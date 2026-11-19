/**
 * The Mac bridge: the Studio queues "jobs" (a prompt and its files), and a small process on the user's Mac
 * (bridge/acs-bridge.mjs) picks them up, runs Claude Code or Codex on them, streams progress back and uploads the
 * anki_bundle.json / anki_revision.json it made. A cloud app can't start a process on the Mac, so the bridge connects
 * out and polls.
 *
 * Security
 * - The bridge signs in with a device token, not the account's cookie. A token is 32 random bytes shown once when
 *   the device is added; only its SHA-256 is stored. It is refused once revoked, when the account is disabled or no
 *   longer allowed to sign in, and after "sign out everywhere" (like a session that started before it).
 * - A device token reaches only the bridge endpoints (claim a job, read its files, post progress, upload the result):
 *   never projects, settings, other people or the admin API.
 * - Only the signed-in Studio creates jobs. The job's prompt and files are files; the bridge never puts them on a
 *   command line or into its own flags.
 *
 * Job states: uploading (the Studio is sending files) -> queued -> running (claimed by one device) -> done | failed |
 * cancelled. A running job whose bridge stops reporting for STALE_MS fails, and so does one still uploading after UPLOAD_MS.
 */
import { createHash, randomBytes } from "node:crypto";
import { db, ensureSchema } from "./db";
import * as st from "./store";
import { HttpError } from "./store";
import { allowedLogins, adminLogins } from "./allow";
import { applyRegistry, getUserRow } from "./users";
import type { User } from "./user";

export const TOKEN_PREFIX = "acsd_";
export const MAX_DEVICES = 10;
export const MAX_OPEN_JOBS = 60;
export const MAX_JOB_FILES = 24;
export const STALE_MS = 5 * 60_000;
/** a job still "uploading" after this never got all its files (the tab closed, the network dropped) */
export const UPLOAD_MS = 60 * 60_000;
export const KEEP_DAYS = 14;
export const AGENTS = new Set(["claude", "codex"]);
/** cards -> anki_bundle.json; revision, format -> anki_revision.json; ask (the Assistant) -> an answer (reply.md), and
    maybe anki_revision.json / anki_actions.json, which the user applies in the Studio */
export const JOB_KINDS = new Set(["cards", "revision", "format", "ask"]);
/** what a bridge may upload as a job's result */
export const OUT_RE = /^(?:anki_bundle\.json|anki_revision\.json|anki_actions\.json|anki_explanations\.md|reply\.md)$/;
const JOB_ID_RE = /^j[a-z0-9]{12,40}$/;
/* what a job may ask its agent for (the bridge checks the same again before they become flags: agentOptions in
   bridge/acs-bridge.mjs). Empty values mean "the CLI's own default". */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,79}$/;
export const EFFORTS: Record<string, string[]> = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["minimal", "low", "medium", "high", "xhigh", "max"] };
const OPTION_KEYS: Record<string, string[]> = { claude: ["model", "effort", "fallbackModel", "maxBudgetUsd", "maxMinutes"], codex: ["model", "effort", "maxMinutes"] };
export function checkOptions(agent: string, raw: unknown): Record<string, string | number> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "options must be an object");
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === "" || v === null || v === undefined || v === 0) continue;
    if (!OPTION_KEYS[agent].includes(k)) throw new HttpError(400, `${agent} has no option ${k}`);
    const sv = String(v).trim(), nv = Number(v);
    if (k === "model" && !MODEL_RE.test(sv)) throw new HttpError(400, "not a model name");
    if (k === "fallbackModel" && !(sv.split(",").length <= 3 && sv.split(",").every((m) => MODEL_RE.test(m.trim())))) throw new HttpError(400, "not a model name");
    if (k === "effort" && !EFFORTS[agent].includes(sv)) throw new HttpError(400, `${agent} effort is one of ${EFFORTS[agent].join(", ")}`);
    if (k === "maxBudgetUsd" && !(nv > 0 && nv <= 1000)) throw new HttpError(400, "maxBudgetUsd is 0-1000");
    if (k === "maxMinutes" && !(Number.isInteger(nv) && nv >= 1 && nv <= 1440)) throw new HttpError(400, "maxMinutes is 1-1440");
    out[k] = k === "maxBudgetUsd" || k === "maxMinutes" ? nv : sv;
  }
  return out;
}
const DEVICE_ID_RE = /^d[a-z0-9]{12,40}$/;
const OPEN = ["uploading", "queued", "running"];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rid = (p: string) => p + randomBytes(10).toString("hex");
const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);


