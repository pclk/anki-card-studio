/* ====================================================================== REVISE */
function renderReviseSummary(){
  renderFmtPass(); renderBrokenImages();
  const ch = S.cards.filter(c => c.status === 'change'), un = S.cards.filter(c => c.status === 'new');
  $('#reviseSummary').innerHTML = !S.cards.length ? '<div class="note warn">No cards yet.</div>'
    : `<div class="note ${ch.length ? '' : 'warn'}"><b>${ch.length}</b> card(s) marked “Request change”${ch.filter(c => !c.feedback.trim()).length ? ` - <span style="color:var(--warn)">${ch.filter(c => !c.feedback.trim()).length} without a comment</span>` : ''}. ${un.length ? `${un.length} still unreviewed.` : ''}
       ${ch.length ? '<div class="small" style="margin-top:4px">' + ch.slice(0, 8).map(c => `<b>${esc(c.id)}</b>: ${esc(c.feedback || '(no comment)')}`).join('<br>') + (ch.length > 8 ? '<br>…' : '') + '</div>' : '<div class="small">Mark cards in Review, or just write general feedback below.</div>'}</div>`;
  $('#genFeedback').value = S.generalFeedback || '';
}
$('#genFeedback').oninput = e => { S.generalFeedback = e.target.value; save(); };
function cardForAI(c, withFeedback){
  const o = {id: c.id, type: c.type};
  for (const f of FIELDS[c.type]) o[f] = c[f];
  o.tags = c.tags;
  if (c.deck) o.deck = c.deck;
  if (c.refs && c.refs.length) o.refs = c.refs;
  if (c.why) o.why = c.why;
  if (withFeedback) o.feedback = c.feedback || '(no specific comment - improve it using the general feedback)';
  return o;
}
$('#btnMakeRevision').onclick = () => {
  const ch = S.cards.filter(c => c.status === 'change');
  const gen = $('#genFeedback').value.trim();
  if (!ch.length && !gen && !$('#rvMore').checked) return toast('Mark some cards as “Request change” or write general feedback first');
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), cards: ch.map(c => cardForAI(c, true)), media: mediaForAI(ch)};
  const others = S.cards.filter(c => c.status !== 'change' && c.status !== 'drop');
  const rb = idBlock('REVISE_CARDS', 'r', JSON.stringify(block, null, 1));
  let txt = promptMode() === 'skill'
  ? `Use the **anki** skill's revision workflow to revise my Anki cards based on my review feedback. Give me **anki_revision.json** (only changed, added or deleted cards). Load the cards with \`Deck.load("${rb.id}")\`.
For every card whose feedback is “I don't understand this card”: fix the card if its wording caused the confusion, and explain step by step why the card says what it says (start from what I already know, give each step's reason, add a small worked example where it helps). One or two short explanations can go in your reply; if there are more, or they are long, put them all in a markdown file **anki_explanations.md** (one section per card, with the card's question) and give me that file.
${gen ? `\n## General feedback (applies to the whole deck)\n${gen}\n` : ''}${checkerSection(promptMode())}${$('#rvMore').checked ? '\n## Also\nAdd new cards for important concepts from the material that the deck does not cover yet (new ids, continue the numbering).\n' : ''}
## Cards to revise (each has my "feedback")
${rb.text}`
  : `Please revise my Anki cards based on my review feedback.

