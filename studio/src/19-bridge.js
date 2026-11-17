/* ====================================================================== MAC BRIDGE */
/* "▶ Run on Mac": a prompt and its files become a job on the server (lib/bridge.ts). The bridge on the user's Mac
   (bridge/acs-bridge.mjs, paired with a device token from Settings → Mac bridge) runs it with Claude Code or Codex and
   uploads anki_bundle.json / anki_revision.json, which this window imports by itself - once, even with several
   windows open. Online version only: the local companion (acs.py) has no jobs. */
const BR = {devices: null, jobs: [], timer: null, logs: new Map(), open: new Set(), importing: new Set(), tries: new Map(), retryMs: 15000, claimed: new Set()};
/** a result that couldn't be fetched is tried again by itself this many times (then from Jobs → Import) */
const IMPORT_TRIES = 3;
const JOB_OPEN = ['uploading', 'queued', 'running'];
function bridgeReady(){ return !!(Store.hosted && BR.devices && BR.devices.length); }
/** the JSON answer of a bridge request, or an Error carrying the server's message */
async function brCall(method, path, body){
  const r = await fetch(`${Store.base}/api/${path}`, {method, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : {'Content-Type': 'application/json'}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function loadDevices(){
  if (!Store.hosted){ BR.devices = []; renderBridgeButtons(); return; }
  try { BR.devices = await brCall('GET', 'devices'); } catch { BR.devices = BR.devices || []; }
  renderBridgeButtons(); renderBridgeSettings();
}
function renderBridgeButtons(){
  const on = bridgeReady();
  $$('.brRun').forEach(b => { b.hidden = !on; });
  if (typeof renderBatch === 'function' && $('#batchOut') && !$('#batchOut').hidden) renderBatch();
}
const agentName = a => a === 'codex' ? 'Codex' : 'Claude Code';

/* ---- Settings → Mac bridge: devices (a token is shown once), which agent, the script */
function renderBridgeSettings(){
  const sec = $('#brSec'); if (!sec) return;
  sec.hidden = !Store.hosted;
  if (!Store.hosted) return;
  $('#brAgent').value = SET.bridgeAgent || 'claude';
  const list = BR.devices || [];
  $('#brDevices').innerHTML = list.length ? list.map(d => `<div class="dev"><span>🖥</span><div class="dm"><b>${esc(d.name)}</b> <span class="muted small">· token …${esc(d.hint)}</span>
      <div class="small muted">added ${esc(ago(d.created))} · last seen ${esc(ago(d.lastSeen))}${d.info && d.info.agents ? ` · runs ${esc(d.info.agents.map(agentName).join(' + ') || 'nothing yet')}` : ''}</div></div>
      <button class="btn sm bad" data-rm="${esc(d.id)}" title="Remove: its token stops working at once">Remove</button></div>`).join('')
    : '<div class="small muted">No device yet.</div>';
}
$('#brDevices').addEventListener('click', async e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  const d = (BR.devices || []).find(x => x.id === b.dataset.rm);
  if (!d || !confirm(`Remove "${d.name}"? Its token stops working at once (a job it is running fails).`)) return;
  try { await brCall('DELETE', `devices/${d.id}`); toast(`Removed ${d.name}`); } catch (er) { toast(er.message); }
  loadDevices();
});
$('#brAdd').onclick = async () => {
  try {
    const d = await brCall('POST', 'devices', {name: $('#brName').value.trim()});
    $('#brName').value = '';
    const box = $('#brNew'); box.hidden = false;
    box.innerHTML = `<b>Device "${esc(d.name)}" added. Copy its token now: it is shown only this once.</b>
      <div class="row" style="gap:6px"><input type="text" readonly id="brTok" value="${esc(d.token)}" style="flex:1;font-family:ui-monospace,monospace;font-size:12px"><button class="btn sm primary" id="brTokCopy">📋 Copy</button></div>
      <ol class="small" style="margin:0;padding-left:18px">
        <li>Download <b>acs-bridge.mjs</b> (button below) - it needs Node 20+ and <code>claude</code> and/or <code>codex</code> installed.</li>
        <li>In Terminal: <code>node ~/Downloads/acs-bridge.mjs pair ${esc(location.origin)}</code> and paste the token.</li>
        <li>Then keep it running: <code>node ~/Downloads/acs-bridge.mjs</code></li></ol>
      <span class="small muted">Anyone with the token can pick up your jobs - keep it to yourself, and remove the device here if it leaks.</span>`;
    $('#brTokCopy').onclick = () => copyText(d.token);
  } catch (er) { toast(er.message); }
  loadDevices();
};
$('#brAgent').onchange = e => { SET.bridgeAgent = e.target.value; saveSettings(); };
$('#brScript').onclick = () => download(new Blob([$('#bridgeSrc').textContent.replace(/^\n/, '')], {type: 'text/javascript'}), 'acs-bridge.mjs');
$('#brJobsOpen').onclick = () => { $('#setDlg').close(); openJobs(); };

/* ---- making a job: the prompt, its attachments and this Studio's own copy of the skill, as files */
async function runOnMac({kind, title, prompt, atts = [], meta = {}}){
  if (!bridgeReady()) return toast('Add a device in Settings → Mac bridge first'), null;
  if (!prompt) return toast('Nothing to run'), null;
  const files = [{name: 'anki_prompt.txt', blob: new Blob([prompt], {type: 'text/plain'})},
    {name: 'SKILL.md', blob: new Blob([skillSource()], {type: 'text/markdown'})},
    {name: 'anki_helper.py', blob: new Blob([helperSource()], {type: 'text/x-python'})},
    {name: 'extract.py', blob: new Blob([$('#extractSrc').textContent.replace(/^\n/, '')], {type: 'text/x-python'})},
    {name: 'make_prompts.py', blob: new Blob([$('#promptsSrc').textContent.replace(/^\n/, '')], {type: 'text/x-python'})}];
  for (const a of atts){
    if (files.some(f => f.name === a.name)) continue;
    try { files.push({name: a.name, blob: await attachmentBlob(a)}); } catch (er) { toast(`${a.name}: ${er.message}`, 5000); return null; }
  }
  let job = null;
  try {
    job = await brCall('POST', 'jobs', {project: curProject, kind, agent: SET.bridgeAgent || 'claude', title: String(title).slice(0, 200), meta,
      files: files.map(f => ({name: f.name, size: f.blob.size}))});
    for (const f of files) await Store.putBlob(`jobs/${job.id}/in/${encodeURIComponent(f.name)}`, f.blob, f.blob.type || 'application/octet-stream');
    const queued = await brCall('POST', `jobs/${job.id}/queue`);
    BR.jobs = [queued, ...BR.jobs.filter(j => j.id !== queued.id)];
    renderJobs(); pollJobsSoon(500);
    return queued;
  } catch (er) {
    // a half-sent job would wait "sending" for nothing: remove it (the server also gives up on it after an hour)
    if (job) await brCall('DELETE', `jobs/${job.id}`).catch(() => {});
    toast('Could not send it to your Mac: ' + er.message, 5000); return null;
  }
}

/* ---- following the jobs: poll while any is open; import finished ones */
function pollJobsSoon(ms = 3000){ clearTimeout(BR.timer); BR.timer = setTimeout(pollJobs, ms); }
async function pollJobs(){
  if (!Store.hosted || !curProject) return;
  const pid = curProject;
  let list;
  try { list = await brCall('GET', `jobs?project=${encodeURIComponent(pid)}`); } catch { return pid === curProject ? pollJobsSoon(15000) : undefined; }
  if (pid !== curProject) return;   // a late answer for the project that was open before: the new one's poll has it
  BR.jobs = list;
  for (const j of BR.jobs) if (j.status === 'done' && (!j.importedAt || BR.claimed.has(j.id)) && !BR.importing.has(j.id) && (BR.tries.get(j.id) || 0) < IMPORT_TRIES) await importJob(j);
  requeueFailed();
  if ($('#jobsDlg').open) await refreshLogs();
  renderJobs();
  if (BR.jobs.some(j => JOB_OPEN.includes(j.status))) pollJobsSoon(3000);
  else if (BR.jobs.some(j => j.status === 'done' && (!j.importedAt || BR.claimed.has(j.id)) && (BR.tries.get(j.id) || 0) < IMPORT_TRIES)) pollJobsSoon(BR.retryMs);
}
/** a Mac job that failed or was cancelled gives its prompt back: the batch item or formatting / checker-fix prompt it
    took is "to do" again, so "Run all on Mac" sends it again. Only while that job is still the one that took it (it.macJob,
    c.fmtJob): it happens once, and never undoes a copy the user made by hand since. */
function requeueFailed(){
  let n = 0;
  for (const j of BR.jobs){
    if (j.status !== 'failed' && j.status !== 'cancelled') continue;
    const m = j.meta || {}, it = m.batchItem && S.batch && S.batch.items.find(x => x.id === m.batchItem && x.macJob === j.id);
    if (it){ delete it.macJob; if (it.status === 'copied'){ it.status = 'todo'; n++; } }
    if (m.fmt){
      let back = false;
      for (const c of S.cards) if (c.fmtJob === j.id){ delete c.fmtJob; if (c.fmt === m.fmt && c.fmtSt === 'copied'){ c.fmtSt = 'todo'; back = true; } }
      if (back) n++;
    }
  }
  if (!n) return;
  save(); if (typeof renderBatch === 'function') renderBatch(); renderFmtPass();
  toast(`🖥 ${n} prompt(s) that didn't finish on your Mac are back to “to do”`, 4500);
}
const resultName = j => j.kind === 'cards' ? 'anki_bundle.json' : 'anki_revision.json';
async function importJob(j, again = false){
  BR.importing.add(j.id);
  try {
    // fetch first, then claim it: a failed download leaves it for the next try instead of using the one import up
    const blob = await Store.getBlob(`jobs/${j.id}/out/${resultName(j)}`);
    if (!blob) throw new Error(`${resultName(j)} is missing`);
    if (j.project !== curProject) return;   // the user switched projects meanwhile: it is imported when this one is open
    // another window has it - unless it is this one, which claimed it and then the project was switched (BR.claimed)
    if (!again && !BR.claimed.has(j.id) && !(await brCall('POST', `jobs/${j.id}/imported`)).first) return;
    BR.claimed.add(j.id);
    if (j.project !== curProject) return;   // switched while claiming: this window applies it when the project is open again
    const files = [new File([blob], resultName(j), {type: 'application/json'})];
    if (j.kind === 'cards'){
      const r = await importFiles(files, 'merge'), s = summarize(r);
      await afterImport();
      const it = j.meta && j.meta.batchItem && S.batch && S.batch.items.find(x => x.id === j.meta.batchItem);
      if (it && s.ok && it.status !== 'done'){ it.status = 'done'; save(); }
      if (typeof renderBatch === 'function') renderBatch();
      toast(s.ok ? `🖥 ${j.title}: ${r.sums.reduce((a, x) => a + x.added, 0)} new card(s) imported - review them` : `🖥 ${j.title}: nothing imported`, 4500);
    } else if (j.kind === 'revision') await applyRevisionResult(await importFiles(files, 'merge', {revision: true}));
    else await fqApplied(await importFiles(files, 'merge', {revision: true}), passOf(j.meta && j.meta.fmt));
    j.importedAt = new Date().toISOString(); BR.claimed.delete(j.id);
  } catch (er) {
    // a network blip: the next poll tries again by itself, so only the last automatic try (or a manual one) says so
    const n = (BR.tries.get(j.id) || 0) + 1; BR.tries.set(j.id, n);
    if (again || n >= IMPORT_TRIES) toast(`🖥 ${j.title}: could not import (${er.message}) - try again from Jobs`, 6000);
  }
  finally { BR.importing.delete(j.id); }
}

/* ---- the jobs dialog and the pill that opens it */
function renderJobs(){
  const open = BR.jobs.filter(j => JOB_OPEN.includes(j.status)), run = open.filter(j => j.status === 'running').length;
  const pill = $('#brPill');
  pill.hidden = !Store.hosted || !BR.jobs.length;
  pill.textContent = open.length ? `🖥 Mac: ${run ? `${run} running` : ''}${run && open.length > run ? ' · ' : ''}${open.length > run ? `${open.length - run} waiting` : ''}` : '🖥 Mac jobs';
  if ($('#jobsDlg').open) renderJobsList();
  if (typeof renderBatch === 'function' && $('#batchOut') && !$('#batchOut').hidden && open.length) renderBatchJobs();
}
const JOB_LABEL = {uploading: 'sending', queued: 'waiting for your Mac', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled'};
function renderJobsList(){
  const devs = BR.devices || [];
  $('#jobsInfo').textContent = devs.length ? `· ${devs.map(d => `${d.name} (seen ${ago(d.lastSeen)})`).join(', ')}` : '· no device - add one in Settings → Mac bridge';
  $('#jobsList').innerHTML = BR.jobs.length ? BR.jobs.map(j => {
    const log = BR.logs.get(j.id), shown = BR.open.has(j.id);
    return `<div class="job" data-job="${esc(j.id)}"><div class="jt"><b title="${esc(j.title)}">${esc(j.title)}</b>
      <span class="pill ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'running' ? 'warn' : ''}">${JOB_LABEL[j.status] || j.status}</span>
      <span class="small muted">${esc(agentName(j.agent))} · ${esc(ago(j.created))}${j.importedAt ? ' · imported' : ''}</span>
      <button class="btn sm" data-ja="log">${shown ? 'Hide log' : 'Log'}</button>
      ${JOB_OPEN.includes(j.status) ? '<button class="btn sm bad" data-ja="cancel">Cancel</button>' : ''}
      ${j.status === 'done' ? `<button class="btn sm" data-ja="import" title="Import its result again">Import</button>` : ''}
      ${(j.outputs || []).includes('anki_explanations.md') ? '<button class="btn sm" data-ja="expl">⬇ Explanations</button>' : ''}
      ${!JOB_OPEN.includes(j.status) || j.status === 'uploading' ? '<button class="btn sm" data-ja="del" title="Delete the job and its files">🗑</button>' : ''}</div>
      ${j.error && j.status !== 'cancelled' ? `<div class="small" style="color:var(--bad);margin-top:4px">${esc(j.error)}</div>` : ''}
      ${shown ? `<pre class="jlog">${log && log.items.length ? log.items.map(e => `<span class="t-${esc(e.type)}">${esc(e.type === 'tool' ? '· ' + e.text : e.text)}</span>`).join('\n') : 'No output yet.'}</pre>` : ''}</div>`;
  }).join('') : '<div class="small muted">No jobs for this project yet. Use ▶ Run on Mac next to a prompt.</div>';
  const pre = $('#jobsList pre.jlog'); if (pre) pre.scrollTop = pre.scrollHeight;
}
async function refreshLogs(){
  for (const id of BR.open){
    const log = BR.logs.get(id) || {after: 0, items: []};
    try { const ev = await brCall('GET', `jobs/${id}/events?after=${log.after}`); log.items.push(...ev); if (ev.length) log.after = ev[ev.length - 1].seq; } catch {}
    BR.logs.set(id, log);
  }
}
async function openJobs(){ $('#jobsDlg').showModal(); renderJobsList(); await pollJobs(); }
$('#brPill').onclick = openJobs;
$('#jobsClose').onclick = () => $('#jobsDlg').close();
$('#jobsList').addEventListener('click', async e => {
  const b = e.target.closest('[data-ja]'); if (!b) return;
  const j = BR.jobs.find(x => x.id === b.closest('[data-job]').dataset.job); if (!j) return;
  const a = b.dataset.ja;
  try {
    if (a === 'log'){ if (BR.open.has(j.id)) BR.open.delete(j.id); else { BR.open.add(j.id); await refreshLogs(); } }
    if (a === 'cancel') await brCall('POST', `jobs/${j.id}/cancel`);
    if (a === 'import') await importJob(j, true);
    if (a === 'expl'){ const bl = await Store.getBlob(`jobs/${j.id}/out/anki_explanations.md`); if (bl) download(bl, 'anki_explanations.md'); }
    if (a === 'del'){ if (!confirm('Delete this job and its files?')) return; await brCall('DELETE', `jobs/${j.id}`); BR.logs.delete(j.id); BR.open.delete(j.id); }
  } catch (er) { toast(er.message); }
  await pollJobs(); renderJobsList();
});

/* ---- the ▶ Run on Mac buttons */
const onMacToast = (j, what) => j && toast(`🖥 ${what} sent to your Mac - it is imported here when it is done`, 4000);
$('#runPrompt').onclick = async () => {
  buildPrompt();
  const p = scopedPrompt(readPrompt()), atts = useStoredSources(p) ? planAttachments(singleSourceList()) : [];
  onMacToast(await runOnMac({kind: 'cards', title: p.pDeck || S.deck || 'Cards', prompt: await fullSinglePrompt(), atts}), 'The prompt');
};
$('#runQueue').onclick = async () => {
  if (!S.batch) return;
  const busy = new Set(BR.jobs.filter(j => JOB_OPEN.includes(j.status)).map(j => j.meta && j.meta.batchItem));
  const todo = S.batch.items.filter(it => it.status === 'todo' && !busy.has(it.id)), n = S.batch.items.length;
  if (!todo.length) return toast('Every prompt is already copied, sent or imported');
  if (!confirm(`Send ${todo.length} prompt(s) to your Mac? They run one after another (each uses your ${agentName(SET.bridgeAgent)} plan).`)) return;
  let sent = 0;
  for (const it of todo){
    const j = await runOnMac({kind: 'cards', title: it.title || it.id, prompt: await itemPromptFull(it, S.batch.items.indexOf(it), n), atts: itemAttachments(it), meta: {batchItem: it.id}});
    if (!j) break;
    it.status = 'copied'; it.copiedAt = Date.now(); it.macJob = j.id; sent++;
  }
  save(); renderBatch();
  if (sent) toast(`🖥 ${sent} prompt(s) sent to your Mac`, 4000);
};
function renderBatchJobs(){
  for (const j of BR.jobs){
    const id = j.meta && j.meta.batchItem; if (!id || !JOB_OPEN.includes(j.status)) continue;
    const row = $(`#qList .qi [data-id="${CSS.escape(id)}"]`); const pill = row && row.closest('.qi').querySelector('.pill');
    if (pill) pill.textContent = `Mac: ${JOB_LABEL[j.status]}`;
  }
}
$('#runRevision').onclick = async () => {
  if (!$('#rvOut').value) $('#btnMakeRevision').click();
  const prompt = $('#rvOut').value; if (!prompt) return;
  // a new session has none of the material: send the pages the cards come from
  const atts = planAttachments(refSourceList(S.cards.filter(c => c.status === 'change')));
  onMacToast(await runOnMac({kind: 'revision', title: 'Revision', prompt: prompt + (atts.length ? `\n\n${await materialSection(atts, [])}` : ''), atts}), 'The revision');
};
$('#runImageFix').onclick = async () => {
  const prompt = await imageFixPrompt(); if (!prompt) return;
  onMacToast(await runOnMac({kind: 'revision', title: 'Image fix', prompt, atts: imageFixAttachments()}), 'The image fix');
};
$('#runFmt').onclick = async () => {
  const todo = fmtItems().filter(i => i.status === 'todo'); if (!todo.length) return toast('No formatting prompt is still to do');
  let sent = 0;
  for (const it of todo){
    const j = await runOnMac({kind: 'format', title: `Formatting ${it.cards[0].id} … ${it.cards[it.cards.length - 1].id}`, prompt: fmtPrompt(it.cards), meta: {fmt: it.id}});
    if (!j) break;
    it.cards.forEach(c => { if (c.fmt){ c.fmtSt = 'copied'; c.fmtJob = j.id; } }); sent++;
  }
  save(); renderFmtPass();
  if (sent) toast(`🖥 ${sent} formatting prompt(s) sent to your Mac`, 4000);
};
$('#runFix').onclick = async () => {
  const todo = fmtItems('K').filter(i => i.status === 'todo'); if (!todo.length) return toast('No checker-fix prompt is still to do');
  let sent = 0;
  for (const it of todo){
    // a new session has none of the material, and the "why" and source references come from it
    const atts = planAttachments(refSourceList(it.cards)), prompt = fixPrompt(it.cards);
    const j = await runOnMac({kind: 'format', title: `Checker fix ${it.cards[0].id} … ${it.cards[it.cards.length - 1].id}`, prompt: prompt + (atts.length ? `\n\n${await materialSection(atts, [])}` : ''), atts, meta: {fmt: it.id}});
    if (!j) break;
    it.cards.forEach(c => { if (c.fmt){ c.fmtSt = 'copied'; c.fmtJob = j.id; } }); sent++;
  }
  save(); renderFmtPass();
  if (sent) toast(`🖥 ${sent} checker-fix prompt(s) sent to your Mac`, 4000);
};
// start: once the storage is known (Store.hosted), and again whenever a project opens
setTimeout(function startBridge(){ if (Store.status === 'detecting' || (Store.on && !curProject)) return setTimeout(startBridge, 500); loadDevices(); pollJobs(); }, 300);
