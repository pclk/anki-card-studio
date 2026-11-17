/** Server-only private objects. Never delete on request failure: COMMIT may have succeeded. */
import { createHash, randomUUID } from 'node:crypto';
export interface ObjectStore { put(key: string, bytes: Buffer): Promise<void>; get(key: string): Promise<Buffer>; delete?(key: string): Promise<void> }
let override: ObjectStore | null | undefined;
export function setObjectStore(value: ObjectStore | null | undefined) { override = value; }
export function objectStore(forRead = false): ObjectStore | null {
  if (override !== undefined) return override;
  if (!forRead && process.env.ACS_OBJECT_STORAGE === 'off') return null;
  const names = ['AWS_ENDPOINT_URL_S3','AWS_REGION','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY'];
  if (!names.some(n => process.env[n])) return null;
  if (!names.every(n => process.env[n])) throw new Error('Incomplete object storage configuration');
  // one client per configuration: every chunk read and write asks for the store
  const config = names.map(n => process.env[n]).join('\n');
  if (remote?.config !== config) remote = { config, store: neonStore() };
  return remote.store;
}
let remote: { config: string; store: ObjectStore } | null = null;
function neonStore(): ObjectStore {
  const files = Promise.all([import('files-sdk'), import('files-sdk/neon')]).then(([{Files},{neon}]) => new Files({ adapter: neon({ bucket: 'uploads' }), timeout: 30_000, retries: 2 }));
  // a client that could not be made is not kept: the next request tries again
  files.catch(() => { if (remote?.store === store) remote = null; });
  const store: ObjectStore = {
    async put(key, bytes) { try { await (await files).upload(key, bytes, {contentType:'application/octet-stream'}); } catch { throw new Error('Object upload failed'); } },
    async delete(key) { try { await (await files).delete(key); } catch { throw new Error('Object deletion failed'); } },
    async get(key) { try { return Buffer.from(await (await (await files).download(key)).arrayBuffer()); } catch { throw new Error('Object download failed'); } },
  };
  return store;
}
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function objectPrefix(owner: string, project: string, kind: string, name: string) {
  return 'acs/v1/' + createHash('sha256').update(JSON.stringify([owner,project,kind,name])).digest('hex') + '/';
}
export function objectKey(owner: string, project: string, kind: string, name: string) {
  return objectPrefix(owner,project,kind,name) + randomUUID();
}
export async function readObject(key: string, hash: string, size: number, owner: string, project: string, kind: string, name: string) {
  if (!key.startsWith(objectPrefix(owner,project,kind,name))) throw new Error('Object scope mismatch');
  const store = objectStore(true);
  if (!store) throw new Error('Object storage required to read this file');
  const bytes = await store.get(key);
  if (bytes.length !== Number(size) || digest(bytes) !== hash) throw new Error('Object integrity mismatch');
  return bytes;
}
