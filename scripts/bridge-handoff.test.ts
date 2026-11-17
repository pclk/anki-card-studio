/**
 * How the bridge hands a job to the agent: a new folder per run with the files in it (removed however the run ends),
 * only the fixed instruction on the command line, big prompt blocks in files of their own (that the helper still
 * finds by id), and files kept by content so the same skill / slides are downloaded once.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync, utimesSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "acs-handoff-")));
process.env.ACS_BRIDGE_HOME = HOME;
const LOG = join(HOME, "agent.json");
const FAKE = join(HOME, "fake-claude.mjs");
// records what it was given, then behaves as ACS_FAKE_MODE says
writeFileSync(FAKE, `#!/usr/bin/env node
import fs from 'node:fs';
const blocks = fs.existsSync('anki_blocks') ? Object.fromEntries(fs.readdirSync('anki_blocks').map(n => [n, fs.readFileSync('anki_blocks/' + n, 'utf8')])) : {};
fs.writeFileSync(${JSON.stringify(LOG)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.').sort(),
  prompt: fs.readFileSync('anki_prompt.txt', 'utf8'), blocks, pdf: fs.existsSync('L01.pdf') ? fs.readFileSync('L01.pdf', 'utf8') : null}));
const mode = process.env.ACS_FAKE_MODE || 'ok';
if (mode === 'crash') { console.error('boom'); process.exit(2); }
if (mode === 'slow') { setInterval(() => console.log(JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'working'}]}})), 50); }
else {
  fs.writeFileSync(process.env.ANKI_OUT_DIR + '/anki_bundle.json', '{"cards":[]}');
  console.log(JSON.stringify({type: 'result', is_error: false, result: 'done'}));
}
`);
chmodSync(FAKE, 0o755);
process.env.ACS_BRIDGE_CLAUDE = FAKE;

let bridge: typeof import("../bridge/acs-bridge.mjs");
before(async () => { bridge = await import("../bridge/acs-bridge.mjs"); });
after(() => rmSync(HOME, { recursive: true, force: true }));

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const cfg = (extra: Record<string, unknown> = {}) => ({ ...bridge.loadConfig(), agents: ["claude"], ...extra });
let n = 0;
const jobId = () => `jhandoff${String(++n).padStart(6, "0")}`;
const agentLog = () => JSON.parse(readFileSync(LOG, "utf8"));
const runDirs = (id?: string) => (existsSync(join(HOME, "jobs")) ? readdirSync(join(HOME, "jobs")) : []).filter((d) => d.startsWith(id ?? "j"));

/** a stand-in for the Studio's API: serves `files`, records downloads and finishes; `cancelAfter` events → cancel */
function fakeApi(files: Record<string, string | Buffer>, o: { cancelAfter?: number; failDownload?: string; fatalAfter?: number } = {}) {
  const api = {
    downloads: [] as string[], finished: [] as { ok: boolean; error: string }[], uploads: [] as string[], posts: 0,
    async events(_id: string, _list: unknown[]) {
      api.posts++;
      if (o.fatalAfter && api.posts > o.fatalAfter) throw Object.assign(new Error("the Studio refused the device token"), { fatal: true });
      return { cancel: !!o.cancelAfter && api.posts > o.cancelAfter };
    },
    async download(_id: string, name: string) {
      api.downloads.push(name);
      if (name === o.failDownload) throw new Error(`GET ${name}: HTTP 500`);
      return Buffer.from(files[name]);
    },
    async upload(_id: string, name: string) { api.uploads.push(name); },
    async finish(_id: string, ok: boolean, error: string) { api.finished.push({ ok, error }); return { job: { status: ok ? "done" : "failed", error } }; },
  };
  return api;
}
const decl = (files: Record<string, string | Buffer>, hashes = true) => Object.entries(files).map(([name, t]) => ({ name, size: t.length, ...(hashes ? { sha256: sha(t) } : {}) }));
const big = (id: string, ch = "x", len = 40_000) => `<<<SOURCE id=${id}\n[L01.pdf p.1]\n${ch.repeat(len)}\nSOURCE>>>`;

