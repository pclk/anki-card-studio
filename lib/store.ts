/**
 * Storage with the same behaviour as the local companion server (local/acs.py), per signed-in owner:
 * settings, the project list (merged by id, newest entry wins, deleted ids never come back), projects with
 * optimistic locking on their `rev`, a rolling history, and media / source files split into chunks so no single
 * request has to exceed Vercel's 4.5 MB body limit.
 */
import { db, ensureSchema } from "./db";

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+,=@#&'\-[\]]{0,180}$/;
export const KINDS = new Set(["media", "sources"]);
export const MAX_CHUNK = 4 * 1024 * 1024; // the client sends 3 MB pieces
const HISTORY_KEEP = 30;

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export function checkId(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, "bad project id");
  return id;
}
export function checkName(name: string): string {
  if (!NAME_RE.test(name) || name.includes("..")) throw new HttpError(400, "bad file name");
  return name;
}

/* ------------------------------------------------------------------ settings */
export async function getSettings(owner: string): Promise<string> {
  await ensureSchema();
  const r = await db()<{ data: string }>("select data from acs_settings where owner = $1", [owner]);
  return r.length ? r[0].data : "null";
}

export async function putSettings(owner: string, body: string): Promise<void> {
  JSON.parse(body);
  await ensureSchema();
  await db()(
    `insert into acs_settings (owner, data, updated) values ($1, $2, now())
     on conflict (owner) do update set data = excluded.data, updated = now()`,
    [owner, body],
  );
}

/* ------------------------------------------------------------------ project list */
type Entry = { id: string; updated?: number; [k: string]: unknown };

async function deletedIds(owner: string): Promise<Set<string>> {
  const r = await db()<{ id: string }>("select id from acs_deleted where owner = $1", [owner]);
  return new Set(r.map((x) => x.id));
}

async function listIndex(owner: string): Promise<Entry[]> {
  const gone = await deletedIds(owner);
  const r = await db()<{ id: string; entry: string }>("select id, entry from acs_index where owner = $1 order by id", [owner]);
  return r.filter((x) => !gone.has(x.id)).map((x) => JSON.parse(x.entry));
}

export async function getIndex(owner: string): Promise<Entry[] | null> {
  await ensureSchema();
  const list = await listIndex(owner);
  const any = await db()("select 1 from acs_index where owner = $1 limit 1", [owner]);
  return any.length ? list : null;
}

/** several windows / devices write this list: merge by id (newest entry wins), never resurrect deleted ones */
export async function putIndex(owner: string, incoming: unknown): Promise<Entry[]> {
  if (!Array.isArray(incoming)) throw new HttpError(400, "expected a list");
  await ensureSchema();
  const gone = await deletedIds(owner);
  for (const e of incoming as Entry[]) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !ID_RE.test(e.id) || gone.has(e.id)) continue;
    const updated = Math.trunc(Number(e.updated) || 0);
    await db()(
      `insert into acs_index (owner, id, entry, updated) values ($1, $2, $3, $4)
       on conflict (owner, id) do update set entry = excluded.entry, updated = excluded.updated
       where acs_index.updated <= excluded.updated`,
      [owner, e.id, JSON.stringify(e), updated],
    );
  }
  return listIndex(owner);
}

/* ------------------------------------------------------------------ projects */
function revInfo(data: string) {
  try {
    const j = JSON.parse(data);
    return { rev: Number(j.rev) || 0, savedAt: j.savedAt ?? null, savedBy: j.savedBy ?? null };
  } catch {
    return { rev: 0, savedAt: null, savedBy: null };
  }
}

export async function getProject(owner: string, id: string): Promise<string | null> {
  await ensureSchema();
  const r = await db()<{ data: string }>("select data from acs_projects where owner = $1 and id = $2", [owner, id]);
  return r.length ? r[0].data : null;
}

export async function getRev(owner: string, id: string) {
  const d = await getProject(owner, id);
  return d == null ? null : revInfo(d);
}

