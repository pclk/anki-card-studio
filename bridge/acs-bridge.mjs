#!/usr/bin/env node
/**
 * Anki Card Studio - Mac bridge. Runs the prompts you send from the Studio ("▶ Run on Mac") with Claude Code or
 * Codex on this Mac, using your own subscription, and sends the finished anki_bundle.json / anki_revision.json back.
 * The Studio can't start programs on your Mac, so this connects out to it and asks for work every few seconds.
 *
 *   pbpaste | node acs-bridge.mjs setup --server https://your-studio.vercel.app   the device token from Settings → Mac bridge
 *   node acs-bridge.mjs install        run in the background: starts at login, restarts if it stops (a macOS LaunchAgent)
 *   node acs-bridge.mjs uninstall      stop it and don't start it at login any more (the pairing is kept)
 *   node acs-bridge.mjs logs [-f]      what the background bridge did (-f: keep following)
 *   node acs-bridge.mjs status         which server and device this is set up for, and whether it runs in the background
 *   node acs-bridge.mjs                run in this terminal instead (Ctrl+C to stop)
 *   (pair <server> is the same as setup --server <server>, asking for the token when it isn't piped in)
 *
 * Needs Node 20+ and `claude` (Claude Code) and/or `codex` on your PATH. No other packages.
 *
 * Safety
 * - The device token is kept in ~/.acs-bridge/config.json, readable only by you. Remove the device in the Studio to
 *   cut it off at once. It is sent only over https (or to this Mac itself), and only to the server you paired with.
 * - Each run gets its own new folder (~/.acs-bridge/jobs/<id>-<random>), removed when the run ends - done, failed or
 *   cancelled (keepJobs keeps them). The prompt and files from the Studio are written there as files; they are never
 *   put on a command line or into the agent's messages. The agent gets a fixed instruction from this script and reads
 *   the files with its own tools. Big blocks of the prompt (material, cards) go to files of their own (anki_blocks/).
 * - Files the Studio declares with a sha256 are kept in ~/.acs-bridge/cache, so the skill and a lecture's slides
 *   are downloaded once, not for every job (checked against the hash each time; old entries are pruned).
 * - Claude Code runs with --permission-mode dontAsk and only the tools in `claudeTools` (anything else is refused,
 *   nothing waits for an answer), and without your MCP servers (--strict-mcp-config). Codex runs in its
 *   workspace-write sandbox. The agent still runs code (the skill is Python), so only pair devices with a Studio
 *   account you trust - a job is as powerful as a prompt you'd paste into Claude Code yourself.
 * - A job may choose the model, the thinking effort and a few limits (Settings → Mac bridge). Each is checked here
 *   against a fixed pattern or list before it becomes a flag, and a job asking for anything else fails.
 * - install copies this script to ~/.acs-bridge/acs-bridge.mjs and runs that copy (so ~/Downloads can be cleaned up).
 *
 * Env (mostly for tests): ACS_BRIDGE_HOME (instead of ~/.acs-bridge), ACS_BRIDGE_SERVER + ACS_BRIDGE_TOKEN (instead of
 * the config file), ACS_BRIDGE_CLAUDE / ACS_BRIDGE_CODEX (the commands), ACS_BRIDGE_POLL_MS, ACS_BRIDGE_LAUNCHD_DIR
 * (instead of ~/Library/LaunchAgents), ACS_BRIDGE_LAUNCHCTL (instead of launchctl).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const VERSION = '3';
const HOME = process.env.ACS_BRIDGE_HOME || path.join(os.homedir(), '.acs-bridge');
const CONFIG = path.join(HOME, 'config.json');
const CHUNK = 3 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.ACS_BRIDGE_TIMEOUT_MS) || 120_000;
const TOKEN_RE = /^acsd_[A-Za-z0-9_-]{43}$/;
export const LABEL = 'dev.ankicardstudio.bridge';
export const LOG = path.join(HOME, 'bridge.log');
const SERVICE = process.env.ACS_BRIDGE_SERVICE === '1';   // started by launchd (install)
const JOBS = path.join(HOME, 'jobs'), CACHE = path.join(HOME, 'cache');
const CACHE_DAYS = 7, CACHE_MAX = 1024 ** 3;          // cached files unused for a week go, and the cache stays under 1 GB
/** a block bigger than this leaves the prompt for a file of its own (smaller ones are handier inline) */
export const BLOCK_INLINE_MAX = 16_000;
const SKILL_FILES = { 'SKILL.md': '', 'anki_helper.py': 'scripts', 'extract.py': 'scripts', 'make_prompts.py': 'scripts' };
const DEFAULTS = {
  agents: ['claude', 'codex'],               // which agents this Mac runs (only the ones that are installed)
  claudeTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'],
  maxMinutes: 60,                            // a run that takes longer is stopped (a job can ask for less, never more)
  keepJobs: false,                           // keep each job's folder after it ends (to look at what the agent did)
};
/** what the agent is told. Fixed here on purpose: nothing from the server ends up in an argument */
export const INSTRUCTION = `You are running unattended for Anki Card Studio, in a folder made for this one job.
Your task is in ./anki_prompt.txt: read it and follow it exactly.
- The anki skill, in the exact version the Studio uses, is in ./anki-skill/SKILL.md; its scripts are in ./anki-skill/scripts (in Python: import sys; sys.path.insert(0, "anki-skill/scripts"); from anki_helper import *).
- The files the prompt mentions as attached are in this folder: open them with your tools. Read blocks of the prompt by their id with the helper (it finds them in anki_prompt.txt and ./anki_blocks); never retype them.
- Outputs go to ./anki_out (ANKI_OUT_DIR is set): the result must be ./anki_out/anki_bundle.json for new cards, or ./anki_out/anki_revision.json for a revision, as the prompt asks.
- Nobody can answer questions while you work: make sensible choices and mention them in your final reply.
- Work only inside this folder.`;

