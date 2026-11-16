/* ====================================================================== SOURCES */
const srcCache = new Map();      // source id -> {pages:[{page, text, figure}]}
const srcDocCache = new Map();   // source id -> pdf.js document
const SRC_ICON = {pdf: '📕', pptx: '📊', docx: '📄', text: '📝', web: '🌐', html: '🌐'};
const srcInScope = x => { const n = scopeNode(); if (!n) return true; return nodeSubtree(n).some(m => m.id === x.node); };
const tokEst = chars => Math.round(chars / 4);
const fmtK = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
/* ---- extraction (everything in the browser; web pages need acs.py because of CORS) */
function cleanLines(t){
  return String(t).replace(/­/g, '').replace(/ /g, ' ').replace(/(\w)-\n(\w)/g, '$1$2').split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, a) => !/^(page\s*)?\d{1,4}(\s*(\/|of)\s*\d{1,4})?$/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function tidyPages(pages, slides){
  // slide builds: a page whose lines all reappear on the next page
  if (slides) for (let i = 0; i < pages.length - 1; i++){
    const a = pages[i].text.split('\n').filter(Boolean), b = new Set(pages[i + 1].text.split('\n').filter(Boolean));
    if (a.length >= 2 && a.every(l => b.has(l))){ pages[i].drop = true; pages[i + 1].builds = pages[i].builds || pages[i].page; pages[i + 1].figure = pages[i + 1].figure || pages[i].figure; }
  }
  const kept = pages.filter(p => !p.drop);
  if (kept.length >= 3){   // headers/footers: short lines on >= 40% of pages
    const cnt = new Map(); for (const p of kept) for (const l of new Set(p.text.split('\n'))) if (l && l.length < 80) cnt.set(l, (cnt.get(l) || 0) + 1);
    const rep = new Set([...cnt].filter(([, n]) => n >= Math.max(3, .4 * kept.length)).map(([l]) => l));
    for (const p of kept) p.text = p.text.split('\n').filter(l => !rep.has(l)).join('\n').trim();
  }
  return kept.filter(p => p.text || p.figure).map(p => ({page: p.page, text: p.text, ...(p.figure ? {figure: true} : {}), ...(p.builds ? {builds: p.builds} : {})}));
}
async function extractPdf(buf){
  const doc = await pdfjsLib.getDocument({data: new Uint8Array(buf.slice(0))}).promise, pages = [];   // pdf.js detaches the buffer it gets: give it a copy
  for (let i = 1; i <= doc.numPages; i++){
    const pg = await doc.getPage(i), tc = await pg.getTextContent();
    let t = '', lastY = null;
    for (const it of tc.items){ const y = it.transform[5]; if (lastY !== null && Math.abs(y - lastY) > 2 && !t.endsWith('\n')) t += '\n'; t += it.str; if (it.hasEOL) t += '\n'; lastY = y; }
    let figure = false;
    try { const ops = await pg.getOperatorList(); figure = ops.fnArray.filter(f => f === pdfjsLib.OPS.paintImageXObject || f === pdfjsLib.OPS.paintInlineImageXObject).length > 0; } catch {}
    pages.push({page: i, text: cleanLines(t), figure});
  }
  return {pages: tidyPages(pages, true), total: doc.numPages};
}
const xmlDoc = s => new DOMParser().parseFromString(s, 'application/xml');
const xText = (el, tag) => [...el.getElementsByTagName(tag)].map(x => x.textContent).join('');
async function extractPptx(buf){
  const z = await JSZip.loadAsync(buf), num = n => +(n.match(/(\d+)\.xml$/) || [0, 0])[1];
  const slides = Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const pages = [];
  for (const [i, n] of slides.entries()){
    const d = xmlDoc(await z.file(n).async('string'));
    const paras = [...d.getElementsByTagName('a:p')].map(p => xText(p, 'a:t').trim()).filter(Boolean);
    const relsF = z.file(n.replace('slides/', 'slides/_rels/') + '.rels'); let notes = '', figure = false;
    if (relsF){ const rels = await relsF.async('string'); figure = /relationships\/(image|chart)/.test(rels);
      const m = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/);
      if (m && z.file('ppt/notesSlides/' + m[1])){ const nd = xmlDoc(await z.file('ppt/notesSlides/' + m[1]).async('string')); notes = [...nd.getElementsByTagName('a:p')].map(p => xText(p, 'a:t').trim()).filter(x => x && !/^\d+$/.test(x)).join(' '); } }
    pages.push({page: i + 1, text: cleanLines(paras.join('\n') + (notes ? '\n\nSpeaker notes: ' + notes : '')), figure});
  }
  return {pages: tidyPages(pages, true), total: slides.length};
}
async function extractDocx(buf){
  const z = await JSZip.loadAsync(buf), d = xmlDoc(await z.file('word/document.xml').async('string'));
  const body = d.getElementsByTagName('w:body')[0]; const secs = [[]];
  for (const el of body ? [...body.children] : []){
    if (el.tagName === 'w:p'){
      const st = (el.getElementsByTagName('w:pStyle')[0] || {getAttribute: () => ''}).getAttribute('w:val') || '';
      const t = xText(el, 'w:t').trim(); if (!t) continue;
      const h = /^Heading([12])$|^Title$/i.exec(st);
      if (h && secs[secs.length - 1].join('').length > 400) secs.push([]);
      secs[secs.length - 1].push((h ? '# ' : '') + t);
    } else if (el.tagName === 'w:tbl'){
      for (const tr of el.getElementsByTagName('w:tr')) secs[secs.length - 1].push([...tr.getElementsByTagName('w:tc')].map(tc => xText(tc, 'w:t').trim()).join(' | '));
    }
  }
  const pages = splitBig(secs.map(x => x.join('\n')));
  return {pages: pages.map((t, i) => ({page: i + 1, text: cleanLines(t)})).filter(p => p.text), total: pages.length};
}
/** text without pages -> "sections" of <= ~3500 characters, breaking at headings/blank lines */
function splitBig(chunks, max = 3500){
  const out = [];
  for (const c of chunks){
    if (c.length <= max){ out.push(c); continue; }
    let buf = '';
    for (const para of c.split(/\n(?=#)|\n\s*\n/)){ if (buf && buf.length + para.length > max){ out.push(buf); buf = ''; } buf += (buf ? '\n\n' : '') + para; }
    if (buf) out.push(buf);
  }
  return out;
}
function extractText(text){
  const parts = splitBig(String(text).split(/\n(?=#{1,2} )/));
  const pages = []; let cur = '';
  for (const p of parts){ if (cur && cur.length + p.length > 3500){ pages.push(cur); cur = ''; } cur += (cur ? '\n\n' : '') + p; }
  if (cur) pages.push(cur);
  return {pages: pages.map((t, i) => ({page: i + 1, text: cleanLines(t)})), total: pages.length};
}
function htmlToReadable(html){
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,iframe,svg').forEach(x => x.remove());
  const root = d.querySelector('main,article') || d.body;
  root.querySelectorAll('pre').forEach(p => p.textContent = '\n```\n' + p.textContent + '\n```\n');
  root.querySelectorAll('h1,h2,h3').forEach(h => h.textContent = '\n\n' + '#'.repeat(+h.tagName[1]) + ' ' + h.textContent + '\n');
  root.querySelectorAll('li').forEach(li => li.prepend('- '));
  root.querySelectorAll('p,div,li,tr,br,table,ul,ol,blockquote').forEach(x => x.append('\n'));
  return {title: (d.title || '').trim(), text: root.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()};
}
const extOfName = n => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
async function ingestSourceFile(file, nodeId){
  const ext = extOfName(file.name), buf = await file.arrayBuffer(), keep = new Blob([buf.slice(0)], {type: file.type || ''});
  let r, kind;
  if (ext === 'pdf'){ if (!window.pdfjsLib) throw new Error('PDF engine did not load'); r = await extractPdf(buf); kind = 'pdf'; }
  else if (ext === 'pptx'){ r = await extractPptx(buf); kind = 'pptx'; }
  else if (ext === 'docx'){ r = await extractDocx(buf); kind = 'docx'; }
  else if (['html', 'htm'].includes(ext)){ const h = htmlToReadable(new TextDecoder().decode(buf)); r = extractText(h.text); kind = 'html'; }
  else { r = extractText(new TextDecoder().decode(buf)); kind = 'text'; }
  return saveSource({name: file.name, kind, ext, mime: file.type || MIME[ext] || '', node: nodeId, total: r.total}, r.pages, keep);
}
async function saveSource(meta, pages, blob){
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let name = meta.name; const taken = new Set((S.sources || []).map(x => x.name)); for (let k = 2; taken.has(name); k++) name = meta.name.replace(/(\.[^.]+)?$/, ` (${k})$1`);
  const src = {...meta, id, name, pages: pages.length, chars: pages.reduce((a, p) => a + p.text.length, 0), pageChars: pages.map(p => [p.page, p.text.length]), added: Date.now()};
  await Store.putSource(curProject, id, {name, kind: src.kind, ext: src.ext, pages}, blob);
  srcCache.set(id, {pages});
  S.sources = [...(S.sources || []), src]; save();
  return src;
}
async function loadSourcePages(src){
  if (srcCache.has(src.id)) return srcCache.get(src.id).pages;
  const d = await Store.getSource(curProject, src.id); const pages = (d && d.pages) || [];
  srcCache.set(src.id, {pages}); return pages;
}
/** match a file name from the AI (a ref or a plan) to a stored source */
function findSource(name){
  if (!name) return null;
  const n = String(name).toLowerCase().split(/[\\/]/).pop(), stem = n.replace(/\.(pdf|pptx?|docx|txt|md|html?)$/, '');
  const all = S.sources || [];
  return all.find(x => x.name.toLowerCase() === n) || all.find(x => x.name.toLowerCase().replace(/\.[^.]+$/, '') === stem)
    || all.find(x => x.url && x.url.toLowerCase() === n) || (stem.length >= 3 ? all.find(x => x.name.toLowerCase().includes(stem)) : null) || null;
}
function parseRanges(spec, avail){
  if (spec == null || spec === '' || spec === 'all' || spec === '*') return avail;
  const want = new Set(); for (const part of String(spec).replace(/\s/g, '').split(',')){ if (!part) continue; const [a, b] = part.split('-'); const lo = +a, hi = b === undefined ? lo : (b === '' ? Math.max(...avail) : +b); for (let i = lo; i <= hi; i++) want.add(i); }
  return avail.filter(p => want.has(p));
}
/** the text block a prompt carries: "[name p.N]\ntext" per page */
async function sourceBlock(list){   // list: [{src, pages: "1-12" | null}]
  const out = [];
  for (const {src, pages} of list){
    const all = await loadSourcePages(src), keep = new Set(parseRanges(pages, all.map(p => p.page)));
    for (const p of all) if (keep.has(p.page)) out.push(`[${src.name} p.${p.page}]${p.builds ? ` (slide builds from p.${p.builds})` : ''}${src.url ? ` (${src.url})` : ''}\n${p.text}${p.figure ? '\n[figure on this page]' : ''}`);
  }
  return out.join('\n\n');
}
function charsFor(src, pages){ const pc = src.pageChars || []; const keep = new Set(parseRanges(pages, pc.map(x => x[0]))); return pc.filter(x => keep.has(x[0])).reduce((a, x) => a + x[1] + 20, 0); }
const scopeSources = () => (S.sources || []).filter(srcInScope);
/* ---- UI */
let srcSel = null;
function renderSourcesTab(){
  const list = scopeSources(), n = scopeNode();
  $('#tabSrcCount').textContent = (S.sources || []).length || '';
  const opts = [['root', projName() + ' (project)'], ...S.nodes.map(m => [m.id, '› ' + m.name])];
  $('#srcList').innerHTML = list.length ? list.map(x => `<div class="src ${x.id === srcSel ? 'ssel' : ''}" data-src="${x.id}">
      <span class="ic">${SRC_ICON[x.kind] || '📄'}</span>
      <div style="min-width:0"><div class="nm" title="${esc(x.url || x.name)}">${esc(x.title || x.name)}</div>
        <div class="mt">${x.kind.toUpperCase()} · ${x.pages}${x.total && x.total !== x.pages ? '/' + x.total : ''} ${x.kind === 'pdf' || x.kind === 'pptx' ? 'pages' : 'sections'} · ~${fmtK(tokEst(x.chars))} tokens</div></div>
      <div class="row" style="gap:4px;flex-wrap:nowrap"><select data-move="${x.id}" title="Which sub-project owns this source">${opts.map(([v, l]) => `<option value="${v}" ${v === (x.node || 'root') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <button class="btn sm" data-del="${x.id}" title="Remove">🗑</button></div></div>`).join('')
    : `<div class="note small">No sources ${n ? 'in this sub-project' : 'yet'}. Drop files above.</div>`;
  const tot = list.reduce((a, x) => a + x.chars, 0);
  $('#srcStatus').innerHTML = list.length ? `<span class="small muted">${list.length} source(s) · ~${fmtK(tokEst(tot))} tokens of text${n ? ` in “${esc(n.name)}”` : ''}</span>` : '';
}
async function viewSource(id){
  srcSel = id; renderSourcesTab();
  const src = (S.sources || []).find(x => x.id === id); if (!src) return;
  $('#srcViewTitle').textContent = src.title || src.name; $('#srcViewInfo').textContent = src.url || '';
  $('#srcView').textContent = 'Loading…';
  const txt = await sourceBlock([{src, pages: null}]);
  $('#srcView').innerHTML = esc(txt).replace(/^\[([^\]\n]+ p\.\d+)\]/gm, '<span class="pmark">[$1]</span>') || '<i>(no text found - a scanned PDF? its pages can still be shown in cards)</i>';
}
$('#srcList').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (del){ const x = S.sources.find(s2 => s2.id === del.dataset.del);
    if (x && confirm(`Remove the source "${x.name}"?`)){ S.sources = S.sources.filter(s2 => s2 !== x); srcCache.delete(x.id); srcDocCache.delete(x.id); await Store.delSource(curProject, x.id, x.ext).catch(() => {}); save(); renderSourcesTab(); renderScopeBar(); }
    return; }
  if (e.target.closest('select')) return;
  const it = e.target.closest('[data-src]'); if (it) viewSource(it.dataset.src);
});
$('#srcList').addEventListener('change', e => { const sel = e.target.closest('[data-move]'); if (!sel) return; const x = S.sources.find(s2 => s2.id === sel.dataset.move); if (x){ x.node = sel.value; save(); renderSourcesTab(); renderTree(); } });
async function addFiles(files){
  const base = scopeNode();
  for (const f of files){
    $('#srcStatus').innerHTML = `<div class="note small">Extracting <b>${esc(f.name)}</b>…</div>`;
    try {
      let node = base ? base.id : 'root';
      if ($('#srcPerFile').checked){ const nm = f.name.replace(/\.[^.]+$/, ''); const nn = ensureNode(`${base ? nodeDeckOf(base) : S.deck}::${nm.replace(/::/g, ' -')}`, nm); node = nn.id; }
      const src = await ingestSourceFile(f, node);
      toast(`${src.name}: ${src.pages} page(s), ~${fmtK(tokEst(src.chars))} tokens`);
    } catch (er) { console.error(er); toast(`${f.name}: ${er.message}`, 4000); }
  }
  renderSourcesTab(); renderTree();
}
wireDrop($('#srcDrop'), $('#srcFile'), addFiles);
$('#btnSrcUrl').onclick = async () => {
  const url = $('#srcUrl').value.trim(); if (!/^https?:\/\//i.test(url)) return toast('Enter a full http(s) link');
  if (!Store.on) return toast('Web pages need the ACS server (acs.py) or the online version - browsers block reading other sites. You can paste the text instead.', 5000);
  $('#srcStatus').innerHTML = `<div class="note small">Fetching ${esc(url)}…</div>`;
  try {
    const r = await fetch(Store.base + '/api/fetch?url=' + encodeURIComponent(url));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
    const node = scopeNode() ? scopeNode().id : 'root';
    if ((r.headers.get('Content-Type') || '').includes('pdf')){
      const name = decodeURIComponent(r.headers.get('X-ACS-Title') || 'download.pdf');
      await ingestSourceFile(new File([await r.blob()], name.endsWith('.pdf') ? name : name + '.pdf', {type: 'application/pdf'}), node);
    } else {
      const j = await r.json(), ex = extractText(j.text || '');
      const host = new URL(j.url || url).hostname.replace(/^www\./, '');
      const nm = (j.title || host).slice(0, 80).replace(/[\\/:*?"<>|]+/g, '-');
      await saveSource({name: nm, title: j.title || nm, kind: 'web', ext: 'txt', mime: 'text/plain', url: j.url || url, node, total: ex.total}, ex.pages, new Blob([j.text || ''], {type: 'text/plain'}));
    }
    $('#srcUrl').value = ''; renderSourcesTab(); renderTree();
  } catch (er) { $('#srcStatus').innerHTML = `<div class="note bad small">Could not fetch: ${esc(er.message)}</div>`; }
};
$('#btnSrcPaste').onclick = async () => {
  const t = $('#srcPaste').value.trim(); if (!t) return;
  const nm = ($('#srcPasteName').value.trim() || 'Pasted text') ; const ex = extractText(t);
  await saveSource({name: nm, kind: 'text', ext: 'txt', mime: 'text/plain', node: scopeNode() ? scopeNode().id : 'root', total: ex.total}, ex.pages, new Blob([t], {type: 'text/plain'}));
  $('#srcPaste').value = ''; $('#srcPasteName').value = ''; renderSourcesTab(); renderTree();
};

/* ====================================================================== tabs */
function showTab(name){
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'review') renderReview();
  if (name === 'revise') renderReviseSummary();
  if (name === 'export') renderExport();
  if (name === 'analytics') renderAnalytics();
  if (name === 'prompt') renderDeckSummary();
  if (name === 'checker') renderCheckSettings();
  if (name === 'sources') renderSourcesTab();
  renderScopeBar();
  window.scrollTo(0, 0);
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
function updateTabCounts(){
  if (S.filter && S.filter.startsWith('chk:')) ensureCheckOption(S.filter.slice(4));
  try { if (SET.showAnalytics !== false) anaCountSoon(); } catch {}   // not defined yet during start-up
  const n = S.cards.filter(c => c.status === 'new').length, ch = S.cards.filter(c => c.status === 'change').length;
  const rc = S.cards.filter(c => c.recheck).length;
  $('#tabReviewCount').textContent = S.cards.length ? `${n} left` + (rc ? ` · ${rc} re-check` : '') : '';
  const ro = $('#filter option[value=recheck]'); if (ro) ro.textContent = `Re-check (formatting pass)${rc ? ' · ' + rc : ''}`; $('#tabReviewCount').hidden = !S.cards.length;
  $('#tabReviseCount').textContent = ch ? String(ch) : ''; $('#tabReviseCount').hidden = !ch;
}

