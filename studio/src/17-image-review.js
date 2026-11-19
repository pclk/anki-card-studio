/* ====================================================================== IMAGE REVIEW */
/* Every image the cards show gets a verdict, kept on its media entry (so it syncs with the project):
   m.rv = 'ok' | 'broken', m.rvNote = what's wrong. Broken images are listed on Revise, where Claude is asked to redo
   them. Images written straight into the HTML (data: / http: links) have no entry and are not reviewed. */
// (function declarations: the card filter and tab counts may call these before this part of the script has run)
function imgVerdict(n){ return (S.media[n] && S.media[n].rv) || ''; }
/** image name -> the cards (not excluded) that show it, in card order */
function imageUses(scoped = true){
  const m = new Map();
  for (const c of S.cards){
    if (c.status === 'drop' || (scoped && !inScope(c))) continue;
    for (const n of cardImages(c)) if (mediaState(n) !== 'inline'){ if (!m.has(n)) m.set(n, []); m.get(n).push(c); }
  }
  return m;
}
function cardBrokenImg(c){ return cardImages(c).some(n => imgVerdict(n) === 'broken'); }
function setImgVerdict(n, v, note){
  const m = S.media[n] || (S.media[n] = {origin: 'generated', blob: null, error: null});
  if (v){ m.rv = v; if (v === 'broken' && note) m.rvNote = note; else if (v !== 'broken') delete m.rvNote; }
  else { delete m.rv; delete m.rvNote; }
  save(); updateTabCounts();
}
/** the caption the card shows under this image (its <figcaption>), else the media caption */
function imgCaption(n, c){
  const q = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const f of FIELDS[c.type]){
    const m = new RegExp(`<figure[^>]*>[\\s\\S]*?<img[^>]*src=["']${q}["'][\\s\\S]*?<figcaption[^>]*>([\\s\\S]*?)</figcaption>`, 'i').exec(c[f] || '');
    if (m) return stripHtml(m[1]);
  }
  return (S.media[n] && S.media[n].caption) || '';
}

