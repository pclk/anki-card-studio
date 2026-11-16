import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, transaction, type Query } from '../lib/db';
import { setObjectStore } from '../lib/object-storage';
import { writeChunk, readChunk, fileMeta } from '../lib/store';
import { usage, checkQuota } from '../lib/users';
import { migrateChunk } from '../lib/storage-migration';
const pg=new PGlite();
const objects=new Map<string,Buffer>();
let fail=false;
before(()=>{
 setDb((async(s,p=[]) => (await pg.query(s,p)).rows) as Query, async work=>pg.transaction(async tx=>work((async(s,p=[]) => (await tx.query(s,p)).rows) as Query)));
 setObjectStore({async put(k,b){if(fail)throw Error('offline');objects.set(k,Buffer.from(b));},async get(k){assert.ok(objects.has(k));return objects.get(k)!;}});
});
after(async()=>{setDb(null);setObjectStore(undefined);await pg.close();});
const write=(idx:number,total:number,b:string,id='session')=>transaction('a',()=>writeChunk('a','p','media','f','text/plain',idx,total,Buffer.from(b),id));
test('object chunks preserve staging, retries, isolation, accounting and failure atomicity',async()=>{
 await write(0,1,'old','old');
 assert.equal((await readChunk('a','p','media','f',0))?.toString(),'old');
 await write(0,2,'abc');
 assert.equal((await readChunk('a','p','media','f',0))?.toString(),'old');
 assert.equal((await usage('a')).total,6);
 const n=objects.size; await write(0,2,'abc');assert.equal(objects.size,n);
 await assert.rejects(write(0,2,'different'));
 fail=true;await assert.rejects(write(1,2,'def'));fail=false;
 assert.equal((await fileMeta('a','p','media','f'))?.size,3);
 await write(1,2,'def');assert.equal((await usage('a')).total,6);
 assert.equal(await readChunk('b','p','media','f',0),null);
 assert.equal(await readChunk('a','other','media','f',0),null);
 const rows=await db()<{data:unknown;object_key:string}>('select data,object_key from acs_chunks');
 assert.ok(rows.every(r=>r.data===null && r.object_key));
 await assert.rejects(transaction('a',async()=>{await write(0,1,'rolled','rollback');throw Error('quota');}));
 assert.equal((await readChunk('a','p','media','f',0))?.toString(),'abc');
 const key=rows[0].object_key;objects.set(key,Buffer.from('corrupt'));
 await assert.rejects(readChunk('a','p','media','f',0));objects.set(key,Buffer.from('abc'));
});
test('bounded migration and rollback are repeatable and preserve legacy reads',async()=>{
 setObjectStore(null);await transaction('legacy',()=>writeChunk('legacy','p','sources','x','text/plain',0,1,Buffer.from('legacy')));
 setObjectStore({async put(k,b){objects.set(k,b);},async get(k){return objects.get(k)!;}});
 assert.equal((await readChunk('legacy','p','sources','x',0))?.toString(),'legacy');
 assert.equal(await migrateChunk('legacy'),6);assert.equal(await migrateChunk('legacy'),null);
 assert.equal((await readChunk('legacy','p','sources','x',0))?.toString(),'legacy');
 assert.equal(await migrateChunk('legacy',true),6);assert.equal(await migrateChunk('legacy',true),null);
 setObjectStore(null);assert.equal((await readChunk('legacy','p','sources','x',0))?.toString(),'legacy');
});

test('real quota rejection rolls back object references and concurrent retries stay idempotent',async()=>{
 setObjectStore({async put(k,b){objects.set(k,b);},async get(k){return objects.get(k)!;}});
 await db()("insert into acs_users(owner,login,quota_mb) values('quota','quota',0)");
 await assert.rejects(transaction('quota',async()=>{
  await writeChunk('quota','p','media','q','text/plain',0,1,Buffer.from('excess'));
  await checkQuota('quota',0);
 }));
 assert.equal(await fileMeta('quota','p','media','q'),null);
 const task=()=>transaction('parallel',()=>writeChunk('parallel','p','media','q','text/plain',0,1,Buffer.from('same'),'stable'));
 await Promise.all([task(),task(),task()]);
 assert.equal((await usage('parallel')).total,4);
 const rows=await db()("select 1 from acs_chunks where owner='parallel'");assert.equal(rows.length,1);
});

test('staged legacy migration preserves completed version and remote failure preserves DB bytes',async()=>{
 setObjectStore(null);
 await transaction('staged',()=>writeChunk('staged','p','media','x','text/plain',0,2,Buffer.from('first'),'stage'));
 setObjectStore({async put(){throw Error('offline');},async get(){throw Error('offline');}});
 await assert.rejects(migrateChunk('staged'));
 const [legacy]=await db()<{n:number}>("select octet_length(data) as n from acs_upload_chunks where owner='staged'");assert.equal(legacy.n,5);
 setObjectStore({async put(k,b){objects.set(k,b);},async get(k){return objects.get(k)!;}});
 assert.equal(await migrateChunk('staged'),5);assert.equal(await migrateChunk('staged'),null);
 assert.equal(await fileMeta('staged','p','media','x'),null);
 assert.equal(await migrateChunk('staged',true),5);
 await transaction('staged',()=>writeChunk('staged','p','media','x','text/plain',1,2,Buffer.from('last'),'stage'));
 assert.equal((await readChunk('staged','p','media','x',0))?.toString(),'first');
});
