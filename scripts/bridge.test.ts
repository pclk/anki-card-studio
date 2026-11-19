/**
 * The Mac bridge: device tokens and jobs (lib/bridge.ts) through a real HTTP server, and the real bridge script
 * (bridge/acs-bridge.mjs) running a fake `claude` that records how it was started.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { setDb, db } from "../lib/db";
import { handleApi } from "../lib/api";
import { deviceUser } from "../lib/bridge";
import * as us from "../lib/users";
import { forgetAllowedCache } from "../lib/allow";
import type { User } from "../lib/user";

const A: User = { owner: "gh:11", login: "alice" }, B: User = { owner: "gh:12", login: "bob" };
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "acs-bridge-home-")));   // macOS: /var is /private/var
process.env.ACS_BRIDGE_HOME = HOME;
process.env.ACS_ALLOWED_GITHUB = "alice,bob";
process.env.ACS_BRIDGE_POLL_MS = "50";
let pg: PGlite, server: http.Server, base = "";
let bridge: typeof import("../bridge/acs-bridge.mjs");

/** a fake agent: records its argv and cwd, prints stream-json, writes the result (behaviour from FAKE_MODE) */
const FAKE = join(HOME, "fake-claude.mjs");
writeFileSync(FAKE, `#!/usr/bin/env node
import fs from 'node:fs';
const mode = fs.existsSync('anki-skill/../../mode') ? fs.readFileSync('anki-skill/../../mode','utf8').trim() : 'ok';
fs.writeFileSync(process.env.ACS_FAKE_LOG || 'argv.json', JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), out: process.env.ANKI_OUT_DIR,
  files: fs.readdirSync('.').sort(), skill: fs.readdirSync('anki-skill/scripts').sort(), prompt: fs.readFileSync('anki_prompt.txt','utf8')}));
const say = o => console.log(JSON.stringify(o));
say({type:'system', subtype:'init'});
say({type:'assistant', message:{content:[{type:'text', text:'Reading the prompt'}, {type:'tool_use', name:'Bash', input:{command:'python3 build_deck.py'}}]}});
if (mode === 'slow') { setInterval(() => say({type:'assistant', message:{content:[{type:'text', text:'still working'}]}}), 100); }
else if (mode === 'crash') { console.error('boom: model overloaded'); process.exit(3); }
else if (mode === 'symlink') {
  // a hijacked agent points its outputs at files outside the job folder
  fs.writeFileSync(process.env.ANKI_OUT_DIR + '/anki_bundle.json', JSON.stringify({format:'anki-studio/v1', deck:'D', cards:[{id:'c001', type:'basic', front:'Q?', back:'A'}]}));
  fs.symlinkSync(process.env.ACS_FAKE_SECRET, process.env.ANKI_OUT_DIR + '/reply.md');
  fs.symlinkSync(process.env.ACS_FAKE_SECRET, process.env.ANKI_OUT_DIR + '/anki_explanations.md');
  say({type:'result', subtype:'success', is_error:false, result:'Made 1 card.'});
}
else {
  if (mode !== 'nothing') fs.writeFileSync(process.env.ANKI_OUT_DIR + '/anki_bundle.json', JSON.stringify({format:'anki-studio/v1', deck:'D', cards:[{id:'c001', type:'basic', front:'Q?', back:'A'}]}));
  say({type:'result', subtype:'success', is_error:false, result:'Made 1 card.'});
}
`);
chmodSync(FAKE, 0o755);
process.env.ACS_BRIDGE_CLAUDE = FAKE;
process.env.ACS_FAKE_LOG = join(HOME, "argv.json");
const setMode = (m: string) => { mkdirSync(join(HOME, "jobs"), { recursive: true }); writeFileSync(join(HOME, "jobs", "mode"), m); };

