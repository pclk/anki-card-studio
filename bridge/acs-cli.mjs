#!/usr/bin/env node
/**
 * acs.mjs - an Anki Card Studio project, for an AI agent. The Studio packs the project into acs_project.json (every
 * card with its fields, status, sub-deck, hidden notes, sources, the Checker's results and facts about its make-up; and,
 * when asked, the user's other projects, read-only), acs_sources.json (the text of the source files) and acs_media.json
 * (the card images, when asked), next to this script. This reads them: list, filter, search and show cards, decks,
 * projects, sources and images; export cards to revise with the anki skill; and record actions (status, tags, sub-deck,
 * feedback, global revisions, Checker settings, .apkg exports, new projects, deleting projects) in anki_actions.json,
 * which the Studio shows the user to apply.
 *
 *   node acs.mjs help                    every command and the query language
 *   node acs.mjs cards 'has:code -lang:java status:ok'
 *
 * Needs only Node 18+. Reads nothing outside its folder and writes only to the output folder (as the skill's helper:
 * $ANKI_OUT_DIR, a chat sandbox's /mnt/user-data/outputs, else ./anki_out) and to -o files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// where results go: the same rule as the skill's helper (ANKI_OUT_DIR, a chat sandbox's outputs folder, else ./anki_out)
const OUT = process.env.ANKI_OUT_DIR || (() => { try { fs.accessSync('/mnt/user-data/outputs', fs.constants.W_OK); return '/mnt/user-data/outputs'; } catch { return path.join(process.cwd(), 'anki_out'); } })();
const ACTIONS = () => path.join(OUT, 'anki_actions.json');
export const STATUSES = { new: 'new', unreviewed: 'new', ok: 'ok', approved: 'ok', change: 'change', drop: 'drop', excluded: 'drop' };
const FIELDS = { basic: ['front', 'back', 'extra', 'source'], cloze: ['text', 'extra', 'source'] };
const TEXT_KEYS = { q: 'q', question: 'q', front: 'q', a: 'a', answer: 'a', back: 'a', notes: 'why', why: 'why', source: 'source', any: 'any', text: 'any', html: 'html' };

/* ------------------------------------------------------------------ the project */
export function load(dir = HERE) {
  const read = (n) => { const p = path.join(dir, n); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
  const project = read('acs_project.json');
  if (!project) throw new Error(`no acs_project.json next to acs.mjs (${dir}) - the Studio sends it with Assistant jobs`);
  const src = read('acs_sources.json'), media = read('acs_media.json');
  project.sourceText = (src && src.sources) || [];
  project.imageData = (media && media.images) || null;
  // the user's other projects: read-only, and only searched when asked (--all-projects, or a project: term)
  for (const c of project.cards) c.project = project.project;
  for (const o of project.others || []) for (const c of o.cards || []) project.cards.push(Object.assign(c, { project: o.name, projectId: o.id, foreign: true }));
  for (const c of project.cards) {
    c.plain = c.plain || {};
    c.plain.any = [c.plain.q, c.plain.a, c.plain.why, c.plain.source].filter(Boolean).join('\n');
    c.plain.html = FIELDS[c.type === 'cloze' ? 'cloze' : 'basic'].map((f) => c[f] || '').concat(c.why || '').join('\n');
  }
  return project;
}

/* ------------------------------------------------------------------ the query language */
/** tokens: ( ) or and not - ! "phrase" /regex/flags and terms (key:value, measure>=N, words) */
export function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { out.push({ t: ch }); i++; continue; }
    if ((ch === '-' || ch === '!') && i + 1 < s.length && !/\s/.test(s[i + 1])) { out.push({ t: 'not' }); i++; continue; }
    let j = i, word = '';
    // one term: runs to the next space or paren, but quotes and /regex/ may hold spaces
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '(' && s[j] !== ')') {
      if (s[j] === '"') { const k = s.indexOf('"', j + 1); if (k < 0) throw new Error('a " is not closed'); word += s.slice(j, k + 1); j = k + 1; continue; }
      if (s[j] === '/' && (j === i || /[:=<>]$/.test(word))) {
        let k = j + 1; while (k < s.length && s[k] !== '/') k += s[k] === '\\' ? 2 : 1;
        if (k >= s.length) throw new Error('a /regex/ is not closed');
        k++; while (k < s.length && /[a-z]/.test(s[k])) k++;
        word += s.slice(j, k); j = k; continue;
      }
      word += s[j++];
    }
    i = j;
    const low = word.toLowerCase();
    if (low === 'or' || word === '|' || word === '||') out.push({ t: 'or' });
    else if (low === 'and' || word === '&&') out.push({ t: 'and' });
    else if (low === 'not') out.push({ t: 'not' });
    else out.push({ t: 'term', v: word });
  }
  return out;
}
const unquote = (v) => v.length >= 2 && v[0] === '"' && v.endsWith('"') ? v.slice(1, -1) : v;
const asRegex = (v) => { const m = /^\/((?:\\.|[^/])*)\/([a-z]*)$/.exec(v); if (!m) return null; try { return new RegExp(m[1], m[2].includes('i') || /[A-Z]/.test(m[1]) ? m[2] : m[2] + 'i'); } catch (e) { throw new Error(`bad regex ${v}: ${e.message}`); } };
const glob = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const textMatch = (hay, v) => { const re = asRegex(v); return re ? re.test(hay || '') : String(hay || '').toLowerCase().includes(unquote(v).toLowerCase()); };
const CMP = /^([a-z_]+)(>=|<=|!=|>|<|=)(-?\d+(?:\.\d+)?)$/;

