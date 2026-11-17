import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';

const source = readFileSync('studio/src/13-revise.js', 'utf8');
function fixture(){
  const elements: Record<string, any> = {'#fixScope': {value: 'all'}, '#fixStatus': {value: 'any'}, '#fxRules': {}, '#fxPresets': {}};
  const ctx = createContext({S: {cards: [], order: 'source'},
    $: (s: string) => elements[s], inScope: (c: any) => c.scoped !== false,
    ordered: (cards: any[]) => cards, checksOf: (c: any) => c.issues || [],
    rulesOn: (keys: string[]) => keys.filter(k => k !== 'off'),
    FIX_RULES: ['a', 'b', 'off'], CHECK_DEFS: ['a', 'b', 'off'].map(key => ({key, group: 'Rules', label: key})),
    FMT_LABEL: {a: 'Rule A', b: 'Rule B', off: 'Off rule'},
    fixPresets: () => [], sameRules: () => false, ruleSetting: () => 'on', esc: String,
  });
  runInContext(source.slice(source.indexOf('const issuesFor'), source.indexOf('const fmtNum')), ctx);
  runInContext(source.slice(source.indexOf('function fixRuleCount'), source.indexOf('function renderFmtPass')), ctx);
  return {ctx, elements, run: (s: string) => runInContext(s, ctx)};
}
test('counts failing cards once and respects scope, status, queue and severity filters', () => {
  const h = fixture();
  h.ctx.S.cards = [
    {status: 'ok', issues: [{key: 'a', level: 'W'}, {key: 'a', level: 'W'}]},
    {status: 'new', issues: [{key: 'a', level: 'E'}]},
    {status: 'ok', issues: []},
    {status: 'drop', issues: [{key: 'a', level: 'E'}]},
    {status: 'ok', scoped: false, issues: [{key: 'a', level: 'E'}]},
    {status: 'ok', fmt: 'Q1', issues: [{key: 'a', level: 'E'}]},
  ];
  assert.equal(h.run("fixRuleCount('a')"), 2);
  h.elements['#fixScope'].value = 'err';
  assert.equal(h.run("fixRuleCount('a')"), 1);
  h.elements['#fixStatus'].value = 'ok';
  assert.equal(h.run("fixRuleCount('a')"), 0);
  h.elements['#fixScope'].value = 'flagok';
  assert.equal(h.run("fixRuleCount('a')"), 1);
});
test('picker displays exact counts and disables zero-match rules including checker-off rules', () => {
  const h = fixture();
  h.ctx.S.cards = [{status: 'ok', issues: [{key: 'a', level: 'E'}, {key: 'off', level: 'E'}]}];
  h.run("renderRulePicker(['b'], {})");
  const html = h.elements['#fxRules'].innerHTML;
  assert.match(html, /data-rule="a"\s*>.*?1 card</);
  assert.match(html, /data-rule="b" checked disabled>.*?0 cards</);
  assert.match(html, /data-rule="off"\s+disabled>.*?0 cards</);
});
