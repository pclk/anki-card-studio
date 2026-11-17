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
  if (c.skipped_checks && Object.keys(c.skipped_checks).length) o.skipped_checks = c.skipped_checks;
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
- A card's "skipped_checks" are checks you skipped on purpose earlier, with your reason: keep them, drop one your change makes unneeded (\`"skipped_checks": {}\` drops them all), or add one if a check is genuinely wrong for the changed card.
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
/* ---- checker fixes: batches of cards sent to Claude to fix what the picked Checker rules found */
/* The queue lives on the cards: c.fmt = its prompt ("Q3"; "F3" / "K3" come from the old separate formatting and checker-fix
   queues) while waiting for Claude (c.fmtSt 'todo' | 'copied'), c.fmtRules = the rules that prompt fixes, c.fmtJob = the Mac
   job it was sent to, c.fmtDone = the prompt that answered it. So it is saved and synced with the project like everything
   else. A card waits in one prompt at a time. */
const FMT_LABEL = {outside_refs: 'outside references', unshown_code: 'unshown code', code_as_text: 'code as plain text', code_language: 'code without a language', code_line_chars: 'code lines too wide for a phone', unshown_math: 'unshown maths', math_as_text: 'maths as plain text', math_in_code: 'maths inside code',
  why: 'no "why"', why_min_words: 'short "why"', front_max_chars: 'long front', back_max_words: 'long answer', cloze_max_deletions: 'too many cloze numbers', multi_question: 'several questions', ref_page: 'source without a page', ref_quote_min_chars: 'short source quote'};
