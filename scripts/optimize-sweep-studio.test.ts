/**
 * The 2026-11-17 sweep, Studio and Mac bridge side: one IndexedDB connection for the page, job logs that don't repeat
 * lines when two refreshes overlap, and bridge event posts that never overtake each other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const between = (file: string, from: string, to: string) => { const s = readFileSync(file, "utf8"), a = s.indexOf(from), b = s.indexOf(to, a); assert.ok(a >= 0 && b > a, `${from} … ${to} in ${file}`); return s.slice(a, b); };

/** a minimal IndexedDB: counts open() calls, keeps values in a Map, and can fire versionchange / close */
function fakeIndexedDB() {
  const data = new Map<string, unknown>(), conns: any[] = [];
  let opens = 0;
  const later = (f: () => void) => setTimeout(f, 0);
  const request = (result: () => unknown) => { const r: any = {}; later(() => { r.result = result(); r.onsuccess?.(); }); return r; };
  const indexedDB = {
    open() {
      opens++;
      const db: any = { closed: false, close() { db.closed = true; },
        transaction() {
          if (db.closed) throw new Error("InvalidStateError: the connection is closing");
          const tx: any = {}; let n = 0; const done = () => later(() => tx.oncomplete?.());
          tx.objectStore = () => ({
            put: (v: unknown, k: string) => { n++; data.set(k, v); done(); return request(() => k); },
            get: (k: string) => request(() => data.get(k)),
            delete: (k: string) => { data.delete(k); done(); return request(() => undefined); },
            getAllKeys: () => request(() => [...data.keys()]),
          });
          return tx;
        } };
      conns.push(db);
      return request(() => db);
    },
  };
  return { indexedDB, data, conns, opens: () => opens };
}

test("IndexedDB: one connection serves every read and write, and a new one is opened after versionchange", async () => {
  const f = fakeIndexedDB();
  const ctx = vm.createContext({ indexedDB: f.indexedDB, IDBKeyRange: { bound: () => null }, console });
  vm.runInContext(between("studio/src/00-core.js", "const DB_NAME", "function mergeIndexLists("), ctx);
  vm.runInContext(between("studio/src/00-core.js", "async function idbKeys(", "function snapshot("), ctx);
  for (let i = 0; i < 20; i++) await ctx.idbPut("k" + i, i);
  assert.equal(await ctx.idbGet("k7"), 7);
  await Promise.all([ctx.idbGet("k1"), ctx.idbGet("k2"), ctx.idbDel("k3"), ctx.idbKeys("k")]);
  assert.equal(f.opens(), 1, "was one open() per call (25 here)");
  // another page upgrades the database: this one lets go of its connection and opens a new one when it needs it
  f.conns[0].onversionchange();
  assert.equal(f.conns[0].closed, true);
  assert.equal(await ctx.idbGet("k7"), 7);
  assert.equal(f.opens(), 2);
  // the browser closed it (storage cleared, for example): the same
  f.conns[1].onclose();
  await ctx.idbPut("x", 1);
  assert.equal(f.opens(), 3);
});

test("IndexedDB: a failed open is not kept, so the next call tries again", async () => {
  let fail = true, opens = 0;
  const ok = fakeIndexedDB();
  const indexedDB = { open() { opens++; if (!fail) return ok.indexedDB.open(); const r: any = {}; setTimeout(() => { r.error = new Error("quota"); r.onerror?.(); }, 0); return r; } };
  const ctx = vm.createContext({ indexedDB, console });
  vm.runInContext(between("studio/src/00-core.js", "const DB_NAME", "function mergeIndexLists("), ctx);
  assert.equal(await ctx.idbGet("a"), null);
  fail = false;
  await ctx.idbPut("a", 1);
  assert.equal(await ctx.idbGet("a"), 1);
  assert.equal(opens, 2);
});

test("job logs: two refreshes at once (the poll and a click on Log) add each line once", async () => {
  const events = [{ seq: 1, type: "log", text: "Picked up" }, { seq: 2, type: "text", text: "Reading" }];
  let calls = 0;
  const ctx = vm.createContext({
    BR: { open: new Set(["j1"]), logs: new Map() },
    brCall: async (_m: string, path: string) => { calls++; const after = Number(/after=(\d+)/.exec(path)![1]); await new Promise((r) => setTimeout(r, 5)); return events.filter((e) => e.seq > after); },
  });
  vm.runInContext(between("studio/src/19-bridge.js", "async function refreshLogs(", "async function openJobs("), ctx);
  await Promise.all([ctx.refreshLogs(), ctx.refreshLogs()]);
  assert.equal(calls, 2);
  const log = vm.runInContext("BR.logs.get('j1')", ctx);
  const seqs = () => JSON.stringify(log.items.map((e: any) => e.seq));   // (the vm's arrays are from another realm)
  assert.equal(seqs(), "[1,2]");
  assert.equal(log.after, 2);
  events.push({ seq: 3, type: "result", text: "done" });
  await Promise.all([ctx.refreshLogs(), ctx.refreshLogs(), ctx.refreshLogs()]);
  assert.equal(seqs(), "[1,2,3]");
});

