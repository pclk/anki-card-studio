/* ====================================================================== IMAGE DIALOG */
const dlg = $('#imgDlg');
const sources = [];   // {id, name, kind:'pdf'|'image', pdf?, pages?, page?, canvas?}
let dlgCtx = null, curSource = null, selRect = null, stageScale = 1;
const stageCanvas = $('#stageCanvas');
/** make the project's stored PDFs available in the snip dialog; with a hint like "L01.pdf p.12", open that one */
async function openProjectPdfsInDialog(hint){
  const pdfs = (S.sources || []).filter(x => x.kind === 'pdf');
  const want = hint ? pdfs.find(x => hint.toLowerCase().includes(x.name.toLowerCase().replace(/\.pdf$/, ''))) : null;
  for (const x of want ? [want, ...pdfs.filter(y => y !== want)] : pdfs){
    if (sources.some(s3 => s3.name === x.name)) continue;
    const bl = await Store.getSourceBlob(curProject, x.id, x.ext).catch(() => null); if (!bl) continue;
    const doc = await pdfjsLib.getDocument({data: new Uint8Array(await bl.arrayBuffer())}).promise.catch(() => null); if (!doc) continue;
    sources.push({id: ++srcSeq, name: x.name, kind: 'pdf', pdf: doc, pages: doc.numPages, page: 1});
  }
  renderSources();
  if (want){ const s3 = sources.find(y => y.name === want.name); if (s3) showSource(s3); }
}
function openImageDialog(ctx){
  dlgCtx = ctx; selRect = null; updateSel();
  const m = ctx.replace ? (S.media[ctx.replace] || {}) : {};
  $('#dlgTitle').textContent = ctx.replace ? `Image: ${ctx.replace}` : 'Add image';
  $('#dlgHint').hidden = !(m.hint || m.error);
  $('#dlgHint').innerHTML = m.hint ? `<b>Claude asked for:</b> ${esc(m.hint)}` : m.error ? `<b>Couldn't download:</b> ${esc(m.error)}<br><a href="${esc(m.url)}" target="_blank" rel="noopener">Open the link</a>, screenshot or save the image, then paste/open it here.` : '';
  $('#dlgName').value = ctx.replace || '';
  $('#dlgMsg').textContent = '';
  $('#commonsQ').value = m.caption ? stripHtml(m.caption).slice(0, 60) : (ctx.replace ? ctx.replace.replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ') : '');
  $('#commonsRes').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  if (ctx.blob) addSourceBlob(ctx.blob, 'Pasted image');
  else if (ctx.replace && mediaState(ctx.replace) === 'ok') ensureMedia([ctx.replace]).then(() => { const b = S.media[ctx.replace] && S.media[ctx.replace].blob; if (b) addSourceBlob(b, ctx.replace + ' (current)', true); });
  else if (m.hint && (S.sources || []).some(x => x.kind === 'pdf')) openProjectPdfsInDialog(m.hint);
  else if (curSource) showSource(curSource);
  else clearStage();
  if (!m.hint) openProjectPdfsInDialog(null);
  renderSources();
}
function closeDlg(){ sourceRenderToken++; dlg.close(); dlgCtx = null; }
$('#dlgClose').onclick = closeDlg;
dlg.addEventListener('cancel', e => { e.preventDefault(); closeDlg(); });
function clearStage(){ stageCanvas.width = stageCanvas.height = 10; $('#stageEmpty').style.display = 'flex'; $('#stage').style.visibility = 'hidden'; $('#dlgUse').disabled = true; $('#dlgPdfNav').hidden = true; }
function renderSources(){
  $('#dlgSources').innerHTML = sources.map(s => `<div class="srcitem ${s === curSource ? 'on' : ''}" data-id="${s.id}">${s.kind === 'pdf' ? '📄' : '🖼'} ${esc(s.name)}${s.kind === 'pdf' ? ` <span class="muted">(${s.pages} p)</span>` : ''}</div>`).join('');
}
$('#dlgSources').onclick = e => { const it = e.target.closest('.srcitem'); if (it) showSource(sources.find(s => s.id === +it.dataset.id)); };
let srcSeq = 0, sourceRenderToken = 0;
/** temp sources (pasted, downloaded, the current image) replace each other; opened files stay for the session */
async function addSourceBlob(blob, name, temp = true){
  const im = await createImageBitmap(blob).catch(() => null);
  if (!im){ $('#dlgMsg').textContent = 'Could not read that image.'; return; }
  const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; try { cv.getContext('2d').drawImage(im, 0, 0); } finally { im.close(); }
  for (let i = sources.length - 1; i >= 0; i--) if (sources[i].temp) sources.splice(i, 1);
  const s = {id: ++srcSeq, name, kind: 'image', canvas: cv, temp};
  sources.unshift(s); await showSource(s);
}
async function addSourceFile(file){
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf'){
    if (!window.pdfjsLib){ $('#dlgMsg').textContent = 'PDF viewer did not load (offline?). Take a screenshot and paste it instead.'; return; }
    $('#dlgMsg').textContent = 'Opening PDF…';
    try {
      const pdf = await pdfjsLib.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
      const s = {id: ++srcSeq, name: file.name, kind: 'pdf', pdf, pages: pdf.numPages, page: 1};
      sources.unshift(s); $('#dlgMsg').textContent = ''; await showSource(s);
    } catch (e) { $('#dlgMsg').textContent = 'Could not open PDF: ' + e.message; }
  } else await addSourceBlob(file, file.name, false);
}
async function showSource(s){
  const token = ++sourceRenderToken;
  if (!s) return clearStage();
  curSource = s; renderSources(); selRect = null; updateSel();
  $('#dlgPdfNav').hidden = s.kind !== 'pdf';
  if (s.kind === 'pdf'){
    const hintPage = (() => { const m = dlgCtx && dlgCtx.replace && S.media[dlgCtx.replace]; const mm = m && m.hint && /\b(?:p|page|pg|slide)\.?\s*(\d+)/i.exec(m.hint); return mm ? +mm[1] : 0; })();
    if (hintPage && hintPage <= s.pages && !s.jumped){ s.page = hintPage; s.jumped = true; }
    $('#pdfPage').value = s.page; $('#pdfPages').textContent = s.pages;
    const page = await s.pdf.getPage(s.page);
    const v1 = page.getViewport({scale: 1}); const scale = Math.min(4, 2000 / v1.width);
    const vp = page.getViewport({scale});
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({canvasContext: ctx, viewport: vp}).promise;
    if (token !== sourceRenderToken) return;
    s.canvas = cv;
  }
  drawStage();
  if (!$('#dlgName').value) $('#dlgName').value = safeName(s.kind === 'pdf' ? `${s.name}_p${s.page}` : s.name);
}
function drawStage(){
  const src = curSource && curSource.canvas; if (!src) return clearStage();
  $('#stageEmpty').style.display = 'none'; $('#stage').style.visibility = 'visible'; $('#dlgUse').disabled = false;
  stageCanvas.width = src.width; stageCanvas.height = src.height;
  stageCanvas.getContext('2d').drawImage(src, 0, 0);
  const z = $('#dlgZoom').value, wrapW = $('#stageWrap').clientWidth - 24;
  stageScale = z === 'fit' ? Math.min(1, wrapW / src.width) : +z;
  stageCanvas.style.width = Math.round(src.width * stageScale) + 'px';
  stageCanvas.style.height = Math.round(src.height * stageScale) + 'px';
  updateSel();
}
$('#dlgZoom').onchange = drawStage;
$('#pdfPrev').onclick = () => { if (curSource && curSource.page > 1){ curSource.page--; showSource(curSource); } };
$('#pdfNext').onclick = () => { if (curSource && curSource.page < curSource.pages){ curSource.page++; showSource(curSource); } };
$('#pdfPage').onchange = e => { const p = Math.max(1, Math.min(curSource.pages, +e.target.value || 1)); curSource.page = p; showSource(curSource); };
$('#dlgUpload').onclick = () => $('#dlgFile').click();
$('#dlgFile').onchange = async e => { for (const f of [...e.target.files]) await addSourceFile(f); e.target.value = ''; };
$('#stageWrap').addEventListener('dragover', e => e.preventDefault());
$('#stageWrap').addEventListener('drop', async e => { e.preventDefault(); for (const f of [...e.dataTransfer.files]) await addSourceFile(f); });
$('#dlgPaste').onclick = async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items){ const t = it.types.find(x => x.startsWith('image/')); if (t){ await addSourceBlob(await it.getType(t), 'Pasted image'); return; } }
    $('#dlgMsg').textContent = 'No image on the clipboard.';
  } catch { $('#dlgMsg').textContent = 'Press Ctrl/⌘+V to paste (the browser blocked the button).'; }
};
dlg.addEventListener('paste', e => {
  if (e.target.closest('input')) return;
  const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (it){ e.preventDefault(); addSourceBlob(it.getAsFile(), 'Pasted image'); }
});
$('#dlgUrlGo').onclick = async () => {
  const url = $('#dlgUrl').value.trim(); if (!url) return;
  $('#dlgMsg').textContent = 'Downloading…';
  try { await addSourceBlob(await fetchImageFromUrl(url), 'URL image'); $('#dlgMsg').textContent = ''; if (dlgCtx) dlgCtx.url = url; }
  catch (e) { $('#dlgMsg').innerHTML = `<span style="color:var(--bad)">Couldn't download (${esc(e.message)}).</span> Open it in a new tab, copy the image, and paste here.`; }
};
$('#commonsGo').onclick = async () => {
  const q = $('#commonsQ').value.trim(); if (!q) return;
  $('#commonsRes').innerHTML = '<span class="small muted">Searching…</span>';
  try {
    const api = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=18&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap|drawing')}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1000&format=json&origin=*`;
    const j = await (await fetch(api)).json();
    const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index).filter(p => p.imageinfo);
    $('#commonsRes').innerHTML = pages.map(p => { const ii = p.imageinfo[0]; return `<img src="${esc(ii.thumburl)}" title="${esc(p.title)}" data-url="${esc(ii.thumburl)}" data-title="${esc(p.title)}" loading="lazy">`; }).join('') || '<span class="small muted">No results.</span>';
  } catch (e) { $('#commonsRes').innerHTML = `<span class="small" style="color:var(--bad)">Search failed: ${esc(e.message)}</span>`; }
};
$('#commonsQ').addEventListener('keydown', e => { if (e.key === 'Enter') $('#commonsGo').click(); });
$('#commonsRes').onclick = async e => {
  const im = e.target.closest('img'); if (!im) return;
  $('#dlgMsg').textContent = 'Downloading…';
  try { await addSourceBlob(await fetchImageFromUrl(im.dataset.url), 'Commons: ' + im.dataset.title.replace(/^File:/, '')); $('#dlgMsg').textContent = '';
    if (dlgCtx){ dlgCtx.credit = 'Wikimedia Commons: ' + im.dataset.title.replace(/^File:/, ''); dlgCtx.url = 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(im.dataset.title.replace(/ /g, '_')); }
    if (!$('#dlgName').value) $('#dlgName').value = safeName(im.dataset.title.replace(/^File:/, ''));
  } catch (err) { $('#dlgMsg').textContent = 'Download failed: ' + err.message; }
};
/* selection */
let dragStart = null;
$('#stage').addEventListener('pointerdown', e => {
  if (!curSource || !curSource.canvas) return;
  const r = stageCanvas.getBoundingClientRect();
  dragStart = {x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height};
  $('#stage').setPointerCapture(e.pointerId);
});
$('#stage').addEventListener('pointermove', e => {
  if (!dragStart) return;
  const r = stageCanvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  selRect = {x0: Math.min(dragStart.x, x), y0: Math.min(dragStart.y, y), x1: Math.max(dragStart.x, x), y1: Math.max(dragStart.y, y)};
  updateSel();
});
$('#stage').addEventListener('pointerup', () => { dragStart = null; if (selRect && (selRect.x1 - selRect.x0 < 0.01 || selRect.y1 - selRect.y0 < 0.01)){ selRect = null; updateSel(); } });
function updateSel(){
  const el = $('#sel');
  if (!selRect){ el.style.display = 'none'; $('#selInfo').textContent = 'No selection = whole image'; return; }
  const w = stageCanvas.clientWidth, h = stageCanvas.clientHeight;
  Object.assign(el.style, {display: 'block', left: selRect.x0 * w + 'px', top: selRect.y0 * h + 'px', width: (selRect.x1 - selRect.x0) * w + 'px', height: (selRect.y1 - selRect.y0) * h + 'px'});
  const W = stageCanvas.width, H = stageCanvas.height;
  $('#selInfo').textContent = `Selection ${Math.round((selRect.x1 - selRect.x0) * W)}×${Math.round((selRect.y1 - selRect.y0) * H)} px`;
}
$('#dlgClear').onclick = () => { selRect = null; updateSel(); };
function canvasToBlob(cv, type, q){ return new Promise(res => cv.toBlob(res, type, q)); }
async function exportSelection(){
  const src = curSource.canvas, r = selRect || {x0: 0, y0: 0, x1: 1, y1: 1};
  let sx = Math.round(r.x0 * src.width), sy = Math.round(r.y0 * src.height), sw = Math.max(1, Math.round((r.x1 - r.x0) * src.width)), sh = Math.max(1, Math.round((r.y1 - r.y0) * src.height));
  const max = +$('#dlgMax').value; const k = max && sw > max ? max / sw : 1;
  const cv = document.createElement('canvas'); cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
  const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const png = await canvasToBlob(cv, 'image/png');
  if (png.size > 350000){ const jpg = await canvasToBlob(cv, 'image/jpeg', 0.86); if (jpg.size < png.size * 0.7) return {blob: jpg, ext: 'jpg'}; }
  return {blob: png, ext: 'png'};
}
function uniqueName(stem, ext, except){
  let n = `${stem}.${ext}`, i = 2;
  while (S.media[n] && n !== except){ n = `${stem}_${i++}.${ext}`; }
  return n;
}
function renameMedia(oldN, newN){
  const re = new RegExp(`(src=["'])${oldN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["'])`, 'g');
  for (const c of S.cards){ for (const f of FIELDS[c.type]) c[f] = c[f].replace(re, (_, before, after) => before + newN + after); if (c.prev) for (const f of FIELDS[c.prev.type]) c.prev[f] = (c.prev[f] || '').replace(re, (_, before, after) => before + newN + after); }
  S.media[newN] = S.media[oldN]; delete S.media[oldN]; dropURL(oldN);
}
$('#dlgUse').onclick = async () => {
  if (!curSource || !curSource.canvas) return;
  const {blob, ext} = await exportSelection();
  const extra = {}; if (dlgCtx.credit) extra.credit = dlgCtx.credit;
  const origin = dlgCtx.url ? 'url' : 'upload';
  if (dlgCtx.replace){
    let name = dlgCtx.replace;
    const wanted = safeName($('#dlgName').value || name);
    let target = (wanted === safeName(name) && extOf(name) === ext) ? name : uniqueName(wanted, ext, name);
    if (target !== name){ renameMedia(name, target); name = target; }
    const prevOrigin = (S.media[name] || {}).origin;
    setMediaBlob(name, blob, Object.assign({origin: prevOrigin === 'material' ? 'material' : origin}, extra));
    toast(`Updated ${name}`);
  } else {
    const name = uniqueName(safeName($('#dlgName').value || 'image'), ext);
    setMediaBlob(name, blob, Object.assign({origin}, extra));
    const f = (dlgCtx.target && dlgCtx.target.f) || 'back';
    const credit = extra.credit ? esc(extra.credit) : '';
    insertIntoField(f, `<figure class="aa-fig"><img src="${name}"><figcaption>`, '</figcaption></figure>', credit || 'Caption');
    toast(`Inserted ${name}`);
  }
  closeDlg(); delete $('#fieldsPanel').dataset.card; save(); renderReview();
};

