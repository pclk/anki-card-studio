/* ====================================================================== SYNC: revisions, 3-way merge, conflict resolver */
const WINDOW_ID = 'w' + Math.random().toString(36).slice(2, 9);
const sync = {rev: 0, base: null, dirty: false, paused: false, state: 'ok', saved: 0, merged: 0, note: '', kept: false, keptJson: null, keptPrev: null, closed: false};
// kept: this window left a copy of its edits for the account in this browser (Store.keepPending): keptJson as stored,
// keptPrev = this window's state it was made from (the base for merging in another tab's kept edits). closed: signing out
let syncChannel = null; try { syncChannel = new BroadcastChannel('acs-sync'); } catch {}
const plain = st => JSON.parse(JSON.stringify(st, (k, v) => (k === 'blob' || k === 'remote' || v instanceof Blob) ? undefined : v));
const J = x => JSON.stringify(x === undefined ? null : x);
/** 3-way value merge: {v} or {conflict:true} */
function mergeVal(b, l, r){ const jl = J(l), jr = J(r); if (jl === jr) return {v: l}; if (jl === J(b)) return {v: r}; if (jr === J(b)) return {v: l}; return {conflict: true}; }
/** merge lists of objects by id, keeping this window's order and slotting in the other side's new items */
function mergeList(b, l, r, mergeItem, onDelConflict){
  const B = new Map((b || []).map(x => [x.id, x])), L = new Map((l || []).map(x => [x.id, x])), R = new Map((r || []).map(x => [x.id, x]));
  const order = (l || []).map(x => x.id);
  (r || []).forEach((x, i) => { if (!L.has(x.id) && !order.includes(x.id)){ const prev = i ? r[i - 1].id : null, at = prev ? order.indexOf(prev) : -1; order.splice(at + 1, 0, x.id); } });
  const out = [];
  for (const id of order){
    const bi = B.get(id), li = L.get(id), ri = R.get(id);
    if (li && ri){ out.push(mergeItem(bi, li, ri)); continue; }
    if (li && !ri){ if (!bi) out.push(li); else if (J(li) !== J(bi)) { const keep = onDelConflict && onDelConflict(id, li, 'theirs'); if (keep !== false) out.push(li); } continue; }  // deleted elsewhere
    if (!li && ri){ if (!bi) out.push(ri); else if (J(ri) !== J(bi)) { const keep = onDelConflict && onDelConflict(id, ri, 'mine'); if (keep !== false) out.push(ri); } }        // deleted here
  }
  return out;
}
const STATUS_RANK = {todo: 0, copied: 1, done: 2};
/** merge two edits of the same project. UI state (current card, scope, prompt form) stays this window's. */
function merge3(b, l, r){
  b = b || {}; const conflicts = [];
  const m = {...r};
  for (const k of ['curId', 'scope', 'prompt', 'order', 'deckFilter']) if (k in l) m[k] = l[k];
  for (const k of ['deck', 'projectName', 'generalFeedback', 'tags']){
    const v = mergeVal(b[k], l[k], r[k]);
    if (v.conflict){ m[k] = l[k]; conflicts.push({kind: 'field', key: k, mine: l[k], theirs: r[k]}); } else m[k] = v.v;
  }
  m.cards = mergeList(b.cards, l.cards, r.cards, (bc, lc, rc) => {
    bc = bc || {}; const out = {}, fields = [];
    for (const k of new Set([...Object.keys(lc), ...Object.keys(rc), ...Object.keys(bc)])){
      if (k === 'time'){ out.time = Math.max(0, (lc.time || 0) + (rc.time || 0) - (bc.time || 0)); continue; }   // both windows' review time counts
      const v = mergeVal(bc[k], lc[k], rc[k]);
      if (v.conflict){ out[k] = lc[k]; fields.push({key: k, mine: lc[k], theirs: rc[k]}); } else if (v.v !== undefined) out[k] = v.v;
    }
    if (fields.length) conflicts.push({kind: 'card', id: lc.id, fields});
    return out;
  }, (id, card, deletedBy) => { conflicts.push({kind: 'card-del', id, card, deletedBy}); return true; });
  const fieldwise = (bi, li, ri) => { bi = bi || {}; const out = {}; for (const k of new Set([...Object.keys(li), ...Object.keys(ri)])){ const v = mergeVal(bi[k], li[k], ri[k]); out[k] = v.conflict ? li[k] : v.v; } return out; };
  m.nodes = mergeList(b.nodes, l.nodes, r.nodes, fieldwise);
  m.sources = mergeList(b.sources, l.sources, r.sources, fieldwise);
  // media: union by name; a removal sticks unless the other side changed that entry
  const bm = b.media || {}, lm = l.media || {}, rm = r.media || {}; m.media = {};
  for (const n of new Set([...Object.keys(lm), ...Object.keys(rm)])){
    if (lm[n] && rm[n]) m.media[n] = fieldwise(bm[n], lm[n], rm[n]);
    else if (lm[n]){ if (!bm[n] || J(bm[n]) !== J(lm[n])) m.media[n] = lm[n]; }
    else if (!bm[n] || J(bm[n]) !== J(rm[n])) m.media[n] = rm[n];
  }
  // prompt queue: union of prompts; progress only moves forward
  if (l.batch || r.batch){
    const lb = l.batch || {items: []}, rb = r.batch || {items: []}, bb = b.batch || {items: []};
    if (!l.batch && b.batch) m.batch = null;                 // cleared here
    else if (!r.batch && b.batch) m.batch = l.batch && J(l.batch) !== J(b.batch) ? l.batch : null;
    else {
      m.batch = {...rb, ...lb, items: mergeList(bb.items.map(i => ({...i, id: i.id})), lb.items, rb.items, (bi, li, ri) => {
        const out = fieldwise(bi, li, ri);
        out.status = (STATUS_RANK[li.status] || 0) >= (STATUS_RANK[ri.status] || 0) ? li.status : ri.status;
        out.cards = Math.max(li.cards || 0, ri.cards || 0); return out; })};
    }
  }
  return {merged: m, conflicts};
}
const isUnchanged = (a, b) => J({...a, curId: 0, scope: 0, prompt: 0, order: 0, rev: 0, savedAt: 0, savedBy: 0, deckFilter: 0}) === J({...b, curId: 0, scope: 0, prompt: 0, order: 0, rev: 0, savedAt: 0, savedBy: 0, deckFilter: 0});
/** pull the stored version, merge it with this window's edits, ask about real clashes, then save the result */
async function syncWithRemote(reason){
  if (!curProject) return;
  const id = curProject;
  const remote = await Store.getProject(id, S.media); if (!remote || id !== curProject) return;
  const local = plain(snapshot()), rp = plain(remote);
  const {merged, conflicts} = merge3(sync.base || rp, local, rp);
  const finish = async m => {
    if (id !== curProject) return;
    applyMerged(m, remote);
    sync.base = rp; sync.rev = remote.rev || 0; sync.paused = false;
    const needSave = !isUnchanged(m, rp);
    sync.merged = Date.now();
    sync.note = reason === 'pull' ? 'Updated from another window' : 'Merged with changes saved elsewhere';
    if (needSave){ sync.dirty = true; renderSyncInfo(); await (async () => { saving = Promise.resolve(); await writeState(); })(); }
    else { sync.dirty = false; sync.state = 'ok'; renderSyncInfo();
      if (sync.kept){ sync.kept = false; await Store.dropPending(id, sync.keptJson); } }   // e.g. the kept edits were all turned down
    if (reason !== 'pull' || needSave) toast(sync.note + (conflicts.length ? ` - ${conflicts.length} clash(es) resolved` : ''), 2600);
  };
  if (!conflicts.length) return finish(merged);
  sync.paused = true; sync.state = 'conflict'; renderSyncInfo();
  openResolver(conflicts, merged, local, rp, finish);
}
function applyMerged(m, remote){
  const keepUI = {curId: S.curId, scope: S.scope, filter: S.filter, q: S.q, order: S.order, deckFilter: S.deckFilter};
  const media = {};
  for (const [n, e] of Object.entries(m.media || {})){ const blob = (S.media[n] && S.media[n].blob) || (remote.media && remote.media[n] && remote.media[n].blob);
    const rem = (S.media[n] && S.media[n].remote) || (remote.media && remote.media[n] && remote.media[n].remote);
    media[n] = blob ? {...e, blob} : rem ? {...e, remote: true} : {...e}; }
  for (const n of Object.keys(S.media)) if (!media[n] || media[n].blob !== S.media[n].blob) dropURL(n);
  const srcIds = J((S.sources || []).map(x => x.id));
  Object.assign(S, {deck: m.deck || S.deck, tags: m.tags || [], cards: m.cards || [], media, generalFeedback: m.generalFeedback || '', batch: m.batch || null,
                    projectName: m.projectName || '', nodes: m.nodes || [], sources: m.sources || [], whyAll: !!m.whyAll}, keepUI);
  if (J(S.sources.map(x => x.id)) !== srcIds){ srcCache.clear(); clearSourceDocuments(); }
  if (!cardById(S.curId)) S.curId = S.cards[0] ? S.cards[0].id : null;
  syncTree(); softRefresh();
}
/** re-render what's on screen without jumping to the top or stealing focus */
function softRefresh(){
  updateTabCounts(); renderTree(); renderScopeBar();
  const active = ($('#tabs button.active') || {dataset: {}}).dataset.tab;
  if (active === 'review') renderReview(); else if (active === 'sources') renderSourcesTab();
  else if (active === 'revise') renderReviseSummary(); else if (active === 'export') renderExport(); else if (active === 'prompt') renderDeckSummary();
  if (typeof renderBatch === 'function') renderBatch();
}
/* ---- background pull: when the window regains focus, every 15 s, and right away when another tab saves */
let checking = false;
async function checkRemote(){
  if (document.hidden || !curProject || sync.paused || checking || $('#syncDlg').open) return;
  checking = true;
  try {
    const rev = await Store.getRev(curProject).catch(() => null);
    if (rev != null && rev !== sync.rev){
      if (sync.dirty){ await writeState(); }        // its save conflicts -> merge path
      else await syncWithRemote('pull');
    }
    const idx = await Store.getIndex().catch(() => null);
    if (Array.isArray(idx)){ const before = J(projects.map(p => [p.id, p.name, p.cards])); const open = new Map(projects.map(p => [p.id, p.open]));
      projects = mergeIndexLists(projects, idx).filter(p => idx.some(x => x.id === p.id) || p.id === curProject).map(p => ({...p, open: open.get(p.id)}));
      if (J(projects.map(p => [p.id, p.name, p.cards])) !== before) renderTree(); }
  } finally { checking = false; renderSyncInfo(); }
}
setInterval(checkRemote, 15000);
window.addEventListener('focus', () => checkRemote());
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkRemote(); });
if (syncChannel) syncChannel.onmessage = e => { const d = e.data || {}; if (d.from !== WINDOW_ID && d.pid === curProject) checkRemote(); };
window.addEventListener('beforeunload', e => { if (sync.closed) return; if (sync.dirty && !sync.paused){ writeState(); } if (sync.paused){ e.preventDefault(); e.returnValue = ''; } });
function renderSyncInfo(){
  const el = $('#syncInfo'); if (!el) return;
  const t = ts => ts ? new Date(ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '';
  el.innerHTML = sync.state === 'conflict' ? '<span style="color:var(--warn)">⚠ Edited in two places - choose what to keep</span> <button class="btn sm" id="btnReopenSync">Resolve…</button>'
    : sync.state === 'offline' ? '<span style="color:var(--warn)">📡 Offline - saved on this device</span>'
    : sync.state === 'error' ? (sync.kept ? '<span style="color:var(--bad)">⚠ Not in your account yet - kept on this device, retrying</span>' : '<span style="color:var(--bad)">⚠ Not saved - retrying on the next change</span>')
    : sync.dirty ? '● Saving…' : `✓ Saved ${t(sync.saved) || 'and in sync'}${sync.merged ? ` · ${esc(sync.note)} ${t(sync.merged)}` : ''}`;
  const b = $('#btnReopenSync'); if (b) b.onclick = () => resolverReopen && resolverReopen();
}
/* ---- conflict resolver */
let resolverReopen = null;
const CF_LABEL = {why: 'Why this card', whyOnCard: 'Why on card', whyAll: 'Why on every card', front: 'Front', back: 'Back', text: 'Text', extra: 'Extra', source: 'Source', tags: 'Tags', status: 'Status', feedback: 'Feedback', deck: 'Sub-deck', refs: 'Source location', skipped_checks: 'Checks skipped by AI', type: 'Card type', ord: 'Study position', edited: 'Field-edited', revised: 'Revised', prev: 'Previous version', projectName: 'Project name', generalFeedback: 'General feedback'};
const cfShow = v => { const s3 = v === undefined || v === null ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v); return esc(s3.length > 700 ? s3.slice(0, 700) + '…' : s3); };
function openResolver(conflicts, merged, local, remote, finish){
  const dlg2 = $('#syncDlg'), list = $('#syncList');
  const title = c => { const card = (local.cards || []).find(x => x.id === c.id) || (remote.cards || []).find(x => x.id === c.id) || c.card || {}; return esc(cardTitle(normCard(card)).slice(0, 90)); };
  let k = 0;
  list.innerHTML = conflicts.map((c, ci) => {
    if (c.kind === 'field') return `<div class="cf"><div class="cf-h">${esc(CF_LABEL[c.key] || c.key)}</div>${cfPair(ci, 0, c.mine, c.theirs)}</div>`;
    if (c.kind === 'card-del') return `<div class="cf"><div class="cf-h">${esc(c.id)} · ${title(c)}</div><div class="small muted">${c.deletedBy === 'mine' ? 'You deleted this card here, but it was edited elsewhere.' : 'You edited this card here, but it was deleted elsewhere.'}</div>
      <div class="row" style="gap:14px"><label class="check"><input type="radio" name="cf${ci}_0" value="keep" checked> Keep the card</label><label class="check"><input type="radio" name="cf${ci}_0" value="drop"> Delete it</label></div></div>`;
    return `<div class="cf"><div class="cf-h">${esc(c.id)} · ${title(c)}</div>${c.fields.map((f, fi) => `<div class="small" style="margin-top:6px"><b>${esc(CF_LABEL[f.key] || f.key)}</b></div>${cfPair(ci, fi, f.mine, f.theirs)}`).join('')}</div>`;
  }).join('');
  function cfPair(ci, fi, mine, theirs){
    return `<div class="cf-pair"><label class="cf-opt"><input type="radio" name="cf${ci}_${fi}" value="mine" checked><span class="cf-lab">This window</span><pre>${cfShow(mine)}</pre></label>
      <label class="cf-opt"><input type="radio" name="cf${ci}_${fi}" value="theirs"><span class="cf-lab">Saved elsewhere</span><pre>${cfShow(theirs)}</pre></label></div>`;
  }
  $('#syncCount').textContent = `${conflicts.length} item(s) were changed both here and in another window or version. Everything else was merged automatically.`;
  $('#syncMine').onclick = () => list.querySelectorAll('input[value=mine],input[value=keep]').forEach(r => r.checked = true);
  $('#syncTheirs').onclick = () => conflicts.forEach((c, ci) => { if (c.kind === 'card-del'){ const r = list.querySelector(`input[name=cf${ci}_0][value=${c.deletedBy === 'mine' ? 'keep' : 'drop'}]`); if (r) r.checked = true; } else list.querySelectorAll(`input[name^=cf${ci}_][value=theirs]`).forEach(r => r.checked = true); });
  $('#syncApply').onclick = () => {
    const pick = (ci, fi) => (list.querySelector(`input[name=cf${ci}_${fi}]:checked`) || {}).value;
    conflicts.forEach((c, ci) => {
      if (c.kind === 'field'){ if (pick(ci, 0) === 'theirs') merged[c.key] = c.theirs; }
      else if (c.kind === 'card-del'){ if (pick(ci, 0) === 'drop') merged.cards = merged.cards.filter(x => x.id !== c.id); }
      else { const card = merged.cards.find(x => x.id === c.id); if (card) c.fields.forEach((f, fi) => { if (pick(ci, fi) === 'theirs'){ if (f.theirs === undefined) delete card[f.key]; else card[f.key] = f.theirs; } }); }
    });
    dlg2.close(); resolverReopen = null; finish(merged);
  };
  resolverReopen = () => dlg2.showModal();
  dlg2.showModal();
}

