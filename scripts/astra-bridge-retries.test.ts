/** Lost-response fault injection around the real client and transactional PGlite API. */
import { test, before, after, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { setDb, db, type Query } from '../lib/db';
import { handleApi } from '../lib/api';
import { deviceUser } from '../lib/bridge';
import { touchUser } from '../lib/users';
import { forgetAllowedCache } from '../lib/allow';
import { client } from '../bridge/acs-bridge.mjs';

const user = { owner: 'gh:791', login: 'astra' };
const base = 'http://127.0.0.1:31999';
let pg: PGlite;
const previousAllowed = process.env.ACS_ALLOWED_GITHUB;
before(async () => {
  process.env.ACS_ALLOWED_GITHUB = 'astra'; forgetAllowedCache();
  pg = new PGlite();
  setDb((async (sql, args = []) => (await pg.query(sql, args)).rows) as Query,
    async work => pg.transaction(async tx => work((async (sql, args = []) => (await tx.query(sql, args)).rows) as Query)));
  await touchUser(user.owner, user.login);
});
after(async () => {
  setDb(null); await pg.close();
  if (previousAllowed === undefined) delete process.env.ACS_ALLOWED_GITHUB;
  else process.env.ACS_ALLOWED_GITHUB = previousAllowed;
  forgetAllowedCache();
});
beforeEach(async () => {
  for (const table of ['acs_job_events', 'acs_jobs', 'acs_devices', 'acs_chunks', 'acs_files']) await db()(`delete from ${table}`);
});
async function api(method: string, path: string, body?: unknown) {
  const r = await handleApi(new Request(`${base}/api/${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  }), path.split('?')[0].split('/'), user);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function queued() {
  const j = await api('POST', 'jobs', {project: 'p1', kind: 'cards', files: [{name: 'anki_prompt.txt', size: 2}]});
  await api('PUT', `jobs/${j.id}/in/anki_prompt.txt`, 'hi');
  await api('POST', `jobs/${j.id}/queue`);
  return j.id;
}
function transport(t: TestContext, lostPath: string) {
  let drops = 0;
  // The server commits successfully; only delivery to the bridge fails. All retries
  // still use the real client, token authentication, API and transaction implementation.
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    const u = await deviceUser(req.headers.get('authorization'));
    assert.ok(u, 'fixture device authenticates');
    const response = await handleApi(req, url.pathname.slice(5).split('/'), u);
    assert.equal(response.status, 200, await response.clone().text());
    if (url.pathname === `/api/${lostPath}` && drops === 0) { drops++; throw new TypeError('injected lost response after commit'); }
    return response;
  });
  return () => drops;
}

test('retrying a lost claim response returns the original job without stranding it', async t => {
  const d = await api('POST', 'devices', {name: 'Mac'}), id = await queued();
  const drops = transport(t, 'bridge/claim');
  const result = await client(base, d.token).claim(['claude']);
  assert.equal(drops(), 1);
  assert.equal((await api('GET', `jobs/${id}`)).status, 'running');
  assert.equal(result.job?.id, id, 'the only job is running on the server but the bridge receives no job');
});

test('retrying a lost progress response records each event exactly once', async t => {
  const d = await api('POST', 'devices', {name: 'Mac'}), id = await queued();
  const drops = transport(t, `bridge/jobs/${id}/events`), bridge = client(base, d.token);
  assert.equal((await bridge.claim(['claude'])).job.id, id);
  await bridge.events(id, [{type: 'text', text: 'Reading lecture'}, {type: 'tool', text: 'Read notes.pdf'}]);
  assert.equal(drops(), 1);
  const events = await api('GET', `jobs/${id}/events`);
  assert.deepEqual(events.map((e: {text: string}) => e.text), ['Reading lecture', 'Read notes.pdf']);
});
