/**
 * The 2026-11-17 optimization sweep: fewer round trips (schema check, quota totals, the project list, bridge events),
 * one object-storage client, and the bridge bugs it fixed (event posts that overtook each other and lost lines, text
 * Postgres refuses, option values of the wrong type). Statement counts are measured on PGlite through setDb().
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { setDb, db, ensureSchema, SCHEMA, SCHEMA_FINGERPRINT } from "../lib/db";
import { handleApi } from "../lib/api";
import { deviceUser, checkOptions, pgText } from "../lib/bridge";
import { objectStore, setObjectStore } from "../lib/object-storage";
import * as us from "../lib/users";
import { forgetAllowedCache } from "../lib/allow";
import type { User } from "../lib/user";

const A: User = { owner: "gh:31", login: "carol" };
process.env.ACS_ALLOWED_GITHUB = "carol";
let pg: PGlite;
/** every statement sent, in order (the transaction's too) */
let log: string[] = [];
const wire = () => setDb(
  (async (t: string, p: unknown[] = []) => { log.push(t); return (await pg.query(t, p)).rows; }) as never,
  async (work) => pg.transaction(async (tx) => work((async (t: string, p: unknown[] = []) => { log.push(t); return (await tx.query(t, p)).rows; }) as never)));

before(async () => {
  pg = new PGlite(); wire();
  await us.touchUser(A.owner, A.login);
  forgetAllowedCache();
});
after(async () => { setDb(null); await pg.close(); });
beforeEach(() => { log = []; });

const origin = "http://studio.test";
async function call(user: User | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = new Request(`${origin}/api/${path}`, { method, headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const out = await handleApi(r, path.split("?")[0].split("/"), user);
  const text = await out.text(); let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: out.status, json };
}

/* ------------------------------------------------------------------ cold start: the schema check */
test("a cold start on an up-to-date database checks the schema with one statement instead of running the DDL", async () => {
  const fresh = new PGlite(), q = (async (t: string, p: unknown[] = []) => { log.push(t); return (await fresh.query(t, p)).rows; }) as never;
  try {
    setDb(q); log = [];
    await ensureSchema();
    const first = log.length;
    assert.ok(first >= SCHEMA.length + 2, `first start runs the whole schema (${first} statements)`);
    // a new server instance: setDb forgets the cached promise, like a fresh process
    setDb(q); log = [];
    await ensureSchema();
    assert.equal(log.length, 1, `then only the fingerprint check (was ${first})`);
    assert.match(log[0], /obj_description/);
    // a database brought up by an older SCHEMA (another fingerprint, or none) gets the DDL again
    await fresh.query("comment on table acs_projects is 'acs-schema old'");
    setDb(q); log = [];
    await ensureSchema();
    assert.ok(log.length > SCHEMA.length);
    const [c] = (await fresh.query<{ v: string }>("select obj_description('acs_projects'::regclass, 'pg_class') as v")).rows;
    assert.equal(c.v, SCHEMA_FINGERPRINT);
    // npm run db:migrate runs it all regardless (it repairs a column dropped by hand)
    await fresh.query("alter table acs_jobs drop column options");
    setDb(q); log = [];
    await ensureSchema(true);
    assert.ok(log.length > SCHEMA.length);
    assert.equal((await fresh.query("select options from acs_jobs limit 1")).rows.length, 0);
  } finally { wire(); await fresh.close(); }
});

test("the schema check never fails on an empty database (no table yet)", async () => {
  const fresh = new PGlite();
  try {
    setDb((async (t: string, p: unknown[] = []) => (await fresh.query(t, p)).rows) as never);
    await ensureSchema();
    assert.equal((await fresh.query("select 1 from acs_jobs limit 1")).rows.length, 0);
  } finally { wire(); await fresh.close(); }
});

/* ------------------------------------------------------------------ writes: no usage totals without a storage limit */
const usageQueries = () => log.filter((t) => /octet_length\(data\)\), 0\) as b from acs_projects|sum\(n\),0\) as bytes/.test(t)).length;