before(async () => {
  pg = new PGlite();
  setDb((async (t: string, p: unknown[] = []) => (await pg.query(t, p)).rows) as never, async (work) => pg.transaction(async (tx) => work((async (t: string, p: unknown[] = []) => (await tx.query(t, p)).rows) as never)));
  for (const u of [A, B]) await us.touchUser(u.owner, u.login);
  forgetAllowedCache();
  // the same wiring as app/api/[...path]/route.ts: a bearer token is the device, anything else is the test user
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, "http://127.0.0.1");
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const bearer = req.headers.authorization;
    const user = bearer ? await deviceUser(bearer) : req.headers["x-user"] === "bob" ? B : req.headers["x-user"] === "alice" ? A : null;
    const out = await handleApi(r, url.pathname.replace(/^\/api\//, "").split("/"), user);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  bridge = await import("../bridge/acs-bridge.mjs");
});
after(async () => { server.close(); setDb(null); await pg.close(); });

/** the Studio (cookie user) or the bridge (device token) talking to the server */
async function call(who: "alice" | "bob" | { token: string }, method: string, path: string, body?: unknown, raw?: Buffer) {
  const headers: Record<string, string> = typeof who === "string" ? { "x-user": who, origin: base } : { authorization: `Bearer ${who.token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${base}/api/${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const addDevice = async (who: "alice" | "bob" = "alice", name = "Mac") => (await call(who, "POST", "devices", { name })).json as { id: string; token: string };
/** a queued job of alice's with its prompt and the skill files (what the Studio sends) */
async function queuedJob(project = "p1", kind = "cards", extra: Record<string, string> = {}) {
  const files: Record<string, string> = { "anki_prompt.txt": "Make cards about classes.\n<<<SOURCE id=s-0011aabb\n[notes.txt p.1]\nA class is a blueprint.\nSOURCE>>>", "SKILL.md": "# skill", "anki_helper.py": "# helper", ...extra };
  const j = (await call("alice", "POST", "jobs", { project, kind, agent: "claude", title: "Lecture 1", files: Object.entries(files).map(([name, t]) => ({ name, size: t.length })), meta: { batchItem: "L01" } })).json;
  for (const [name, t] of Object.entries(files)) assert.equal((await call("alice", "PUT", `jobs/${j.id}/in/${encodeURIComponent(name)}`, undefined, Buffer.from(t))).status, 200);
  assert.equal((await call("alice", "POST", `jobs/${j.id}/queue`)).json.status, "queued");
  return j.id as string;
}
const job = async (id: string) => (await call("alice", "GET", `jobs/${id}`)).json;
const cfg = () => ({ ...bridge.loadConfig(), agents: ["claude"] });

/* ------------------------------------------------------------------ device tokens */
test("a device token is shown once, stored only as a hash, and listed without it", async () => {
  const d = await addDevice("alice", "MacBook");
  assert.match(d.token, /^acsd_[A-Za-z0-9_-]{43}$/);
  const list = (await call("alice", "GET", "devices")).json;
  const mine = list.find((x: any) => x.id === d.id);
  assert.equal(mine.name, "MacBook"); assert.equal(mine.hint, d.token.slice(-4));
  assert.ok(!JSON.stringify(list).includes(d.token.slice(5, 20)));
  const [row] = await db()<{ token_hash: string }>("select token_hash from acs_devices where id = $1", [d.id]);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/); assert.ok(!row.token_hash.includes(d.token));
  assert.equal((await call("bob", "GET", "devices")).json.length, 0);          // per account
});

test("a device token reaches the bridge endpoints and nothing else", async () => {
  const d = await addDevice();
  assert.equal((await call(d, "POST", "bridge/hello", { version: "1", agents: ["claude"] })).json.login, "alice");
  for (const [m, p] of [["GET", "ping"], ["GET", "projects"], ["GET", "settings"], ["PUT", "settings"], ["GET", "devices"], ["POST", "devices"], ["GET", "jobs"], ["GET", "project/p1"], ["GET", "admin/users"], ["GET", "fetch?url=https://example.com"]])
    assert.equal((await call(d, m, p, m === "GET" ? undefined : {})).status, 403, `${m} ${p}`);
  // and the signed-in Studio can't use the bridge's endpoints
  assert.equal((await call("alice", "POST", "bridge/claim", { agents: ["claude"] })).status, 403);
});

test("unknown, malformed and revoked tokens are refused", async () => {
  for (const t of ["acsd_" + "x".repeat(43), "acsd_short", "Bearer", "sk-ant-" + "y".repeat(43)])
    assert.equal((await call({ token: t }, "POST", "bridge/hello", {})).status, 401, t);
  const d = await addDevice();
  assert.equal((await call(d, "POST", "bridge/hello", {})).status, 200);
  assert.equal((await call("alice", "DELETE", `devices/${d.id}`)).status, 200);
  assert.equal((await call(d, "POST", "bridge/hello", {})).status, 401);
  assert.equal((await call("bob", "DELETE", `devices/${(await addDevice()).id}`)).status, 404);   // not bob's
});

test("a token follows the account: disabled, read-only, signed out everywhere, no longer allowed", async () => {
  const d = await addDevice();
  await db()("update acs_users set status = 'disabled' where owner = $1", [A.owner]); us.forgetUser(A.owner);
  assert.equal((await call(d, "POST", "bridge/hello", {})).status, 401);
  await db()("update acs_users set status = 'readonly' where owner = $1", [A.owner]); us.forgetUser(A.owner);
  assert.equal((await call(d, "POST", "bridge/claim", { agents: ["claude"] })).status, 403);
  await db()("update acs_users set status = 'active', signed_out = now() + interval '1 second' where owner = $1", [A.owner]); us.forgetUser(A.owner);
  assert.equal((await call(d, "POST", "bridge/hello", {})).status, 401);            // older than "sign out everywhere"
  await db()("update acs_users set signed_out = null where owner = $1", [A.owner]); us.forgetUser(A.owner);
  assert.equal((await call(d, "POST", "bridge/hello", {})).status, 200);
  process.env.ACS_ALLOWED_GITHUB = "bob"; forgetAllowedCache();
  try { assert.equal((await call(d, "POST", "bridge/hello", {})).status, 401); }
  finally { process.env.ACS_ALLOWED_GITHUB = "alice,bob"; forgetAllowedCache(); }
});

test("at most 10 devices per account", async () => {
  const have = (await call("bob", "GET", "devices")).json.length;
  for (let i = have; i < 10; i++) assert.equal((await call("bob", "POST", "devices", { name: `d${i}` })).status, 200);
  assert.equal((await call("bob", "POST", "devices", { name: "one too many" })).status, 400);
});

/* ------------------------------------------------------------------ jobs */
test("a job needs its prompt, only takes its declared files, and queues once they are all there", async () => {
  const bad = (files: unknown) => call("alice", "POST", "jobs", { project: "p1", kind: "cards", files });
  assert.equal((await bad([{ name: "x.pdf", size: 1 }])).status, 400);                         // no anki_prompt.txt
  assert.equal((await bad([{ name: "anki_prompt.txt" }, { name: "../etc/passwd" }])).status, 400);
  assert.equal((await bad([{ name: "anki_prompt.txt" }, { name: ".bashrc" }])).status, 400);
  assert.equal((await call("alice", "POST", "jobs", { project: "p1", kind: "shell", files: [{ name: "anki_prompt.txt" }] })).status, 400);
  assert.equal((await call("alice", "POST", "jobs", { project: "p1", kind: "cards", agent: "bash", files: [{ name: "anki_prompt.txt" }] })).status, 400);
  const j = (await call("alice", "POST", "jobs", { project: "p1", kind: "cards", files: [{ name: "anki_prompt.txt", size: 2 }, { name: "L01.pdf", size: 2 }] })).json;
  assert.equal(j.status, "uploading");
  assert.equal((await call("alice", "PUT", `jobs/${j.id}/in/other.pdf`, undefined, Buffer.from("x"))).status, 400);
  await call("alice", "PUT", `jobs/${j.id}/in/anki_prompt.txt`, undefined, Buffer.from("hi"));
  assert.equal((await call("alice", "POST", `jobs/${j.id}/queue`)).status, 409);               // L01.pdf missing
  await call("alice", "PUT", `jobs/${j.id}/in/L01.pdf`, undefined, Buffer.from("%P"));
  assert.equal((await call("alice", "POST", `jobs/${j.id}/queue`)).json.status, "queued");
  assert.equal((await call("alice", "PUT", `jobs/${j.id}/in/L01.pdf`, undefined, Buffer.from("changed"))).status, 409);
  assert.equal((await call("bob", "GET", `jobs/${j.id}`)).status, 404);                          // not bob's
  await call("alice", "POST", `jobs/${j.id}/cancel`);
});

test("the bridge runs a job end to end: files in a fresh folder, fixed flags, events, result, one import", async () => {
  const d = await addDevice();
  const id = await queuedJob("p2", "cards", { "L01_p3-5.pdf": "%PDF-fake" });
  setMode("ok");
  const r = await bridge.serve({ ...cfg(), server: base, token: d.token }, { once: true, log: () => {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  const j = await job(id);
  assert.equal(j.status, "done"); assert.deepEqual(j.outputs, ["anki_bundle.json", "reply.md"]);
  // how the agent was started
  const log = JSON.parse(readFileSync(join(HOME, "argv.json"), "utf8"));
  assert.deepEqual(log.argv.slice(0, 1), ["-p"]);
  assert.equal(log.argv[1], bridge.INSTRUCTION);                                        // the fixed instruction…
  assert.ok(!log.argv.some((a: string) => a.includes("classes") || a.includes("blueprint")));   // …never the prompt
  for (const f of ["--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--strict-mcp-config", "--allowedTools"]) assert.ok(log.argv.includes(f), f);
  assert.ok(!log.argv.includes("--dangerously-skip-permissions") && !log.argv.includes("bypassPermissions"));
  assert.match(log.cwd, new RegExp(`^${join(HOME, "jobs", id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${process.pid}-[A-Za-z0-9]{6}$`));   // a new folder per run, named by its bridge
  assert.equal(log.out, join(log.cwd, "anki_out"));
  assert.deepEqual(log.files, ["AGENTS.md", "L01_p3-5.pdf", "anki-skill", "anki_out", "anki_prompt.txt"]);
  assert.deepEqual(log.skill, ["anki_helper.py"]);
  assert.match(log.prompt, /Make cards about classes/);
  // progress reached the Studio
  const ev = (await call("alice", "GET", `jobs/${id}/events?after=0`)).json;
  assert.deepEqual(ev.map((e: any) => e.type), ["log", "log", "text", "tool", "result"]);
  assert.match(ev[0].text, /^Picked up on .* - fetching 4 file\(s\)$/);   // before the downloads: a heartbeat
  assert.equal(ev[3].text, "Bash: python3 build_deck.py"); assert.equal(ev[4].text, "Made 1 card.");
  // the result, imported exactly once
  const out = await call("alice", "GET", `jobs/${id}/out/anki_bundle.json`);
  assert.equal(out.json.cards[0].id, "c001");
  assert.equal((await call("alice", "POST", `jobs/${id}/imported`)).json.first, true);
  assert.equal((await call("alice", "POST", `jobs/${id}/imported`)).json.first, false);
  assert.equal((await call("bob", "GET", `jobs/${id}/out/anki_bundle.json`)).status, 404);
  assert.ok(!existsSync(log.cwd), "a finished job's folder is removed");
});

const runDirs = (id: string) => readdirSync(join(HOME, "jobs")).filter((n) => n.startsWith(id));
test("a failing agent, or one that makes no bundle, fails the job and removes its folder", async () => {
  const d = await addDevice();
  for (const [mode, err] of [["crash", /exited with code 3: boom: model overloaded/], ["nothing", /no anki_bundle\.json was made/]] as const) {
    const id = await queuedJob("p3");
    setMode(mode);
    const r = await bridge.serve({ ...cfg(), server: base, token: d.token }, { once: true, log: () => {} });
    assert.equal(r.ok, false);
    const j = await job(id);
    assert.equal(j.status, "failed"); assert.match(j.error, err);
    assert.deepEqual(runDirs(id), [], "nothing is left behind");
    assert.equal(r.dir, undefined, "and the log doesn't point at a folder that is gone");
    assert.equal((await call("alice", "POST", `jobs/${id}/imported`)).status, 409);
  }
});

test("cancelling in the Studio stops the agent on the Mac", async () => {
  const d = await addDevice();
  const id = await queuedJob("p4");
  setMode("slow");
  const run = bridge.serve({ ...cfg(), server: base, token: d.token }, { once: true, log: () => {} });
  for (let i = 0; i < 100 && (await job(id)).status !== "running"; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call("alice", "POST", `jobs/${id}/cancel`)).json.status, "cancelled");
  const r = await run;
  assert.equal(r.cancelled, true);
  assert.equal((await job(id)).status, "cancelled");
});

test("jobs stay with their account and their device", async () => {
  for (const d of (await call("bob", "GET", "devices")).json) await call("bob", "DELETE", `devices/${d.id}`);
  const da = await addDevice("alice", "A1"), da2 = await addDevice("alice", "A2"), bobTok = (await addDevice("bob", "B1")).token;
  const id = await queuedJob("p5");
  // bob's device sees nothing of alice's
  assert.equal((await call({ token: bobTok }, "POST", "bridge/claim", { agents: ["claude"] })).json.job, null);
  assert.equal((await call({ token: bobTok }, "GET", `bridge/jobs/${id}/in/anki_prompt.txt`)).status, 404);
  // alice's first device claims it; her second device can't touch it
  const claimed = (await call(da, "POST", "bridge/claim", { agents: ["claude"] })).json.job;
  assert.equal(claimed.id, id);
  assert.equal((await call(da2, "GET", `bridge/jobs/${id}/in/anki_prompt.txt`)).status, 403);
  assert.equal((await call(da2, "POST", `bridge/jobs/${id}/events`, [{ type: "text", text: "hi" }])).status, 403);
  assert.equal((await call(da2, "POST", `bridge/jobs/${id}/finish`, { ok: true })).status, 403);
  assert.equal((await call(da, "GET", `bridge/jobs/${id}/in/not-declared.txt`)).status, 404);
  // results are only these names
  for (const n of ["evil.sh", "anki_bundle.json.exe", ".bashrc"]) assert.equal((await call(da, "PUT", `bridge/jobs/${id}/out/${n}`, undefined, Buffer.from("x"))).status, 400, n);
  // removing the device fails its running job and cuts it off
  await call("alice", "DELETE", `devices/${da.id}`);
  assert.equal((await job(id)).status, "failed");
  assert.equal((await call(da, "POST", `bridge/jobs/${id}/events`, [])).status, 401);
});

test("a running job whose bridge went quiet fails; agents the job doesn't use are not claimed", async () => {
  const d = await addDevice();
  const id = await queuedJob("p6");
  assert.equal((await call(d, "POST", "bridge/claim", { agents: ["codex"] })).json.job, null);   // it asks for claude
  assert.equal((await call(d, "POST", "bridge/claim", { agents: ["claude"] })).json.job.id, id);
  await db()("update acs_jobs set heartbeat_at = now() - interval '6 minutes' where id = $1", [id]);
  const j = await job(id);
  assert.equal((await call("alice", "GET", "jobs?project=p6")).json[0].status, "failed");
  assert.equal((await job(id)).error, "the bridge stopped responding");
  void j;
});

test("deleting the account removes its devices and jobs", async () => {
  const d = await addDevice("bob", "gone");
  await us.wipeUser(B.owner, false);
  assert.equal((await db()("select 1 from acs_devices where owner = $1", [B.owner])).length, 0);
  assert.equal((await db()("select 1 from acs_jobs where owner = $1", [B.owner])).length, 0);
  assert.equal((await call(d, "POST", "bridge/hello", {})).status, 401);
});

/* ------------------------------------------------------------------ the bridge script on its own */
test("the bridge only sends its token over https or to this machine, and checks the token's shape", () => {
  assert.equal(bridge.checkServer("https://studio.example.com/x"), "https://studio.example.com");
  assert.equal(bridge.checkServer("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  for (const s of ["http://studio.example.com", "ftp://x", "not a url", "http://192.168.1.5:3000"]) assert.throws(() => bridge.checkServer(s), s);
  assert.throws(() => bridge.client("https://x.example", "sk-ant-123"), /device token/);
});

test("the agents' JSON output becomes short progress events", () => {
  assert.deepEqual(bridge.toEvents("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use", name: "Write", input: { file_path: "build_deck.py" } }] } })),
    [{ type: "text", text: "Hi" }, { type: "tool", text: "Write: build_deck.py" }]);
  assert.deepEqual(bridge.toEvents("claude", JSON.stringify({ type: "result", is_error: false, result: "Done" })), [{ type: "result", text: "Done", final: true }]);
  assert.deepEqual(bridge.toEvents("codex", JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "python3 x.py" } })), [{ type: "tool", text: "$ python3 x.py" }]);
  assert.deepEqual(bridge.toEvents("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Saved" } })), [{ type: "text", text: "Saved" }]);
  assert.deepEqual(bridge.toEvents("claude", "plain text line"), [{ type: "log", text: "plain text line" }]);
  // codex: the sandbox flag and its own working folder, the fixed instruction last
  const args = bridge.agentArgs("codex", bridge.loadConfig(), "/tmp/job");
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"]);
  assert.equal(args.at(-1), bridge.INSTRUCTION);
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("pairing saves the token where only the user can read it", async () => {
  void readdirSync;
  // the test server runs in this process, so the bridge must run alongside it (spawnSync would block both)
  const { spawn } = await import("node:child_process");
  const spawnSync = (cmd: string, args: string[], o: { input: string; env: NodeJS.ProcessEnv; encoding: string }) => new Promise<{ status: number | null; stderr: string }>((res) => {
    const c = spawn(cmd, args, { env: o.env }); let stderr = "";
    c.stderr.on("data", (d) => { stderr += d; }); c.on("close", (status) => res({ status, stderr }));
    c.stdin.end(o.input);
  });
  const d = await addDevice("alice", "pairing");
  const home = mkdtempSync(join(tmpdir(), "acs-pair-"));
  const r = await spawnSync(process.execPath, ["bridge/acs-bridge.mjs", "pair", base], { input: d.token + "\n", env: { ...process.env, ACS_BRIDGE_HOME: home, ACS_BRIDGE_TOKEN: "", ACS_BRIDGE_SERVER: "" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const p = join(home, "config.json");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).token, d.token);
  const { statSync } = await import("node:fs");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const bad = await spawnSync(process.execPath, ["bridge/acs-bridge.mjs", "pair", base], { input: "acsd_" + "z".repeat(43) + "\n", env: { ...process.env, ACS_BRIDGE_HOME: mkdtempSync(join(tmpdir(), "acs-pair-")) }, encoding: "utf8" });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /refused the device token/);
});

// A server response must never choose a directory outside the job root.
test("the bridge refuses unsafe job ids before touching the filesystem", async () => {
  for (const id of ["../escape", "../../config.json", "", "/tmp/job"])
    await assert.rejects(bridge.runJob({} as never, { id } as never, cfg()), /invalid job id/);
});

test("Claude exposes only the configured built-in tools", () => {
  const c = cfg(), args = bridge.agentArgs("claude", c, "/tmp/job");
  assert.equal(args[args.indexOf("--tools") + 1], c.claudeTools.join(","));
});

test("disabled administrator devices are refused too", async () => {
  const d = await addDevice();
  const old = process.env.ACS_ADMIN_GITHUB;
  process.env.ACS_ADMIN_GITHUB = "alice";
  try {
    await db()("update acs_users set status = 'disabled' where owner = $1", [A.owner]);
    us.forgetUser(A.owner);
    assert.equal(await deviceUser(`Bearer ${d.token}`), null);
  } finally {
    if (old === undefined) delete process.env.ACS_ADMIN_GITHUB; else process.env.ACS_ADMIN_GITHUB = old;
    await db()("update acs_users set status = 'active' where owner = $1", [A.owner]);
    us.forgetUser(A.owner);
  }
});

test("Codex item errors appear in the progress log", () => {
  assert.deepEqual(bridge.toEvents("codex", JSON.stringify({type: "item.completed", item: {type: "error", message: "configuration warning"}})),
    [{type: "error", text: "configuration warning"}]);
});

test("removing the device during a run stops the agent (and what it started) on the Mac", async () => {
  for (const x of (await call("alice", "GET", "devices")).json) await call("alice", "DELETE", `devices/${x.id}`);   // under the limit of 10
  const d = await addDevice();
  const id = await queuedJob("p7");
  setMode("slow");
  const run = bridge.serve({ ...cfg(), server: base, token: d.token }, { once: true, log: () => {} });
  for (let i = 0; i < 100 && (await job(id)).status !== "running"; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  await call("alice", "DELETE", `devices/${d.id}`);
  await assert.rejects(run, /refused the device token/);
  const j = await job(id);
  assert.equal(j.status, "failed"); assert.equal(j.error, "the device was removed");
  assert.equal((await call("alice", "GET", `jobs/${id}`)).json.outputs.length, 0);   // nothing uploaded
});

test("old finished jobs are pruned a few at a time, never open ones", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) { const id = await queuedJob("p8"); await call("alice", "POST", `jobs/${id}/cancel`); ids.push(id); }
  const open = await queuedJob("p8");
  await db()("update acs_jobs set finished_at = now() - interval '20 days', created = now() - interval '20 days' where owner = $1 and project = 'p8'", [A.owner]);
  const left = async () => (await call("alice", "GET", "jobs?project=p8")).json.map((j: any) => j.id);
  assert.equal((await left()).length, 8 - 5);                 // first request: 5 of the 7 old ones
  assert.deepEqual(await left(), [open]);                      // next: the rest; the queued one stays
  assert.equal((await db()("select 1 from acs_files where owner = $1 and project = any($2::text[])", [A.owner, ids])).length, 0);
  await call("alice", "POST", `jobs/${open}/cancel`);
});

test("a job whose files never all arrived fails after a while, so it doesn't count against the open-job limit", async () => {
  const j = (await call("alice", "POST", "jobs", { project: "p9", kind: "cards", files: [{ name: "anki_prompt.txt", size: 2 }, { name: "L01.pdf", size: 2 }] })).json;
  await call("alice", "PUT", `jobs/${j.id}/in/anki_prompt.txt`, undefined, Buffer.from("hi"));   // the tab closed before L01.pdf
  assert.equal((await job(j.id)).status, "uploading");
  await db()("update acs_jobs set created = now() - interval '2 hours' where id = $1", [j.id]);
  const after = await job(j.id);
  assert.equal(after.status, "failed"); assert.equal(after.error, "its files never all arrived");
  assert.equal((await call("alice", "POST", `jobs/${j.id}/queue`)).status, 409);
  assert.equal((await call("alice", "DELETE", `jobs/${j.id}`)).status, 200);
});

test("two devices asking at once never both get the same job", async () => {
  const [d1, d2] = [await addDevice("alice", "one"), await addDevice("alice", "two")];
  const id = await queuedJob("p10");
  const got = await Promise.all([d1, d2, d1, d2].map((d) => call(d, "POST", "bridge/claim", { agents: ["claude"] })));
  for (const r of got) assert.equal(r.status, 200);
  // the job goes to one device only (that device asking again gets the same job: the answer may have been lost)
  const who = [d1, d2, d1, d2].filter((_, i) => got[i].json.job);
  assert.ok(who.length >= 1 && who.every((d) => d === who[0]), "one device has it");
  assert.deepEqual([...new Set(got.map((r) => r.json.job?.id).filter(Boolean))], [id]);
  assert.equal((await call(who[0] === d1 ? d2 : d1, "POST", "bridge/claim", { agents: ["claude"] })).json.job, null, "the other device never gets it");
  await call("alice", "POST", `jobs/${id}/cancel`);
});

test("progress posted at the same moment keeps every event, in order", async () => {
  const d = await addDevice();
  const id = await queuedJob("p11");
  assert.equal((await call(d, "POST", "bridge/claim", { agents: ["claude"] })).json.job.id, id);
  const posts = await Promise.all([0, 1, 2, 3].map((n) => call(d, "POST", `bridge/jobs/${id}/events`, [{ type: "text", text: `a${n}` }, { type: "text", text: `b${n}` }])));
  for (const r of posts) assert.equal(r.status, 200);
  const ev = (await call("alice", "GET", `jobs/${id}/events`)).json;
  assert.deepEqual(ev.map((e: any) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(ev.map((e: any) => e.text)).size, 8);
  await call("alice", "POST", `jobs/${id}/cancel`);
});

test("outputs the agent turned into links to files elsewhere on the Mac are never uploaded", async () => {
  const secret = join(HOME, "secret-key.txt"); writeFileSync(secret, "PRIVATE KEY 1234");
  process.env.ACS_FAKE_SECRET = secret;
  const d = await addDevice();
  const id = await queuedJob("p12");
  setMode("symlink");
  try {
    const r = await bridge.serve({ ...cfg(), server: base, token: d.token }, { once: true, log: () => {} });
    assert.equal(r?.ok, true);
    const j = await job(id);
    assert.deepEqual(j.outputs, ["anki_bundle.json"]);
    for (const name of ["reply.md", "anki_explanations.md"])
      assert.equal((await call("alice", "GET", `jobs/${id}/out/${name}`)).status, 404, name);
    const [row] = await db()<{ n: string }>("select count(*) as n from acs_files where owner = $1 and project = $2 and kind = 'jobout'", [A.owner, id]);
    assert.equal(Number(row.n), 1);
  } finally { setMode("ok"); }
});

/* ------------------------------------------------------------------ agent options, setup from the clipboard, the background service */
/** run the bridge script as the user would (async: the test server runs in this process) */
async function runScript(args: string[], env: Record<string, string>, input = "") {
  const { spawn } = await import("node:child_process");
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const c = spawn(process.execPath, ["bridge/acs-bridge.mjs", ...args], { env: { ...process.env, ACS_BRIDGE_TOKEN: "", ACS_BRIDGE_SERVER: "", ...env } });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
    c.on("close", (status) => res({ status, stdout, stderr }));
    c.stdin.end(input);
  });
}

test("a job's model, effort and limits reach the agent as checked flags; the Mac's own time limit wins", async () => {
  const d = await addDevice("alice", "options");
  const files = { "anki_prompt.txt": "Make cards.", "SKILL.md": "# skill" };
  const j = (await call("alice", "POST", "jobs", { project: "p-opt", kind: "cards", agent: "claude", title: "Opts", files: Object.entries(files).map(([name, t]) => ({ name, size: t.length })),
    options: { model: "opus", effort: "high", fallbackModel: "sonnet", maxBudgetUsd: 2.5, maxMinutes: 30, ignoredEmpty: "" } })).json;
  assert.deepEqual(j.options, { model: "opus", effort: "high", fallbackModel: "sonnet", maxBudgetUsd: 2.5, maxMinutes: 30 });
  for (const [name, t] of Object.entries(files)) await call("alice", "PUT", `jobs/${j.id}/in/${encodeURIComponent(name)}`, undefined, Buffer.from(t));
  await call("alice", "POST", `jobs/${j.id}/queue`);
  setMode("ok");
  const r = await bridge.serve({ ...cfg(), maxMinutes: 2, server: base, token: d.token }, { once: true, log: () => {} });
  assert.equal(r?.ok, true, JSON.stringify(r));
  const argv: string[] = JSON.parse(readFileSync(join(HOME, "argv.json"), "utf8")).argv;
  const after = (f: string) => argv[argv.indexOf(f) + 1];
  assert.equal(after("--model"), "opus"); assert.equal(after("--effort"), "high");
  assert.equal(after("--fallback-model"), "sonnet"); assert.equal(after("--max-budget-usd"), "2.5");
  assert.equal(argv[1], bridge.INSTRUCTION);
  const ev = (await call("alice", "GET", `jobs/${j.id}/events?after=0`)).json;
  assert.equal(ev[1].text, "Started with claude (model opus, effort high, fallback sonnet, max $ 2.5, limit min 2)");   // capped by the Mac's 2
});

test("the server refuses options that aren't for that agent or aren't well formed", async () => {
  const files = [{ name: "anki_prompt.txt", size: 1 }];
  const post = (agent: string, options: unknown) => call("alice", "POST", "jobs", { project: "p-opt", kind: "cards", agent, title: "x", files, options });
  for (const [agent, options] of [["claude", { model: "--dangerously-skip-permissions" }], ["claude", { model: "opus; rm -rf ~" }], ["claude", { effort: "ultra" }],
    ["codex", { effort: "xxl" }], ["codex", { fallbackModel: "sonnet" }], ["codex", { maxBudgetUsd: 1 }], ["claude", { maxBudgetUsd: 5000 }],
    ["claude", { maxMinutes: 1.5 }], ["claude", { temperature: 1 }], ["claude", ["opus"]], ["claude", { fallbackModel: "a,b,c,d" }]] as [string, unknown][]) {
    const r = await post(agent, options);
    assert.equal(r.status, 400, `${agent} ${JSON.stringify(options)}: ${r.text}`);
  }
  const ok = await post("codex", { model: "gpt-6-astra", effort: "minimal", maxMinutes: 10 });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.options, { model: "gpt-6-astra", effort: "minimal", maxMinutes: 10 });
  await call("alice", "DELETE", `jobs/${ok.json.id}`);
});

test("the bridge checks the options again itself: a job asking for anything else fails before the agent starts", async () => {
  assert.throws(() => bridge.agentOptions("claude", { model: "--permission-mode=bypassPermissions" }), /not a model name/);
  assert.throws(() => bridge.agentOptions("codex", { effort: 'high" sandbox_mode="danger-full-access' }), /effort must be one of/);
  assert.throws(() => bridge.agentOptions("codex", { fallbackModel: "x" }), /no option/);
  assert.deepEqual(bridge.agentOptions("claude", null), {});
  // Codex: -m and -c before the fixed instruction, which stays last
  const args = bridge.agentArgs("codex", cfg(), "/tmp/job", bridge.agentOptions("codex", { model: "gpt-6-astra", effort: "xhigh" }));
  assert.deepEqual(args.slice(-5), ["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"', bridge.INSTRUCTION]);
  // a server that let a bad option through: the job fails with the reason and the agent never runs
  const fakeApi = { events: async () => ({}), download: async () => Buffer.from("x"), upload: async () => {}, finish: async (_id: string, ok: boolean, error: string) => ({ job: { status: ok ? "done" : "failed", error } }) };
  writeFileSync(join(HOME, "argv.json"), "{}");
  const r = await bridge.runJob(fakeApi as never, { id: "jbadoptions00000", agent: "claude", files: [{ name: "anki_prompt.txt" }], options: { model: "-x" } } as never, cfg(), () => {});
  assert.equal(r.ok, false); assert.match(String(r.error), /not a model name/);
  assert.equal(readFileSync(join(HOME, "argv.json"), "utf8"), "{}");
});

test("the Studio, the server and the bridge allow the same efforts", async () => {
  const lib = await import("../lib/bridge");
  assert.deepEqual(lib.EFFORTS, bridge.EFFORTS);
  const studio = readFileSync("studio/src/11-settings.js", "utf8");
  const m = /const BR_EFFORTS = (\{[^\n]*\});/.exec(studio)!;
  assert.deepEqual(JSON.parse(m[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"')), bridge.EFFORTS);
});

test("setup reads the token from a pipe (pbpaste | …) and refuses a clipboard that holds something else", async () => {
  const d = await addDevice("alice", "clipboard");
  const home = mkdtempSync(join(tmpdir(), "acs-setup-"));
  const r = await runScript(["setup", "--server", base], { ACS_BRIDGE_HOME: home }, d.token);   // pbpaste adds no newline
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Paired with .* as alice/); assert.match(r.stdout, /install/);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).token, d.token);
  const bad = await runScript(["setup", "--server", base], { ACS_BRIDGE_HOME: mkdtempSync(join(tmpdir(), "acs-setup-")) }, "some other text\n");
  assert.equal(bad.status, 1); assert.match(bad.stderr, /isn't a device token/);
  const none = await runScript(["setup"], { ACS_BRIDGE_HOME: home }, d.token);
  assert.equal(none.status, 1); assert.match(none.stderr, /which Studio\?/);
});

test("install runs an installed copy as a LaunchAgent (keeps PATH, restarts after errors); uninstall stops it", async () => {
  const d = await addDevice("alice", "service");
  const home = mkdtempSync(join(tmpdir(), "acs-svc-")), agents = mkdtempSync(join(tmpdir(), "acs-la-")), calls = join(home, "launchctl.log");
  const fake = join(home, "launchctl.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'print') { if (fs.existsSync(${JSON.stringify(join(agents, "dev.ankicardstudio.bridge.plist"))})) console.log('state = running\\n\\tpid = 4242'); else process.exit(113); }
`);
  chmodSync(fake, 0o755);
  const env = { ACS_BRIDGE_HOME: home, ACS_BRIDGE_LAUNCHD_DIR: agents, ACS_BRIDGE_LAUNCHCTL: fake, ACS_BRIDGE_CLAUDE: FAKE };
  const notYet = await runScript(["install"], env);
  assert.equal(notYet.status, 1); assert.match(notYet.stderr, /not paired yet/);
  assert.equal((await runScript(["setup", "--server", base], env, d.token)).status, 0);
  const r = await runScript(["install"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runs in the background/);
  // a copy that stays put, and a plist launchd accepts
  const copy = join(home, "acs-bridge.mjs");
  assert.equal(readFileSync(copy, "utf8"), readFileSync("bridge/acs-bridge.mjs", "utf8"));
  const plistFile = join(agents, "dev.ankicardstudio.bridge.plist"), xml = readFileSync(plistFile, "utf8");
  const { spawnSync } = await import("node:child_process");
  if (process.platform === "darwin") assert.equal(spawnSync("plutil", ["-lint", plistFile]).status, 0, xml);
  assert.ok(xml.includes(`<string>${process.execPath}</string><string>${copy}</string><string>run</string>`), xml);
  assert.ok(xml.includes(`<key>PATH</key><string>${process.env.PATH!.replace(/&/g, "&amp;")}</string>`));
  assert.ok(xml.includes("<key>ACS_BRIDGE_SERVICE</key><string>1</string>"));
  assert.ok(xml.includes("<key>SuccessfulExit</key><false/>") && xml.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(xml.includes(`<key>StandardOutPath</key><string>${join(home, "bridge.log")}</string>`));
  assert.ok(!xml.includes(d.token), "the token stays in config.json");
  const uid = process.getuid!();
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [`bootout gui/${uid}/dev.ankicardstudio.bridge`, `bootstrap gui/${uid} ${plistFile}`]);
  assert.match((await runScript(["status"], env)).stdout, /Background: running \(pid 4242\)/);
  // uninstall: stopped, no longer at login; the pairing is kept
  const u = await runScript(["uninstall"], env);
  assert.equal(u.status, 0); assert.ok(!existsSync(plistFile));
  assert.match(readFileSync(calls, "utf8").trim().split("\n").at(-1)!, /^bootout gui\/\d+\/dev\.ankicardstudio\.bridge$/);
  assert.ok(existsSync(join(home, "config.json")));
  assert.match((await runScript(["status"], env)).stdout, /Background: not installed/);
});

test("in the background a removed device ends the bridge cleanly (no restart loop); other failures exit with an error", async () => {
  const d = await addDevice("alice", "gone");
  const home = mkdtempSync(join(tmpdir(), "acs-gone-"));
  const env = { ACS_BRIDGE_HOME: home, ACS_BRIDGE_CLAUDE: FAKE };
  assert.equal((await runScript(["setup", "--server", base], env, d.token)).status, 0);
  await call("alice", "DELETE", `devices/${d.id}`);
  const svc = await runScript(["run", "--once"], { ...env, ACS_BRIDGE_SERVICE: "1" });
  assert.equal(svc.status, 0, svc.stderr); assert.match(svc.stderr, /refused the device token[\s\S]*not restarting/);
  const tty = await runScript(["run", "--once"], env);
  assert.equal(tty.status, 1);
  const unpaired = await runScript(["run"], { ACS_BRIDGE_HOME: mkdtempSync(join(tmpdir(), "acs-none-")), ACS_BRIDGE_SERVICE: "1" });
  assert.equal(unpaired.status, 0); assert.match(unpaired.stderr, /not paired yet/);
});

test("a job's files may declare a sha256 (64 hex digits), which the bridge gets back; anything else is refused", async () => {
  const post = (sha256: unknown) => call("alice", "POST", "jobs", { project: "p-sha", kind: "cards", files: [{ name: "anki_prompt.txt", size: 2, sha256 }] });
  for (const bad of ["abc", "../../x", "A".repeat(64), 12, null]) assert.equal((await post(bad)).status, 400, String(bad));
  const ok = "0123456789abcdef".repeat(4), j = (await post(ok)).json;
  assert.deepEqual(j.files, [{ name: "anki_prompt.txt", size: 2, sha256: ok }]);
  assert.deepEqual((await job(j.id)).files[0].sha256, ok);
  assert.deepEqual((await call("alice", "POST", "jobs", { project: "p-sha", kind: "cards", files: [{ name: "anki_prompt.txt", size: 2 }] })).json.files, [{ name: "anki_prompt.txt", size: 2 }], "optional");
});