## Rules
- Keep each card's **id**. Return ONLY cards you changed or added (plus deletions) - not the whole deck. New cards need ids that are not in "existing_ids".
- To delete a card return \`{"id": "c007", "delete": true}\`. To split a card, keep the original id for one part and give new parts new ids with \`"after": "c007"\`.
- Keep following the original card-writing rules (ONE question per card - split any card that bundles several; descriptive back with answer → explanation → example/image, HTML with the aa-* classes). Keep each card's "why" (an extensive explanation in HTML: <p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>); give new and split cards one, and update it when a change alters what the card tests.
- Images I already have (listed under "media") can be reused by filename. For new or changed images use anki_helper.py as before; for a changed image give it a NEW filename.
- The block below is the CURRENT version of each card (it includes my own edits) - work from it, not from older versions.
- If you have code execution (load anki_helper.py again if needed): \`deck = Deck.load("${rb.id}")\` (it reads the REVISE_CARDS block with that id from this prompt saved as a file (an attachment, the working folder or Downloads), so never retype the block; if it is not found, ask me to send the prompt as a file), read \`deck.feedback\` / \`deck.show()\`, apply changes with deck.update(...), deck.add_basic(...), deck.add_cloze(...), deck.delete(...), run deck.validate() (ignore "registered but not used" for images I already have), then \`deck.save(revision=True)\` and give me **anki_revision.json** as a download.
- Otherwise output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block with "revision": true.
- For every card whose feedback is “I don't understand this card”: fix the card if its wording caused the confusion, and explain step by step why the card says what it says (start from what I already know, give each step's reason, add a small worked example where it helps). One or two short explanations can go in your reply; if there are more, or they are long, put them all in a markdown file **anki_explanations.md** (one section per card, with the card's question) and give me that file. (With the helper: deck.explain(id, markdown) for each, then deck.save_explanations(). Without file creation, put the markdown in one fenced block.)
- Then list each changed card in one line: what changed.
${gen ? `\n## General feedback (applies to the whole deck)\n${gen}\n` : ''}${checkerSection(promptMode())}${$('#rvMore').checked ? '\n## Also\nAdd new cards for important concepts from the material that the deck does not cover yet (new ids, continue the numbering).\n' : ''}
## Cards to revise (each has my "feedback")
${rb.text}`;
  if ($('#rvContext').checked && others.length) txt += `\n\n## Other cards already in the deck (do not duplicate; change them only if the general feedback requires it)\n` + others.map(c => `${c.id}: ${cardTitle(c).slice(0, 110)}`).join('\n');
  $('#rvOut').value = txt;
};
/* ---- formatting pass and checker fixes: batches of cards sent to Claude to fix what the Checker found */
/* The queue lives on the cards: c.fmt = its prompt ("F3" formatting pass, "K3" checker fix) while waiting for Claude
   (c.fmtSt 'todo' | 'copied'), c.fmtJob = the Mac job it was sent to, c.fmtDone = the prompt that answered it. So it is saved and synced with the project like
   everything else. A card waits in one queue at a time. */
const FMT_LABEL = {outside_refs: 'outside references', unshown_code: 'unshown code', code_as_text: 'code as plain text', code_language: 'code without a language', code_line_chars: 'code lines too wide for a phone', unshown_math: 'unshown maths', math_as_text: 'maths as plain text', math_in_code: 'maths inside code',
  why: 'no "why"', why_min_words: 'short "why"', front_max_chars: 'long front', back_max_words: 'long answer', cloze_max_deletions: 'too many cloze numbers', multi_question: 'several questions', ref_page: 'source without a page', ref_quote_min_chars: 'short source quote'};
