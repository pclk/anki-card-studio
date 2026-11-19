/* ====================================================================== IMPORT / PARSE */
function lenientJSON(s){
  s = s.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch (e1) {
    const fixed = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed); } catch { throw e1; }
  }
}
function extractBundles(text){
  const blocks = [];
  for (const m of text.matchAll(/<<<(?:ANKI|REVISE)_CARDS(?:[ \t]+id=\S+)?([\s\S]*?)(?:ANKI|REVISE)_CARDS>>>/g)) if (/"cards"\s*:/.test(m[1])) blocks.push(m[1]);
  if (!blocks.length) for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) if (/"cards"\s*:/.test(m[1])) blocks.push(m[1]);
  if (!blocks.length){ const i = text.indexOf('{'), j = text.lastIndexOf('}'); if (i >= 0 && j > i) blocks.push(text.slice(i, j + 1)); }
  const out = [], errors = [];
  blocks.forEach((b, i) => {
    try { let d = lenientJSON(b); if (Array.isArray(d)) d = {cards: d}; out.push(d); }
    catch (e) { errors.push(`Block ${i + 1}: ${e.message}`); }
  });
  return {bundles: out, errors};
}
/** Apply a bundle. mode: 'merge' | 'replace'. Returns summary. */
function applyBundle(d, mode, opts = {}){
  const sum = {added: 0, updated: 0, deleted: 0, media: 0, deck: d.deck || '', recheck: 0, fmtSame: 0, fmtUpd: 0, na: [], outside: []};
  // opts.queueOnly (a reply to global-revision prompts): it may change only cards waiting in a prompt, and add only the
  // parts of a card it split; anything else in it is left out and listed
  const outside = (raw, c) => { if (!opts.queueOnly || (c && c.fmt)) return false; if (!c && raw.after && cardById(raw.after) && (cardById(raw.after).fmt || cardById(raw.after).fmtDone)) return false;
    sum.outside.push(String(raw.id || '(new card)')); return true; };
  const fmtSeen = new Set();   // global-revision prompts this reply answers
  const isProject = d.format === PROJECT_FORMAT;
  const isRevision = !!(opts.revision || d.revision);
  if (mode === 'replace'){ S.cards = []; for (const k of Object.keys(S.media)) dropURL(k); S.media = {}; }
  if (d.deck && (mode === 'replace' || !S.cards.length) && !(S.batch && S.batch.items && S.batch.items.length && !isProject)) S.deck = d.deck;
  // a sub-deck (e.g. one lecture of a batch); a revision never moves cards between decks
  const bundleDeck = !isRevision && d.deck && d.deck !== S.deck ? d.deck : null;
  const idMap = {};
  if (Array.isArray(d.tags) && d.tags.length) S.tags = d.tags;
  for (const m of d.media || []){
    if (!m || !m.filename) continue;
    const name = m.filename, prev = S.media[name];
    const meta = {origin: m.origin || (m.url ? 'url' : m.hint ? 'material' : 'generated')};
    for (const k of ['url','hint','caption','credit', ...(isProject ? ['rv', 'rvNote'] : [])]) if (m[k]) meta[k] = m[k];
    if (m.data){ setMediaBlob(name, b64ToBlob(m.data, m.mime || MIME[extOf(name)] || 'image/png'), meta, !isProject); sum.media++; }
    else if (prev && (prev.blob || prev.remote) && !(meta.origin === 'url' && meta.url && meta.url !== prev.url)) { /* keep existing image */ }
    else { dropURL(name); S.media[name] = Object.assign({}, meta, {blob: null, error: null}); }
  }
  for (const raw of d.cards || []){
    if (!raw) continue;
    // a global revision that doesn't fit a card: the AI leaves it as it was and says why
    if (typeof raw.not_applicable === 'string' && raw.id){ const c = cardById(raw.id);
      if (c && isRevision){ if (c.fmt){ fmtSeen.add(c.fmt); fmtFinish(c); sum.fmtSame++; } c.fmtNA = raw.not_applicable.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no reason given'; sum.na.push({id: c.id, reason: c.fmtNA}); }
      continue; }
    if (raw.delete){ const c = cardById(raw.id); if (c && outside(raw, c)) continue;
      // a checker fix never removes cards; a global revision only when it was allowed to
      if (c && isRevision && c.fmt && !opts.keepStatus && !(c.fmtTask && c.fmtTask.del)){ fmtSeen.add(c.fmt); fmtFinish(c); sum.fmtSame++; continue; }
      if (c && isRevision && c.fmt && !opts.keepStatus){ fmtSeen.add(c.fmt); fmtFinish(c); delete c.recheck; }
      if (c){ c.status = 'drop'; c.revised = true; sum.deleted++; } continue; }
    const n = normCard(raw);
    if (!n.deck && bundleDeck) n.deck = bundleDeck;
    const origId = n.id;
    if (raw.after && n.id && cardById(n.id) && n.id !== raw.after) n.id = null;   // "new" card whose id collides -> renumber
    // a different bundle (other lecture / sub-deck) reusing ids like c001 -> keep both, prefix the newcomer
    if (!isProject && !isRevision && n.id && cardById(n.id) && cardDeck(cardById(n.id)) !== (n.deck || S.deck)){
      const pre = (n.deck || 'b').split('::').pop().replace(/[^A-Za-z0-9]+/g, '').slice(0, 12) || 'b';
      let nid2 = `${pre}-${n.id}`, k = 2; while (cardById(nid2)) nid2 = `${pre}${k++}-${n.id}`;
      n.id = nid2;
    }
    const existing = n.id && cardById(n.id);
    if (outside(raw, existing)) continue;
    if (existing){
      // opts.keepStatus (an Assistant reply the user applied): the same, for any card it changes
      if (!isProject && isRevision && (existing.fmt || opts.keepStatus)){
        // formatting pass: the card keeps its review status. If it was approved and really changed, it waits for a
        // quick re-check (with a diff); if the AI sent it back unchanged, nothing happens.
        if (!opts.keepStatus){ fmtSeen.add(existing.fmt); fmtFinish(existing); }
        // a checker fix may change only the "why" or the source references, so those count as changes too
        const same = n.type === existing.type && FIELDS[existing.type].every(f => (n[f] || '') === (existing[f] || ''))
          && (n.why || '') === (existing.why || '') && J(n.refs || []) === J(existing.refs || [])
          && (!('skipped_checks' in n) || J(n.skipped_checks) === J(existing.skipped_checks || {}));
        if (same){ sum.fmtSame++; continue; }
        existing.prev = {type: existing.type, ...Object.fromEntries(FIELDS[existing.type].map(f => [f, existing[f]])), why: existing.why || '', refs: existing.refs || [], skipped_checks: existing.skipped_checks || {}, feedback: opts.keepStatus ? opts.note || '' : existing.fmtTask && existing.fmtTask.instr ? 'Global revision: ' + existing.fmtTask.instr : ''};
        existing.revised = true; existing.edited = false; delete existing.fmtNA;
        sum.fmtUpd++; if (existing.status === 'ok'){ existing.recheck = true; sum.recheck++; }
        // keep the review state and any feedback the user already wrote
        for (const k of ['status', 'feedback', 'time', 'ord', 'deck']) if (existing[k] !== undefined) delete n[k];
      } else if (!isProject){
        delete existing.fmtNA;
        existing.prev = {type: existing.type, ...Object.fromEntries(FIELDS[existing.type].map(f => [f, existing[f]])), why: existing.why || '', refs: existing.refs || [], skipped_checks: existing.skipped_checks || {}, feedback: existing.feedback || ''};
        existing.revised = true; existing.edited = false; existing.status = 'new'; existing.feedback = '';
      }
      Object.assign(existing, n);
      if (existing.skipped_checks && !Object.keys(existing.skipped_checks).length) delete existing.skipped_checks;
      if (isProject) Object.assign(existing, pickStatus(raw));
      sum.updated++;
    } else {
      if (n.skipped_checks && !Object.keys(n.skipped_checks).length) delete n.skipped_checks;
      if (!n.id) n.id = nextId();
      if (origId) idMap[origId] = n.id;
      const card = Object.assign(n, {status: 'new', feedback: '', revised: !!opts.revision}, isProject ? pickStatus(raw) : {});
      const after = raw.after && cardById(raw.after);
      if (after){ let i = S.cards.indexOf(after) + 1; while (i < S.cards.length && S.cards[i].after === raw.after) i++; card.after = raw.after; S.cards.splice(i, 0, card);
        if (!card.deck && after.deck) card.deck = after.deck; }   // a split card stays in its original's deck
      else S.cards.push(card);
      if (after && typeof after.ord === 'number' && typeof card.ord !== 'number') card.ord = after.ord + 0.01;
      sum.added++;
    }
    if (origId && !idMap[origId]) idMap[origId] = n.id || origId;
  }
  // anti-spoiler order chosen by the AI: "order": [ids...] -> per-card ord (offset so batches stay grouped by bundle)
  if (Array.isArray(d.order) && d.order.length){
    const base = Math.max(0, ...S.cards.filter(c => typeof c.ord === 'number' && !d.order.some(i => (idMap[i] || i) === c.id)).map(c => Math.floor(c.ord / 100000) + 1)) * 100000;
    d.order.forEach((id, i) => { const c = cardById(idMap[id] || id); if (c) c.ord = base + i; });
    sum.ordered = d.order.length;
  }
  // cards of an answered formatting batch that the reply left out were fine as they were
  if (fmtSeen.size) for (const c of S.cards) if (c.fmt && fmtSeen.has(c.fmt)){ fmtFinish(c); sum.fmtSame++; }
  if (!isProject && !isRevision) markBatch(d, sum, idMap);
  syncTree();
  return sum;
}
const pickStatus = r => ({status: r.status || 'new', feedback: r.feedback || '', revised: !!r.revised, edited: !!r.edited, prev: r.prev || null, ...(r.recheck ? {recheck: true} : {}), ...(r.fmt ? {fmt: r.fmt, fmtSt: r.fmtSt || 'todo', ...(r.fmtJob ? {fmtJob: r.fmtJob} : {})} : {}), ...(Array.isArray(r.fmtRules) ? {fmtRules: r.fmtRules.map(String)} : {}), ...(r.fmtTask && typeof r.fmtTask.instr === 'string' ? {fmtTask: {instr: r.fmtTask.instr, mode: r.fmtTask.mode === 'format' ? 'format' : 'content', split: !!r.fmtTask.split, del: !!r.fmtTask.del}} : {}), ...(typeof r.fmtNA === 'string' ? {fmtNA: r.fmtNA} : {}), ...(r.fmtDone ? {fmtDone: r.fmtDone} : {}), time: r.time || 0, ...(typeof r.ord === 'number' ? {ord: r.ord} : {})});

async function importFiles(files, mode, opts = {}){
  const sums = []; let imgs = 0; const errors = [];
  const handleJSONText = (txt, name) => {
    const {bundles, errors: e} = extractBundles(txt);
    e.forEach(x => errors.push(`${name}: ${x}`));
    for (const b of bundles){ sums.push(applyBundle(b, mode, opts)); mode = 'merge'; }
  };
  const handleImage = (blob, name) => { const fn = name.split('/').pop(); setMediaBlob(fn, blob, {origin: (S.media[fn] || {}).origin || 'upload'}); imgs++; };
  for (const f of files){
    const ext = extOf(f.name);
    if (ext === 'json' || ext === 'txt') handleJSONText(await f.text(), f.name);
    else if (ext === 'zip'){
      if (!window.JSZip){ errors.push('JSZip did not load (offline?)'); continue; }
      const z = await JSZip.loadAsync(f);
      for (const e of Object.values(z.files)){
        if (e.dir) continue; const ee = extOf(e.name);
        if (ee === 'json') handleJSONText(await e.async('string'), e.name);
        else if (MIME[ee]) handleImage(new Blob([await e.async('uint8array')], {type: MIME[ee]}), e.name);
      }
    } else if (f.type.startsWith('image/') || MIME[ext]) handleImage(f, f.name);
    else errors.push(`${f.name}: unsupported file type`);
  }
  return {sums, imgs, errors};
}
function summarize({sums, imgs, errors}){
  const t = sums.reduce((a, s) => ({added: a.added + s.added, updated: a.updated + s.updated, deleted: a.deleted + s.deleted, media: a.media + s.media, recheck: a.recheck + (s.recheck || 0), fmtSame: a.fmtSame + (s.fmtSame || 0), fmtUpd: a.fmtUpd + (s.fmtUpd || 0), na: a.na.concat(s.na || []), outside: a.outside.concat(s.outside || [])}), {added: 0, updated: 0, deleted: 0, media: 0, recheck: 0, fmtSame: 0, fmtUpd: 0, na: [], outside: []});
  const parts = [];
  if (t.added) parts.push(`${t.added} new card${t.added > 1 ? 's' : ''}`);
  if (t.updated) parts.push(`${t.updated} updated`);
  if (t.deleted) parts.push(`${t.deleted} deleted`);
  if (t.media + imgs) parts.push(`${t.media + imgs} image${t.media + imgs > 1 ? 's' : ''}`);
  let html = '';
  if (parts.length) html += `<div class="note ok">Imported ${parts.join(', ')}.</div>`;
  else if (!errors.length && !t.fmtSame && !t.na.length && !t.outside.length) html += `<div class="note warn">Nothing found to import.</div>`;
  if (t.recheck || t.fmtSame) html += `<div class="note" style="margin-top:6px">Global revision: ${t.recheck} approved card${t.recheck === 1 ? '' : 's'} changed and wait${t.recheck === 1 ? 's' : ''} for a re-check (Review → filter <i>Re-check</i>)${t.fmtSame ? `; ${t.fmtSame} needed no change` : ''}.</div>`;
  if (t.outside.length) html += `<div class="note warn" style="margin-top:6px">Left out ${t.outside.length} card${t.outside.length === 1 ? '' : 's'} the reply changed that ${t.outside.length === 1 ? "isn't" : "aren't"} in a waiting prompt: ${esc(t.outside.slice(0, 12).join(', '))}${t.outside.length > 12 ? ' …' : ''}. Revise ${t.outside.length === 1 ? 'it' : 'them'} from <i>Ask Claude for changes</i> instead.</div>`;
  if (t.na.length) html += `<div class="note" style="margin-top:6px">Left as is - the instruction didn't apply to ${t.na.length} card${t.na.length === 1 ? '' : 's'}:<div class="small" style="margin-top:4px">${t.na.slice(0, 12).map(x => `<b>${esc(x.id)}</b>: ${esc(x.reason)}`).join('<br>')}${t.na.length > 12 ? '<br>…' : ''}</div></div>`;
  if (!parts.length && (t.fmtSame || t.na.length || t.outside.length) && !errors.length) return {html, ok: true, recheck: 0, plain: 0};
  if (errors.length) html += `<div class="note bad" style="margin-top:6px"><b>Problems:</b><br>${errors.map(esc).join('<br>')}<br><span class="small">If the reply was cut off, ask Claude to "continue the JSON" or to save the bundle file instead.</span></div>`;
  const missing = Object.entries(S.media).filter(([n, m]) => !m.blob && !m.remote && m.origin === 'generated').map(([n]) => n);
  if (missing.length) html += `<div class="note warn" style="margin-top:6px">${missing.length} generated image(s) are referenced but not loaded yet (${esc(missing.slice(0, 4).join(', '))}${missing.length > 4 ? '…' : ''}). Drop <b>anki_bundle.json</b> (or the image files) to add them.</div>`;
  return {html, ok: parts.length > 0, recheck: t.recheck, plain: t.added + t.deleted + t.updated - t.fmtUpd};
}
async function afterImport(){
  if (!S.curId || !cardById(S.curId)) S.curId = (S.cards.find(c => c.status === 'new') || S.cards[0] || {}).id || null;
  $('#exDeck').value = S.deck;
  save(); updateTabCounts(); renderDeckSummary();
  fetchUrlImages();
}
function wireDrop(zone, input, handler){
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files.length) handler([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) handler([...e.dataTransfer.files]); });
}
wireDrop($('#importDrop'), $('#importFile'), async files => {
  const r = await importFiles(files, $('#importMode').value);
  $('#importMode').value = 'merge';
  const s = summarize(r); $('#importResult').innerHTML = s.html; await afterImport();
});
$('#btnImport').onclick = async () => {
  const txt = $('#importText').value.trim();
  let r = {sums: [], imgs: 0, errors: []};
  if (txt){
    const {bundles, errors} = extractBundles(txt); r.errors = errors;
    let mode = $('#importMode').value;
    for (const b of bundles){ r.sums.push(applyBundle(b, mode)); mode = 'merge'; }
    $('#importMode').value = 'merge';
  }
  const s = summarize(r); $('#importResult').innerHTML = s.html;
  await afterImport();
  if (s.ok){ $('#importText').value = ''; showTab('review'); }
};
function renderDeckSummary(){
  const c = S.cards, by = k => c.filter(x => x.status === k).length;
  const imgs = Object.keys(S.media).length, missing = Object.values(S.media).filter(m => !m.blob && !m.remote).length;
  $('#deckSummary').innerHTML = c.length ? `
    <div><b>${esc(S.deck)}</b></div>
    <div class="row small"><span class="pill">${c.length} cards</span><span class="pill">${c.filter(x => x.type === 'basic').length} basic</span><span class="pill">${c.filter(x => x.type === 'cloze').length} cloze</span>
    <span class="pill ok">${by('ok')} approved</span><span class="pill warn">${by('change')} change</span><span class="pill bad">${by('drop')} excluded</span></div>
    <div class="small">${imgs} images${missing ? `, <span style="color:var(--warn)">${missing} still missing</span>` : ''}</div>
    <div class="row"><button class="btn sm" onclick="showTab('review')">Open review →</button><button class="btn sm bad" id="btnClearDeck">Clear deck</button></div>`
    : '<div class="muted">Empty - nothing imported yet.</div>';
  const cl = $('#btnClearDeck'); if (cl) cl.onclick = () => { if (confirm('Remove all cards and images from this browser? (Save the project first if you want to keep it.)')){ S.cards = []; for (const k of Object.keys(S.media)) dropURL(k); S.media = {}; S.curId = null; save(); updateTabCounts(); renderDeckSummary(); } };
}

