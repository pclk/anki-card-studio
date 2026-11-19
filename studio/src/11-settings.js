/* ====================================================================== SETTINGS + KEYS */
/* the Mac bridge: what each agent runs with (Settings → Mac bridge). The server and the bridge check the same rules
   (checkOptions in lib/bridge.ts, agentOptions in bridge/acs-bridge.mjs); defined here because settings load first */
const BR_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,79}$/;
const BR_EFFORTS = {claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']};
const BR_OPTS = [
  {key: 'model', label: 'Model', kind: 'model', hint: "empty = the CLI's default", agents: ['claude', 'codex']},
  {key: 'effort', label: 'Thinking effort', kind: 'effort', agents: ['claude', 'codex']},
  {key: 'fallbackModel', label: 'Fallback model', kind: 'model', hint: 'used when the model is overloaded', agents: ['claude']},
  {key: 'maxBudgetUsd', label: 'Max spend per run (USD)', kind: 'num', step: '0.5', max: 1000, hint: 'only when Claude Code uses an API key', agents: ['claude']},
  {key: 'maxMinutes', label: 'Time limit per run (min)', kind: 'num', step: '1', max: 1440, hint: "empty = the bridge's limit (60); never more than it", agents: ['claude', 'codex']}
];
const brOptOk = (agent, d, v) => v === '' || v === undefined || v === null || v === 0 || (d.kind === 'model' ? String(v).split(d.key === 'fallbackModel' ? ',' : '\u0000').every(m => BR_MODEL_RE.test(m.trim()))
  : d.kind === 'effort' ? BR_EFFORTS[agent].includes(v) : +v > 0 && +v <= d.max && (d.key !== 'maxMinutes' || Number.isInteger(+v)));
/** saved settings: only well-formed values (anything else falls back to the CLI's default) */
function cleanBridgeOpts(agent, o){
  const out = {}; if (!o || typeof o !== 'object') return out;
  for (const d of BR_OPTS) if (d.agents.includes(agent) && o[d.key] !== undefined && o[d.key] !== '' && brOptOk(agent, d, o[d.key])) out[d.key] = d.kind === 'num' ? +o[d.key] : String(o[d.key]).trim();
  return out;
}
const DEFAULT_SETTINGS = {
  version: 2,
  swipe: {dist: 25, angle: 50, effects: true},   // touch screens: % of card width, degrees off horizontal, stars
  showAnalytics: true,                             // the Analytics tab (Settings → Tabs)
  promptFile: false,                               // Copy saves big prompts as a file to attach (the helper reads blocks from it)
  showCopy: false,                                 // the 📋 Copy buttons next to prompts (Settings → Prompts); ▶ Run on Mac replaces them
  bridgeAgent: 'claude',                           // ▶ Run on Mac uses Claude Code or Codex (Settings → Mac bridge)
  bridgeOpts: {claude: {}, codex: {}},              // what each agent runs with there: model, effort, limits (empty = the CLI's default)
  checks: {...CHECK_DEFAULTS},                     // the checker (Prompt page): sent to Claude, used by Analytics
  fixRules: [...FMT_KEYS],                         // the Checker rules a global revision fixes (Revise → Global revision)
  grTask: {instr: '', mode: 'content', split: false, del: false},   // its instruction and options
  grFilter: {match: 'all', conds: []},             // its filter: [{key, deny, a: {arguments}}], allow all / any
  fixPresets: [],                                  // your own presets there: [{name, rules, task?, filter?}]
  keys: {exclude: ['q'], change: ['w'], approve: ['d'], reset: ['r'], next: ['Meta', 'ArrowRight'], prev: ['ArrowLeft'],
         flip: ['Tab'], copy: ['c'], pane: ['e'], order: ['o'], image: ['i'], sidebar: ['\\']},
  leader: [
    {key: 'w', text: '', then: 'focus'},
    {key: 'f', text: "I don't understand this card", then: 'next'},
    {key: 's', text: 'Something is broken in the card, most likely the image but please check through everything in this card', then: 'next'}
  ]
};
const KEY_LABELS = {exclude: 'Exclude & next', change: 'Request change (opens the menu)', approve: 'Approve & next', reset: 'Reset to unreviewed',
  next: 'Next card', prev: 'Previous card', flip: 'Flip front / back', copy: 'Copy card to clipboard (yank)', pane: 'Preview ⇄ Edit (narrow window)',
  order: 'Toggle card order', image: 'Add image', sidebar: 'Show / hide sidebar'};
let SET = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
function loadSettings(){
  try { const j = JSON.parse(localStorage.getItem('acs-settings') || 'null'); if (j) SET = mergeSettings(j); } catch {}
}
function mergeSettings(j){
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (j && j.keys) for (const k of Object.keys(out.keys)) if (Array.isArray(j.keys[k])) out.keys[k] = j.keys[k].map(String);
  // v2 swapped the defaults (Q exclude, D approve); move people who never changed the old defaults (Q approve, D exclude) over
  if (j && j.keys && !(j.version >= 2) && J(j.keys.approve) === J(['q']) && J(j.keys.exclude) === J(['d'])){ out.keys.approve = ['d']; out.keys.exclude = ['q']; }
  if (j && j.showAnalytics === false) out.showAnalytics = false;
  if (j && j.promptFile === true) out.promptFile = true;
  if (j && j.showCopy === true) out.showCopy = true;   // on only when chosen: settings saved before it existed hide them too
  if (j && ['claude', 'codex'].includes(j.bridgeAgent)) out.bridgeAgent = j.bridgeAgent;
  if (j && j.bridgeOpts && typeof j.bridgeOpts === 'object') for (const a of ['claude', 'codex']) out.bridgeOpts[a] = cleanBridgeOpts(a, j.bridgeOpts[a]);
  if (j && j.checks && typeof j.checks === 'object') for (const d of CHECK_DEFS){
    const v = j.checks[d.key]; if (v === undefined) continue;
    if (d.kind === 'level'){ if (['error', 'warn', 'off'].includes(v)) out.checks[d.key] = v; }
    else if (Number.isFinite(+v) && +v >= 0) out.checks[d.key] = Math.round(+v);
  }
  if (j && Array.isArray(j.fixRules)) out.fixRules = FIX_RULES.filter(k => j.fixRules.includes(k));
  if (j && j.grTask) out.grTask = cleanGrTask(j.grTask);
  if (j && j.grFilter) out.grFilter = cleanGrFilter(j.grFilter);
  if (j && Array.isArray(j.fixPresets)) out.fixPresets = j.fixPresets.filter(p => p && typeof p.name === 'string' && p.name.trim() && Array.isArray(p.rules))
    .map(p => { const t = p.task && cleanGrTask(p.task), f = p.filter && cleanGrFilter(p.filter);
      return {name: p.name.trim().slice(0, 40), rules: FIX_RULES.filter(k => p.rules.includes(k)), ...(t && t.instr.trim() ? {task: t} : {}), ...(f && f.conds.length ? {filter: f} : {})}; })
    .filter(p => p.rules.length || p.task || p.filter).slice(0, 20);
  if (j && j.swipe && typeof j.swipe === 'object'){
    const n = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d;
    out.swipe = {dist: n(j.swipe.dist, 8, 60, 25), angle: n(j.swipe.angle, 10, 75, 50), effects: j.swipe.effects !== false};
  }
  if (j && Array.isArray(j.leader)) out.leader = j.leader.filter(x => x && x.key).map(x => ({key: String(x.key), text: String(x.text || ''), then: ['focus', 'next', 'stay'].includes(x.then) ? x.then : 'next'}));
  return out;
}
/** a global revision's instruction and options, and its filter, as saved (condition keys are checked when they are used) */
function cleanGrTask(t){
  return {instr: typeof t.instr === 'string' ? t.instr.slice(0, 4000) : '', mode: t.mode === 'format' ? 'format' : 'content', split: !!t.split, del: !!t.del};
}
function cleanGrFilter(f){
  const arg = a => Object.fromEntries(Object.entries(a && typeof a === 'object' ? a : {}).filter(([, v]) => ['string', 'number'].includes(typeof v)).map(([k, v]) => [k.slice(0, 20), typeof v === 'string' ? v.slice(0, 500) : v]));
  return {match: f && f.match === 'any' ? 'any' : 'all',
    conds: (f && Array.isArray(f.conds) ? f.conds : []).filter(x => x && typeof x.key === 'string').slice(0, 30).map(x => ({key: x.key.slice(0, 40), deny: !!x.deny, ...(x.a ? {a: arg(x.a)} : {})}))};
}
function saveSettings(){ try { localStorage.setItem('acs-settings', JSON.stringify(SET)); } catch {} Store.putSettings(SET).catch(() => {}); renderKeyHints(); if (typeof settingsChanged === 'function') settingsChanged(); }
const MOD_KEYS = ['Meta', 'Control', 'Alt', 'Shift'];
const keyName = k => ({Meta: '⌘ Cmd', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', ' ': 'Space', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Tab: 'Tab', Enter: 'Enter'}[k] || (k.length === 1 ? k.toUpperCase() : k));
const keyMatches = (action, key) => (SET.keys[action] || []).some(k => k.length === 1 ? k.toLowerCase() === key.toLowerCase() : k === key);
/** optional tabs (Settings → Tabs); tab numbers follow what is shown */
function applyTabs(){
  const on = SET.showAnalytics !== false, b = $('#tabs button[data-tab=analytics]');
  if (b){ b.hidden = !on; if (!on && b.classList.contains('active')) showTab('review'); }
  let i = 0; $$('#tabs button').forEach(x => { if (!x.hidden){ const n = x.querySelector('.n'); if (n) n.textContent = ++i; } });
}
/** Prompt transfer controls follow the saved preference, including before bridge setup.
    Manual transfer reveals them everywhere and persists the choice for the next visit. */
function copyHidden(){ return !SET.showCopy; }
function revealManualTransfer(){ SET.showCopy = true; saveSettings(); }
function applyCopyButtons(){
  const off = copyHidden();
  document.body.classList.toggle('hide-copy', off);
  $$('.brRun').forEach(b => b.classList.toggle('primary', off));
  $$('.manualTransfer').forEach(b => { b.hidden = !off; });
}
document.addEventListener('click', e => {
  if (e.target.closest('.manualTransfer')) revealManualTransfer();
});
function renderKeyHints(){
  try { applyTabs(); } catch {}
  applyCopyButtons();
  if ($('#ckGrid') && typeof renderCheckSettings === 'function') try { renderCheckSettings(); } catch {}   // the checker settings change with the rest of the settings
  $$('.optPromptFile').forEach(cb => { cb.checked = !!SET.promptFile; });
  $$('.kbd[data-k]').forEach(el => { const ks = SET.keys[el.dataset.k] || []; el.textContent = ks.length ? keyName(ks[0]) : '–'; el.title = ks.map(keyName).join(' / '); });
}
/* -------- leader (request-change) menu: shown when the key is pressed and released */
let leader = null;   // {shown:boolean}
function showLeader(anchor){
  const m = $('#leaderMenu'), b = (anchor || $('#stChange')).getBoundingClientRect();
  m.innerHTML = `<div class="lm-h">Request change…</div>` + SET.leader.map((x, i) => `<div class="lm-row" data-li="${i}"><span class="kbd">${esc(keyName(x.key))}</span><span>${x.text ? esc(x.text.length > 70 ? x.text.slice(0, 68) + '…' : x.text) : '<i>type your own feedback</i>'}</span><span class="spacer"></span><span class="small muted">${{focus: '→ edit', next: '→ next', stay: ''}[x.then]}</span></div>`).join('')
    + `<div class="lm-row small muted"><span class="kbd">Esc</span><span>cancel</span></div>`;
  m.classList.add('show');
  m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, b.left)) + 'px';
  m.style.top = (b.bottom + 6 + m.offsetHeight > innerHeight - 8 ? Math.max(8, b.top - m.offsetHeight - 6) : b.bottom + 6) + 'px';
  if (leader) leader.shown = true;
}
function hideLeader(){ leader = null; $('#leaderMenu').classList.remove('show'); }
$('#leaderMenu').addEventListener('click', e => { const r = e.target.closest('[data-li]'); if (r) runLeader(SET.leader[+r.dataset.li]); else if (e.target.closest('.lm-row')) hideLeader(); });
function runLeader(item){
  hideLeader();
  const c = curCard(); if (!c) return;
  if (item.text){ c.feedback = c.feedback && c.feedback.trim() && !c.feedback.includes(item.text) ? c.feedback.trim() + '\n' + item.text : (c.feedback && c.feedback.includes(item.text) ? c.feedback : item.text); }
  setCardStatus(c, 'change'); save();
  $('#edFeedback').value = c.feedback || '';
  renderReviewSoft();
  if (item.then === 'focus'){
    const ta = isPhone() ? $('#mbNote') : $('#edFeedback');
    if (isPhone()){ ta.value = c.feedback || ''; ta.dataset.card = c.id; syncMobileBar(); }
    ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length;
  }
  else if (item.then === 'next') setTimeout(nextUnreviewed, 120);
  if (item.text) toast('Change requested: ' + (item.text.length > 50 ? item.text.slice(0, 48) + '…' : item.text));
}
$('#stChange').onclick = () => runLeader(SET.leader.find(x => x.then === 'focus' && !x.text) || {text: '', then: 'focus'});
/* -------- review key handler (modifier keys trigger when tapped on their own) */
let modTap = null;
function reviewAction(key, e){
  if (leader){
    const item = SET.leader.find(x => x.key.toLowerCase() === key.toLowerCase());
    e && e.preventDefault();
    if (item) runLeader(item); else if (key === 'Escape' || !MOD_KEYS.includes(key)) hideLeader();
    return true;
  }
  const act = Object.keys(SET.keys).find(a => keyMatches(a, key)); if (!act) return false;
  e && e.preventDefault();
  switch (act){
    case 'approve': setStatus('ok'); break;
    case 'change': leader = {shown: false}; leader.timer = setTimeout(() => leader && !leader.shown && showLeader(), 600); break;
    case 'exclude': setStatus('drop'); break;
    case 'reset': $('#stReset').click(); break;
    case 'next': move(1); break;
    case 'prev': move(-1); break;
    case 'flip': side = side === 'front' ? 'back' : 'front'; renderPreview(); break;
    case 'copy': yankCard(); break;
    case 'pane': setPane(PANE === 'preview' ? 'edit' : 'preview'); break;
    case 'order': if (hasOrder()){ S.order = (S.order === 'mixed') ? 'source' : 'mixed'; save(); renderReview(); toast(S.order === 'mixed' ? 'Interleaved order' : 'Order as written'); } break;
    case 'image': $('#btnAddImg').click(); break;
    case 'sidebar': toggleSidebar(); break;
  }
  return true;
}
const reviewKeysLive = () => !$('#imgDlg').open && !$('#setDlg').open && !$('#irDlg').open && $('#tab-review').classList.contains('active') && S.cards.length;
document.addEventListener('keydown', e => {
  if (capturing) return;
  if (MOD_KEYS.includes(e.key)){ modTap = e.repeat ? modTap : e.key; return; }
  modTap = null;
  if (keyMatches('sidebar', e.key) && !e.target.closest('input,textarea,select,[contenteditable]') && !e.metaKey && !e.ctrlKey){ e.preventDefault(); toggleSidebar(); return; }
  if (!reviewKeysLive()) return;
  if (e.target.closest('input,textarea,select,[contenteditable]')){ if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ' && !leader){ side = side === 'front' ? 'back' : 'front'; renderPreview(); e.preventDefault(); return; }
  if (e.key === 'j' && !leader){ move(1); return; } if (e.key === 'k' && !leader){ move(-1); return; }
  reviewAction(e.key, e);
});
document.addEventListener('keyup', e => {
  if (capturing) return;
  if (MOD_KEYS.includes(e.key)){
    const tapped = modTap === e.key; modTap = null;
    if (tapped && reviewKeysLive() && !e.target.closest('input,textarea,select,[contenteditable]')) reviewAction(e.key, e);
    return;
  }
  if (leader && !leader.shown && keyMatches('change', e.key)){ clearTimeout(leader.timer); showLeader(); }
});
window.addEventListener('blur', () => { modTap = null; });
document.addEventListener('pointerdown', e => { if (leader && !e.target.closest('#leaderMenu')) hideLeader(); modTap = null; });
/* -------- settings dialog */
let capturing = null;
function renderSwipeSettings(){
  $('#swDist').value = SET.swipe.dist; $('#swDistV').textContent = SET.swipe.dist + '%';
  $('#swAng').value = SET.swipe.angle; $('#swAngV').textContent = SET.swipe.angle + '°';
  $('#swFx').checked = SET.swipe.effects;
  $('#setAna').checked = SET.showAnalytics !== false;
  $('#setCopy').checked = !!SET.showCopy;
}
$('#swDist').oninput = e => { SET.swipe.dist = +e.target.value; renderSwipeSettings(); };
$('#swAng').oninput = e => { SET.swipe.angle = +e.target.value; renderSwipeSettings(); };
['#swDist', '#swAng'].forEach(q => $(q).onchange = () => saveSettings());
$('#swFx').onchange = e => { SET.swipe.effects = e.target.checked; saveSettings(); };
$('#setAna').onchange = e => { SET.showAnalytics = e.target.checked; saveSettings(); applyTabs(); };
$('#setCopy').onchange = e => { SET.showCopy = e.target.checked; saveSettings(); };   // saveSettings → renderKeyHints → applyCopyButtons
function renderSettings(){
  renderSwipeSettings();
  $('#keyGrid').innerHTML = Object.keys(DEFAULT_SETTINGS.keys).map(a => `<span>${esc(KEY_LABELS[a])}</span>
    <span class="row" style="gap:4px;flex-wrap:nowrap">${[0, 1].map(i => `<button class="btn sm keycap" data-act="${a}" data-i="${i}">${SET.keys[a][i] ? esc(keyName(SET.keys[a][i])) : '<span class="muted">+</span>'}</button>`).join('')}</span>`).join('');
  $('#leadRows').innerHTML = SET.leader.map((x, i) => `<div class="leadrow">
    <button class="btn sm keycap" data-lead="${i}">${esc(keyName(x.key))}</button>
    <input type="text" data-lt="${i}" value="${esc(x.text)}" placeholder="(type your own)">
    <select data-lthen="${i}"><option value="focus" ${x.then === 'focus' ? 'selected' : ''}>edit feedback</option><option value="next" ${x.then === 'next' ? 'selected' : ''}>go to next</option><option value="stay" ${x.then === 'stay' ? 'selected' : ''}>stay</option></select>
    <button class="btn sm" data-ldel="${i}" title="Remove">✕</button></div>`).join('');
}
$('#btnSettings').onclick = () => { renderSettings(); renderPeople(); if (typeof loadDevices === 'function') loadDevices(); $('#setDlg').showModal(); };
/* ---- admin: user management (online version, admins only) - see lib/users.ts for what each control does */
async function renderPeople(){ $('#peopleSec').hidden = !(Store.hosted && Store.user && Store.user.admin); }
$('#btnAdmin').onclick = () => { $('#setDlg').close(); openAdmin(); };
const admApi = async (method, path, body) => {
  const r = await fetch('/api/admin/' + path, {method, cache: 'no-store', ...(body !== undefined ? {body: typeof body === 'string' ? body : JSON.stringify(body), headers: {'Content-Type': 'application/json'}} : {})});
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
  return j ?? t;
};
const fmtBytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const ago = t => { if (!t) return 'never'; const s = (Date.now() - new Date(t)) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
let adm = {users: [], pending: [], cur: null, people: null};
async function openAdmin(){ $('#admDlg').showModal(); await loadAdmin(); }
async function loadAdmin(keep){
  try {
    const [u, ppl] = await Promise.all([admApi('GET', 'users'), fetch('/api/people', {cache: 'no-store'}).then(r => r.json())]);
    adm.users = u.users; adm.pending = u.pending; adm.people = ppl;
    if (!keep || !adm.users.some(x => x.owner === adm.cur)) adm.cur = adm.cur && adm.users.some(x => x.owner === adm.cur) ? adm.cur : (adm.users[0] || {}).owner || null;
    renderAdminList(); renderAdminUser();
  } catch (e) { $('#admUsers').innerHTML = `<div class="small muted">Could not load: ${esc(e.message)}</div>`; }
}
const avatar = l => `https://github.com/${encodeURIComponent(l)}.png?size=56`;
function renderAdminList(){
  const added = new Set((adm.people && adm.people.added || []).map(x => x.login));
  $('#admUsers').innerHTML = adm.users.map(u => `<div class="adm-u ${u.owner === adm.cur ? 'on' : ''}" data-uo="${esc(u.owner)}">
      <img src="${esc(u.image || avatar(u.login))}" alt="" onerror="this.style.visibility='hidden'"><div class="t"><div><b>@${esc(u.login)}</b> ${u.role === 'admin' ? '<span class="adm-st admin">admin</span>' : ''}
      ${u.status !== 'active' ? `<span class="adm-st ${u.status}">${u.status === 'readonly' ? 'read-only' : u.status}</span>` : ''}${!u.allowed ? '<span class="adm-st disabled">no access</span>' : ''}</div>
      <div class="small muted">${u.projects} project${u.projects === 1 ? '' : 's'} · ${fmtBytes(u.bytes)} · ${ago(u.last_seen)}</div></div></div>`).join('')
    + (adm.pending.length ? `<div class="small muted" style="margin-top:8px">Allowed, not signed in yet</div>` + adm.pending.map(p => `<div class="adm-u" style="cursor:default">
      <img src="${avatar(p.login)}" alt="" onerror="this.style.visibility='hidden'"><div class="t"><div><b>@${esc(p.login)}</b></div><div class="small muted">${p.envAdmin ? 'admin' : added.has(p.login) ? 'waiting for first sign-in' : 'set on Vercel'}</div></div>
      ${added.has(p.login) ? `<button class="btn sm" data-rm="${esc(p.login)}" title="Remove access">✕</button>` : ''}</div>`).join('') : '');
}
$('#admUsers').addEventListener('click', async e => {
  const rm = e.target.closest('[data-rm]');
  if (rm){ e.stopPropagation(); if (!confirm(`Stop @${rm.dataset.rm} from signing in? Their data is kept.`)) return;
    const r = await fetch('/api/people/' + encodeURIComponent(rm.dataset.rm), {method: 'DELETE'}); const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || `HTTP ${r.status}`, 4000); toast(`@${rm.dataset.rm} can no longer sign in`); return loadAdmin(true); }
  const it = e.target.closest('[data-uo]'); if (!it) return;
  adm.cur = it.dataset.uo; renderAdminList(); renderAdminUser();
});
$('#peopleAdd').onsubmit = async e => {
  e.preventDefault();
  const login = $('#peopleLogin').value.trim().replace(/^@/, ''); if (!login) return;
  const r = await fetch('/api/people', {method: 'POST', body: JSON.stringify({login}), headers: {'Content-Type': 'application/json'}});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || `Could not add (HTTP ${r.status})`, 4000);
  $('#peopleLogin').value = ''; toast(`@${login} can now sign in`); loadAdmin(true);
};
$('#admClose').onclick = () => $('#admDlg').close();
$('#admRefresh').onclick = () => loadAdmin(true);
async function renderAdminUser(){
  const box = $('#admDetail'), u = adm.users.find(x => x.owner === adm.cur);
  if (!u){ box.innerHTML = '<div class="muted small" style="padding:20px">Choose an account.</div>'; return; }
  const me = Store.user && Store.user.login && Store.user.login.toLowerCase() === u.login, locked = u.envAdmin || me;
  const inApp = (adm.people && adm.people.added || []).some(x => x.login === u.login);
  const quota = u.quota_mb ? u.quota_mb * 1048576 : 0;
  box.innerHTML = `<div class="row" style="gap:12px;margin-bottom:12px"><img src="${esc(u.image || avatar(u.login))}" alt="" width="48" height="48" style="border-radius:50%" onerror="this.style.visibility='hidden'">
      <div><h2 style="margin:0">@${esc(u.login)}${u.name ? ` <span class="muted" style="font-weight:400">${esc(u.name)}</span>` : ''}</h2>
      <div class="small muted">first seen ${new Date(u.first_seen).toLocaleDateString()} · last active ${ago(u.last_seen)} · account <code>${esc(u.owner)}</code>${u.signed_out ? ` · signed out everywhere ${ago(u.signed_out)}` : ''}</div></div></div>
    <div class="adm-sec"><h3>Access and limits</h3><div class="adm-ctl">
      <label class="f">Role<select id="admRole" ${locked ? 'disabled' : ''}><option value="user">User</option><option value="admin">Admin (can manage users)</option></select></label>
      <label class="f">Status<select id="admStatus" ${locked ? 'disabled' : ''}><option value="active">Active</option><option value="readonly">Read-only (can view, can't save)</option><option value="disabled">Disabled (can't use the app)</option></select></label>
      <label class="f">Storage limit (MB)<input type="number" min="1" id="admQuota" placeholder="no limit" value="${u.quota_mb ?? ''}"></label>
      <div><button class="btn" id="admSave">Save changes</button></div></div>
      <div class="small" style="margin-top:10px">Using <b>${fmtBytes(u.bytes)}</b>${quota ? ` of ${u.quota_mb} MB` : ''} in ${u.projects} project(s) and ${u.files} file(s).</div>
      ${quota ? `<div class="ana-meter" style="margin-top:4px"><i style="width:${Math.min(100, u.bytes / quota * 100)}%;background:${u.bytes > quota * .9 ? 'var(--bad)' : 'var(--accent)'}"></i></div>` : ''}
      ${locked ? `<div class="small muted" style="margin-top:6px">${me ? 'This is you.' : 'This admin is set on Vercel (ACS_ADMIN_GITHUB).'} Role and status can't be changed here.</div>` : ''}
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">${!me ? `<button class="btn" id="admSignOut" title="Ends every session this account has; they can sign in again">Sign out everywhere</button>` : ''}
      ${inApp ? `<button class="btn" id="admRevoke">Remove sign-in access</button>` : ''}</div></div>
    <div class="adm-sec"><h3>Projects</h3><div id="admProjects" class="small muted">Loading…</div></div>
    <div class="adm-sec"><h3>Settings</h3><div class="row" style="gap:8px"><button class="btn" id="admSetView">View / edit</button><button class="btn" id="admSetReset">Reset to defaults</button></div></div>
    <div id="admEditor"></div>
    ${!me ? `<div class="adm-sec adm-danger"><h3>Danger zone</h3><div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn" id="admWipe">Delete all their data</button><button class="btn" id="admForget">Delete data and forget the account</button></div>
      <div class="small muted" style="margin-top:6px">Deletes projects, images, history and settings. Forgetting also removes this entry (it comes back if they sign in again while allowed).</div></div>` : ''}`;
  $('#admRole').value = u.role; $('#admStatus').value = u.status;
  $('#admSave').onclick = async () => {
    const patch = {quota_mb: $('#admQuota').value === '' ? null : +$('#admQuota').value};
    if (!locked){ patch.role = $('#admRole').value; patch.status = $('#admStatus').value; }
    try { await admApi('PATCH', 'users/' + encodeURIComponent(u.owner), patch); toast('Saved'); loadAdmin(true); } catch (e) { toast(e.message, 4000); }
  };
  if ($('#admSignOut')) $('#admSignOut').onclick = async () => { if (!confirm(`Sign @${u.login} out on every device?`)) return;
    try { await admApi('PATCH', 'users/' + encodeURIComponent(u.owner), {signOut: true}); toast('Signed out everywhere'); loadAdmin(true); } catch (e) { toast(e.message, 4000); } };
  if ($('#admRevoke')) $('#admRevoke').onclick = async () => { if (!confirm(`Stop @${u.login} from signing in? Their data is kept.`)) return;
    const r = await fetch('/api/people/' + encodeURIComponent(u.login), {method: 'DELETE'}); const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || `HTTP ${r.status}`, 4000); toast('Access removed'); loadAdmin(true); };
  const typed = what => prompt(`This can't be undone. Type ${u.login} to ${what}.`) === u.login;
  if ($('#admWipe')) $('#admWipe').onclick = async () => { if (!typed('delete all their data')) return;
    try { await admApi('DELETE', 'users/' + encodeURIComponent(u.owner)); toast('Data deleted'); loadAdmin(true); } catch (e) { toast(e.message, 4000); } };
  if ($('#admForget')) $('#admForget').onclick = async () => { if (!typed('delete their data and forget the account')) return;
    try { await admApi('DELETE', 'users/' + encodeURIComponent(u.owner) + '?forget=1'); toast('Account forgotten'); adm.cur = null; loadAdmin(); } catch (e) { toast(e.message, 4000); } };
  $('#admSetView').onclick = async () => { try { const j = await admApi('GET', `users/${encodeURIComponent(u.owner)}/settings`);
    admEditor(`Settings of @${u.login}`, JSON.stringify(j, null, 2), async txt => admApi('PUT', `users/${encodeURIComponent(u.owner)}/settings`, txt)); } catch (e) { toast(e.message, 4000); } };
  $('#admSetReset').onclick = async () => { if (!confirm(`Reset @${u.login}'s keys and settings to the defaults?`)) return;
    try { await admApi('DELETE', `users/${encodeURIComponent(u.owner)}/settings`); toast('Settings reset'); } catch (e) { toast(e.message, 4000); } };
  renderAdminProjects(u);
}
async function renderAdminProjects(u){
  const box = $('#admProjects'), base = `users/${encodeURIComponent(u.owner)}/project/`;
  let list; try { list = await admApi('GET', `users/${encodeURIComponent(u.owner)}/projects`); } catch (e) { box.textContent = e.message; return; }
  if (!list.length){ box.textContent = 'No projects.'; return; }
  box.classList.remove('muted');
  box.innerHTML = `<div class="ana-scroll"><table class="ana-tbl"><thead><tr><th>Project</th><th class="num">Cards</th><th class="num">Size</th><th class="num">Images & files</th><th>Updated</th><th></th></tr></thead><tbody>`
    + list.map(p => `<tr data-pid="${esc(p.id)}"${p.deleted ? ' class="muted"' : ''}><td><b>${esc(p.name || p.id)}</b>${p.deleted ? ' <span class="adm-st disabled">deleted</span>' : ''}<div class="small muted">${esc(p.id)} · rev ${p.rev ?? '–'} · ${p.history} saved cop${p.history === 1 ? 'y' : 'ies'}</div></td>`
      + `<td class="num">${p.cards ?? '–'}</td><td class="num">${fmtBytes(p.bytes)}</td><td class="num">${p.files} · ${fmtBytes(p.fileBytes)}</td><td class="small">${p.updated ? ago(p.updated) : '–'}</td>`
      + `<td style="white-space:nowrap">${p.deleted || !p.stored ? `<button class="btn sm" data-pa="restore">Restore</button>`
        : `<button class="btn sm" data-pa="edit">Edit</button> <button class="btn sm" data-pa="rename">Rename</button> <button class="btn sm" data-pa="dl">⬇</button> <button class="btn sm" data-pa="hist">History</button> <button class="btn sm" data-pa="files">Files</button> <button class="btn sm" data-pa="del">Delete</button>`}</td></tr>`).join('')
    + `</tbody></table></div>`;
  box.onclick = async e => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    const pid = b.closest('[data-pid]').dataset.pid, p = list.find(x => x.id === pid), path = base + encodeURIComponent(pid);
    try {
      if (b.dataset.pa === 'edit'){ const txt = await admApi('GET', path);
        admEditor(`Project "${p.name || pid}" of @${u.login}`, JSON.stringify(typeof txt === 'string' ? JSON.parse(txt) : txt, null, 1), async t => { await admApi('PUT', path, t); renderAdminProjects(u); },
          'Saving replaces the stored project and raises its revision, so their open windows pick the change up. The old version is kept in History.'); }
      if (b.dataset.pa === 'rename'){ const n = prompt('New name', p.name || ''); if (!n) return; await admApi('PATCH', path, {name: n}); toast('Renamed'); renderAdminProjects(u); }
      if (b.dataset.pa === 'dl'){ const txt = await admApi('GET', path); download(new Blob([typeof txt === 'string' ? txt : JSON.stringify(txt)], {type: 'application/json'}), `${u.login}-${(p.name || pid).replace(/[^\w.-]+/g, '_')}.json`); }
      if (b.dataset.pa === 'del'){ if (!confirm(`Delete "${p.name || pid}" for @${u.login}? It can be restored from here later.`)) return; await admApi('DELETE', path); toast('Deleted'); renderAdminProjects(u); loadAdmin(true); }
      if (b.dataset.pa === 'restore'){ await admApi('POST', path + '/restore'); toast('Restored'); renderAdminProjects(u); loadAdmin(true); }
      if (b.dataset.pa === 'hist'){ const h = await admApi('GET', path + '/history');
        admPanel(`History of "${p.name || pid}"`, h.length ? `<table class="ana-tbl"><thead><tr><th>Saved</th><th class="num">Rev</th><th class="num">Size</th><th></th></tr></thead><tbody>${h.map(x => `<tr><td>${new Date(x.at).toLocaleString()}</td><td class="num">${x.rev}</td><td class="num">${fmtBytes(x.bytes)}</td><td><button class="btn sm" data-hat="${esc(x.at)}">Put this version back</button></td></tr>`).join('')}</tbody></table>` : 'No saved copies yet.',
          async el => { const at = el.dataset.hat; if (!at || !confirm('Make this saved copy the current version? The current one goes into history.')) return; await admApi('POST', path + '/history', {at}); toast('Version restored'); renderAdminProjects(u); }); }
      if (b.dataset.pa === 'files'){ const f = await admApi('GET', path + '/files');
        admPanel(`Files of "${p.name || pid}"`, f.length ? `<table class="ana-tbl"><thead><tr><th>Name</th><th>Kind</th><th class="num">Size</th><th></th></tr></thead><tbody>${f.map(x => `<tr><td>${esc(x.name)}${x.complete ? '' : ' <span class="adm-st readonly">incomplete</span>'}</td><td>${esc(x.kind)}</td><td class="num">${fmtBytes(x.size)}</td><td style="white-space:nowrap"><a class="btn sm" href="/api/admin/${path}/files/${esc(x.kind)}/${encodeURIComponent(x.name)}" download>⬇</a> <button class="btn sm" data-fdel="${esc(x.kind)}/${esc(x.name)}">Delete</button></td></tr>`).join('')}</tbody></table>` : 'No files.',
          async el => { const k = el.dataset.fdel; if (!k || !confirm(`Delete ${k.split('/').slice(1).join('/')}? Cards using it will show a missing image.`)) return; const [kind, ...nm] = k.split('/'); await admApi('DELETE', `${path}/files/${kind}/${encodeURIComponent(nm.join('/'))}`); toast('File deleted'); b.click(); }); }
    } catch (err) { toast(err.message, 4000); }
  };
}
/** a JSON editor inside the user page: validates before saving */
function admEditor(title, text, onSave, note){
  const box = $('#admEditor');
  box.innerHTML = `<div class="adm-sec"><div class="row"><h3 style="margin:0">${esc(title)}</h3><span class="spacer"></span><button class="btn sm" id="admEdClose">Close</button></div>
    ${note ? `<div class="small muted" style="margin:6px 0">${esc(note)}</div>` : ''}<textarea class="adm-json" id="admEdText" spellcheck="false"></textarea>
    <div class="row" style="gap:8px;margin-top:6px"><span class="small" id="admEdMsg"></span><span class="spacer"></span><button class="btn primary" id="admEdSave">Save</button></div></div>`;
  $('#admEdText').value = text; box.scrollIntoView({behavior: 'smooth', block: 'start'});
  $('#admEdClose').onclick = () => box.innerHTML = '';
  $('#admEdText').oninput = () => { try { JSON.parse($('#admEdText').value); $('#admEdMsg').textContent = ''; } catch (e) { $('#admEdMsg').innerHTML = `<span style="color:var(--bad)">Not valid JSON: ${esc(e.message)}</span>`; } };
  $('#admEdSave').onclick = async () => {
    let t = $('#admEdText').value; try { JSON.parse(t); } catch (e) { return toast('Not valid JSON: ' + e.message, 4000); }
    try { await onSave(t); toast('Saved'); box.innerHTML = ''; } catch (e) { toast(e.message, 4000); }
  };
}
function admPanel(title, html, onClick){
  const box = $('#admEditor');
  box.innerHTML = `<div class="adm-sec"><div class="row"><h3 style="margin:0">${esc(title)}</h3><span class="spacer"></span><button class="btn sm" id="admEdClose">Close</button></div><div class="ana-scroll" style="margin-top:8px">${html}</div></div>`;
  $('#admEdClose').onclick = () => box.innerHTML = '';
  box.onclick = e => { const el = e.target.closest('[data-hat],[data-fdel]'); if (el) onClick(el).catch(err => toast(err.message, 4000)); };
  box.scrollIntoView({behavior: 'smooth', block: 'start'});
}
$('#setClose').onclick = () => $('#setDlg').close();
$('#setDlg').addEventListener('click', e => {
  const kc = e.target.closest('.keycap');
  if (kc){ $$('.keycap.listening').forEach(x => x.classList.remove('listening')); kc.classList.add('listening'); kc.textContent = 'press…'; capturing = kc; return; }
  const del = e.target.closest('[data-ldel]'); if (del){ SET.leader.splice(+del.dataset.ldel, 1); saveSettings(); renderSettings(); }
});
$('#setDlg').addEventListener('input', e => { const i = e.target.dataset.lt; if (i !== undefined){ SET.leader[+i].text = e.target.value; saveSettings(); } });
$('#setDlg').addEventListener('change', e => { const i = e.target.dataset.lthen; if (i !== undefined){ SET.leader[+i].then = e.target.value; saveSettings(); } });
document.addEventListener('keydown', e => {
  if (!capturing) return;
  e.preventDefault(); e.stopPropagation();
  const kc = capturing;
  if (MOD_KEYS.includes(e.key)){ kc.dataset.mod = e.key; return; }  // decided on keyup (a tap)
  commitCapture(kc, e.key === 'Escape' ? null : e.key === 'Backspace' ? '' : e.key);
}, true);
document.addEventListener('keyup', e => { if (capturing && MOD_KEYS.includes(e.key) && capturing.dataset.mod === e.key){ e.preventDefault(); commitCapture(capturing, e.key); } }, true);
function commitCapture(kc, key){
  capturing = null; kc.classList.remove('listening'); delete kc.dataset.mod;
  if (key !== null){
    if (kc.dataset.lead !== undefined){ if (key) SET.leader[+kc.dataset.lead].key = key; }
    else { const arr = SET.keys[kc.dataset.act].slice(); if (key) arr[+kc.dataset.i] = key; else arr.splice(+kc.dataset.i, 1);
           // a key can only do one thing: take it away from other actions
           if (key) for (const a of Object.keys(SET.keys)) if (a !== kc.dataset.act) SET.keys[a] = SET.keys[a].filter(k => k.toLowerCase() !== key.toLowerCase());
           SET.keys[kc.dataset.act] = arr.filter(Boolean); }
    saveSettings();
  }
  renderSettings();
}
$('#leadAdd').onclick = () => { SET.leader.push({key: 'x', text: '', then: 'next'}); saveSettings(); renderSettings(); };
$('#setReset').onclick = () => { if (confirm('Reset all keys and the request-change menu to the defaults?')){ SET = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); saveSettings(); renderSettings(); } };
$('#setExport').onclick = () => download(new Blob([JSON.stringify({format: 'anki-studio/settings-v1', ...SET}, null, 2)], {type: 'application/json'}), 'acs-settings.json');
$('#setImport').onclick = () => $('#setFile').click();
$('#setFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  // a full export (.zip from "App data -> Export all") goes to the app-data import
  const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
  if (/\.zip$/i.test(f.name) || (head[0] === 0x50 && head[1] === 0x4b)){ $('#setDlg') && $('#setDlg').open && $('#setDlg').close(); return importAppZip(f); }
  try { SET = mergeSettings(JSON.parse(await f.text())); saveSettings(); renderSettings(); toast('Settings imported'); } catch (er) { toast('Not a settings file: ' + er.message); } };
// "📎 As a file" next to each prompt's Copy button: one setting for all of them
document.addEventListener('change', e => { const cb = e.target.closest('.optPromptFile'); if (!cb) return; SET.promptFile = cb.checked; saveSettings();
  toast(cb.checked ? 'Copy now saves the prompt as a file to attach (and copies a short message)' : 'Copy puts the whole prompt on the clipboard again', 3500); });
loadSettings(); renderKeyHints();

document.addEventListener('paste', e => {
  if ($('#imgDlg').open || $('#irDlg').open || !$('#tab-review').classList.contains('active') || !S.cards.length) return;
  if (e.target.closest('input,textarea')) return;
  const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (it){ e.preventDefault(); openImageDialog({target: {f: curCard().type === 'cloze' ? 'extra' : 'back'}, blob: it.getAsFile()}); }
});

