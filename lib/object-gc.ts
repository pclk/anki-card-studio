import { db, ensureSchema, transaction } from './db';
import { objectStore } from './object-storage';
/** Deletes only enrolled keys, with an account lock held across reference check + DELETE.
 * Retain tombstones: an ambiguously completed remote PUT may arrive after a DELETE.
 */
export async function collectObjects(limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid GC limit');
  await ensureSchema();
  const store = objectStore(true);
  if (!store?.delete) throw new Error('Object deletion unavailable');
  // Expire abandoned staging sessions under the same lock; triggers queue their keys.
  const stale = await db()<{owner:string;project:string;kind:string;name:string}>(
    "select owner,project,kind,name from acs_upload_files where updated < now()-interval '7 days' order by updated limit $1", [limit]);
  for (const r of stale) await transaction(r.owner, async () => {
    const args=[r.owner,r.project,r.kind,r.name];
    const expired=await db()("delete from acs_upload_files where owner=$1 and project=$2 and kind=$3 and name=$4 and updated < now()-interval '7 days' returning name", args);
    if (expired.length) await db()('delete from acs_upload_chunks where owner=$1 and project=$2 and kind=$3 and name=$4',args);
  });
  const rows = await db()<{object_key:string;owner:string}>(
    'select object_key,owner from acs_object_gc where eligible_at <= now() order by eligible_at limit $1', [limit]);
  let deleted = 0;
  for (const r of rows) await transaction(r.owner, async () => {
    // The unlocked candidate list may be stale: retirement or another collector
    // can have renewed the grace period while we waited for this account lock.
    const due = await db()('select 1 from acs_object_gc where object_key=$1 and owner=$2 and eligible_at <= now() for update', [r.object_key,r.owner]);
    if (!due.length) return;
    if (!/^acs\/v1\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(r.object_key)) throw new Error('Invalid enrolled key');
    const refs = await db()(`select 1 from acs_chunks where object_key=$1 union all select 1 from acs_upload_chunks where object_key=$1 limit 1`, [r.object_key]);
    if (!refs.length) { await store.delete!(r.object_key); deleted++; }
    await db()("update acs_object_gc set eligible_at=now()+interval '7 days' where object_key=$1", [r.object_key]);
  });
  return deleted;
}
