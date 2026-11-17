"use strict";
/* ====================================================================== constants */
const FORMAT = 'anki-studio/v1';
const PROJECT_FORMAT = 'anki-studio/project-v1';
const BOX_KINDS = ['key','why','example','method','check','mnemonic','warning','note','compare','clinical'];
const BOX_TITLES = {key:'Key point',why:'Why / how',example:'Example',method:'Method',check:'Check',mnemonic:'Mnemonic',warning:'Common pitfall',note:'Note',compare:'Compare',clinical:'Application'};
const FIELDS = {basic:['front','back','extra','source'], cloze:['text','extra','source']};
const FIELD_LABEL = {front:'Front',back:'Back',text:'Text',extra:'Extra',source:'Source'};
const MODEL_BASIC_ID = 1717171700001, MODEL_CLOZE_ID = 1717171700002;
const CDN_SQL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/';
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const CARD_CSS = `.card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:19px;line-height:1.55;color:#1f2328;background:#fbfbfa;text-align:left;padding:18px 20px}
.aa-wrap{max-width:760px;margin:0 auto}
.aa-src-shot img{display:block;max-width:100%;margin-top:6px;border:1px solid rgba(127,127,127,.35);border-radius:6px}
.aa-src-excerpt{margin-top:6px;padding:6px 10px;border-left:3px solid #e0a000;background:rgba(224,160,0,.07);border-radius:0 6px 6px 0;font-size:.92em;white-space:pre-wrap;line-height:1.45}
.aa-src-excerpt mark{background:rgba(255,214,0,.55);color:inherit;border-radius:2px;padding:0 1px}
.nightMode .aa-src-excerpt mark{background:rgba(255,196,0,.35)}
.front{font-size:1.12em;font-weight:600;line-height:1.4}
hr#answer{border:none;border-top:2px solid #d0d7de;margin:16px 0}
.aa-answer{font-size:1.05em;font-weight:700;color:#0b4f9c;background:#e8f1fb;border-radius:8px;padding:8px 12px;margin:2px 0 10px}
.extra{margin-top:14px;padding-top:10px;border-top:1px dashed #d0d7de;font-size:.92em;color:#3d444d}
.source{margin-top:12px;font-size:.7em;color:#8b949e}
img{max-width:100%;max-height:440px;height:auto;display:block;margin:12px auto;border-radius:6px}
figure.aa-fig{margin:12px 0;text-align:center}
figure.aa-fig img{margin-bottom:4px}
figcaption{font-size:.78em;color:#59636e}
.aa-box{border-left:4px solid #8b949e;background:rgba(139,148,158,.10);border-radius:6px;padding:8px 12px;margin:10px 0;font-size:.94em}
.aa-box-title{font-size:.7em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.75;margin-bottom:2px}
.aa-key{border-color:#0969da;background:rgba(9,105,218,.08)}
.aa-why{border-color:#8250df;background:rgba(130,80,223,.08)}
.aa-example{border-color:#1a7f37;background:rgba(26,127,55,.08)}
.aa-mnemonic{border-color:#bf8700;background:rgba(191,135,0,.10)}
.aa-warning{border-color:#cf222e;background:rgba(207,34,46,.08)}
.aa-compare{border-color:#0598bc;background:rgba(5,152,188,.08)}
.aa-clinical{border-color:#bc4c00;background:rgba(188,76,0,.08)}
.aa-method{border-color:#1f6feb;background:rgba(31,111,235,.07)}
.aa-method ol,.aa-method ul{margin:4px 0;padding-left:1.3em}
.aa-check{border-color:#2da44e;background:rgba(45,164,78,.08)}
.aa-purpose{margin-top:14px;font-size:.85em;border-top:1px dashed #d0d7de;padding-top:6px;color:#424a53}
.aa-purpose summary{cursor:pointer;font-weight:600;color:#57606a}
.aa-purpose p{margin:.4em 0}
.nightMode .aa-purpose,.night_mode .aa-purpose{border-color:#3d444d;color:#c9d1d9}
.nightMode .aa-purpose summary,.night_mode .aa-purpose summary{color:#9198a1}
table{border-collapse:collapse;margin:10px auto;font-size:.88em}
/* narrow screens: nothing sticks out of the card. Long words wrap; wide tables, equations and code scroll sideways */
.card{overflow-wrap:break-word}
:not(pre)>code{overflow-wrap:anywhere}
table{display:block;width:fit-content;max-width:100%;overflow-x:auto}
math[display=block],.katex-display{display:block;max-width:100%;overflow-x:auto;overflow-y:hidden}
pre{max-width:100%}
td,th{border:1px solid #d0d7de;padding:4px 9px;vertical-align:top}
th{background:rgba(127,127,127,.12)}
ul,ol{margin:6px 0;padding-left:1.4em}
li{margin:2px 0}
.cloze{font-weight:700;color:#0969da}
.nightMode.card,.nightMode .card{color:#e6edf3;background:#1c1f24}
.nightMode .aa-answer{color:#9cc6ff;background:rgba(56,139,253,.15)}
.nightMode hr#answer,.nightMode .extra{border-color:#3d444d}
.nightMode .extra{color:#c9d1d9}
.nightMode figcaption{color:#9198a1}
.nightMode td,.nightMode th{border-color:#3d444d}
.nightMode .cloze{color:#6cb6ff}`;

