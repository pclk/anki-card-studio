/* ====================================================================== PROMPT */
const helperSource = () => $('#helperSrc').textContent.replace(/^\n/, '');
const PROMPT_IDS = ['pTopic','pDeck','pCount','pLevel','pLang','pBasic','pCloze','pImgGen','pImgWeb','pImgMat','pOrder','pRefs','pInclSrc','pDetail','pTags','pExtra','pSplit','pMaxPages'];
function readPrompt(){
  const p = {}; for (const id of PROMPT_IDS){ const el = $('#' + id); p[id] = el.type === 'checkbox' ? el.checked : el.value; }
  p.pScript = ($('input[name=pScript]:checked') || {}).value || 'attach';
  p.pMode = ($('input[name=pMode]:checked') || {}).value || 'skill';
  p.pFlow = ($('#flowSeg button.on') || {dataset: {}}).dataset.flow || 'single'; return p;
}
function writePrompt(p){
  for (const id of PROMPT_IDS){ if (!(id in p)) continue; const el = $('#' + id); if (el.type === 'checkbox') el.checked = !!p[id]; else el.value = p[id]; }
  if (p.pScript) { const r = $(`input[name=pScript][value=${p.pScript}]`); if (r) r.checked = true; }
  { const r = $(`input[name=pMode][value=${p.pMode || 'skill'}]`); if (r) r.checked = true; }
  $$('#flowSeg button').forEach(b => b.classList.toggle('on', b.dataset.flow === (p.pFlow || 'single')));
}
const skillSource = () => $('#skillSrc').textContent.replace(/^\n/, '');
const promptMode = () => (S.prompt && S.prompt.pMode) || 'skill';
const STEPS = {
  skill: ['Install the <b>anki</b> skill once (button on the left).',
          'In Claude Code or a Claude chat, attach or point to your material, then paste the prompt.',
          'When Claude finishes, drop <b>anki_bundle.json</b> (it has the images) under the prompt, then review every card.'],
  other: ['Open a new chat. Attach your material and <b>anki_helper.py</b> (if the AI has code execution), then paste the prompt.',
          'When it finishes, download <b>anki_bundle.json</b> (has the images) - or copy the <code>&lt;&lt;&lt;ANKI_CARDS</code> block from the reply.',
          'Drop the file / paste the reply under the prompt, then review every card.']
};
function updateModeUI(mode){
  const skill = mode === 'skill';
  $('#skillNote').hidden = !skill; $('#pScriptWrap').hidden = skill;
  $('#btnCopyScript').hidden = skill; $('#btnDlScript').hidden = skill; $('#btnDlSkill2').hidden = !skill;
  $('#pSteps').innerHTML = STEPS[skill ? 'skill' : 'other'].map(t => `<li>${t}</li>`).join('');
  $('#rvMode').value = mode;
}
/* ---- checker settings: the Prompt page panel, and the section every prompt carries when they differ from the defaults */
function checkerSection(mode){
  const C = ck(), changed = CHECK_DEFS.filter(d => C[d.key] !== d.def);
  if (!changed.length) return '';
  if (mode === 'skill') return `\n## Checker settings\nRight after creating or loading the deck, call \`deck.configure_checks(${JSON.stringify(Object.fromEntries(changed.map(d => [d.key, C[d.key]])))})\` and write the cards to these limits.\n`;
  const say = d => d.kind === 'level' ? `${d.label}: ${{error: 'must be fixed', warn: 'fix unless clearly fine', off: 'ignore this check'}[C[d.key]]}`
    : `${d.label}: ${C[d.key] ? C[d.key] + ' ' + d.unit : 'no limit'}`;
  return `\n## Quality limits (these replace the defaults above)\n${changed.map(d => '- ' + say(d)).join('\n')}\n`;
}
function renderCheckSettings(){
  const C = ck(); let g = '', h = '';
  for (const d of CHECK_DEFS){
    if (d.group !== g){ g = d.group; h += `<h4>${esc(g)}</h4>`; }
    const ch = C[d.key] !== d.def;
    h += `<div class="ck-row"><label class="${ch ? 'ck-ch' : ''}" for="ck_${d.key}">${esc(d.label)}${ch ? ` <span class="small muted">(default ${esc(String(d.def))})</span>` : ''}</label>` + (d.kind === 'level'
      ? `<select id="ck_${d.key}" data-ck="${d.key}">${['error', 'warn', 'off'].map(v => `<option ${C[d.key] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`
      : `<div class="ck-num"><input type="number" min="0" step="1" id="ck_${d.key}" data-ck="${d.key}" value="${C[d.key]}"><span>${esc(d.unit)}</span></div>`)
      + `<details class="ck-how"><summary>What it looks for</summary>${esc(CHECK_HOW[d.key] || '')}</details></div>`;
  }
  h += `<h4>Studio</h4><div class="ck-row"><label>Image missing or not loaded</label><span class="small muted">always on</span><details class="ck-how"><summary>What it looks for</summary>${esc(CHECK_HOW.missing_img)}</details></div>`;
  $('#ckGrid').innerHTML = h;
  const n = CHECK_DEFS.filter(d => C[d.key] !== d.def).length;
  $('#ckSum').textContent = n ? `${n} changed from the defaults` : 'defaults';
  $('#tabCkCount').textContent = n ? String(n) : ''; $('#tabCkCount').hidden = !n;
  if ($('#pCkLine')) $('#pCkLine').innerHTML = `Checker: <b>${n ? n + ' setting' + (n === 1 ? '' : 's') + ' changed' : 'defaults'}</b>${n ? ' (sent with the prompt)' : ''} · <a href="#" id="pCkEdit">edit in Checker</a>`;
  if ($('#pCkEdit')) $('#pCkEdit').onclick = e => { e.preventDefault(); showTab('checker'); };
}
$('#ckGrid').addEventListener('change', e => {
  const el = e.target.closest('[data-ck]'); if (!el) return;
  const d = CHECK_DEFS.find(x => x.key === el.dataset.ck);
  const v = d.kind === 'level' ? el.value : Math.max(0, Math.round(+el.value || 0));
  SET.checks = {...ck(), [d.key]: v}; saveSettings(); renderCheckSettings(); buildPrompt();
  if ($('#tab-analytics.active')) renderAnalytics();
});
$('#ckReset').onclick = () => { SET.checks = {...CHECK_DEFAULTS}; saveSettings(); renderCheckSettings(); buildPrompt(); };
function buildSkillPrompt(p){
  const types = [p.pBasic && 'Basic', p.pCloze && 'Cloze'].filter(Boolean);
  const imgs = [p.pImgGen && 'generated diagrams & charts', p.pImgWeb && 'real photos from Wikimedia Commons', p.pImgMat && 'figures cropped from my material'].filter(Boolean);
  const set = [
    `Deck name: ${p.pDeck || 'AI Generated Deck'}`,
    `Number of cards: ${p.pCount ? 'about ' + p.pCount : 'as many as needed'}`,
    `Card types: ${types.length ? types.join(' and ') : 'Basic'}`,
    `Detail: ${p.pDetail}`,
    `Images: ${imgs.length ? imgs.join(', ') : 'none - text only'}`,
    p.pLevel && `Learner level: ${p.pLevel}`,
    p.pLang && p.pLang.trim().toLowerCase() !== 'english' && `Language: ${p.pLang}`,
    p.pTags && `Tags on every card: ${p.pTags}`,
    `Card order: ${p.pOrder ? 'anti-spoiler interleaved order (deck.set_order)' : 'as written'}`,
    `Source locations: ${p.pRefs ? 'yes - refs with file, page and a short exact quote on every card' : 'Source field only'}`
  ].filter(Boolean);
  return `Use the **anki** skill to make Anki cards.

## What to cover
${p.pTopic.trim() || 'Everything important in the attached material.'}

## Settings
${set.map(x => '- ' + x).join('\n')}
${p.pExtra.trim() ? '\n## Extra instructions\n' + p.pExtra.trim() + '\n' : ''}${checkerSection('skill')}
Give me **anki_bundle.json** (I'll import it into Anki Card Studio) and reply with only the skill's summary block.`;
}
/** single prompt in a sub-project targets that sub-deck */
function scopedPrompt(p){ const n = scopeNode(); return n ? {...p, pDeck: nodeDeckOf(n)} : p; }
const SOURCE_NOTE = (p, label, sb) => `- There are **no attachments of my files**: all the material is in "Source material" below, extracted from my files${label ? ` (${label})` : ''}. Markers like [L01.pdf p.12] give the file and page of the text that follows - use them for each card's Source${p.pRefs ? ' and refs (copy the quote verbatim from the text)' : ''}.
- You cannot crop figures from my files. Where a figure would help (see [figure] markers), add a "material" placeholder naming the exact file and page; generated diagrams and Wikimedia photos are fine.${sb ? `
- With code execution: \`deck.load_source("${sb.id}")\` reads the Source material from this prompt saved as a file (an attachment, the working folder or Downloads), so never retype it. If no file has it, skip load_source (validate() then cannot check quotes) and say so in your summary.` : ''}`;
const useStoredSources = p => p.pInclSrc && scopeSources().length > 0;
async function fullSinglePrompt(){
  const p = scopedPrompt(readPrompt());
  if (!useStoredSources(p)) return p.pMode === 'skill' ? buildSkillPrompt(p) : fullPrompt(p);
  const list = singleSourceList(), atts = planAttachments(list);
  if (atts.length){   // the original files go with the prompt (Copy downloads them); only file-less sources go as text
    const base = p.pMode === 'skill' ? buildSkillPrompt(p) : fullPrompt(p);
    return `${base}\n\n${await materialSection(atts, list.filter(x => !hasFile(x.src)))}`;
  }
  const p2 = {...p, pImgMat: false};
  const base = p.pMode === 'skill' ? buildSkillPrompt(p2) : fullPrompt(p2);
  const sb = idBlock('SOURCE', 's', await sourceBlock(list));
  return `${base}

## About the material
${SOURCE_NOTE(p, '', sb)}

## Source material
${sb.text}`;
}
function buildPrompt(){
  const p0 = readPrompt(); if (J(p0) !== J(S.prompt || {})){ S.prompt = p0; save(); }   // only a real change is saved
  updateModeUI(p0.pMode);
  const p = scopedPrompt(p0), srcs = scopeSources(), withSrc = useStoredSources(p);
  $('#pSrcInfo').textContent = srcs.length ? `(${srcs.length} source(s), ~${fmtK(tokEst(srcs.reduce((a, x) => a + x.chars, 0)))} tokens)` : '(none in this scope)';
  const atts = withSrc ? planAttachments(singleSourceList()) : [], noFiles = withSrc && !atts.length;
  let t = p.pMode === 'skill' ? buildSkillPrompt(noFiles ? {...p, pImgMat: false} : p) : fullPrompt(noFiles ? {...p, pImgMat: false} : p);
  if (atts.length) t += `\n\n## The material: attached files\n… which files are attached (${attachNames(atts)}) and how their pages map is added when you press Copy …`;
  else if (withSrc) t += `

## About the material
${SOURCE_NOTE(p)}

## Source material
<<<SOURCE
… the text of ${srcs.length} source(s) is added when you press Copy …
SOURCE>>>`;
  $('#pOut').value = t;
  if (typeof renderBatch === 'function') renderBatch();
  if (typeof renderAttachInfo === 'function') renderAttachInfo();
  return t;
}
function fullPrompt(p){
  const types = [p.pBasic && 'Basic', p.pCloze && 'Cloze'].filter(Boolean);
  if (!types.length) types.push('Basic');
  const detail = {
    concise: 'Back = the direct answer plus at most one short line of context. Images only where essential.',
    descriptive: 'Back = (1) the direct answer in one bold line, (2) a short explanation of WHY/HOW (2-4 sentences or bullets), (3) an example or application where relevant, (4) an image whenever a visual genuinely helps.',
    deep: 'Back = (1) the direct answer in one bold line, (2) the mechanism/explanation, (3) an example or application, (4) a comparison with easily-confused concepts, (5) a common pitfall or mnemonic where useful, (6) an image whenever a visual genuinely helps. Put secondary depth in Extra so the Back stays scannable.'
  }[p.pDetail];
  const imgLines = [];
  if (p.pImgGen) imgLines.push(`- **Generated diagrams/charts**: flowcharts for processes, concept maps for classifications, timelines, labelled versions of figures, plots of relationships/graphs. ${p.pScript === 'none' ? 'You have no code tool, so describe needed diagrams as "material" placeholders instead.' : 'Use the helper (deck.flowchart, deck.concept_map, deck.timeline, deck.labeled_image, or your own matplotlib figure via deck.figure).'}`);
  if (p.pImgWeb) imgLines.push(`- **Real photos/illustrations** (anatomy, specimens, places, people, objects, artworks…): use Wikimedia Commons ${p.pScript === 'none' ? '' : 'via deck.web_image(url, name, caption, credit) '}with URLs of the form \`https://commons.wikimedia.org/wiki/Special:FilePath/<Exact_File_Name.jpg>?width=800\`. Only use file names you are confident exist (search the web first if you can). My app downloads them; broken ones I'll replace myself.`);
  if (p.pImgMat) imgLines.push(`- **Figures from my material**: reuse the material's own diagrams/tables when they are the best visual. ${p.pScript === 'none' ? 'Register each as a "material" media item with a precise hint (file, page/slide, which figure) - I will screenshot and crop it myself.' : 'Crop them directly: pdf_figures(path) lists embedded figures, deck.pdf_figure(path, page, index) crops one, deck.crop_pdf(path, page, box) crops any region (box as page fractions - use render_page_preview() to check coordinates), deck.office_image() for .docx/.pptx, deck.add_image_file(path, box=…) for uploaded screenshots. If you cannot crop something reliably, use deck.material(name, hint) with a precise hint and I will snip it myself.'}`);

  const schema = `<<<ANKI_CARDS
{
 "format": "${FORMAT}",
 "deck": "${p.pDeck || 'AI Generated Deck'}",${p.pOrder ? `
 "order": ["c002", "c001"],` : ''}
 "cards": [
  {"id": "c001", "type": "basic",
   "front": "Why does …?",
   "back": "<div class=\\"aa-answer\\">Direct answer</div><div class=\\"aa-box aa-why\\"><div class=\\"aa-box-title\\">Why / how</div>Explanation…</div><figure class=\\"aa-fig\\"><img src=\\"heart_valves.png\\"><figcaption>Caption</figcaption></figure>",
   "extra": "<div class=\\"aa-box aa-mnemonic\\"><div class=\\"aa-box-title\\">Mnemonic</div>…</div>",
   "source": "lecture3.pdf p.12", "tags": ["valves"],
   "why": "<p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>"${p.pRefs ? `,
   "refs": [{"file": "lecture3.pdf", "page": 12, "quote": "the mitral valve sits between the left atrium"}]` : ''}},
  {"id": "c002", "type": "cloze",
   "text": "The {{c1::mitral}} valve sits between the {{c2::left atrium}} and left ventricle.",
   "extra": "<img src=\\"heart_valves.png\\">", "source": "p.12", "tags": [], "why": "…"}
 ],
 "media": [
  {"filename": "heart_valves.png", "origin": "url", "url": "https://commons.wikimedia.org/wiki/Special:FilePath/Heart_diagram-en.svg?width=800", "credit": "Wikimedia Commons"},
  {"filename": "wiggers.png", "origin": "material", "hint": "lecture3.pdf page 14 - the Wiggers diagram, whole figure"}
 ]
}
ANKI_CARDS>>>` + checkerSection('other');

  let workflow;
  if (p.pScript === 'none'){
    workflow = `## How to deliver
You have no code tool for this task. Write the cards yourself as JSON in exactly the format below. Every image you reference with <img src="…"> must appear in "media" with origin "url" (Wikimedia) or "material" (with a precise hint). If there are more than ~40 cards, split them over several consecutive <<<ANKI_CARDS … ANKI_CARDS>>> blocks (each a complete JSON object); I will paste them all.`;
  } else {
    const load = p.pScript === 'inline'
      ? 'The full source of anki_helper.py is at the end of this message. Save it to a file in your code environment (e.g. /tmp/anki_helper.py) and exec() it.'
      : 'I attached **anki_helper.py**. Load it in your code environment with:\n```python\nimport glob; exec(open(glob.glob("/mnt/**/anki_helper.py", recursive=True)[0]).read())\nhelp()\n```';
    workflow = `## How to work (use your code-execution tool)
${load}
1. Read my material first (list_uploads(), pdf_info(path), pdf_text(path, page), pdf_figures(path)). Plan the cards before writing them.
2. Create the deck: \`deck = Deck(${JSON.stringify(p.pDeck || 'AI Generated Deck')}${p.pTags ? ', tags=' + JSON.stringify(p.pTags.split(/\s+/).filter(Boolean)) : ''})\`
3. Make images with the helper (each call RETURNS the filename to use - extensions can change) and add cards with deck.add_basic(...) / deck.add_cloze(...), using the HTML helpers answer(), box(kind, html), img(name, caption), bullets(), table(). Give every card an extensive why=rationale(tests=…, matters=…, mistake=…, connects=…): 1-3 specific sentences per part (~60-150 words): what exactly it tests and what a full answer must show; why it matters (where it comes up - later topics, labs, exams, practice - and what goes wrong without it); the misconception it guards against; prerequisites and related cards. No generic filler.
   Call \`deck.load_source(...)\` with the material your refs point into, so quotes get checked: the file paths (no argument = every uploaded PDF), or the id of a <<<SOURCE block - never retype a block into code.
4. Run \`deck.validate()\`: fix every ERROR and look at every warn. Repeat until clean.
5. **Look at every image - not optional.** Run \`deck.contact_sheet()\` (and \`deck.preview_png()\` for the cards), then OPEN each PNG it prints with your image-viewing tool and check every image: elements overlapping or covering each other, anything cut off, unreadable text, wrong content. Redraw and look again until they are clean. validate() also reports overlaps it can measure and stays red until every new image has been on a contact sheet - but only your own look catches everything.
6. ${p.pOrder ? '\`deck.set_order(deck.suggest_order())\`, then \`deck.check_order()\`. ' : ''}Run \`deck.save()\`: it writes **anki_bundle.json** (cards + all images) - make sure I get it as a downloadable file.
7. Your whole reply is \`print(deck.summary(issues))\` - see "Final reply".
If code execution is unavailable, fall back to writing the JSON yourself in the format below.`;
  }

  let txt = `You are an expert educator and Anki card author. Create **highly descriptive, image-rich Anki flashcards** from the material I provide.

## What to cover
${p.pTopic.trim() || 'Everything important in the attached material.'}

## Settings
- Deck name: ${p.pDeck || 'AI Generated Deck'}
- Number of cards: ${p.pCount ? 'about ' + p.pCount : 'as many as needed to cover the key ideas thoroughly (no filler)'}
- Allowed card types: ${types.join(' and ')}${types.length > 1 ? ' - choose whichever suits each fact' : ''}
- Learner level: ${p.pLevel || 'not specified - assume a motivated student new to the topic'}
- Language: ${p.pLang || 'English'}${p.pTags ? `\n- Tags on every card: ${p.pTags}` : ''}

## Card-writing rules
1. **One question per card, rich answers.** Each card asks exactly ONE question and tests ONE idea, but the answer side teaches it. ${detail}
   - Never bundle several questions on one card: no numbered sub-questions, no "classify each of these statements", no back like "1 → A; 2 → C; 3 → B". Make one card per item, each restating the shared instructions so it stands alone (e.g. "\`Object[] o = intArray;\` (intArray is an Integer[]). Rejected at compile time, fails at run time, or compiles and runs?"). A single question whose answer is a list is fine.
2. **Specific, self-contained fronts.** No "it"/"this"/"the above"; name the subject. Prefer why/how/compare/apply questions over bare recall; include the key definitions, mechanisms, classifications, numbers and exceptions.
3. **Cloze cards** (${p.pCloze ? 'allowed' : 'NOT allowed'}): for definitions, sentences with key terms, short lists and formulas. 1-3 deletions per note; use separate numbers (c1, c2) for things to recall separately, the same number to hide them together; add a hint {{c1::answer::hint}} when the blank is ambiguous; never cloze trivial words. Put explanation and images in Extra.
4. **Images - only where they genuinely help** understanding or recall (no quota). Always give a figcaption saying what to look at. Never reuse an image as filler, and never put an image on a card if its labels give away another card's answer. Real photos are optional: if none suits the topic, leave them out; only use Wikimedia file names you have confirmed exist (search / open the file page) - never guess one. Sources:
${imgLines.join('\n') || '- (images disabled - text only)'}
5. **Source** field: where the fact comes from (file + page/slide) so I can verify it.
6. **Accuracy first.** Only state what the material supports or what is well-established; flag uncertainty in Extra. No duplicate cards. If the material contains an error, teach the correct value, add a "warning" box naming what the source printed, never cloze the wrong value, and list it under issues in your final reply.
7. **Formatting.** Fields are HTML. Allowed tags: b strong i em u s sub sup br hr p div span ul ol li table thead tbody tr th td pre code img figure figcaption mark small h3 h4 a blockquote kbd. Escape text: write &lt; &gt; &amp; (never a raw < or &).
   - **Never set colours or backgrounds** (no style="background:…" / "color:…"): cards are shown in light AND night mode, and a white/light background makes the text unreadable at night. The note type already styles everything.
   - **Code:** \`<pre><code class="language-java">…escaped code…</code></pre>\` (my app highlights it and bakes the colours in) - no styling of your own. Inline code: <code>…</code>.${ck().code_line_chars ? ` Keep every line of a code block at most ${ck().code_line_chars} characters - the width of my phone screen: break long lines (after a comma or operator, one chained call per line) and indent the continuation.` : ''}
   - **Maths:** LaTeX inside \\( … \\) (inline) or \\[ … \\] (display) - Anki renders it with MathJax. ($…$ / $$…$$ also work: the Studio converts them on import.) A cloze can go inside a formula, e.g. \\(x = {{c1::\\frac{1}{2} }}\\) - put a space between LaTeX's own closing braces so they never form }} before the cloze's end.
   - Styled blocks:
   - \`<div class="aa-answer">…</div>\` the one-line direct answer at the top of Back
   - \`<div class="aa-box aa-KIND"><div class="aa-box-title">Title</div>…</div>\` with KIND = ${BOX_KINDS.join(' | ')}
   - \`<figure class="aa-fig"><img src="FILENAME"><figcaption>…</figcaption></figure>\` for images (FILENAME only, no path)
${p.pOrder ? `8. **Anti-spoiler study order.** Keep the cards written grouped by topic, but after writing them choose a study order in which no card directly gives away the answer of a card shortly after it (e.g. a definition card right before the cloze of the same sentence). Interleave topics while keeping true prerequisites first. Record it as a top-level \`"order": [ids…]\`${p.pScript === 'none' ? '' : ' (helper: `deck.set_order([...])`)'}.
` : ''}${p.pRefs ? `${p.pOrder ? 9 : 8}. **Exact source locations.** Give every card \`"refs": [{"file": "lecture3.pdf", "page": 12, "quote": "5-15 words copied verbatim from that page"}]\`${p.pScript === 'none' ? '' : ' (helper: `ref=("lecture3.pdf", 12, "verbatim quote")` on add_basic/add_cloze)'}. Copy at least ~25 characters exactly as the source's text says them (a PDF's text layer; for markdown/web pages the rendered text without * # or backticks; for web pages use the URL as "file") - my app searches for it to show the source passage inside the card.
` : ''}${p.pExtra.trim() ? '\n## Extra instructions\n' + p.pExtra.trim() + '\n' : ''}
${workflow}

## Output format
Card ids must be unique (c001, c002, …). The JSON must be valid (escape quotes inside strings).
${schema}

## Final reply
${p.pScript === 'none' ? 'After the JSON block(s), end' : 'Reply'} with exactly this and nothing else:
\`\`\`
Deck generated: {deck name}
Total cards: {number of cards}
Number of Basic cards: {number}
Number of Cloze cards: {number}
Number of Images: {number}
Unexpected and unresolvable issues: {issues - only what you could not resolve, or None}
\`\`\``;
  if (p.pScript === 'inline') txt += `\n\n## anki_helper.py\n\`\`\`python\n${helperSource()}\n\`\`\``;
  return txt;
}
$('#tab-prompt').addEventListener('input', debounce(buildPrompt, 150));
$('#tab-prompt').addEventListener('change', buildPrompt);
$('#btnCopyPrompt').onclick = async () => {
  buildPrompt();
  const withSrc = useStoredSources(scopedPrompt(readPrompt())), atts = withSrc ? planAttachments(singleSourceList()) : [];
  await copyPrompt(fullSinglePrompt(), 'Prompt copied' + (withSrc && !atts.length ? ' (with source text)' : ''));
  // the second half of the prompt: its files, to attach in the same message
  if (atts.length && await downloadAttachments(atts)) toast(`Prompt copied + ${atts.length} file(s) downloaded - attach ${attachNames(atts)} and paste the prompt`, 5000);
};
$('#btnCopyScript').onclick = () => copyText(helperSource());
$('#btnDlScript').onclick = () => download(new Blob([helperSource()], {type: 'text/x-python'}), 'anki_helper.py');
async function downloadSkill(){
  if (!window.JSZip) return toast('JSZip did not load - are you online?');
  const z = new JSZip();
  z.file('anki/SKILL.md', skillSource());
  z.file('anki/scripts/anki_helper.py', helperSource());
  z.file('anki/scripts/extract.py', $('#extractSrc').textContent.replace(/^\n/, ''));
  z.file('anki/scripts/make_prompts.py', $('#promptsSrc').textContent.replace(/^\n/, ''));
  download(await z.generateAsync({type: 'blob', compression: 'DEFLATE'}), 'anki-skill.zip');
}
$('#btnDlSkill').onclick = downloadSkill; $('#btnDlSkill2').onclick = downloadSkill; $('#btnDlSkill3').onclick = downloadSkill;
$('#btnCopySkill').onclick = () => copyText(skillSource());
$('#rvMode').onchange = e => { const r = $(`input[name=pMode][value=${e.target.value}]`); if (r) r.checked = true; buildPrompt(); if ($('#rvOut').value) $('#btnMakeRevision').click(); };