/* ------------------------------------------------------------------ device tokens */
export type DeviceRow = { id: string; owner: string; name: string; hint: string; created: string; last_seen: string | null; last_info: string | null; revoked_at: string | null };

export async function listDevices(owner: string) {
  await ensureSchema();
  const rows = await db()<DeviceRow>("select id, owner, name, hint, created, last_seen, last_info, revoked_at from acs_devices where owner = $1 and revoked_at is null order by created", [owner]);
  return rows.map((r) => ({ id: r.id, name: r.name, hint: r.hint, created: r.created, lastSeen: r.last_seen, info: r.last_info ? safeJson(r.last_info) : null }));
}

/** a new device: returns its token, which is shown once and never stored */
export async function addDevice(owner: string, name: unknown): Promise<{ id: string; name: string; token: string }> {
  await ensureSchema();
  const nm = clip(name, 60).trim() || "My Mac";
  const [n] = await db()<{ n: string }>("select count(*) as n from acs_devices where owner = $1 and revoked_at is null", [owner]);
  if (Number(n.n) >= MAX_DEVICES) throw new HttpError(400, `at most ${MAX_DEVICES} devices - remove one first`);
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url"), id = rid("d");
  await db()("insert into acs_devices (id, owner, name, token_hash, hint) values ($1, $2, $3, $4, $5)", [id, owner, nm, sha256(token), token.slice(-4)]);
  return { id, name: nm, token };
}

export async function revokeDevice(owner: string, id: string): Promise<void> {
  if (!DEVICE_ID_RE.test(id)) throw new HttpError(400, "bad device id");
  await ensureSchema();
  const r = await db()<{ id: string }>("update acs_devices set revoked_at = now() where owner = $1 and id = $2 and revoked_at is null returning id", [owner, id]);
  if (!r.length) throw new HttpError(404, "no such device");
  // its running jobs stop: nothing it sends is accepted any more
  await db()("update acs_jobs set status = 'failed', error = 'the device was removed', finished_at = now() where owner = $1 and device = $2 and status = 'running'", [owner, id]);
}

const seen = new Map<string, number>();
/**
 * The account behind a device token, or null. Checks the token (by hash), that it isn't revoked, and the same
 * account rules as a signed-in session: still allowed to sign in, not disabled, and not signed out everywhere since
 * the device was added.
 */
export async function deviceUser(authorization: string | null): Promise<User | null> {
  const m = /^Bearer\s+(acsd_[A-Za-z0-9_-]{43})\s*$/.exec(authorization || "");
  if (!m) return null;
  await ensureSchema();
  const [d] = await db()<{ id: string; owner: string; created: string; revoked_at: string | null }>(
    "select id, owner, created, revoked_at from acs_devices where token_hash = $1", [sha256(m[1])]);
  if (!d || d.revoked_at) return null;
  const row = await getUserRow(d.owner, true);
  if (!row || row.status === "disabled") return null;
  const dev = process.env.ACS_INSECURE_DEV_USER && !process.env.VERCEL && d.owner === `dev:${process.env.ACS_INSECURE_DEV_USER}`;
  if (!dev && !(await allowedLogins()).includes(row.login.toLowerCase())) return null;
  const u = await applyRegistry({ owner: d.owner, login: row.login, name: row.name, image: row.image }, new Date(d.created).getTime(), adminLogins());
  if (!u || u.status === "disabled") return null;
  if (Date.now() - (seen.get(d.id) || 0) > 60_000) {
    seen.set(d.id, Date.now());
    await db()("update acs_devices set last_seen = now() where id = $1", [d.id]);
  }
  return { ...u, admin: false, device: d.id };
}

/* ------------------------------------------------------------------ jobs */
type JobRow = { id: string; owner: string; project: string; kind: string; agent: string; title: string; status: string; files: string; meta: string;
  options: string; device: string | null; created: string; claimed_at: string | null; heartbeat_at: string | null; finished_at: string | null; imported_at: string | null;
  error: string | null; outputs: string; events: number; client_seq: number };