/* projects: an index + one state per top-level project (sub-projects live inside it, see TREE) */
let projects = [], curProject = null;
const projName = () => S.projectName || S.deck || 'Untitled';
let saving = Promise.resolve(), saveErrShown = false;
async function writeState(){
  if (!curProject) return;
  const id = curProject; let relabel = false;
  saving = saving.then(async () => {
    if (sync.paused || sync.closed || id !== curProject) return;
    if (accountStatus() !== 'active'){ sync.state = 'error'; renderSyncInfo(); return; }   // read-only: keep the changes in this window only
    const st = snapshot(); st.rev = sync.rev + 1; st.savedAt = Date.now(); st.savedBy = WINDOW_ID;
    sync.dirty = false;
    try {
      let r = await Store.putProject(id, st, sync.rev);
      if (r && r.offline){   // no connection (online version): kept in this browser until it's back, see backOnline
        await keepHere(id, st); sync.state = 'offline'; sync.saved = Date.now();
        const pr = projects.find(x => x.id === id);
        if (pr){ const nm = st.projectName || st.deck || 'Untitled', nc = (st.cards || []).length; if (pr.name !== nm || pr.cards !== nc) relabel = true; pr.name = nm; pr.updated = Date.now(); pr.cards = nc; }
        await saveIndex(); renderSyncInfo(); return;
      }
      if (r && r.deleted) {
        sync.paused = true; sync.dirty = true;
        if (confirm('This project was deleted on another device. Restore it with the edits in this tab?')) {
          r = await Store.putProject(id, st, undefined, undefined, true); sync.paused = false;
          if (!projects.some(p => p.id === id)) projects.push({id, name: st.projectName || st.deck, updated: Date.now()});
        } else if (confirm('Discard this tab’s edits and reload the remaining projects?')) { location.reload(); return; }
        else { sync.state = 'error'; toast('Saving paused. Export this project to keep your edits, or reload to choose another project.', 10000); renderSyncInfo(); return; }
      }
      if (r && r.conflict){ sync.dirty = true; await syncWithRemote('conflict'); return; }
      sync.base = r && r.json ? JSON.parse(r.json) : plain(st); sync.rev = st.rev; sync.saved = Date.now(); sync.state = 'ok';
      // label from what was saved: by now another project may be open
      const pr = projects.find(x => x.id === id);
      if (pr){ const nm = st.projectName || st.deck || 'Untitled', nc = (st.cards || []).length; if (pr.name !== nm || pr.cards !== nc) relabel = true; pr.name = nm; pr.updated = Date.now(); pr.cards = nc; }
      if (sync.kept){ sync.kept = false; await Store.dropPending(id, sync.keptJson); }   // unless another tab kept newer edits meanwhile
      await saveIndex(); saveErrShown = false; retryDelay = 5000;
      try { syncChannel && syncChannel.postMessage({pid: id, rev: st.rev, from: WINDOW_ID}); } catch {}
    } catch (e) { console.error(e); sync.dirty = true; sync.state = 'error'; retrySave();
      // the online version: keep the edits in this browser too, so closing the tab before the retry works loses nothing
      if (Store.hosted && id === curProject) try { await keepHere(id, st); } catch {}
      if (!saveErrShown){ saveErrShown = true; toast('⚠ Could not save: ' + e.message + (Store.hosted ? (navigator.onLine === false ? ' - you are offline; it will save when you are back online' : ' - retrying') : Store.on ? ' - is acs.py still running?' : ''), 5000); } }
    renderSyncInfo();
  });
  await saving;
  if (relabel) renderProjects();   // the sidebar only changes when a name or card count does (it costs ~10 ms per save on a phone otherwise)
}
async function saveIndex(){
  const merged = await Store.putIndex(projects);
  if (Array.isArray(merged)){ const open = new Map(projects.map(p => [p.id, p.open])); projects = merged.map(p => ({...p, open: open.get(p.id)})); }
}
/** keep this window's edits in the browser for the account; another tab's kept edits are merged in and shown here */
async function keepHere(id, st){
  const k = await Store.keepPending(id, st, sync.rev, sync.base, sync.keptPrev || sync.base);
  sync.kept = true; sync.keptJson = k.json;
  if (k.merged && id === curProject){
    const media = {}; for (const [n, b] of Object.entries(k.blobs)) media[n] = {blob: b};
    applyMerged(k.merged, {media}); sync.keptPrev = plain(snapshot());
  } else sync.keptPrev = plain(st);
}
const saveSoon = debounce(writeState, 500);
/* a failed save (offline, server hiccup) tries again by itself: after 5 s, doubling to 2 min, and as soon as the
   device is back online */
