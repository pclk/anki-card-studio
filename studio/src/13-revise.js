/* ====================================================================== REVISE */
function renderReviseSummary(){
  renderFmtPass();
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
  const names = new Set(ch.flatMap(cardImages));
  const media = [...names].filter(n => S.media[n]).map(n => { const m = S.media[n]; const e = {filename: n, origin: m.origin}; for (const k of ['url','hint','caption','credit']) if (m[k]) e[k] = m[k]; return e; });
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), cards: ch.map(c => cardForAI(c, true)), media};
  const others = S.cards.filter(c => c.status !== 'change' && c.status !== 'drop');
  let txt = promptMode() === 'skill'
  ? `Use the **anki** skill's revision workflow to revise my Anki cards based on my review feedback. Give me **anki_revision.json** (only changed, added or deleted cards).
For every card whose feedback is “I don't understand this card”: fix the card if its wording caused the confusion, and explain step by step why the card says what it says (start from what I already know, give each step's reason, add a small worked example where it helps). One or two short explanations can go in your reply; if there are more, or they are long, put them all in a markdown file **anki_explanations.md** (one section per card, with the card's question) and give me that file.
${gen ? `\n## General feedback (applies to the whole deck)\n${gen}\n` : ''}${checkerSection(promptMode())}${$('#rvMore').checked ? '\n## Also\nAdd new cards for important concepts from the material that the deck does not cover yet (new ids, continue the numbering).\n' : ''}
## Cards to revise (each has my "feedback")
<<<REVISE_CARDS
${JSON.stringify(block, null, 1)}
REVISE_CARDS>>>`
  : `Please revise my Anki cards based on my review feedback.

## Rules
- Keep each card's **id**. Return ONLY cards you changed or added (plus deletions) - not the whole deck. New cards need ids that are not in "existing_ids".
- To delete a card return \`{"id": "c007", "delete": true}\`. To split a card, keep the original id for one part and give new parts new ids with \`"after": "c007"\`.
- Keep following the original card-writing rules (ONE question per card - split any card that bundles several; descriptive back with answer → explanation → example/image, HTML with the aa-* classes). Keep each card's "why" (an extensive explanation in HTML: <p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>); give new and split cards one, and update it when a change alters what the card tests.
- Images I already have (listed under "media") can be reused by filename. For new or changed images use anki_helper.py as before; for a changed image give it a NEW filename.
- The block below is the CURRENT version of each card (it includes my own edits) - work from it, not from older versions.
- If you have code execution (load anki_helper.py again if needed): \`deck = Deck.load(r"""<the whole REVISE_CARDS block>""")\`, read \`deck.feedback\` / \`deck.show()\`, apply changes with deck.update(...), deck.add_basic(...), deck.add_cloze(...), deck.delete(...), run deck.validate() (ignore "registered but not used" for images I already have), then \`deck.save(revision=True)\` and give me **anki_revision.json** as a download.
- Otherwise output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block with "revision": true.
- For every card whose feedback is “I don't understand this card”: fix the card if its wording caused the confusion, and explain step by step why the card says what it says (start from what I already know, give each step's reason, add a small worked example where it helps). One or two short explanations can go in your reply; if there are more, or they are long, put them all in a markdown file **anki_explanations.md** (one section per card, with the card's question) and give me that file. (With the helper: deck.explain(id, markdown) for each, then deck.save_explanations(). Without file creation, put the markdown in one fenced block.)
- Then list each changed card in one line: what changed.
${gen ? `\n## General feedback (applies to the whole deck)\n${gen}\n` : ''}${checkerSection(promptMode())}${$('#rvMore').checked ? '\n## Also\nAdd new cards for important concepts from the material that the deck does not cover yet (new ids, continue the numbering).\n' : ''}
## Cards to revise (each has my "feedback")
<<<REVISE_CARDS
${JSON.stringify(block, null, 1)}
REVISE_CARDS>>>`;
  if ($('#rvContext').checked && others.length) txt += `\n\n## Other cards already in the deck (do not duplicate; change them only if the general feedback requires it)\n` + others.map(c => `${c.id}: ${cardTitle(c).slice(0, 110)}`).join('\n');
  $('#rvOut').value = txt;
};
/* ---- formatting pass: batches of cards sent to Claude for presentation-only fixes (see formatIssues) */
/* The queue lives on the cards: c.fmt = its prompt ("F3") while waiting for Claude (c.fmtSt 'todo' | 'copied'),
   c.fmtDone = the prompt that answered it. So it is saved and synced with the project like everything else. */
