// API-level concurrency against a real PostgreSQL (PGlite serializes everything, so it cannot show these races).
import { Pool } from 'pg';
import assert from 'node:assert/strict';
import { setDb, db, type Query } from '../lib/db';
import { handleApi } from '../lib/api';
import { applyRegistry, forgetUser } from '../lib/users';
async function main(){
 assert.ok(process.env.ACS_TEST_POSTGRES_URL,'explicit disposable test database required');
 const pool=new Pool({connectionString:process.env.ACS_TEST_POSTGRES_URL,max:20});
 const schema='review_'+Date.now();
 await pool.query(`create schema ${schema}`);
 const q=(async(s:string,p:unknown[]=[])=>{const c=await pool.connect();try{await c.query(`set search_path to ${schema}`);return (await c.query(s,p)).rows;}finally{c.release();}}) as Query;
 setDb(q,async work=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query(`set local search_path to ${schema}`);const r=await work((async(s,p=[])=>(await c.query(s,p)).rows) as Query);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
 const user={owner:'gh:pgrace',login:'pgrace'};
 const call=(method:string,path:string,body?:string|Buffer,headers:Record<string,string>={})=>{
  const url=new URL('https://studio.test/api/'+path);
  return handleApi(new Request(url,{method,body,headers:{origin:'https://studio.test',...headers}}),url.pathname.slice(5).split('/'),user);
 };
 try {
  // two devices create the same project at once: exactly one wins, the other learns of the conflict
  for (let round=0;round<5;round++){
   const st=(await Promise.all([1,2].map(n=>call('PUT',`project/new${round}`,JSON.stringify({rev:1,who:n}),{'x-acs-base-rev':'0'})))).map(r=>r.status).sort();
   assert.deepEqual(st,[200,409],`round ${round}: ${st}`);
  }
  // quota: parallel uploads on separate connections cannot jointly exceed it
  await applyRegistry(user as any,null,[]);
  await db()('update acs_users set quota_mb=1 where owner=$1',[user.owner]);forgetUser();
  const up=(await Promise.all(['a','b','c'].map(n=>call('PUT',`project/q/media/${n}.png`,Buffer.alloc(450_000))))).map(r=>r.status).sort();
  assert.deepEqual(up,[200,200,413],`quota uploads: ${up}`);
  await db()('update acs_users set quota_mb=null where owner=$1',[user.owner]);forgetUser();
  // interleaved sessions for one name: the file is entirely one session's bytes
  const path='project/u/sources/f.bin';
  await Promise.all(['A','B'].map(async s=>{
   for (let i=0;i<4;i++) await call('PUT',`${path}?chunk=${i}&chunks=4&upload=${s}`,s.repeat(10)+i);
  }));
  const meta=await (await call('GET',path)).json();
  if (meta.chunks){
   const parts=await Promise.all([0,1,2,3].map(async i=>(await (await call('GET',`${path}?chunk=${i}`)).text())[0]));
   assert.equal(new Set(parts).size,1,`mixed sessions: ${parts}`);
  }
  console.log('PostgreSQL API concurrency (create, quota, upload sessions) passed');
 } finally { await pool.query(`drop schema ${schema} cascade`); await pool.end(); setDb(null); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
