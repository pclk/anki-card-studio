/* ====================================================================== SOURCE PICTURE in each card's Source */
/** refs from the card, or parsed from free-text Source like "lecture3.pdf p.12" */
function cardRefs(c){
  if (c.refs && c.refs.length) return c.refs;
  const m = /([^\s,;()]+\.(?:pdf|pptx?|docx|md|txt|html?))\D{0,12}?(?:p|pp|page|pg|slide|section)\.?\s*(\d+)/i.exec(stripHtml(c.source || ''));
  return m ? [{file: m[1], page: +m[2]}] : [];
}
const normTxt = s3 => String(s3).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9]+/g, ' ').trim();
const pendingSourceDocuments = new Map();
async function srcDoc(src){
  if (srcDocCache.has(src.id)) return srcDocCache.get(src.id);
  const project = curProject, generation = srcDocGeneration;
  const key = JSON.stringify([project, generation, src.id]);
  if (pendingSourceDocuments.has(key)) return pendingSourceDocuments.get(key);
  const load = (async () => {
    const bl = await Store.getSourceBlob(project, src.id, src.ext); if (!bl || !window.pdfjsLib) return null;
    const doc = await pdfjsLib.getDocument({data: new Uint8Array(await bl.arrayBuffer())}).promise;
    if (project !== curProject || generation !== srcDocGeneration || !S.sources.some(x => x.id === src.id)){
      await doc.destroy(); return null;
    }
    srcDocCache.set(src.id, doc); return doc;
  })();
  pendingSourceDocuments.set(key, load);
  try { return await load; } finally { pendingSourceDocuments.delete(key); }
}
/** find the quote on a PDF page -> bbox in viewport pixels (whole quote, then its first / last words) */
async function findQuote(page, vp, quote){
  if (!quote) return null;
  const tc = await page.getTextContent();
  let flat = ''; const owner = [];
  tc.items.forEach((it, i) => { const t = normTxt(it.str); if (!t) return; if (flat){ flat += ' '; owner.push(-1); } for (const ch of t){ flat += ch; owner.push(i); } });
  const words = normTxt(quote).split(' ').filter(Boolean);
  const tries = [words.join(' '), words.slice(0, 7).join(' '), words.slice(-7).join(' '), words.slice(0, 4).join(' ')].filter((t, i, a) => t && t.length >= 6 && a.indexOf(t) === i);
  for (const t of tries){
    const at = flat.indexOf(t); if (at < 0) continue;
    const ids = new Set(owner.slice(at, at + t.length).filter(i => i >= 0));
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const i of ids){ const it = tc.items[i], [, b, , d, e, f] = it.transform, h = Math.hypot(b, d) || it.height || 10;
      const p1 = vp.convertToViewportPoint(e, f), p2 = vp.convertToViewportPoint(e + it.width, f + h);
      x0 = Math.min(x0, p1[0], p2[0]); x1 = Math.max(x1, p1[0], p2[0]); y0 = Math.min(y0, p1[1], p2[1]); y1 = Math.max(y1, p1[1], p2[1]); }
    if (x1 > x0) return {x0, y0, x1, y1};
  }
  return null;
}
/** PDF source -> JPEG of the section the card was made from: exactly the ref's box when it has one (the quote highlighted
    inside it), else the region around the quote (highlighted); the whole page if the quote isn't found */