test("bridge: event posts go one at a time, so a slow post is never overtaken (the server would drop its lines)", async () => {
  const HOME = realpathSync(mkdtempSync(join(tmpdir(), "acs-sweep-bridge-")));
  process.env.ACS_BRIDGE_HOME = HOME;
  // an agent that keeps talking for ~2 s: the 1.5 s flusher fires while the (slow) previous post is still out
  const fake = join(HOME, "chatty.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
const say = o => console.log(JSON.stringify(o));
let i = 0; const t = setInterval(() => { say({type:'assistant', message:{content:[{type:'text', text:'line ' + (++i)}]}}); if (i === 40) { clearInterval(t); say({type:'result', result:'ok'}); } }, 50);
`);
  chmodSync(fake, 0o755);
  process.env.ACS_BRIDGE_CLAUDE = fake;
  const bridge = await import("../bridge/acs-bridge.mjs");
  let active = 0, most = 0, serverSeq = 0;
  const stored: string[] = [], seqs = new Map<string, number>();
  const api = {
    // like the real client: numbers each event once; like the server: drops anything at or below the highest number seen
    async events(id: string, list: any[]) {
      let n = seqs.get(id) || 0; for (const e of list) if (e.n == null) e.n = ++n; seqs.set(id, n);
      active++; most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 2000));
      for (const e of list) if (e.n > serverSeq) { serverSeq = e.n; stored.push(e.text); }
      active--;
      return { cancel: false };
    },
    async download(_id: string, name: string) { return Buffer.from(name === "anki_prompt.txt" ? "make cards" : "#"); },
    async upload() {},
    async finish() { return { job: { status: "done" } }; },
  };
  const job = { id: "j" + "a".repeat(20), title: "t", kind: "cards", agent: "claude", files: [{ name: "anki_prompt.txt" }], options: {} };
  const r = await bridge.runJob(api, job, { ...bridge.loadConfig(), agents: ["claude"] }, () => {});
  assert.equal(r.ok, true);
  assert.equal(most, 1, "two posts were out at once");
  for (let i = 1; i <= 40; i++) assert.ok(stored.includes("line " + i), `line ${i} was lost`);
});

test("bridge: a burst of more than 200 lines goes up in posts of at most 200, and none is lost (found by the Sol review)", async () => {
  const HOME = realpathSync(mkdtempSync(join(tmpdir(), "acs-sweep-burst-")));
  process.env.ACS_BRIDGE_HOME = HOME;
  const fake = join(HOME, "burst.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
for (let i = 1; i <= 450; i++) console.log(JSON.stringify({type:'assistant', message:{content:[{type:'text', text:'line ' + i}]}}));
console.log(JSON.stringify({type:'result', result:'ok'}));
`);
  chmodSync(fake, 0o755);
  process.env.ACS_BRIDGE_CLAUDE = fake;
  const bridge = await import("../bridge/acs-bridge.mjs");
  const stored = new Set<string>(), sizes: number[] = [];
  let n = 0;
  const api = {
    // like the server: a post keeps only its first 200 events
    async events(_id: string, list: any[]) { for (const e of list) if (e.n == null) e.n = ++n; sizes.push(list.length); for (const e of list.slice(0, 200)) stored.add(e.text); return { cancel: false }; },
    async download() { return Buffer.from("make cards"); },
    async upload() {},
    async finish() { return { job: { status: "done" } }; },
  };
  const job = { id: "j" + "b".repeat(20), title: "t", kind: "cards", agent: "claude", files: [{ name: "anki_prompt.txt" }], options: {} };
  const r = await bridge.runJob(api, job, { ...bridge.loadConfig(), agents: ["claude"] }, () => {});
  assert.equal(r.ok, true);
  assert.ok(Math.max(...sizes) <= 200, `a post of ${Math.max(...sizes)} events`);
  for (let i = 1; i <= 450; i++) assert.ok(stored.has("line " + i), `line ${i} was lost`);
});