/* ---- the viewer (Review tab → 🖼 Images): one image at a time, approve or mark broken */
const IR = {list: [], i: 0};
function irBuild(){
  const f = $('#irFilter').value, names = [...imageUses().keys()];
  IR.list = names.filter(n => f === 'all' || (f === 'todo' ? !imgVerdict(n) : imgVerdict(n) === f));
  IR.i = Math.min(IR.i, Math.max(0, IR.list.length - 1));
}
function openImageReview(){
  if (!imageUses().size) return toast('No images on the cards in this sub-deck');
  const any = [...imageUses().keys()].some(n => !imgVerdict(n));
  $('#irFilter').value = any ? 'todo' : 'all'; IR.i = 0; irBuild();
  $('#irDlg').showModal(); irRender();
}
function irRender(){
  const uses = imageUses(), all = [...uses.keys()], ok = all.filter(n => imgVerdict(n) === 'ok').length, bad = all.filter(n => imgVerdict(n) === 'broken').length;
  $('#irProg').innerHTML = `<i style="width:${ok / (all.length || 1) * 100}%;background:var(--ok)"></i><i style="width:${bad / (all.length || 1) * 100}%;background:var(--bad)"></i>`;
  $('#irStats').textContent = `${ok} approved · ${bad} broken · ${all.length - ok - bad} to review`;
  const n = IR.list[IR.i];
  $('#irPos').textContent = IR.list.length ? `${IR.i + 1} / ${IR.list.length}` : '';
  $('#irPrev').disabled = IR.i <= 0; $('#irNext').disabled = IR.i >= IR.list.length - 1;
  ['irOk', 'irBad', 'irReset'].forEach(id => $('#' + id).disabled = !n);
  if (!n){
    $('#irImg').innerHTML = '';
    $('#irSide').innerHTML = `<div class="note ${bad ? 'warn' : 'ok'}">${$('#irFilter').value === 'todo' ? 'Every image has been reviewed.' : 'No images here.'}${bad ? ` ${bad} marked broken - fix them on <a href="#" id="irToRevise">Revise</a>.` : ''}</div>`;
    const tr = $('#irToRevise'); if (tr) tr.onclick = e => { e.preventDefault(); $('#irDlg').close(); showTab('revise'); };
    return;
  }
  const st = mediaState(n), m = S.media[n] || {}, cards = uses.get(n) || [], v = imgVerdict(n);
  $('#irImg').innerHTML = st === 'ok' ? `<img src="${mediaURL(n)}" alt="${esc(n)}">` : `<img src="${MISSING_SVG(n, st)}" alt="">`;
  const cap = imgCaption(n, cards[0]);
  $('#irSide').innerHTML = `<div class="row" style="gap:6px;flex-wrap:wrap"><code style="word-break:break-all">${esc(n)}</code>
      ${v ? `<span class="pill ${v === 'ok' ? 'ok' : 'bad'}">${v === 'ok' ? 'approved' : 'broken'}</span>` : '<span class="pill">not reviewed</span>'}
      ${st !== 'ok' ? `<span class="pill warn">${{snip: 'snip needed', loading: 'downloading', failed: 'download failed', missing: 'missing'}[st] || st}</span>` : ''}</div>
    ${cap ? `<div><span class="muted small">Caption</span><div>${esc(cap)}</div></div>` : ''}
    <div class="small muted">${esc(m.origin || '')}${m.credit ? ' · ' + esc(m.credit) : ''}${m.url ? ` · <a href="${esc(m.url)}" target="_blank" rel="noopener">source link</a>` : ''}${m.hint ? '<br>' + esc(m.hint) : ''}</div>
    <div><span class="muted small">On ${cards.length} card${cards.length === 1 ? '' : 's'}</span>
      <div class="ir-cards">${cards.map(c => `<button class="ir-card" data-id="${esc(c.id)}" title="Open this card"><b>${esc(c.id)}</b> ${esc(cardTitle(c).slice(0, 120))}</button>`).join('')}</div></div>`;
  $('#irNote').value = m.rvNote || '';
}
function irGo(d){ IR.i = Math.max(0, Math.min(IR.list.length - 1, IR.i + d)); irRender(); }
function irDecide(v){
  const n = IR.list[IR.i]; if (!n) return;
  setImgVerdict(n, v, $('#irNote').value.trim());
  const f = $('#irFilter').value;
  // in a filtered view the decided image leaves the list; otherwise move on to the next one
  if (f !== 'all' && imgVerdict(n) !== f){ IR.list.splice(IR.i, 1); IR.i = Math.min(IR.i, Math.max(0, IR.list.length - 1)); }
  else if (v) IR.i = Math.min(IR.i + 1, IR.list.length - 1);
  irRender();
  if (v === 'broken') toast('Marked broken - it is listed on Revise');
}
$('#btnImgReview').onclick = openImageReview; $('#hudImgs').onclick = openImageReview;
$('#irFilter').onchange = () => { IR.i = 0; irBuild(); irRender(); };
$('#irPrev').onclick = () => irGo(-1); $('#irNext').onclick = () => irGo(1);
$('#irOk').onclick = () => irDecide('ok'); $('#irBad').onclick = () => irDecide('broken'); $('#irReset').onclick = () => irDecide('');
$('#irClose').onclick = () => $('#irDlg').close();
$('#irDlg').addEventListener('close', () => { if ($('#tab-review').classList.contains('active')) renderReview(); });
// a note on an image already marked broken is kept as you type
$('#irNote').oninput = () => { const n = IR.list[IR.i]; if (n && imgVerdict(n) === 'broken'){ S.media[n].rvNote = $('#irNote').value.trim(); save(); } };
$('#irSide').addEventListener('click', e => {
  const b = e.target.closest('.ir-card'); if (!b) return;
  S.curId = b.dataset.id; if (S.filter !== 'all' && !filtered().some(c => c.id === S.curId)){ S.filter = 'all'; $('#filter').value = 'all'; }
  $('#irDlg').close(); showTab('review');
});
$('#irDlg').addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input,textarea,select')){ if (e.key === 'Enter' && e.target.id === 'irNote' && !e.shiftKey){ e.preventDefault(); irDecide('broken'); } return; }
  const k = e.key;
  if (k === 'ArrowRight' || keyMatches('next', k)) irGo(1);
  else if (k === 'ArrowLeft' || keyMatches('prev', k)) irGo(-1);
  else if (keyMatches('approve', k)) irDecide('ok');
  else if (keyMatches('exclude', k)) irDecide('broken');
  else if (keyMatches('reset', k)) irDecide('');
  else if (keyMatches('change', k)){ e.preventDefault(); $('#irNote').focus(); }
  else return;
  e.preventDefault();
});
// swipe on phones: → approve, ← broken (same directions as cards)
(() => {
  let x0 = null, y0 = 0;
  const box = $('#irImg');
  box.addEventListener('touchstart', e => { if (e.touches.length === 1){ x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, {passive: true});
  box.addEventListener('touchend', e => {
    if (x0 === null) return; const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) irDecide(dx > 0 ? 'ok' : 'broken');
  });
})();

/* ---- Revise: broken images → a prompt asking Claude to redo them, answered with anki_revision.json */
function brokenImages(){
  const uses = imageUses(false);
  return [...uses.entries()].filter(([n]) => imgVerdict(n) === 'broken').map(([n, cards]) => ({name: n, cards, note: S.media[n].rvNote || ''}));
}
function renderBrokenImages(){
  if (!$('#biPanel')) return;
  const list = brokenImages();
  $('#biPanel').hidden = !list.length;
  if (!list.length) return;
  const nc = new Set(list.flatMap(b => b.cards.map(c => c.id))).size;
  $('#biStats').textContent = `${list.length} image${list.length === 1 ? '' : 's'} on ${nc} card${nc === 1 ? '' : 's'}`;
  $('#biList').innerHTML = list.map(b => {
    const st = mediaState(b.name);
    return `<div class="imgrow" data-name="${esc(b.name)}">${st === 'ok' ? `<img src="${mediaURL(b.name)}" alt="">` : '<div class="ph">⚠</div>'}
      <div class="meta"><code>${esc(b.name)}</code> <span class="muted">· ${b.cards.map(c => esc(c.id)).join(', ')}</span>
        <input type="text" class="bi-note" placeholder="What's wrong? (helps Claude redo it)" value="${esc(b.note)}"></div>
      <div class="stack" style="gap:4px"><button class="btn sm" data-act="ok" title="It's fine after all">✓ Fine</button></div></div>`;
  }).join('');
}
$('#biList').addEventListener('input', e => {
  const i = e.target.closest('.bi-note'); if (!i) return;
  const n = i.closest('.imgrow').dataset.name; if (S.media[n]){ S.media[n].rvNote = i.value.trim(); save(); }
});
$('#biList').addEventListener('click', e => {
  const b = e.target.closest('button[data-act="ok"]'); if (!b) return;
  setImgVerdict(b.closest('.imgrow').dataset.name, 'ok'); renderBrokenImages(); $('#biOut').value = '';
});
/** the stored source pages the cards' refs point at (to re-snip from): [{src, pages: [n…]}] */
function refSourceList(cards){
  const m = new Map();
  for (const c of cards) for (const r of c.refs || []){ const src = r && r.page && findSource(r.file); if (src){ if (!m.has(src)) m.set(src, new Set()); m.get(src).add(r.page); } }
  return [...m].map(([src, pages]) => ({src, pages: [...pages]}));
}
const imageFixAttachments = () => planAttachments(refSourceList(brokenImages().flatMap(b => b.cards)));
async function imageFixPrompt(){
  const list = brokenImages(); if (!list.length) return '';
  const cards = ordered([...new Map(list.flatMap(b => b.cards).map(c => [c.id, c])).values()], S.order || 'source');
  const why = c => list.filter(b => b.cards.includes(c)).map(b => `${b.name}${b.note ? ` (${b.note})` : ''}`);
  const media = list.map(b => { const m = S.media[b.name], e = {filename: b.name, origin: m.origin, broken: true};
    for (const k of ['url', 'hint', 'caption', 'credit']) if (m[k]) e[k] = m[k]; if (b.note) e.problem = b.note; return e; });
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), media,
    cards: cards.map(c => ({...cardForAI(c, false), feedback: `Image fix - redo the broken image(s): ${why(c).join('; ')}. Change nothing else on this card.`}))};
  const rb = idBlock('REVISE_CARDS', 'r', JSON.stringify(block, null, 1)), atts = imageFixAttachments();
  const rules = `These images are **broken** (I reviewed every image; my note says what's wrong, when I wrote one). Redo each one properly:
- Work out what the image is meant to show from the card (question, answer, caption) and the material, then make a correct, legible replacement: redraw a diagram or chart (labels readable, nothing overlapping or cut off, no boxes for missing glyphs), re-snip the right region of the source page, or find a better image from a reliable source (with its credit).
- Give every replacement a **NEW filename** and point the card's <img> at it. Keep the <figure>/<figcaption> and fix the caption only if it was wrong too.
- Change nothing else: not what the card tests, its answer, its "why", its tags or its status. Do not delete, merge or split cards.
- If an image is better left out (it adds nothing to the card), remove it from the card and say so.
- Then list each card in one line: which image you replaced and what was wrong.`;
  return (promptMode() === 'skill'
    ? `${skillGetSection()}Use the **anki** skill's revision workflow to redo the broken images on these Anki cards. Load them with \`Deck.load("${rb.id}")\`. Check each new image (\`contact_sheet()\`, \`preview_png()\`), run \`deck.validate()\`, then \`deck.save(revision=True)\` and give me **anki_revision.json** (it carries the new images).\n\n${rules}`
    : `Please redo the broken images on these Anki cards. If you have code execution, ${helperFromWeb() ? helperAgain() : 'load anki_helper.py'}, \`deck = Deck.load("${rb.id}")\` (it reads the REVISE_CARDS block with that id from this prompt saved as a file (an attachment, the working folder or Downloads), so never retype the block; if it is not found, ask me to send the prompt as a file), make the new images with it (deck.figure, deck.add_image_file, deck.web_image …), deck.update(...) the cards, check them with deck.contact_sheet() and deck.validate(), then \`deck.save(revision=True)\` and give me **anki_revision.json** as a download. Otherwise output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block with "revision": true, with each new image in "media" (filename, and base64 "data" or a direct "url").\n\n${rules}`)
    + (atts.length ? `\n\n${await materialSection(atts, [])}` : '') + `\n\n${rb.text}`;
}
$('#biBuild').onclick = async () => { $('#biOut').value = await imageFixPrompt(); };
$('#biCopy').onclick = async () => {
  if (!$('#biOut').value) $('#biOut').value = await imageFixPrompt();
  if (!$('#biOut').value) return;
  await copyPrompt($('#biOut').value);
  // the pages the cards come from go with it, so Claude can re-snip figures from the original
  const atts = imageFixAttachments();
  if (atts.length && await downloadAttachments(atts)) toast(`Prompt copied + downloaded ${attachNames(atts)} - attach ${atts.length > 1 ? 'them' : 'it'} and paste the prompt`, 5000);
};
