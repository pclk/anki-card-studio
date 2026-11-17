import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
// code blocks must fit a phone: the Studio's code_line_chars check (shared cases with scripts/code_width_test.py)
const src = readFileSync('studio/src/07-review.js', 'utf8');
const slice = (from: string, to: string) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };
const code = slice('/* ---- formatting-pass checks', '/* checks are re-run') + slice('const CODE_SPLIT_RE', '/* ------') + ';({cardChecks, codeLines, CHECK_DEFS, FMT_KEYS})';
const ctx = vm.createContext({DOMParser: new JSDOM('').window.DOMParser, FIELDS: {basic: ['front', 'back', 'extra', 'source'], cloze: ['text', 'extra', 'source']}});
const {cardChecks: run, codeLines, CHECK_DEFS, FMT_KEYS} = vm.runInContext(code, ctx);
const cardChecks = (c: any, C?: any) => JSON.parse(JSON.stringify(run(c, C)));
const cases: {name: string, card: any, longest: number, flag: boolean}[] = JSON.parse(readFileSync('scripts/fixtures/code-width.json', 'utf8'));
const width = (card: any) => cardChecks({why: 'x', tags: [], ...card}).filter((x: any) => x.key === 'code_line_chars');
for (const c of cases) test(`studio code width: ${c.name}`, () => {
 assert.equal(Math.max(0, ...codeLines({tags: [], ...c.card}).map((l: string) => l.length)), c.longest);
 assert.equal(width(c.card).length, c.flag ? 1 : 0);
});
test('the limit is 27 by default, a warning, configurable, and part of the formatting pass', () => {
 const d = CHECK_DEFS.find((x: any) => x.key === 'code_line_chars');
 assert.equal(d.def, 27); assert.equal(d.kind, 'num'); assert.ok(FMT_KEYS.has('code_line_chars'));
 const card = {type: 'basic', why: 'x', tags: [], front: 'Q', back: '<pre><code class="language-java">public ColoredCircle(Circle c,\n  String colour) {</code></pre>'};
 const base = Object.fromEntries(CHECK_DEFS.map((x: any) => [x.key, x.def]));
 const [hit] = cardChecks(card, base).filter((x: any) => x.key === 'code_line_chars');
 assert.equal(hit.level, 'W');
 assert.match(hit.msg, /^1 code line is longer than 27 characters \(the longest has 30: "public ColoredCircle\(Circle c,"\)/);
 assert.equal(cardChecks(card, {...base, code_line_chars: 30}).filter((x: any) => x.key === 'code_line_chars').length, 0);
 assert.equal(cardChecks(card, {...base, code_line_chars: 0}).filter((x: any) => x.key === 'code_line_chars').length, 0);
});