/* ------------------------------------------------------------------ config */
export function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  if (process.env.ACS_BRIDGE_SERVER) c.server = process.env.ACS_BRIDGE_SERVER;
  if (process.env.ACS_BRIDGE_TOKEN) c.token = process.env.ACS_BRIDGE_TOKEN;
  return { ...DEFAULTS, ...c };
}
function saveConfig(c) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
}
/** the token only ever goes over https, or to this machine itself */
export function checkServer(s) {
  let u;
  try { u = new URL(String(s)); } catch { throw new Error(`not a web address: ${s}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('the Studio address must start with https:// (http only for this Mac itself)');
  return u.origin;
}

/* ------------------------------------------------------------------ talking to the Studio */
export function client(server, token) {
  const base = checkServer(server);
  if (!TOKEN_RE.test(token || '')) throw new Error('that is not a device token (it starts with acsd_) - add the device again in the Studio');
  // a request that hangs (bad Wi-Fi, a sleeping Mac waking up) gives up after 2 minutes; network errors and 5xx are
  // tried 3 times. 4xx answers are final (the server said no), and 401 means the token is gone.
  const call = async (method, p, body, type) => {
    let r;
    for (let tries = 0; ; tries++) {
      try {
        r = await fetch(`${base}/api/${p}`, { method, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}`, ...(type ? { 'Content-Type': type } : {}) } });
        if (r.status < 500 || tries >= 2) break;
      } catch (e) { if (tries >= 2) throw e; }
      await new Promise((res) => setTimeout(res, 1000 * 3 ** tries));
    }
    if (r.status === 401) throw Object.assign(new Error('the Studio refused the device token (removed, or the account was signed out everywhere) - pair again'), { fatal: true });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(`${method} ${p}: ${j.error || 'HTTP ' + r.status}`), { status: r.status }); }
    return r;
  };
  // each job's events are numbered once, so a post that is sent again (its answer was lost) isn't logged twice
  const seqs = new Map();
  const json = async (method, p, obj) => (await call(method, p, obj === undefined ? undefined : JSON.stringify(obj), 'application/json')).json();
  return {
    base,
    hello: (info) => json('POST', 'bridge/hello', info),
    claim: (agents) => json('POST', 'bridge/claim', { agents }),
    events: (id, list) => {
      let n = seqs.get(id) || 0;
      for (const e of list) if (e.n == null) e.n = ++n;
      seqs.set(id, n);
      return json('POST', `bridge/jobs/${id}/events`, list);
    },
    finish: (id, ok, error) => json('POST', `bridge/jobs/${id}/finish`, { ok, error }),
    async download(id, name) {
      const p = `bridge/jobs/${id}/in/${encodeURIComponent(name)}`, r = await call('GET', p);
      if (r.headers.get('x-acs-chunked') !== '1') return Buffer.from(await r.arrayBuffer());
      const meta = await r.json(), parts = [];
      for (let i = 0; i < meta.chunks; i++) parts.push(Buffer.from(await (await call('GET', `${p}?chunk=${i}`)).arrayBuffer()));
      return Buffer.concat(parts);
    },
    async upload(id, name, bytes, type) {
      const p = `bridge/jobs/${id}/out/${encodeURIComponent(name)}`, n = Math.max(1, Math.ceil(bytes.length / CHUNK)), up = randomUUID();
      for (let i = 0; i < n; i++) await call('PUT', n === 1 ? p : `${p}?chunk=${i}&chunks=${n}&upload=${up}`, bytes.subarray(i * CHUNK, (i + 1) * CHUNK), type);
    },
  };
}

