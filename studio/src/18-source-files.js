/* ====================================================================== SOURCE FILES FOR PROMPTS */
/* Prompts send the original files, not only their text: Claude has code execution, so it reads, renders and crops
   them itself. A batch part gets just its pages of a PDF - an excerpt whose page map is in the prompt and in the PDF's
   keywords (the helper's load_source() reads it, so refs keep the original file and page). Slides and Word files can't
   be cut in the browser: a part gets the whole file and is told which slides are its own. Pasted text and web pages
   have no file: their text stays in the prompt. Copy puts the prompt on the clipboard AND downloads the files. */
const PDF_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
const FILE_KINDS = new Set(['pdf', 'pptx', 'docx', 'html']);
function hasFile(src){ return FILE_KINDS.has(src.kind); }
/** [3,4,5,9] -> "3-5, 9" */
function fmtPages(list){
  const out = []; let a = null, b = null;
  for (const n of [...list].sort((x, y) => x - y)){ if (a !== null && n === b + 1){ b = n; continue; } if (a !== null) out.push(a === b ? `${a}` : `${a}-${b}`); a = b = n; }
  if (a !== null) out.push(a === b ? `${a}` : `${a}-${b}`);
  return out.join(', ');
}
/** a file name the server and the Mac bridge accept (lib/store.ts NAME_RE): "Lecture 1 – Café.pdf" -> "Lecture 1 - Cafe.pdf" */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+,=@#&'\-[\]]{0,180}$/;
function safeFileName(name, fallback = 'source'){
  const ext = (/\.[A-Za-z0-9]{1,8}$/.exec(name) || [''])[0];
  let stem = name.slice(0, name.length - ext.length).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[^A-Za-z0-9 ._()+,=@#&'\-[\]]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 160).trim();
  return (stem || fallback) + ext;
}
/** what a prompt attaches for [{src, pages}]: [{src, pages: [n…] | null (all), cut: a PDF excerpt, name}]. Names are
   always accepted by the server and never shared: a PDF whose own name isn't goes as a whole-file excerpt, so its page
   map still names the original file. */
function planAttachments(list){
  const used = new Set(['anki_prompt.txt', 'skill.md', 'anki_helper.py', 'extract.py', 'make_prompts.py', 'agents.md', 'anki_out', 'anki-skill', 'anki_blocks']);   // the bridge's own names too
  const unique = n => {
    const ext = (/\.[^.]+$/.exec(n) || [''])[0], stem = n.slice(0, n.length - ext.length);
    let out = n;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = `${stem} (${i})${ext}`;
    used.add(out.toLowerCase()); return out;
  };
  return list.filter(x => hasFile(x.src)).map(({src, pages}) => {
    const total = src.total || src.pages || 0, all = Array.from({length: total}, (_, i) => i + 1);
    const want = pages == null || pages === '' ? null : parseRanges(Array.isArray(pages) ? pages.join(',') : pages, all);
    const part = want && want.length && want.length < total ? want : null;
    const ok = FILE_NAME_RE.test(src.name) && !src.name.includes('..'), safe = safeFileName(src.name).replace(/\.{2,}/g, '.');
    if (part && src.kind === 'pdf')
      return {src, pages: part, cut: true, name: unique(`${safe.replace(/\.[^.]+$/, '')}_p${fmtPages(part).replace(/, /g, '_')}.pdf`)};
    // renamed: a PDF becomes an excerpt of all its pages (its page map keeps the original name); other kinds just get the name
    const cut = !ok && src.kind === 'pdf' && total > 0 && !part;
    return {src, pages: cut ? all : part, cut, whole: cut, name: unique(ok ? src.name : safe)};
  });
}
async function attachmentBlob(a){
  const blob = await Store.getSourceBlob(curProject, a.src.id, a.src.ext).catch(() => null);
  if (!blob) throw new Error(`the original file of ${a.src.name} isn't stored - add it again on Sources`);
  if (!a.cut) return blob;
  if (!window.PDFLib) await loadScript(PDF_LIB);
  const {PDFDocument} = window.PDFLib;
  const doc = await PDFDocument.load(await blob.arrayBuffer(), {ignoreEncryption: true}), out = await PDFDocument.create();
  for (const pg of await out.copyPages(doc, a.pages.map(p => p - 1))) out.addPage(pg);
  out.setTitle(`${a.src.name} p.${fmtPages(a.pages)}`);
  out.setSubject(`Pages ${fmtPages(a.pages)} of ${a.src.name}: page 1 here is ${a.src.name} p.${a.pages[0]}`);
  out.setKeywords([`acs-pages=${encodeURIComponent(a.src.name)}:${a.pages.join(',')}`]);   // read by the helper's load_source()
  return new Blob([await out.save()], {type: 'application/pdf'});
}
/** download every attachment (a short pause between them, so the browser keeps them all) */
async function downloadAttachments(atts){
  let ok = 0;
  for (const a of atts){
    try { download(await attachmentBlob(a), a.name); ok++; } catch (e) { toast(`${a.name}: ${e.message}`, 5000); }
    await new Promise(r => setTimeout(r, 350));
  }
  return ok;
}
const attachNames = atts => atts.map(a => a.name).join(', ');
/** the prompt section that describes the attached files (and carries the text of sources that have no file) */
async function materialSection(atts, textList, label){
  let s = '';
  if (atts.length){
    s += `## The material: attached files${label ? ` (${label})` : ''}
I attached the original file${atts.length > 1 ? 's' : ''}. Read ${atts.length > 1 ? 'them' : 'it'} with your code tools (pdf_info / pdf_text / pdf_figures / render_page_preview for PDFs; load_source() and office_images() for slides and Word files) and crop figures straight from ${atts.length > 1 ? 'them' : 'it'}:
${atts.map(a => `- **${a.name}**: ${a.whole ? `the whole of ${a.src.name}, renamed (same page numbers)` : a.cut ? `${a.pages.length > 1 ? 'pages' : 'page'} ${fmtPages(a.pages)} of ${a.src.name}${a.pages.length > 1 ? ', in order' : ''} (page 1 of the attachment is ${a.src.name} p.${a.pages[0]})` : `${a.name === a.src.name ? '' : `${a.src.name}, renamed: `}${a.pages ? `the whole file; this prompt covers only ${a.src.kind === 'pptx' ? 'slides' : 'pages'} ${fmtPages(a.pages)}` : 'the whole file'}`}.`).join('\n')}
- Each card's source and refs name the ORIGINAL file and page ("${atts[0].src.name} p.${(atts[0].pages || [1])[0]}"), never an excerpt's own page numbers. With the helper, \`deck.load_source(find_upload(${JSON.stringify(atts[0].name.replace(/\.[^.]+$/, ''))}))\` for each attachment reads its page map, so validate() checks every quote against the original pages; \`orig_page(path, n)\` turns page n of an excerpt into (file, page).
- If an attachment is missing, ask me for it before starting.`;
  }
  if (textList.length){
    const sb = idBlock('SOURCE', 's', await sourceBlock(textList));
    s += `${s ? '\n\n' : ''}## Source material${atts.length ? ' (text sources with no file)' : ''}
- Markers like [notes.txt p.2] give the source and section of the text that follows: use them for each card's Source and refs (copy quotes verbatim).
- With code execution: \`deck.load_source("${sb.id}")\` reads this block from the prompt saved as a file (an attachment, the working folder or Downloads), so never retype it. If no file has it, skip load_source (validate() then cannot check these quotes) and say so in your summary.
${sb.text}`;
  }
  return s;
}

/* ---- single prompt: Copy also downloads the files; "⬇ Source files" downloads them again */
function singleSourceList(){ return scopeSources().map(src => ({src, pages: null})); }
function renderAttachInfo(){
  const el = $('#pAttachInfo'); if (!el) return;
  const p = scopedPrompt(readPrompt()), atts = useStoredSources(p) ? planAttachments(singleSourceList()) : [];
  $('#btnSrcFiles').hidden = !atts.length;
  el.innerHTML = atts.length ? `📎 Copy also downloads <b>${atts.length}</b> file${atts.length > 1 ? 's' : ''} to attach with the prompt: ${esc(attachNames(atts))}` : '';
}
$('#btnSrcFiles').onclick = async () => { const n = await downloadAttachments(planAttachments(singleSourceList())); if (n) toast(`Downloaded ${n} file(s) - attach them with the prompt`); };
