/** Real private bucket + isolated in-memory database. No production SQL connection. */
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, transaction, type Query } from '../lib/db';
import { writeChunk, readChunk } from '../lib/store';
import { migrateChunk } from '../lib/storage-migration';
async function main(){
 loadEnvFile('.env.local');
 delete process.env.ACS_OBJECT_STORAGE;
 const pg=new PGlite();
 setDb((async(s,p=[]) => (await pg.query(s,p)).rows) as Query,async work=>pg.transaction(async tx=>work((async(s,p=[]) => (await tx.query(s,p)).rows) as Query)));
 const owner='integration:'+randomUUID(), bytes=Buffer.alloc(256*1024,71);
 const keys:string[]=[];
 try {
  await transaction(owner,()=>writeChunk(owner,'p','media','test','application/octet-stream',0,1,bytes,'integration'));
  const [row]=await db()<{object_key:string;payload:number;metadata:number}>(`select object_key,coalesce(octet_length(data),0) as payload,octet_length(object_key)+octet_length(sha256)+8 as metadata from acs_chunks where owner=$1`,[owner]);
  keys.push(row.object_key);
  assert.equal(row.payload,0);assert.deepEqual(await readChunk(owner,'p','media','test',0),bytes);
  assert.equal(await readChunk(owner+'other','p','media','test',0),null);
  assert.equal(await migrateChunk(owner,true),bytes.length);
  assert.deepEqual(await readChunk(owner,'p','media','test',0),bytes);
  console.log(JSON.stringify({verified:true,logicalBytes:bytes.length,databasePayloadBytes:row.payload,referenceBytes:row.metadata,legacyBase64Bytes:bytes.toString('base64').length}));
 } finally {
  const [{Files},{neon}]=await Promise.all([import('files-sdk'),import('files-sdk/neon')]);
  const files=new Files({adapter:neon({bucket:'uploads'})});
  for(const key of keys) await files.delete(key);
  setDb(null);await pg.close();
 }
}
main().catch(()=>{console.error('Isolated object integration failed');process.exitCode=1;});
