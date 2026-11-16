import { Pool } from 'pg';
import assert from 'node:assert/strict';
import { setDb, transaction, db, type Query } from '../lib/db';
async function main(){
const pool=new Pool({connectionString:process.env.ACS_TEST_POSTGRES_URL});
assert.ok(process.env.ACS_TEST_POSTGRES_URL,'explicit disposable test database required');
const schema='test_'+Date.now();
await pool.query(`create schema ${schema}`);
const q=(async(s:string,p:unknown[]=[])=>{const c=await pool.connect();try {await c.query(`set search_path to ${schema}`);return (await c.query(s,p)).rows;}finally{c.release();}}) as Query;
setDb(q,async work=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query(`set local search_path to ${schema}`);const result=await work((async(s,p=[]) => (await c.query(s,p)).rows) as Query);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
try {
 await transaction('owner',async()=>{await db()('create table counter (n int)');await db()('insert into counter values(0)');});
 await Promise.all(Array.from({length:8},()=>transaction('owner',async()=>{const [r]=await db()<{n:number}>('select n from counter');await db()('select pg_sleep(0.02)');await db()('update counter set n=$1',[r.n+1]);})));
 assert.equal((await q<{n:number}>('select n from counter'))[0].n,8,'account lock prevents lost updates across connections');
 await assert.rejects(transaction('owner',async()=>{await db()('update counter set n=999');throw Error('rollback');}));
 assert.equal((await q<{n:number}>('select n from counter'))[0].n,8);
 console.log('PostgreSQL: concurrent account locking and rollback passed');
}finally{await pool.query(`drop schema ${schema} cascade`);await pool.end();setDb(null);}

}
main().catch(e=>{console.error(e);process.exitCode=1;});