type FileDecl = { name: string; size: number };
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
const view = (j: JobRow) => ({ id: j.id, project: j.project, kind: j.kind, agent: j.agent, title: j.title, status: j.status,
  files: safeJson(j.files) || [], meta: safeJson(j.meta) || {}, options: safeJson(j.options) || {}, device: j.device, created: j.created, claimedAt: j.claimed_at,
  heartbeatAt: j.heartbeat_at, finishedAt: j.finished_at, importedAt: j.imported_at, error: j.error, outputs: safeJson(j.outputs) || [], events: j.events });

export function checkJobId(id: string): string { if (!JOB_ID_RE.test(id)) throw new HttpError(400, "bad job id"); return id; }

async function getJob(owner: string, id: string): Promise<JobRow> {
  checkJobId(id);
  await ensureSchema();
  const [j] = await db()<JobRow>("select * from acs_jobs where owner = $1 and id = $2", [owner, id]);
  if (!j) throw new HttpError(404, "no such job");
  return j;
}

/** fail running jobs whose bridge went quiet and uploads that never finished; forget finished jobs (and their files) after KEEP_DAYS */
async function tidy(owner: string): Promise<void> {
  await db()(`update acs_jobs set status = 'failed', error = 'the bridge stopped responding', finished_at = now()
    where owner = $1 and status = 'running' and heartbeat_at < now() - interval '1 millisecond' * $2::integer`, [owner, STALE_MS]);
  await db()(`update acs_jobs set status = 'failed', error = 'its files never all arrived', finished_at = now()
    where owner = $1 and status = 'uploading' and created < now() - interval '1 millisecond' * $2::integer`, [owner, UPLOAD_MS]);
  // a few per request, so a long backlog never runs into the serverless time limit
  const old = await db()<{ id: string }>(`select id from acs_jobs where owner = $1 and status not in ('uploading','queued','running')
    and coalesce(finished_at, created) < now() - interval '1 day' * $2::integer order by created limit 5`, [owner, KEEP_DAYS]);
  for (const { id } of old) await deleteJobRows(owner, id);
}

async function deleteJobRows(owner: string, id: string): Promise<void> {
  for (const kind of ["jobin", "jobout"]) for (const name of await st.listFiles(owner, id, kind)) await st.deleteFile(owner, id, kind, name);
  for (const t of ["acs_upload_chunks", "acs_upload_files"]) await db()(`delete from ${t} where owner = $1 and project = $2 and kind in ('jobin','jobout')`, [owner, id]);
  await db()("delete from acs_job_events where job = $1", [id]);
  await db()("delete from acs_jobs where owner = $1 and id = $2", [owner, id]);
}

export async function listJobs(owner: string, project: string | null) {
  await ensureSchema();
  await tidy(owner);
  const rows = project
    ? await db()<JobRow>("select * from acs_jobs where owner = $1 and project = $2 order by created desc limit 200", [owner, st.checkId(project)])
    : await db()<JobRow>("select * from acs_jobs where owner = $1 order by created desc limit 200", [owner]);
  return rows.map(view);
}

export async function jobView(owner: string, id: string) { await ensureSchema(); await tidy(owner); return view(await getJob(owner, id)); }

/** a new job, waiting for its files: {project, kind, agent, title, files: [{name, size}], meta} */
export async function createJob(owner: string, body: Record<string, unknown>) {
  await ensureSchema();
  const project = st.checkId(String(body.project || ""));
  const kind = String(body.kind || ""), agent = String(body.agent || "claude");
  if (!JOB_KINDS.has(kind)) throw new HttpError(400, "unknown job kind");
  if (!AGENTS.has(agent)) throw new HttpError(400, "unknown agent");
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length || files.length > MAX_JOB_FILES) throw new HttpError(400, `a job has 1-${MAX_JOB_FILES} files`);
  const decl: FileDecl[] = files.map((f) => ({ name: st.checkName(String((f as FileDecl)?.name || "")), size: Math.max(0, Math.floor(Number((f as FileDecl)?.size) || 0)) }));
  if (new Set(decl.map((f) => f.name)).size !== decl.length) throw new HttpError(400, "file names must differ");
  if (!decl.some((f) => f.name === "anki_prompt.txt")) throw new HttpError(400, "a job needs anki_prompt.txt");
  const meta = JSON.stringify(body.meta && typeof body.meta === "object" ? body.meta : {});
  if (meta.length > 4000) throw new HttpError(400, "job details too long");
  const options = JSON.stringify(checkOptions(agent, body.options));
  await tidy(owner);
  const [n] = await db()<{ n: string }>(`select count(*) as n from acs_jobs where owner = $1 and status in ('uploading','queued','running')`, [owner]);
  if (Number(n.n) >= MAX_OPEN_JOBS) throw new HttpError(429, `at most ${MAX_OPEN_JOBS} jobs waiting or running - cancel some first`);
  const id = rid("j");
  await db()(`insert into acs_jobs (id, owner, project, kind, agent, title, status, files, meta, options) values ($1,$2,$3,$4,$5,$6,'uploading',$7,$8,$9)`,
    [id, owner, project, kind, agent, clip(body.title, 200) || kind, JSON.stringify(decl), meta, options]);
  return view(await getJob(owner, id));
}

