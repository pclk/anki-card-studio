import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
// the Studio's checker, run on its own: the checks section and the maths helpers of 07-review.js
const src = readFileSync('studio/src/07-review.js', 'utf8');
const slice = (from: string, to: string) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };
const code = slice('/* ---- formatting-pass checks', '/* checks are re-run') + slice('const CODE_SPLIT_RE', '/* ------') + ';({cardChecks, CHECK_DEFS, FMT_KEYS})';
const ctx = vm.createContext({DOMParser: new JSDOM('').window.DOMParser, FIELDS: {basic: ['front', 'back', 'extra', 'source'], cloze: ['text', 'extra', 'source']}});
const {cardChecks: run, CHECK_DEFS, FMT_KEYS} = vm.runInContext(code, ctx);
// results come from another realm: copy them so deepEqual compares plain values
const cardChecks = (c: any, C?: any) => JSON.parse(JSON.stringify(run(c, C)));
const MATH = ['unshown_math', 'math_as_text', 'math_in_code'];
// shared with scripts/math_checks_test.py, so the Studio and the skill's validate() agree
const cases: {name: string, card: any, want: string[]}[] = JSON.parse(readFileSync('scripts/fixtures/math-checks.json', 'utf8'));
const keys = (card: any, C?: any) => [...new Set(cardChecks({why: 'x', tags: [], ...card}, C).map((x: any) => x.key))]
  .filter(k => MATH.includes(k as string) || k === 'code_language').sort();
for (const c of cases) test(`studio math check: ${c.name}`, () => assert.deepEqual(keys(c.card), [...c.want].sort()));
test('maths checks are configurable and part of the formatting pass', () => {
 for (const k of MATH){ const d = CHECK_DEFS.find((x: any) => x.key === k); assert.equal(d.def, 'warn'); assert.ok(FMT_KEYS.has(k)); }
 const card = {type: 'basic', front: 'Using Eq. (3), what is x^2?', back: '<code>\\sum x</code>'};
 const all = (C: any) => cardChecks({why: 'x', tags: [], ...card}, C).filter((x: any) => MATH.includes(x.key));
 const base = Object.fromEntries(CHECK_DEFS.map((d: any) => [d.key, d.def]));
 assert.deepEqual(all(base).map((x: any) => x.level), ['W', 'W', 'W']);
 assert.deepEqual(all({...base, math_as_text: 'error'}).map((x: any) => [x.key, x.level]), [['unshown_math', 'W'], ['math_as_text', 'E'], ['math_in_code', 'W']]);
 assert.deepEqual(all({...base, unshown_math: 'off', math_as_text: 'off', math_in_code: 'off'}), []);
});
test('maths messages tell the AI what to write', () => {
 const m = cardChecks({type: 'basic', why: 'x', tags: [], front: 'Find x^2.', back: ''}).find((x: any) => x.key === 'math_as_text');
 assert.match(m.msg, /"x\^2"/); assert.match(m.msg, /\\\( … \\\)/);
});