async function refSnapshot(src, ref){
  const doc = await srcDoc(src); if (!doc) return null;
  const pn = Math.min(Math.max(1, ref.page || 1), doc.numPages), page = await doc.getPage(pn), box = refBox(ref);
  // a small section is rendered sharper, so it still reads at full width
  const v1 = page.getViewport({scale: 1}), vp = page.getViewport({scale: Math.min(4, Math.max(1400, box ? 1000 / (box[2] - box[0]) : 0) / v1.width)});
  const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({canvasContext: ctx, viewport: vp}).promise;
  const hit = await findQuote(page, vp, ref.quote);
  if (hit){ ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(255,214,0,.5)'; ctx.fillRect(hit.x0 - 6, hit.y0 - 4, hit.x1 - hit.x0 + 12, hit.y1 - hit.y0 + 8); ctx.restore(); }
  let crop = {x: 0, y: 0, w: cv.width, h: cv.height};
  if (box){ const px = cv.width * 0.012, py = cv.height * 0.008, x0 = Math.max(0, box[0] * cv.width - px), y0 = Math.max(0, box[1] * cv.height - py);
    crop = {x: x0, y: y0, w: Math.min(cv.width, box[2] * cv.width + px) - x0, h: Math.min(cv.height, box[3] * cv.height + py) - y0}; }
  else if (hit){ const pad = cv.height * 0.13, y0 = Math.max(0, hit.y0 - pad), y1 = Math.min(cv.height, hit.y1 + pad); crop = {x: 0, y: y0, w: cv.width, h: Math.max(y1 - y0, cv.height * 0.22)}; }
  const W = Math.min(1000, Math.round(crop.w)), sc = W / crop.w, out = document.createElement('canvas'); out.width = W; out.height = Math.max(1, Math.round(crop.h * sc));
  out.getContext('2d').drawImage(cv, crop.x, crop.y, crop.w, crop.h, 0, 0, W, out.height);
  const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.82));
  return {blob, found: !!(box || hit), page: pn};
}
/** text sources (slides, docs, web, notes) -> the passage around the quote, with the quote marked */
async function refExcerpt(src, ref){
  const pages = await loadSourcePages(src);
  const nq = ref.quote ? ref.quote.toLowerCase().replace(/\s+/g, ' ') : '';
  const has = p => nq && p.text.toLowerCase().replace(/\s+/g, ' ').includes(nq);
  // the page named in the ref, else wherever the quote actually is (web pages / notes often have no page)
  const pg = [pages.find(p => p.page === ref.page && (!nq || has(p))), pages.find(has), pages.find(p => p.page === ref.page), pages[0]].find(Boolean); if (!pg) return null;
  const txt = pg.text; let at = -1, len = 0;
  if (ref.quote){
    const low = txt.toLowerCase(), q = ref.quote.toLowerCase().replace(/\s+/g, ' ');
    at = low.replace(/\s+/g, ' ').indexOf(q);
    if (at >= 0){ // map back onto the original string (whitespace was collapsed)
      let i = 0, j = 0; const col = low.replace(/\s+/g, ' ');
      while (i < low.length && j < at){ if (/\s/.test(low[i])){ while (i < low.length && /\s/.test(low[i])) i++; j++; } else { i++; j++; } }
      at = i; len = Math.min(txt.length - at, ref.quote.length + (txt.slice(at, at + ref.quote.length * 1.5).length - txt.slice(at, at + ref.quote.length * 1.5).replace(/\s+/g, ' ').length));
    }
  }
  const from = Math.max(0, (at >= 0 ? at : 0) - 220), to = Math.min(txt.length, (at >= 0 ? at + len : 0) + 260);
  const before = txt.slice(from, at >= 0 ? at : from), mid = at >= 0 ? txt.slice(at, at + len) : '', after = txt.slice(at >= 0 ? at + len : from, to);
  return `<div class="aa-src-excerpt">${from > 0 ? '… ' : ''}${esc(before)}${mid ? `<mark>${esc(mid)}</mark>` : ''}${esc(after)}${to < txt.length ? ' …' : ''}</div>`;
}
const visCache = new class extends Map {
  delete(key){ const value = this.get(key); if (value?.url) URL.revokeObjectURL(value.url); return super.delete(key); }
  clear(){ for (const key of this.keys()) this.delete(key); }
  set(key, value){ if (this.has(key)) this.delete(key); super.set(key, value); while (this.size > 64) this.delete(this.keys().next().value); return this; }
}();   // key -> {html, blob?, url?}
/** the visual for a card's first ref: {html} (excerpt) or {blob, url} (PDF picture); null if its source isn't stored */
async function sourceVisual(c){
  const ref = cardRefs(c)[0]; if (!ref) return null;
  const src = findSource(ref.file) || (S.sources.length === 1 ? S.sources[0] : null); if (!src) return null;
  const project = curProject, generation = srcDocGeneration;
  const key = `${curProject}|${src.id}|${ref.page}|${ref.quote || ''}|${(ref.box || []).join(',')}`;
  if (visCache.has(key)) return visCache.get(key);
  let v = null;
  try {
    if (src.kind === 'pdf'){ const sn = await refSnapshot(src, ref); if (sn) v = {blob: sn.blob, url: URL.createObjectURL(sn.blob), found: sn.found, label: `${src.name} p.${sn.page}`}; }
    if (!v){ const h = await refExcerpt(src, ref); if (h) v = {html: h, label: `${src.name} ${src.kind === 'pdf' || src.kind === 'pptx' ? 'p.' : '§'}${ref.page}`}; }
  } catch (e) { console.warn('source visual', e); }
  if (project !== curProject || generation !== srcDocGeneration){ if (v?.url) URL.revokeObjectURL(v.url); return null; }
  visCache.set(key, v); return v;
}
let visToken = 0;
async function attachSourceVisual(c, pc){
  if (!$('#srcPrev').checked) return;
  const my = ++visToken, v = await sourceVisual(c); if (!v || my !== visToken || !pc.isConnected) return;
  let box = pc.querySelector('.source');
  if (!box){ box = document.createElement('div'); box.className = 'source'; box.textContent = 'Source: ' + v.label; (pc.querySelector('.aa-wrap') || pc).appendChild(box); }
  const d = document.createElement('div');
  d.innerHTML = v.url ? `<div class="aa-src-shot"><img alt="source"></div>` : v.html;
  if (v.url) d.querySelector('img').src = v.url;
  box.appendChild(d.firstElementChild);
}

