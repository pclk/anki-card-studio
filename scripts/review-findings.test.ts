import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, type Query } from '../lib/db';
import { handleApi } from '../lib/api';
import { applyRegistry, forgetUser } from '../lib/users';

const pg = new PGlite();
const user = {owner:'gh:review', login:'review'};
const admin = {owner:'gh:boss', login:'boss', admin:true};
before(async () => setDb((async (s,p=[]) => (await pg.query(s,p)).rows) as Query,
  async work => pg.transaction(async tx => work((async(s,p=[]) => (await tx.query(s,p)).rows) as Query))));
after(async () => { setDb(null); await pg.close(); });
function call(method:string, path:string, body?:string|Buffer, headers:Record<string,string>={}, who:any=user) {
 const url=new URL('https://studio.test/api/'+path);
 return handleApi(new Request(url,{method,body,headers:{origin:'https://studio.test',...headers}}),url.pathname.slice(5).split('/'),who);
}
const project = (rev:number, pad:number) => JSON.stringify({rev, cards:[], pad:'x'.repeat(pad)});
async function setQuota(owner:string, mb:number|null){
 await applyRegistry({owner, login: owner.slice(3)} as any, null, []);
 await db()('update acs_users set quota_mb=$2 where owner=$1',[owner, mb]); forgetUser();
}

test('saving the same project twice does not double its quota charge', async () => {
 const u = {owner:'gh:hist', login:'hist'};
 await setQuota(u.owner, 1);
 assert.equal((await call('PUT','project/p', project(1, 600_000), {}, u)).status, 200);
 // 600 KB project, 1 MB quota: the history copy made by the second save must not make the account "full"
 const r = await call('PUT','project/p', project(2, 600_000), {'x-acs-base-rev':'1'}, u);
 assert.equal(r.status, 200, await r.text());
});

test('deleting a project frees the space it used', async () => {
 const u = {owner:'gh:del', login:'del'};
 await setQuota(u.owner, 1);
 assert.equal((await call('PUT','project/big', project(1, 700_000), {}, u)).status, 200);
 assert.equal((await call('DELETE','project/big', undefined, {}, u)).status, 200);
 const r = await call('PUT','project/other/media/a.png', Buffer.alloc(700_000), {}, u);
 assert.equal(r.status, 200, await r.text());
});

test('retrying the final piece after its response was lost is idempotent', async () => {
 const path='project/retry/sources/a.pdf', q='&chunks=2&upload=s1';
 assert.equal((await call('PUT',`${path}?chunk=0${q}`,'a')).status,200);
 assert.equal((await call('PUT',`${path}?chunk=1${q}`,'b')).status,200);
 assert.equal((await call('PUT',`${path}?chunk=1${q}`,'b')).status,200);
});

test('a re-sent piece 0 of the same session does not silently discard later pieces', async () => {
 const path='project/retry0/sources/a.pdf', q='&chunks=3&upload=s2';
 for (const [i, s] of [[0,'a'],[1,'b'],[0,'a'],[2,'c']] as const)
  assert.equal((await call('PUT',`${path}?chunk=${i}${q}`,s)).status,200);
 // every request was accepted, so the file must be complete (or one of the requests must have failed)
 assert.equal((await call('GET',path)).status,200);
});

test('superseded upload cannot resume after the newer upload finishes', async () => {
 const path='project/race/media/a.png';
 assert.equal((await call('PUT',`${path}?chunk=0&chunks=2&upload=A`,'A0')).status,200);
 assert.equal((await call('PUT',`${path}?chunk=0&chunks=2&upload=B`,'B0')).status,200);
 assert.equal((await call('PUT',`${path}?chunk=1&chunks=2&upload=B`,'B1')).status,200);
 assert.equal((await call('PUT',`${path}?chunk=1&chunks=2&upload=A`,'A1')).status,409);
 const meta = await (await call('GET',path)).json();
 assert.equal(meta.size, 4);
 assert.equal(await (await call('GET',path+'?chunk=0')).text(),'B0');
});

for (const rev of ['"5"', 'true', 'null', '[]']) test(`hosted rejects non-integer rev ${rev} like the local server`, async () => {
 const r = await call('PUT','project/revshape', `{"rev":${rev}}`);
 assert.equal(r.status, 400, await r.text());
});

for (const base of ['1e3', '0x10', '5 0']) test(`hosted rejects non-decimal base revision ${JSON.stringify(base)}`, async () => {
 const r = await call('PUT','project/baseshape', project(5000, 0), {'x-acs-base-rev': base});
 assert.equal(r.status, 400, await r.text());
});

test('admin history restore of a deleted project clears its tombstone', async () => {
 const u = {owner:'gh:zombie', login:'zombie'};
 await applyRegistry(u as any, null, []); await applyRegistry(admin as any, null, ['boss']);
 assert.equal((await call('PUT','project/z', project(1, 10), {}, u)).status, 200);
 assert.equal((await call('DELETE','project/z', undefined, {}, u)).status, 200);
 const hist = await (await call('GET',`admin/users/${u.owner}/project/z/history`, undefined, {}, admin)).json();
 assert.ok(hist.length);
 assert.equal((await call('POST',`admin/users/${u.owner}/project/z/history`, JSON.stringify({at: hist[0].at}), {}, admin)).status, 200);
 // the project is back in storage, so the owner must be able to keep saving it
 const r = await call('PUT','project/z', project(3, 10), {'x-acs-base-rev': String((await (await call('GET','project/z/rev',undefined,{},u)).json()).rev)}, u);
 assert.equal(r.status, 200, await r.text());
});

test('admin account listing reports the same usage the quota enforces', async () => {
 const u = {owner:'gh:shown', login:'shown'};
 await applyRegistry(u as any, null, []); await applyRegistry(admin as any, null, ['boss']);
 await call('PUT','settings', JSON.stringify({pad:'s'.repeat(50_000)}), {}, u);
 await call('PUT','project/h', project(1, 50_000), {}, u);
 await call('DELETE','project/h', undefined, {}, u);
 const {users} = await (await call('GET','admin/users', undefined, {}, admin)).json();
 const shown = users.find((x:any) => x.owner === u.owner).bytes;
 const {usage} = await import('../lib/users');
 assert.equal(shown, (await usage(u.owner)).total);
});