test("a write by an account without a storage limit computes no usage totals", async () => {
  await db()("update acs_users set quota_mb = null where owner = $1", [A.owner]); us.forgetUser(A.owner);
  log = [];
  assert.equal((await call(A, "PUT", "settings", { theme: "dark" })).status, 200);
  assert.equal(usageQueries(), 0);
  // it still trims the history (the default 64 MB budget)
  assert.ok(log.some((t) => /delete from acs_history where ctid/.test(t)));
});

test("an account with a storage limit is still held to it", async () => {
  await db()("update acs_users set quota_mb = 1 where owner = $1", [A.owner]); us.forgetUser(A.owner);
  try {
    log = [];
    assert.equal((await call(A, "PUT", "settings", { small: true })).status, 200);
    assert.ok(usageQueries() >= 2, "before and after totals");
    const big = JSON.stringify({ blob: "x".repeat(1_200_000) });
    const r = await call(A, "PUT", "settings", big);
    assert.equal(r.status, 413);
    assert.deepEqual((await call(A, "GET", "settings")).json, { small: true });   // rolled back
  } finally { await db()("update acs_users set quota_mb = null where owner = $1", [A.owner]); us.forgetUser(A.owner); }
});

/* ------------------------------------------------------------------ the project list: one query */
test("the project list is read with one query, without deleted projects, and is null until one was stored", async () => {
  const B: User = { owner: "gh:32", login: "carol" };
  await us.touchUser(B.owner, B.login);
  log = [];
  assert.equal((await call(B, "GET", "projects")).json, null);
  assert.equal(log.filter((t) => /acs_index|acs_deleted/.test(t)).length, 1);
  await call(B, "PUT", "projects", [{ id: "pa", name: "A", updated: 1 }, { id: "pb", name: "B", updated: 1 }]);
  await call(B, "DELETE", "project/pb");
  log = [];
  assert.deepEqual((await call(B, "GET", "projects")).json.map((e: any) => e.id), ["pa"]);
  assert.equal(log.filter((t) => /acs_index|acs_deleted/.test(t)).length, 1);
  // an entry left behind for a deleted project (an older server) stays hidden: the list is empty, not null
  await call(B, "DELETE", "project/pa");
  await db()("insert into acs_index (owner, id, entry, updated) values ($1, 'pa', $2, 1)", [B.owner, JSON.stringify({ id: "pa", name: "A" })]);
  assert.deepEqual((await call(B, "GET", "projects")).json, []);
  // a deleted project can't be saved without an explicit restore
  assert.equal((await call(B, "PUT", "project/pa", { rev: 1 })).status, 410);
  assert.equal((await call(B, "PUT", "project/pa", { rev: 1 }, { "x-acs-restore": "1" })).status, 200);
});

/* ------------------------------------------------------------------ bridge events */
async function runningJob() {
  const d = (await call(A, "POST", "devices", { name: "Mac" })).json as { token: string };
  const files = ["anki_prompt.txt"];
  const j = (await call(A, "POST", "jobs", { project: "p1", kind: "cards", agent: "claude", files: files.map((name) => ({ name, size: 2 })) })).json;
  for (const name of files) {
    const r = new Request(`${origin}/api/jobs/${j.id}/in/${name}`, { method: "PUT", headers: { origin }, body: Buffer.from("hi") });
    assert.equal((await handleApi(r, ["jobs", j.id, "in", name], A)).status, 200);
  }
  await call(A, "POST", `jobs/${j.id}/queue`);
  const dev = (await deviceUser(`Bearer ${d.token}`))!;
  assert.equal((await call(dev, "POST", "bridge/claim", { agents: ["claude"] })).json.job.id, j.id);
  return { id: j.id as string, dev };
}

test("a post of many events is stored with one insert, in order, and a retried post adds nothing", async () => {
  const { id, dev } = await runningJob();
  const events = Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `line ${i + 1}`, n: i + 1 }));
  log = [];
  assert.equal((await call(dev, "POST", `bridge/jobs/${id}/events`, events)).status, 200);
  assert.equal(log.filter((t) => /insert into acs_job_events/.test(t)).length, 1, "was one insert per event (200)");
  const got = (await call(A, "GET", `jobs/${id}/events`)).json;
  assert.equal(got.length, 200);
  assert.deepEqual(got.map((e: any) => e.seq), events.map((e) => e.n));
  assert.equal(got[199].text, "line 200");
  // the same post again (its answer was lost): nothing new
  await call(dev, "POST", `bridge/jobs/${id}/events`, events);
  assert.equal((await call(A, "GET", `jobs/${id}/events`)).json.length, 200);
  assert.equal((await call(A, "GET", `jobs/${id}`)).json.events, 200);
});