/* ------------------------------------------------------------------ agents */
const which = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;
export function agentCommand(agent) { return agent === 'claude' ? process.env.ACS_BRIDGE_CLAUDE || 'claude' : process.env.ACS_BRIDGE_CODEX || 'codex'; }
export function installedAgents(cfg) {
  return cfg.agents.filter((a) => ['claude', 'codex'].includes(a)).filter((a) => {
    const cmd = agentCommand(a); return path.isAbsolute(cmd) ? fs.existsSync(cmd) : which(cmd);
  });
}
/* what a job may choose (the same rules as OPTION_RULES in lib/bridge.ts): a model name, the thinking effort, and limits */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,79}$/;
export const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
const OPTION_KEYS = { claude: ['model', 'effort', 'fallbackModel', 'maxBudgetUsd', 'maxMinutes'], codex: ['model', 'effort', 'maxMinutes'] };
/** a job's options, checked: anything unknown or malformed throws (the job fails with that message) */
export function agentOptions(agent, raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === '' || v === null || v === undefined || v === 0) continue;
    if (!OPTION_KEYS[agent]?.includes(k)) throw new Error(`${agent} has no option ${JSON.stringify(k)}`);
    if (k === 'model' && !MODEL_RE.test(String(v))) throw new Error(`not a model name: ${JSON.stringify(v)}`);
    if (k === 'fallbackModel' && !String(v).split(',').every((m) => MODEL_RE.test(m.trim()))) throw new Error(`not a model name: ${JSON.stringify(v)}`);
    if (k === 'effort' && !EFFORTS[agent].includes(String(v))) throw new Error(`${agent} effort must be one of ${EFFORTS[agent].join(', ')}`);
    if (k === 'maxBudgetUsd' && !(Number(v) > 0 && Number(v) <= 1000)) throw new Error('maxBudgetUsd must be between 0 and 1000');
    if (k === 'maxMinutes' && !(Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 1440)) throw new Error('maxMinutes must be 1-1440');
    out[k] = typeof v === 'string' ? v.trim() : Number(v);
  }
  return out;
}
/** the command line for a job: fixed flags, the checked options and the fixed instruction - never the prompt */
export function agentArgs(agent, cfg, dir, opts = {}) {
  if (agent === 'claude')
    return ['-p', INSTRUCTION, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--tools', cfg.claudeTools.join(','), '--allowedTools', ...cfg.claudeTools, '--strict-mcp-config',
      ...(opts.model ? ['--model', opts.model] : []), ...(opts.effort ? ['--effort', opts.effort] : []),
      ...(opts.fallbackModel ? ['--fallback-model', opts.fallbackModel] : []), ...(opts.maxBudgetUsd ? ['--max-budget-usd', String(opts.maxBudgetUsd)] : [])];
  return ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', dir, '-o', path.join(dir, 'anki_out', 'reply.md'),
    ...(opts.model ? ['-m', opts.model] : []), ...(opts.effort ? ['-c', `model_reasoning_effort="${opts.effort}"`] : []), INSTRUCTION];
}
const describe = (o) => Object.entries(o).map(([k, v]) => `${{ model: 'model', effort: 'effort', fallbackModel: 'fallback', maxBudgetUsd: 'max $', maxMinutes: 'limit min' }[k]} ${v}`).join(', ');
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** one line of the agent's JSON output -> progress events for the Studio (and the final reply, if it is one) */
export function toEvents(agent, line) {
  let j; try { j = JSON.parse(line); } catch { return line.trim() ? [{ type: 'log', text: short(line, 400) }] : []; }
  const out = [];
  if (agent === 'claude') {
    if (j.type === 'assistant') for (const c of j.message?.content || []) {
      if (c.type === 'text' && c.text?.trim()) out.push({ type: 'text', text: c.text });
      if (c.type === 'tool_use') out.push({ type: 'tool', text: `${c.name}: ${short(c.input?.command ?? c.input?.file_path ?? c.input ?? '')}` });
    }
    if (j.type === 'result') out.push({ type: j.is_error ? 'error' : 'result', text: String(j.result ?? j.subtype ?? ''), final: true });
  } else {
    const it = j.item || {};
    if (j.type === 'item.completed' && it.type === 'agent_message') out.push({ type: 'text', text: String(it.text || '') });
    if (j.type === 'item.started' && it.type === 'command_execution') out.push({ type: 'tool', text: `$ ${short(it.command || '')}` });
    if (j.type === 'item.completed' && it.type === 'error') out.push({ type: 'error', text: short(it.message || 'error', 1000) });
    if (j.type === 'error' || j.type === 'turn.failed') out.push({ type: 'error', text: short(j.message || j.error?.message || j.error || 'error', 1000) });
  }
  return out;
}