/* ---------------------------------------------------------------------- URL images (Wikimedia aware) */
function commonsTitle(url){
  try {
    const u = new URL(url);
    if (!/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/.test(u.hostname)) return null;
    let m = u.pathname.match(/Special:FilePath\/(.+)$/i) || u.pathname.match(/\/wiki\/(?:File|Image):(.+)$/i);
    if (m) return decodeURIComponent(m[1]).replace(/_/g, ' ');
    return null;
  } catch { return null; }
}
async function fetchImageFromUrl(url, width = 1000){
  const title = commonsTitle(url);
  if (title){
    const w = (new URL(url).searchParams.get('width')) || width;
    const api = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent('File:' + title)}&prop=imageinfo&iiprop=url|mime&iiurlwidth=${w}&format=json&origin=*`;
    const j = await (await fetch(api)).json();
    const page = Object.values(j.query?.pages || {})[0];
    const ii = page && page.imageinfo && page.imageinfo[0];
    if (!ii) throw new Error(`"${title}" does not exist on Wikimedia Commons`);
    url = ii.thumburl || ii.url;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`not an image (${blob.type || 'unknown type'})`);
  return blob;
}
async function fetchUrlImages(){
  const todo = Object.entries(S.media).filter(([, m]) => m.origin === 'url' && m.url && !m.blob && !m.remote && !m.error);
  await Promise.all(todo.map(async ([name, m]) => {
    try { const b = await fetchImageFromUrl(m.url); setMediaBlob(name, b, {}, false); }
    catch (e) { m.error = (e && e.message) || 'download blocked'; if (/Failed to fetch|NetworkError|Load failed/i.test(m.error)) m.error = 'download blocked by the site (CORS) or offline'; }
    if ($('#tab-review').classList.contains('active')) renderReview();
  }));
  if (todo.length){ save(); renderDeckSummary(); }
}