/* ------------------------------------------------------------------ the folder */
test("each run gets a new private folder under jobs/, removed after a successful run", async () => {
  const id = jobId(), files = { "anki_prompt.txt": "Make cards.", "L01.pdf": "%PDF-1" };
  const r = await bridge.runJob(fakeApi(files), { id, agent: "claude", files: decl(files) }, cfg(), () => {});
  assert.equal(r.ok, true, JSON.stringify(r));
  const log = agentLog();
  assert.match(log.cwd, new RegExp(`/jobs/${id}-${process.pid}-[A-Za-z0-9]{6}$`));
  assert.deepEqual(log.files, ["AGENTS.md", "L01.pdf", "anki-skill", "anki_out", "anki_prompt.txt"]);
  assert.equal(log.pdf, "%PDF-1");
  assert.equal(existsSync(log.cwd), false);
  assert.deepEqual(runDirs(id), []);
  assert.equal(r.dir, undefined);
});

test("two runs of the same job at once (a lost claim answer, two bridges) never share a folder", async () => {
  const id = jobId(), files = { "anki_prompt.txt": "Make cards." };
  process.env.ACS_FAKE_MODE = "slow";
  const a = fakeApi(files, { cancelAfter: 3 }), b = fakeApi(files, { cancelAfter: 3 });
  const runs = [bridge.runJob(a, { id, agent: "claude", files: decl(files) }, cfg(), () => {}), bridge.runJob(b, { id, agent: "claude", files: decl(files) }, cfg(), () => {})];
  // while both are running, there are two folders for the one job
  for (let i = 0; i < 100 && runDirs(id).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runDirs(id).length, 2);
  const [ra, rb] = await Promise.all(runs);
  delete process.env.ACS_FAKE_MODE;
  assert.equal(ra.cancelled, true); assert.equal(rb.cancelled, true);
  assert.deepEqual(runDirs(id), []);
});