const FMT_LABEL = {outside_refs: 'outside references', unshown_code: 'unshown code', code_as_text: 'code as plain text', code_language: 'code without a language'};
function fmtCandidates(){
  const scope = $('#fmtScope').value, stf = $('#fmtStatus').value;
  return ordered(S.cards.filter(c => inScope(c) && c.status !== 'drop' && !c.fmt && (stf === 'any' || c.status === stf)
    && (scope === 'all' || formatIssues(c).length || (scope === 'flagok' && c.status === 'ok'))), S.order || 'source');
}
function fmtItems(){
  const m = new Map();
  for (const c of S.cards){ const id = c.fmt || c.fmtDone; if (!id) continue; if (!m.has(id)) m.set(id, []); m.get(id).push(c); }
  return [...m.entries()].map(([id, cards]) => ({id, cards, status: cards.some(c => c.fmt) ? (cards.some(c => c.fmt && c.fmtSt === 'copied') ? 'copied' : 'todo') : 'done'}))
    .sort((a, b) => (+a.id.slice(1) || 0) - (+b.id.slice(1) || 0));
}
const fmtNext = () => fmtItems().find(i => i.status === 'todo');
function fmtFinish(c){ c.fmtDone = c.fmt; delete c.fmt; delete c.fmtSt; }
function renderFmtPass(){
  if (!$('#fmtPanel')) return;
  const C = ck(), on = [...FMT_KEYS].filter(k => C[k] !== 'off');
  $('#fqUses').innerHTML = `Looks for, using the <a href="#" id="fqToCk">Checker</a>: ${on.length ? on.map(k => `<b>${FMT_LABEL[k]}</b> <span class="muted">(${C[k]})</span>`).join(', ') : '<span style="color:var(--warn)">nothing - all its checks are off</span>'}`;
  $('#fqToCk').onclick = e => { e.preventDefault(); showTab('checker'); };
  const cand = fmtCandidates(), size = +$('#fmtSize').value || 40;
  $('#fqBuildInfo').textContent = cand.length ? `${cand.length} card(s) → ${Math.ceil(cand.length / size)} prompt(s)` : 'no cards to add with these settings';
  $('#fqBuild').disabled = !cand.length;
  const items = fmtItems(); $('#fqPanel').hidden = !items.length;
  if (!items.length){ $('#fqStats').textContent = ''; return; }
  const n = items.length, cnt = k => items.filter(i => i.status === k).length, nx = fmtNext();
  $('#fqStats').textContent = `${n} prompts · ${cnt('copied') + cnt('done')} copied · ${cnt('done')} answered`;
  $('#fqProg').innerHTML = `<i style="width:${cnt('done') / n * 100}%;background:var(--ok)"></i><i style="width:${cnt('copied') / n * 100}%;background:var(--accent)"></i>`;
  $('#fqNextLabel').innerHTML = nx ? `next: <b>${items.indexOf(nx) + 1}. ${esc(nx.cards[0].id)} … ${esc(nx.cards[nx.cards.length - 1].id)}</b>` : '<span style="color:var(--ok)">all copied ✓</span>';
  $('#fqNext').disabled = !nx;
  $('#fqList').innerHTML = items.map((it, i) => {
    const tally = {}; for (const c of it.cards) for (const x of checksOf(c)) if (FMT_KEYS.has(x.key)) tally[x.key] = (tally[x.key] || 0) + 1;
    const ok = it.cards.filter(c => c.status === 'ok').length, rc = it.cards.filter(c => c.recheck).length;
    return `<div class="qi ${it.status} ${it === nx ? 'next' : ''}"><span class="n">${i + 1}</span>
      <div style="min-width:0"><div class="tt">${esc(it.cards[0].id)} … ${esc(it.cards[it.cards.length - 1].id)}</div>
      <div class="sub">${it.cards.length} cards · ${ok} approved${rc ? ` · ${rc} to re-check` : ''}${Object.keys(tally).length ? ' · ' + Object.entries(tally).map(([k, v]) => `${FMT_LABEL[k]} ${v}`).join(', ') : ''}</div></div>
      <div class="acts"><span class="pill ${it.status}">${{todo: 'to do', copied: 'copied', done: 'answered'}[it.status]}</span>
        <button class="btn sm" data-fq="view" data-id="${it.id}" title="Open the full prompt in a new tab">👁</button>
        <button class="btn sm" data-fq="copy" data-id="${it.id}" ${it.status === 'done' ? 'disabled' : ''}>📋</button>
        <button class="btn sm" data-fq="done" data-id="${it.id}" title="Toggle answered">✓</button></div></div>`; }).join('');
  const cur = $('#fqList .qi.next'); if (cur) cur.scrollIntoView({block: 'nearest'});
}
function fmtCopy(it){
  copyText(fmtPrompt(it.cards)); it.cards.forEach(c => { if (c.fmt) c.fmtSt = 'copied'; }); save(); renderFmtPass();
  toast(`Prompt ${fmtItems().findIndex(x => x.id === it.id) + 1} copied (${it.cards.length} cards)`);
}
$('#fqBuild').onclick = () => {
  const cand = fmtCandidates(), size = +$('#fmtSize').value || 40; if (!cand.length) return;
  let k = Math.max(0, ...S.cards.map(c => +String(c.fmt || c.fmtDone || 'F0').slice(1) || 0));
  for (let i = 0; i < cand.length; i += size){ const id = 'F' + (++k); cand.slice(i, i + size).forEach(c => { c.fmt = id; c.fmtSt = 'todo'; delete c.fmtDone; }); }
  save(); renderFmtPass(); toast(`Queue: ${Math.ceil(cand.length / size)} prompt(s)`);
};
$('#fqNext').onclick = () => { const nx = fmtNext(); if (nx) fmtCopy(nx); };
$('#fqList').addEventListener('click', e => {
  const b = e.target.closest('[data-fq]'); if (!b) return;
  const it = fmtItems().find(x => x.id === b.dataset.id); if (!it) return;
  if (b.dataset.fq === 'copy') fmtCopy(it);
  if (b.dataset.fq === 'view'){ const w = window.open(URL.createObjectURL(new Blob([fmtPrompt(it.cards)], {type: 'text/plain;charset=utf-8'})), '_blank'); if (!w) toast('Allow pop-ups to view the prompt'); }
  if (b.dataset.fq === 'done'){ if (it.status === 'done') it.cards.forEach(c => { c.fmt = c.fmtDone; c.fmtSt = 'copied'; delete c.fmtDone; }); else it.cards.forEach(fmtFinish); save(); renderFmtPass(); }
});
$('#fqReset').onclick = () => { if (!confirm('Mark every prompt as not copied (answered ones stay ticked)?')) return; S.cards.forEach(c => { if (c.fmt) c.fmtSt = 'todo'; }); save(); renderFmtPass(); };
$('#fqClear').onclick = () => { if (!confirm('Remove the formatting-pass queue? Cards and re-checks are not affected.')) return; S.cards.forEach(c => { delete c.fmt; delete c.fmtSt; delete c.fmtDone; }); save(); renderFmtPass(); };
async function fqApplied(r){ const s2 = summarize(r); $('#fqResult').innerHTML = s2.html; await applyRevisionResult(r, true); renderFmtPass(); }
wireDrop($('#fqDrop'), $('#fqFile'), async files => fqApplied(await importFiles(files, 'merge', {revision: true})));
$('#fqApply').onclick = async () => {
  const txt = $('#fqPaste').value.trim(); if (!txt) return toast('Paste the reply first');
  const {bundles, errors} = extractBundles(txt);
  await fqApplied({sums: bundles.map(b => applyBundle(b, 'merge', {revision: true})), imgs: 0, errors});
  if (bundles.length) $('#fqPaste').value = '';
};
document.addEventListener('keydown', e => {
  if (!$('#tab-revise').classList.contains('active') || $('#fqPanel').hidden) return;
  if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'n'){ e.preventDefault(); $('#fqNext').click(); }
});
['fmtScope', 'fmtStatus', 'fmtSize'].forEach(id => $('#' + id).onchange = renderFmtPass);
function fmtPrompt(cards){
  const names = new Set(cards.flatMap(cardImages));
  const media = [...names].filter(n => S.media[n]).map(n => { const m = S.media[n]; const e = {filename: n, origin: m.origin}; for (const k of ['url','hint','caption','credit']) if (m[k]) e[k] = m[k]; return e; });
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), media,
    cards: cards.map(c => { const o = cardForAI(c, false), iss = formatIssues(c);
      o.feedback = iss.length ? 'Formatting pass - the checks found: ' + iss.join(' ') : 'Formatting pass - no automatic flag: check it against the rules and leave it out unless something needs fixing.';
      return o; })};
  const rules = `This is a **formatting pass, not a content review**: I have already reviewed these cards.
- Do NOT change what a card tests, its answer, its "why", its images or its tags. Do not delete, merge or split cards.
- Fix only how the card is written:
  1. **Code:** statements and snippets go in a code block (\`<pre><code class="language-java">…</code></pre>\`, or \`code(src, "java")\` with anki_helper.py), never as plain text and never squeezed into one inline \`<code>\`. Names of classes, methods, variables and types go in inline \`<code>\`.
  2. **Self-contained:** the card must carry everything needed to answer it - the reader has no notes, slides or other cards. If the question depends on code, a definition or a figure (e.g. what a method it calls does), put it on the front, cut down to what matters. Remove references to the notes, slides, lectures or other cards.
  3. Maths as LaTeX (\\( … \\)), comparisons as tables, long answers as bullets.
- Each card's "feedback" says what the automatic checks found. They can be wrong: if a card is fine, leave it out.
- Return ONLY the cards you changed, with their ids unchanged. Then list each changed card in one line: what changed.`;
  return (promptMode() === 'skill'
    ? `Use the **anki** skill's revision workflow for a formatting pass on these Anki cards. Give me **anki_revision.json** with only the cards you changed.\n\n${rules}`
    : `Please do a formatting pass on these Anki cards. Output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block (JSON with "revision": true and a "cards" list; each card keeps its id, type and all its fields).\n\n${rules}`)
    + checkerSection(promptMode()) + `\n\n<<<REVISE_CARDS\n${JSON.stringify(block, null, 1)}\nREVISE_CARDS>>>`;
}

$('#btnCopyRevision').onclick = () => { if (!$('#rvOut').value) $('#btnMakeRevision').click(); if ($('#rvOut').value) copyText($('#rvOut').value); };
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