/* ------------------------------------------------------------------ one job */
let running = null;   // stops the agent that is running now
/** names this script uses in the job folder itself: a job's file may not take one (in any case: macOS folders ignore it) */
const RESERVED = new Set(['agents.md', 'anki_out', 'anki-skill', 'anki_blocks']);
const safeName = (n) => typeof n === 'string' && n === path.basename(n) && !n.startsWith('.') && !RESERVED.has(n.toLowerCase()) && /^[A-Za-z0-9][A-Za-z0-9 ._()+,=@#&'\-[\]]{0,180}$/.test(n);
const SHA_RE = /^[0-9a-f]{64}$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** a regular file's bytes, or null for anything else (missing, a folder, a link) */
function readOwnFile(p) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch { return null; }
  try { return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null; } finally { fs.closeSync(fd); }
}

/* big blocks by reference: the Studio puts a prompt's material and cards in <<<SOURCE id=s-… / <<<REVISE_CARDS id=r-…
   blocks. A big one goes to anki_blocks/<id>.txt and the prompt keeps one line saying where it is. The helper finds a
   block by its id in any text file of the job folder (find_block), so load_source(id) / Deck.load(id) work the same,
   and the agent reads a short prompt instead of all the material at once. */
const BLOCK_RE = /<<<(SOURCE|REVISE_CARDS) id=([a-z]-[0-9a-f]{8})[^\n]*\n[\s\S]*?\n?\1>>>/g;
/** {prompt, blocks: [{id, text}]}: the prompt with every block longer than `max` characters replaced by a pointer */
export function splitBlocks(text, max = BLOCK_INLINE_MAX) {
  const blocks = [];
  const prompt = text.replace(BLOCK_RE, (m, tag, id) => {
    if (m.length <= max) return m;
    if (!blocks.some((b) => b.id === id)) blocks.push({ id, text: m });   // the id comes from the content: same id, same block
    return `[${tag} block ${id} (${m.length} characters) is in anki_blocks/${id}.txt, not in this prompt. ${tag === 'SOURCE' ? `load_source("${id}")` : `Deck.load("${id}")`} reads it from there; open the file yourself only for the parts you need.]`;
  });
  return { prompt, blocks };
}

