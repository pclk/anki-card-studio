import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, transaction, type Query } from '../lib/db';
import { setObjectStore } from '../lib/object-storage';
import { writeChunk, readChunk } from '../lib/store';
import { migrateChunk } from '../lib/storage-migration';
// the production migration script moves one kind at a time with --kind: the filter must leave other kinds untouched
const pg = new PGlite(), objects = new Map<string, Buffer>();
setDb((async (s, p = []) => (await pg.query(s, p)).rows) as Query, async work => pg.transaction(async tx => work((async (s, p = []) => (await tx.query(s, p)).rows) as Query)));
after(async () => { setDb(null); setObjectStore(undefined); await pg.close(); });
test('migration by kind moves only that kind, verifies it, and keeps every file readable', async () => {
  setObjectStore(null);
  for (const [kind, name, body] of [['media', 'a.png', 'png-bytes'], ['pdf', 'notes.pdf', 'pdf-bytes'], ['media', 'b.png', 'more']] as const)
    await transaction('u', () => writeChunk('u', 'p', kind, name, 'application/octet-stream', 0, 1, Buffer.from(body), ''));
  setObjectStore({ async put(k, b) { objects.set(k, Buffer.from(b)); }, async get(k) { return objects.get(k)!; } });
  let n: number | null, moved = 0;
  while ((n = await migrateChunk('u', false, ['media'])) !== null) moved += n;
  assert.equal(moved, 'png-bytes'.length + 'more'.length);
  const rows = await db()<{ kind: string; moved: boolean }>('select kind, object_key is not null as moved from acs_chunks order by name');
  assert.deepEqual(rows.map(r => [r.kind, r.moved]), [['media', true], ['media', true], ['pdf', false]]);
  assert.equal(await migrateChunk('u', false, ['media']), null);
  assert.equal(await migrateChunk('u', false), 'pdf-bytes'.length);   // no filter: everything else
  for (const [kind, name, body] of [['media', 'a.png', 'png-bytes'], ['pdf', 'notes.pdf', 'pdf-bytes'], ['media', 'b.png', 'more']])
    assert.equal((await readChunk('u', 'p', kind, name, 0))?.toString(), body);
  assert.equal(objects.size, 3);
});
