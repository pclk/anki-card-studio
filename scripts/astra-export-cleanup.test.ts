import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
test('export closes SQL database when schema creation fails', async () => {
  const source = readFileSync('studio/src/15-analytics.js', 'utf8');
  const fn = source.slice(source.indexOf('async function buildApkg('), source.indexOf("$('#btnExport').onclick"));
  let closed = 0;
  const context = vm.createContext({ window: { initSqlJs: true, JSZip: true }, CDN_SQL: '', initSqlJs: async () => ({ Database: class { run(){ throw new Error('schema failure'); } close(){ closed++; } } }) });
  vm.runInContext(fn, context);
  await assert.rejects(context.buildApkg('Deck', [], {}), /schema failure/);
  assert.equal(closed, 1);
});
