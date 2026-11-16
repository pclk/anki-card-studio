import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, transaction, type Query } from '../lib/db';
import { handleApi } from '../lib/api';
import { applyRegistry, forgetUser } from '../lib/users';
import { isPublicAddress } from '../lib/fetch-readable';
const pg = new PGlite();
const user = {owner:'gh:edges', login:'edges'};
before(async () => setDb((async (s,p=[]) => (await pg.query(s,p)).rows) as Query,
  async work => pg.transaction(async tx => work((async(s,p=[]) => (await tx.query(s,p)).rows) as Query))));
after(async () => { setDb(null); await pg.close(); });
function call(method:string, path:string, body?:string|Buffer, headers:Record<string,string>={}, who:any=user) {
 const url=new URL('https://studio.test/api/'+path);
 if(url.searchParams.has('chunks') && !url.searchParams.has('upload')) url.searchParams.set('upload','test-session');
 return handleApi(new Request(url,{method,body,headers:{origin:'https://studio.test',...headers}}),url.pathname.slice(5).split('/'),who);
}
for (const method of ['PUT','POST','PATCH','DELETE']) test(`${method} rejects hostile origin`,async()=>{
 assert.equal((await call(method,'settings','{}',{origin:'https://evil.test'})).status,403);
});
for (const path of ['settings','projects','project/x','project/x/media','admin/users','people']) test(`anonymous cannot read ${path}`,async()=>{
 assert.equal((await call('GET',path,undefined,{},null)).status,401);
});
for (const path of ['settings','projects','project/x','project/x/media']) test(`disabled cannot read ${path}`,async()=>{
 assert.equal((await call('GET',path,undefined,{}, {...user,status:'disabled'})).status,403);
});
for (const method of ['PUT','DELETE','POST','PATCH']) test(`readonly rejects ${method}`,async()=>{
 assert.equal((await call(method,'project/x','{}',{}, {...user,status:'readonly'})).status,403);
});
for (const path of ['project/%2e%2e','project/a%2fb','project/x/media/a%2fb.png','project/x/media/..png']) test(`invalid path ${path}`,async()=>{
 assert.equal((await call('PUT',path,'{}')).status,path === 'project/%2e%2e' ? 404 : 400);
});
for (const endpoint of ['settings','projects','project/invalid']) test(`malformed JSON at ${endpoint}`,async()=>{
 assert.equal((await call('PUT',endpoint,'{')).status,400);
});
for (const body of ['null','[]','42','"text"']) test(`project rejects non-object ${body}`,async()=>{
 assert.equal((await call('PUT','project/shape',body)).status,400);
});
for (const query of ['chunk=-1&chunks=2','chunk=1.5&chunks=2','chunk=0&chunks=0','chunk=0&chunks=4097','chunk=x&chunks=2','chunk=2&chunks=2']) test(`invalid upload ${query}`,async()=>{
 assert.equal((await call('PUT','project/x/media/x.png?'+query,'x')).status,400);
});
test('oversize upload rejected',async()=>assert.equal((await call('PUT','project/x/media/large',Buffer.alloc(4*1024*1024+1025))).status,413));
test('chunk completion requires every piece, retry replaces rather than appends',async()=>{
 const path='project/chunks/sources/file.pdf';
 for(const [idx,text] of [[0,'a'],[2,'c']] as const) assert.equal((await call('PUT',`${path}?chunk=${idx}&chunks=3`,text)).status,200);
 assert.equal((await call('GET',path)).status,404);
 assert.equal((await call('PUT',path+'?chunk=1&chunks=3','b')).status,200);
 assert.equal((await (await call('GET',path)).json()).size,3);
 await call('PUT',path+'?chunk=1&chunks=3','BB');
 assert.equal((await (await call('GET',path)).json()).size,3);
 assert.equal(await (await call('GET',path+'?chunk=1')).text(),'b');
});
test('ETag supports conditional reads and owner isolation',async()=>{
 const path='project/etag/media/image.png'; await call('PUT',path,'image',{'content-type':'image/png'});
 const r=await call('GET',path); const etag=r.headers.get('etag')!;
 assert.equal((await call('GET',path,undefined,{'if-none-match':etag})).status,304);
 assert.equal((await call('GET',path,undefined,{'if-none-match':etag},{owner:'gh:other',login:'other'})).status,404);
});
test('transaction rolls back multiple writes on exception',async()=>{
 await assert.rejects(transaction(user.owner,async()=>{
  await db()("insert into acs_settings(owner,data) values($1,$2)",['rollback','{}']);
  throw Error('injected failure');
 }));
 assert.equal((await db()('select 1 from acs_settings where owner=$1',['rollback'])).length,0);
});
test('nested transactions share rollback',async()=>{
 await assert.rejects(transaction(user.owner,async()=>{
  await transaction(user.owner,async()=>{await db()("insert into acs_settings(owner,data) values($1,$2)",['nested','{}']);});
  throw Error('outer failure');
 }));
 assert.equal((await db()('select 1 from acs_settings where owner=$1',['nested'])).length,0);
});
test('competing quota writes permit only the capacity that exists',async()=>{
 await applyRegistry(user,null,[]);
 await db()('update acs_users set quota_mb=1 where owner=$1',[user.owner]);forgetUser();
 const results=await Promise.all(['a','b'].map(name=>call('PUT',`project/quota/media/${name}.png`,Buffer.alloc(700000))));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,413]);
 await db()('update acs_users set quota_mb=null where owner=$1',[user.owner]);forgetUser();
});
for (const ip of ['::','fe80::1','224.0.0.1','255.255.255.255','192.168.0.1','172.16.0.1','198.18.0.1','::ffff:10.0.0.1']) test(`SSRF blocks ${ip}`,()=>assert.equal(isPublicAddress(ip),false));
test('unknown route returns 404',async()=>assert.equal((await call('GET','does-not-exist')).status,404));