/* ====================================================================== project file */
$('#btnSaveProject').onclick = async () => {
  const media = [];
  for (const [n, m] of Object.entries(S.media)){ const e = {filename: n}; for (const k of ['origin','url','hint','caption','credit','error']) if (m[k]) e[k] = m[k]; if (m.blob){ e.data = await blobToB64(m.blob); e.mime = m.blob.type; } media.push(e); }
  const d = {format: PROJECT_FORMAT, deck: S.deck, tags: S.tags, generalFeedback: S.generalFeedback, prompt: S.prompt, order: S.order, batch: S.batch, projectName: S.projectName, whyAll: !!S.whyAll, cards: S.cards, media};
  download(new Blob([JSON.stringify(d)], {type: 'application/json'}), (S.deck || 'deck').replace(/::/g, ' - ').replace(/[\\/:*?"<>|]+/g, '_') + '.anki-studio.json');
};
$('#btnOpenProject').onclick = () => $('#projectFile').click();
$('#projectFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    // opened files become their own project (the current one is kept)
    if (S.cards.length || S.batch) await newProject(d.projectName || d.deck || f.name.replace(/\.anki-studio\.json$|\.json$/i, ''));
    applyBundle(d, 'replace');
    if (d.generalFeedback) S.generalFeedback = d.generalFeedback;
    if (d.order) S.order = d.order;
    if (d.batch) S.batch = d.batch;
    S.projectName = d.projectName || S.projectName || d.deck || '';
    if (d.prompt){ S.prompt = d.prompt; writePrompt(d.prompt); buildPrompt(); }
    S.curId = null; $('#exDeck').value = S.deck; await afterImport(); showTab('review'); toast('Project opened');
  } catch (err) { alert('Could not open: ' + err.message); }
};
$('#btnTheme').onclick = () => {
  const r = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = r.dataset.theme || (dark ? 'dark' : 'light'); r.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('acs-theme', r.dataset.theme); } catch {}
};
try { const t = localStorage.getItem('acs-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
window.addEventListener('resize', debounce(() => { if (dlg.open) drawStage(); }, 150));

/* ====================================================================== init */
let DEFAULT_PROMPT = null;
(async function init(){
  checkCompact(); setPane(PANE);
  DEFAULT_PROMPT = readPrompt();
  await restore();
  if (S.prompt && Object.keys(S.prompt).length) writePrompt(S.prompt);
  buildPrompt();
  $('#exDeck').value = S.deck;
  updateTabCounts(); renderDeckSummary(); renderProjects();
  if (S.cards.length) fetchUrlImages();
})();