/** save; with baseRev, only if the stored project is still at that revision (else 409 with the current one).
 *  restore = an explicit import of a project that was deleted before: it may come back */
export async function putProject(owner: string, id: string, body: string, baseRev: string | null, restore = false) {
  JSON.parse(body);
  await ensureSchema();
  if (restore) await db()("delete from acs_deleted where owner = $1 and id = $2", [owner, id]);
  const rev = revInfo(body).rev;
  // keep a copy of what is being replaced (at most one per 10 minutes, the last 30)
  await db()(
    `insert into acs_history (owner, id, rev, data)
       select owner, id, rev, data from acs_projects p where p.owner = $1 and p.id = $2
       and not exists (select 1 from acs_history h where h.owner = $1 and h.id = $2 and h.at > now() - interval '10 minutes')`,
    [owner, id],
  );
  if (baseRev != null && baseRev !== "") {
    const base = Number(baseRev);
    const upd = await db()(
      `update acs_projects set data = $3, rev = $4, updated = now() where owner = $1 and id = $2 and rev = $5 returning rev`,
      [owner, id, body, rev, base],
    );
    if (!upd.length) {
      const cur = await getRev(owner, id);
      if (cur) throw new HttpError(409, "conflict", { ok: false, error: "conflict", ...cur });
      await db()(
        `insert into acs_projects (owner, id, data, rev) values ($1, $2, $3, $4)
         on conflict (owner, id) do nothing`,
        [owner, id, body, rev],
      );
    }
  } else {
    await db()(
      `insert into acs_projects (owner, id, data, rev) values ($1, $2, $3, $4)
       on conflict (owner, id) do update set data = excluded.data, rev = excluded.rev, updated = now()`,
      [owner, id, body, rev],
    );
  }
  await db()(
    `delete from acs_history where owner = $1 and id = $2 and at < (
       select at from acs_history where owner = $1 and id = $2 order by at desc offset ${HISTORY_KEEP - 1} limit 1)`,
    [owner, id],
  );
  return { ok: true, ...revInfo(body) };
}

/** remove a project everywhere; its last state stays in acs_history for recovery */
export async function deleteProject(owner: string, id: string): Promise<void> {
  await ensureSchema();
  await db()(
    `insert into acs_history (owner, id, rev, data) select owner, id, rev, data from acs_projects where owner = $1 and id = $2`,
    [owner, id],
  );
  await db()("delete from acs_projects where owner = $1 and id = $2", [owner, id]);
  await db()("delete from acs_chunks where owner = $1 and project = $2", [owner, id]);
  await db()("delete from acs_files where owner = $1 and project = $2", [owner, id]);
  await db()("delete from acs_index where owner = $1 and id = $2", [owner, id]);
  await db()("insert into acs_deleted (owner, id) values ($1, $2) on conflict do nothing", [owner, id]);
}

/* ------------------------------------------------------------------ who may sign in (besides ACS_ALLOWED_GITHUB) */
export const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export async function listAllowed(): Promise<{ login: string; added_by: string; at: string }[]> {
  await ensureSchema();
  return db()("select login, added_by, at from acs_allowed order by login");
}
export async function addAllowed(login: string, by: string): Promise<void> {
  if (!LOGIN_RE.test(login)) throw new HttpError(400, "not a valid GitHub username");
  await ensureSchema();
  await db()("insert into acs_allowed (login, added_by) values ($1, $2) on conflict (login) do nothing", [login.toLowerCase(), by]);
}
export async function removeAllowed(login: string): Promise<void> {
  await ensureSchema();
  await db()("delete from acs_allowed where login = $1", [login.toLowerCase()]);
}

/* ------------------------------------------------------------------ media / source files */
export async function listFiles(owner: string, project: string, kind: string): Promise<string[]> {
  await ensureSchema();
  const r = await db()<{ name: string }>(
    "select name from acs_files where owner = $1 and project = $2 and kind = $3 and complete order by name",
    [owner, project, kind],
  );
  return r.map((x) => x.name);
}

