import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync('public/sw.js', 'utf8');
function worker(cache: object, fetch: () => Promise<unknown>) {
  const handlers: Record<string, Function> = {};
  vm.runInNewContext(source, {self: {addEventListener: (n: string, f: Function) => handlers[n] = f, clients: {claim() {}}, skipWaiting() {}}, location: {origin: 'https://studio.test'}, URL, Response, caches: cache, fetch});
  return handlers;
}
test('activation preserves caches owned by other applications', async () => {
  const deleted: string[] = []; let work: Promise<unknown>;
  const h = worker({keys: async () => ['other-app', 'acs-v1', 'acs-v2', 'acs-media'], delete: async (key: string) => deleted.push(key)}, async () => null);
  h.activate({waitUntil(p: Promise<unknown>) {work = p;}});
  await work!; assert.deepEqual(deleted, ['acs-v1']);
});
for (const path of ['/', '/api/project/p/media/a.png', '/icons/icon-192.png']) {
  test(`cache writes extend fetch lifetime and tolerate quota failure: ${path}`, async () => {
    const pending: Promise<unknown>[] = []; let response: Promise<unknown>; let writes = 0;
    const h = worker({match: async () => undefined, open: async () => ({put: async () => {writes++; throw new Error('quota');}})}, async () => ({ok: true, status: 200, type: 'basic', redirected: false, headers: new Headers(), clone: () => new Response('ok')}));
    h.fetch({request: {url: 'https://studio.test' + path, method: 'GET', mode: 'navigate'}, respondWith(p: Promise<unknown>) {response = p;}, waitUntil(p: Promise<unknown>) {pending.push(p);}});
    assert.ok(await response!); assert.ok(pending.length); await Promise.all(pending); assert.equal(writes, 1);
  });
}