let retryTimer = null, retryDelay = 5000;
function retrySave(){
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; if (sync.dirty && sync.state === 'error'){ retryDelay = Math.min(120000, retryDelay * 2); writeState(); } else retryDelay = 5000; }, retryDelay);
}
window.addEventListener('online', () => { if (sync.dirty){ clearTimeout(retryTimer); retryTimer = null; retryDelay = 5000; writeState(); } });
const save = () => { sync.dirty = true; renderSyncInfo(); saveSoon(); };
function loadState(st){
  for (const k of Object.keys(S.media)) dropURL(k);
  Object.assign(S, {deck: 'AI Generated Deck', tags: [], cards: [], media: {}, curId: null, generalFeedback: '', prompt: {}, order: 'source', deckFilter: '', batch: null, projectName: '', filter: 'all', q: '', nodes: [], sources: [], scope: 'root', whyAll: false});
  if (st) Object.assign(S, {deck: st.deck || S.deck, tags: st.tags || [], cards: st.cards || [], media: st.media || {}, curId: st.curId, generalFeedback: st.generalFeedback || '', prompt: st.prompt || {}, order: st.order || 'source',
                            batch: st.batch || null, projectName: st.projectName || '', nodes: st.nodes || [], sources: st.sources || [], scope: st.scope || 'root', whyAll: !!st.whyAll});
  srcCache.clear(); clearSourceDocuments();
  try { const last = curProject && localStorage.getItem('acs-cur:' + curProject); if (last && S.cards.some(c => c.id === last)) S.curId = last; } catch {}
  if (typeof syncTree === 'function') syncTree();
  // what this window last agreed with the store: the base of every 3-way merge
  sync.rev = (st && st.rev) || 0; sync.base = st ? plain(st) : plain(snapshot()); sync.dirty = false; sync.paused = false; sync.state = 'ok';
  sync.kept = false; sync.keptJson = sync.keptPrev = null;
}
/* the admin's controls on this account (online version): disabled = can't use the app, read-only = nothing is saved */
const accountStatus = () => (Store.hosted && Store.user && Store.user.status) || 'active';
function showDisabled(){
  if ($('#offlineScreen')) return;
  const d = document.createElement('div'); d.id = 'offlineScreen';
  d.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px';
  d.innerHTML = `<div class="panel" style="max-width:420px;text-align:center;padding:24px"><div style="font-size:34px">⛔</div><h2 style="margin:8px 0">This account is disabled</h2>
    <p class="small muted">The admin has turned off access for @${esc((Store.user && Store.user.login) || '')}. Your projects are kept; ask the admin to turn access back on.</p>
    <button class="btn" onclick="location.reload()">Try again</button></div>`;
  document.body.appendChild(d);
}
function applyAccountStatus(){
  const st = accountStatus();
  if (st === 'disabled') return showDisabled();
  let b = $('#roBanner');
  if (st === 'readonly' && !b){ b = document.createElement('div'); b.id = 'roBanner';
    b.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:60;background:var(--warn);color:#fff;padding:6px 14px;border-radius:20px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.2)';
    b.textContent = '👁 Read-only: the admin has paused saving for this account. You can look around, but changes are not kept.'; document.body.appendChild(b); }
  if (st !== 'readonly' && b) b.remove();
}
/** a 403 from the server may mean the admin restricted the account while it was open */
async function accountRefused(r){
  if (r.status !== 403 || !Store.hosted) return false;
  const j = await r.clone().json().catch(() => ({}));
  if (!j.readonly && !j.disabled) return false;
  if (Store.user) Store.user.status = j.disabled ? 'disabled' : 'readonly';
  applyAccountStatus(); return true;
}
function showOffline(){
  const d = document.createElement('div'); d.id = 'offlineScreen';
  d.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:24px';
  d.innerHTML = `<div class="panel" style="max-width:420px;text-align:center;padding:24px"><div style="font-size:34px">📡</div><h2 style="margin:8px 0">You're offline</h2>
    <p class="small muted">Card Studio keeps your projects in your account, so it needs a connection to open them. It will load by itself as soon as you're back online.</p>
    <button class="btn" onclick="location.reload()">Try again</button></div>`;
  document.body.appendChild(d);
  window.addEventListener('online', () => location.reload());
}
async function restore(){
  await Store.detect();
  if (accountStatus() === 'disabled'){ showDisabled(); return; }
  if (Store.offline){
    if (!await openOffline()){ showOffline(); return; }
    applyAccountStatus(); renderStorage(); watchConnection(); return;
  }
  applyAccountStatus();
  if (Store.hosted && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (Store.on) await loadSettings();
  projects = await Store.getIndex().catch(() => null) || [];
  if (Store.on && !projects.length) await migrateBrowserProjects(Store.hosted ? undefined : true);
  if (!projects.length && !Store.on){
    const legacy = await idbGet('state');
    projects = [{id: 'p' + Date.now().toString(36), name: (legacy && legacy.deck) || 'Project 1', updated: Date.now()}];
    if (legacy) await idbPut('project:' + projects[0].id, legacy);
    await Store.putIndex(projects);
  }
  if (!projects.length){ projects = [{id: 'p' + Date.now().toString(36), name: 'Project 1', updated: Date.now()}]; await Store.putIndex(projects); }
  try { curProject = localStorage.getItem('acs-current'); } catch {}
  if (!curProject && !Store.on) curProject = await idbGet('currentProject');
  if (!projects.some(x => x.id === curProject)) curProject = [...projects].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0].id;
  setCurrent(curProject);
  loadState(await Store.getProject(curProject));
  await resumePending(curProject);
  renderStorage();
  if (Store.hosted) flushPending();
}
/** the account's settings; ones changed while offline go up instead (this browser had the newest) */
async function loadSettings(){
  let pend = false; try { pend = Store.hosted && localStorage.getItem(Store.offKey('settings-pending')) === '1'; } catch {}
  if (pend){ try { await Store.putSettings(SET); localStorage.removeItem(Store.offKey('settings-pending')); return; } catch {} }
  const ss = await Store.getSettings().catch(() => null);
  if (ss){ SET = mergeSettings(ss); try { localStorage.setItem('acs-settings', JSON.stringify(SET)); } catch {} renderKeyHints(); }
}