/** a declared file's bytes: from this Mac's cache when it holds exactly that content (sha256), else downloaded and cached */
async function fetchInput(api, id, f) {
  const want = typeof f.sha256 === 'string' && SHA_RE.test(f.sha256) ? f.sha256 : null, cached = want && path.join(CACHE, want);
  if (cached) {
    const bytes = readOwnFile(cached);
    if (bytes && sha256(bytes) === want) { try { const now = new Date(); fs.utimesSync(cached, now, now); } catch {} return { bytes, hit: true }; }
  }
  const bytes = await api.download(id, f.name);
  // only what really has that hash is kept, written to a new name first so a half-written file is never used
  if (cached && sha256(bytes) === want) try {
    fs.mkdirSync(CACHE, { recursive: true, mode: 0o700 });
    const tmp = `${cached}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, cached);
  } catch {}
  return { bytes, hit: false };
}
/** the cache keeps what was used in the last CACHE_DAYS, newest first, up to CACHE_MAX bytes */
export function pruneCache(now = Date.now()) {
  let names; try { names = fs.readdirSync(CACHE); } catch { return; }
  const list = names.map((n) => ({ n, p: path.join(CACHE, n), st: fs.lstatSync(path.join(CACHE, n), { throwIfNoEntry: false }) })).filter((e) => e.st);
  let total = 0;
  for (const e of list.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)) {
    if (e.n.endsWith('.tmp') && now - e.st.mtimeMs < 3600_000) continue;   // another bridge may be writing it now
    if (!SHA_RE.test(e.n) || !e.st.isFile() || now - e.st.mtimeMs > CACHE_DAYS * 86_400_000 || (total += e.st.size) > CACHE_MAX)
      fs.rmSync(e.p, { recursive: true, force: true });
  }
}
/** folders of runs that never ended here (the bridge was stopped, the Mac shut down): removed once no run can still be
    using them, i.e. older than the longest run allowed. Also the folders of failed jobs older versions kept. */
export function sweepJobs(cfg, now = Date.now()) {
  if (cfg.keepJobs) return;
  let names; try { names = fs.readdirSync(JOBS); } catch { return; }
  for (const n of names) {
    if (!/^j[a-z0-9]{12,40}(?:-[A-Za-z0-9]{6})?$/.test(n)) continue;
    const p = path.join(JOBS, n), st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory() && now - st.mtimeMs > (cfg.maxMinutes + 15) * 60_000) fs.rmSync(p, { recursive: true, force: true });
  }
}

export async function runJob(api, job, cfg, log = console.log) {
  if (typeof job.id !== 'string' || !/^j[a-z0-9]{12,40}$/.test(job.id)) throw new Error('invalid job id');
  fs.mkdirSync(JOBS, { recursive: true, mode: 0o700 });
  // a new folder for every run, even of the same job (a claim whose answer was lost is handed out again), so two runs
  // never share one; it is removed however the run ends
  const dir = fs.mkdtempSync(path.join(JOBS, job.id + '-'));
  fs.mkdirSync(path.join(dir, 'anki_out'), { mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'anki-skill', 'scripts'), { recursive: true });
  const kept = cfg.keepJobs ? dir : undefined;
  let pending = [], stop = null, cancelled = false, reply = '', lastSent = 0;
  // also the heartbeat: with nothing new to say, still report every 30 s so the Studio knows the run is alive
  const send = async (force) => {
    if (!pending.length && !force && Date.now() - lastSent < 30_000) return;
    const list = pending; pending = []; lastSent = Date.now();
    try { const r = await api.events(job.id, list); if (r.cancel && !cancelled){ cancelled = true; log(`  cancelled in the Studio`); stop?.(); } }
    catch (e) { if (e.fatal) throw e; pending = list.concat(pending).slice(-400); }
  };
  let revoked = null;
  try {
    // say so first: a slow download must not look like a bridge that went quiet
    pending.push({ type: 'log', text: `Picked up on ${os.hostname()} - fetching ${job.files.length} file(s)` });
    await send(true);
    let hits = 0;
    for (const f of job.files) {
      await send(false);
      if (cancelled) return { ok: false, cancelled: true };
      if (!safeName(f.name)) throw new Error(`refusing the file name ${JSON.stringify(f.name)}`);
      const { bytes, hit } = await fetchInput(api, job.id, f), sub = SKILL_FILES[f.name];
      hits += hit;
      fs.writeFileSync(sub === undefined ? path.join(dir, f.name) : path.join(dir, 'anki-skill', sub, f.name), bytes, { mode: 0o600 });
    }
    const promptPath = path.join(dir, 'anki_prompt.txt'), raw = readOwnFile(promptPath);
    if (!raw) throw new Error('the job has no anki_prompt.txt');
    const { prompt, blocks } = splitBlocks(raw.toString('utf8'));
    if (blocks.length) {
      fs.mkdirSync(path.join(dir, 'anki_blocks'), { mode: 0o700 });
      for (const b of blocks) fs.writeFileSync(path.join(dir, 'anki_blocks', b.id + '.txt'), b.text, { mode: 0o600 });
      fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
    }
    const opts = agentOptions(job.agent, job.options), minutes = Math.min(opts.maxMinutes || cfg.maxMinutes, cfg.maxMinutes);
    // Codex reads AGENTS.md; Claude gets the same through its instruction
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), INSTRUCTION + '\n');
    pending.push({ type: 'log', text: `Started with ${job.agent}${Object.keys(opts).length ? ` (${describe({ ...opts, ...(opts.maxMinutes ? { maxMinutes: minutes } : {}) })})` : ''}${hits ? ` - ${hits} of ${job.files.length} file(s) were already on this Mac` : ''}` });
    await send(true);
    if (cancelled) return { ok: false, cancelled: true };
    // its own process group, so stopping it also stops whatever it started (python, shells…)
    const group = process.platform !== 'win32';
    const child = spawn(agentCommand(job.agent), agentArgs(job.agent, cfg, dir, opts), {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: group,
      env: { ...process.env, ANKI_OUT_DIR: path.join(dir, 'anki_out'), ANKI_MATERIAL_DIR: dir },
    });
    const kill = (sig) => { try { if (group) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    stop = () => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); };
    running = stop;   // Ctrl+C on the bridge stops the agent too (it isn't in the terminal's process group)
    const timer = setTimeout(() => { pending.push({ type: 'error', text: `stopped after ${minutes} minutes` }); stop(); }, minutes * 60_000);
    // the device was removed (or the account signed out everywhere): stop the run at once, upload nothing
    const flusher = setInterval(() => { send(false).catch((e) => { if (e.fatal && !revoked){ revoked = e; log(`  ${e.message}`); stop(); } }); }, 1500);
    let errTail = '';
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      for (const e of toEvents(job.agent, line)) { if (e.final) reply = e.text; const { final, ...ev } = e; pending.push(ev); }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    const code = await new Promise((res) => { child.on('error', (e) => { errTail += String(e.message); res(-1); }); child.on('close', res); });
    clearTimeout(timer); clearInterval(flusher); running = null;
    if (revoked) throw revoked;
    if (code !== 0 && errTail.trim()) pending.push({ type: 'error', text: errTail.trim().slice(-1000) });
    await send(true);
    if (cancelled) return { ok: false, cancelled: true };
    // the result: whatever the run left in anki_out (only these names, and only real files: a link the agent made to
    // somewhere else on this Mac is never followed, so it can't send your files to the Studio)
    const outDir = path.join(dir, 'anki_out');
    if (!fs.lstatSync(outDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('anki_out is no longer a folder');
    const lexists = (p) => !!fs.lstatSync(p, { throwIfNoEntry: false });
    if (reply && !lexists(path.join(outDir, 'reply.md'))) fs.writeFileSync(path.join(outDir, 'reply.md'), reply, { flag: 'wx' });
    for (const name of ['anki_bundle.json', 'anki_revision.json', 'anki_explanations.md', 'reply.md']) {
      const bytes = readOwnFile(path.join(outDir, name));
      if (bytes) await api.upload(job.id, name, bytes, name.endsWith('.json') ? 'application/json' : 'text/markdown');
    }
    const r = await api.finish(job.id, code === 0, code === 0 ? '' : `${job.agent} exited with code ${code}${errTail.trim() ? ': ' + errTail.trim().slice(-300) : ''}`);
    return { ok: r.job?.status === 'done', status: r.job?.status, error: r.job?.error, dir: kept };
  } catch (e) {
    if (e.fatal) throw e;
    await api.finish(job.id, false, String(e.message || e)).catch(() => {});
    return { ok: false, error: String(e.message || e), dir: kept };
  } finally {
    running = null;
    if (!kept) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ the loop */
export async function serve(cfg, { once = false, log = console.log } = {}) {
  if (!cfg.server || !cfg.token) throw Object.assign(new Error('not paired yet - run: pbpaste | node acs-bridge.mjs setup --server https://<your studio>'), { fatal: true });
  const api = client(cfg.server, cfg.token), agents = installedAgents(cfg);
  if (!agents.length) throw new Error('neither claude nor codex is on your PATH');
  sweepJobs(cfg); pruneCache();
  // offline at start (the Mac just woke up, no Wi-Fi yet): keep trying instead of giving up
  let me;
  for (let tries = 0; ; tries++) {
    try { me = await api.hello({ version: VERSION, agents, host: os.hostname(), platform: process.platform }); break; }
    catch (e) { if (e.fatal || e.status || once) throw e; if (!tries) log(`  (can't reach the Studio yet: ${e.message} - retrying)`); await new Promise((res) => setTimeout(res, Math.min(60_000, 2000 * 2 ** tries))); }
  }
  log(`Connected to ${api.base} as ${me.login} (device "${me.device}"), running ${agents.join(' + ')}. Waiting for jobs…`);
  let wait = Number(process.env.ACS_BRIDGE_POLL_MS) || 5000, quiet = 0;
  for (;;) {
    let job = null;
    try { job = (await api.claim(agents)).job; quiet = 0; }
    catch (e) { if (e.fatal) throw e; quiet = Math.min(quiet + 1, 6); log(`  (can't reach the Studio: ${e.message})`); }
    if (job) {
      log(`▶ ${job.title} (${job.kind}, ${job.agent})`);
      const r = await runJob(api, job, cfg, log);
      pruneCache();
      log(r.ok ? `✓ done - the Studio imports it` : `✗ ${r.cancelled ? 'cancelled' : r.error || 'failed'}${r.dir && !r.ok ? ` (files kept in ${r.dir})` : ''}`);
      if (once) return r;
      continue;
    }
    if (once) return null;
    await new Promise((res) => setTimeout(res, wait * 2 ** quiet));
  }
}

/** the token from a pipe (pbpaste | …) or, in a terminal, typed / pasted at the prompt */
async function readToken() {
  if (!process.stdin.isTTY) { let t = ''; for await (const c of process.stdin) t += c; return t.trim(); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const t = await new Promise((res) => rl.question('Paste the device token from the Studio (Settings → Mac bridge): ', res));
  rl.close(); return t.trim();
}
async function pair(server) {
  if (!server) throw new Error('which Studio? setup --server https://<your studio>');
  const origin = checkServer(server), token = await readToken();
  if (!TOKEN_RE.test(token)) throw new Error("that isn't a device token (acsd_…) - copy it from the Studio (Settings → Mac bridge), then run the command again");
  const me = await client(origin, token).hello({ version: VERSION, agents: [], host: os.hostname(), platform: process.platform });
  saveConfig({ ...loadConfig(), server: origin, token });
  console.log(`Paired with ${origin} as ${me.login} (device "${me.device}"). Saved in ${CONFIG} (only you can read it).`);
  console.log(`Run it in the background with: node ${process.argv[1]} install   (or in this terminal: node ${process.argv[1]})`);
}

/* ------------------------------------------------------------------ in the background (a macOS LaunchAgent) */
const agentsDir = () => process.env.ACS_BRIDGE_LAUNCHD_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
export const plistPath = () => path.join(agentsDir(), LABEL + '.plist');
const launchctl = (...args) => spawnSync(process.env.ACS_BRIDGE_LAUNCHCTL || 'launchctl', args, { encoding: 'utf8' });
const domain = () => `gui/${process.getuid()}`;
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** the LaunchAgent: node runs the installed copy at login, again if it stops with an error (not after a clean exit, e.g. a removed device) */
export function plist(script, env) {
  const kv = (k, v) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => kv(k, v)).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}
function serviceState() {
  const r = launchctl('print', `${domain()}/${LABEL}`);
  if (r.status !== 0) return null;
  return { pid: (/\bpid = (\d+)/.exec(r.stdout) || [])[1] || null, state: (/\bstate = (\w+)/.exec(r.stdout) || [])[1] || 'loaded' };
}
export function install() {
  if (process.platform !== 'darwin' && !process.env.ACS_BRIDGE_LAUNCHCTL)
    throw new Error(`install sets up a macOS LaunchAgent. Elsewhere, run it with: nohup node ${process.argv[1]} >> ${LOG} 2>&1 &`);
  const c = loadConfig();
  if (!c.server || !c.token) throw new Error('not paired yet - run: pbpaste | node acs-bridge.mjs setup --server https://<your studio>');
  if (!installedAgents(c).length) throw new Error('neither claude nor codex is on your PATH');
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  // a copy that stays put: the download in ~/Downloads can be deleted, or replaced by a newer one
  const script = path.join(HOME, 'acs-bridge.mjs'), self = fs.realpathSync(fileURLToPath(import.meta.url));
  if (self !== path.resolve(script)) fs.copyFileSync(self, script);
  fs.chmodSync(script, 0o700);
  // launchd starts programs with a bare PATH: keep this terminal's, so it finds claude / codex and python
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), ACS_BRIDGE_SERVICE: '1' };
  for (const k of ['ACS_BRIDGE_HOME', 'ACS_BRIDGE_CLAUDE', 'ACS_BRIDGE_CODEX', 'LANG']) if (process.env[k]) env[k] = process.env[k];
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(plistPath(), plist(script, env), { mode: 0o644 });
  launchctl('bootout', `${domain()}/${LABEL}`);   // an older one, if any (fails when there is none)
  const r = launchctl('bootstrap', domain(), plistPath());
  if (r.status !== 0) throw new Error(`launchctl could not start it: ${(r.stderr || r.stdout).trim()}`);
  console.log(`The bridge now runs in the background (${installedAgents(c).join(' + ')} for ${c.server}). It starts at login and restarts if it stops.`);
  console.log(`  logs:  node ${script} logs -f\n  stop:  node ${script} uninstall\n  after updating Node, claude or codex, run install again (it remembers their paths).`);
}
export function uninstall() {
  const had = fs.existsSync(plistPath());
  launchctl('bootout', `${domain()}/${LABEL}`);
  fs.rmSync(plistPath(), { force: true });
  console.log(had ? `Stopped. It no longer starts at login. The pairing is kept in ${CONFIG} (remove the device in the Studio to cut it off).` : 'It was not installed.');
}
function logs(follow) {
  if (!fs.existsSync(LOG)) return console.log(`No log yet (${LOG}).`);
  if (follow) return new Promise((res) => spawn('tail', ['-n', '60', '-f', LOG], { stdio: 'inherit' }).on('close', res));
  console.log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-61).join('\n'));
}
function status() {
  const c = loadConfig();
  console.log(c.server ? `Server: ${c.server}\nToken: …${String(c.token).slice(-4)}\nAgents: ${installedAgents(c).join(', ') || 'none installed'}` : 'Not paired yet.');
  const sv = fs.existsSync(plistPath()) ? serviceState() : null;
  console.log(sv ? `Background: ${sv.state}${sv.pid ? ` (pid ${sv.pid})` : ''} - logs: ${LOG}` : `Background: not installed (node ${process.argv[1]} install)`);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { running?.(); process.exit(130); });
  const [cmd, ...rest] = process.argv.slice(2), flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  // in the background: a time on every line, and a log that doesn't grow forever
  const stamp = (m) => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${m}`);
  if (SERVICE) try { if (fs.statSync(LOG).size > 5e6) fs.truncateSync(LOG); } catch {}
  const run = cmd === 'pair' ? pair(rest[0])
    : cmd === 'setup' ? pair(flag('--server') || rest.find((a) => !a.startsWith('-')))
    : cmd === 'install' ? Promise.resolve().then(install)
    : cmd === 'uninstall' ? Promise.resolve().then(uninstall)
    : cmd === 'logs' ? Promise.resolve().then(() => logs(rest.includes('-f')))
    : cmd === 'status' ? Promise.resolve().then(status)
    : !cmd || cmd === 'run' ? serve(loadConfig(), { once: rest.includes('--once'), log: SERVICE || !process.stdout.isTTY ? stamp : console.log })
    : Promise.reject(new Error(`unknown command ${cmd} (setup, install, uninstall, logs, status, run)`));
  run.catch((e) => {
    console.error('acs-bridge: ' + (e.message || e));
    // launchd restarts it after an error; not when it can never work (the device was removed, not paired)
    if (SERVICE && e.fatal){ console.error('acs-bridge: not restarting - pair again and run install'); process.exit(0); }
    process.exit(1);
  });
}