test("event text Postgres can't hold (NUL, half an emoji) is cleaned instead of failing the post forever", async () => {
  const { id, dev } = await runningJob();
  const emoji = "😀".repeat(2500);      // clipped at 4000 UTF-16 units: exactly 2000 whole emoji
  const cut = "a" + "😀".repeat(2500);  // shifted by one: the 4000th unit is a high surrogate whose low half is cut off
  const r = await call(dev, "POST", `bridge/jobs/${id}/events`, [
    { type: "tool", text: "cat: bin\u0000ary", n: 1 }, { type: "text", text: cut, n: 2 }, { type: "text", text: emoji, n: 3 }, { type: "lo\u0000g", text: "\udc00x", n: 4 }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const got = (await call(A, "GET", `jobs/${id}/events`)).json;
  assert.equal(got[0].text, "cat: binary");
  assert.equal(got[1].text.length, 4000); assert.ok(got[1].text.endsWith("�")); assert.ok(got[1].text.startsWith("a😀"));
  assert.equal(got[2].text, "😀".repeat(2000));
  assert.equal(got[3].type, "log"); assert.equal(got[3].text, "�x");
  // and a failed run's error with a NUL still finishes the job
  const fin = await call(dev, "POST", `bridge/jobs/${id}/finish`, { ok: false, error: "boom\u0000" });
  assert.equal(fin.status, 200); assert.equal(fin.json.job.status, "failed"); assert.equal(fin.json.job.error, "boom");
});

test("pgText keeps well-formed text as it is", () => {
  for (const s of ["", "plain", "😀 emoji and ünïcode", "tabs\tand\nnewlines"]) assert.equal(pgText(s), s);
  assert.equal(pgText("\ud83d"), "�"); assert.equal(pgText("x\ude00"), "x�"); assert.equal(pgText("\u0000"), "");
});

/* ------------------------------------------------------------------ job options: types */
test("job options must have the right type: names are strings, limits numbers", async () => {
  const bridge = await import("../bridge/acs-bridge.mjs");
  for (const bad of [{ model: ["opus"] }, { model: true }, { effort: ["high"] }, { fallbackModel: { a: 1 } }, { maxMinutes: true }, { maxMinutes: [30] }, { maxBudgetUsd: " " }]) {
    assert.throws(() => checkOptions("claude", bad), /must be a (string|number)|is 0-1000|is 1-1440/, JSON.stringify(bad));
    assert.throws(() => bridge.agentOptions("claude", bad), /must be a (string|number)|between 0 and 1000|1-1440/, JSON.stringify(bad));
  }
  assert.deepEqual(checkOptions("claude", { model: " opus ", maxMinutes: "30", maxBudgetUsd: 2.5 }), { model: "opus", maxMinutes: 30, maxBudgetUsd: 2.5 });
  // the bridge turns digits into a number too (it was left a string)
  assert.deepEqual(bridge.agentOptions("claude", { model: "opus", maxMinutes: "30" }), { model: "opus", maxMinutes: 30 });
  // a job asking for a list as its model is refused when it is made
  const r = await call(A, "POST", "jobs", { project: "p1", kind: "cards", agent: "claude", options: { model: ["opus"] }, files: [{ name: "anki_prompt.txt", size: 1 }] });
  assert.equal(r.status, 400);
});

/* ------------------------------------------------------------------ object storage: one client */
test("object storage keeps one client per configuration", () => {
  const names = ["AWS_ENDPOINT_URL_S3", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  const saved = names.map((n) => process.env[n]);
  setObjectStore(undefined);
  try {
    for (const n of names) process.env[n] = "test-" + n;
    const a = objectStore(), b = objectStore(true);
    assert.ok(a); assert.equal(a, b);
    process.env.AWS_REGION = "elsewhere";
    assert.notEqual(objectStore(), a);
  } finally {
    names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
  }
});
