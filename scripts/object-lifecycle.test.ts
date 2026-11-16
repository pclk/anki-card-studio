import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, type Query } from '../lib/db';
import { setObjectStore } from '../lib/object-storage';
import { writeChunk, deleteFile, readChunk, deleteProject } from '../lib/store';
import { wipeUser } from '../lib/users';
import { collectObjects } from '../lib/object-gc';
import { migrateChunk } from '../lib/storage-migration';
test('durable cleanup covers failures, retirement and retries without deleting references', async()=>{
 const originalMode = process.env.ACS_OBJECT_STORAGE;
 const pg = new PGlite(); const objects = new Map<string,Buffer>(); let failPut=false, failDelete=false;
 setDb((async(s,p=[]) => (await pg.query(s,p)).rows) as Query, async work=>pg.transaction(async tx=>work((async(s,p=[]) => (await tx.query(s,p)).rows) as Query)));
 setObjectStore({async put(k,b){objects.set(k,b);if(failPut) throw Error('ambiguous PUT');},async get(k){return objects.get(k)!;},async delete(k){if(failDelete)throw Error('offline');objects.delete(k);}});
 const write=(s:string,total=1,id='')=>writeChunk('a','p','media','f','text/plain',0,total,Buffer.from(s),id);
 const due=()=>db()("update acs_object_gc set eligible_at=now()-interval '1 day'");
 try {
  await write('old'); process.env.ACS_OBJECT_STORAGE='off';
  assert.equal((await readChunk('a','p','media','f',0))?.toString(),'old');
  delete process.env.ACS_OBJECT_STORAGE; await due(); assert.equal(await collectObjects(),0); assert.equal(objects.size,1);
  await write('new'); await due(); assert.equal(await collectObjects(),1);assert.equal(objects.size,1);
  failPut=true; await assert.rejects(write('failed'));failPut=false;
  assert.equal((await readChunk('a','p','media','f',0))?.toString(),'new');
  await due();await collectObjects();assert.equal(objects.size,1);
  await write('stage',2,'session'); await write('restart',2,'other');
  await due();await collectObjects();assert.equal(objects.size,2);
  await db()("update acs_upload_files set updated=now()-interval '8 days'");
  await collectObjects();await due();await collectObjects();assert.equal(objects.size,1);
  await deleteFile('a','p','media','f');failDelete=true;await due();await assert.rejects(collectObjects());failDelete=false;
  await collectObjects();assert.equal(objects.size,0);
  await write('project');await deleteProject('a','p');await due();await collectObjects();assert.equal(objects.size,0);
  await write('rollback');assert.equal(await migrateChunk('a',true),8);await due();await collectObjects();assert.equal(objects.size,0);
  await write('wipe');await wipeUser('a',true);await due();await collectObjects();assert.equal(objects.size,0);
  await db()("insert into acs_users(owner,login,quota_mb) values('a','a',0)");
  await assert.rejects(write('rejected'));assert.equal(objects.size,0);
 } finally {
  if (originalMode === undefined) delete process.env.ACS_OBJECT_STORAGE;
  else process.env.ACS_OBJECT_STORAGE = originalMode;
  setDb(null);setObjectStore(undefined);await pg.close();
 }
});