/** a term -> a test on a card (throws for one it doesn't know, saying what it can be) */
export function termTest(raw, project) {
  const cmp = CMP.exec(raw);
  if (cmp) {
    const [, k, op, n] = cmp, v = Number(n);
    const known = new Set(project.cards.flatMap((c) => Object.keys(c.measures || {})));
    if (!known.has(k) && k !== 'page') throw new Error(`unknown measure "${k}" - one of: ${[...known, 'page'].sort().join(', ')}`);
    const ok = (x) => op === '>=' ? x >= v : op === '<=' ? x <= v : op === '>' ? x > v : op === '<' ? x < v : op === '!=' ? x !== v : x === v;
    if (k === 'page') return (c) => (c.refs || []).some((r) => r && r.page && ok(Number(r.page)));
    return (c) => ok(Number((c.measures || {})[k] ?? 0));
  }
  const colon = raw.indexOf(':');
  if (colon <= 0 || raw[0] === '"' || raw[0] === '/') return (c) => textMatch(c.plain.any, raw);
  const key = raw.slice(0, colon).toLowerCase(), val = raw.slice(colon + 1), v = unquote(val), lv = v.toLowerCase();
  if (TEXT_KEYS[key]) return (c) => textMatch(c.plain[TEXT_KEYS[key]], val);
  switch (key) {
    case 'status': case 'is': {
      const st = STATUSES[lv];
      if (st) return (c) => c.status === st;
      if (key === 'is' && ['edited', 'revised', 'recheck', 'basic', 'cloze'].includes(lv)) return lv === 'basic' || lv === 'cloze' ? (c) => c.type === lv : (c) => !!c[lv];
      throw new Error(`${key}: is one of ${Object.keys(STATUSES).join(', ')}${key === 'is' ? ', edited, revised, recheck, basic, cloze' : ''}`);
    }
    case 'type': if (!['basic', 'cloze'].includes(lv)) throw new Error('type: is basic or cloze'); return (c) => c.type === lv;
    case 'deck': case 'subdeck': {
      if (v.includes('*') || v.includes('?')) { const re = glob(v); return (c) => re.test(c.deck); }
      // the full name (and the decks under it), or a part of the name that starts with the word(s): deck:L02 is "Root::L02 Heaps"
      const word = new RegExp('^' + lv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])');
      return (c) => { const d = String(c.deck || '').toLowerCase(); return d === lv || d.startsWith(lv + '::') || d.split('::').some((p) => word.test(p)); };
    }
    case 'tag': { const re = glob(v); return (c) => (c.tags || []).some((t) => re.test(t)); }
    case 'id': { const ids = v.split(','); return (c) => ids.some((p) => glob(p).test(c.id)); }
    case 'lang': return (c) => (c.langs || []).includes(lv.replace(/^language-/, ''));
    case 'box': return (c) => (c.boxes || []).includes(lv);
    case 'project': return (c) => textMatch(c.project, val);
    case 'img': case 'image': return (c) => (c.images || []).some((n) => textMatch(n, val));
    case 'ref': return (c) => (c.refs || []).some((r) => r && textMatch(r.file, val)) || textMatch(c.plain.source, val);
    case 'check': {
      if (lv === 'any') return (c) => (c.checks || []).length > 0;
      if (lv === 'error' || lv === 'warn') return (c) => (c.checks || []).some((x) => x.level === (lv === 'error' ? 'E' : 'W'));
      const keys = new Set((project.checkDefs || []).map((d) => d.key).concat('missing_img'));
      if (!keys.has(lv)) throw new Error(`check: is any, error, warn or a check: ${[...keys].join(', ')}`);
      return (c) => (c.checks || []).some((x) => x.key === lv);
    }
    case 'skipped': return lv === 'any' ? (c) => Object.keys(c.skipped_checks || {}).length > 0 : (c) => !!(c.skipped_checks || {})[lv];
    case 'has': {
      const facts = new Set(project.cards.flatMap((c) => Object.keys(c.facts || {})));
      if (!facts.has(lv)) throw new Error(`has: is one of ${[...facts].sort().join(', ')}`);
      return (c) => !!(c.facts || {})[lv];
    }
    default: throw new Error(`unknown key "${key}:" - see: node acs.mjs help`);
  }
}

