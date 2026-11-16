import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { db, ensureSchema, setDb, type Query } from '../lib/db';
import { getRev, writeChunk } from '../lib/store';
import { setObjectStore } from '../lib/object-storage';
const pg = new PGlite();
let results: unknown[][] = [];
let parameterBytes = 0;
before(async () => {
  setDb((async (sql, params = []) => {
    parameterBytes += Buffer.byteLength(JSON.stringify(params));
    const rows = (await pg.query(sql, params)).rows;
    results.push(rows);
    return rows;
  }) as Query, async work => pg.transaction(async tx => work((async (sql, params=[]) => { const rows=(await tx.query(sql,params)).rows; results.push(rows); return rows; }) as Query)));
  setObjectStore(null);
  await ensureSchema();
});
after(async () => { setDb(null); setObjectStore(undefined); await pg.close(); });

test('revision polls transfer only metadata for multi-MB legacy projects', async () => {
  const body = JSON.stringify({ rev: '17', savedAt: 12345, savedBy: 'old-tab', cards: [{ text: 'x'.repeat(4 * 1024 * 1024) }] });
  await db()('insert into acs_projects(owner,id,data,rev) values($1,$2,$3,99)', ['egress', 'large', body]);
  results = [];
  assert.deepEqual(await getRev('egress', 'large'), { rev: 17, savedAt: 12345, savedBy: 'old-tab' });
  assert.equal(results.length, 1);
  assert.deepEqual(Object.keys(results[0][0] as object), ['metadata']);
  const size = Buffer.byteLength(JSON.stringify(results));
  assert.ok(size < 200);
  console.log(`Revision result: ${Buffer.byteLength(body)} body bytes -> ${size} serialized result bytes`);
  assert.equal(await getRev('other-owner', 'large'), null);
  assert.equal(await getRev('egress', 'missing'), null);
  for (const data of ['{}', 'null', '[]', '{"rev":"invalid","savedAt":false,"savedBy":""}', '{"rev":3,"unused":1e1000000}']) {
    await db()('update acs_projects set data=$1 where owner=$2', [data, 'egress']);
    const j = JSON.parse(data);
    assert.deepEqual(await getRev('egress', 'large'), { rev: Number(j?.rev) || 0, savedAt: j?.savedAt ?? null, savedBy: j?.savedBy ?? null });
  }
});

test('legacy and object retries return booleans without downloading payloads', async () => {
  const bytes = Buffer.alloc(1024 * 1024, 42);
  for (const objects of [false, true]) {
    setObjectStore(objects ? { async put() {}, async get() { throw Error('retry downloaded object'); } } : null);
    const name = objects ? 'object' : 'legacy';
    await writeChunk('egress', 'p', 'media', name, 'image/png', 0, 2, bytes, 'retry');
    results = [];
    await writeChunk('egress', 'p', 'media', name, 'image/png', 0, 2, bytes, 'retry');
    assert.ok(Buffer.byteLength(JSON.stringify(results)) < 1000);
    assert.ok(results.some(rows => rows.some(row => (row as {same?: boolean}).same === true)));
    await assert.rejects(writeChunk('egress', 'p', 'media', name, 'image/png', 0, 2, Buffer.from('changed'), 'retry'), /upload piece changed/);
    await writeChunk('egress', 'p', 'media', name, 'image/png', 1, 2, bytes, 'retry');
    results = [];
    await writeChunk('egress', 'p', 'media', name, 'image/png', 0, 2, bytes, 'retry');
    assert.ok(Buffer.byteLength(JSON.stringify(results)) < 1000);
  }
});

test('new object pieces and retries send no payload to Postgres', async () => {
  const bytes = Buffer.alloc(1024 * 1024, 42);
  setObjectStore({ async put() {}, async get() { throw Error('unexpected download'); } });
  for (const idx of [0, 1, 1]) {
    parameterBytes = 0;
    await writeChunk('egress', 'p', 'media', 'parameter-bound', 'image/png', idx, 3, bytes, 'bounded');
    assert.ok(parameterBytes < 10_000, `piece ${idx} sent ${parameterBytes} SQL parameter bytes`);
  }
});

test('hidden tabs skip polls and visible focus/visibility resume checks', async () => {
  const source = readFileSync('studio/src/01-sync.js', 'utf8');
  const block = source.slice(source.indexOf('let checking = false;'), source.indexOf('if (syncChannel) syncChannel.onmessage'));
  let calls = 0;
  const events: Record<string, () => unknown> = {};
  const document = { hidden: true, addEventListener(name: string, callback: () => unknown) { events[name] = callback; } };
  const context = vm.createContext({ document, window: { addEventListener(name: string, callback: () => unknown) { events[name] = callback; } }, setInterval(callback: () => unknown) { events.interval = callback; }, curProject: 'p', sync: {rev: 1}, $: () => ({open: false}), Store: { async getRev() { calls++; return 1; }, async getIndex() { return null; } }, renderSyncInfo() {} });
  vm.runInContext(block, context);
  await events.interval(); assert.equal(calls, 0);
  document.hidden = false;
  await events.focus(); assert.equal(calls, 1);
  events.visibilitychange();
  await vm.runInContext('Promise.resolve()', context);
  assert.equal(calls, 2);
});
