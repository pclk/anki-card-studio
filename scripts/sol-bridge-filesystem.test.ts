/** Additional filesystem coverage (by GPT-6.1 Sol): unsafe names, symlinks, the cache cap, and stopping the bridge mid-job. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sol-bridge-')));
process.env.ACS_BRIDGE_HOME = home;
let bridge: typeof import('../bridge/acs-bridge.mjs');
let cfg: import('../bridge/acs-bridge.mjs').BridgeConfig;
before(async () => { bridge = await import('../bridge/acs-bridge.mjs'); cfg = { ...bridge.loadConfig(), keepJobs: false }; });
after(() => fs.rmSync(home, { recursive: true, force: true }));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const id = 'jsoltest1234567';

function api(download: (id: string, name: string) => Promise<Buffer>) {
  return { events: async () => ({ cancel: false }), download,
    finish: async () => ({ job: { status: 'failed' } }) };
}

test('reserved names and traversal are rejected before any download and leave no job folder', async () => {
  for (const name of ['../escape', 'x/y', 'AGENTS.md', 'aGeNtS.Md', 'ANKI_OUT', 'Anki-Skill', 'ANKI_BLOCKS']) {
    let calls = 0;
    const result = await bridge.runJob(api(async () => { calls++; return Buffer.from('x'); }),
      { id, agent: 'claude', files: [{ name }] }, cfg, () => {});
    assert.match(result.error!, /refusing the file name/, name);
    assert.equal(calls, 0, name);
    assert.deepEqual(fs.readdirSync(join(home, 'jobs')), []);
  }
});

test('cache symlink is not read or written through, even when its target has the correct hash', async () => {
  const cache = join(home, 'cache'); fs.mkdirSync(cache, { recursive: true });
  const target = join(home, 'outside.txt'), bytes = 'private-content';
  fs.writeFileSync(target, bytes);
  const entry = join(cache, hash(bytes)); fs.symlinkSync(target, entry);
  let downloads = 0;
  // No prompt: stops before spawning, after exercising cache retrieval.
  await bridge.runJob(api(async () => { downloads++; return Buffer.from(bytes); }),
    { id, agent: 'claude', files: [{ name: 'lecture.txt', sha256: hash(bytes) }] }, cfg, () => {});
  assert.equal(downloads, 1);
  assert.equal(fs.lstatSync(entry).isFile(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
});

test('sweep does not follow job symlinks or delete unrelated folders', () => {
  const jobs = join(home, 'jobs'), outside = join(home, 'outside');
  fs.mkdirSync(outside); fs.writeFileSync(join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, join(jobs, id + '-Ab1234'));
  fs.mkdirSync(join(jobs, 'unrelated'));
  bridge.sweepJobs(cfg, Date.now() + 30 * 86400_000);
  assert.equal(fs.existsSync(join(outside, 'keep')), true);
  assert.equal(fs.lstatSync(join(jobs, id + '-Ab1234')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(join(jobs, 'unrelated')), true);
});

test('cache size cap evicts an old sparse entry exceeding 1 GiB', () => {
  const cache = join(home, 'cache'); fs.rmSync(cache, { recursive: true }); fs.mkdirSync(cache);
  const large = join(cache, hash('large')), recent = join(cache, hash('recent'));
  fs.writeFileSync(large, ''); fs.truncateSync(large, 1024 ** 3 + 1);
  fs.utimesSync(large, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  fs.writeFileSync(recent, 'recent'); bridge.pruneCache();
  assert.deepEqual(fs.readdirSync(cache), [hash('recent')]);
});

test('SIGTERM during a download removes the private job folder', { timeout: 15000 }, async () => {
  const signalHome = join(home, 'signal'); fs.mkdirSync(signalHome);
  const fake = join(home, 'fake-agent'); fs.writeFileSync(fake, '');
  let started!: () => void;
  const downloading = new Promise<void>(r => { started = r; });
  const server = createServer((req, res) => {
    if (req.url!.endsWith('/hello')) res.end('{}');
    else if (req.url!.endsWith('/claim')) res.end(JSON.stringify({ job: { id, files: [{ name: 'anki_prompt.txt' }], agent: 'claude' } }));
    else if (req.url!.endsWith('/events')) res.end('{}');
    else { started(); /* deliberately hold the download open */ }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [resolve('bridge/acs-bridge.mjs'), 'run', '--once'], {
    env: { ...process.env, ACS_BRIDGE_HOME: signalHome, ACS_BRIDGE_SERVER: `http://127.0.0.1:${port}`,
      ACS_BRIDGE_TOKEN: 'acsd_' + 'a'.repeat(43), ACS_BRIDGE_CLAUDE: fake }, stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  try {
    await Promise.race([downloading, exited.then(() => { throw new Error('bridge exited before download'); })]);
    child.kill('SIGTERM'); await exited;
    assert.deepEqual(fs.readdirSync(join(signalHome, 'jobs')), []);
  } finally {
    child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  }
});
