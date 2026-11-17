/* ====================================================================== REVIEW */
/* review timer: counts seconds while a card is open in Review, the page is visible and you were active in the last 90 s */
function fmtTime(sec, long){ sec = Math.round(sec || 0); if (!sec && !long) return ''; const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s2 = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`; }
let lastActive = Date.now(), timerTicks = 0;
['keydown','pointerdown','pointermove','wheel','input'].forEach(ev => document.addEventListener(ev, () => { lastActive = Date.now(); }, {passive: true, capture: true}));
setInterval(() => {
  if (document.hidden || !$('#tab-review').classList.contains('active') || Date.now() - lastActive > 90000) return;
  const c = curCard(); if (!c) return;
  c.time = (c.time || 0) + 1;
  const el = document.querySelector(`#cardItems .tm[data-tm="${CSS.escape(c.id)}"]`); if (el) el.textContent = fmtTime(c.time);
  $('#curTimer').textContent = '⏱ ' + fmtTime(c.time, true);
  if (++timerTicks % 15 === 0) save();
}, 1000);
let side = 'back', clozeN = 1;
const hasOrder = () => S.cards.some(c => typeof c.ord === 'number');
function ordered(cards, mode){
  if (mode !== 'mixed' || !hasOrder()) return cards;
  const idx = new Map(S.cards.map((c, i) => [c.id, i]));
  // cards without an AI position keep their place after the ordered ones of the same deck
  return [...cards].sort((a, b) => {
    const da = deckIndex(cardDeck(a)), db = deckIndex(cardDeck(b));
    if (da !== db) return da - db;
    const oa = typeof a.ord === 'number' ? a.ord : 1e12 + idx.get(a.id), ob = typeof b.ord === 'number' ? b.ord : 1e12 + idx.get(b.id);
    return oa - ob;
  });
}
const allDecks = () => [...new Set(S.cards.map(cardDeck))];
const deckIndex = d => allDecks().indexOf(d);
/* ---- formatting-pass checks: the Studio's copy of the skill's validate() rules for self-contained cards, plus
   code written as plain text. Each returns short problems, phrased as instructions for the AI. */
const FMT_STD = new Set(('add addAll get set put remove contains containsKey size isEmpty equals hashCode toString compareTo length charAt ' +
  'substring indexOf append map filter reduce forEach collect stream of iterate limit sum count apply accept test andThen compose ' +
  'next hasNext getClass clone push pop peek poll offer join start run call sort split strip trim format println print ' +
  'keys values items extend insert copy update lower upper').split(' '));
const FMT_EXT = new RegExp(String.raw`\b(?:(?:previous|earlier|last|next|other|above|preceding|following) cards?|cards? (?:above|before|earlier)` +
  String.raw`|(?:the|this|that) (?:example|code|snippet|listing|program|figure|diagram|table|method|class|function|definition|output|scenario|setup) (?:above|earlier|before|from (?:the )?(?:lecture|notes|slides?|tutorial|lab|textbook|reading))` +
  String.raw`|(?:figure|fig\.|listing|slide|table) ?[1-9]\d*(?:\.\d+)?\b(?!\s*[-+×*/=<>])` +
  String.raw`|as (?:shown|seen|defined|discussed|described|introduced|covered) (?:above|earlier|before|in (?:the )?(?:lecture|notes|slides?|class|tutorial|lab|textbook|reading))` +
  String.raw`|(?:in|from) (?:the )?(?:lecture|lecture notes|slides?|notes|textbook|tutorial|recitation|reading|handout)s?\b(?! on\b)` +
  String.raw`|(?:in|from|of) (?:lecture|L) ?\d+)`, 'i');
