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
  ? `${skillGetSection()}Use the **anki** skill's revision workflow to revise my Anki cards based on my review feedback. Give me **anki_revision.json** (only changed, added or deleted cards). Load the cards with \`Deck.load("${rb.id}")\`.
For every card whose feedback is “I don't understand this card”: fix the card if its wording caused the confusion, and explain step by step why the card says what it says (start from what I already know, give each step's reason, add a small worked example where it helps). One or two short explanations can go in your reply; if there are more, or they are long, put them all in a markdown file **anki_explanations.md** (one section per card, with the card's question) and give me that file.
${gen ? `\n## General feedback (applies to the whole deck)\n${gen}\n` : ''}${notesSection(promptMode() === 'skill')}${checkerSection(promptMode())}${$('#rvMore').checked ? '\n## Also\nAdd new cards for important concepts from the material that the deck does not cover yet (new ids, continue the numbering).\n' : ''}
## Cards to revise (each has my "feedback")
${rb.text}`
  : `Please revise my Anki cards based on my review feedback.

## Rules
- Keep each card's **id**. Return ONLY cards you changed or added (plus deletions) - not the whole deck. New cards need ids that are not in "existing_ids".
- To delete a card return \`{"id": "c007", "delete": true}\`. To split a card, keep the original id for one part and give new parts new ids with \`"after": "c007"\`.
- Keep following the original card-writing rules (ONE question per card - split any card that bundles several; descriptive back with answer → explanation → example/image, HTML with the aa-* classes). Keep each card's "why" - its hidden notes (${notesSpec() ? notesSpec() : 'by default an extensive explanation of why the card was made, in HTML: <p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>'}); give new and split cards their own, and update them when a change alters what the card tests.
- Images I already have (listed under "media") can be reused by filename. For new or changed images use anki_helper.py as before; for a changed image give it a NEW filename.
- The block below is the CURRENT version of each card (it includes my own edits) - work from it, not from older versions.
- A card's "skipped_checks" are checks you skipped on purpose earlier, with your reason: keep them, drop one your change makes unneeded (\`"skipped_checks": {}\` drops them all), or add one if a check is genuinely wrong for the changed card.
- If you have code execution (${helperAgain()}): \`deck = Deck.load("${rb.id}")\` (it reads the REVISE_CARDS block with that id from this prompt saved as a file (an attachment, the working folder or Downloads), so never retype the block; if it is not found, ask me to send the prompt as a file), read \`deck.feedback\` / \`deck.show()\`, apply changes with deck.update(...), deck.add_basic(...), deck.add_cloze(...), deck.delete(...), run deck.validate() (ignore "registered but not used" for images I already have), then \`deck.save(revision=True)\` and give me **anki_revision.json** as a download.
- Otherwise output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block with "revision": true.
- For every card whose feedback is “I don't understand this card”: fix the card if its wording caused the confusion, and explain step by step why the card says what it says (start from what I already know, give each step's reason, add a small worked example where it helps). One or two short explanations can go in your reply; if there are more, or they are long, put them all in a markdown file **anki_explanations.md** (one section per card, with the card's question) and give me that file. (With the helper: deck.explain(id, markdown) for each, then deck.save_explanations(). Without file creation, put the markdown in one fenced block.)
- Then list each changed card in one line: what changed.
${gen ? `\n## General feedback (applies to the whole deck)\n${gen}\n` : ''}${notesSection(promptMode() === 'skill')}${checkerSection(promptMode())}${$('#rvMore').checked ? '\n## Also\nAdd new cards for important concepts from the material that the deck does not cover yet (new ids, continue the numbering).\n' : ''}
## Cards to revise (each has my "feedback")
${rb.text}`;
  if ($('#rvContext').checked && others.length) txt += `\n\n## Other cards already in the deck (do not duplicate; change them only if the general feedback requires it)\n` + others.map(c => `${c.id}: ${cardTitle(c).slice(0, 110)}`).join('\n');
  $('#rvOut').value = txt;
};
/* ---- global revision: one change across every card that passes a filter, sent to Claude in batches. The change is your
   instruction, and/or fixes for what the picked Checker rules find (with rules only it is a checker fix, as before; rules
   that are all about formatting make a formatting pass). */
/* The queue lives on the cards: c.fmt = its prompt ("Q3"; "F3" / "K3" come from the old separate formatting and checker-fix
   queues) while waiting for Claude (c.fmtSt 'todo' | 'copied'), c.fmtRules = the rules that prompt fixes, c.fmtTask = its
   instruction and options ({instr, mode, split, del}; none for a plain checker fix), c.fmtJob = the Mac job it was sent to,
   c.fmtDone = the prompt that answered it, c.fmtNA = the AI's reason when it left the card as it was. So it is saved and
   synced with the project like everything else. A card waits in one prompt at a time. */
const FMT_LABEL = {outside_refs: 'outside references', unshown_code: 'unshown code', code_as_text: 'code as plain text', code_language: 'code without a language', code_line_chars: 'code lines too wide for a phone', unshown_math: 'unshown maths', math_as_text: 'maths as plain text', math_in_code: 'maths inside code',
  why: 'no hidden notes', why_min_words: 'short hidden notes', front_max_chars: 'long front', back_max_words: 'long answer', cloze_max_deletions: 'too many cloze numbers', multi_question: 'several questions', ref_page: 'source without a page', ref_section: 'source without its section', ref_quote_min_chars: 'short source quote'};
/** the built-in rule presets; your own are SET.fixPresets (rules, plus the instruction and filter when you saved them). Rules
    that are all formatting make a formatting pass: Claude may not touch the content */