// q: the prefix of the queue's element ids; sel: its Which / Status / Size selects
const PASS = {
  F: {keys: FMT_KEYS, issues: formatIssues, prompt: cards => fmtPrompt(cards), q: 'fq', sel: 'fmt', name: 'Formatting', defSize: 40},
  K: {keys: FIX_KEYS, issues: fixIssues, prompt: cards => fixPrompt(cards), q: 'kq', sel: 'fix', name: 'Checker fix', defSize: 25}
};
const passOf = id => PASS[String(id || 'F')[0]] ? String(id || 'F')[0] : 'F';
/** the checks a pass looks for that are switched on (a limit of 0 is off; the "why" length follows the "why" check) */
const passOn = (kind, C = ck()) => [...PASS[kind].keys].filter(k => C[k] !== 'off' && C[k] !== 0 && !(k === 'why_min_words' && C.why === 'off'));
function fmtCandidates(kind = 'F'){
  const P = PASS[kind], scope = $('#' + P.sel + 'Scope').value, stf = $('#' + P.sel + 'Status').value;
  return ordered(S.cards.filter(c => inScope(c) && c.status !== 'drop' && !c.fmt && (stf === 'any' || c.status === stf)
    && (kind === 'K' ? checksOf(c).some(x => P.keys.has(x.key) && (scope !== 'err' || x.level === 'E'))
      : scope === 'all' || formatIssues(c).length || (scope === 'flagok' && c.status === 'ok'))), S.order || 'source');
}
function fmtItems(kind = 'F'){
  const m = new Map();
  for (const c of S.cards){ const id = c.fmt || c.fmtDone; if (!id || passOf(id) !== kind) continue; if (!m.has(id)) m.set(id, []); m.get(id).push(c); }
  return [...m.entries()].map(([id, cards]) => ({id, cards, status: cards.some(c => c.fmt) ? (cards.some(c => c.fmt && c.fmtSt === 'copied') ? 'copied' : 'todo') : 'done'}))
    .sort((a, b) => (+a.id.slice(1) || 0) - (+b.id.slice(1) || 0));
}
const fmtNext = (kind = 'F') => fmtItems(kind).find(i => i.status === 'todo');
function fmtFinish(c){ c.fmtDone = c.fmt; delete c.fmt; delete c.fmtSt; delete c.fmtJob; }
function renderFmtPass(){ for (const k of Object.keys(PASS)) renderPass(k); }
function renderPass(kind){
  const P = PASS[kind], q = id => $('#' + P.q + id);
  if (!q('List')) return;
  const C = ck(), on = passOn(kind, C), unit = k => (CHECK_DEFS.find(d => d.key === k) || {}).unit;
  q('Uses').innerHTML = `Looks for, using the <a href="#" data-to-ck>Checker</a>: ${on.length ? on.map(k => `<b>${FMT_LABEL[k]}</b> <span class="muted">(${typeof C[k] === 'number' ? C[k] + ' ' + unit(k) : k === 'why_min_words' ? C.why : C[k]})</span>`).join(', ') : '<span style="color:var(--warn)">nothing - all its checks are off</span>'}`;
  q('Uses').querySelector('[data-to-ck]').onclick = e => { e.preventDefault(); showTab('checker'); };
  const cand = fmtCandidates(kind), size = +$('#' + P.sel + 'Size').value || P.defSize;
  q('BuildInfo').textContent = cand.length ? `${cand.length} card(s) → ${Math.ceil(cand.length / size)} prompt(s)` : 'no cards to add with these settings';
  q('Build').disabled = !cand.length;
  const items = fmtItems(kind); q('Panel').hidden = !items.length;
  if (!items.length){ q('Stats').textContent = ''; return; }
  const n = items.length, cnt = k => items.filter(i => i.status === k).length, nx = fmtNext(kind);
  q('Stats').textContent = `${n} prompts · ${cnt('copied') + cnt('done')} copied · ${cnt('done')} answered`;
  q('Prog').innerHTML = `<i style="width:${cnt('done') / n * 100}%;background:var(--ok)"></i><i style="width:${cnt('copied') / n * 100}%;background:var(--accent)"></i>`;
  q('NextLabel').innerHTML = nx ? `next: <b>${items.indexOf(nx) + 1}. ${esc(nx.cards[0].id)} … ${esc(nx.cards[nx.cards.length - 1].id)}</b>` : '<span style="color:var(--ok)">all copied ✓</span>';
  q('Next').disabled = !nx;
  q('List').innerHTML = items.map((it, i) => {
    const tally = {}; for (const c of it.cards) for (const x of checksOf(c)) if (P.keys.has(x.key)) tally[x.key] = (tally[x.key] || 0) + 1;
    const ok = it.cards.filter(c => c.status === 'ok').length, rc = it.cards.filter(c => c.recheck).length;
    return `<div class="qi ${it.status} ${it === nx ? 'next' : ''}"><span class="n">${i + 1}</span>
      <div style="min-width:0"><div class="tt">${esc(it.cards[0].id)} … ${esc(it.cards[it.cards.length - 1].id)}</div>
      <div class="sub">${it.cards.length} cards · ${ok} approved${rc ? ` · ${rc} to re-check` : ''}${Object.keys(tally).length ? ' · ' + Object.entries(tally).map(([k, v]) => `${FMT_LABEL[k]} ${v}`).join(', ') : ''}</div></div>
      <div class="acts"><span class="pill ${it.status}">${{todo: 'to do', copied: 'copied', done: 'answered'}[it.status]}</span>
        <button class="btn sm" data-fq="view" data-id="${it.id}" title="Open the full prompt in a new tab">👁</button>
        <button class="btn sm" data-fq="copy" data-id="${it.id}" ${it.status === 'done' ? 'disabled' : ''}>📋</button>
        <button class="btn sm" data-fq="done" data-id="${it.id}" title="Toggle answered">✓</button></div></div>`; }).join('');
  const cur = q('List').querySelector('.qi.next'); if (cur) cur.scrollIntoView({block: 'nearest'});
}
function fmtCopy(it){
  const kind = passOf(it.id);
  copyPrompt(PASS[kind].prompt(it.cards)); it.cards.forEach(c => { if (c.fmt){ c.fmtSt = 'copied'; delete c.fmtJob; } }); save(); renderFmtPass();
  toast(`Prompt ${fmtItems(kind).findIndex(x => x.id === it.id) + 1} copied (${it.cards.length} cards)`);
}
/** a reply to a formatting / checker-fix prompt: shown in the queue of the prompt it answers */
async function fqApplied(r, kind = 'F'){ const s2 = summarize(r); $('#' + PASS[kind].q + 'Result').innerHTML = s2.html; await applyRevisionResult(r, true); renderFmtPass(); }
for (const [kind, P] of Object.entries(PASS)){
  const q = id => $('#' + P.q + id);
  if (!q('List')) continue;
  q('Build').onclick = () => {
    const cand = fmtCandidates(kind), size = +$('#' + P.sel + 'Size').value || P.defSize; if (!cand.length) return;
    // numbered per pass, so F3 and K3 can both exist
    let k = Math.max(0, ...S.cards.map(c => c.fmt || c.fmtDone).filter(id => id && passOf(id) === kind).map(id => +String(id).slice(1) || 0));
    for (let i = 0; i < cand.length; i += size){ const id = kind + (++k); cand.slice(i, i + size).forEach(c => { c.fmt = id; c.fmtSt = 'todo'; delete c.fmtDone; delete c.fmtJob; }); }
    save(); renderFmtPass(); toast(`Queue: ${Math.ceil(cand.length / size)} prompt(s)`);
  };
  q('Next').onclick = () => { const nx = fmtNext(kind); if (nx) fmtCopy(nx); };
  q('List').addEventListener('click', e => {
    const b = e.target.closest('[data-fq]'); if (!b) return;
    const it = fmtItems(kind).find(x => x.id === b.dataset.id); if (!it) return;
    if (b.dataset.fq === 'copy') fmtCopy(it);
    if (b.dataset.fq === 'view'){ const w = window.open(URL.createObjectURL(new Blob([P.prompt(it.cards)], {type: 'text/plain;charset=utf-8'})), '_blank'); if (!w) toast('Allow pop-ups to view the prompt'); }
    if (b.dataset.fq === 'done'){ if (it.status === 'done') it.cards.forEach(c => { c.fmt = c.fmtDone; c.fmtSt = 'copied'; delete c.fmtDone; }); else it.cards.forEach(c => { if (c.fmt) fmtFinish(c); }); save(); renderFmtPass(); }   // answered members keep their batch
  });
  q('Reset').onclick = () => { if (!confirm('Mark every prompt as not copied (answered ones stay ticked)?')) return; S.cards.forEach(c => { if (c.fmt && passOf(c.fmt) === kind) c.fmtSt = 'todo'; }); save(); renderFmtPass(); };
  q('Clear').onclick = () => { if (!confirm(`Remove the ${P.name.toLowerCase()} queue? Cards and re-checks are not affected.`)) return;
    S.cards.forEach(c => { if (passOf(c.fmt || c.fmtDone) === kind && (c.fmt || c.fmtDone)){ delete c.fmt; delete c.fmtSt; delete c.fmtDone; delete c.fmtJob; } }); save(); renderFmtPass(); };
  wireDrop(q('Drop'), q('File'), async files => fqApplied(await importFiles(files, 'merge', {revision: true}), kind));
  q('Apply').onclick = async () => {
    const txt = q('Paste').value.trim(); if (!txt) return toast('Paste the reply first');
    const {bundles, errors} = extractBundles(txt);
    await fqApplied({sums: bundles.map(b => applyBundle(b, 'merge', {revision: true})), imgs: 0, errors}, kind);
    if (bundles.length) q('Paste').value = '';
  };
  ['Scope', 'Status', 'Size'].forEach(x => $('#' + P.sel + x).onchange = renderFmtPass);
}
document.addEventListener('keydown', e => {
  if (!$('#tab-revise').classList.contains('active') || e.key.toLowerCase() !== 'n') return;
  if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  // the formatting queue first, then the checker fixes
  const kind = Object.keys(PASS).find(k => !$('#' + PASS[k].q + 'Panel').hidden && fmtNext(k)); if (!kind) return;
  e.preventDefault(); $('#' + PASS[kind].q + 'Next').click();
});
const mediaForAI = cards => [...new Set(cards.flatMap(cardImages))].filter(n => S.media[n]).map(n => { const m = S.media[n]; const e = {filename: n, origin: m.origin}; for (const k of ['url','hint','caption','credit']) if (m[k]) e[k] = m[k]; return e; });
function fmtPrompt(cards){
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), media: mediaForAI(cards),
    cards: cards.map(c => { const o = cardForAI(c, false), iss = formatIssues(c);
      o.feedback = iss.length ? 'Formatting pass - the checks found: ' + iss.join(' ') : 'Formatting pass - no automatic flag: check it against the rules and leave it out unless something needs fixing.';
      return o; })};
  const rules = `This is a **formatting pass, not a content review**: I have already reviewed these cards.
- Do NOT change what a card tests, its answer, its "why", its images or its tags. Do not delete, merge or split cards.
- Fix only how the card is written:
  1. **Code:** statements and snippets go in a code block (\`<pre><code class="language-java">…</code></pre>\`, or \`code(src, "java")\` with anki_helper.py), never as plain text and never squeezed into one inline \`<code>\`. Names of classes, methods, variables and types go in inline \`<code>\`.${ck().code_line_chars ? ` Keep every code-block line at most ${ck().code_line_chars} characters so it fits a phone: break long lines at natural points (after a comma or operator, one chained call per line, parameters on their own lines) and indent the continuation; never change what the code does.` : ''}
  2. **Maths:** formulas go in LaTeX - inline \\( … \\), display \\[ … \\] for multi-line or long ones (\\\\ line breaks, aligned, cases) - never as plain text (x^2, a_1, sqrt(x), a bare \\frac) and never inside \`<code>\`.
  3. **Self-contained:** the card must carry everything needed to answer it - the reader has no notes, slides or other cards. If the question depends on code, a definition, an equation or theorem it cites (e.g. "Eq. (3)", "Theorem 2") or a figure, put it on the front, cut down to what matters. Remove references to the notes, slides, lectures or other cards.
  4. Comparisons as tables, long answers as bullets.
- Each card's "feedback" says what the automatic checks found. They can be wrong: if a card is fine, leave it out.
- Return ONLY the cards you changed, with their ids unchanged. Then list each changed card in one line: what changed.`;
  const rb = idBlock('REVISE_CARDS', 'r', JSON.stringify(block, null, 1));
  return (promptMode() === 'skill'
    ? `Use the **anki** skill's revision workflow for a formatting pass on these Anki cards. Load them with \`Deck.load("${rb.id}")\` and give me **anki_revision.json** with only the cards you changed.\n\n${rules}`
    : `Please do a formatting pass on these Anki cards. Output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block (JSON with "revision": true and a "cards" list; each card keeps its id, type and all its fields).\n\n${rules}`)
    + checkerSection(promptMode()) + `\n\n${rb.text}`;
}
/** the checker-fix prompt: content fixes for exactly the problems the checks found (only the checks that are on) */
function fixPrompt(cards){
  const C = ck(), on = new Set(passOn('K', C));
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), media: mediaForAI(cards),
    cards: cards.map(c => { const o = cardForAI(c, false), iss = fixIssues(c);
      o.feedback = iss.length ? 'Checker fix - the checks found: ' + iss.join(' ') : 'Checker fix - the checks no longer flag this card: leave it out unless something needs fixing.';
      return o; })};
  const how = [
    (on.has('why') || on.has('why_min_words')) && `**No "why" / a short "why":** write the card's "why" as an extensive explanation in HTML (\`<p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>\`${promptMode() === 'skill' ? ', `why=rationale(...)` with anki_helper.py' : ''})${on.has('why_min_words') ? `, at least ${C.why_min_words} words` : ''}. Base it on what the card tests and the material.`,
    on.has('front_max_chars') && `**Front too long:** cut the front's prose to at most ${C.front_max_chars} characters (code blocks, inline code and maths are not counted). Keep everything needed to answer it; drop padding and background, or move background into the "why".`,
    on.has('back_max_words') && `**Answer too long:** cut the answer to at most ${C.back_max_words} words (code is not counted): the answer first, then the shortest explanation that makes it stick. Move background into the "why", or split the card if it really tests several things.`,
    on.has('cloze_max_deletions') && `**Too many cloze numbers:** at most ${C.cloze_max_deletions} per note. Split the note into several cloze notes, or hide related items under one number.`,
    on.has('multi_question') && `**Several questions on one card:** split it into one card per question. Keep the original id for the first part; give every other part a new id that is not in "existing_ids", \`"after": "<original id>"\` (\`after="…"\` with anki_helper.py), and its own "why".`,
    (on.has('ref_page') || on.has('ref_quote_min_chars')) && `**Source references:** give each reference ${[on.has('ref_page') && 'the page it is on', on.has('ref_quote_min_chars') && `a verbatim quote${on.has('ref_page') ? ' from that page' : ''} of at least ${C.ref_quote_min_chars} characters`].filter(Boolean).join(' and ')}. Take them only from the material: if you don't have it, leave the references as they are and say so.`
  ].filter(Boolean);
  const rules = `This is a **checker fix**: I have already reviewed these cards. Fix only the problems each card's "feedback" lists (found by the automatic checks).
- Keep what each card tests, keep its answer correct and complete, and keep its images and tags. Never delete or merge cards.
- How to fix each problem:
${how.map(x => '  - ' + x).join('\n')}
- Keep the card-writing rules (descriptive back, HTML with the aa-* classes, self-contained cards).
- The checks can be wrong: if a card is fine, leave it out.
- Return ONLY the cards you changed and any new parts of split cards, with the ids of existing cards unchanged. Then list each changed card in one line: what changed.`;
  const rb = idBlock('REVISE_CARDS', 'r', JSON.stringify(block, null, 1));
  return (promptMode() === 'skill'
    ? `Use the **anki** skill's revision workflow for a checker fix on these Anki cards. Load them with \`Deck.load("${rb.id}")\` and give me **anki_revision.json** with only the cards you changed or split off.\n\n${rules}`
    : `Please do a checker fix on these Anki cards. Output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block (JSON with "revision": true and a "cards" list; each card keeps its id, type, all its fields, "why" and "refs").\n\n${rules}`)
    + checkerSection(promptMode()) + `\n\n${rb.text}`;
}