/** the built-in rule presets; your own are SET.fixPresets. Rules that are all formatting make a formatting pass: Claude may not touch the content */
const FIX_PRESETS = [
  {name: 'Formatting', rules: [...FMT_KEYS]},
  {name: 'Others', rules: [...FIX_KEYS]},
  {name: 'Everything', rules: FIX_RULES},
  {name: 'Code', rules: ['unshown_code', 'code_as_text', 'code_language', 'code_line_chars']},
  {name: 'Maths', rules: ['unshown_math', 'math_as_text', 'math_in_code']},
  {name: 'Length', rules: ['front_max_chars', 'back_max_words', 'cloze_max_deletions', 'multi_question']},
  {name: 'Sources', rules: ['ref_page', 'ref_quote_min_chars']}
];
const fixPresets = () => [...FIX_PRESETS, ...(SET.fixPresets || []).map(p => ({...p, own: true}))];
const sameRules = (a, b) => a.length === b.length && a.every(k => b.includes(k));
const rulesName = rules => (fixPresets().find(p => sameRules(p.rules, rules)) || {name: `${rules.length} rule${rules.length === 1 ? '' : 's'}`}).name;
/** the rules picked on the Revise tab, in the Checker's order */
const pickedRules = () => FIX_RULES.filter(k => (SET.fixRules || []).includes(k));
/** the ones the Checker has switched on (a limit of 0 is off; the "why" length follows the "why" check) */
const rulesOn = (rules, C = ck()) => rules.filter(k => C[k] !== 'off' && C[k] !== 0 && !(k === 'why_min_words' && C.why === 'off'));
const formattingOnly = rules => rulesOn(rules).every(k => FMT_KEYS.has(k));
/** a queued prompt's rules, saved on its cards (the old queues had fixed ones); cards not queued use the picked rules */
function itemRules(cards){
  const c = cards.find(x => Array.isArray(x.fmtRules)); if (c) return FIX_RULES.filter(k => c.fmtRules.includes(k));
  const id = String((cards[0] && (cards[0].fmt || cards[0].fmtDone)) || '');
  return id[0] === 'K' ? [...FIX_KEYS] : id[0] === 'F' ? [...FMT_KEYS] : pickedRules();
}
const issuesFor = (c, rules) => checksOf(c).filter(x => rules.includes(x.key));
function fmtCandidates(rules = rulesOn(pickedRules())){
  const scope = $('#fixScope').value, stf = $('#fixStatus').value;
  if (!rules.length) return [];
  return ordered(S.cards.filter(c => inScope(c) && c.status !== 'drop' && !c.fmt && (stf === 'any' || c.status === stf)
    && (scope === 'all' || (scope === 'flagok' && c.status === 'ok') || issuesFor(c, rules).some(x => scope !== 'err' || x.level === 'E'))), S.order || 'source');
}
const fmtNum = id => +String(id).slice(1) || 0;
function fmtItems(){
  const m = new Map();
  for (const c of S.cards){ const id = c.fmt || c.fmtDone; if (!id) continue; if (!m.has(id)) m.set(id, []); m.get(id).push(c); }
  return [...m.entries()].map(([id, cards]) => ({id, cards, status: cards.some(c => c.fmt) ? (cards.some(c => c.fmt && c.fmtSt === 'copied') ? 'copied' : 'todo') : 'done'}))
    .sort((a, b) => fmtNum(a.id) - fmtNum(b.id) || a.id.localeCompare(b.id));
}
const fmtNext = () => fmtItems().find(i => i.status === 'todo');
function fmtFinish(c){ c.fmtDone = c.fmt; delete c.fmt; delete c.fmtSt; delete c.fmtJob; }
const ruleSetting = (k, C) => typeof C[k] === 'number' ? C[k] + ' ' + (CHECK_DEFS.find(d => d.key === k) || {}).unit : k === 'why_min_words' ? C.why : C[k];
function renderRulePicker(picked, C){
  $('#fxPresets').innerHTML = fixPresets().map((p, i) => `<button class="btn sm ${sameRules(p.rules, picked) ? 'on' : ''}" data-preset="${i}" title="${esc(p.rules.map(k => FMT_LABEL[k]).join(', '))}">${esc(p.name)}${p.own ? `<span class="fx-rm" data-rm-preset="${i}" title="Delete this preset">✕</span>` : ''}</button>`).join('')
    + `<button class="btn sm" id="fxSave" title="Save the rules ticked below as a preset of your own" ${picked.length ? '' : 'disabled'}>＋ Save as preset</button>`;
  let g = '', h = '';
  for (const k of FIX_RULES){
    const d = CHECK_DEFS.find(x => x.key === k), off = !rulesOn([k], C).length;
    if (d.group !== g){ h += `${g ? '</div>' : ''}<div class="fx-g"><h4>${esc(d.group)}</h4>`; g = d.group; }
    h += `<label class="check small" title="${esc(d.label)}"><input type="checkbox" data-rule="${k}" ${picked.includes(k) ? 'checked' : ''}> <span>${esc(FMT_LABEL[k])} <span class="muted">(${off ? 'off in the Checker' : esc(String(ruleSetting(k, C)))})</span></span></label>`;
  }
  $('#fxRules').innerHTML = h + '</div>';
}
function renderFmtPass(){
  if (!$('#fqList')) return;
  const C = ck(), picked = pickedRules(), on = rulesOn(picked, C);
  renderRulePicker(picked, C);
  $('#fqUses').innerHTML = `Looks for, using the <a href="#" data-to-ck>Checker</a>: ${on.length ? on.map(k => `<b>${FMT_LABEL[k]}</b> <span class="muted">(${esc(String(ruleSetting(k, C)))})</span>`).join(', ') : `<span style="color:var(--warn)">nothing - ${picked.length ? 'the picked rules are all off in the Checker' : 'pick some rules'}</span>`}`
    + (on.length ? `<div class="muted" style="margin-top:2px">${formattingOnly(on) ? '<b>Formatting only:</b> Claude changes how the cards are written, never what they test, and never splits them.' : 'Claude may rewrite content to fix these, and splits cards that bundle several questions (the new parts come in as <i>Unreviewed</i>).'}</div>` : '');
  $('#fqUses').querySelector('[data-to-ck]').onclick = e => { e.preventDefault(); showTab('checker'); };
  const cand = fmtCandidates(on), size = +$('#fixSize').value || 25;
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
    const rules = itemRules(it.cards), tally = {};
    for (const c of it.cards) for (const x of issuesFor(c, rules)) tally[x.key] = (tally[x.key] || 0) + 1;
    const ok = it.cards.filter(c => c.status === 'ok').length, rc = it.cards.filter(c => c.recheck).length;
    return `<div class="qi ${it.status} ${it === nx ? 'next' : ''}"><span class="n">${i + 1}</span>
      <div style="min-width:0"><div class="tt">${esc(it.cards[0].id)} … ${esc(it.cards[it.cards.length - 1].id)} <span class="muted small">· ${esc(rulesName(rules))}</span></div>
      <div class="sub">${it.cards.length} cards · ${ok} approved${rc ? ` · ${rc} to re-check` : ''}${Object.keys(tally).length ? ' · ' + Object.entries(tally).map(([k, v]) => `${FMT_LABEL[k]} ${v}`).join(', ') : ''}</div></div>
      <div class="acts"><span class="pill ${it.status}">${{todo: 'to do', copied: 'copied', done: 'answered'}[it.status]}</span>
        <button class="btn sm" data-fq="view" data-id="${it.id}" title="Open the full prompt in a new tab">👁</button>
        <button class="btn sm copyBtn" data-fq="copy" data-id="${it.id}" ${it.status === 'done' ? 'disabled' : ''}>📋</button>
        <button class="btn sm" data-fq="done" data-id="${it.id}" title="Toggle answered">✓</button></div></div>`; }).join('');
  const cur = $('#fqList').querySelector('.qi.next'); if (cur) cur.scrollIntoView({block: 'nearest'});
}
function fmtCopy(it){
  copyPrompt(fixPrompt(it.cards)); it.cards.forEach(c => { if (c.fmt){ c.fmtSt = 'copied'; delete c.fmtJob; } }); save(); renderFmtPass();
  toast(`Prompt ${fmtItems().findIndex(x => x.id === it.id) + 1} copied (${it.cards.length} cards)`);
}
/** a reply to a checker-fix prompt: shown under the queue */
async function fqApplied(r){ const s2 = summarize(r); $('#fqResult').innerHTML = s2.html; await applyRevisionResult(r, true); renderFmtPass(); }
function setFixRules(rules){ SET.fixRules = FIX_RULES.filter(k => rules.includes(k)); saveSettings(); renderFmtPass(); }
if ($('#fqList')){
  $('#fxRules').addEventListener('change', e => { if (e.target.dataset.rule) setFixRules([...$$('#fxRules [data-rule]:checked')].map(x => x.dataset.rule)); });
  $('#fxPresets').addEventListener('click', e => {
    const ps = fixPresets(), rm = e.target.closest('[data-rm-preset]');
    if (rm){ const p = ps[+rm.dataset.rmPreset]; if (!p || !confirm(`Delete the preset “${p.name}”?`)) return;
      SET.fixPresets = (SET.fixPresets || []).filter(x => x.name !== p.name); saveSettings(); renderFmtPass(); return; }
    if (e.target.closest('#fxSave')){
      const name = (prompt('Name for this preset', '') || '').trim().slice(0, 40); if (!name) return;
      if (FIX_PRESETS.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('That name is taken by a built-in preset');
      SET.fixPresets = [...(SET.fixPresets || []).filter(x => x.name !== name), {name, rules: pickedRules()}]; saveSettings(); renderFmtPass(); toast(`Preset “${name}” saved`); return;
    }
    const b = e.target.closest('[data-preset]'); if (b) setFixRules(ps[+b.dataset.preset].rules);
  });
  $('#fqBuild').onclick = () => {
    // the prompt keeps the picked rules (it leaves out the ones the Checker has off when it is made)
    const rules = pickedRules(), cand = fmtCandidates(rulesOn(rules)), size = +$('#fixSize').value || 25; if (!cand.length) return;
    let k = Math.max(0, ...S.cards.map(c => c.fmt || c.fmtDone).filter(Boolean).map(fmtNum));
    for (let i = 0; i < cand.length; i += size){ const id = 'Q' + (++k); cand.slice(i, i + size).forEach(c => { c.fmt = id; c.fmtSt = 'todo'; c.fmtRules = [...rules]; delete c.fmtDone; delete c.fmtJob; }); }
    save(); renderFmtPass(); toast(`Queue: ${Math.ceil(cand.length / size)} prompt(s) · ${rulesName(rules)}`);
  };
  $('#fqNext').onclick = () => { const nx = fmtNext(); if (nx) fmtCopy(nx); };
  $('#fqList').addEventListener('click', e => {
    const b = e.target.closest('[data-fq]'); if (!b) return;
    const it = fmtItems().find(x => x.id === b.dataset.id); if (!it) return;
    if (b.dataset.fq === 'copy') fmtCopy(it);
    if (b.dataset.fq === 'view'){ const w = window.open(URL.createObjectURL(new Blob([fixPrompt(it.cards)], {type: 'text/plain;charset=utf-8'})), '_blank'); if (!w) toast('Allow pop-ups to view the prompt'); }
    if (b.dataset.fq === 'done'){ if (it.status === 'done') it.cards.forEach(c => { c.fmt = c.fmtDone; c.fmtSt = 'copied'; delete c.fmtDone; }); else it.cards.forEach(c => { if (c.fmt) fmtFinish(c); }); save(); renderFmtPass(); }   // answered members keep their batch
  });
  $('#fqReset').onclick = () => { if (!confirm('Mark every prompt as not copied (answered ones stay ticked)?')) return; S.cards.forEach(c => { if (c.fmt) c.fmtSt = 'todo'; }); save(); renderFmtPass(); };
  $('#fqClear').onclick = () => { if (!confirm('Remove the checker-fix queue? Cards and re-checks are not affected.')) return;
    S.cards.forEach(c => { delete c.fmt; delete c.fmtSt; delete c.fmtDone; delete c.fmtJob; delete c.fmtRules; }); save(); renderFmtPass(); };
  wireDrop($('#fqDrop'), $('#fqFile'), async files => fqApplied(await importFiles(files, 'merge', {revision: true})));
  $('#fqApply').onclick = async () => {
    const txt = $('#fqPaste').value.trim(); if (!txt) return toast('Paste the reply first');
    const {bundles, errors} = extractBundles(txt);
    await fqApplied({sums: bundles.map(b => applyBundle(b, 'merge', {revision: true})), imgs: 0, errors});
    if (bundles.length) $('#fqPaste').value = '';
  };
  ['Scope', 'Status', 'Size'].forEach(x => $('#fix' + x).onchange = renderFmtPass);
}
document.addEventListener('keydown', e => {
  if (!$('#tab-revise').classList.contains('active') || e.key.toLowerCase() !== 'n') return;
  if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#fqPanel').hidden || !fmtNext() || copyHidden()) return;
  e.preventDefault(); $('#fqNext').click();
});
const mediaForAI = cards => [...new Set(cards.flatMap(cardImages))].filter(n => S.media[n]).map(n => { const m = S.media[n]; const e = {filename: n, origin: m.origin}; for (const k of ['url','hint','caption','credit']) if (m[k]) e[k] = m[k]; return e; });
/** the checker-fix prompt: fixes for exactly the problems the picked rules found (only the ones the Checker has on). Rules that
    are all about formatting make a formatting pass, which may not change what a card says */
function fixPrompt(cards, rules = itemRules(cards)){
  const C = ck(), onList = rulesOn(rules, C), on = new Set(onList), fmtOnly = onList.every(k => FMT_KEYS.has(k)), what = fmtOnly ? 'Formatting pass' : 'Checker fix';
  const has = (...ks) => ks.some(k => on.has(k));
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), media: mediaForAI(cards),
    cards: cards.map(c => { const o = cardForAI(c, false), iss = issuesFor(c, onList).map(x => x.msg);
      o.feedback = iss.length ? `${what} - the checks found: ` + iss.join(' ') : `${what} - the checks don't flag this card: check it against the rules and leave it out unless something needs fixing.`;
      return o; })};
  const how = [
    has('code_as_text', 'code_language', 'code_line_chars') && `**Code:** statements and snippets go in a code block with their language (\`<pre><code class="language-java">…</code></pre>\`, or \`code(src, "java")\` with anki_helper.py), never as plain text and never squeezed into one inline \`<code>\`. Names of classes, methods, variables and types go in inline \`<code>\`.${on.has('code_line_chars') ? ` Keep every code-block line at most ${C.code_line_chars} characters so it fits a phone: break long lines at natural points (after a comma or operator, one chained call per line, parameters on their own lines) and indent the continuation; never change what the code does.` : ''}`,
    has('math_as_text', 'math_in_code') && `**Maths:** formulas go in LaTeX - inline \\( … \\), display \\[ … \\] for multi-line or long ones (\\\\ line breaks, aligned, cases) - never as plain text (x^2, a_1, sqrt(x), a bare \\frac) and never inside \`<code>\`.`,
    has('outside_refs', 'unshown_code', 'unshown_math') && `**Self-contained:** the card must carry everything needed to answer it - the reader has no notes, slides or other cards. If the question depends on code, a definition, an equation or theorem it cites (e.g. "Eq. (3)", "Theorem 2") or a figure, put it on the front, cut down to what matters. Remove references to the notes, slides, lectures or other cards.`,
    has('why', 'why_min_words') && `**No "why" / a short "why":** write the card's "why" as an extensive explanation in HTML (\`<p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>\`${promptMode() === 'skill' ? ', `why=rationale(...)` with anki_helper.py' : ''})${on.has('why_min_words') ? `, at least ${C.why_min_words} words` : ''}. Base it on what the card tests and the material.`,
    on.has('front_max_chars') && `**Front too long:** cut the front's prose to at most ${C.front_max_chars} characters (code blocks, inline code and maths are not counted). Keep everything needed to answer it; drop padding and background, or move background into the "why".`,
    on.has('back_max_words') && `**Answer too long:** cut the answer to at most ${C.back_max_words} words (code is not counted): the answer first, then the shortest explanation that makes it stick. Move background into the "why", or split the card if it really tests several things.`,
    on.has('cloze_max_deletions') && `**Too many cloze numbers:** at most ${C.cloze_max_deletions} per note. Split the note into several cloze notes, or hide related items under one number.`,
    on.has('multi_question') && `**Several questions on one card:** split it into one card per question. Keep the original id for the first part; give every other part a new id that is not in "existing_ids", \`"after": "<original id>"\` (\`after="…"\` with anki_helper.py), and its own "why".`,
    has('ref_page', 'ref_quote_min_chars') && `**Source references:** give each reference ${[on.has('ref_page') && 'the page it is on', on.has('ref_quote_min_chars') && `a verbatim quote${on.has('ref_page') ? ' from that page' : ''} of at least ${C.ref_quote_min_chars} characters`].filter(Boolean).join(' and ')}. Take them only from the material: if you don't have it, leave the references as they are and say so.`
  ].filter(Boolean);
  const rulesTxt = fmtOnly ? `This is a **formatting pass, not a content review**: I have already reviewed these cards.
- Do NOT change what a card tests, its answer, its "why", its images or its tags. Do not delete, merge or split cards.
- Fix only how the card is written:
${[...how, 'Comparisons as tables, long answers as bullets.'].map((x, i) => `  ${i + 1}. ${x}`).join('\n')}
- Each card's "feedback" says what the automatic checks found. They can be wrong: if a card is fine, return it with the check in "skipped_checks" and your reason (see below) instead of changing it.
- ${SKIP_RULE(promptMode() === 'skill')}
- Return ONLY the cards you changed or skipped a check on, with their ids unchanged. Then list each changed card in one line: what changed (or which check you skipped and why).`
  : `This is a **checker fix**: I have already reviewed these cards. Fix only the problems each card's "feedback" lists (found by the automatic checks).
- Keep what each card tests, keep its answer correct and complete, and keep its images and tags. Never delete or merge cards.
- How to fix each problem:
${how.map(x => '  - ' + x).join('\n')}
- Keep the card-writing rules (descriptive back, HTML with the aa-* classes, self-contained cards).
- The checks can be wrong: if a check is wrong for a card, return the card with that check in "skipped_checks" and your reason instead of changing it.
- ${SKIP_RULE(promptMode() === 'skill')}
- Return ONLY the cards you changed or skipped a check on${on.has('multi_question') ? ', and any new parts of split cards' : ''}, with the ids of existing cards unchanged. Then list each changed card in one line: what changed (or which check you skipped and why).`;
  const rb = idBlock('REVISE_CARDS', 'r', JSON.stringify(block, null, 1)), job = fmtOnly ? 'a formatting pass' : 'a checker fix';
  return (promptMode() === 'skill'
    ? `Use the **anki** skill's revision workflow for ${job} on these Anki cards. Load them with \`Deck.load("${rb.id}")\` and give me **anki_revision.json** with only the cards you changed${on.has('multi_question') ? ' or split off' : ''}.\n\n${rulesTxt}`
    : `Please do ${job} on these Anki cards. Output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block (JSON with "revision": true and a "cards" list; each card keeps its id, type, all its fields, "why", "refs" and "skipped_checks").\n\n${rulesTxt}`)
    + checkerSection(promptMode()) + `\n\n${rb.text}`;
}

$('#btnCopyRevision').onclick = () => { if (!$('#rvOut').value) $('#btnMakeRevision').click(); if ($('#rvOut').value) copyPrompt($('#rvOut').value); };
async function applyRevisionResult(r, quiet){
  const s = summarize(r); if (!quiet) $('#reviseResult').innerHTML = s.html;   // quiet: the checker-fix queue shows it
  await afterImport();
  // a reply that only answers a checker fix opens the Re-check view; one with ordinary revisions opens those
  if (s.ok && s.recheck && !s.plain){
    S.filter = 'recheck'; $('#filter').value = 'recheck'; S.curId = S.cards.find(c => c.recheck).id;
    toast(`Checker fix applied - ${s.recheck || 'some'} approved card(s) to re-check`); renderFmtPass(); return;
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