/* ---- OFFLINE (online version): open from the copies in this browser, keep edits here, send them when it's back */
/** a project this browser can open without a connection: its last account version, or {} for one made offline */
async function offlineCopy(id){
  const st = await Store.getProject(id); if (st) return st;
  return await Store.getPending(id).catch(() => null) ? {} : null;
}
async function openOffline(){
  projects = await Store.getIndex().catch(() => null) || [];
  const pre = Store.offKey('project:'), can = new Set([...(await idbKeys(pre)).map(k => k.slice(pre.length)), ...await Store.pendingIds()]);
  const here = projects.filter(p => can.has(p.id));
  if (!here.length) return false;
  try { curProject = localStorage.getItem('acs-current'); } catch {}
  if (!here.some(p => p.id === curProject)) curProject = [...here].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0].id;
  setCurrent(curProject);
  loadState(await offlineCopy(curProject));
  await resumePending(curProject);
  sync.state = 'offline';
  return true;
}
/** edits this browser kept while the account couldn't be reached (Store.keepPending): put them back on top of the
    version just loaded, with the account's version they started from as the merge base. The next save sends them; if
    the account moved on meanwhile, its 409 merges them 3-way with those changes (and asks about real clashes). */
async function resumePending(id){
  if (!Store.hosted) return false;
  const p = await Store.getPending(id).catch(() => null); if (!p || id !== curProject) return false;
  const mine = JSON.parse(p.json), media = {}, loaded = sync.base;
  for (const [n, e] of Object.entries(mine.media || {})){
    const b = p.blobs && p.blobs[n], had = S.media[n];
    media[n] = b ? {...e, blob: b} : had && had.blob ? {...e, blob: had.blob} : {...e, remote: true};
  }
  loadState({...mine, media});
  sync.rev = p.baseRev || 0; sync.base = JSON.parse(p.base || 'null') || loaded;
  sync.kept = true; sync.keptJson = p.json; sync.keptPrev = JSON.parse(p.json);
  if (Store.offline) sync.state = 'offline';
  else { sync.dirty = true; saveSoon(); }
  renderSyncInfo();
  return true;
}
/** other projects edited offline: each one whose account version hasn't moved goes up now; the rest wait until they
    are opened (resumePending merges them then) */