$('#btnCopyRevision').onclick = () => { if (!$('#rvOut').value) $('#btnMakeRevision').click(); if ($('#rvOut').value) copyPrompt($('#rvOut').value); };
async function applyRevisionResult(r, quiet){
  const s = summarize(r); if (!quiet) $('#reviseResult').innerHTML = s.html;   // quiet: the formatting-pass queue shows it
  await afterImport();
  // a reply that only answers a formatting pass opens the Re-check view; one with ordinary revisions opens those
  if (s.ok && s.recheck && !s.plain){
    S.filter = 'recheck'; $('#filter').value = 'recheck'; S.curId = S.cards.find(c => c.recheck).id;
    toast(`Formatting pass applied - ${s.recheck || 'some'} approved card(s) to re-check`); renderFmtPass(); return;
  }
  if (s.ok) renderFmtPass();
  if (s.ok){ S.filter = 'new'; $('#filter').value = 'new'; const first = S.cards.find(c => c.revised && c.status === 'new'); if (first) S.curId = first.id; toast('Revision applied - review the revised cards'); }
}
wireDrop($('#reviseDrop'), $('#reviseFile'), async files => applyRevisionResult(await importFiles(files, 'merge', {revision: true})));
$('#btnApplyRevision').onclick = async () => {
  const txt = $('#reviseText').value.trim(); if (!txt) return toast('Paste the reply first');
  const {bundles, errors} = extractBundles(txt);
  const r = {sums: bundles.map(b => applyBundle(b, 'merge', {revision: true})), imgs: 0, errors};
  await applyRevisionResult(r);
  if (r.sums.length){ $('#reviseText').value = ''; }
};