const FIX_PRESETS = [
  {name: 'Formatting', rules: [...FMT_KEYS]},
  {name: 'Others', rules: [...FIX_KEYS]},
  {name: 'Everything', rules: FIX_RULES},
  {name: 'Code', rules: ['unshown_code', 'code_as_text', 'code_language', 'code_line_chars']},
  {name: 'Maths', rules: ['unshown_math', 'math_as_text', 'math_in_code']},
  {name: 'Length', rules: ['front_max_chars', 'back_max_words', 'cloze_max_deletions', 'multi_question']},
  {name: 'Sources', rules: ['ref_page', 'ref_section', 'ref_quote_min_chars']}
];
const fixPresets = () => [...FIX_PRESETS, ...(SET.fixPresets || []).map(p => ({...p, own: true}))];
const sameRules = (a, b) => a.length === b.length && a.every(k => b.includes(k));
const rulesName = rules => (fixPresets().find(p => !p.task && !p.filter && sameRules(p.rules, rules)) || {name: `${rules.length} rule${rules.length === 1 ? '' : 's'}`}).name;
/** the rules picked on the Revise tab, in the Checker's order */
const pickedRules = () => FIX_RULES.filter(k => (SET.fixRules || []).includes(k));
/** the ones the Checker has switched on (a limit of 0 is off; the hidden-notes length follows the hidden-notes check) */
const rulesOn = (rules, C = ck()) => rules.filter(k => C[k] !== 'off' && C[k] !== 0 && !(k === 'why_min_words' && C.why === 'off'));
const formattingOnly = rules => rulesOn(rules).every(k => FMT_KEYS.has(k));
/** a queued prompt's rules, saved on its cards (the old queues had fixed ones); cards not queued use the picked rules */
function itemRules(cards){
  const c = cards.find(x => Array.isArray(x.fmtRules)); if (c) return FIX_RULES.filter(k => c.fmtRules.includes(k));
  const id = String((cards[0] && (cards[0].fmt || cards[0].fmtDone)) || '');
  return id[0] === 'K' ? [...FIX_KEYS] : id[0] === 'F' ? [...FMT_KEYS] : pickedRules();
}
/** a queued prompt's instruction and options (null: a plain checker fix) */
const itemTask = cards => (cards.find(c => c.fmtTask && c.fmtTask.instr) || {}).fmtTask || null;
const shorten = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const itemName = (cards, rules = itemRules(cards), task = itemTask(cards)) => task ? `“${shorten(task.instr, 40)}”${rulesOn(rules).length ? ' + ' + rulesName(rules) : ''}` : rulesName(rules);
const issuesFor = (c, rules) => checksOf(c).filter(x => rules.includes(x.key));

/* ---- the filter: conditions that each allow or deny cards. A card passes when it matches the allow conditions (all of
   them, or any - SET.grFilter.match) and none of the deny ones; no allow conditions = every card. Conditions with a
   missing value or a bad regex are ignored (and shown as incomplete). */
