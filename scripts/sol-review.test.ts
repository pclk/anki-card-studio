import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setDb, ensureSchema, SCHEMA_FINGERPRINT } from '../lib/db';
import { pgText } from '../lib/bridge';

test('review: concurrent cold starts share one schema probe', async () => {
  let calls = 0;
  setDb((async () => { calls++; await new Promise(r => setTimeout(r, 5)); return [{ v: SCHEMA_FINGERPRINT }]; }) as never);
  try { await Promise.all(Array.from({ length: 30 }, () => ensureSchema())); assert.equal(calls, 1); }
  finally { setDb(null); }
});

test('review: failed DDL does not publish a fingerprint and a subsequent call retries', async () => {
  let fail = true;
  const statements: string[] = [];
  setDb((async (sql: string) => {
    statements.push(sql);
    if (fail && sql.startsWith('create table')) throw new Error('temporary DDL failure');
    return [];
  }) as never);
  try {
    await assert.rejects(ensureSchema(), /temporary DDL failure/);
    assert.equal(statements.some(s => s.startsWith('comment on')), false);
    fail = false;
    await ensureSchema();
    assert.equal(statements.filter(s => s.includes('obj_description')).length, 2);
    assert.equal(statements.filter(s => s.startsWith('comment on')).length, 1);
  } finally { setDb(null); }
});

test('review: text sanitizer handles adjacent malformed surrogates and is idempotent', () => {
  const alphabet = ['a', '\0', '\ud800', '\udfff', '😀'];
  for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) {
    const result = pgText(a + b + c);
    assert.equal(result.includes('\0'), false);
    assert.equal(result, result.toWellFormed());
    assert.equal(pgText(result), result);
  }
});

function extract(file: string, start: string, end: string) {
  const source = readFileSync(file, 'utf8');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}

test('review: a newer log response arriving first never moves the cursor backwards', async () => {
  const responses: ((value: unknown) => void)[] = [];
  const logs = new Map();
  const ctx = vm.createContext({ BR: { open: new Set(['job']), logs }, brCall: () => new Promise(resolve => responses.push(resolve)) });
  vm.runInContext(extract('studio/src/19-bridge.js', 'async function refreshLogs(', 'async function openJobs('), ctx);
  const older = ctx.refreshLogs(), newer = ctx.refreshLogs();
  responses[1]([{ seq: 1 }, { seq: 2 }, { seq: 3 }]); await newer;
  responses[0]([{ seq: 1 }, { seq: 2 }]); await older;
  assert.equal(logs.get('job').after, 3);
  assert.equal(JSON.stringify(logs.get('job').items), '[{"seq":1},{"seq":2},{"seq":3}]');
});

test('review: synchronous IndexedDB open exceptions can be retried', async () => {
  let calls = 0;
  const connection = {};
  const ctx = vm.createContext({ indexedDB: { open() {
    if (++calls === 1) throw new Error('SecurityError');
    const request: any = { result: connection };
    queueMicrotask(() => request.onsuccess());
    return request;
  } }, console });
  vm.runInContext(extract('studio/src/00-core.js', 'const DB_NAME', 'function mergeIndexLists('), ctx);
  await assert.rejects(ctx.idb(), /SecurityError/);
  assert.equal(await ctx.idb(), connection);
  assert.equal(calls, 2);
});