export type FileMeta = { mime: string; size: number; chunks: number; etag: string };

export async function fileMeta(owner: string, project: string, kind: string, name: string): Promise<FileMeta | null> {
  await ensureSchema();
  const r = await db()<{ mime: string; size: string | number; chunks: number; ts: string | number }>(
    `select mime, size, chunks, floor(extract(epoch from updated) * 1000) as ts
     from acs_files where owner = $1 and project = $2 and kind = $3 and name = $4 and complete`,
    [owner, project, kind, name],
  );
  if (!r.length) return null;
  const f = r[0];
  return { mime: f.mime, size: Number(f.size), chunks: Number(f.chunks), etag: `"${Number(f.size).toString(36)}-${Number(f.ts).toString(36)}"` };
}

export async function readChunk(owner: string, project: string, kind: string, name: string, idx: number): Promise<Buffer | null> {
  const r = await db()<{ b64: string }>(
    "select encode(data, 'base64') as b64 from acs_chunks where owner = $1 and project = $2 and kind = $3 and name = $4 and idx = $5",
    [owner, project, kind, name, idx],
  );
  return r.length ? Buffer.from(r[0].b64.replace(/\s+/g, ""), "base64") : null;
}

/**
 * Write one piece of a file. Piece 0 replaces whatever was stored under that name; the file becomes readable once
 * the last piece arrives. A file small enough for one request is just piece 0 of 1.
 */
export async function writeChunk(owner: string, project: string, kind: string, name: string, mime: string,
                                 idx: number, total: number, bytes: Buffer): Promise<void> {
  if (!Number.isInteger(idx) || !Number.isInteger(total) || total < 1 || total > 4096 || idx < 0 || idx >= total)
    throw new HttpError(400, "bad chunk number");
  if (bytes.length > MAX_CHUNK + 1024) throw new HttpError(413, "piece too large");
  await ensureSchema();
  const q = db();
  if (idx === 0) {
    await q("delete from acs_chunks where owner = $1 and project = $2 and kind = $3 and name = $4", [owner, project, kind, name]);
    await q(
      `insert into acs_files (owner, project, kind, name, mime, size, chunks, complete, updated)
       values ($1, $2, $3, $4, $5, 0, $6, false, now())
       on conflict (owner, project, kind, name) do update
       set mime = excluded.mime, size = 0, chunks = excluded.chunks, complete = false, updated = now()`,
      [owner, project, kind, name, mime || "application/octet-stream", total],
    );
  } else {
    const f = await q<{ chunks: number }>(
      "select chunks from acs_files where owner = $1 and project = $2 and kind = $3 and name = $4",
      [owner, project, kind, name],
    );
    if (!f.length || Number(f[0].chunks) !== total) throw new HttpError(409, "upload not started (send piece 0 first)");
  }
  await q(
    `insert into acs_chunks (owner, project, kind, name, idx, data) values ($1, $2, $3, $4, $5, decode($6, 'base64'))
     on conflict (owner, project, kind, name, idx) do update set data = excluded.data`,
    [owner, project, kind, name, idx, bytes.toString("base64")],
  );
  await q(
    `update acs_files set size = (select coalesce(sum(length(data)), 0) from acs_chunks c
       where c.owner = $1 and c.project = $2 and c.kind = $3 and c.name = $4),
     complete = (select count(*) from acs_chunks c where c.owner = $1 and c.project = $2 and c.kind = $3 and c.name = $4) = chunks,
     updated = now()
     where owner = $1 and project = $2 and kind = $3 and name = $4`,
    [owner, project, kind, name],
  );
}

export async function deleteFile(owner: string, project: string, kind: string, name: string): Promise<void> {
  await ensureSchema();
  await db()("delete from acs_chunks where owner = $1 and project = $2 and kind = $3 and name = $4", [owner, project, kind, name]);
  await db()("delete from acs_files where owner = $1 and project = $2 and kind = $3 and name = $4", [owner, project, kind, name]);
}
