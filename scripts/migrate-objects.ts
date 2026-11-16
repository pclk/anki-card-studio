/** Explicit environment only: does not load .env.local. */
import { db, ensureSchema, closeDb } from '../lib/db';
import { migrateChunk } from '../lib/storage-migration';
async function main() {
  const owner = process.env.ACS_MIGRATE_OWNER;
  if (!owner) throw new Error('ACS_MIGRATE_OWNER is required');
  if (process.argv.slice(2).some(a => !['--apply','--rollback'].includes(a))) throw new Error('Unknown argument');
  const limit = Number(process.env.ACS_MIGRATE_LIMIT || 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid ACS_MIGRATE_LIMIT');
  await ensureSchema();
  const rollback = process.argv.includes('--rollback');
  const [r] = await db()(`select count(*) as chunks, coalesce(sum(coalesce(byte_size,octet_length(data))),0) as bytes
    from (select data,object_key,byte_size from acs_chunks where owner=$1 union all select data,object_key,byte_size from acs_upload_chunks where owner=$1) candidates where ${rollback ? 'object_key is not null' : 'object_key is null'}`, [owner]);
  console.log({direction:rollback?'database':'objects',...r});
  if (!process.argv.includes('--apply')) return;
  let chunks=0, bytes=0;
  while(chunks<limit) { const n=await migrateChunk(owner,rollback); if(n===null) break; chunks++; bytes+=n; }
  console.log({committedChunks:chunks,logicalBytes:bytes});
}
main().finally(closeDb).catch(()=>{console.error('Migration failed; committed chunks remain valid. Check configuration and retry.');process.exitCode=1;});