for(const rev of [1.5,1e12,-1]) test(`reject invalid revision ${rev}`, async()=>{
 assert.equal((await call('PUT','project/badrev',JSON.stringify({rev}))).status,400);
});
test('invalid base and non-increasing revision rejected',async()=>{
 for(const base of ['abc','1']) assert.equal((await call('PUT','project/badrev','{"rev":1}',{'x-acs-base-rev':base})).status,400);
});
for(const chunk of ['abc','1.5','-1','1','%0D%0A']) test(`read rejects invalid chunk ${chunk}`,async()=>{
 await call('PUT','project/read/media/f','x');
 assert.equal((await call('GET','project/read/media/f?chunk='+chunk)).status,400);
});
test('stale save cannot recreate deleted project',async()=>{
 await call('DELETE','project/gone');
 assert.equal((await call('PUT','project/gone','{"rev":1}')).status,410);
 assert.equal((await call('GET','project/gone')).status,404);
});
test('settings contribute to quota',async()=>{
 const u={owner:'gh:settingsquota',login:'settingsquota'};
 await applyRegistry(u,null,[]);
 await db()('update acs_users set quota_mb=1 where owner=$1',[u.owner]);forgetUser();
 assert.equal((await call('PUT','settings',JSON.stringify({data:'x'.repeat(1100000)}),{},u)).status,413);
 assert.equal(await (await call('GET','settings',undefined,{},u)).text(),'null');
});
test('incomplete replacement preserves previous file until promotion',async()=>{
 const path='project/stage/media/f';
 await call('PUT',path,'original');
 await call('PUT',path+'?chunk=0&chunks=2','new');
 assert.equal(await (await call('GET',path)).text(),'original');
 await call('PUT',path+'?chunk=1&chunks=2','file');
 assert.equal((await (await call('GET',path)).json()).chunks,2);
 assert.equal(await (await call('GET',path+'?chunk=0')).text(),'new');
 assert.equal((await call('PUT',path+'?chunk=1&chunks=2','corrupt')).status,409);
});
test('competing upload sessions cannot mix their pieces',async()=>{
 const p='project/sessions/media/f';
 await call('PUT',p+'?chunk=0&chunks=2&upload=A','A0');
 await call('PUT',p+'?chunk=0&chunks=2&upload=B','B0');
 assert.equal((await call('PUT',p+'?chunk=1&chunks=2&upload=A','A1')).status,409);
 assert.equal((await call('PUT',p+'?chunk=1&chunks=2&upload=B','B1')).status,200);
 assert.equal(await (await call('GET',p+'?chunk=0')).text(),'B0');
 assert.equal(await (await call('GET',p+'?chunk=1')).text(),'B1');
});