/* token colours for <pre><code class="language-…"> (baked into the export, so Anki needs no JS) */
const HLJS_CSS = `pre{background:#f6f8fa;color:#1f2328;border:1px solid #d0d7de;border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:.82em;line-height:1.45;text-align:left}
pre code,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:not(pre)>code{background:rgba(127,127,127,.15);border-radius:4px;padding:.1em .35em;font-size:.88em}
.hljs-keyword,.hljs-selector-tag,.hljs-type,.hljs-meta .hljs-keyword{color:#cf222e}.hljs-string,.hljs-regexp,.hljs-meta .hljs-string{color:#0a3069}
.hljs-number,.hljs-literal,.hljs-variable.language_,.hljs-attr,.hljs-attribute{color:#0550ae}.hljs-title,.hljs-title.function_,.hljs-title.class_{color:#8250df}
.hljs-comment,.hljs-quote{color:#6e7781;font-style:italic}.hljs-built_in,.hljs-symbol{color:#953800}.hljs-meta{color:#116329}.hljs-tag,.hljs-name{color:#116329}
.nightMode pre{background:#161b22;color:#e6edf3;border-color:#30363d}
.nightMode .hljs-keyword,.nightMode .hljs-selector-tag,.nightMode .hljs-type{color:#ff7b72}.nightMode .hljs-string,.nightMode .hljs-regexp{color:#a5d6ff}
.nightMode .hljs-number,.nightMode .hljs-literal,.nightMode .hljs-attr,.nightMode .hljs-attribute{color:#79c0ff}.nightMode .hljs-title,.nightMode .hljs-title.function_,.nightMode .hljs-title.class_{color:#d2a8ff}
.nightMode .hljs-comment,.nightMode .hljs-quote{color:#8b949e}.nightMode .hljs-built_in,.nightMode .hljs-symbol{color:#ffa657}.nightMode .hljs-meta,.nightMode .hljs-tag,.nightMode .hljs-name{color:#7ee787}`;
function loadScript(src){ return new Promise((res, rej) => { const s3 = document.createElement('script'); s3.src = src; s3.onload = res; s3.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s3); }); }
const KATEX = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/';
let katexLoading = null;
/** render \( … \) and \[ … \] the way Anki's MathJax will (KaTeX loads the first time a card has maths) */
async function renderMath(root){
  if (!/\\\(|\\\[/.test(root.textContent)) return;
  if (!window.renderMathInElement){
    katexLoading = katexLoading || loadScript(KATEX + 'katex.min.js').then(() => loadScript(KATEX + 'contrib/auto-render.min.js')).catch(() => null);
    await katexLoading; if (!window.renderMathInElement) return;
  }
  if (!root.getRootNode().querySelector('link[data-katex]')){ const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = KATEX + 'katex.min.css'; l.dataset.katex = 1; (root.getRootNode().host ? root.getRootNode() : document.head).prepend(l); }
  try { renderMathInElement(root, {delimiters: [{left: '\\(', right: '\\)', display: false}, {left: '\\[', right: '\\]', display: true}], throwOnError: false, ignoredTags: ['pre', 'code', 'textarea']}); } catch (e) { console.warn('math', e); }
}
const codeLang = el => ((el.className || '').match(/(?:^|\s)(?:language|lang)-([\w+#-]+)/) || [])[1];
function highlightCode(root){
  if (!window.hljs) return;
  root.querySelectorAll('pre code').forEach(code => {
    const lang = codeLang(code) || codeLang(code.parentElement); if (!lang || code.dataset.hl) return;
    try { code.innerHTML = hljs.getLanguage(lang) ? hljs.highlight(code.textContent, {language: lang, ignoreIllegals: true}).value : hljs.highlightAuto(code.textContent).value; code.classList.add('hljs'); code.dataset.hl = lang; } catch {}
  });
}
/** export: replace code blocks with pre-highlighted HTML */
function bakeCode(html){
  if (!window.hljs || !/<code[^>]+(?:language|lang)-/i.test(String(html))) return html;
  const t = document.createElement('template'); t.innerHTML = html; highlightCode(t.content);
  t.content.querySelectorAll('code[data-hl]').forEach(c => c.removeAttribute('data-hl'));
  return t.innerHTML;
}
const TPL_BASIC_Q = '<div class="aa-wrap"><div class="front">{{Front}}</div></div>';
const TPL_BASIC_A = '<div class="aa-wrap"><div class="front">{{Front}}</div><hr id="answer"><div class="back">{{Back}}</div>{{#Extra}}<div class="extra">{{Extra}}</div>{{/Extra}}{{#Source}}<div class="source">Source: {{Source}}</div>{{/Source}}</div>';
const TPL_CLOZE_Q = '<div class="aa-wrap"><div class="cloze-text">{{cloze:Text}}</div></div>';
const TPL_CLOZE_A = '<div class="aa-wrap"><div class="cloze-text">{{cloze:Text}}</div>{{#Extra}}<div class="extra">{{Extra}}</div>{{/Extra}}{{#Source}}<div class="source">Source: {{Source}}</div>{{/Source}}</div>';

/* ====================================================================== utils */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stripHtml = s => { const d = new DOMParser().parseFromString('', 'text/html').body; d.innerHTML = String(s ?? '').replace(/<img[^>]*>/gi, ' [image] ').replace(/<br\s*\/?>/gi, ' '); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const extOf = n => (String(n).split('?')[0].match(/\.([a-z0-9]+)$/i) || [,''])[1].toLowerCase();
const MIME = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp'};
const safeName = n => (String(n).replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'image');
function toast(msg, ms = 2200){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); }
function download(blob, name){ const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }
/** copy text that is still being built (source text loads async); keeps Safari's user-gesture rule happy */
async function copyLater(promise, msg){
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write){
      await navigator.clipboard.write([new ClipboardItem({'text/plain': promise.then(t => new Blob([t], {type: 'text/plain'}))})]);
      toast(msg || 'Copied to clipboard'); return await promise;
    }
  } catch (e) { console.warn('clipboard item failed, falling back', e); }
  const t = await promise; await copyText(t); return t;
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast('Copied to clipboard');
}
/* ---- big blocks by reference: a prompt's material or cards sit in a block with an id taken from its content
   (<<<SOURCE id=s-1a2b3c4d … SOURCE>>>). With the prompt saved as a file, the helper reads a block by its id
   (load_source("s-…"), Deck.load("r-…")), so Claude never has to retype it into code. */
const blockId = (prefix, body) => prefix + '-' + sha1hex(body).slice(0, 8);
function idBlock(tag, prefix, body){ const id = blockId(prefix, body); return {id, text: `<<<${tag} id=${id}\n${body}\n${tag}>>>`}; }
const PROMPT_FILE_MSG = 'Follow the instructions in the attached anki_prompt file. Read its blocks from the file by their id - never retype them.';
/** copy a prompt; with "As a file" on, save the whole prompt as a file to attach and copy a one-line message instead */
async function copyPrompt(t, msg){
  let asFile = false; try { asFile = !!SET.promptFile; } catch {}
  if (!asFile) return typeof t === 'string' ? copyText(t) : copyLater(t, msg);
  await copyText(PROMPT_FILE_MSG);   // first, while the click still counts as a user action
  const text = await t, id = (/<<<(?:SOURCE|REVISE_CARDS) id=(\S+)/.exec(text) || [])[1] || blockId('p', text);
  download(new Blob([text], {type: 'text/plain;charset=utf-8'}), `anki_prompt_${id}.txt`);
  toast(`Saved anki_prompt_${id}.txt - attach it and paste the copied message`, 4500);
  return text;
}
function b64ToBlob(b64, mime){ const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], {type: mime}); }
function blobToB64(blob){ return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); }); }
function sha1hex(str){
  const b = new TextEncoder().encode(str), l = b.length, wl = (((l + 8) >> 6) + 1) * 16, w = new Uint32Array(wl);
  for (let i = 0; i < l; i++) w[i >> 2] |= b[i] << (24 - (i % 4) * 8);
  w[l >> 2] |= 0x80 << (24 - (l % 4) * 8);
  w[wl - 1] = l * 8;
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const W = new Uint32Array(80);
  for (let i = 0; i < wl; i += 16){
    for (let t = 0; t < 16; t++) W[t] = w[i + t];
    for (let t = 16; t < 80; t++){ const x = W[t-3] ^ W[t-8] ^ W[t-14] ^ W[t-16]; W[t] = (x << 1) | (x >>> 31); }
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++){
      let f, k;
      if (t < 20){ f = (bb & c) | (~bb & d); k = 0x5A827999; }
      else if (t < 40){ f = bb ^ c ^ d; k = 0x6ED9EBA1; }
      else if (t < 60){ f = (bb & c) | (bb & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = bb ^ c ^ d; k = 0xCA62C1D6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + W[t]) >>> 0;
      e = d; d = c; c = ((bb << 30) | (bb >>> 2)) >>> 0; bb = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
}
function sanitizeInto(el, html){
  if (!window.DOMPurify) { el.textContent = String(html ?? ''); return; }
  const fragment = DOMPurify.sanitize(String(html ?? ''), {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  });
  const source = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const originals = [...source.querySelectorAll('img')];
  fragment.querySelectorAll('img').forEach((img, i) => {
    const value = originals[i]?.style.maxWidth || '';
    if (/^\d+(?:\.\d+)?(?:px|%|em|rem)$/.test(value)) img.style.maxWidth = value;
  });
  el.replaceChildren(fragment);
}

/* ====================================================================== state */
const S = {
  deck: 'AI Generated Deck', tags: [], cards: [], media: {}, curId: null,
  generalFeedback: '', prompt: {}, filter: 'all', q: '', order: 'source', deckFilter: '', batch: null, projectName: '', nodes: [], sources: [], scope: 'root'
};
const urlCache = new Map();  // filename -> objectURL
function mediaURL(name){
  const m = S.media[name]; if (!m) return null;
  // online version: an image stored in the account loads straight from it when shown (the browser caches it)
  if (!m.blob && m.remote && curProject) return `${Store.base}/api/${Store.pPath(curProject, 'media', name)}`;
  if (!m.blob) return null;
  if (!urlCache.has(name)) urlCache.set(name, URL.createObjectURL(m.blob));
  return urlCache.get(name);
}
function dropURL(name){ if (urlCache.has(name)){ URL.revokeObjectURL(urlCache.get(name)); urlCache.delete(name); } }
function setMediaBlob(name, blob, extra = {}, fresh = true){
  dropURL(name);
  const m = S.media[name] = Object.assign(S.media[name] || {origin:'upload'}, extra, {blob, error:null});
  if (fresh){ delete m.rv; delete m.rvNote; }   // new picture: its image review (approved / broken) starts again
}
const cardById = id => S.cards.find(c => c.id === id);
const curCard = () => cardById(S.curId);
const imgMemo = new WeakMap();   // card -> {src: [field strings], out}: the regex scan runs again only when a field changes
function cardImages(c){
  const fs = FIELDS[c.type] || [], src = fs.map(f => c[f]), hit = imgMemo.get(c);
  if (hit && hit.src.length === src.length && hit.src.every((v, i) => v === src[i])) return hit.out.slice();
  const out = [];
  for (const f of fs) for (const m of String(c[f] || '').matchAll(/<img[^>]*?src\s*=\s*["']([^"']+)["']/gi)) if (!out.includes(m[1])) out.push(m[1]);
  imgMemo.set(c, {src, out}); return out.slice();
}
function mediaState(name){
  if (/^(data:|https?:)/i.test(name)) return 'inline';
  const m = S.media[name];
  if (!m) return 'missing';
  if (m.blob || m.remote) return 'ok';
  if (m.origin === 'url') return m.error ? 'failed' : 'loading';
  if (m.origin === 'material') return 'snip';
  return 'missing';
}
/** the bytes of images that so far only exist in the account (for export, editing, packing) */
async function ensureMedia(names, st = S, pid = curProject){
  const todo = (names || Object.keys(st.media || {})).filter(n => st.media[n] && st.media[n].remote && !st.media[n].blob);
  let i = 0;
  const worker = async () => { while (i < todo.length){ const n = todo[i++];
    try { const bl = await Store.getBlob(Store.pPath(pid, 'media', n)); if (bl){ st.media[n].blob = bl; Store.uploaded.add(bl); } } catch {} } };
  await Promise.all(Array.from({length: Math.min(6, todo.length)}, worker));
  return todo.length;
}
const cardMissing = c => cardImages(c).some(n => !['ok','inline'].includes(mediaState(n)));
function nextId(){
  let n = 0; for (const c of S.cards){ const m = /^\D*(\d+)$/.exec(c.id); if (m) n = Math.max(n, +m[1]); }
  let id; do { n++; id = 'c' + String(n).padStart(3, '0'); } while (cardById(id)); return id;
}
/** source locations for the reference PDF: [{file, page, quote?, box?}] */
function normRefs(r){
  if (!r) return [];
  const arr = Array.isArray(r) && !(r.length && typeof r[0] !== 'object') ? r : [r];
  return arr.map(x => {
    if (Array.isArray(x)) x = {file: x[0], page: x[1], quote: x[2]};
    if (!x || typeof x !== 'object') return null;
    const o = {file: String(x.file || '').split(/[\\/]/).pop(), page: parseInt(x.page, 10) || 0};
    if (x.quote) o.quote = String(x.quote).slice(0, 300);
    if (Array.isArray(x.box) && x.box.length === 4) o.box = x.box.map(Number);
    return o.file || o.page ? o : null;
  }).filter(Boolean);
}
const cardDeck = c => c.deck || S.deck;
function normCard(raw){
  const c = {}; for (const [k, v] of Object.entries(raw)) c[k.toLowerCase()] = v;
  let type = String(c.type || '').toLowerCase();
  if (!['basic','cloze'].includes(type)) type = (c.text && /\{\{c\d+::/.test(c.text) && !c.front) ? 'cloze' : 'basic';
  const out = { id: String(c.id || '').trim() || null, type,
    front: String(c.front ?? ''), back: String(c.back ?? ''), text: String(c.text ?? ''),
    extra: String(c.extra ?? ''), source: String(c.source ?? ''),
    tags: Array.isArray(c.tags) ? c.tags.map(String) : String(c.tags || '').split(/[\s,]+/).filter(Boolean) };
  if (type === 'cloze' && !out.text && out.front) out.text = out.front;
  for (const k of ['front', 'back', 'text', 'extra']) out[k] = fixMath(out[k]);
  if (c.why && String(c.why).trim()) out.why = String(c.why).trim();
  if (typeof c.whyoncard === 'boolean') out.whyOnCard = c.whyoncard;
  if (c.deck) out.deck = String(c.deck);
  const refs = normRefs(c.refs ?? c.ref);
  if (refs.length) out.refs = refs;
  if (typeof c.ord === 'number') out.ord = c.ord;
  return out;
}

/* ---------------------------------------------------------------------- persistence (IndexedDB) */
const DB_NAME = 'anki-card-studio';
function idb(){ return new Promise((res, rej) => { const r = indexedDB.open(DB_NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbPut(key, val){ try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { console.warn('autosave failed', e); } }
async function idbGet(key){ try { const db = await idb(); return await new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch { return null; } }
/** run fn(objectStore) inside one read-write transaction; resolves with fn's result once committed */
async function idbTx(fn){
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); let out; Promise.resolve(fn(tx.objectStore('kv'))).then(v => { out = v; });
    tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
function mergeIndexLists(cur, mine){
  const by = new Map((cur || []).map(e => [e.id, e]));
  for (const e of mine || []){ const o = by.get(e.id); if (!o || (e.updated || 0) >= (o.updated || 0)) by.set(e.id, {...(o || {}), ...e}); }
  return [...by.values()];
}
/** every key that starts with `prefix` */
async function idbKeys(prefix){ try { const db = await idb(); return await new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')); r.onsuccess = () => res(r.result.map(String)); r.onerror = () => rej(r.error); }); } catch { return []; } }
async function idbDel(key){ try { const db = await idb(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); tx.oncomplete = res; tx.onerror = res; }); } catch {} }
function snapshot(){
  const media = {}; for (const [k, m] of Object.entries(S.media)) media[k] = {...m};
  return { deck: S.deck, tags: S.tags, cards: S.cards, media, curId: S.curId, generalFeedback: S.generalFeedback, prompt: S.prompt, order: S.order,
           batch: S.batch, projectName: S.projectName, nodes: S.nodes, sources: S.sources, scope: S.scope, whyAll: !!S.whyAll, version: 2 };
}

/* ---------------------------------------------------------------------- STORAGE: data folder via acs.py, else this browser */
const Store = {
  base: null, dataDir: '', status: 'browser',            // 'server' | 'browser' | 'blocked' | 'offline' (the online version, no connection)
  hosted: false, user: null,                             // hosted = the online service (account storage), not acs.py
  CHUNK: 3 * 1024 * 1024,                                // hosted requests stay under the 4.5 MB limit
  uploaded: new WeakSet(),
  get on(){ return this.status === 'server'; },
  get offline(){ return this.status === 'offline'; },
  defaultBase(){ let c = ''; try { c = (localStorage.getItem('acs-server') || '').trim().replace(/\/$/, ''); } catch {} return c || 'http://127.0.0.1:8765'; },
  async detect(){
    const ping = async b => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1200);
      try { const r = await fetch(b + '/api/ping', {signal: ctl.signal, cache: 'no-store'});
        if (r.status === 401 && b === location.origin){ signInAgain(true); return null; }
        if (r.ok){ const j = await r.json(); if (j && j.ok) return j; } } catch {} finally { clearTimeout(t); } return null; };
    const cands = [...new Set([/^https?:$/.test(location.protocol) ? location.origin : null, this.defaultBase()].filter(Boolean))];
    for (const b of cands){ const j = await ping(b); if (j){ this.base = b; this.dataDir = j.dataDir; this.status = 'server'; this.hosted = !!j.hosted; this.user = j.user || null;
      try { if (this.hosted){ localStorage.setItem('acs-hosted', location.origin); localStorage.setItem('acs-user', JSON.stringify(this.user)); } } catch {} return; } }
    // the online version, opened without a connection: don't fall back to browser-only storage (edits would never reach the
    // account). It works from the copies kept in this browser instead, and saves edits here until the connection is back.
    let wasHosted = false; try { wasHosted = localStorage.getItem('acs-hosted') === location.origin; } catch {}
    if (wasHosted){ this.status = 'offline'; this.hosted = true; this.base = location.origin;
      try { this.user = JSON.parse(localStorage.getItem('acs-user') || 'null'); } catch {} return; }
    // is a server running that refuses this page (an .html opened from disk)?
    try { const ctl = new AbortController(); setTimeout(() => ctl.abort(), 1200); await fetch(this.defaultBase() + '/api/ping', {mode: 'no-cors', signal: ctl.signal}); this.status = 'blocked'; }
    catch { this.status = 'browser'; }
  },
  enc: x => encodeURIComponent(x),
  async req(method, path, body, type){
    const r = await fetch(this.base + '/api/' + path, {method, body, cache: 'no-store', headers: body != null && type ? {'Content-Type': type} : {}});
    if (r.status === 401 && this.hosted){ signInAgain(); throw new Error('signed out - sign in again to keep saving'); }
    if (await accountRefused(r)) throw new Error(accountStatus() === 'readonly' ? 'read-only account' : 'account disabled');
    if (!r.ok && r.status !== 404) throw new Error(`${method} ${path}: HTTP ${r.status}`);
    return r;
  },
  /** a file; the hosted service splits big ones into pieces (each request under 4.5 MB) */
  async putBlob(path, blob, type){
    type = type || blob.type || 'application/octet-stream';
    if (!this.hosted || blob.size <= this.CHUNK) return this.req('PUT', path, blob, type);
    const n = Math.ceil(blob.size / this.CHUNK), upload = crypto.randomUUID();
    for (let i = 0; i < n; i++) await this.req('PUT', `${path}?chunk=${i}&chunks=${n}&upload=${upload}`, blob.slice(i * this.CHUNK, (i + 1) * this.CHUNK, type), type);
  },
  async getBlob(path){
    const r = await this.req('GET', path); if (r.status === 404) return null;
    if (r.headers.get('X-ACS-Chunked') !== '1') return r.blob();
    const meta = await r.json(), parts = [];
    for (let i = 0; i < meta.chunks; i++){ const p = await this.req('GET', `${path}?chunk=${i}`); if (!p.ok) return null; parts.push(await p.blob()); }
    return new Blob(parts, {type: meta.type || 'application/octet-stream'});
  },
  async getJSON(path){ const r = await this.req('GET', path); return r.status === 404 ? null : r.json(); },
  async putJSON(path, obj){ await this.req('PUT', path, JSON.stringify(obj), 'application/json'); },
  pPath(id, ...rest){ return ['project', id, ...rest].map(x => this.enc(x)).join('/'); },
  /* ---- the online version's copies in this browser, per account: the project list, each project's last version
     from the account, and edits not yet in the account
     ("pending": the edited state, the account's version it started from (the base of the 3-way merge when it goes up),
     and new images). A failed save keeps one, so closing the tab or losing the connection loses nothing. */
  offKey(k){ return 'off:' + ((this.user && this.user.login) || '') + ':' + k; },
  /** keep `st` for the account; `prev` = what this window kept (or loaded) last. Another tab of this browser may have
      kept its own edits of the project since: they are merged in (3-way over `prev`). -> {json, merged} */
  async keepPending(id, st, baseRev, base, prev){
    const key = this.offKey('pending:' + id), old = await idbGet(key);
    let out = plain(st), merged = null;
    if (old && old.json && prev){ const theirs = old.json; if (theirs !== JSON.stringify(prev)){ out = merge3(prev, out, JSON.parse(theirs)).merged; merged = out; } }
    // the older account version is the safer merge base (a newer one would hide changes made since the older one)
    if (old && old.base && (old.baseRev || 0) < (baseRev || 0)){ baseRev = old.baseRev; base = JSON.parse(old.base); }
    const blobs = {};
    for (const [n, m] of Object.entries(st.media || {})) if (m.blob && !this.uploaded.has(m.blob)) blobs[n] = m.blob;
    // images added in an earlier offline save (this tab's or another's) are still to be uploaded
    if (old && old.blobs) for (const [n, b] of Object.entries(old.blobs)) if (!blobs[n] && out.media && out.media[n]) blobs[n] = b;
    const json = JSON.stringify(out);
    await idbPut(key, {baseRev: baseRev || 0, base: JSON.stringify(base || null), json, blobs, savedAt: Date.now()});
    return {json, merged, blobs};
  },
  getPending(id){ return idbGet(this.offKey('pending:' + id)); },
  /** drop the kept edits - only if they are still `json` (another tab may have kept newer ones meanwhile) */
  dropPending(id, json){ const key = this.offKey('pending:' + id);
    return idbTx(os => new Promise(res => { const g = os.get(key); g.onsuccess = () => { if (g.result && (json == null || g.result.json === json)) os.delete(key); res(); }; g.onerror = () => res(); })).catch(() => {}); },
  async pendingIds(){ const pre = this.offKey('pending:'); return (await idbKeys(pre)).map(k => k.slice(pre.length)); },
  needsNet(){ return new Error('needs a connection - you are offline'); },
  async getIndex(){
    if (this.offline) return idbGet(this.offKey('projects'));
    if (!this.on) return idbGet('projects');
    const list = await this.getJSON('projects');
    if (this.hosted && Array.isArray(list)) idbPut(this.offKey('projects'), list);
    return list;
  },
  /** returns the merged list (other windows may have added / deleted projects) */
  async putIndex(list){
    if (this.offline){ const m = mergeIndexLists(await idbGet(this.offKey('projects')), list); await idbPut(this.offKey('projects'), m); return m; }
    if (this.on){ const r = await this.req('PUT', 'projects', JSON.stringify(list), 'application/json'); const m = await r.json();
      if (this.hosted && Array.isArray(m)) idbPut(this.offKey('projects'), m); return m; }
    return idbTx(os => new Promise(res => { const g1 = os.get('projects'), g2 = os.get('deletedProjects'); let cur, gone;
      g1.onsuccess = () => { cur = g1.result || []; if (gone) done2(); }; g2.onsuccess = () => { gone = new Set(g2.result || []); if (cur) done2(); };
      const done2 = () => { const m = mergeIndexLists(cur, list).filter(e => !gone.has(e.id)); os.put(m, 'projects'); res(m); }; }));
  },
  async getRev(id){
    if (this.offline) return null;
    if (this.on){ const r = await this.req('GET', this.pPath(id, 'rev')); if (r.status === 404) return null; return (await r.json()).rev || 0; }
    const st = await idbGet('project:' + id); return st ? (st.rev || 0) : null;
  },
  async getProject(id, known){
    if (this.offline){
      // the last version seen from the account (edits made since are applied on top: see resumePending)
      const c = await idbGet(this.offKey('project:' + id)); if (!c) return null;
      const st = typeof c.json === 'string' ? JSON.parse(c.json) : JSON.parse(JSON.stringify(c));
      for (const [n, m] of Object.entries(st.media || {})){ delete m.remote; if (known && known[n] && known[n].blob) m.blob = known[n].blob; else m.remote = true; }
      return st;
    }
    if (!this.on) return idbGet('project:' + id);
    let st = null, files = null;
    if (this.hosted){
      // a copy kept in this browser is used when the account still has the same revision (one tiny request)
      const [cached, rev, list] = await Promise.all([idbGet(this.offKey('project:' + id)), this.getRev(id).catch(() => null), this.getJSON(this.pPath(id, 'media')).catch(() => null)]);
      files = Array.isArray(list) ? new Set(list) : null;
      // kept as {rev, json}: storing one string is far cheaper than cloning the whole card graph into IndexedDB
      if (cached && rev != null && (cached.rev || 0) === rev) st = typeof cached.json === 'string' ? JSON.parse(cached.json) : JSON.parse(JSON.stringify(cached));
    }
    if (!st){ st = await this.getJSON(this.pPath(id)); if (!st) return null; if (this.hosted) idbPut(this.offKey('project:' + id), {rev: st.rev || 0, json: JSON.stringify(st)}); }
    for (const [n, m] of Object.entries(st.media || {})){
      delete m.remote;
      if (known && known[n] && known[n].blob){ m.blob = known[n].blob; continue; }
      // images load when they are shown (online version); the local server still downloads them up front
      if (this.hosted){ if (!files || files.has(n)) m.remote = true; }
    }
    if (!this.hosted) await ensureMedia(null, st, id);
    return st;
  },
  /** save unless someone else saved since `baseRev` -> {ok} | {conflict, rev} */
  /** restore = an explicit import: a project deleted earlier may come back */
  async putProject(id, st, baseRev, onProgress, restore){
    if (this.offline) return {offline: true};
    if (!this.on) return idbTx(os => new Promise(res => { const g = os.get('project:' + id);
      if (restore){ const d = os.get('deletedProjects'); d.onsuccess = () => os.put((d.result || []).filter(x => x !== id), 'deletedProjects'); }
      g.onsuccess = () => { const cur = g.result; if (baseRev != null && cur && (cur.rev || 0) !== baseRev) return res({conflict: true, rev: cur.rev || 0}); os.put(st, 'project:' + id); res({ok: true}); }; }));
    const meta = {...st, media: {}}, todo = [];
    for (const [n, m] of Object.entries(st.media || {})){
      const e = {...m}; delete e.blob; delete e.remote; meta.media[n] = e;
      if (m.blob && !this.uploaded.has(m.blob)) todo.push([n, m.blob]);
    }
    // new images go up 4 at a time (an import can bring hundreds)
    let next = 0, done = 0;
    const worker = async () => { while (next < todo.length){ const [n, bl] = todo[next++];
      await this.putBlob(this.pPath(id, 'media', n), bl); this.uploaded.add(bl); done++; if (onProgress && todo.length > 8) onProgress(done, todo.length); } };
    await Promise.all(Array.from({length: Math.min(4, todo.length)}, worker));
    const headers = {'Content-Type': 'application/json'}; if (baseRev != null) headers['X-ACS-Base-Rev'] = String(baseRev);
    if (restore) headers['X-ACS-Restore'] = '1';
    const json = JSON.stringify(meta); let body = json;
    // the online version: send it gzipped (cards compress ~10x: less mobile data, and big projects stay under 4.5 MB)
    if (this.hosted && typeof CompressionStream === 'function' && body.length > 20000){
      body = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).blob(); headers['X-ACS-Encoding'] = 'gzip';
    }
    const r = await fetch(this.base + '/api/' + this.pPath(id), {method: 'PUT', body, headers, cache: 'no-store'});
    if (r.status === 401 && this.hosted){ signInAgain(); throw new Error('signed out - sign in again to keep saving'); }
    if (r.status === 410) return {deleted: true};
    if (r.status === 409){ const j = await r.json().catch(() => ({})); return {conflict: true, rev: j.rev || 0}; }
    if (await accountRefused(r)) throw new Error(accountStatus() === 'readonly' ? 'this account is read-only (set by the admin)' : 'this account has been disabled');
    if (r.status === 413){ const j = await r.json().catch(() => ({})); throw new Error(j.error || 'storage limit reached'); }
    if (!r.ok) throw new Error(`save: HTTP ${r.status}`);
    if (this.hosted) idbPut(this.offKey('project:' + id), {rev: meta.rev || 0, json});
    return {ok: true, json};
  },
  async delProject(id){
    if (this.offline) throw this.needsNet();
    if (this.on) return this.req('DELETE', this.pPath(id));
    await idbTx(os => new Promise(res => { const g = os.get('deletedProjects'); g.onsuccess = () => { os.put([...new Set([...(g.result || []), id])], 'deletedProjects'); os.delete('project:' + id); res(); }; }));
  },
  /* sources: extracted pages as <sid>.json, original file as <sid>.<ext> */
  async putSource(pid, sid, data, blob){
    if (this.offline) throw this.needsNet();
    if (!this.on) return idbPut(`src:${pid}:${sid}`, {...data, blob: blob || null});
    await this.putBlob(this.pPath(pid, 'sources', sid + '.json'), new Blob([JSON.stringify(data)], {type: 'application/json'}));
    if (blob) await this.putBlob(this.pPath(pid, 'sources', sid + '.' + (data.ext || 'bin')), blob);
  },
  async getSource(pid, sid){ if (this.offline) throw this.needsNet(); if (!this.on){ const d = await idbGet(`src:${pid}:${sid}`); if (d){ const {blob, ...rest} = d; return rest; } return null; }
    const b = await this.getBlob(this.pPath(pid, 'sources', sid + '.json')); return b ? JSON.parse(await b.text()) : null; },
  async getSourceBlob(pid, sid, ext){
    if (this.offline) throw this.needsNet();
    if (!this.on){ const d = await idbGet(`src:${pid}:${sid}`); return d && d.blob; }
    return this.getBlob(this.pPath(pid, 'sources', sid + '.' + (ext || 'bin')));
  },
  async delSource(pid, sid, ext){
    if (this.offline) throw this.needsNet();
    if (!this.on) return idbDel(`src:${pid}:${sid}`);
    await this.req('DELETE', this.pPath(pid, 'sources', sid + '.json')); if (ext) await this.req('DELETE', this.pPath(pid, 'sources', sid + '.' + ext));
  },
  async getSettings(){ return this.on ? this.getJSON('settings') : null; },
  async putSettings(o){ if (this.offline){ try { localStorage.setItem(this.offKey('settings-pending'), '1'); } catch {} return; } if (this.on) await this.putJSON('settings', o); },
  async openFolder(sub){ if (this.on && !this.hosted) await this.req('POST', 'open' + (sub ? '?path=' + this.enc(sub) : '')); }
};
/** the hosted service's sign-in expired: send the user to sign in (now, on first load; else via a banner, so unsaved work stays) */
function signInAgain(now){
  const url = '/api/auth/signin?callbackUrl=' + encodeURIComponent(location.pathname + location.search);
  if (now){ location.href = url; return; }
  if (document.getElementById('signinBanner')) return;
  const b = document.createElement('div'); b.id = 'signinBanner'; b.className = 'note warn';
  b.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:90;max-width:min(560px,92vw);box-shadow:0 8px 30px rgba(0,0,0,.25)';
  b.innerHTML = `<b>You've been signed out.</b> Your changes are still in this tab. <a href="${url}" target="_blank" rel="noopener">Sign in again</a> (opens a new tab), then come back - saving resumes by itself.`;
  document.body.appendChild(b);
  const poll = setInterval(async () => { try { const r = await fetch('/api/ping', {cache: 'no-store'}); if (r.ok){ clearInterval(poll); b.remove(); toast('Signed in again'); if (sync.dirty) writeState(); } } catch {} }, 4000);
}
/** copy every project kept in this browser into the data folder (server mode) */
async function migrateBrowserProjects(ask){
  const list = await idbGet('projects') || [];
  const legacy = !list.length && await idbGet('state');
  const todo = list.length ? list : legacy ? [{id: 'p' + Date.now().toString(36), name: legacy.deck || 'Project 1', updated: Date.now(), _legacy: true}] : [];
  const fresh = todo.filter(p => !projects.some(x => x.id === p.id));
  if (!fresh.length){ if (ask) toast('No browser-only projects to copy'); return 0; }
  if (ask !== false && !confirm(Store.hosted ? `Copy ${fresh.length} project(s) kept in this browser into your account, so every device sees them?` : `Copy ${fresh.length} project(s) kept in this browser into the data folder?\n${Store.dataDir}`)) return 0;
  for (const p of fresh){
    const st = p._legacy ? legacy : await idbGet('project:' + p.id); if (!st) continue;
    await Store.putProject(p.id, st, undefined, undefined, true);
    for (const src of st.sources || []){ const d = await idbGet(`src:${p.id}:${src.id}`); if (d){ const {blob, ...rest} = d; await Store.putSource(p.id, src.id, rest, blob); } }
    const {_legacy, ...entry} = p; projects.push(entry);
  }
  await Store.putIndex(projects); renderProjects();
  toast(`Copied ${fresh.length} project(s) into ${Store.hosted ? 'your account' : 'the data folder'}`);
  return fresh.length;
}
function renderStorage(){
  const el = $('#storageInfo'); if (!el) return;
  if (Store.offline) el.innerHTML = `<span class="small">📡 <b>Offline.</b> Your changes are kept on this device${Store.user && Store.user.login ? ` (<b>@${esc(Store.user.login)}</b>)` : ''} and go to your account by themselves when you're back online. Sources, the Mac bridge and settings that live in the account need a connection.</span>`;
  else if (Store.hosted) el.innerHTML = `<span class="small">☁️ Saving to your account${Store.user && Store.user.login ? ` (<b>@${esc(Store.user.login)}</b>)` : ''}. Open this address on any device to pick up where you left off.</span>
    <div class="small muted">${/iphone|ipad/i.test(navigator.userAgent) ? 'On iPhone: Share → Add to Home Screen to install it.' : 'Use your browser\'s "Install app" / "Add to Home screen" to install it.'}</div>
    <div class="row" style="gap:6px"><button class="btn sm" id="btnMigrate" title="Copy projects that were saved in this browser before">⇪ Copy browser projects</button><a class="btn sm" href="/api/auth/signout" id="btnSignOut">Sign out</a></div>`;
  else if (Store.on) el.innerHTML = `<span class="small">📁 Saving to the data folder:</span><code class="small" style="word-break:break-all">${esc(Store.dataDir)}</code>
    <div class="row" style="gap:6px"><button class="btn sm" id="btnOpenFolder">Open folder</button><button class="btn sm" id="btnMigrate" title="Copy projects that were saved in this browser before">⇪ Copy browser projects</button></div>`;
  else if (Store.status === 'blocked') el.innerHTML = `<div class="note warn small">The ACS server is running, but this page was opened from a file, so it can't reach the data folder. Open <a href="${esc(Store.defaultBase())}/" target="_blank">${esc(Store.defaultBase())}</a> instead (or start it with <code>--allow-file-pages</code>). Saving in this browser for now.</div>`;
  else el.innerHTML = `<div class="note small">🌐 Saving in <b>this browser only</b>. To keep everything in a real folder shared by every copy of the Studio, run <code>uv run acs.py</code> (or <code>python3 acs.py</code>) and open <a href="${esc(Store.defaultBase())}/" target="_blank">${esc(Store.defaultBase())}</a>.</div>`;
  renderSyncInfo();
  const of = $('#btnOpenFolder'); if (of) of.onclick = () => Store.openFolder().catch(e => toast(e.message));
  const mg = $('#btnMigrate'); if (mg) mg.onclick = () => migrateBrowserProjects(true);
  const so = $('#btnSignOut'); if (so) so.onclick = e => { e.preventDefault(); signOutHere(); };
}
/** sign out: the copies this browser keeps for working offline go too (another person may use it next) */
async function signOutHere(){
  const left = await Store.pendingIds();
  if (left.length && !confirm(`${left.length} project(s) have changes that haven't reached your account yet. Signing out now discards them. Sign out anyway?`)) return;
  sync.closed = true; await saving;   // a save still running (or a retry) would write its copy back
  for (const k of [...await idbKeys(Store.offKey('')), ...await idbKeys('cache:project:')]) await idbDel(k);   // cache:project: = before per-account copies
  try { localStorage.removeItem('acs-user'); localStorage.removeItem('acs-hosted'); } catch {}
  try { if (window.caches) await caches.delete('acs-media'); } catch {}
  location.href = '/api/auth/signout';
}