/** a query -> a test on a card. Terms side by side must all match; "or" between them, "not" / - before one, ( ) to group */
export function compile(query, project) {
  const toks = tokenize(String(query || '')); let i = 0;
  if (!toks.length) return () => true;
  const peek = () => toks[i];
  const orExpr = () => { const parts = [andExpr()]; while (peek() && peek().t === 'or') { i++; parts.push(andExpr()); } return parts.length === 1 ? parts[0] : (c) => parts.some((p) => p(c)); };
  const andExpr = () => {
    const parts = [unary()];
    while (peek() && peek().t !== 'or' && peek().t !== ')') { if (peek().t === 'and') i++; parts.push(unary()); }
    return parts.length === 1 ? parts[0] : (c) => parts.every((p) => p(c));
  };
  const unary = () => {
    const tk = toks[i++];
    if (!tk) throw new Error('the query ends too early');
    if (tk.t === 'not') { const p = unary(); return (c) => !p(c); }
    if (tk.t === '(') { const p = orExpr(); if (!toks[i] || toks[i].t !== ')') throw new Error('a ( is not closed'); i++; return p; }
    if (tk.t === 'term') return termTest(tk.v, project);
    throw new Error(`unexpected "${tk.t}"`);
  };
  const fn = orExpr();
  if (i < toks.length) throw new Error(`unexpected "${toks[i].t === 'term' ? toks[i].v : toks[i].t}"`);
  return fn;
}
/** the cards that match; cards of the user's other projects only with all (or a project: term in the query) */
export const select = (project, query, all = false) => {
  const t = compile(query, project), every = all || /(?:^|[\s(!-])project:/i.test(String(query || ''));
  return project.cards.filter((c) => (every || !c.foreign) && t(c));
};
/** cards an action may change: only this project's (the others are read-only) */
const own = (cards, what) => {
  const mine = cards.filter((c) => !c.foreign);
  if (!mine.length) throw new Error(cards.length ? `${JSON.stringify(what)} only matches cards of other projects - they are read-only` : `no card matches ${JSON.stringify(what)}`);
  return mine;
};

/* ------------------------------------------------------------------ output */
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const COLS = {
  id: (c) => c.id, project: (c) => c.project, status: (c) => c.status + (c.recheck ? '*' : ''), type: (c) => c.type, deck: (c) => c.deck, tags: (c) => (c.tags || []).join(' '),
  q: (c) => cut(c.plain.q, 90), a: (c) => cut(c.plain.a, 90), notes: (c) => cut(c.plain.why, 90), source: (c) => cut(c.plain.source, 60),
  checks: (c) => (c.checks || []).map((x) => x.key).join(','), feedback: (c) => cut(c.feedback, 60),
};
function table(cards, fields) {
  const cols = fields.map((f) => { const g = COLS[f] || ((c) => { const m = (c.measures || {})[f]; return m === undefined ? (c.facts || {})[f] ?? '' : m; }); return g; });
  const rows = cards.map((c) => cols.map((g) => String(g(c) ?? '')));
  const w = fields.map((f, k) => Math.min(40, Math.max(f.length, ...rows.map((r) => r[k].length))));
  const line = (r) => r.map((x, k) => k === r.length - 1 ? x : x.padEnd(w[k])).join('  ');
  return [line(fields), ...rows.map(line)].join('\n');
}
function showCard(c, html) {
  const L = [`── ${c.id} · ${c.type} · ${c.status}${c.recheck ? ' (re-check)' : ''} · ${c.deck}${c.foreign ? ` · project "${c.project}" (read-only)` : ''}${(c.tags || []).length ? ' · tags: ' + c.tags.join(' ') : ''}`];
  const f = (name, v) => { if (v && String(v).trim()) L.push(`${name}:\n  ${String(v).trim().replace(/\n/g, '\n  ')}`); };
  if (html) { for (const k of FIELDS[c.type === 'cloze' ? 'cloze' : 'basic']) f(k, c[k]); f('hidden notes (why)', c.why); }
  else { f('question', c.plain.q); f('answer', c.plain.a); f('hidden notes', c.plain.why); f('source', c.plain.source); }
  for (const r of c.refs || []) L.push(`ref: ${r.file}${r.page ? ' p.' + r.page : ''}${r.box ? ' box ' + JSON.stringify(r.box) : ''}${r.quote ? ` "${r.quote}"` : ''}`);
  if (c.feedback) L.push(`my feedback: ${c.feedback}`);
  for (const x of c.checks || []) L.push(`check ${x.level === 'E' ? 'ERROR' : 'warn'} ${x.key}: ${x.msg}`);
  for (const [k, why] of Object.entries(c.skipped_checks || {})) L.push(`skipped ${k}: ${why}`);
  const facts = Object.entries(c.facts || {}).filter(([, v]) => v).map(([k]) => k);
  if (facts.length) L.push(`has: ${facts.join(' ')}`);
  L.push(`measures: ${Object.entries(c.measures || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ actions (applied by the user in the Studio) */
function readActions() { try { return JSON.parse(fs.readFileSync(ACTIONS(), 'utf8')).actions || []; } catch { return []; } }
function writeActions(list) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(ACTIONS(), JSON.stringify({ format: 'acs-actions/v1', actions: list }, null, 1)); }
export function addAction(a) { const list = readActions(); list.push(a); writeActions(list); return list.length; }
const describeAction = (a) => `${a.op} ${a.ids ? a.ids.length + ' card(s)' : a.id || a.key || ''} ${JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !['op', 'ids', 'id', 'why'].includes(k))))}${a.why ? ` - ${a.why}` : ''}`;

/* ------------------------------------------------------------------ commands */
function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] === '-o' ? '--o' : argv[i];   // -o FILE; any other single "-" is "not" in a query (-lang:java)
    if (/^--[a-z-]+$/.test(a)) { const k = a.slice(2); const nx = argv[i + 1]; if (nx !== undefined && !nx.startsWith('--')) { flags[k] = nx; i++; } else flags[k] = true; }
    else rest.push(a);
  }
  return { flags, rest };
}
const HELP = `acs.mjs - this Anki Card Studio project (read from acs_project.json / acs_sources.json)