const GR_TASK = {instr: '', mode: 'content', split: false, del: false};
const grTask = () => ({...GR_TASK, ...(SET.grTask || {})});
const FIELD_OPTS = [['any', 'any field'], ['q', 'question (front / cloze text)'], ['a', 'answer (back + Extra)'], ['why', 'hidden notes'], ['source', 'source'], ['html', 'the HTML of any field']];
const plainMemo = new WeakMap();
/** the card's text by part, tags removed (re-made only when the card changes) */
function cardPlain(c){
  const sig = [c.type, c.front, c.back, c.text, c.extra, c.why, c.source], m = plainMemo.get(c);
  if (m && m.sig.every((v, i) => v === sig[i])) return m.res;
  const pl = h => decodeEnt(String(h || '').replace(/<br\s*\/?>|<\/(?:p|div|li|tr|pre|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
  const cloze = c.type === 'cloze';
  const res = {q: pl(unCloze(cloze ? c.text : c.front)), a: pl(cloze ? c.extra : (c.back || '') + '\n' + (c.extra || '')), why: pl(c.why), source: pl(c.source)};
  res.any = [res.q, res.a, res.why, res.source].join('\n');
  res.html = FIELDS[c.type].map(f => c[f] || '').concat(c.why || '').join('\n');
  plainMemo.set(c, {sig, res}); return res;
}
const cardHTMLAll = c => FIELDS[c.type].map(f => c[f] || '').join('\n');
const wordsIn = s => (String(s || '').match(/\S+/g) || []).length;
const cmpOk = (v, a) => a.op === 'le' ? v <= +a.n : a.op === 'eq' ? v === +a.n : v >= +a.n;
const codeLangs = c => [...cardHTMLAll(c).matchAll(/<pre[^>]*>\s*<code[^>]*\blanguage-([\w+#.-]+)/gi)].map(m => m[1].toLowerCase());
const mathSpans = c => FIELDS[c.type].flatMap(f => [...String(fixMath(mathWithoutCode(c[f] || ''))).matchAll(MATH_SPAN_RE)]);
const CMP = {k: 'op', t: 'cmp'}, NUM = n => ({k: 'n', t: 'num', d: n}), TEXT = ph => ({k: 'q', t: 'text', ph});
const COND_DEFS = [
  {key: 'check', group: 'Checker', label: 'Flagged by the check', args: [{k: 'v', t: 'sel', opts: () => CHECK_ROWS.map(r => [r.key, r.label])}], test: (c, a) => { const r = checkRow(a.v); return !!r && r.test(c); }},
  {key: 'check_any', group: 'Checker', label: 'Flagged by any check', test: c => checksOf(c).length > 0},
  {key: 'check_err', group: 'Checker', label: 'Flagged with an error', test: c => checksOf(c).some(x => x.level === 'E')},
  {key: 'skipped', group: 'Checker', label: 'The AI skipped a check on it', test: c => !!(c.skipped_checks && Object.keys(c.skipped_checks).length)},
  {key: 'code_block', group: 'Code', label: 'Has a code block', test: c => /<pre\b/i.test(cardHTMLAll(c))},
  {key: 'code_lang', group: 'Code', label: 'Has a code block in the language', args: [TEXT('java')], test: (c, a) => codeLangs(c).includes(a.q.trim().toLowerCase().replace(/^language-/, ''))},
  {key: 'code_nolang', group: 'Code', label: 'Has a code block without a language', test: c => /<pre(?![^>]*>\s*<code)|<pre[^>]*>\s*<code(?![^>]*language-)/i.test(cardHTMLAll(c))},
  {key: 'inline_code', group: 'Code', label: 'Has inline code', test: c => /<code\b/i.test(cardHTMLAll(c).replace(/<pre[\s\S]*?<\/pre>/gi, ''))},
  {key: 'code_lines', group: 'Code', label: 'Lines of code', args: [CMP, NUM(10)], test: (c, a) => cmpOk(codeLines(c).filter(l => l.trim()).length, a)},
  {key: 'code_width', group: 'Code', label: 'Longest code line (characters)', args: [CMP, NUM(40)], test: (c, a) => cmpOk(Math.max(0, ...codeLines(c).map(l => l.length)), a)},
  {key: 'math', group: 'Maths', label: 'Has maths', test: c => mathSpans(c).length > 0},
  {key: 'math_display', group: 'Maths', label: 'Has display maths \\[ … \\]', test: c => mathSpans(c).some(m => m[2] !== undefined)},
  {key: 'math_q', group: 'Maths', label: 'Has maths in the question', test: c => [...String(fixMath(mathWithoutCode(c.type === 'cloze' ? c.text : c.front))).matchAll(MATH_SPAN_RE)].length > 0},
  {key: 'image', group: 'Layout', label: 'Has an image', test: c => cardImages(c).length > 0},
  {key: 'images', group: 'Layout', label: 'Number of images', args: [CMP, NUM(2)], test: (c, a) => cmpOk(cardImages(c).length, a)},
  {key: 'image_q', group: 'Layout', label: 'Has an image in the question', test: c => /<img\b/i.test(c.type === 'cloze' ? c.text || '' : c.front || '')},
  {key: 'table', group: 'Layout', label: 'Has a table', test: c => /<table\b/i.test(cardHTMLAll(c))},
  {key: 'list', group: 'Layout', label: 'Has a list', test: c => /<(?:ul|ol)\b/i.test(cardHTMLAll(c))},
  {key: 'box', group: 'Layout', label: 'Has a box of the kind', args: [{k: 'v', t: 'sel', opts: () => BOX_KINDS.map(k => [k, k])}], test: (c, a) => new RegExp(`aa-box aa-${a.v}\\b`).test(cardHTMLAll(c))},
  {key: 'answer_line', group: 'Layout', label: 'Has the one-line answer (aa-answer)', test: c => /class="aa-answer"/.test(cardHTMLAll(c))},
  {key: 'extra', group: 'Layout', label: 'Has Extra', test: c => !!(String(c.extra || '').replace(/<[^>]+>/g, '').trim() || /<img\b/i.test(c.extra || ''))},
  {key: 'link', group: 'Layout', label: 'Has a link', test: c => /<a\b/i.test(cardHTMLAll(c))},
  {key: 'type', group: 'Card', label: 'Card type is', args: [{k: 'v', t: 'sel', opts: [['basic', 'Basic'], ['cloze', 'Cloze']]}], test: (c, a) => c.type === a.v},
  {key: 'cloze_n', group: 'Card', label: 'Cloze numbers', args: [CMP, NUM(2)], test: (c, a) => c.type === 'cloze' && cmpOk(new Set([...String(c.text || '').matchAll(/\{\{c(\d+)::/g)].map(m => m[1])).size, a)},
  {key: 'cloze_hint', group: 'Card', label: 'Has a cloze hint {{c1::…::hint}}', test: c => c.type === 'cloze' && /\{\{c\d+::(?:(?!\}\}).)*::[^{}]*\}\}/s.test(c.text || '')},
  {key: 'q_words', group: 'Card', label: 'Question length (words)', args: [CMP, NUM(30)], test: (c, a) => cmpOk(wordsIn(cardPlain(c).q), a)},
  {key: 'a_words', group: 'Card', label: 'Answer length (words, back + Extra)', args: [CMP, NUM(80)], test: (c, a) => cmpOk(wordsIn(cardPlain(c).a), a)},
  {key: 'q_marks', group: 'Card', label: 'Question marks in the question', args: [CMP, NUM(2)], test: (c, a) => cmpOk((cardPlain(c).q.match(/\?/g) || []).length, a)},
  {key: 'notes', group: 'Hidden notes', label: 'Has hidden notes', test: c => !!cardPlain(c).why},
  {key: 'notes_words', group: 'Hidden notes', label: 'Hidden-notes length (words)', args: [CMP, NUM(45)], test: (c, a) => cmpOk(wordsIn(cardPlain(c).why), a)},
  {key: 'notes_on_card', group: 'Hidden notes', label: 'Hidden notes are put on the card', test: c => whyOn(c)},
  {key: 'status', group: 'Review', label: 'Status is', args: [{k: 'v', t: 'sel', opts: [['ok', 'approved'], ['new', 'unreviewed'], ['change', 'change requested']]}], test: (c, a) => c.status === a.v},
  {key: 'edited', group: 'Review', label: 'I edited its fields', test: c => !!c.edited},
  {key: 'revised', group: 'Review', label: 'The AI revised it', test: c => !!c.revised},
  {key: 'recheck', group: 'Review', label: 'Waiting for a re-check', test: c => !!c.recheck},
  {key: 'feedback', group: 'Review', label: 'Has my feedback', test: c => !!String(c.feedback || '').trim()},
  {key: 'time', group: 'Review', label: 'Review time (seconds)', args: [CMP, NUM(60)], test: (c, a) => cmpOk(Math.round(c.time || 0), a)},
  {key: 'left_as_is', group: 'Review', label: 'The last global revision left it as is', test: c => !!c.fmtNA},
  {key: 'tag', group: 'Metadata', label: 'Has the tag', args: [TEXT('tag')], test: (c, a) => (c.tags || []).some(t => t.toLowerCase() === a.q.trim().toLowerCase())},
  {key: 'deck', group: 'Metadata', label: 'In the sub-deck', args: [{k: 'v', t: 'sel', opts: () => allDecks().map(d => [d, d])}], test: (c, a) => cardDeck(c) === a.v || cardDeck(c).startsWith(a.v + '::')},
  {key: 'id', group: 'Metadata', label: 'Card id is one of', args: [TEXT('c001, c007, L03-*')], test: (c, a) => a.q.split(/[\s,]+/).filter(Boolean).some(p => p.endsWith('*') ? c.id.startsWith(p.slice(0, -1)) : c.id === p)},
  {key: 'refs', group: 'Source', label: 'Has a source reference', test: c => cardRefs(c).length > 0},
  {key: 'ref_file', group: 'Source', label: 'Source file name contains', args: [TEXT('lecture3')], test: (c, a) => cardRefs(c).some(r => String(r.file || '').toLowerCase().includes(a.q.trim().toLowerCase())) || cardPlain(c).source.toLowerCase().includes(a.q.trim().toLowerCase())},
  {key: 'ref_page', group: 'Source', label: 'Source page', args: [CMP, NUM(1)], test: (c, a) => cardRefs(c).some(r => r.page && cmpOk(+r.page, a))},
  {key: 'ref_box', group: 'Source', label: 'Source shows its exact section (box)', test: c => cardRefs(c).some(refBox)},
  {key: 'contains', group: 'Text', label: 'Text contains', args: [{k: 'f', t: 'field'}, TEXT('words to find')], test: (c, a) => cardPlain(c)[a.f].toLowerCase().includes(a.q.toLowerCase())},
  {key: 'regex', group: 'Text', label: 'Text matches the regex', args: [{k: 'f', t: 'field'}, TEXT('e.g. \\bO\\(n\\^?2\\)')], regex: true, test: (c, a, re) => re.test(cardPlain(c)[a.f])}
];
const condDef = k => COND_DEFS.find(d => d.key === k);
const condDefaults = d => Object.fromEntries((d.args || []).map(g => [g.k, g.t === 'cmp' ? 'ge' : g.t === 'num' ? g.d : g.t === 'field' ? 'any' : g.t === 'sel' ? String(((typeof g.opts === 'function' ? g.opts() : g.opts)[0] || [''])[0]) : '']));
const grFilter = () => { const f = SET.grFilter || {}; return {match: f.match === 'any' ? 'any' : 'all', conds: (f.conds || []).filter(x => x && condDef(x.key))}; };
/** the filter as tests: {allow, deny, match, bad (conditions ignored as incomplete)} */
function compileFilter(f = grFilter()){
  const mk = x => {
    const d = condDef(x.key), a = {...condDefaults(d), ...(x.a || {})};
    if ((d.args || []).some(g => (g.t === 'text' && !String(a[g.k] || '').trim()) || (g.t === 'num' && !Number.isFinite(+a[g.k])))) return null;
    let re = null; if (d.regex){ try { re = new RegExp(a.q, 'i'); } catch { return null; } }
    return c => { try { return !!d.test(c, a, re); } catch { return false; } };
  };
  const all = f.conds.map(x => ({x, fn: mk(x)}));
  return {allow: all.filter(o => o.fn && !o.x.deny).map(o => o.fn), deny: all.filter(o => o.fn && o.x.deny).map(o => o.fn), match: f.match, tests: all.map(o => o.fn)};
}
const filterPass = (c, F) => (!F.allow.length || (F.match === 'any' ? F.allow.some(t => t(c)) : F.allow.every(t => t(c)))) && !F.deny.some(t => t(c));
/** does the card pass everything the global revision picks cards by (Which cards, Status, the filter)? */
function revPass(c, rules, F){
  const scope = rules.length ? $('#fixScope').value : 'all', stf = $('#fixStatus').value;
  return c.status !== 'drop' && (stf === 'any' || c.status === stf)
    && (scope === 'all' || (scope === 'flagok' && c.status === 'ok') || issuesFor(c, rules).some(x => scope !== 'err' || x.level === 'E'))
    && filterPass(c, F);
}
let revFilterMemo = {key: null, F: null};
/** the Review filter "Global revision filter": the cards it would pick, queued or not */
function revFilterMatch(c){
  const rules = rulesOn(pickedRules()), key = J([SET.grFilter, rules, $('#fixScope').value, $('#fixStatus').value, SET.checks]);
  if (revFilterMemo.key !== key) revFilterMemo = {key, F: compileFilter()};
  return revPass(c, rules, revFilterMemo.F);
}
function fmtCandidates(rules = rulesOn(pickedRules()), F = compileFilter()){
  if (!rules.length && !grTask().instr.trim()) return [];
  return ordered(S.cards.filter(c => inScope(c) && !c.fmt && revPass(c, rules, F)), S.order || 'source');
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
/** an own preset is on when its rules, and the instruction / filter it saved, are what is set up now */
function presetOn(p, picked){
  if (!sameRules(p.rules, picked)) return false;
  if (!p.own) return true;
  const t = grTask(), f = grFilter();
  return J(p.task || null) === J(t.instr.trim() ? t : null) && J(p.filter || null) === J(f.conds.length ? f : null);
}
function renderRulePicker(picked, C){
  $('#fxPresets').innerHTML = fixPresets().map((p, i) => `<button class="btn sm ${presetOn(p, picked) ? 'on' : ''}" data-preset="${i}" title="${esc([p.rules.map(k => FMT_LABEL[k]).join(', '), p.task && `“${shorten(p.task.instr, 80)}”`, p.filter && `${p.filter.conds.length} filter condition(s)`].filter(Boolean).join(' · '))}">${esc(p.name)}${p.own ? `<span class="fx-rm" data-rm-preset="${i}" title="Delete this preset">✕</span>` : ''}</button>`).join('')
    + `<button class="btn sm" id="fxSave" title="Save the rules ticked below, the instruction and the filter as a preset of your own" ${picked.length || grTask().instr.trim() || grFilter().conds.length ? '' : 'disabled'}>＋ Save as preset</button>`;
  let g = '', h = '';
  for (const k of FIX_RULES){
    const d = CHECK_DEFS.find(x => x.key === k), off = !rulesOn([k], C).length;
    if (d.group !== g){ h += `${g ? '</div>' : ''}<div class="fx-g"><h4>${esc(d.group)}</h4>`; g = d.group; }
    h += `<label class="check small" title="${esc(d.label)}"><input type="checkbox" data-rule="${k}" ${picked.includes(k) ? 'checked' : ''}> <span>${esc(FMT_LABEL[k])} <span class="muted">(${off ? 'off in the Checker' : esc(String(ruleSetting(k, C)))})</span></span></label>`;
  }
  $('#fxRules').innerHTML = h + '</div>';
}
function condArgsHTML(d, a){
  return (d.args || []).map(g => {
    const v = a[g.k] ?? '';
    if (g.t === 'cmp') return `<select data-ca="${g.k}" aria-label="comparison">${[['ge', '≥'], ['le', '≤'], ['eq', '=']].map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    if (g.t === 'num') return `<input type="number" min="0" step="1" data-ca="${g.k}" value="${esc(String(v))}" aria-label="number">`;
    if (g.t === 'text') return `<input type="text" data-ca="${g.k}" value="${esc(String(v))}" placeholder="${esc(g.ph || '')}" aria-label="value">`;
    const opts = g.t === 'field' ? FIELD_OPTS : typeof g.opts === 'function' ? g.opts() : g.opts;
    if (!opts.some(([k]) => String(k) === String(v)) && v) opts.unshift([v, v]);
    return `<select data-ca="${g.k}" aria-label="value">${opts.map(([k, l]) => `<option value="${esc(String(k))}" ${String(v) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }).join('');
}
function renderConds(f){
  const groups = [...new Set(COND_DEFS.map(d => d.group))];
  $('#grMatch').value = f.match;
  $('#grConds').innerHTML = f.conds.map((x, i) => { const d = condDef(x.key), a = {...condDefaults(d), ...(x.a || {})};
    return `<div class="gr-cond ${x.deny ? 'deny' : 'allow'}" data-i="${i}"><select data-cm="deny" aria-label="allow or deny"><option value="0" ${x.deny ? '' : 'selected'}>Allow</option><option value="1" ${x.deny ? 'selected' : ''}>Deny</option></select>
      <select data-cm="key" aria-label="condition">${groups.map(g => `<optgroup label="${esc(g)}">${COND_DEFS.filter(d2 => d2.group === g).map(d2 => `<option value="${d2.key}" ${d2.key === d.key ? 'selected' : ''}>${esc(d2.label)}</option>`).join('')}</optgroup>`).join('')}</select>
      ${condArgsHTML(d, a)}<span class="small muted gr-n" data-cn></span><button class="btn sm" data-cm="rm" title="Remove this condition">✕</button></div>`; }).join('')
    || '<div class="small muted">No conditions: every card that passes <i>Which cards</i> and <i>Status</i> goes in.</div>';
  $('#grConds').dataset.sig = J(f);
}
function renderFmtPass(){
  if (!$('#fqList')) return;
  const C = ck(), picked = pickedRules(), on = rulesOn(picked, C), t = grTask(), instr = t.instr.trim(), f = grFilter();
  renderRulePicker(picked, C);
  if (document.activeElement !== $('#grInstr') && $('#grInstr').value !== t.instr) $('#grInstr').value = t.instr;
  $('#grMode').value = t.mode; $('#grSplit').checked = t.split; $('#grDel').checked = t.del;
  $('#grOpts').hidden = !instr;
  if ($('#grConds').dataset.sig !== J(f)) renderConds(f);
  $('#fixScope').disabled = !on.length; $('#fixScope').title = on.length ? '' : 'Pick some Checker rules to choose cards by what they find';
  $('#fqUses').innerHTML = (instr ? `<div><b>Instruction:</b> “${esc(shorten(instr, 160))}” <span class="muted">(${t.mode === 'format' ? 'formatting only' : 'may change content'}${t.split ? ', may split' : ''}${t.del ? ', may delete' : ''})</span></div>` : '')
    + (on.length || !instr ? `Looks for, using the <a href="#" data-to-ck>Checker</a>: ${on.length ? on.map(k => `<b>${FMT_LABEL[k]}</b> <span class="muted">(${esc(String(ruleSetting(k, C)))})</span>`).join(', ') : `<span style="color:var(--warn)">nothing - ${picked.length ? 'the picked rules are all off in the Checker' : 'pick some rules'}${instr ? '' : ', or write an instruction'}</span>`}` : '')
    + (on.length && !instr ? `<div class="muted" style="margin-top:2px">${formattingOnly(on) ? '<b>Formatting only:</b> Claude changes how the cards are written, never what they test, and never splits them.' : 'Claude may rewrite content to fix these, and splits cards that bundle several questions (the new parts come in as <i>Unreviewed</i>).'}</div>` : '');
  const ck0 = $('#fqUses').querySelector('[data-to-ck]'); if (ck0) ck0.onclick = e => { e.preventDefault(); showTab('checker'); };
  const F = compileFilter(f), cand = fmtCandidates(on, F), size = +$('#fixSize').value || 25;
  // how many cards each condition matches on its own (cards in this sub-deck that aren't excluded)
  const pool = S.cards.filter(c => inScope(c) && c.status !== 'drop');
  $$('#grConds .gr-cond').forEach((row, i) => { const fn = F.tests[i], el = row.querySelector('[data-cn]');
    row.classList.toggle('bad', !fn); el.textContent = fn ? `${pool.filter(fn).length} card${pool.filter(fn).length === 1 ? '' : 's'}` : 'incomplete - ignored'; });
  $('#fqBuildInfo').textContent = cand.length ? `${cand.length} card(s) → ${Math.ceil(cand.length / size)} prompt(s)` : 'no cards to add with these settings';
  $('#grShow').hidden = !cand.length;
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
    const ok = it.cards.filter(c => c.status === 'ok').length, rc = it.cards.filter(c => c.recheck).length, na = it.status === 'done' ? it.cards.filter(c => c.fmtNA).length : 0;
    return `<div class="qi ${it.status} ${it === nx ? 'next' : ''}"><span class="n">${i + 1}</span>
      <div style="min-width:0"><div class="tt">${esc(it.cards[0].id)} … ${esc(it.cards[it.cards.length - 1].id)} <span class="muted small">· ${esc(itemName(it.cards, rules))}</span></div>
      <div class="sub">${it.cards.length} cards · ${ok} approved${rc ? ` · ${rc} to re-check` : ''}${na ? ` · ${na} left as is` : ''}${Object.keys(tally).length ? ' · ' + Object.entries(tally).map(([k, v]) => `${FMT_LABEL[k]} ${v}`).join(', ') : ''}</div></div>
      <div class="acts"><span class="pill ${it.status}">${{todo: 'to do', copied: 'copied', done: 'answered'}[it.status]}</span>
        <button class="btn sm" data-fq="view" data-id="${it.id}" title="Open the full prompt in a new tab">👁</button>
        <button class="btn sm" data-fq="copy" data-id="${it.id}" ${it.status === 'done' ? 'disabled' : ''}>📋</button>
        <button class="btn sm" data-fq="done" data-id="${it.id}" title="Toggle answered">✓</button></div></div>`; }).join('');
  const cur = $('#fqList').querySelector('.qi.next'); if (cur) cur.scrollIntoView({block: 'nearest'});
}
function fmtCopy(it){
  copyPrompt(fixPrompt(it.cards)); it.cards.forEach(c => { if (c.fmt){ c.fmtSt = 'copied'; delete c.fmtJob; } }); save(); renderFmtPass();
  toast(`Prompt ${fmtItems().findIndex(x => x.id === it.id) + 1} copied (${it.cards.length} cards)`);
}
/** a reply to a global-revision prompt: shown under the queue */
async function fqApplied(r){ const s2 = summarize(r); $('#fqResult').innerHTML = s2.html; await applyRevisionResult(r, true); renderFmtPass(); }
/** put cards in the global-revision queue: prompts of `size` cards, each with the rules and the instruction (task, or null) */
function queueRevision(cards, rules, task, size = 25){
  let k = Math.max(0, ...S.cards.map(c => c.fmt || c.fmtDone).filter(Boolean).map(fmtNum));
  for (let i = 0; i < cards.length; i += size){ const id = 'Q' + (++k); cards.slice(i, i + size).forEach(c => { c.fmt = id; c.fmtSt = 'todo'; c.fmtRules = [...rules];
    if (task) c.fmtTask = task; else delete c.fmtTask; delete c.fmtDone; delete c.fmtJob; }); }
}
function setFixRules(rules){ SET.fixRules = FIX_RULES.filter(k => rules.includes(k)); saveSettings(); renderFmtPass(); }
const saveRevSettings = debounce(saveSettings, 500);
/** change the instruction / options (SET.grTask) or the filter (SET.grFilter); typing saves a moment later */
function setGrTask(patch, soon){ SET.grTask = {...grTask(), ...patch}; soon ? saveRevSettings() : saveSettings(); renderFmtPass(); }
function setGrFilter(f, soon, keepRows){ SET.grFilter = {match: f.match, conds: f.conds}; if (keepRows) $('#grConds').dataset.sig = J(grFilter()); soon ? saveRevSettings() : saveSettings(); renderFmtPass(); }
if ($('#fqList')){
  $('#fxRules').addEventListener('change', e => { if (e.target.dataset.rule) setFixRules([...$$('#fxRules [data-rule]:checked')].map(x => x.dataset.rule)); });
  $('#fxPresets').addEventListener('click', e => {
    const ps = fixPresets(), rm = e.target.closest('[data-rm-preset]');
    if (rm){ const p = ps[+rm.dataset.rmPreset]; if (!p || !confirm(`Delete the preset “${p.name}”?`)) return;
      SET.fixPresets = (SET.fixPresets || []).filter(x => x.name !== p.name); saveSettings(); renderFmtPass(); return; }
    if (e.target.closest('#fxSave')){
      const name = (prompt('Name for this preset', '') || '').trim().slice(0, 40); if (!name) return;
      if (FIX_PRESETS.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('That name is taken by a built-in preset');
      const t = grTask(), f = grFilter(), p = {name, rules: pickedRules(), ...(t.instr.trim() ? {task: t} : {}), ...(f.conds.length ? {filter: f} : {})};
      SET.fixPresets = [...(SET.fixPresets || []).filter(x => x.name !== name), p]; saveSettings(); renderFmtPass(); toast(`Preset “${name}” saved`); return;
    }
    const b = e.target.closest('[data-preset]'); if (!b) return;
    const p = ps[+b.dataset.preset];
    if (p.task) SET.grTask = {...GR_TASK, ...p.task};
    if (p.filter) SET.grFilter = JSON.parse(J(p.filter));
    setFixRules(p.rules);
  });
  $('#grInstr').addEventListener('input', e => setGrTask({instr: e.target.value}, true));
  $('#grMode').onchange = e => setGrTask({mode: e.target.value});
  $('#grSplit').onchange = e => setGrTask({split: e.target.checked});
  $('#grDel').onchange = e => setGrTask({del: e.target.checked});
  $('#grMatch').onchange = e => setGrFilter({...grFilter(), match: e.target.value});
  $('#grAdd').onclick = () => { const f = grFilter(); f.conds.push({key: 'code_block', deny: false}); setGrFilter(f); };
  $('#grClear').onclick = () => { if (grFilter().conds.length && !confirm('Remove every filter condition?')) return; setGrFilter({match: 'all', conds: []}); };
  const condAt = el => { const row = el.closest('.gr-cond'); return row ? +row.dataset.i : -1; };
  $('#grConds').addEventListener('change', e => {
    // typed values are saved as you type (below); a text box's late "change" (when its row is re-drawn) must not land on another condition
    if (e.target.tagName !== 'SELECT' || !e.target.isConnected) return;
    const i = condAt(e.target), f = grFilter(); if (i < 0 || !f.conds[i]) return;
    const x = f.conds[i], m = e.target.dataset.cm;
    if (m === 'deny') x.deny = e.target.value === '1';
    else if (m === 'key'){ x.key = e.target.value; delete x.a; }
    else if (e.target.dataset.ca){ x.a = {...(x.a || {}), [e.target.dataset.ca]: e.target.value}; return setGrFilter(f, false, true); }
    setGrFilter(f);
  });
  $('#grConds').addEventListener('input', e => {   // typing in a value: keep the rows (and the cursor), update the counts
    const i = condAt(e.target), f = grFilter(); if (i < 0 || !f.conds[i] || !e.target.dataset.ca || e.target.tagName === 'SELECT') return;
    f.conds[i].a = {...(f.conds[i].a || {}), [e.target.dataset.ca]: e.target.value}; setGrFilter(f, true, true);
  });
  $('#grConds').addEventListener('click', e => {
    if (e.target.closest('[data-cm=rm]')){ const i = condAt(e.target), f = grFilter(); f.conds.splice(i, 1); setGrFilter(f); }
  });
  $('#grShow').onclick = e => {
    e.preventDefault(); S.filter = 'glob'; $('#filter').value = 'glob';
    const first = filtered()[0]; if (!first) return toast('No card in this sub-deck matches the filter');
    S.curId = first.id; showTab('review');
  };
  $('#fqBuild').onclick = () => {
    // the prompt keeps the picked rules (it leaves out the ones the Checker has off when it is made)
    const rules = pickedRules(), cand = fmtCandidates(rulesOn(rules)), size = +$('#fixSize').value || 25; if (!cand.length) return;
    const t = grTask(), task = t.instr.trim() ? {...t, instr: t.instr.trim()} : null;
    queueRevision(cand, rules, task, size);
    save(); renderFmtPass(); toast(`Queue: ${Math.ceil(cand.length / size)} prompt(s) · ${itemName(cand, rules, task)}`);
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
  $('#fqClear').onclick = () => { if (!confirm('Remove the global-revision queue? Cards and re-checks are not affected.')) return;
    S.cards.forEach(c => { delete c.fmt; delete c.fmtSt; delete c.fmtDone; delete c.fmtJob; delete c.fmtRules; delete c.fmtTask; }); save(); renderFmtPass(); };
  wireDrop($('#fqDrop'), $('#fqFile'), async files => fqApplied(await importFiles(files, 'merge', {revision: true, queueOnly: true})));
  $('#fqApply').onclick = async () => {
    const txt = $('#fqPaste').value.trim(); if (!txt) return toast('Paste the reply first');
    const {bundles, errors} = extractBundles(txt);
    await fqApplied({sums: bundles.map(b => applyBundle(b, 'merge', {revision: true, queueOnly: true})), imgs: 0, errors});
    if (bundles.length) $('#fqPaste').value = '';
  };
  ['Scope', 'Status', 'Size'].forEach(x => $('#fix' + x).onchange = renderFmtPass);
}
document.addEventListener('keydown', e => {
  if (!$('#tab-revise').classList.contains('active') || e.key.toLowerCase() !== 'n') return;
  if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#fqPanel').hidden || !fmtNext()) return;
  e.preventDefault(); $('#fqNext').click();
});
const mediaForAI = cards => [...new Set(cards.flatMap(cardImages))].filter(n => S.media[n]).map(n => { const m = S.media[n]; const e = {filename: n, origin: m.origin}; for (const k of ['url','hint','caption','credit']) if (m[k]) e[k] = m[k]; return e; });
/** how to fix what each picked rule found (only the ones the Checker has on) */
function fixHow(on, C){
  const has = (...ks) => ks.some(k => on.has(k));
  return [
    has('code_as_text', 'code_language', 'code_line_chars') && `**Code:** statements and snippets go in a code block with their language (\`<pre><code class="language-java">…</code></pre>\`, or \`code(src, "java")\` with anki_helper.py), never as plain text and never squeezed into one inline \`<code>\`. Names of classes, methods, variables and types go in inline \`<code>\`.${on.has('code_line_chars') ? ` Keep every code-block line at most ${C.code_line_chars} characters so it fits a phone: break long lines at natural points (after a comma or operator, one chained call per line, parameters on their own lines) and indent the continuation; never change what the code does.` : ''}`,
    has('math_as_text', 'math_in_code') && `**Maths:** formulas go in LaTeX - inline \\( … \\), display \\[ … \\] for multi-line or long ones (\\\\ line breaks, aligned, cases) - never as plain text (x^2, a_1, sqrt(x), a bare \\frac) and never inside \`<code>\`.`,
    has('outside_refs', 'unshown_code', 'unshown_math') && `**Self-contained:** the card must carry everything needed to answer it - the reader has no notes, slides or other cards. If the question depends on code, a definition, an equation or theorem it cites (e.g. "Eq. (3)", "Theorem 2") or a figure, put it on the front, cut down to what matters. Remove references to the notes, slides, lectures or other cards.`,
    has('why', 'why_min_words') && `**No hidden notes / short hidden notes:** write the card's hidden notes ("why") in HTML - ${notesSpec() ? notesSpec() : `an extensive explanation of why the card was made (\`<p><b>Tests:</b> …</p><p><b>Why it matters:</b> …</p><p><b>Common mistake:</b> …</p><p><b>Connects to:</b> …</p>\`${promptMode() === 'skill' ? ', `why=rationale(...)` with anki_helper.py' : ''})`}${on.has('why_min_words') ? `, at least ${C.why_min_words} words` : ''}. Base them on what the card tests and the material.`,
    on.has('front_max_chars') && `**Front too long:** cut the front's prose to at most ${C.front_max_chars} characters (code blocks, inline code and maths are not counted). Keep everything needed to answer it; drop padding and background, or move background into the hidden notes.`,
    on.has('back_max_words') && `**Answer too long:** cut the answer to at most ${C.back_max_words} words (code is not counted): the answer first, then the shortest explanation that makes it stick. Move background into the hidden notes, or split the card if it really tests several things.`,
    on.has('cloze_max_deletions') && `**Too many cloze numbers:** at most ${C.cloze_max_deletions} per note. Split the note into several cloze notes, or hide related items under one number.`,
    on.has('multi_question') && `**Several questions on one card:** split it into one card per question. Keep the original id for the first part; give every other part a new id that is not in "existing_ids", \`"after": "<original id>"\` (\`after="…"\` with anki_helper.py), and its own hidden notes.`,
    has('ref_page', 'ref_section', 'ref_quote_min_chars') && `**Source references:** give each reference ${[on.has('ref_page') && 'the page it is on', on.has('ref_quote_min_chars') && `a verbatim quote${on.has('ref_page') ? ' from that page' : ''} of at least ${C.ref_quote_min_chars} characters - the text that led to the card`, on.has('ref_section') && `for a PDF, a "box" [x0, y0, x1, y1] (page fractions) around the exact section the card was made from${promptMode() === 'skill' ? ' (`section_box(path, page, quote)` with anki_helper.py, or a box from `render_page_preview`)' : ''}`].filter(Boolean).join(' and ')}. Take them only from the material: if you don't have it, leave the references as they are and say so.`
  ].filter(Boolean);
}
/** the global-revision prompt: your instruction and/or fixes for exactly the problems the picked rules found (only the ones
    the Checker has on). Rules alone make a checker fix; rules that are all about formatting make a formatting pass, which
    may not change what a card says */
function fixPrompt(cards, rules = itemRules(cards), task = itemTask(cards)){
  const C = ck(), onList = rulesOn(rules, C), on = new Set(onList), skill = promptMode() === 'skill';
  const fmtOnly = !task && onList.every(k => FMT_KEYS.has(k)), what = task ? 'Global revision' : fmtOnly ? 'Formatting pass' : 'Checker fix';
  const instrShort = task && task.instr.length <= 200 ? task.instr : 'see the instruction in the prompt';
  const block = {format: FORMAT, deck: S.deck, tags: S.tags, existing_ids: S.cards.map(c => c.id), media: mediaForAI(cards),
    cards: cards.map(c => { const o = cardForAI(c, false), iss = issuesFor(c, onList).map(x => x.msg);
      o.feedback = task ? `Global revision - ${instrShort}${iss.length ? ' Also fix what the checks found: ' + iss.join(' ') : ''}`
        : iss.length ? `${what} - the checks found: ` + iss.join(' ') : `${what} - the checks don't flag this card: check it against the rules and leave it out unless something needs fixing.`;
      return o; })};
  const how = fixHow(on, C), splits = task ? task.split || on.has('multi_question') : on.has('multi_question');
  let rulesTxt;
  if (task) rulesTxt = `This is a **global revision**: I have already reviewed these cards (many are approved), and now want this change across the deck:

<<<INSTRUCTION
${task.instr}
INSTRUCTION>>>

- Apply it to each card below where it applies. ${task.mode === 'format' ? 'Change only how a card is written: never what it tests, its answer, its hidden notes, its images or its tags.' : 'You may rewrite a card to carry it out; keep every card correct, complete and self-contained, and keep its images and tags unless the instruction is about them.'}
- ${task.split ? 'If the change makes a card ask several things, split it: keep the original id for the first part; give every other part a new id that is not in "existing_ids", `"after": "<original id>"`' + (skill ? ' (`after="…"` with anki_helper.py)' : '') + ', and its own hidden notes.' : on.has('multi_question') ? 'Split a card only to fix "several questions" (below); never merge cards.' : 'Do not split or merge cards.'}
- ${task.del ? 'If the change makes a card redundant, delete it: `{"id": "c007", "delete": true}`' + (skill ? ' (`deck.delete(id)`)' : '') + '. Say why in your summary.' : 'Never delete cards.'}
- The cards matched a filter, so the instruction may not fit every one of them. Never force a change: for a card it doesn't apply to, change nothing and return \`{"id": "c007", "not_applicable": "why it doesn't apply"}\`${skill ? ' (`deck.not_applicable("c007", reason)` with anki_helper.py)' : ''}. I see each reason.
- Each card's "why" is its hidden notes: keep them unless the instruction is about them, and update them when your change alters what the card tests.${how.length ? `
- Also fix what the automatic checks found (each card's "feedback" lists it):
${how.map(x => '  - ' + x).join('\n')}
- The checks can be wrong: if a check is wrong for a card, record it in "skipped_checks" with your reason instead of distorting the card.` : ''}
- Keep the card-writing rules (descriptive back, HTML with the aa-* classes, self-contained cards).
- ${SKIP_RULE(skill)}
- Return ONLY the cards you changed, split off${task.del ? ', deleted' : ''} or marked not applicable, with the ids of existing cards unchanged. Then list each in one line: what changed (or why the instruction didn't apply).`;
  else rulesTxt = fmtOnly ? `This is a **formatting pass, not a content review**: I have already reviewed these cards.
- Do NOT change what a card tests, its answer, its hidden notes ("why"), its images or its tags. Do not delete, merge or split cards.
- Fix only how the card is written:
${[...how, 'Comparisons as tables, long answers as bullets.'].map((x, i) => `  ${i + 1}. ${x}`).join('\n')}
- Each card's "feedback" says what the automatic checks found. They can be wrong: if a card is fine, return it with the check in "skipped_checks" and your reason (see below) instead of changing it.
- ${SKIP_RULE(skill)}
- Return ONLY the cards you changed or skipped a check on, with their ids unchanged. Then list each changed card in one line: what changed (or which check you skipped and why).`
  : `This is a **checker fix**: I have already reviewed these cards. Fix only the problems each card's "feedback" lists (found by the automatic checks).
- Keep what each card tests, keep its answer correct and complete, and keep its images and tags. Never delete or merge cards.
- How to fix each problem:
${how.map(x => '  - ' + x).join('\n')}
- Keep the card-writing rules (descriptive back, HTML with the aa-* classes, self-contained cards).
- The checks can be wrong: if a check is wrong for a card, return the card with that check in "skipped_checks" and your reason instead of changing it.
- ${SKIP_RULE(skill)}
- Return ONLY the cards you changed or skipped a check on${on.has('multi_question') ? ', and any new parts of split cards' : ''}, with the ids of existing cards unchanged. Then list each changed card in one line: what changed (or which check you skipped and why).`;
  const rb = idBlock('REVISE_CARDS', 'r', JSON.stringify(block, null, 1)), job = task ? 'a global revision' : fmtOnly ? 'a formatting pass' : 'a checker fix';
  return (skill
    ? `${skillGetSection()}Use the **anki** skill's revision workflow for ${job} on these Anki cards. Load them with \`Deck.load("${rb.id}")\` and give me **anki_revision.json** with only the cards you changed${splits ? ' or split off' : ''}${task ? (task.del ? ', deleted' : '') + ' or marked not applicable' : ''}.\n\n${rulesTxt}`
    : `Please do ${job} on these Anki cards. Output the changed cards in a <<<ANKI_CARDS … ANKI_CARDS>>> block (JSON with "revision": true and a "cards" list; each card keeps its id, type, all its fields, "why", "refs" and "skipped_checks").\n\n${rulesTxt}`)
    + notesSection(skill) + checkerSection(promptMode()) + `\n\n${rb.text}`;
}

$('#btnCopyRevision').onclick = () => { if (!$('#rvOut').value) $('#btnMakeRevision').click(); if ($('#rvOut').value) copyPrompt($('#rvOut').value); };
async function applyRevisionResult(r, quiet){
  const s = summarize(r); if (!quiet) $('#reviseResult').innerHTML = s.html;   // quiet: the global-revision queue shows it
  await afterImport();
  // a reply that only answers a global revision opens the Re-check view; one with ordinary revisions opens those
  if (s.ok && s.recheck && !s.plain){
    S.filter = 'recheck'; $('#filter').value = 'recheck'; S.curId = S.cards.find(c => c.recheck).id;
    toast(`Global revision applied - ${s.recheck || 'some'} approved card(s) to re-check`); renderFmtPass(); return;
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

