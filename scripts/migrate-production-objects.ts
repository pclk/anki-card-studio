/** Moves every account's stored files (images = kind "media", source PDFs = kind "pdf") out of Postgres into the
 * matching Neon bucket, one verified chunk per transaction. Explicit environment only - pass the file yourself:
 *   node --env-file=.env.local --import=tsx scripts/migrate-production-objects.ts            # read-only survey
 *   node --env-file=.env.local --import=tsx scripts/migrate-production-objects.ts --apply --confirm=<endpoint>
 * Options: --kind=media (or pdf; repeatable) limits what moves. Stop and re-run at any time: finished chunks stay done.
 * Prints hosts and counts, never credentials. */
import { db, ensureSchema, closeDb } from '../lib/db';
import { migrateChunk } from '../lib/storage-migration';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = args.find(a => a.startsWith('--confirm='))?.slice(10);
const kinds = args.filter(a => a.startsWith('--kind=')).map(a => a.slice(7));
const bad = args.filter(a => a !== '--apply' && !a.startsWith('--confirm=') && !a.startsWith('--kind='));
if (bad.length || kinds.some(k => !['media', 'pdf'].includes(k))) throw new Error('Usage: [--apply --confirm=<endpoint>] [--kind=media|pdf]');

// migrations use the direct (non-pooled) connection when one is given
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set: run with node --env-file=<file>');
process.env.DATABASE_URL = url; delete process.env.POSTGRES_URL;
const host = new URL(url).hostname, endpoint = host.split('.')[0].replace(/-pooler$/, '');
const s3 = process.env.AWS_ENDPOINT_URL_S3, bucketBranch = s3 ? new URL(s3).hostname.split('.')[0] : '';
const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';

type Row = { owner: string; kind: string; chunks: number; bytes: number };
async function survey(): Promise<{ rows: Row[]; ready: boolean }> {
  const q = db();
  const tables = (await q<{ table_name: string; migrated: boolean }>(
    `select t.table_name, exists(select 1 from information_schema.columns c where c.table_schema = t.table_schema
       and c.table_name = t.table_name and c.column_name = 'object_key') as migrated
     from information_schema.tables t where t.table_schema = current_schema() and t.table_name in ('acs_chunks', 'acs_upload_chunks')`));
  const ready = tables.length > 0 && tables.every(t => t.migrated);
  if (!tables.length) return { rows: [], ready };
  const parts = tables.map(t => `select owner, kind, octet_length(data) as size from ${t.table_name}` + (t.migrated ? ' where object_key is null' : ''));
  const rows = await q<Row>(`select owner, kind, count(*)::int as chunks, coalesce(sum(size), 0)::bigint as bytes
    from (${parts.join(' union all ')}) pending where cardinality($1::text[]) = 0 or kind = any($1::text[])
    group by owner, kind order by owner, kind`, [kinds]);
  return { rows: rows.map(r => ({ ...r, chunks: Number(r.chunks), bytes: Number(r.bytes) })), ready };
}
function report(rows: Row[]) {
  if (!rows.length) return console.log('Nothing left in Postgres to move.');
  console.table(rows.map(r => ({ owner: r.owner, kind: r.kind, chunks: r.chunks, size: mb(r.bytes) })));
  console.log(`Total: ${rows.reduce((n, r) => n + r.chunks, 0)} chunks, ${mb(rows.reduce((n, r) => n + r.bytes, 0))}`);
}

async function main() {
  console.log(`Database: ${host} (${new URL(url!).pathname.slice(1)}), branch ${process.env.NEON_BRANCH || '?'}`);
  console.log(`Bucket:   ${s3 ? new URL(s3).hostname : 'NOT CONFIGURED'} (uploads)`);
  if (process.env.NEON_BRANCH_ID && bucketBranch && process.env.NEON_BRANCH_ID !== bucketBranch)
    throw new Error(`The bucket belongs to branch ${bucketBranch} but the database is ${process.env.NEON_BRANCH_ID}: use matching credentials`);
  if (!process.env.NEON_BRANCH_ID) console.log('(NEON_BRANCH_ID not set: cannot check that the bucket matches the database branch)');
  const before = await survey();
  report(before.rows);
  console.log(before.ready ? 'Schema: object-aware release has run here.' : 'Schema: no object columns yet - deploy the object-storage release before --apply.');
  if (!apply) {
    if (before.rows.length) console.log(`\nRead-only survey; nothing changed. To move these, re-run with: --apply --confirm=${endpoint}${kinds.map(k => ' --kind=' + k).join('')}`);
    return;
  }
  if (confirm !== endpoint) throw new Error(`--confirm must name this database's endpoint (${endpoint})`);
  if (!s3) throw new Error('Object storage is not configured (AWS_* variables)');
  if (process.env.ACS_OBJECT_STORAGE === 'off') throw new Error('ACS_OBJECT_STORAGE=off: unset it to migrate');
  // the object-aware release adds these columns when it first runs; until then the live app can't read moved files
  if (!before.ready) throw new Error('This database has no object columns yet: deploy the object-storage release (with the AWS_* variables) first, open the app once, then re-run');
  await ensureSchema();
  let moved = 0, bytes = 0;
  for (const owner of [...new Set(before.rows.map(r => r.owner))]) {
    let n: number | null, mine = 0;
    while ((n = await migrateChunk(owner, false, kinds)) !== null) {
      moved++; mine++; bytes += n;
      if (mine % 20 === 0) console.log(`  ${owner}: ${mine} chunks moved…`);
    }
    console.log(`${owner}: done (${mine} chunks)`);
  }
  console.log(`\nMoved ${moved} chunks (${mb(bytes)}), each verified by downloading it back. Remaining:`);
  report((await survey()).rows);
}
main().finally(closeDb).catch(e => { console.error('Stopped: ' + (e instanceof Error ? e.message : 'unknown error') + '\nChunks already moved stay valid; fix the cause and re-run.'); process.exitCode = 1; });