const declared = (j: JobRow, name: string) => (safeJson(j.files) as FileDecl[] || []).some((f) => f.name === name);

/** the Studio sends one of the job's declared files (while it is still uploading) */
export async function putJobInput(owner: string, id: string, name: string, mime: string, idx: number, total: number, bytes: Buffer, upload: string) {
  const j = await getJob(owner, id);
  if (j.status !== "uploading") throw new HttpError(409, "the job's files are already sent");
  if (!declared(j, st.checkName(name))) throw new HttpError(400, "not one of the job's files");
  await st.writeChunk(owner, id, "jobin", name, mime, idx, total, bytes, upload);
}

/** every declared file arrived: the job waits for a bridge */
export async function queueJob(owner: string, id: string) {
  const j = await getJob(owner, id);
  if (j.status !== "uploading") throw new HttpError(409, `the job is ${j.status}`);
  const have = new Set(await st.listFiles(owner, id, "jobin"));
  const missing = (safeJson(j.files) as FileDecl[]).filter((f) => !have.has(f.name)).map((f) => f.name);
  if (missing.length) throw new HttpError(409, `files not sent yet: ${missing.join(", ")}`);
  await db()("update acs_jobs set status = 'queued' where id = $1", [id]);
  return view(await getJob(owner, id));
}

export async function cancelJob(owner: string, id: string) {
  const j = await getJob(owner, id);
  if (OPEN.includes(j.status)) await db()("update acs_jobs set status = 'cancelled', finished_at = now(), error = 'cancelled' where id = $1", [id]);
  return view(await getJob(owner, id));
}

export async function deleteJob(owner: string, id: string) {
  const j = await getJob(owner, id);
  if (j.status === "running") throw new HttpError(409, "cancel the job first");
  await deleteJobRows(owner, id);
}

/** the first window to import a finished job's result gets true; every other one false (no double import) */
export async function claimImport(owner: string, id: string): Promise<boolean> {
  const j = await getJob(owner, id);
  if (j.status !== "done") throw new HttpError(409, `the job is ${j.status}`);
  const r = await db()<{ id: string }>("update acs_jobs set imported_at = now() where id = $1 and imported_at is null returning id", [id]);
  return r.length > 0;
}

export async function jobEvents(owner: string, id: string, after: number) {
  await getJob(owner, id);
  return db()<{ seq: number; at: string; type: string; text: string }>(
    "select seq, at, type, text from acs_job_events where job = $1 and seq > $2 order by seq limit 500", [id, Math.max(0, Math.floor(after) || 0)]);
}

/* ------------------------------------------------------------------ the bridge's side (device token) */
export async function hello(user: User, info: unknown) {
  await db()("update acs_devices set last_seen = now(), last_info = $2 where id = $1", [user.device, clip(JSON.stringify(info ?? {}), 2000)]);
  const [d] = await db()<{ name: string }>("select name from acs_devices where id = $1", [user.device]);
  return { ok: true, device: d?.name, login: user.login };
}

/** the oldest queued job of this account (atomically: the account lock is held), or null */
export async function claimJob(user: User, agents: unknown) {
  await ensureSchema();
  await tidy(user.owner);
  const can = (Array.isArray(agents) ? agents.map(String) : ["claude"]).filter((a) => AGENTS.has(a));
  if (!can.length) return null;
  // a job this device took but never reported on: the answer to its claim was lost (a timeout, a dropped connection),
  // so the bridge asks again - give it the same job instead of leaving it "running" on a Mac that doesn't know
  const [lost] = await db()<JobRow>(`select * from acs_jobs where owner = $1 and device = $2 and status = 'running' and events = 0 order by claimed_at limit 1`, [user.owner, user.device]);
  if (lost) return view(lost);
  const [j] = await db()<JobRow>(`select * from acs_jobs where owner = $1 and status = 'queued' and agent = any($2::text[]) order by created limit 1`, [user.owner, can]);
  if (!j) return null;
  await db()("update acs_jobs set status = 'running', device = $2, claimed_at = now(), heartbeat_at = now() where id = $1 and status = 'queued'", [j.id, user.device]);
  return view(await getJob(user.owner, j.id));
}