let flushing = false;
async function flushPending(){
  if (flushing || !Store.on) return; flushing = true;
  try {
    let sent = 0;
    for (const id of await Store.pendingIds()){
      if (id === curProject || !Store.on) continue;
      const p = await Store.getPending(id); if (!p) continue;
      try {
        const st = JSON.parse(p.json);
        for (const [n, b] of Object.entries(p.blobs || {})) if (st.media && st.media[n]) st.media[n].blob = b;
        Object.assign(st, {rev: (p.baseRev || 0) + 1, savedAt: Date.now(), savedBy: WINDOW_ID});
        const r = await Store.putProject(id, st, p.baseRev || 0);
        if (r && r.ok){ await Store.dropPending(id, p.json); sent++;
          const pr = projects.find(x => x.id === id); if (pr) Object.assign(pr, {name: st.projectName || st.deck || pr.name, cards: (st.cards || []).length, updated: Date.now()}); }
      } catch (e) { console.warn('offline edits of', id, 'not sent yet:', e.message); }
    }
    if (sent){ await saveIndex().catch(() => {}); renderProjects(); }
  } finally { flushing = false; }
}
/** offline: look for the connection every 10 s, and at once when the browser says it's back; then carry on online */
function watchConnection(){
  let busy = false;
  const tryNow = async () => {
    if (busy || !Store.offline) return; busy = true;
    try {
      await Store.detect(); if (Store.offline) return;
      clearInterval(timer); window.removeEventListener('online', tryNow);
      if (!Store.on || !Store.hosted){ location.reload(); return; }
      await backOnline();
    } finally { busy = false; }
  };
  const timer = setInterval(tryNow, 10000); window.addEventListener('online', tryNow);
}
async function backOnline(){
  if (accountStatus() === 'disabled'){ showDisabled(); return; }
  applyAccountStatus(); renderStorage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await loadSettings();
  const mine = curProject && await Store.getPending(curProject);
  sync.state = 'ok';
  if (mine){ toast('Back online - saving the changes made offline', 2600); sync.dirty = true; await writeState(); }
  else { renderSyncInfo(); await checkRemote(); }
  await flushPending();
  if (typeof loadDevices === 'function') loadDevices();
  if (typeof pollJobs === 'function') pollJobs();
}
function setCurrent(id){ curProject = id; try { localStorage.setItem('acs-current', id); } catch {} if (!Store.on) idbPut('currentProject', id);
  if (typeof pollJobs === 'function') setTimeout(pollJobs, 0); }   // the Mac bridge's jobs belong to a project
