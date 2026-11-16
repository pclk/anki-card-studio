import { db, transaction, objectIntent } from './db';
import { digest, objectKey, objectStore, readObject } from './object-storage';
/** One bounded chunk per transaction. Owner lock excludes application writes/deletes.
 * Objects are deliberately retained after rollback/failure for ambiguous commit safety.
 */
export async function migrateChunk(owner: string, rollback = false, kinds: string[] = []): Promise<number | null> {
  return transaction(owner, async () => {
    const q = db();
    for (const table of ['acs_chunks', 'acs_upload_chunks']) {
      const rows = await q<{project:string;kind:string;name:string;idx:number;b64:string;object_key:string;sha256:string;byte_size:number}>(
        `select project,kind,name,idx,encode(data,'base64') as b64,object_key,sha256,byte_size
         from ${table} where owner=$1 and ${rollback ? 'object_key is not null' : 'object_key is null'}
           and (cardinality($2::text[]) = 0 or kind = any($2::text[]))
         order by project,kind,name,idx limit 1`, [owner, kinds]);
      const r = rows[0];
      if (!r) continue;
      const args = [owner,r.project,r.kind,r.name,r.idx];
      if (rollback) {
        const bytes = await readObject(r.object_key,r.sha256,r.byte_size,owner,r.project,r.kind,r.name);
        await q(`update ${table} set data=decode($6,'base64'),object_key=null,sha256=null,byte_size=null
          where owner=$1 and project=$2 and kind=$3 and name=$4 and idx=$5`, [...args,bytes.toString('base64')]);
        return bytes.length;
      }
      const storage = objectStore();
      if (!storage) throw new Error('Object storage required');
      const bytes = Buffer.from(r.b64,'base64');
      const key = objectKey(owner,r.project,r.kind,r.name);
      await objectIntent(key,owner);
      await storage.put(key,bytes);
      // Verify the remote bytes before retiring the database payload.
      await readObject(key,digest(bytes),bytes.length,owner,r.project,r.kind,r.name);
      await q(`update ${table} set data=null,object_key=$6,sha256=$7,byte_size=$8
        where owner=$1 and project=$2 and kind=$3 and name=$4 and idx=$5`, [...args,key,digest(bytes),bytes.length]);
      return bytes.length;
    }
    return null;
  });
}