/** a job this device is running (anything else is refused) */
async function mine(user: User, id: string, running = true): Promise<JobRow> {
  const j = await getJob(user.owner, id);
  if (j.device !== user.device) throw new HttpError(403, "this job belongs to another device");
  if (running && j.status !== "running") throw new HttpError(409, `the job is ${j.status}`);
  return j;
}

export async function deviceInputMeta(user: User, id: string, name: string) {
  const j = await mine(user, id);
  if (!declared(j, st.checkName(name))) throw new HttpError(404, "not one of the job's files");
  return st.fileMeta(user.owner, id, "jobin", name);
}

/** progress from the bridge (also its heartbeat); answers whether the job was cancelled */
export async function postEvents(user: User, id: string, events: unknown): Promise<{ cancel: boolean }> {
  const j = await mine(user, id, false);
  if (j.status === "cancelled") return { cancel: true };
  if (j.status !== "running") throw new HttpError(409, `the job is ${j.status}`);
  const list = (Array.isArray(events) ? events : []).slice(0, 200);
  let seq = j.events, sent = j.client_seq;
  for (const e of list) {
    if (seq >= 5000) break;   // a runaway log stops growing; the job still finishes
    const ev = e as { type?: unknown; text?: unknown; n?: unknown };
    // numbered by the bridge: one already stored is a retry, not a new line
    if (Number.isSafeInteger(ev.n)) { if ((ev.n as number) <= sent) continue; sent = ev.n as number; }
    await db()("insert into acs_job_events (job, seq, type, text) values ($1, $2, $3, $4)", [id, ++seq, clip(ev.type, 20) || "text", clip(ev.text, 4000)]);
  }
  await db()("update acs_jobs set events = $2, client_seq = $3, heartbeat_at = now() where id = $1", [id, seq, sent]);
  return { cancel: false };
}

export async function putJobOutput(user: User, id: string, name: string, mime: string, idx: number, total: number, bytes: Buffer, upload: string) {
  await mine(user, id);
  if (!OUT_RE.test(name)) throw new HttpError(400, "a job's result is anki_bundle.json, anki_revision.json, anki_actions.json, anki_explanations.md or reply.md");
  await st.writeChunk(user.owner, id, "jobout", name, mime, idx, total, bytes, upload);
}

export async function finishJob(user: User, id: string, body: Record<string, unknown>) {
  const j = await mine(user, id, false);
  // cancelled, or already finished: a retry whose first answer was lost (a timeout, a dropped connection) gets the
  // outcome that stands, never a different one
  if (j.status === "cancelled" || j.status === "done" || j.status === "failed") return view(j);
  if (j.status !== "running") throw new HttpError(409, `the job is ${j.status}`);
  const outputs = await st.listFiles(user.owner, id, "jobout");
  const need = j.kind === "cards" ? "anki_bundle.json" : j.kind === "ask" ? "reply.md" : "anki_revision.json";
  const ok = body.ok === true && outputs.includes(need);
  const error = ok ? null : clip(body.error, 1000) || (body.ok === true ? (j.kind === "ask" ? "there was no answer" : `no ${need} was made`) : "the run failed");
  await db()("update acs_jobs set status = $2, error = $3, outputs = $4, finished_at = now(), heartbeat_at = now() where id = $1",
    [id, ok ? "done" : "failed", error, JSON.stringify(outputs)]);
  return view(await getJob(user.owner, id));
}

/** everything of the account (account deletion) */
export async function wipeBridge(owner: string): Promise<void> {
  await ensureSchema();
  await db()("delete from acs_job_events where job in (select id from acs_jobs where owner = $1)", [owner]);
  await db()("delete from acs_jobs where owner = $1", [owner]);
  await db()("delete from acs_devices where owner = $1", [owner]);
}