const FMT_CARDREF = /\b(?:(?:previous|earlier|last|next|other|above|preceding|following) cards?|cards? (?:above|before|earlier)|(?:the|this|that) (?:example|code|snippet|listing|program|figure|diagram) above|as (?:shown|seen|defined) above)/i;
// code-looking text: statements, calls ending in ;, lambdas, generics, declarations
const FMT_CODELIKE = /(?:\b[A-Za-z_]\w*(?:\.\w+)*\([^()\n]{0,60}\)\s*;)|(?:\b(?:int|double|boolean|String|var|final|void|char|long)\s+[a-z]\w*\s*(?:=|;|\())|(?:\bnew\s+[A-Z]\w*(?:<[^>]*>)?\s*\()|(?:\b[a-z]\w*\s*->\s*[\w(])|(?:\b[A-Z]\w*<[A-Z?][\w<>?, ]*>)|(?:\breturn\s+[^.?!]{1,40};)|(?:\b(?:public|private|protected|static)\s+(?:static\s+|final\s+|abstract\s+)*(?:class|interface|void|int|double|boolean|String|[A-Z]\w*)\b)/;
// maths written as plain text: bare LaTeX commands, powers (x^2, e^{-x}), subscripts (a_1, x_{n+1}), sqrt(…), ∑ ∫ √
const FMT_TEXCMD = String.raw`\\(?:d?frac|sqrt|sum|prod|o?int|lim|log|ln|exp|sin|cos|tan|alpha|beta|gamma|delta|v?epsilon|theta|lambda|mu|pi|rho|sigma|tau|v?phi|omega|Gamma|Delta|Theta|Lambda|Sigma|Phi|Omega|infty|c?dots|ldots|times|div|pm|leq?|geq?|neq|approx|equiv|sim|propto|in|notin|subseteq|supseteq|cup|cap|forall|exists|neg|land|lor|implies|iff|to|mapsto|rightarrow|leftarrow|Rightarrow|Leftrightarrow|partial|nabla|math(?:bb|bf|rm|cal)|text|operatorname|begin|end|left|right|binom|vec|hat|bar|overline|det)(?![A-Za-z])`;
const FMT_TEXCMD_RE = new RegExp(FMT_TEXCMD);
const FMT_MATHLIKE = new RegExp(FMT_TEXCMD + String.raw`|[\w)\]]\^(?:\{[^{}\n]{1,30}\}|[-+]?\w)|\b[A-Za-z]_(?:\{[^{}\n]{1,30}\}|\d+|[a-z])(?!\w)|\bsqrt\s*\(|[∑∏∫∮√]`);
// an equation or theorem the question cites by number, or "the formula above"
const FMT_MATHREF = /\b(?:(?:equations?|eqns?\.?|eq\.)\s*\(?\d+(?:\.\d+)*[a-z]?\)?|(?:theorem|lemma|proposition|corollary|identity|formula)\s+\(?\d+(?:\.\d+)*\)?(?!\s*[-+×*/=<>])|(?:using|by|from|into|see|in|of)\s+\(\d+(?:\.\d+)*\)|(?:the|this|that)\s+(?:equation|formula|identity|theorem|lemma|proof|derivation|result|expression|recurrence)\s+(?:above|earlier|before))/i;
// a formula too big for inline \( … \): line breaks (outside matrices), multi-line environments, or over 80 characters
function mathSqueezed(body){
  const t = decodeEnt(unCloze(body).replace(/<[^>]+>/g, '')).trim();
  return /\\\\/.test(t.replace(/\\begin\{([pbvBV]?matrix|smallmatrix)\}[\s\S]*?\\end\{\1\}/g, '')) || /\\begin\{(?:align|aligned|gather|gathered|split|multline|eqnarray|cases|array)\*?\}/.test(t) || t.length > 80 ? t : '';
}
/** Ignore code samples when deciding whether the card's prose contains displayed maths. */
const mathWithoutCode = h => String(h || '').replace(/<pre\b[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>/gi, ' ');
function mathCodeSamples(h){
  return [...String(h || '').matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>|<code\b([^>]*)>([\s\S]*?)<\/code>/gi)]
    .filter(m => !/\blanguage-/i.test(m[1] || m[3] || '') && !(m[2] && /^\s*<code\b[^>]*\blanguage-/i.test(m[2])))
    .map(m => decodeEnt((m[2] ?? m[4]).replace(/<[^>]+>/g, '')));
}
/** prose outside code and maths (maths in $…$ counts as maths): what's left should have no maths in it */
const mathProse = h => fmtProse(String(fixMath(h || '')).replace(MATH_SPAN_RE, ' ')).replace(/https?:\/\/\S+/g, ' ');
function fmtProse(h){ return decodeEnt(String(h || '').replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<code[^>]*>[\s\S]*?<\/code>/gi, ' ').replace(/<[^>]+>/g, ' ')); }
const unCloze = s => String(s || '').replace(/\{\{c\d+::([\s\S]*?)(?:::[^{}]*)?\}\}/g, '$1');
function decodeEnt(s){ return new DOMParser().parseFromString(String(s).replace(/</g, '&lt;'), 'text/html').body.textContent || ''; }
/* ---- the checker: the same card-quality checks as the skill's validate(), with the same settings (SET.checks, edited on
   the Prompt page and passed to Claude in every prompt). Used by the formatting pass and the Analytics tab. */
const CHECK_DEFS = [
  {key: 'why', group: 'Why this card', label: '"Why" present and long enough', kind: 'level', def: 'warn'},
  {key: 'why_min_words', group: 'Why this card', label: 'Minimum words in "why"', kind: 'num', def: 45, unit: 'words'},
  {key: 'front_max_chars', group: 'Length', label: 'Maximum front length (prose, code and maths not counted)', kind: 'num', def: 300, unit: 'chars'},
  {key: 'back_max_words', group: 'Length', label: 'Maximum answer length (code not counted)', kind: 'num', def: 0, unit: 'words'},
  {key: 'cloze_max_deletions', group: 'Length', label: 'Maximum cloze numbers per note', kind: 'num', def: 3, unit: 'c1…cN'},
  {key: 'multi_question', group: 'One idea per card', label: 'Several questions bundled on one card', kind: 'level', def: 'error'},
  {key: 'outside_refs', group: 'Self-contained', label: 'Points at notes, slides, figures or other cards', kind: 'level', def: 'error'},
  {key: 'unshown_code', group: 'Self-contained', label: "Calls a method whose code the card doesn't show", kind: 'level', def: 'warn'},
  {key: 'unshown_math', group: 'Self-contained', label: "Cites an equation or theorem the card doesn't show", kind: 'level', def: 'warn'},
  {key: 'code_as_text', group: 'Code', label: 'Code written as plain text / squeezed into inline code', kind: 'level', def: 'warn'},
  {key: 'code_language', group: 'Code', label: 'Code block without a language', kind: 'level', def: 'warn'},
  {key: 'code_line_chars', group: 'Code', label: 'Longest line in a code block (fits a phone)', kind: 'num', def: 27, unit: 'chars'},
  {key: 'math_as_text', group: 'Maths', label: 'Maths written as plain text / squeezed into inline maths', kind: 'level', def: 'warn'},
  {key: 'math_in_code', group: 'Maths', label: 'Maths written inside code', kind: 'level', def: 'warn'},
  {key: 'ref_quote_min_chars', group: 'Sources', label: 'Minimum source-quote length', kind: 'num', def: 25, unit: 'chars'},
  {key: 'ref_page', group: 'Sources', label: 'Source reference without a page', kind: 'level', def: 'warn'},
  {key: 'unused_images', group: 'Images', label: 'Image not used by any card (checked by Claude)', kind: 'level', def: 'warn'},
  {key: 'order_window', group: 'Study order', label: 'Spoiler window in the study order', kind: 'num', def: 3, unit: 'cards'}
];
const CHECK_DEFAULTS = Object.fromEntries(CHECK_DEFS.map(d => [d.key, d.def]));
/* exactly what each check looks for (kept in step with cardChecks() below and validate() in anki_helper.py) */
const CHECK_HOW = {
  why: 'Fails when the card\'s "why this card" field is empty once HTML tags are removed.',
  why_min_words: 'Removes HTML tags from "why", splits it on spaces and counts the words. Fails below the minimum. (An empty "why" is reported by the check above instead.) Its level follows the "why" check.',
  front_max_chars: 'Basic cards only. Takes the front, removes code blocks (<pre>), inline <code>, maths \\( … \\) and \\[ … \\], and HTML tags, then counts the characters left (spaces included). Fails above the limit. Always a warning.',
  back_max_words: 'Counts the words on the back (basic cards) or in the cloze text plus Extra (cloze cards), after removing code blocks and HTML tags. Fails above the limit. Always a warning.',
  cloze_max_deletions: 'Cloze cards only. Counts the different numbers used in {{c1::…}}, {{c2::…}} … (c1 used twice counts once). Fails above the limit. Always a warning.',
  multi_question: 'Basic cards only; cards tagged multi-ok are skipped. Three signs, checked in this order: (1) the front has 2+ numbered items (an <ol> list, or lines starting "1." "2)" "(a)" "i." …) AND the back answers them one by one (2+ items written like "1 → …" "2: …", or at least as many lines as items) - error; (2) the front has 2+ question marks outside code - warning; (3) the back answers 3+ numbered items - error. With the level set to warn, all three are warnings.',
  outside_refs: 'Cards tagged refs-ok are skipped. In the question (front, or cloze text) it looks for phrases that point outside the card: "previous / next / other / earlier card", "the example / code / figure / table / method … above" or "… from the notes / lecture / slides", "Figure 3", "Fig. 2", "Slide 12", "Listing 4", "Table 2", "as shown / defined / discussed in the lecture / notes / slides / class", "in / from the notes / slides / lecture / textbook / tutorial / reading", "from L04" / "in lecture 3". On the back and Extra it only looks for references to other cards and to "the example / code / figure above". A numbered "Question 3.1", "Exercise 2" or "Example 4" is only ever a warning (fine when the whole problem is on the card).',
  unshown_code: 'Cards tagged refs-ok, and questions that contain a code block (<pre>), are skipped. Otherwise it looks in the question text and its inline <code> for a method called on a variable: a lowercase name, a dot, a method name and "(" - like p1.distanceTo(p2). Common library methods are ignored (add, get, set, put, remove, contains, size, isEmpty, equals, hashCode, toString, compareTo, length, charAt, substring, indexOf, append, map, filter, reduce, forEach, collect, stream, of, iterate, limit, sum, count, apply, accept, test, andThen, compose, next, hasNext, sort, split, trim, format, println, print and similar).',
  code_as_text: 'Two signs. (1) In the front, back or Extra, outside code tags: a call ending in ";" (foo(x);), a typed declaration (int x = …, String s;), new Foo(…), a lambda (x -> …), generics (List<Integer>), "return …;", or modifiers before a type (public static void, private final Point). (2) Inline <code> holding several statements - 2+ semicolons, a line break, or { … } over 40 characters - in a field without a code block.',
  code_line_chars: 'Code blocks (<pre>) only - not inline <code>, prose or maths. Measures every line of every code block after removing tags and decoding entities, with tabs expanded to the next multiple of 8 (how the card shows them), and fails when the longest line is over the limit. The default, 27, is the width of a phone screen ("public ColoredCircle(Circle"): longer lines make the reader scroll sideways. 0 = no limit. Always a warning.',
  code_language: 'A code block (<pre>) whose <code> has no language-… class, so it is shown without syntax highlighting. code() in the skill always adds one.',
  unshown_math: 'Cards tagged refs-ok, and questions that contain display maths \\[ … \\], are skipped. Otherwise it looks in the question, outside code and maths, for an equation or result cited by number or position: "equation 3", "Eq. (2.1)", "eqn 4", "Theorem 2", "Lemma 3.1", "Proposition / Corollary / Identity / Formula 5", "using / by / from / in (3)", or "the equation / formula / identity / theorem / lemma / proof / derivation / result above / earlier".',
  math_as_text: 'Two signs. (1) In the front, back or Extra, outside code and maths: a LaTeX command (\\frac, \\sum, \\alpha, \\leq, \\begin …), a power (x^2, e^{-x}, (a+b)^2), a one-letter subscript (a_1, x_i, x_{n+1}), sqrt(…), or ∑ ∏ ∫ √. (2) Inline maths \\( … \\) that is too big for a line - a line break \\\\ outside a matrix, an align / aligned / gather / cases / array environment, or over 80 characters.',
  math_in_code: 'Inline <code> or a code block without a language-… class (code with a language, language-latex included, is left alone) holding maths: \\( … \\), \\[ … \\] or a LaTeX command like \\frac or \\sum. Code shows it as raw LaTeX instead of a formula.',
  ref_quote_min_chars: 'Each source reference\'s quote, with runs of spaces collapsed, must be at least this many characters, so it can be found again in the material. (When the material is loaded, Claude also checks that the quote really is on that page - that part is always an error.)',
  ref_page: 'A source reference to a file (anything that isn\'t an http(s) address) without a page number.',
  unused_images: 'Run by Claude only: an image registered on the deck that no card\'s HTML uses.',
  order_window: 'Used by Claude when it orders the cards: a card counts as spoiling a later one if it comes up to this many places earlier and its answer terms, numbers or image give away the later card\'s answer.',
  missing_img: 'Studio only: a card shows an image whose file is not in the project (or could not be downloaded).'
};
const ck = () => { let c = null; try { c = SET.checks; } catch {} return {...CHECK_DEFAULTS, ...(c || {})}; };   // SET may not exist yet during start-up
function plainLines(h){
  const t = decodeEnt(String(h || '').replace(/<pre[\s\S]*?<\/pre>/gi, ' [code] ').replace(/<\/?(br|p|div|li|tr|h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''));
  return t.split('\n').map(x => x.trim()).filter(Boolean);
}
function multiQuestion(c){
  if (c.type === 'cloze') return [];
  const q = String(c.front || ''), a = String(c.back || '');
  let n = /<ol\b/i.test(q) ? (q.match(/<li\b/gi) || []).length : 0;
  n = Math.max(n, plainLines(q).filter(l => /^(\(?\d+[.):]|\(?[a-h]\)|[ivx]+[.)])\s/.test(l)).length);
  const mapped = (plainLines(a).join(' ').match(/(?:^|[\s;,(])\(?\d+\)?\s*(?:→|->|=>|:)\s*\S/g) || []).length;
  const qm = (q.replace(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/gi, '').match(/\?(?=\s|$|<)/g) || []).length;
  if (n >= 2 && (mapped >= 2 || plainLines(a).length >= n)) return [['E', `It asks ${n} questions at once (numbered items with one answer each): make one card per item.`]];
  if (qm >= 2) return [['W', `The front has ${qm} question marks: one question per card.`]];
  if (mapped >= 3) return [['E', `The back answers ${mapped} numbered items: one question per card.`]];
  return [];
}
/** every configurable check this card fails: [{key, level: 'E'|'W', msg}] (msg is written as an instruction) */
function cardChecks(c, C = ck()){
  const out = [], tags = c.tags || [], cloze = c.type === 'cloze';
  const add = (key, designed, msg) => { const lv = C[key]; if (lv === 'off') return; out.push({key, level: lv === 'warn' ? 'W' : designed, msg}); };
  const strict = (key, msg) => { const lv = C[key]; if (lv !== 'off') out.push({key, level: lv === 'error' ? 'E' : 'W', msg}); };
  const why = String(c.why || '').trim(), wn = why ? decodeEnt(why.replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean).length : 0;
  if (!why) strict('why', 'There is no "why this card" rationale.');
  else if (C.why_min_words && wn < C.why_min_words) out.push(...(C.why === 'off' ? [] : [{key: 'why_min_words', level: C.why === 'error' ? 'E' : 'W', msg: `The "why" has ${wn} words (minimum ${C.why_min_words}).`}]));
  if (!cloze && C.front_max_chars){
    const n = decodeEnt(String(c.front || '').replace(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/gi, '').replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, '').replace(/<[^>]+>/g, '')).length;
    if (n > C.front_max_chars) out.push({key: 'front_max_chars', level: 'W', msg: `The front has ${n} characters of prose (limit ${C.front_max_chars}).`});
  }
  if (C.back_max_words){
    const n = decodeEnt(String(cloze ? (c.text || '') + ' ' + (c.extra || '') : c.back || '').replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean).length;
    if (n > C.back_max_words) out.push({key: 'back_max_words', level: 'W', msg: `The answer has ${n} words (limit ${C.back_max_words}).`});
  }
  if (cloze && C.cloze_max_deletions){
    const n = new Set([...String(c.text || '').matchAll(/\{\{c(\d+)::/g)].map(m => m[1])).size;
    if (n > C.cloze_max_deletions) out.push({key: 'cloze_max_deletions', level: 'W', msg: `${n} cloze numbers (limit ${C.cloze_max_deletions}): split it, or hide related items under one number.`});
  }
  if (!tags.includes('multi-ok')) for (const [lv, m] of multiQuestion(c)) add('multi_question', lv, m);
  const q = unCloze((cloze ? c.text : c.front) || ''), a = cloze ? '' : String(c.back || ''), ex = String(c.extra || '');
  if (!tags.includes('refs-ok')){
    const plainQ = decodeEnt(q.replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<[^>]+>/g, ' '));
    const plainAll = decodeEnt((q + ' ' + a + ' ' + ex).replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<[^>]+>/g, ' '));
    const m = FMT_EXT.exec(plainQ) || FMT_CARDREF.exec(plainAll);
    if (m){
      if (/^(?:question|exercise|example)\b/i.test(m[0])) out.push({key: 'outside_refs', level: 'W', msg: `"${m[0]}" is a label from the source: fine if the whole problem is on the card, otherwise copy in what it refers to.`});
      else add('outside_refs', 'E', `It depends on something the reader can't see ("${m[0]}"): put that code, figure or definition on the card itself.`);
    }
    if (!/<pre/i.test(q)){
      const txt = decodeEnt([...q.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)].map(x => x[1]).join(' ') + ' ' + plainQ).replace(/<[^>]+>/g, '');
      const call = [...txt.matchAll(/\b([a-z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\s*\(/g)].find(x => !FMT_STD.has(x[2]));
      if (call) strict('unshown_code', `The question uses ${call[1]}.${call[2]}(…) but the front doesn't show ${call[2]}'s code: if answering depends on what it does (parameters, body, fields), show it in a code block on the front.`);
    }
  }
  const parts = [[cloze ? 'Text' : 'Front', q], ['Back', a], ['Extra', ex]];
  for (const [name, h] of parts){
    const hit = FMT_CODELIKE.exec(fmtProse(h));
    if (hit){ strict('code_as_text', `${name} has code written as plain text ("${hit[0].trim().slice(0, 40)}"): format it as code (code blocks for statements/snippets, <code> for names).`); break; }
  }
  for (const [name, h] of parts){
    if (/<pre/i.test(h)) continue;
    const long = [...h.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)].map(x => decodeEnt(x[1].replace(/<[^>]+>/g, ''))).find(t => (t.match(/;/g) || []).length >= 2 || /\n/.test(t.trim()) || /\{[\s\S]*\}/.test(t) && t.length > 40);
    if (long){ strict('code_as_text', `${name} squeezes several lines of code into inline <code> ("${long.trim().slice(0, 40)}…"): use a code block.`); break; }
  }
  if (FIELDS[c.type].some(f => /<pre(?![^>]*>\s*<code)|<pre[^>]*>\s*<code(?![^>]*language-)/i.test(c[f] || ''))) strict('code_language', 'A code block has no language, so it is not highlighted.');
  if (C.code_line_chars){
    const long = codeLines(c).filter(l => l.length > C.code_line_chars);
    if (long.length){ const w = long.reduce((a, l) => l.length > a.length ? l : a);
      out.push({key: 'code_line_chars', level: 'W', msg: `${long.length} code line${long.length > 1 ? 's are' : ' is'} longer than ${C.code_line_chars} characters (the longest has ${w.length}: "${w.trim().slice(0, 40)}"): break long lines so each code block fits a phone screen without scrolling sideways.`}); }
  }
  if (!tags.includes('refs-ok') && !/\\\[/.test(fixMath(mathWithoutCode(q)))){
    const m = FMT_MATHREF.exec(mathProse(q));
    if (m) strict('unshown_math', `The question cites "${m[0].trim()}" but the card doesn't state it: if answering needs it, write it on the front as maths (\\[ … \\]).`);
  }
  for (const [name, h] of parts){
    const hit = FMT_MATHLIKE.exec(mathProse(h));
    if (hit){ strict('math_as_text', `${name} has maths written as plain text ("${hit[0].trim().slice(0, 40)}"): write it as LaTeX in \\( … \\) (inline) or \\[ … \\] (display).`); break; }
  }
  for (const [name, h] of parts){
    const big = [...String(fixMath(mathWithoutCode(h))).matchAll(MATH_SPAN_RE)].map(x => x[1] !== undefined ? mathSqueezed(x[1]) : '').find(Boolean);
    if (big){ strict('math_as_text', `${name} squeezes a multi-line or long formula into inline \\( … \\) ("${big.slice(0, 40)}…"): use display maths \\[ … \\].`); break; }
  }
  for (const [name, h] of parts){
    const hit = mathCodeSamples(h).find(t => /\\\(|\\\[/.test(t) || FMT_TEXCMD_RE.test(t));
    if (hit){ strict('math_in_code', `${name} has maths inside code ("${hit.trim().slice(0, 40)}"), so it shows as raw LaTeX: write it as maths, \\( … \\) inline or \\[ … \\] display.`); break; }
  }
  for (const r of c.refs || []){
    if (r && r.file && !r.page && !/^https?:/.test(r.file)){ strict('ref_page', `The source reference to ${r.file} has no page.`); break; }
  }
  for (const r of c.refs || []){
    const n = String((r && r.quote) || '').replace(/\s+/g, ' ').trim().length;
    if (n && C.ref_quote_min_chars && n < C.ref_quote_min_chars){ out.push({key: 'ref_quote_min_chars', level: 'W', msg: `A source quote is only ${n} characters (minimum ${C.ref_quote_min_chars}).`}); break; }
  }
  return out;
}
/** every line of the card's code blocks, as the reader sees it: tags removed, entities decoded, tabs expanded to 8 */
function codeLines(c){
  const out = [];
  for (const f of FIELDS[c.type]) for (const m of String(c[f] || '').matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi))
    for (const l of decodeEnt(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).split('\n'))
      out.push(l.replace(/[^\t]*\t/g, s => s.slice(0, -1) + ' '.repeat(8 - (s.length - 1) % 8)).replace(/\s+$/, ''));
  return out;
}
/** what the formatting pass sends: the presentation problems only */
const FMT_KEYS = new Set(['outside_refs', 'unshown_code', 'code_as_text', 'code_language', 'code_line_chars', 'unshown_math', 'math_as_text', 'math_in_code']);
/* checks are re-run for a card only when it or the settings change (Analytics and the check filter look at every card) */
const chkMemo = new WeakMap();
function checksOf(c, C = ck(), cs = J(C)){
  const sig = [c.type, c.front, c.back, c.text, c.extra, c.why, (c.tags || []).join(' '), c.refs ? J(c.refs) : '', cs], m = chkMemo.get(c);
  if (m && m.sig.every((v, i) => v === sig[i])) return m.res;
  const res = cardChecks(c, C); chkMemo.set(c, {sig, res}); return res;
}
// a check key as used by the Review filter ("chk:<key>"); 'missing_img' is the Studio's own image check
const CHECK_ROWS = [
  {key: 'why', label: 'No "why this card"', test: c => checksOf(c).some(x => x.key === 'why')},
  {key: 'why_min_words', label: '"Why" too short', test: c => checksOf(c).some(x => x.key === 'why_min_words')},
  ...['front_max_chars', 'back_max_words', 'cloze_max_deletions', 'multi_question', 'outside_refs', 'unshown_code', 'code_as_text', 'code_language', 'code_line_chars', 'unshown_math', 'math_as_text', 'math_in_code', 'ref_page', 'ref_quote_min_chars']
    .map(k => ({key: k, label: CHECK_DEFS.find(d => d.key === k).label, test: c => checksOf(c).some(x => x.key === k)})),
  {key: 'missing_img', label: 'Image missing or not loaded', test: c => cardMissing(c), studio: true}
];
const checkRow = k => CHECK_ROWS.find(r => r.key === k);
function showCheckCards(key, wholeProject){
  const r = checkRow(key); if (!r) return;
  ensureCheckOption(key); S.filter = 'chk:' + key; $('#filter').value = S.filter;
  const go = () => { const first = filtered()[0]; if (first) S.curId = first.id; showTab('review'); };
  if (wholeProject && S.scope !== 'root') setScope('root').then(go); else go();
}
function ensureCheckOption(key){
  const sel = $('#filter'); if (!sel) return;
  sel.querySelectorAll('option[data-chk]').forEach(o => { if (o.value !== 'chk:' + key) o.remove(); });
  if (!sel.querySelector(`option[value="chk:${key}"]`)){ const r = checkRow(key); if (!r) return;
    const o = document.createElement('option'); o.value = 'chk:' + key; o.dataset.chk = 1; o.textContent = 'Check: ' + r.label; sel.appendChild(o); }
}
function formatIssues(c){ return checksOf(c).filter(x => FMT_KEYS.has(x.key)).map(x => x.msg); }
/** what the checker fix sends: every other check the Studio runs (content, length, rationale and sources) */
const FIX_KEYS = new Set(['why', 'why_min_words', 'front_max_chars', 'back_max_words', 'cloze_max_deletions', 'multi_question', 'ref_page', 'ref_quote_min_chars']);
function fixIssues(c){ return checksOf(c).filter(x => FIX_KEYS.has(x.key)).map(x => x.msg); }

/** set a card's review status; any decision on a card also settles a pending formatting re-check */
function setCardStatus(c, st){ c.status = st; if (c.recheck) delete c.recheck; }
function filtered(){
  const q = S.q.toLowerCase();
  return ordered(S.cards.filter(c => {
    if (!inScope(c)) return false;
    if (S.deckFilter && cardDeck(c) !== S.deckFilter) return false;
    if (S.filter === 'edited' && !c.edited) return false;
    if (S.filter === 'missing' && !cardMissing(c)) return false;
    if (S.filter === 'brokenimg' && !cardBrokenImg(c)) return false;
    if (S.filter === 'recheck' && !c.recheck) return false;
    if (S.filter.startsWith('chk:')){ const r = checkRow(S.filter.slice(4)); if (r && !r.test(c)) return false; }
    if (['new','ok','change','drop'].includes(S.filter) && c.status !== S.filter) return false;
    if (q && !(c.id + ' ' + FIELDS[c.type].map(f => c[f]).join(' ') + ' ' + c.tags.join(' ')).toLowerCase().includes(q)) return false;
    return true;
  }), S.order || 'source');
}
function renderOrderControls(){
  const os = $('#orderSel'); os.value = S.order || 'source'; os.disabled = !hasOrder();
  os.options[1].text = hasOrder() ? 'Order: interleaved (anti-spoiler)' : 'Order: interleaved (none in bundle)';
  const decks = allDecks(), df = $('#deckFilter');
  df.hidden = decks.length < 2;
  if (decks.length >= 2){
    if (S.deckFilter && !decks.includes(S.deckFilter)) S.deckFilter = '';
    df.innerHTML = `<option value="">All decks (${decks.length})</option>` + decks.map(d => `<option value="${esc(d)}" ${d === S.deckFilter ? 'selected' : ''}>${esc(d.split('::').slice(-1)[0])} (${S.cards.filter(c => cardDeck(c) === d).length})</option>`).join('');
  } else S.deckFilter = '';
}
$('#orderSel').onchange = e => { S.order = e.target.value; save(); renderReview(); };
$('#deckFilter').onchange = e => { S.deckFilter = e.target.value; renderReview(); };
function cardTitle(c){ return stripHtml(c.type === 'cloze' ? c.text.replace(/\{\{c\d+::([\s\S]*?)(::[\s\S]*?)?\}\}/g, '[$1]') : c.front) || '(empty)'; }
const listRow = c => `<div class="ci ${c.id === S.curId ? 'cur' : ''} ${c.status}" data-id="${esc(c.id)}">
    <span class="dot ${c.status}"></span><div style="min-width:0"><div class="id">${esc(c.id)} · ${c.type}${S.order === 'mixed' && typeof c.ord === 'number' ? ' · #' + (Math.round(c.ord % 100000) + 1) : ''}${c.edited ? ' · <span style="color:#8250df">edited</span>' : ''}${c.recheck ? ' · <span style="color:var(--warn)">re-check</span>' : ''}${cardMissing(c) ? ' · <span style="color:var(--warn)">img?</span>' : ''}</div><div class="t">${esc(cardTitle(c))}</div></div><span class="tm ${c.id === S.curId ? 'live' : ''}" data-tm="${esc(c.id)}">${fmtTime(c.time)}</span></div>`;
/* the card list is rebuilt only when the cards shown (or their order) change; otherwise only rows that differ are
   replaced, so moving or swiping touches 2-3 rows instead of rebuilding ~1000 */
let listState = {key: null, rows: new Map(), sigs: new Map()};
// everything a row's HTML depends on (strings compare by reference when unchanged, so this is fast)
const rowSig = c => [c.id === S.curId, c.status, c.type, fmtTime(c.time), !!c.edited, !!c.recheck, c.front, c.text, c.back, S.order, c.ord, cardMissing(c)];
function renderList(){
  const list = filtered(), box = $('#cardItems');
  const key = curProject + '|' + list.map(c => c.id).join('|');
  if (!list.length){ box.innerHTML = '<div class="muted small" style="padding:8px">No cards match.</div>'; listState = {key: null, rows: new Map(), sigs: new Map()}; }
  else if (key !== listState.key || box.children.length !== list.length){
    const rows = new Map(list.map(c => [c.id, listRow(c)]));
    box.innerHTML = [...rows.values()].join('');
    listState = {key, rows, sigs: new Map(list.map(c => [c.id, rowSig(c)]))};
  } else {
    list.forEach((c, i) => {
      // cheap check first: only rebuild a row's HTML when something it shows may have changed
      const sg = rowSig(c), prev = listState.sigs.get(c.id);
      if (prev && prev.length === sg.length && prev.every((v, k) => v === sg[k])) return;
      listState.sigs.set(c.id, sg);
      const h = listRow(c);
      if (listState.rows.get(c.id) !== h){ listState.rows.set(c.id, h); const el = box.children[i]; if (el) el.outerHTML = h; }
    });
  }
  const n = S.cards.length || 1, cnt = k => S.cards.filter(c => c.status === k).length;
  $('#progBar').innerHTML = `<i style="width:${cnt('ok') / n * 100}%;background:var(--ok)"></i><i style="width:${cnt('change') / n * 100}%;background:var(--warn)"></i><i style="width:${cnt('drop') / n * 100}%;background:var(--bad)"></i>`;
  const total = S.cards.reduce((a, c) => a + (c.time || 0), 0);
  // average over cards you actually spent time on (≥ 2 s), projected onto the unreviewed ones
  const timed = S.cards.filter(c => (c.time || 0) >= 2 && c.status !== 'new');
  const avg = timed.length ? timed.reduce((a, c) => a + c.time, 0) / timed.length : 0;
  const left = cnt('new');
  $('#progText').innerHTML = `${cnt('ok')} approved · ${cnt('change')} change · ${cnt('drop')} excluded · ${left} left<br>⏱ ${fmtTime(total, true)} spent`
    + (avg ? ` · avg <b>${fmtTime(avg, true)}</b>/card · ~<b>${fmtTime(avg * left, true)}</b> to go` : '');
  if (centerNext){ centerNext = false; centerCurrent(); }
}
let centerNext = true;
function centerCurrent(){
  const box = $('#cardItems'), el = $('#cardItems .ci.cur'); if (!box || !el) return;
  box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
}
$('#cardItems').addEventListener('click', e => { const it = e.target.closest('.ci'); if (it){ select(it.dataset.id); } });
$('#filter').onchange = e => { S.filter = e.target.value; renderList(); };
$('#search').oninput = debounce(e => { S.q = e.target.value; renderList(); }, 120);
// moving to a card isn't a change to upload; the position is remembered in this browser
function select(id){ S.curId = id; side = 'back'; clozeN = 1; centerNext = true; renderReview(); try { localStorage.setItem('acs-cur:' + curProject, id); } catch {} }
function move(delta){
  const list = filtered(); if (!list.length) return;
  let i = list.findIndex(c => c.id === S.curId);
  i = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta));
  select(list[i].id);
}
function nextUnreviewed(){
  const list = filtered(); const i = list.findIndex(c => c.id === S.curId);
  // in the Re-check view "next" means the next card still waiting for a re-check
  const pending = S.filter === 'recheck' ? (c => c.recheck) : (c => c.status === 'new');
  const nxt = list.slice(i + 1).find(pending) || list.find(c => pending(c) && c.id !== S.curId);
  if (nxt) select(nxt.id); else { move(1); toast('All cards in this view are reviewed 🎉'); }
}

function renderReview(){
  const has = S.cards.length > 0;
  $('#reviewEmpty').hidden = has; $('#reviewUI').hidden = !has;
  updateTabCounts();
  if (!has) return;
  if (!curCard()) S.curId = S.cards[0].id;
  const c = curCard();
  renderOrderControls();
  renderList();
  const list = filtered(), pos = list.findIndex(x => x.id === c.id);
  $('#curLabel').textContent = `${c.id}  (${pos >= 0 ? pos + 1 : '–'} / ${list.length})`;
  $('#hudPos').textContent = `${pos >= 0 ? pos + 1 : '–'} / ${list.length}`;
  { const stt = c.recheck ? '⟳ Re-check' : {ok: '✓ Approved', drop: '✕ Excluded', change: '✎ Change'}[c.status] || ''; $('#hudStatus').textContent = stt; $('#hudStatus').className = stt ? 's-' + (c.recheck ? 'change' : c.status) : ''; }
  $('#curTimer').textContent = '⏱ ' + fmtTime(c.time, true);
  $('#curBadges').innerHTML = badgesHTML(c);
  $('#edType').value = c.type;
  $('#stOk').classList.toggle('on', c.status === 'ok'); $('#stChange').classList.toggle('on', c.status === 'change'); $('#stDrop').classList.toggle('on', c.status === 'drop');
  if (document.activeElement !== $('#edFeedback')) $('#edFeedback').value = c.feedback || '';
  syncMobileBar();
  $('#prevWrap').hidden = !c.prev;
  if (c.prev){
    $('#prevBox').innerHTML = prevDiffHTML(c);
    $('#prevSum').textContent = c.recheck ? 'What the formatting pass / checker fix changed' : 'Show previous version & feedback';
    // a re-check is about the changes, so show them straight away (once per card, so closing it sticks)
    if ($('#prevWrap').dataset.card !== c.id){ $('#prevWrap').dataset.card = c.id; $('#prevWrap').open = !!c.recheck; }
  }
  renderFields(c);
  renderImages(c);
  renderPreview();
}
function renderFields(c){
  const panel = $('#fieldsPanel');
  if (panel.dataset.card === c.id && panel.dataset.type === c.type && !panel.dataset.dirty){ // keep focus/cursor; just sync values not being edited
    for (const f of FIELDS[c.type]){ const ta = panel.querySelector(`textarea[data-f="${f}"]`); if (ta && ta !== document.activeElement && ta.dataset.src !== c[f]) showField(ta, c[f]); }
    const tg = $('#edTags'); if (tg !== document.activeElement) tg.value = c.tags.join(' ');
    return;
  }
  if (panel.dataset.type === c.type && !panel.dataset.dirty && panel.querySelector('#edTags')){   // same kind of card: keep the toolbars, swap the values
    panel.dataset.card = c.id;
    for (const f of FIELDS[c.type]){ const ta = panel.querySelector(`textarea[data-f="${f}"]`); if (ta) showField(ta, c[f]); }
    $('#edTags').value = c.tags.join(' ');
    return;
  }
  panel.dataset.card = c.id; panel.dataset.type = c.type; delete panel.dataset.dirty;
  const tb = f => `<button data-act="b" title="Bold"><b>B</b></button><button data-act="i" title="Italic"><i>I</i></button><button data-act="u" title="Underline"><u>U</u></button><button data-act="sub" title="Subscript">x₂</button><button data-act="sup" title="Superscript">x²</button><button data-act="ul" title="Bullet list">• list</button><button data-act="br" title="Line break">↵</button>
    ${f !== 'source' ? '<button data-act="code" title="Code block (asks for the language; escapes the selection)">&lt;/&gt;</button><button data-act="math" title="Maths: \\( … \\)">∑</button>' : ''}${f === 'back' ? '<button data-act="answer" title="Direct-answer block">Answer</button>' : ''}
    ${f !== 'source' ? `<select data-act="box" title="Insert a styled box"><option value="">Box…</option>${BOX_KINDS.map(k => `<option value="${k}">${BOX_TITLES[k]}</option>`).join('')}</select><button data-act="img" title="Insert image here">🖼</button>` : ''}
    ${f === 'text' ? '<button data-act="cloze" title="Make cloze (new number)">[…] cloze</button><button data-act="clozeSame" title="Cloze with same number as last">[…] same #</button>' : ''}`;
  panel.innerHTML = '<h3 class="ph-only" style="margin:0">✎ Edit card</h3>' + FIELDS[c.type].map(f => `<div class="field"><div class="fh"><b>${FIELD_LABEL[f]}</b>${tb(f)}</div><div class="hl-wrap"><pre class="hl-pre" aria-hidden="true"></pre><textarea data-f="${f}" rows="${f === 'source' ? 1 : f === 'front' ? 3 : 6}" spellcheck="false"></textarea></div></div>`).join('')
    + `<label class="f">Tags<span class="hint">space-separated</span><input type="text" id="edTags"></label>`;
  for (const f of FIELDS[c.type]) showField(panel.querySelector(`textarea[data-f="${f}"]`), c[f]);
  $('#edTags').value = c.tags.join(' ');
}
/** put a field's HTML in its editor, indented for reading (the stored value only changes when you edit it) */
function showField(ta, v){
  v = v || '';
  ta.value = ta.dataset.f === 'source' ? v : formatHTML(v);
  ta.dataset.src = v; delete ta.dataset.typed; sizeSoon(ta);
  // colour it after the card is on screen: highlighting several fields is the slowest part of moving to the next card
  const pre = ta.previousElementSibling; if (pre && pre.classList.contains('hl-pre')) pre.textContent = ta.value + (ta.value.endsWith('\n') ? ' ' : '');
  const want = ta.value; requestAnimationFrame(() => setTimeout(() => { if (ta.value === want && ta.isConnected) syncHl(ta); }, 0));
}
/** paint the HTML in a field editor (textarea text is transparent; the <pre> behind it shows the colours) */
function syncHl(ta){
  const pre = ta.previousElementSibling; if (!pre || !pre.classList.contains('hl-pre')) return;
  const v = ta.value;
  let h;
  try { h = window.hljs ? hljs.highlight(v, {language: 'xml', ignoreIllegals: true}).value : esc(v); } catch { h = esc(v); }
  h = h.replace(/\{\{c\d+::|::(?=[^{}]*\}\})|\}\}/g, m => `<span class="hl-cloze">${m}</span>`).replace(/&amp;[a-z#0-9]+;/gi, m => `<span class="hl-ent">${m}</span>`);
  pre.innerHTML = h + (v.endsWith('\n') ? ' ' : '');
  pre.scrollTop = ta.scrollTop;
}
document.addEventListener('scroll', e => { if (e.target.matches && e.target.matches('.hl-wrap textarea')) e.target.previousElementSibling.scrollTop = e.target.scrollTop; }, true);
function markEdited(c){ if (!c.edited){ c.edited = true; renderReviewSoft(); } }
function autosize(ta){ ta.style.height = 'auto'; ta.style.height = Math.min(420, ta.scrollHeight + 4) + 'px'; }
/* fit several editors at once: all writes, then all reads, then all writes = one page layout instead of one per field */
const sizeQ = new Set();
function sizeSoon(ta){
  if (!sizeQ.size) queueMicrotask(() => {
    const tas = [...sizeQ].filter(t => t.isConnected); sizeQ.clear();
    tas.forEach(t => t.style.height = 'auto');
    const hs = tas.map(t => t.scrollHeight);
    tas.forEach((t, i) => t.style.height = Math.min(420, hs[i] + 4) + 'px');
  });
  sizeQ.add(ta);
}
let lastField = null;  // {f, start, end}
$('#fieldsPanel').addEventListener('input', e => {
  const c = curCard(); if (!c) return;
  if (e.target.matches('textarea[data-f]')){ c[e.target.dataset.f] = e.target.dataset.src = e.target.value; e.target.dataset.typed = '1'; autosize(e.target); syncHl(e.target); }
  if (e.target.id === 'edTags') c.tags = e.target.value.split(/\s+/).filter(Boolean);
  markEdited(c);
  save(); renderPreviewSoon(); renderListSoon(); renderImagesSoon();
});
$('#fieldsPanel').addEventListener('focusin', e => { if (e.target.matches('textarea[data-f]')) trackCursor(e.target); });
// leaving a field you typed in re-indents it
$('#fieldsPanel').addEventListener('focusout', e => {
  const ta = e.target; if (!ta.matches || !ta.matches('textarea[data-f]') || !ta.dataset.typed || ta.dataset.f === 'source') return;
  delete ta.dataset.typed;
  const c = curCard(), f = formatHTML(ta.value);
  if (c && f !== ta.value){ ta.value = c[ta.dataset.f] = ta.dataset.src = f; autosize(ta); syncHl(ta); save(); }
});
// Enter keeps the current line's indentation (one level more after an opening block tag)
$('#fieldsPanel').addEventListener('keydown', e => {
  const ta = e.target;
  if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || !ta.matches('textarea[data-f]')) return;
  const v = ta.value, at = ta.selectionStart, ls = v.lastIndexOf('\n', at - 1) + 1, line = v.slice(ls, at);
  let ind = (line.match(/^\s*/) || [''])[0];
  const opened = line.match(/<([a-zA-Z][\w-]*)\b[^>]*>\s*$/);
  if (opened && FMT_BLOCK.has(opened[1].toLowerCase()) && !new RegExp(`</${opened[1]}>`, 'i').test(line)) ind += '  ';
  e.preventDefault();
  ta.setRangeText('\n' + ind, at, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', {bubbles: true}));
});
$('#fieldsPanel').addEventListener('keyup', e => { if (e.target.matches('textarea[data-f]')) trackCursor(e.target); });
$('#fieldsPanel').addEventListener('mouseup', e => { if (e.target.matches('textarea[data-f]')) trackCursor(e.target); });
function trackCursor(ta){ lastField = {f: ta.dataset.f, start: ta.selectionStart, end: ta.selectionEnd}; }
function insertIntoField(f, before, after = '', placeholder = ''){
  const c = curCard(); const ta = $(`#fieldsPanel textarea[data-f="${f}"]`); if (!c || !ta) return;
  const useLast = lastField && lastField.f === f;
  const s = useLast ? lastField.start : ta.value.length, e = useLast ? lastField.end : ta.value.length;
  const sel = ta.value.slice(s, e) || placeholder;
  ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
  c[f] = ta.dataset.src = ta.value; ta.dataset.typed = '1'; autosize(ta); syncHl(ta); markEdited(c); ta.focus();
  ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length; trackCursor(ta);
  save(); renderPreview(); renderList(); renderImages(c);
}
$('#fieldsPanel').addEventListener('mousedown', e => { if (e.target.closest('.fh button')) e.preventDefault(); });
$('#fieldsPanel').addEventListener('click', e => {
  const b = e.target.closest('.fh button'); if (!b) return;
  const f = b.closest('.field').querySelector('textarea').dataset.f;
  if (!lastField || lastField.f !== f) trackCursor(b.closest('.field').querySelector('textarea'));
  const act = b.dataset.act;
  const wrap = {b: ['<b>', '</b>'], i: ['<i>', '</i>'], u: ['<u>', '</u>'], sub: ['<sub>', '</sub>'], sup: ['<sup>', '</sup>'], ul: ['<ul><li>', '</li></ul>'], answer: ['<div class="aa-answer">', '</div>']}[act];
  if (wrap) return insertIntoField(f, wrap[0], wrap[1], act === 'answer' ? 'Direct answer' : '');
  if (act === 'br') return insertIntoField(f, '<br>');
  if (act === 'math') return insertIntoField(f, '\\(', '\\)', 'x^2');
  if (act === 'code'){
    const lang = (prompt('Language for highlighting (java, python, js, c, cpp, sql, bash … or empty):', localStorage.getItem('acs-code-lang') || 'java') || '').trim().replace(/[^\w+#-]/g, '');
    try { localStorage.setItem('acs-code-lang', lang); } catch {}
    const ta = $(`#fieldsPanel textarea[data-f="${f}"]`), s0 = lastField ? lastField.start : ta.value.length, e0 = lastField ? lastField.end : ta.value.length;
    const sel = ta.value.slice(s0, e0);
    // the selection is code text: escape it, so <, > and & survive
    const body = sel ? sel.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'code';
    ta.value = ta.value.slice(0, s0) + ta.value.slice(e0); lastField = {f, start: s0, end: s0};
    return insertIntoField(f, `<pre><code${lang ? ` class="language-${lang}"` : ''}>`, '</code></pre>', body);
  }
  if (act === 'img') return openImageDialog({target: {f}});
  if (act === 'cloze' || act === 'clozeSame'){
    const c = curCard(); const nums = [...(c.text || '').matchAll(/\{\{c(\d+)::/g)].map(m => +m[1]);
    const n = act === 'cloze' ? (nums.length ? Math.max(...nums) + 1 : 1) : (nums.length ? Math.max(...nums) : 1);
    return insertIntoField(f, `{{c${n}::`, '}}', 'answer');
  }
});
$('#fieldsPanel').addEventListener('change', e => {
  const s = e.target.closest('select[data-act="box"]'); if (!s || !s.value) return;
  const f = s.closest('.field').querySelector('textarea').dataset.f, k = s.value; s.value = '';
  insertIntoField(f, `<div class="aa-box aa-${k}"><div class="aa-box-title">${BOX_TITLES[k]}</div>`, '</div>', '…');
});
$('#fieldsPanel').addEventListener('paste', e => {
  const ta = e.target.closest('textarea[data-f]'); if (!ta) return;
  const file = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault(); trackCursor(ta);
  openImageDialog({target: {f: ta.dataset.f}, blob: file.getAsFile()});
});
const renderPreviewSoon = debounce(() => renderPreview(), 120);
const renderListSoon = debounce(() => renderList(), 400);
const renderImagesSoon = debounce(() => { const c = curCard(); if (c) renderImages(c); }, 400);

$('#edType').onchange = e => {
  const c = curCard(); const t = e.target.value; if (c.type === t) return;
  if (t === 'cloze' && !c.text) c.text = c.front + (c.back ? '<br>{{c1::' + stripHtml(c.back).slice(0, 80) + '}}' : '');
  if (t === 'basic' && !c.front) { c.front = c.text.replace(/\{\{c\d+::([\s\S]*?)(::[\s\S]*?)?\}\}/g, '[…]'); c.back = c.back || c.text.replace(/\{\{c\d+::([\s\S]*?)(::[\s\S]*?)?\}\}/g, '<b>$1</b>'); }
  c.type = t; save(); renderReview();
};
$('#edFeedback').addEventListener('input', e => {
  const c = curCard(); c.feedback = e.target.value;
  if (c.feedback.trim() && c.status !== 'change'){ setCardStatus(c, 'change'); renderReviewSoft(); }
  save();
});
/* line diff (longest common subsequence) of each field's indented HTML: the previous version against the current one */
function lineDiff(a, b){
  if (a.length * b.length > 250000) return [...a.map(t => ['-', t]), ...b.map(t => ['+', t])];
  const L = Array.from({length: a.length + 1}, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < a.length && j < b.length){ if (a[i] === b[j]){ out.push([' ', a[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]); }
  while (i < a.length) out.push(['-', a[i++]]); while (j < b.length) out.push(['+', b[j++]]);
  return out;
}
function prevDiffHTML(c){
  const p = c.prev, fields = [...new Set([...(FIELDS[p.type] || []), ...(FIELDS[c.type] || [])])];
  let h = p.feedback ? `<div style="margin-bottom:6px"><b>Your feedback:</b> ${esc(p.feedback)}</div>` : '';
  if (p.type !== c.type) h += `<div>Type: ${esc(p.type)} → ${esc(c.type)}</div>`;
  let changed = 0;
  // older versions were saved without their "why": only compare it when it was kept
  for (const f of 'why' in p ? [...fields, 'why'] : fields){
    const a = String(p[f] || ''), b = String(c[f] || ''); if (a === b) continue; changed++;
    const fa = (f === 'source' ? a : formatHTML(a)).split('\n'), fb = (f === 'source' ? b : formatHTML(b)).split('\n');
    const d = lineDiff(fa, fb);
    // keep 2 lines of context around each change
    const keep = d.map((x, k) => x[0] !== ' ' || d.slice(Math.max(0, k - 2), k + 3).some(y => y[0] !== ' '));
    let rows = '', gap = false;
    d.forEach((x, k) => { if (!keep[k]){ if (!gap) rows += '<div class="df-gap">⋯</div>'; gap = true; return; } gap = false;
      rows += `<div class="df-${x[0] === '+' ? 'add' : x[0] === '-' ? 'del' : 'ctx'}">${x[0] === ' ' ? '&nbsp;' : x[0]} ${esc(x[1]) || '&nbsp;'}</div>`; });
    h += `<div class="df-field"><b>${esc(FIELD_LABEL[f] || (f === 'why' ? 'Why this card' : f))}</b><div class="df">${rows}</div></div>`;
  }
  // source references, when the old version kept them
  const refTxt = rs => (rs || []).map(r => `${r.file}${r.page ? ' p. ' + r.page : ''}${r.quote ? ': "' + r.quote + '"' : ''}`);
  if ('refs' in p && J(p.refs || []) !== J(c.refs || [])){
    changed++; const d = lineDiff(refTxt(p.refs), refTxt(c.refs));
    h += `<div class="df-field"><b>Source location</b><div class="df">${d.map(x => `<div class="df-${x[0] === '+' ? 'add' : x[0] === '-' ? 'del' : 'ctx'}">${x[0] === ' ' ? '&nbsp;' : x[0]} ${esc(x[1]) || '&nbsp;'}</div>`).join('')}</div></div>`;
  }
  if (!changed) h += '<div class="muted">No field changes.</div>';
  return h;
}
/** the Checker's verdict on the card being reviewed (same checks and settings as everywhere else) */
function renderCurChecks(c){
  const box = $('#curChecks'); if (!box) return;
  const res = c ? checksOf(c).concat(cardMissing(c) ? [{key: 'missing_img', level: 'W', msg: 'An image is missing or not loaded.'}] : []) : [];
  box.hidden = !res.length; if (!res.length) return;
  const e = res.filter(x => x.level === 'E').length, w = res.length - e;
  box.querySelector('summary').innerHTML = `Checker: ${e ? `<b class="E" style="color:var(--bad)">${e} error${e > 1 ? 's' : ''}</b>` : ''}${e && w ? ', ' : ''}${w ? `<b style="color:var(--warn)">${w} warning${w > 1 ? 's' : ''}</b>` : ''}`;
  box.querySelector('ul').innerHTML = res.map(x => `<li class="${x.level}"><span style="color:var(--text)">${esc(x.msg)}</span> <span class="muted">(${esc((CHECK_DEFS.find(d => d.key === x.key) || {label: 'Studio'}).label)})</span></li>`).join('');
}
function badgesHTML(c){
  renderCurChecks(c);
  return `<span class="pill ${{ok:'ok',change:'warn',drop:'bad'}[c.status] || ''}">${{new:'unreviewed',ok:'approved',change:'change requested',drop:'excluded'}[c.status]}</span> `
    + (c.recheck ? '<span class="pill warn" title="Approved before, then changed by a formatting pass or checker fix: check the changes (see below the card), then approve or exclude it">re-check</span> ' : '')
    + (c.edited ? '<span class="pill edited" title="You edited this card\'s fields directly">field-edited</span>' : '');
}
function renderReviewSoft(){ const c = curCard(); renderList(); updateTabCounts(); $('#stOk').classList.toggle('on', c.status === 'ok'); $('#stChange').classList.toggle('on', c.status === 'change'); $('#stDrop').classList.toggle('on', c.status === 'drop');
  $('#curBadges').innerHTML = badgesHTML(c); }
function setStatus(st){
  const c = curCard(); if (!c) return;
  setCardStatus(c, (c.status === st && st !== 'ok' && !c.recheck) ? 'new' : st);
  save();
  if (st === 'change' && c.status === 'change'){ renderReviewSoft(); $('#edFeedback').focus(); return; }
  if (st === 'ok' || st === 'drop') { renderReviewSoft(); setTimeout(nextUnreviewed, 120); return; }
  renderReview();
}
$('#stOk').onclick = () => setStatus('ok'); $('#stChange').onclick = () => setStatus('change'); $('#stDrop').onclick = () => setStatus('drop');
$('#stReset').onclick = () => { const c = curCard(); setCardStatus(c, 'new'); save(); renderReview(); };
$('#btnPrev').onclick = () => move(-1); $('#btnNext').onclick = () => move(1);
$('#btnAddCard').onclick = () => {
  const c = curCard(); const id = nextId();
  const card = {id, type: 'basic', front: '', back: '', text: '', extra: '', source: '', tags: [...(c ? c.tags : [])], status: 'new', feedback: '', revised: false};
  if (c){ S.cards.splice(S.cards.indexOf(c) + 1, 0, card); } else S.cards.push(card);
  S.filter = 'all'; $('#filter').value = 'all'; select(id);
  setTimeout(() => $('#fieldsPanel textarea')?.focus(), 50);
};
$('#btnApproveAll').onclick = () => {
  const list = filtered().filter(c => c.status === 'new');
  if (!list.length) return toast('No unreviewed cards in this view');
  if (!confirm(`Approve ${list.length} unreviewed card(s) in the current view?`)) return;
  list.forEach(c => setCardStatus(c, 'ok')); save(); renderReview();
};
$('#sideSeg').onclick = e => { const b = e.target.closest('button'); if (b){ side = b.dataset.side; renderPreview(); } };

try { const sv = localStorage.getItem('acs-src-prev'); if (sv !== null) $('#srcPrev').checked = sv === '1'; } catch {}
$('#srcPrev').onchange = () => { try { localStorage.setItem('acs-src-prev', $('#srcPrev').checked ? '1' : '0'); } catch {} renderPreview(); };
try { const nv = localStorage.getItem('acs-night-prev'); if (nv !== null) $('#nightPrev').checked = nv === '1'; } catch {}
$('#nightPrev').onchange = () => { try { localStorage.setItem('acs-night-prev', $('#nightPrev').checked ? '1' : '0'); } catch {} renderPreview(); };

/* ---------------------------------------------------------------------- maths ($…$ → \( \), braces, cloze inside maths) */
const CODE_SPLIT_RE = /(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/i;
const MATH_SPAN_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
/** LaTeX's closing braces must not form "}}" (Anki would end a cloze there); the "}}" that closes a {{c1::…}} stays */
function spaceBraces(body){
  let out = '', i = 0, prev = false; const stack = [];
  while (i < body.length){
    const m = /^\{\{c\d+::/.exec(body.slice(i, i + 12));
    if (m){ out += m[0]; stack.push('cz'); i += m[0].length; prev = false; continue; }
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length){ out += body.slice(i, i + 2); i += 2; prev = false; continue; }
    if (ch === '{'){ stack.push('{'); out += ch; prev = false; }
    else if (ch === '}'){
      if (stack[stack.length - 1] === 'cz' && body[i + 1] === '}'){ stack.pop(); out += (prev ? ' ' : '') + '}}'; i += 2; prev = false; continue; }
      if (stack[stack.length - 1] === '{') stack.pop();
      out += (prev ? ' ' : '') + ch; prev = true;
    } else { out += ch; prev = false; }
    i++;
  }
  return out;
}
/** same rules as the helper's fix_math(): $$…$$ → \[…\], $…$ → \(…\) (money like "$5" left alone), braces spaced,
 *  raw < > inside maths escaped, src='x' → src="x". Idempotent. */
function fixMath(html){
  if (!html) return html || '';
  html = String(html).replace(/(<img\b[^>]*?\bsrc=)'([^']*)'/gi, '$1"$2"');
  if (!/[$}<]/.test(html)) return html;
  return html.split(CODE_SPLIT_RE).map((part, i) => {
    if (i % 2) return part;
    part = part.replace(/(?<![\\$])\$\$([\s\S]+?)\$\$(?!\$)/g, (_, b) => '\\[' + b.trim() + '\\]');
    part = part.replace(/(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\w$])/g, (all, b) => (/^\d/.test(b) && !/[\\^_{}=]/.test(b)) ? all : '\\(' + b + '\\)');
    return part.replace(MATH_SPAN_RE, t => {
      const body = spaceBraces(t.slice(2, -2)).split(/(<\/?(?:span|br|b|i|u|sub|sup)\b[^<>]*>)/)
        .map((q, k) => k % 2 ? q : q.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('');
      return t.slice(0, 2) + body + t.slice(-2);
    });
  }).join('');
}

/* ---------------------------------------------------------------------- HTML pretty-printing for the field editors */
const FMT_BLOCK = new Set('address article aside blockquote details dialog div dl dd dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p section summary table thead tbody tfoot tr td th caption colgroup ul'.split(' '));
const FMT_VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const FMT_RAW = new Set(['pre', 'code', 'textarea', 'script', 'style', 'svg', 'math']);
/** Indent card HTML: block elements on their own lines, nested 2 spaces; short blocks with only inline content stay on
 *  one line; <pre>/<code>/<svg>… are copied untouched. Rendering is unchanged (card CSS never preserves whitespace outside
 *  <pre>). Unbalanced HTML is returned as it is, so nothing can be lost. Idempotent. */
function formatHTML(html, width = 96){
  const src = String(html || '');
  if (!/<\/?[a-zA-Z]/.test(src)) return src;
  const tokRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)\b[^>]*>/g;
  const root = {tag: '#root', kids: []}, stack = [root];
  let last = 0, m;
  const text = t => { if (t) stack[stack.length - 1].kids.push({text: t}); };
  while ((m = tokRe.exec(src))){
    text(src.slice(last, m.index)); last = tokRe.lastIndex;
    const tok = m[0], tag = (m[1] || '').toLowerCase(), top = stack[stack.length - 1];
    if (tok.startsWith('<!--')){ top.kids.push({raw: tok}); continue; }
    if (tok[1] === '/'){
      if (top.tag !== tag) return src;                        // unbalanced: leave it alone
      top.close = tok; stack.pop(); continue;
    }
    if (FMT_VOID.has(tag) || tok.endsWith('/>')){ top.kids.push({tag, open: tok, kids: [], close: '', void: true}); continue; }
    if (FMT_RAW.has(tag)){                                    // copy verbatim up to the matching close
      const end = new RegExp(`</${tag}\\s*>`, 'ig'); end.lastIndex = last;
      const e = end.exec(src); if (!e) return src;
      top.kids.push({tag, raw: src.slice(m.index, end.lastIndex), inlineRaw: tag !== 'pre'}); tokRe.lastIndex = last = end.lastIndex; continue;
    }
    const el = {tag, open: tok, kids: [], close: ''}; top.kids.push(el); stack.push(el);
  }
  text(src.slice(last));
  if (stack.length !== 1) return src;
  const isBlock = n => !!n.tag && (n.raw ? n.tag === 'pre' : (FMT_BLOCK.has(n.tag) || n.kids.some(isBlock)));
  const flat = n => n.text != null ? n.text.replace(/\s+/g, ' ') : n.raw != null ? n.raw : n.open + n.kids.map(flat).join('') + (n.close || '');
  const out = [];
  const emit = (n, d) => {
    const pad = '  '.repeat(d);
    if (n.raw != null){ out.push(pad + n.raw); return; }
    const one = flat(n).trim();
    if (n.void || (!n.kids.some(isBlock) && pad.length + one.length <= width)){ out.push(pad + one); return; }
    out.push(pad + n.open); kids(n.kids, d + 1); out.push(pad + n.close);
  };
  const kids = (list, d) => {
    let run = [];
    const flush = () => {
      const t = run.map(flat).join('').trim(); run = [];
      if (!t) return;
      // break long inline runs after <br>
      t.split(/(?<=<br\s*\/?>)\s*/i).forEach(part => part.trim() && out.push('  '.repeat(d) + part.trim()));
    };
    for (const n of list){ if (isBlock(n)){ flush(); emit(n, d); } else run.push(n); }
    flush();
  };
  kids(root.kids, 0);
  return out.join('\n');
}

/* ---------------------------------------------------------------------- preview */
function clozeNums(text){ return [...new Set([...String(text).matchAll(/\{\{c(\d+)::/g)].map(m => +m[1]))].sort((a, b) => a - b); }
function renderCloze(text, n, back){
  const CZ = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  // a deletion inside \( \): Anki shows it inside the formula, in colour
  text = String(text).replace(MATH_SPAN_RE, t => t.replace(CZ, (_, num, ans, hint) => {
    if (n !== 0 && +num !== n) return ans;
    return '{\\color{#3b82f6}' + (back ? ans : '\\text{[' + (hint || '...').replace(/[{}\\]/g, '') + ']}') + '}';
  }));
  return String(text).replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_, num, ans, hint) => {
    if (n !== 0 && +num !== n) return ans;   // n = 0: show every deletion at once
    return back ? `<span class="cloze">${ans}</span>` : `<span class="cloze">[${hint || '...'}]</span>`;
  });
}
/** is the card's "why" put on the card (end of Extra)? per-card choice, else the Export-tab default */
const whyOn = c => !!(c.why && c.why.trim()) && (c.whyOnCard === true || (c.whyOnCard !== false && !!S.whyAll));
const whyHTML = w => /<[a-z][\s\S]*>/i.test(w) ? w : String(w).split(/\n{2,}/).map(p => `<p>${esc(p.trim())}</p>`).join('');
const extraWithWhy = c => (c.extra || '') + (whyOn(c) ? `<details class="aa-purpose"><summary>Why this card</summary>${whyHTML(c.why.trim())}</details>` : '');
function cardHTML(c, sd, n){
  c = {...c, front: fixMath(c.front), back: fixMath(c.back), text: fixMath(c.text), extra: fixMath(extraWithWhy(c))};
  const extra = c.extra && c.extra.trim() ? `<div class="extra">${c.extra}</div>` : '';
  const source = c.source && c.source.trim() ? `<div class="source">Source: ${c.source}</div>` : '';
  if (c.type === 'cloze'){
    const t = `<div class="cloze-text">${renderCloze(c.text, n, sd === 'back')}</div>`;
    return `<div class="aa-wrap">${t}${sd === 'back' ? extra + source : ''}</div>`;
  }
  const fr = `<div class="front">${c.front}</div>`;
  return `<div class="aa-wrap">${fr}${sd === 'back' ? `<hr id="answer"><div class="back">${c.back}</div>${extra}${source}` : ''}</div>`;
}
const MISSING_SVG = (label, kind) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="150"><rect width="100%" height="100%" rx="10" fill="${kind === 'snip' ? '#fff4e0' : '#f2f2f2'}" stroke="${kind === 'snip' ? '#d58b00' : '#aaa'}" stroke-dasharray="6 5" stroke-width="2"/><text x="50%" y="45%" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#555">${kind === 'snip' ? '✂ Snip needed' : kind === 'loading' ? 'Downloading…' : kind === 'failed' ? '⚠ Download failed' : '⚠ Image missing'}</text><text x="50%" y="65%" text-anchor="middle" font-family="monospace" font-size="13" fill="#777">${esc(label).slice(0, 60)}</text></svg>`);
let shadow;
function renderWhy(c){
  const box = $('#whyBox'); if (!box || !c) return;
  box.hidden = false;
  const has = !!(c.why && c.why.trim()), editing = !$('#whyEditWrap').hidden;
  if (editing && box.dataset.card !== c.id) whyEditing(false);
  box.dataset.card = c.id;
  const v = $('#whyView');
  if (has){ sanitizeInto(v, fixMath(whyHTML(c.why.trim()))); renderMath(v); }
  else v.innerHTML = '<div class="small muted">No explanation for this card yet. ✎ Edit to add one.</div>';
  $('#whyOnCard').checked = whyOn(c); $('#whyOnCard').disabled = !has;
}
function whyEditing(on){
  const c = curCard(), ta = $('#whyEdit');
  $('#whyEditWrap').hidden = !on; $('#whyView').hidden = on;
  $('#whyEditBtn').textContent = on ? '✓ Done' : '✎ Edit';
  if (on && c){ ta.value = formatHTML(whyHTML((c.why || '').trim())); autosize(ta); syncHl(ta); ta.focus(); }
}
$('#whyEditBtn').onclick = () => { const on = $('#whyEditWrap').hidden; whyEditing(on); if (!on) renderWhy(curCard()); };
$('#whyOnCard').onchange = e => { const c = curCard(); if (!c) return; c.whyOnCard = e.target.checked; save(); renderPreview(); };
$('#whyEdit').addEventListener('input', e => { const c = curCard(); if (!c) return; c.why = e.target.value; autosize(e.target); syncHl(e.target); save(); if (whyOn(c)) renderPreviewSoon(); });
$('#whyEdit').addEventListener('keydown', e => { if (e.key === 'Escape'){ e.preventDefault(); whyEditing(false); renderWhy(curCard()); } });
$('#exWhy').onchange = e => { S.whyAll = e.target.checked; save(); };
/* sideways scrollers in the preview (code, wide tables, equations) fade out on the side that has more,
   since phones hide scrollbars; re-checked when the card's size changes (images, maths, rotating the phone) */
const HS_CSS = `.hs-r{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 34px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 34px),transparent)}
.hs-l{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 34px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - 34px),transparent)}
.hs-l.hs-r{-webkit-mask-image:linear-gradient(to right,transparent,#000 34px,#000 calc(100% - 34px),transparent);mask-image:linear-gradient(to right,transparent,#000 34px,#000 calc(100% - 34px),transparent)}`;
let scrollRO = null;
function watchScrollers(pc){
  const mark = el => { const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('hs-l', max > 1 && el.scrollLeft > 1); el.classList.toggle('hs-r', max > 1 && el.scrollLeft < max - 1); };
  const scan = () => pc.querySelectorAll('pre,table,math,.katex-display').forEach(el => {
    mark(el); if (!el.dataset.hs){ el.dataset.hs = 1; el.addEventListener('scroll', () => mark(el), {passive: true}); } });
  if (scrollRO) scrollRO.disconnect();
  if (window.ResizeObserver){ scrollRO = new ResizeObserver(() => requestAnimationFrame(scan)); scrollRO.observe(pc); }
  requestAnimationFrame(scan);
}
function renderPreview(){
  const c = curCard(); if (!c) return;
  renderCurChecks(c);   // edits change what the checker finds
  renderWhy(c);
  const host = $('#previewHost');
  if (!shadow) shadow = host.attachShadow({mode: 'open'});
  const nums = c.type === 'cloze' ? clozeNums(c.text) : [];
  $('#clozeNote').hidden = nums.length < 2;
  if (nums.length > 1) $('#clozeNote').textContent = `${nums.length} cloze cards (c${nums.join(', c')}) shown together`;
  $$('#sideSeg button').forEach(b => b.classList.toggle('on', b.dataset.side === side));
  const night = $('#nightPrev').checked; host.classList.toggle('night', night);
  const style = `<style>:host{display:flex;flex-direction:column}${CARD_CSS}${HLJS_CSS}.card{flex:1 0 auto}${HS_CSS}@keyframes yank{from{background:rgba(255,196,0,.45)}to{background:rgba(255,196,0,0)}}.yank{position:absolute;inset:-6px -8px;border-radius:8px;pointer-events:none;animation:yank .3s ease-out forwards;mix-blend-mode:multiply}.nightMode .yank{mix-blend-mode:screen}</style>`;
  shadow.innerHTML = style + `<div class="card ${night ? 'nightMode' : ''}" id="pc"></div>`;
  const pc = shadow.getElementById('pc');
  sanitizeInto(pc, cardHTML(c, side, 0));
  highlightCode(pc);
  renderMath(pc);
  attachSourceVisual(c, pc);
  watchScrollers(pc);
  pc.querySelectorAll('img').forEach(im => {
    const name = im.getAttribute('src'); const st = mediaState(name);
    if (st === 'ok') im.src = mediaURL(name);
    else if (st !== 'inline') { im.src = MISSING_SVG(name, st); im.style.cursor = 'pointer'; im.title = 'Click to provide this image'; im.onclick = () => openImageDialog({replace: name}); }
  });
}

/* ---------------------------------------------------------------------- images panel */
function renderImages(c){
  const names = cardImages(c);
  $('#imgList').innerHTML = names.map(n => {
    const st = mediaState(n), m = S.media[n] || {};
    const thumb = st === 'ok' ? `<img src="${mediaURL(n)}" alt="">` : st === 'inline' ? `<img src="${esc(n)}" alt="">` : `<div class="ph">${st === 'snip' ? '✂' : st === 'loading' ? '⏳' : '⚠'}</div>`;
    const label = {ok: `<span class="pill ok">${esc(m.origin || 'ok')}</span>`, inline: '<span class="pill">inline</span>', snip: '<span class="pill warn">snip needed</span>', loading: '<span class="pill">downloading</span>', failed: '<span class="pill bad">download failed</span>', missing: '<span class="pill bad">missing</span>'}[st];
    const detail = st === 'snip' ? `<div style="color:var(--warn)">${esc(m.hint || '')}</div>` : st === 'failed' ? `<div style="color:var(--bad)">${esc(m.error)} - <a href="${esc(m.url)}" target="_blank" rel="noopener">open link</a></div>` : st === 'missing' ? `<div class="muted">Not in the bundle - drop the file on Import, or provide it here.</div>` : (m.credit ? `<div class="muted">${esc(m.credit)}</div>` : '');
    const act = st === 'snip' ? 'Snip ✂' : (st === 'ok' ? 'Crop / replace' : 'Provide…'), v = imgVerdict(n);
    const verdict = v === 'ok' ? ' <span class="pill ok" title="Approved in the image review">✓ image ok</span>' : v === 'broken' ? ` <span class="pill bad" title="Marked broken in the image review - fix it on Revise">✕ broken</span>${m.rvNote ? `<div style="color:var(--bad)">${esc(m.rvNote)}</div>` : ''}` : '';
    return `<div class="imgrow" data-name="${esc(n)}">${thumb}<div class="meta"><code>${esc(n)}</code> ${label}${verdict}${detail}</div>
      <div class="stack" style="gap:4px">${st !== 'inline' ? `<button class="btn sm ${st === 'snip' ? 'primary' : ''}" data-act="replace">${act}</button>` : ''}<button class="btn sm" data-act="remove" title="Remove from this card">Remove</button></div></div>`;
  }).join('') || '<div class="muted small">No images yet.</div>';
}
$('#imgList').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const name = b.closest('.imgrow').dataset.name, c = curCard();
  if (b.dataset.act === 'replace') openImageDialog({replace: name});
  if (b.dataset.act === 'remove'){
    const reFig = new RegExp(`<figure[^>]*>\\s*<img[^>]*src=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>[\\s\\S]*?</figure>`, 'gi');
    const reImg = new RegExp(`<img[^>]*src=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'gi');
    for (const f of FIELDS[c.type]) c[f] = c[f].replace(reFig, '').replace(reImg, '');
    delete $('#fieldsPanel').dataset.card; save(); renderReview();
  }
});
$('#btnAddImg').onclick = () => openImageDialog({target: {f: curCard().type === 'cloze' ? 'extra' : 'back'}});

/* ---------------------------------------------------------------------- keyboard */