function renderProjects(){ if (typeof renderTree === 'function') renderTree(); }
let switchToken = 0;
async function switchProject(id, st){
  const token = ++switchToken;
  // fetch first, then switch in one step: while the download runs, the open project and its data must stay a pair
  // (a save or sync check in that gap would otherwise mix one project's cards into another)
  const data = st !== undefined ? st : Store.offline ? await offlineCopy(id) : await Store.getProject(id);
  if (token !== switchToken) return;     // another project was picked meanwhile
  if (data == null && Store.offline){ toast("This project isn't on this device yet - it opens when you're back online", 4000); return; }
  if (sync.dirty) await writeState();   // nothing changed -> nothing to upload
  if (token !== switchToken) return;
  setCurrent(id);
  loadState(data);
  if (st === undefined) await resumePending(id);
  if (Store.offline) sync.state = 'offline';
  refreshAll(); renderSyncInfo();
}
async function newProject(name, st){
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  projects.push({id, name: name || 'New project', updated: Date.now()});
  await switchProject(id, st || {projectName: name || 'New project', deck: name || 'New project'});
  await writeState();
}
function refreshAll(){
  writePrompt(Object.keys(S.prompt || {}).length ? S.prompt : DEFAULT_PROMPT);
  $('#filter').value = 'all'; $('#search').value = '';
  buildPrompt(); $('#exDeck').value = S.deck; $('#genFeedback').value = S.generalFeedback || '';
  updateTabCounts(); renderDeckSummary(); renderProjects();
  const active = ($('#tabs button.active') || {dataset: {}}).dataset.tab || 'prompt';
  showTab(active);
  if (S.cards.length) fetchUrlImages();
}
$('#btnSyncNow').onclick = async () => { await checkRemote(); if (!sync.dirty && sync.state === 'ok') toast('Up to date'); };
$('#syncDlg').addEventListener('cancel', e => e.preventDefault());   // a choice is needed before saving resumes
$('#btnNewProject').onclick = () => { const n = prompt('Name of the new project (also its parent deck):', 'New project'); if (n !== null) newProject(n.trim() || 'New project'); };
$('#btnRenameProject').onclick = () => { const n = prompt('Rename project:', projName()); if (n !== null && n.trim()){ S.projectName = n.trim(); writeState(); } };
$('#btnDeleteProject').onclick = async () => {
  if (Store.offline) return toast('Deleting a project needs a connection', 3000);
  if (!confirm(`Delete the project "${projName()}"? (${S.cards.length} cards)${Store.on ? '\nIt is moved to the trash/ folder inside the data folder.' : '\nUse 💾 Save file first if you want a copy.'}`)) return;
  await Store.delProject(curProject).catch(() => {});
  projects = projects.filter(x => x.id !== curProject); curProject = null;
  if (!projects.length) return newProject('Project 1');
  const next = [...projects].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0].id;
  await Store.putIndex(projects); setCurrent(next);
  loadState(await Store.getProject(next)); refreshAll();
};

