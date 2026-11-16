/* ====================================================================== BATCH (planning prompt + prompt queue) */
const PROMPTS_FORMAT = 'anki-studio/prompts-v1';
$('#flowSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('#flowSeg button').forEach(x => x.classList.toggle('on', x === b)); buildPrompt(); };
function splitText(p){
  const n = Math.max(1, +p.pMaxPages || 30);
  return {file: 'one prompt per file (per lecture / chapter); if a file is longer than ' + n + ' pages, split it into consecutive parts',
          topic: `by topic: group consecutive pages into coherent topics of at most ${n} pages each`,
          pages: `consecutive chunks of at most ${n} pages, breaking at natural section boundaries`}[p.pSplit || 'file'];
}
/** compact outline: first line of every page, so a planner can split without seeing the full text */
async function sourcesOutline(list){
  const out = [];
  for (const src of list){
    const pages = await loadSourcePages(src);
    out.push(`## ${src.name} (${pages.length} ${src.kind === 'pdf' || src.kind === 'pptx' ? 'pages' : 'sections'}, ~${fmtK(tokEst(src.chars))} tokens${src.node && src.node !== 'root' && nodeById(src.node) ? `, in sub-project "${nodeById(src.node).name}"` : ''})`);
    for (const pg of pages){ const first = (pg.text.split('\n').find(l => l.trim()) || '').slice(0, 90); out.push(`p.${pg.page}${pg.figure ? ' [fig]' : ''}: ${first}`); }
  }
  return out.join('\n');
}
async function planPromptStored(p){
  const root = p.pDeck || S.deck || 'AI Generated Deck', list = scopeSources();
  return `I want to turn a large amount of course material into Anki cards using many separate chats - one chat per part - so every part is covered thoroughly. Do NOT write any cards. Plan the split.

Below is an OUTLINE of my material: the first line of every page. My app holds the full text and will paste the right pages into each chat, so you only decide which pages go together.

## Settings
- Parent deck: ${root}
- Split: ${splitText(p)}
- What the cards should cover overall: ${p.pTopic.trim() || 'everything important'}${p.pExtra.trim() ? '\n- Also: ' + p.pExtra.trim() : ''}

## Output - JSON only, exactly this shape
<<<ANKI_PROMPTS
{"format": "${PROMPTS_FORMAT}", "deck_root": ${JSON.stringify(root)}, "items": [
  {"id": "L01", "title": "Lecture 1: …", "deck": ${JSON.stringify(root + '::L01 …')}, "focus": "1-3 sentences on what these cards should emphasise",${p.pCount ? ` "count": ${+p.pCount},` : ''}
   "sources": [{"file": "exact source name from the outline", "pages": "1-24"}]}
]}
ANKI_PROMPTS>>>
- Use the source names exactly as written after "##". Page ranges look like "1-12,15".
- Cover every page that has real content; skip only admin/title pages. Keep each item under ~40k tokens.
- Short ids (L01, L01b …): they become card-id prefixes.

## Outline
${await sourcesOutline(list)}`;
}
function planPrompt(p){
  const root = p.pDeck || 'AI Generated Deck';
  const goal = p.pTopic.trim() || 'Everything important in the attached material.';
  if (p.pMode === 'skill') return `Use the **anki** skill's **batch planning** workflow. Do not write any cards.

I've attached my course material. Split it into self-contained card-making prompts and give me **anki_prompts.json** for Anki Card Studio.

## Batch settings
- Parent deck: ${root} (each prompt gets a sub-deck like "${root}::L01 Title")
- Split: ${splitText(p)}
- What the cards should cover overall: ${goal}
- For each prompt write a short "focus" (1-3 sentences: what that part's cards should emphasise${p.pCount ? `; about ${p.pCount} cards per prompt` : ''}) and a clear title.${p.pExtra.trim() ? '\n- Also: ' + p.pExtra.trim() : ''}

Move the material with the skill's scripts (extract.py → plan.json → make_prompts.py) - don't retype it in your reply. Then tell me how many prompts there are and their rough sizes.`;
  return `I want to turn a large amount of course material into Anki cards using many separate chats - one chat per part - so that every part is covered thoroughly. Do NOT write any cards. Your job is to split the attached material into self-contained parts.

## Settings
- Parent deck: ${root}
- Split: ${splitText(p)}
- What the cards should cover overall: ${goal}${p.pExtra.trim() ? '\n- Also: ' + p.pExtra.trim() : ''}

## Output
JSON only, in this exact format (no commentary inside the block):
<<<ANKI_PROMPTS
{"format": "${PROMPTS_FORMAT}", "deck_root": ${JSON.stringify(root)}, "items": [
  {"id": "L01", "title": "Lecture 1: …", "deck": ${JSON.stringify(root + '::L01 …')}, "focus": "1-3 sentences on what to emphasise",
   "sources": [{"file": "L01.pdf", "pages": "1-24"}],
   "content": "[L01.pdf p.1]\\n…the text of page 1…\\n[L01.pdf p.2]\\n…"}
]}
ANKI_PROMPTS>>>

Rules for "content" - the next chats will see ONLY this text, no files:
- Include ALL of the part's substance: definitions, explanations, code (verbatim), examples, numbers, lists, tables (as text). Drop only boilerplate (title slides, repeated headers/footers, page numbers, slide-build duplicates).
- Put a marker like [L01.pdf p.12] before the text of each page, and write [figure: what it shows] where a page has an important diagram.
- Escape the JSON properly (\\n for newlines, \\" for quotes).
- If you can run Python, extract the text with code and build the JSON file programmatically instead of typing it, then give me anki_prompts.json as a file.
- If the output gets too long, split it over several complete <<<ANKI_PROMPTS … ANKI_PROMPTS>>> blocks (each a full JSON object with its own "items"); I'll paste them all.`;
}
async function itemContent(it){
  if (it.content) return it.content;
  const list = [];
  for (const s2 of it.sources || []){ const src = s2.sid ? (S.sources || []).find(x => x.id === s2.sid) : findSource(s2.file || s2.name); if (src) list.push({src, pages: s2.pages}); }
  return list.length ? sourceBlock(list) : '';
}
function itemChars(it){
  if (it.content) return it.content.length;
  return (it.sources || []).reduce((a, s2) => { const src = s2.sid ? (S.sources || []).find(x => x.id === s2.sid) : findSource(s2.file || s2.name); return a + (src ? charsFor(src, s2.pages) : 0); }, 0);
}
async function itemPromptFull(it, i, n){ return itemPrompt({...it, content: await itemContent(it)}, i, n); }
function itemPrompt(it, i, n){
  if (it.prompt) return it.prompt;
  const p = readPrompt();
  // no attachments in a batch chat: figures come from placeholders (see below), not cropping
  const p2 = {...p, pImgMat: false, pTopic: it.focus || `Everything important in the source material below${it.title ? ` (${it.title})` : ''}.`, pDeck: it.deck, pCount: it.count || p.pCount};
  const base = p.pMode === 'skill' ? buildSkillPrompt(p2) : fullPrompt(p2);
  const pre = it.id.replace(/[^A-Za-z0-9_]+/g, '');
  return `${base}

## This prompt: part ${i + 1} of ${n}${it.title ? ` - ${it.title}` : ''}
- Card ids: start every id with "${pre}-" (e.g. ${pre}-c001)${p.pMode === 'skill' ? `, i.e. \`Deck(${JSON.stringify(it.deck)}, id_prefix="${pre}-c")\`` : ''}.
- There are **no attachments**: all the material for this part is in "Source material" below, extracted from my files. Markers like [L01.pdf p.12] give the file and page of the text that follows - use them for each card's Source${p.pRefs ? ' and refs (copy the quote verbatim from the text)' : ''}.
- You cannot crop figures from my files. Where a figure from the material would help (see [figure] markers), add a "material" placeholder naming the exact file and page; generated diagrams and Wikimedia photos are fine.

## Source material
<<<SOURCE
${it.content || '(empty)'}
SOURCE>>>`;
}
function parsePromptSets(text){
  const blocks = [...text.matchAll(/<<<ANKI_PROMPTS([\s\S]*?)ANKI_PROMPTS>>>/g)].map(m => m[1]);
  const raw = blocks.length ? blocks : [text];
  const out = {root: '', items: []}, errors = [];
  for (const b of raw){
    try { const d = lenientJSON(b.trim()); if (!d || !Array.isArray(d.items)) throw new Error('no "items" array');
          if (d.deck_root) out.root = d.deck_root; out.items.push(...d.items); }
    catch (e) { errors.push(e.message); }
  }
  return {...out, errors};
}
function loadQueue(text){
  const {root, items, errors} = parsePromptSets(text);
  if (!items.length){ toast('No prompts found' + (errors.length ? ': ' + errors[0] : '')); return false; }
  const r = root || readPrompt().pDeck || S.deck || 'AI Generated Deck';
  const seen = new Set();
  const norm = items.map((x, i) => {
    let id = String(x.id || `P${String(i + 1).padStart(2, '0')}`).trim(); while (seen.has(id)) id += 'b'; seen.add(id);
    const title = String(x.title || '').trim();
    const deck = String(x.deck || `${r}::${(id + ' ' + title).trim().replace(/::/g, ' -')}`).trim();
    return {id, title, deck, focus: String(x.focus || ''), count: x.count || null, sources: x.sources || [], content: String(x.content || ''), prompt: x.prompt ? String(x.prompt) : '', status: 'todo', cards: 0, ...(x.node ? {node: x.node} : {})};
  });
  if (S.batch && S.batch.items.some(i => i.status !== 'todo') && !confirm(`Replace the current queue (${S.batch.items.length} prompts) with this one (${norm.length})?`)) return false;
  S.batch = {root: r, items: norm, loaded: Date.now()};
  syncTree();
  const unmatched = norm.filter(it => !it.content && !it.prompt && !itemChars(it));
  if (unmatched.length) toast(`${unmatched.length} prompt(s) have no text: their sources weren't found among this project's sources`, 5000);
  if (!S.cards.length) S.deck = r;
  save(); renderBatch(); toast(`Loaded ${norm.length} prompts`);
  return true;
}
wireDrop($('#qDrop'), $('#qFile'), async files => { loadQueue(await files[0].text()); });
$('#btnQPaste').onclick = () => { const t = $('#qPaste').value.trim(); if (t && loadQueue(t)){ $('#qPaste').value = ''; $('#qPasteWrap').open = false; } };
const qNext = () => S.batch && S.batch.items.find(i => i.status === 'todo');
async function copyItem(it){
  const i = S.batch.items.indexOf(it);
  await copyLater(itemPromptFull(it, i, S.batch.items.length), `Copied ${i + 1}/${S.batch.items.length}`);
  if (it.status === 'todo') it.status = 'copied';
  it.copiedAt = Date.now(); save(); renderBatch();
  toast(`Copied ${i + 1}/${S.batch.items.length}: ${it.title || it.id} - paste it into a NEW chat`, 2600);
}
$('#btnCopyNext').onclick = () => { const it = qNext(); if (it) copyItem(it); else toast('Every prompt has been copied'); };
$('#btnQReset').onclick = () => { if (!S.batch || !confirm('Mark every prompt as not copied (imported ones stay ticked)?')) return; S.batch.items.forEach(i => { if (i.status === 'copied') i.status = 'todo'; }); save(); renderBatch(); };
$('#btnQClear').onclick = () => { if (!S.batch || !confirm('Remove the prompt queue? (Cards already imported stay.)')) return; S.batch = null; save(); renderBatch(); };
$('#qList').addEventListener('click', e => {
  const b = e.target.closest('button[data-q]'); if (!b) return;
  const it = S.batch.items.find(i => i.id === b.dataset.id); if (!it) return;
  if (b.dataset.q === 'copy') copyItem(it);
  else if (b.dataset.q === 'done'){ it.status = it.status === 'done' ? 'copied' : 'done'; save(); renderBatch(); }
  else if (b.dataset.q === 'view'){ const w = window.open('', '_blank'); if (w){ w.document.title = it.title || it.id; const pre = w.document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = 'Loading…'; w.document.body.appendChild(pre); itemPromptFull(it, S.batch.items.indexOf(it), S.batch.items.length).then(t => pre.textContent = t); } }
});
/** tick off the queue item a bundle belongs to (by sub-deck, or by id prefix) */
function markBatch(d, sum, idMap){
  if (!S.batch || !d || d.revision) return;
  const ids = (d.cards || []).map(c => String(c.id || ''));
  const it = S.batch.items.find(i => i.deck === d.deck) || S.batch.items.find(i => ids.length && ids.every(x => x.startsWith(i.id.replace(/[^A-Za-z0-9_]+/g, '') + '-')));
  if (it){ it.status = 'done'; it.cards = (it.cards || 0) + (sum.added || 0); sum.batchItem = it.id;
    // matched by id prefix but the AI named the deck differently: file the cards under the prompt's sub-project
    if (d.deck !== it.deck && idMap) for (const raw of d.cards || []){ const c = cardById(idMap[raw.id] || raw.id); if (c && (!c.deck || c.deck === d.deck)) c.deck = it.deck; }
  }
}
wireDrop($('#qResDrop'), $('#qResFile'), async files => {
  const r = await importFiles(files, 'merge');
  const s = summarize(r);
  const hit = r.sums.filter(x => x.batchItem).map(x => x.batchItem), miss = r.sums.filter(x => !x.batchItem && x.added).length;
  $('#qResult').innerHTML = s.html + (hit.length ? `<div class="note ok small" style="margin-top:6px">Ticked off: ${hit.map(esc).join(', ')}</div>` : '') + (miss ? `<div class="note warn small" style="margin-top:6px">${miss} bundle(s) didn't match a prompt (different deck name) - imported anyway.</div>` : '');
  await afterImport(); renderBatch();
});
function renderBatch(){
  const p = readPrompt(), batch = p.pFlow === 'batch';
  $('#batchOpts').hidden = !batch; $('#singleOut').hidden = batch; $('#batchOut').hidden = !batch;
  $('#flowHint').textContent = batch ? 'e.g. 40 lecture PDFs → 40 prompts → 40 chats' : 'one chat with your material attached';
  if (!batch) return;
  const stored = planFromStored();
  $('#planOut').value = stored ? '(The planning prompt carries an outline of your ' + scopeSources().length + ' stored source(s) - press Copy to build it.)\n\n' + planPrompt(p).split('\n').slice(0, 3).join('\n') + '\n…' : planPrompt(p);
  const subsWith = S.nodes.filter(n => (S.sources || []).some(x => x.node === n.id)).length;
  $('#fromSubsInfo').textContent = subsWith ? `${subsWith} sub-project(s) with sources` : 'no sub-project has sources yet';
  $('#btnQueueFromSubs').disabled = !subsWith;
  $('#btnDlSkill3').hidden = p.pMode !== 'skill';
  $('#planHelp').innerHTML = p.pMode === 'skill'
    ? 'Paste into Claude (with the anki skill and code execution), attach <b>all</b> the material, and get back <b>anki_prompts.json</b>. Claude moves the text with scripts, so this stays cheap even for 40 lectures.<br><b>No AI needed</b> for one-prompt-per-file: <code>uv run extract.py *.pdf -o extract.json</code> then <code>uv run make_prompts.py --per-file extract.json --deck-root "' + esc(p.pDeck || 'Deck') + '" -o anki_prompts.json</code> (scripts are in the skill zip).'
    : '<span style="color:var(--warn)">Heavy on output tokens:</span> without the skill, the AI has to type all the material into the JSON. For large sources, prefer the Claude + skill mode or run the skill\'s extract.py / make_prompts.py yourself.';
  const b = S.batch; $('#qPanel').hidden = !b; $('#qDrop').querySelector('b').textContent = b ? 'Drop a new anki_prompts.json to replace the queue' : 'Drop anki_prompts.json here';
  if (!b){ $('#qStats').textContent = ''; return; }
  const n = b.items.length, cnt = k => b.items.filter(i => i.status === k).length, nx = qNext();
  $('#qStats').textContent = `${n} prompts · ${cnt('copied') + cnt('done')} copied · ${cnt('done')} imported`;
  $('#qProg').innerHTML = `<i style="width:${cnt('done') / n * 100}%;background:var(--ok)"></i><i style="width:${cnt('copied') / n * 100}%;background:var(--accent)"></i>`;
  $('#qNextLabel').innerHTML = nx ? `next: <b>${b.items.indexOf(nx) + 1}. ${esc(nx.title || nx.id)}</b>` : '<span style="color:var(--ok)">all copied ✓</span>';
  $('#btnCopyNext').disabled = !nx;
  const tok = it => Math.round((itemPrompt({...it, content: ''}, 0, n).length + itemChars(it)) / 4 / 100) / 10;
  $('#qList').innerHTML = b.items.map((it, i) => `<div class="qi ${it.status} ${it === nx ? 'next' : ''}">
    <span class="n">${i + 1}</span>
    <div style="min-width:0"><div class="tt">${esc(it.title || it.id)}</div><div class="sub">${esc(it.deck)} · ~${tok(it)}k tokens${it.sources && it.sources.length ? ' · ' + esc(it.sources.map(s => `${s.file}${s.pages ? ' p.' + s.pages : ''}`).join(', ')) : ''}${it.cards ? ` · ${it.cards} cards` : ''}</div></div>
    <div class="acts"><span class="pill ${it.status}">${{todo: 'to do', copied: 'copied', done: 'imported'}[it.status]}</span>
      <button class="btn sm" data-q="view" data-id="${esc(it.id)}" title="Open the full prompt in a new tab">👁</button>
      <button class="btn sm" data-q="copy" data-id="${esc(it.id)}">📋</button>
      <button class="btn sm" data-q="done" data-id="${esc(it.id)}" title="Toggle imported">✓</button></div></div>`).join('');
  const cur = $('#qList .qi.next'); if (cur) cur.scrollIntoView({block: 'nearest'});
}
const planFromStored = () => (($('input[name=planSrc]:checked') || {}).value || 'stored') === 'stored' && scopeSources().length > 0;
$('#btnCopyPlan').onclick = () => { const p = readPrompt(); if (planFromStored()) copyLater(planPromptStored(p), 'Planning prompt copied (outline of your sources)'); else copyText(planPrompt(p)); };
$$('input[name=planSrc]').forEach(r => r.onchange = () => renderBatch());
$('#btnQueueFromSubs').onclick = () => {
  const subs = S.nodes.filter(n => (S.sources || []).some(x => x.node === n.id));
  if (!subs.length) return toast('No sub-project has its own sources yet (Sources tab → owner column, or “each file in its own sub-project”)', 5000);
  const used = new Set();
  const items = subs.map(n => { let id = (n.name.match(/^([A-Za-z]{0,3}\d{1,3})/) || [])[1] || n.name.replace(/[^A-Za-z0-9]+/g, '').slice(0, 8) || 'P'; while (used.has(id)) id += 'b'; used.add(id);
    return {id, title: n.name, deck: nodeDeckOf(n), node: n.id, sources: S.sources.filter(x => x.node === n.id).map(x => ({sid: x.id, file: x.name}))}; });
  loadQueue(JSON.stringify({format: PROMPTS_FORMAT, deck_root: S.deck, items}));
};
document.addEventListener('keydown', e => {
  if (!$('#tab-prompt').classList.contains('active') || $('#batchOut').hidden || $('#qPanel').hidden) return;
  if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'n'){ e.preventDefault(); $('#btnCopyNext').click(); }
});