test("keepJobs keeps the folder (done or failed) and says where it is", async () => {
  const id = jobId(), files = { "anki_prompt.txt": "Make cards." };
  process.env.ACS_FAKE_MODE = "crash";
  const r = await bridge.runJob(fakeApi(files), { id, agent: "claude", files: decl(files) }, cfg({ keepJobs: true }), () => {});
  delete process.env.ACS_FAKE_MODE;
  assert.equal(r.ok, false);
  assert.ok(r.dir && existsSync(join(r.dir, "anki_prompt.txt")));
  rmSync(r.dir!, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ cleanup however it ends */
test("the folder is removed when the agent fails", async () => {
  const id = jobId(), files = { "anki_prompt.txt": "Make cards." }, api = fakeApi(files);
  process.env.ACS_FAKE_MODE = "crash";
  const r = await bridge.runJob(api, { id, agent: "claude", files: decl(files) }, cfg(), () => {});
  delete process.env.ACS_FAKE_MODE;
  assert.equal(r.ok, false); assert.match(api.finished[0].error, /exited with code 2: boom/);
  assert.deepEqual(runDirs(id), []);
});

test("the folder is removed when a download fails, a name is refused, or the prompt is missing", async () => {
  for (const [files, job, err] of [
    [{ "anki_prompt.txt": "p", "L01.pdf": "x" }, { failDownload: "L01.pdf" }, /HTTP 500/],
    [{ "anki_prompt.txt": "p", "../evil.txt": "x" }, {}, /refusing the file name/],
    [{ "L01.pdf": "x" }, {}, /no anki_prompt\.txt/],
  ] as const) {
    const id = jobId(), api = fakeApi(files as Record<string, string>, job);
    const r = await bridge.runJob(api, { id, agent: "claude", files: decl(files as Record<string, string>) }, cfg(), () => {});
    assert.equal(r.ok, false); assert.match(r.error!, err);
    assert.equal(api.finished.length, 1, "the Studio hears it failed");
    assert.deepEqual(runDirs(id), [], `nothing left after ${r.error}`);
  }
});

test("the folder is removed when the job is cancelled, before or during the run", async () => {
  for (const cancelAfter of [1, 3]) {
    const id = jobId(), files = { "anki_prompt.txt": "Make cards.", "L01.pdf": "%PDF" };
    process.env.ACS_FAKE_MODE = "slow";
    const r = await bridge.runJob(fakeApi(files, { cancelAfter }), { id, agent: "claude", files: decl(files) }, cfg(), () => {});
    delete process.env.ACS_FAKE_MODE;
    assert.equal(r.cancelled, true);
    assert.deepEqual(runDirs(id), []);
  }
});

test("the folder is removed when the device is removed mid-run (the error still ends the bridge)", async () => {
  const id = jobId(), files = { "anki_prompt.txt": "Make cards." };
  process.env.ACS_FAKE_MODE = "slow";
  await assert.rejects(bridge.runJob(fakeApi(files, { fatalAfter: 2 }), { id, agent: "claude", files: decl(files) }, cfg(), () => {}), /refused the device token/);
  delete process.env.ACS_FAKE_MODE;
  assert.deepEqual(runDirs(id), []);
});

test("file names the bridge uses itself are refused, in any case", async () => {
  for (const name of ["AGENTS.md", "agents.md", "anki_out", "ANKI_BLOCKS", "anki-skill", ".hidden", "a/b.pdf", ".."]) {
    const id = jobId(), files = { "anki_prompt.txt": "p", [name]: "x" };
    const r = await bridge.runJob(fakeApi(files), { id, agent: "claude", files: decl(files) }, cfg(), () => {});
    assert.match(r.error || "", /refusing the file name/, name);
    assert.deepEqual(runDirs(id), []);
  }
});

test("folders a stopped bridge left behind are swept once no run can still use them; nothing else is touched", () => {
  const jobs = join(HOME, "jobs"); mkdirSync(jobs, { recursive: true });
  const old = Date.now() / 1000 - 3 * 3600;
  for (const d of ["jsweep00000001-Ab12Cd", "jsweep00000002", "jsweep00000003-Zz99Yy", "not-a-job"]) mkdirSync(join(jobs, d), { recursive: true });
  writeFileSync(join(jobs, "mode"), "ok");
  for (const d of ["jsweep00000001-Ab12Cd", "jsweep00000002", "not-a-job"]) utimesSync(join(jobs, d), old, old);
  bridge.sweepJobs(cfg({ keepJobs: true }));
  assert.ok(existsSync(join(jobs, "jsweep00000001-Ab12Cd")), "keepJobs keeps them");
  bridge.sweepJobs(cfg());   // maxMinutes 60: older than 75 minutes goes
  const left = readdirSync(jobs);
  assert.ok(!left.includes("jsweep00000001-Ab12Cd") && !left.includes("jsweep00000002"));
  assert.ok(left.includes("jsweep00000003-Zz99Yy"), "a recent one may still be running");
  assert.ok(left.includes("not-a-job") && left.includes("mode"));
  for (const d of ["jsweep00000003-Zz99Yy", "not-a-job", "mode"]) rmSync(join(jobs, d), { recursive: true, force: true });
});

test("a folder owned by a running bridge is never swept by another one with a shorter limit; a dead owner's goes at once", () => {
  const jobs = join(HOME, "jobs"); mkdirSync(jobs, { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
  const mine = `jowner00000001-${process.pid}-Ab12Cd`, live = `jowner00000002-${process.ppid}-Ab12Cd`, gone = `jowner00000003-${dead}-Ab12Cd`;
  const old = Date.now() / 1000 - 3 * 3600;
  for (const d of [mine, live, gone]) { mkdirSync(join(jobs, d)); utimesSync(join(jobs, d), old, old); }
  bridge.sweepJobs(cfg({ maxMinutes: 1 }));
  const left = readdirSync(jobs);
  assert.ok(left.includes(mine), "never this bridge's own"); assert.ok(left.includes(live), "another live bridge's run may still be going");
  assert.ok(!left.includes(gone), "its bridge is gone: nothing can use it");
  bridge.sweepJobs(cfg(), Date.now() + 25 * 3600_000);   // past the longest run any bridge allows
  assert.ok(!readdirSync(jobs).includes(live));
  for (const d of readdirSync(jobs)) rmSync(join(jobs, d), { recursive: true, force: true });
});

/* ------------------------------------------------------------------ what the agent gets */
test("the agent gets only the fixed instruction; the prompt and files are files", async () => {
  const id = jobId(), files = { "anki_prompt.txt": "SECRET-PROMPT-TEXT\n" + big("s-0123abcd"), "L01.pdf": "%PDF-SECRET" };
  await bridge.runJob(fakeApi(files), { id, agent: "claude", files: decl(files) }, cfg(), () => {});
  const log = agentLog();
  assert.equal(log.argv[1], bridge.INSTRUCTION);
  assert.ok(!log.argv.some((a: string) => /SECRET|xxxx/.test(a)), "nothing from the job is on the command line");
  assert.match(bridge.INSTRUCTION, /anki_blocks/);
  for (const agent of ["claude", "codex"]) assert.ok(!bridge.agentArgs(agent, cfg(), "/d").some((a) => a.length > bridge.INSTRUCTION.length), "no payload in the args");
});

test("a big block leaves the prompt for anki_blocks/<id>.txt; a small one stays inline", async () => {
  const id = jobId();
  const small = "<<<REVISE_CARDS id=r-00aa11bb\n{\"cards\": []}\nREVISE_CARDS>>>";
  const files = { "anki_prompt.txt": `Use the skill.\n\n## Source material\n${big("s-0123abcd")}\n\n${small}\n\nThe end.` };
  await bridge.runJob(fakeApi(files), { id, agent: "claude", files: decl(files) }, cfg(), () => {});
  const log = agentLog();
  assert.ok(log.files.includes("anki_blocks"));
  assert.deepEqual(Object.keys(log.blocks), ["s-0123abcd.txt"]);
  assert.equal(log.blocks["s-0123abcd.txt"], big("s-0123abcd"), "the block file is the whole block, markers and all");
  assert.ok(log.prompt.length < 1000, `the prompt is short now (${log.prompt.length})`);
  assert.match(log.prompt, /anki_blocks\/s-0123abcd\.txt/); assert.match(log.prompt, /load_source\("s-0123abcd"\)/);
  assert.ok(!log.prompt.includes("<<<SOURCE") && !log.prompt.includes("SOURCE>>>"), "the pointer is not itself a block");
  assert.ok(log.prompt.includes(small) && log.prompt.endsWith("The end."));
});

test("splitBlocks: REVISE_CARDS points at Deck.load, the same block twice is written once, the threshold is respected", () => {
  const cards = `<<<REVISE_CARDS id=r-11223344\n${JSON.stringify({ cards: Array(1000).fill({ id: "c1", front: "Q" }) })}\nREVISE_CARDS>>>`;
  const { prompt, blocks } = bridge.splitBlocks(`a\n${cards}\nb\n${cards}`);
  assert.equal(blocks.length, 1); assert.equal(blocks[0].id, "r-11223344"); assert.equal(blocks[0].text, cards);
  assert.equal(prompt.match(/Deck\.load\("r-11223344"\)/g)?.length, 2);
  assert.equal(bridge.splitBlocks(cards, cards.length).blocks.length, 0, "exactly at the limit stays inline");
  // not a real block id (the helper only reads these), or no end marker: left alone
  for (const t of [`<<<SOURCE id=s-NOTHEX00\n${"y".repeat(20_000)}\nSOURCE>>>`, `<<<SOURCE id=s-0123abcd\n${"y".repeat(20_000)}`]) assert.equal(bridge.splitBlocks(t).prompt, t);
});

test("the skill's helper still finds a block that moved to anki_blocks (find_block / load_source by id)", { skip: spawnSync("python3", ["--version"]).status !== 0 && "no python3" }, () => {
  const dir = mkdtempSync(join(HOME, "py-")), block = big("s-0123abcd", "z", 30_000);
  const { prompt, blocks } = bridge.splitBlocks(`Make cards.\n${block}`);
  writeFileSync(join(dir, "anki_prompt.txt"), prompt);
  mkdirSync(join(dir, "anki_blocks")); writeFileSync(join(dir, "anki_blocks", `${blocks[0].id}.txt`), blocks[0].text);
  copyFileSync(join(process.cwd(), "skill/anki/scripts/anki_helper.py"), join(dir, "anki_helper.py"));
  const r = spawnSync("python3", ["-I", "-c", "import sys; sys.path.insert(0, '.'); from anki_helper import find_block; t, p = find_block('s-0123abcd', 'SOURCE'); print(len(t), p.split('/')[-2])"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, ANKI_MATERIAL_DIR: dir, HOME: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").pop(), `${"[L01.pdf p.1]\n".length + 30_000} anki_blocks`);
});

/* ------------------------------------------------------------------ files kept by content */
test("a file with a declared sha256 is downloaded once and then copied from the cache", async () => {
  const helper = "# helper " + "h".repeat(5000), files = { "anki_prompt.txt": "Part 1", "anki_helper.py": helper, "L01.pdf": "%PDF-same" };
  const a = fakeApi(files);
  await bridge.runJob(a, { id: jobId(), agent: "claude", files: decl(files) }, cfg(), () => {});
  assert.deepEqual(a.downloads.sort(), ["L01.pdf", "anki_helper.py", "anki_prompt.txt"]);
  assert.ok(existsSync(join(HOME, "cache", sha(helper))));
  const files2 = { ...files, "anki_prompt.txt": "Part 2" }, b = fakeApi(files2);
  const logs: string[] = [];
  const r = await bridge.runJob({ ...b, events: async (_: string, list: { text: string }[]) => { logs.push(...list.map((e) => e.text)); return { cancel: false }; } } as never,
    { id: jobId(), agent: "claude", files: decl(files2) }, cfg(), () => {});
  assert.equal(r.ok, true);
  assert.deepEqual(b.downloads, ["anki_prompt.txt"], "only what changed is downloaded");
  assert.equal(agentLog().pdf, "%PDF-same");
  assert.ok(logs.some((t) => /2 of 3 file\(s\) were already on this Mac/.test(t)), logs.join("\n"));
});

test("the cache never serves the wrong bytes: a wrong hash isn't cached, a damaged entry is downloaded again", async () => {
  const files = { "anki_prompt.txt": "p", "L01.pdf": "%PDF-real" };
  // declared hash doesn't match what arrives: used for this run, not kept
  const wrong = sha("something else"), a = fakeApi(files);
  await bridge.runJob(a, { id: jobId(), agent: "claude", files: [{ name: "anki_prompt.txt", size: 1 }, { name: "L01.pdf", size: 9, sha256: wrong }] }, cfg(), () => {});
  assert.equal(agentLog().pdf, "%PDF-real");
  assert.equal(existsSync(join(HOME, "cache", wrong)), false);
  // a cache entry whose bytes changed is ignored and replaced
  const good = sha("%PDF-real"); mkdirSync(join(HOME, "cache"), { recursive: true }); writeFileSync(join(HOME, "cache", good), "tampered");
  const b = fakeApi(files);
  await bridge.runJob(b, { id: jobId(), agent: "claude", files: decl(files) }, cfg(), () => {});
  assert.ok(b.downloads.includes("L01.pdf"));
  assert.equal(agentLog().pdf, "%PDF-real");
  assert.equal(readFileSync(join(HOME, "cache", good), "utf8"), "%PDF-real");
  // a malformed hash is just a download (it never becomes a path)
  const c = fakeApi(files);
  await bridge.runJob(c, { id: jobId(), agent: "claude", files: [{ name: "anki_prompt.txt", size: 1 }, { name: "L01.pdf", size: 9, sha256: "../../config.json" }] }, cfg(), () => {});
  assert.ok(c.downloads.includes("L01.pdf"));
});

test("the cache drops entries unused for a week, stray files, and the oldest beyond its size", () => {
  const cache = join(HOME, "cache"); rmSync(cache, { recursive: true, force: true }); mkdirSync(cache);
  const fresh = sha("fresh"), stale = sha("stale"), now = Date.now();
  writeFileSync(join(cache, fresh), "fresh"); writeFileSync(join(cache, stale), "stale"); writeFileSync(join(cache, "junk"), "j");
  writeFileSync(join(cache, `${fresh}.x.tmp`), "writing");                    // another bridge writing it right now
  utimesSync(join(cache, stale), now / 1000 - 8 * 86400, now / 1000 - 8 * 86400);
  bridge.pruneCache(now);
  assert.deepEqual(readdirSync(cache).sort(), [fresh, `${fresh}.x.tmp`].sort());
  bridge.pruneCache(now + 2 * 3600_000);   // two hours on, the half-written one is abandoned
  assert.deepEqual(readdirSync(cache), [fresh]);
});