LOOK
  info                          the project: decks, statuses, card types, Checker results, sources
  decks                         the sub-deck tree with card counts per status
  cards [QUERY]                 the cards that match. --fields id,status,deck,q (also a, notes, source, tags, checks,
                                feedback, type, or any measure / fact) --sort FIELD [--desc] --limit N --count --ids --json
  show ID... | show QUERY       everything about cards (--html: the raw HTML fields)
  search QUERY                  like cards, with the matching lines (--context N characters)
  checks                        how many cards each Checker rule flags (and the Checker settings)
  facts                         the has: facts and the measures you can query, with how many cards have each
  sources                       the source files; source NAME [--page N | --pages 3-7] [--grep REGEX]: their text
  projects                      this project and the other ones that came along (read-only; search them with
                                --all-projects, or a project:NAME term)
  images [QUERY]                the card images and the cards that use them; image NAME -o FILE writes one,
                                extract-images [QUERY] [--dir DIR] writes those of the cards (needs acs_media.json)
EDIT CARDS (with the anki skill)
  export QUERY -o FILE.json [--feedback TEXT]
                                the cards as a revision bundle: deck = Deck.load("FILE.json") with the skill's helper,
                                change them, deck.save(revision=True) -> anki_out/anki_revision.json (the Studio keeps
                                each card's status; approved cards it changes wait for a re-check)
ACTIONS (written to anki_out/anki_actions.json; the user sees them and applies them in the Studio)
  status QUERY ok|new|change|drop [--feedback TEXT] [--why TEXT]
  tag add|remove TAG QUERY [--why TEXT]
  move QUERY "Deck::Sub" [--why TEXT]          the full deck name, as in "decks"
  feedback ID "text"                           ask for a change on one card (status change, with this feedback)
  notes-on-card QUERY on|off                   put the hidden notes on the card (end of Extra) or not
  global-revision QUERY --instr TEXT [--rules why,ref_page] [--format] [--split] [--delete]
                                               queue a global revision in the Studio for those cards
  set-check KEY VALUE                          a Checker setting (error|warn|off, or a number; see checks)
  set-notes TEXT                               what every card's hidden notes should hold ("" = why it was made)
  export-apkg QUERY [--deck NAME]              the Studio builds an Anki package of those cards for the user
  new-project NAME QUERY [--move]              a new project with copies of those cards (--move: take them out here)
  delete-project NAME                          delete one of the other projects (the user confirms by typing its name)
  actions                                      the actions so far; drop-action N removes one

QUERY: terms side by side must all match; "or" between terms, "not" or - before one, ( ) to group. Quote with "…".
  words / "a phrase" / /regex/i   in any text (question, answer, hidden notes, source)
  q: a: notes: source: html:      in one part: q:recursion a:/O\\(n\\^2\\)/ html:aa-mnemonic
  status:ok|new|change|drop       (also approved, unreviewed, excluded); is:edited is:revised is:recheck is:cloze
  type:basic|cloze  deck:L03 (a deck, its sub-decks, or any part of the name; * and ? as wildcards)
  tag:oop  id:L03-*  lang:java  box:mnemonic  img:heart  ref:lecture3  page>=12  project:biology
  check:why check:any check:error check:warn  skipped:any skipped:code_line_chars
  has:FACT                        has:code_block has:image has:math has:table … (see "facts")
  MEASURE>N (>= < <= = !=)        q_words a_words notes_words front_chars images code_lines code_width cloze_n time …
Examples
  node acs.mjs cards 'has:code_block -lang:python status:ok'
  node acs.mjs cards '(check:why or notes_words<30) deck:L03' --fields id,notes_words,q
  node acs.mjs search '/\\bdeadlock/' --context 60
  node acs.mjs status 'deck:L02 check:error' change --feedback "fix what the Checker found" --why "errors in L02"`;

export function run(argv, project = null, print = console.log) {
  const [cmd = 'help', ...args] = argv, { flags, rest } = parseArgs(args), P = () => (project ||= load());
  const q = () => rest.join(' '), all = !!flags['all-projects'];
  const ids = (cards) => cards.map((c) => c.id);
  const need = (cards, what) => { if (!cards.length) throw new Error(`no card matches ${JSON.stringify(what)}`); return cards; };
  switch (cmd) {
    case 'help': case '--help': case '-h': return print(HELP);
    case 'info': {
      const p = P(), by = (f) => p.cards.reduce((m, c) => ((m[f(c)] = (m[f(c)] || 0) + 1), m), {});
      const ck = {}; for (const c of p.cards) for (const x of c.checks || []) ck[x.key] = (ck[x.key] || 0) + 1;
      return print([`Project: ${p.project}  (deck ${p.deck}${p.scope ? `, only the sub-deck ${p.scope}` : ''}; packed ${p.exported})`,
        `Cards: ${p.cards.length}  by status ${JSON.stringify(by((c) => c.status))}  by type ${JSON.stringify(by((c) => c.type))}`,
        `Sub-decks: ${Object.keys(by((c) => c.deck)).length}  (node acs.mjs decks)`,
        `Checker: ${Object.entries(ck).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing flagged'}`,
        `Sources: ${(p.sources || []).map((s) => s.name).join(', ') || 'none'}`,
        `Hidden notes hold: ${p.notesSpec || 'why each card was made (the default)'}`].join('\n'));
    }
    case 'decks': {
      const p = P(), m = new Map();
      for (const c of p.cards) { const parts = String(c.deck).split('::'); for (let k = 1; k <= parts.length; k++) { const d = parts.slice(0, k).join('::'); const e = m.get(d) || { n: 0, st: {} }; e.n++; e.st[c.status] = (e.st[c.status] || 0) + 1; m.set(d, e); } }
      return print([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, e]) => `${'  '.repeat(d.split('::').length - 1)}${d.split('::').pop()}  ${e.n}  (${Object.entries(e.st).map(([s, n]) => `${s} ${n}`).join(', ')})  = "${d}"`).join('\n'));
    }
    case 'cards': case 'search': {
      const p = P(); let cards = select(p, q(), all);
      if (flags.sort) { const k = String(flags.sort), g = COLS[k] && !['q', 'a', 'notes', 'source'].includes(k) ? COLS[k] : (c) => (c.measures || {})[k] ?? c.plain[k] ?? '';
        cards = [...cards].sort((a, b) => { const x = g(a), y = g(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * (flags.desc ? -1 : 1); }); }
      const total = cards.length; if (flags.limit) cards = cards.slice(0, Number(flags.limit) || 20);
      if (flags.count) return print(String(total));
      if (flags.ids) return print(ids(cards).join('\n'));
      if (flags.json) return print(JSON.stringify(cards.map(({ plain, ...c }) => c), null, 1));
      if (cmd === 'search') {
        const toks = tokenize(q()).filter((t) => t.t === 'term' && !CMP.test(t.v)).map((t) => t.v), n = Number(flags.context) || 50;
        const pats = toks.map((v) => { const val = v.includes(':') && TEXT_KEYS[v.slice(0, v.indexOf(':')).toLowerCase()] ? v.slice(v.indexOf(':') + 1) : v.includes(':') ? null : v; return val && (asRegex(val) || new RegExp(unquote(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')); }).filter(Boolean);
        print(cards.map((c) => { const hits = []; for (const re of pats) { const m = re.exec(c.plain.any); if (m) hits.push('…' + c.plain.any.slice(Math.max(0, m.index - n), m.index + m[0].length + n).replace(/\s+/g, ' ') + '…'); }
          return `${c.id} [${c.status}] ${c.deck}\n  ${hits.join('\n  ') || cut(c.plain.q, 120)}`; }).join('\n'));
        return print(`(${total} card${total === 1 ? '' : 's'}${cards.length < total ? `, ${cards.length} shown` : ''})`);
      }
      print(table(cards, String(flags.fields || 'id,status,deck,type,q').split(',').map((s) => s.trim()).filter(Boolean)));
      return print(`(${total} card${total === 1 ? '' : 's'}${cards.length < total ? `, ${cards.length} shown` : ''})`);
    }
    case 'show': {
      const p = P();
      const byIdOwn = new Map(p.cards.filter((c) => !c.foreign).map((c) => [c.id, c]));
      const cards = rest.length && rest.every((a) => byIdOwn.has(a)) ? rest.map((a) => byIdOwn.get(a)) : need(select(p, q(), all), q());
      return print(cards.slice(0, Number(flags.limit) || 50).map((c) => showCard(c, !!flags.html)).join('\n\n'));
    }
    case 'checks': {
      const p = P(), n = {}; for (const c of p.cards) for (const x of c.checks || []) n[x.key] = (n[x.key] || 0) + 1;
      return print((p.checkDefs || []).map((d) => `${d.key.padEnd(22)} ${String(n[d.key] || 0).padStart(4)}  ${d.label}  [${JSON.stringify((p.checkSettings || {})[d.key])}]`).join('\n') + `\n(query: check:KEY)`);
    }
    case 'facts': {
      const p = P(), f = {}, m = {};
      for (const c of p.cards) { for (const [k, v] of Object.entries(c.facts || {})) if (v) f[k] = (f[k] || 0) + 1; for (const k of Object.keys(c.measures || {})) m[k] = (m[k] || 0) + 1; }
      const facts = [...new Set(p.cards.flatMap((c) => Object.keys(c.facts || {})))].sort();
      return print(`has: facts (cards that have it)\n${facts.map((k) => `  has:${k}  ${f[k] || 0}`).join('\n')}\nmeasures (MEASURE>N)\n  ${Object.keys(m).sort().join(' ')}${p.factLabels ? '\n\nwhat they mean:\n' + Object.entries(p.factLabels).map(([k, l]) => `  ${k}: ${l}`).join('\n') : ''}`);
    }
    case 'sources': {
      const p = P();
      return print((p.sources || []).map((s) => { const t = p.sourceText.find((x) => x.id === s.id); return `${s.name}  (${s.kind}, ${t ? t.pages.length + ' page(s) of text' : 'no text'}${s.file ? `, file attached: ./${s.file}` : ''})`; }).join('\n') || 'No sources in this project.');
    }
    case 'source': {
      const p = P(), name = rest.join(' ').toLowerCase();
      const t = p.sourceText.find((s) => s.name.toLowerCase() === name) || p.sourceText.find((s) => s.name.toLowerCase().includes(name));
      if (!t) throw new Error(`no source matches "${rest.join(' ')}" - see: node acs.mjs sources`);
      let pages = t.pages;
      if (flags.page) pages = pages.filter((x) => String(x.page) === String(flags.page));
      if (flags.pages) { const [a, b] = String(flags.pages).split('-').map(Number); pages = pages.filter((x) => x.page >= a && x.page <= (b || a)); }
      if (flags.grep) { const re = asRegex(String(flags.grep)) || new RegExp(String(flags.grep), 'i');
        return print(pages.flatMap((x) => String(x.text).split('\n').filter((l) => re.test(l)).map((l) => `p.${x.page}: ${l.trim()}`)).join('\n') || 'no match'); }
      return print(pages.map((x) => `[${t.name} p.${x.page}]\n${x.text}`).join('\n\n'));
    }
    case 'export': {
      const p = P(), out = flags.o || flags.out; if (!out || out === true) throw new Error('export QUERY -o FILE.json');
      const cards = own(select(p, q(), all), q());
      const keep = ['id', 'type', 'front', 'back', 'text', 'extra', 'source', 'tags', 'deck', 'refs', 'why', 'skipped_checks'];
      const used = new Set(cards.flatMap((c) => c.images || []));
      const bundle = { format: p.bundleFormat, deck: p.deck, tags: p.tags || [], existing_ids: p.allIds || ids(p.cards),
        media: (p.mediaInfo || []).filter((m) => used.has(m.filename)).map((m) => ({ ...m, ...(p.imageData && p.imageData[m.filename] ? { data: p.imageData[m.filename].data } : {}) })),
        cards: cards.map((c) => ({ ...Object.fromEntries(keep.filter((k) => c[k] !== undefined && c[k] !== '').map((k) => [k, c[k]])), ...(flags.feedback ? { feedback: String(flags.feedback) } : c.feedback ? { feedback: c.feedback } : {}) })) };
      fs.writeFileSync(path.resolve(String(out)), JSON.stringify(bundle, null, 1));
      return print(`${cards.length} card(s) -> ${out}. With the skill: deck = Deck.load(${JSON.stringify(String(out))}); …; deck.save(revision=True)`);
    }
    case 'status': {
      const st = STATUSES[String(rest.pop() || '').toLowerCase()]; if (!st) throw new Error('status QUERY ok|new|change|drop');
      const cards = own(select(P(), rest.join(' '), all), rest.join(' '));
      const n = addAction({ op: 'status', ids: ids(cards), status: st, ...(flags.feedback ? { feedback: String(flags.feedback) } : {}), ...(flags.why ? { why: String(flags.why) } : {}) });
      return print(`action ${n}: ${cards.length} card(s) -> ${st}`);
    }
    case 'tag': {
      const [how, tag, ...qq] = rest; if (!['add', 'remove'].includes(how) || !tag) throw new Error('tag add|remove TAG QUERY');
      if (!/^\S+$/.test(tag)) throw new Error('a tag has no spaces');
      const cards = own(select(P(), qq.join(' '), all), qq.join(' '));
      const n = addAction({ op: 'tag', ids: ids(cards), [how]: [tag], ...(flags.why ? { why: String(flags.why) } : {}) });
      return print(`action ${n}: ${how} tag ${tag} on ${cards.length} card(s)`);
    }
    case 'move': {
      const deck = rest.pop(); const p = P(); if (!deck || !String(deck).startsWith(p.deck)) throw new Error(`move QUERY "${p.deck}::Sub" (a full deck name under ${p.deck})`);
      const cards = own(select(p, rest.join(' '), all), rest.join(' '));
      const n = addAction({ op: 'move', ids: ids(cards), deck, ...(flags.why ? { why: String(flags.why) } : {}) });
      return print(`action ${n}: ${cards.length} card(s) -> ${deck}`);
    }
    case 'feedback': {
      const [id, ...t] = rest, p = P(); if (!p.cards.some((c) => c.id === id && !c.foreign) || !t.length) throw new Error('feedback ID "what should change"');
      return print(`action ${addAction({ op: 'feedback', id, text: t.join(' ') })}: change requested on ${id}`);
    }
    case 'notes-on-card': {
      const on = rest.pop(); if (!['on', 'off'].includes(on)) throw new Error('notes-on-card QUERY on|off');
      const cards = own(select(P(), rest.join(' '), all), rest.join(' '));
      return print(`action ${addAction({ op: 'notes_on_card', ids: ids(cards), on: on === 'on' })}: hidden notes ${on} for ${cards.length} card(s)`);
    }
    case 'global-revision': {
      const p = P(); if (!flags.instr && !flags.rules) throw new Error('global-revision QUERY --instr TEXT [--rules a,b] [--format] [--split] [--delete]');
      const rules = flags.rules ? String(flags.rules).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const bad = rules.filter((r) => !(p.fixRules || []).includes(r)); if (bad.length) throw new Error(`not a rule: ${bad.join(', ')} - one of ${(p.fixRules || []).join(', ')}`);
      const cards = own(select(p, q(), all), q());
      const n = addAction({ op: 'global_revision', ids: ids(cards), instr: flags.instr === true ? '' : String(flags.instr || ''), rules, mode: flags.format ? 'format' : 'content', split: !!flags.split, del: !!flags.delete, ...(flags.why ? { why: String(flags.why) } : {}) });
      return print(`action ${n}: a global revision of ${cards.length} card(s) is queued when the user applies it`);
    }
    case 'projects': {
      const p = P();
      return print([`${p.project} (this one, ${p.cards.filter((c) => !c.foreign).length} cards)`, ...(p.others || []).map((o) => `${o.name} (${(o.cards || []).length} cards, deck ${o.deck}; read-only)`)].join('\n')
        + ((p.others || []).length ? '' : '\n(no other projects came along: the user can include them)'));
    }
    case 'images': {
      const p = P(), cards = select(p, q(), all), by = new Map();
      for (const c of cards) for (const n of c.images || []) by.set(n, [...(by.get(n) || []), c.id]);
      const meta = new Map((p.mediaInfo || []).map((m) => [m.filename, m]));
      return print([...by.entries()].map(([n, ids]) => { const m = meta.get(n) || {}; return `${n}  (${m.origin || '?'}${m.caption ? `, "${cut(m.caption, 50)}"` : ''}${p.imageData && p.imageData[n] ? '' : ', not included'})  used by ${ids.join(', ')}`; }).join('\n') || 'No images.');
    }
    case 'image': case 'extract-images': {
      const p = P(); if (!p.imageData) throw new Error('the images did not come along (acs_media.json) - ask the user to include them');
      const write = (n, file) => { const e = p.imageData[n]; if (!e) throw new Error(`no image ${n}`); fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, Buffer.from(e.data, 'base64')); return file; };
      if (cmd === 'image') { const out = flags.o; if (!rest[0] || !out || out === true) throw new Error('image NAME -o FILE'); return print(`wrote ${write(rest[0], String(out))}`); }
      const dir = String(flags.dir && flags.dir !== true ? flags.dir : 'media'), names = [...new Set(select(p, q(), all).flatMap((c) => c.images || []))].filter((n) => p.imageData[n]);
      for (const n of names) write(n, path.join(dir, n));
      return print(`${names.length} image(s) -> ${dir}/`);
    }
    case 'set-check': {
      const [key, value] = rest, p = P(), d = (p.checkDefs || []).find((x) => x.key === key);
      if (!d || value === undefined) throw new Error(`set-check KEY VALUE - KEY one of ${(p.checkDefs || []).map((x) => x.key).join(', ')}`);
      const cur = (p.checkSettings || {})[key], v = typeof cur === 'number' ? Number(value) : String(value).toLowerCase();
      if (typeof cur === 'number' ? !(Number.isInteger(v) && v >= 0) : !['error', 'warn', 'off'].includes(v)) throw new Error(`${key} is ${typeof cur === 'number' ? 'a whole number (0 = no limit)' : 'error, warn or off'}`);
      return print(`action ${addAction({ op: 'check_setting', key, value: v, ...(flags.why ? { why: String(flags.why) } : {}) })}: ${key} = ${v} (now ${JSON.stringify(cur)})`);
    }
    case 'set-notes': return print(`action ${addAction({ op: 'notes_spec', text: rest.join(' '), ...(flags.why ? { why: String(flags.why) } : {}) })}: the hidden notes setting`);
    case 'export-apkg': {
      const cards = own(select(P(), q(), all), q());
      return print(`action ${addAction({ op: 'export_apkg', ids: ids(cards), ...(flags.deck && flags.deck !== true ? { deck: String(flags.deck) } : {}), ...(flags.why ? { why: String(flags.why) } : {}) })}: an Anki package of ${cards.length} card(s)`);
    }
    case 'new-project': {
      const [name, ...qq] = rest; if (!name || !name.trim()) throw new Error('new-project NAME QUERY [--move]');
      const cards = own(select(P(), qq.join(' '), all), qq.join(' '));
      return print(`action ${addAction({ op: 'new_project', name: name.trim(), ids: ids(cards), move: !!flags.move, ...(flags.why ? { why: String(flags.why) } : {}) })}: a new project "${name.trim()}" with ${cards.length} card(s)${flags.move ? ' (moved)' : ''}`);
    }
    case 'delete-project': {
      const p = P(), name = rest.join(' '), o = (p.others || []).find((x) => x.name === name || x.id === name);
      if (!o) throw new Error(`delete-project NAME - one of the other projects: ${(p.others || []).map((x) => JSON.stringify(x.name)).join(', ') || '(none came along)'}`);
      return print(`action ${addAction({ op: 'delete_project', id: o.id, name: o.name, ...(flags.why ? { why: String(flags.why) } : {}) })}: delete the project "${o.name}" (the user confirms)`);
    }
    case 'actions': { const list = readActions(); return print(list.length ? list.map((a, k) => `${k + 1}. ${describeAction(a)}`).join('\n') : 'No actions yet.'); }
    case 'drop-action': { const list = readActions(), k = Number(rest[0]) - 1; if (!(k >= 0 && k < list.length)) throw new Error('drop-action N (see: actions)'); list.splice(k, 1); writeActions(list); return print(`dropped; ${list.length} left`); }
    default: throw new Error(`unknown command "${cmd}" - see: node acs.mjs help`);
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try { run(process.argv.slice(2)); }
  catch (e) { console.error('acs: ' + (e.message || e)); process.exit(1); }
}
