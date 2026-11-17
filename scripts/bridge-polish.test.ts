/**
 * The Mac bridge when the network misbehaves: a request that reached the server but whose answer was lost is sent
 * again by the bridge, and the retry must not turn a finished job into an error.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { realpathSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { setDb } from "../lib/db";
import { handleApi } from "../lib/api";
import { deviceUser } from "../lib/bridge";
import * as us from "../lib/users";
import { forgetAllowedCache } from "../lib/allow";
import type { User } from "../lib/user";

const A: User = { owner: "gh:21", login: "carol" };
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "acs-bridge-polish-")));
process.env.ACS_BRIDGE_HOME = HOME;
process.env.ACS_ALLOWED_GITHUB = "carol";
const FAKE = join(HOME, "fake-claude.mjs");
writeFileSync(FAKE, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.ANKI_OUT_DIR + '/anki_bundle.json', JSON.stringify({format:'anki-studio/v1', deck:'D', cards:[{id:'c001', type:'basic', front:'Q?', back:'A'}]}));
console.log(JSON.stringify({type:'result', is_error:false, result:'Made 1 card.'}));
`);
chmodSync(FAKE, 0o755);
process.env.ACS_BRIDGE_CLAUDE = FAKE;

let pg: PGlite, server: http.Server, base = "";
let bridge: typeof import("../bridge/acs-bridge.mjs");
/** paths whose next request is carried out by the server, but whose answer never reaches the bridge */
const dropAnswer = new Set<string>();

before(async () => {
  pg = new PGlite();
  setDb((async (t: string, p: unknown[] = []) => (await pg.query(t, p)).rows) as never, async (work) => pg.transaction(async (tx) => work((async (t: string, p: unknown[] = []) => (await tx.query(t, p)).rows) as never)));
  await us.touchUser(A.owner, A.login);
  forgetAllowedCache();
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url!, "http://127.0.0.1");
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const user = req.headers.authorization ? await deviceUser(req.headers.authorization) : A;
    const out = await handleApi(r, url.pathname.replace(/^\/api\//, "").split("/"), user);
    const body = Buffer.from(await out.arrayBuffer());
    if (dropAnswer.delete(url.pathname)) return req.socket.destroy();   // done on the server, lost on the way back
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  bridge = await import("../bridge/acs-bridge.mjs");
});
after(async () => { server.close(); setDb(null); await pg.close(); });

async function call(who: "carol" | { token: string }, method: string, path: string, body?: unknown, raw?: Buffer) {
  const headers: Record<string, string> = who === "carol" ? { origin: base } : { authorization: `Bearer ${who.token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${base}/api/${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
}
async function queuedJob(project: string) {
  const files = { "anki_prompt.txt": "Make cards.", "SKILL.md": "# skill" };
  const j = (await call("carol", "POST", "jobs", { project, kind: "cards", agent: "claude", title: "L1", files: Object.entries(files).map(([name, t]) => ({ name, size: t.length })) })).json;
  for (const [name, t] of Object.entries(files)) assert.equal((await call("carol", "PUT", `jobs/${j.id}/in/${name}`, undefined, Buffer.from(t))).status, 200);
  assert.equal((await call("carol", "POST", `jobs/${j.id}/queue`)).json.status, "queued");
  return j.id as string;
}

test("finishing a job again (a retry) answers the finished job instead of an error", async () => {
  const d = (await call("carol", "POST", "devices", { name: "Mac" })).json;
  const id = await queuedJob("pa1");
  assert.equal((await call(d, "POST", "bridge/claim", { agents: ["claude"] })).json.job.id, id);
  assert.equal((await call(d, "PUT", `bridge/jobs/${id}/out/anki_bundle.json`, undefined, Buffer.from("{}"))).status, 200);
  const first = await call(d, "POST", `bridge/jobs/${id}/finish`, { ok: true });
  assert.equal(first.json.job.status, "done");
  const again = await call(d, "POST", `bridge/jobs/${id}/finish`, { ok: false, error: "late" });
  assert.equal(again.status, 200);
  assert.equal(again.json.job.status, "done", "a retry never changes the outcome");
  assert.equal(again.json.job.error, null);
  // another device still can't touch it
  const other = (await call("carol", "POST", "devices", { name: "Other" })).json;
  assert.equal((await call(other, "POST", `bridge/jobs/${id}/finish`, { ok: true })).status, 403);
  // and a job that failed stays failed
  const id2 = await queuedJob("pa2");
  assert.equal((await call(d, "POST", "bridge/claim", { agents: ["claude"] })).json.job.id, id2);
  assert.equal((await call(d, "POST", `bridge/jobs/${id2}/finish`, { ok: false, error: "boom" })).json.job.status, "failed");
  const again2 = await call(d, "POST", `bridge/jobs/${id2}/finish`, { ok: true });
  assert.equal(again2.status, 200);
  assert.equal(again2.json.job.status, "failed");
  assert.equal(again2.json.job.error, "boom");
  for (const dev of [d, other]) await call("carol", "DELETE", `devices/${dev.id}`);
});

test("a run whose 'finished' answer was lost is still reported as done, and its folder is cleaned up", async () => {
  const d = (await call("carol", "POST", "devices", { name: "Mac" })).json;
  const id = await queuedJob("pa3");
  dropAnswer.add(`/api/bridge/jobs/${id}/finish`);
  const r = await bridge.serve({ ...bridge.loadConfig(), agents: ["claude"], server: base, token: d.token }, { once: true, log: () => {} });
  assert.equal(dropAnswer.size, 0, "the first answer was dropped");
  assert.equal(r?.ok, true, `reported ${JSON.stringify(r)}`);
  assert.equal((await call("carol", "GET", `jobs/${id}`)).json.status, "done");
  assert.equal(existsSync(join(HOME, "jobs", id)), false, "a successful job's folder is removed");
  await call("carol", "DELETE", `devices/${d.id}`);
});
