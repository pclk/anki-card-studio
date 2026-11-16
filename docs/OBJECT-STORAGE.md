Binary storage rollout
=====================

The server uses private `uploads` objects when all four AWS variables are configured
(AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).
No variables means the existing Postgres-only mode. Partial configuration fails
closed. ACS_OBJECT_STORAGE=off disables new object writes; object-backed reads
still use the configured credentials. Configure matching database and storage
branch credentials on the application host; never expose them as NEXT_PUBLIC vars.
No deployment is performed by these changes.

New writes use random immutable keys scoped by a SHA-256 hash of owner/project/kind/name.
The existing API authenticates the owner; no caller supplies an object key. Reads
verify scope, size and digest. Owner transaction locks serialize staging, retry,
promotion, deletion and quota accounting. Logical bytes count toward quotas even
though Postgres stores only references. An upload completes before its reference
can commit. Failed SQL/quotas or ambiguous commits can leave unused objects; they
cannot overwrite an existing file. Deleted/replaced objects enter the durable cleanup
queue described below. Run its bounded collector to reclaim them after the grace
period. Do not run bucket-wide deletion; snapshot retention and account erasure
requirements need operational handling.

Rollout and migration
---------------------

1. Back up database and matching bucket state. Test the release on an isolated
   branch first. Deploy this dual-reader version with matching private bucket
   credentials. Schema initialization adds nullable object metadata columns and
   allows null data; existing bytes are untouched. Do not run old and new writer
   versions concurrently during rollout or rollback.
2. Supply DATABASE_URL and AWS variables through your secure environment injector.
   The migration command intentionally never loads .env.local. Select one owner:
   `ACS_MIGRATE_OWNER='<owner>' npx tsx scripts/migrate-objects.ts`
   This initializes additive schema and prints completed and staged chunk candidate counts.
3. Add `--apply` to migrate up to ACS_MIGRATE_LIMIT chunks (default 100).
   Repeat until none remain. Each chunk has an owner-locked transaction; upload and
   verified download precede replacing database bytes. Both committed and staged
   chunks migrate. Stop/retry freely. Migration consumes one final legacy payload
   read, plus object upload and verification download; it cannot bypass HTTP402.
   Restore DB service/quota before migration. No bulk migration ran during development.
4. Confirm API downloads and quota reports. Postgres retains project JSON/history;
   this change moves only media/source binary chunks. It does not remove all DB traffic.

### Whole-database migration (production)

`scripts/migrate-production-objects.ts` runs the same verified per-chunk migration for every owner.
Pass the environment file explicitly; it uses DATABASE_URL_UNPOOLED (direct) when present:

    node --env-file=.env.local --import=tsx scripts/migrate-production-objects.ts
    node --env-file=.env.local --import=tsx scripts/migrate-production-objects.ts --apply --confirm=<endpoint>

Without `--apply` it is a read-only survey (pending chunks and size per owner and kind). `--apply`
requires `--confirm=` naming the database endpoint it prints, refuses a bucket from another branch
(NEON_BRANCH_ID vs the storage endpoint), and refuses until the object-aware release has created
its columns, because an older live app cannot read moved files. `--kind=media` (or `pdf`) limits it.
Interrupt and re-run freely. Roll back per owner with `scripts/migrate-objects.ts --rollback`.

Rollback
--------

Keep this release deployed; pause client writes. Run the same command with
`--rollback` (dry-run), then `--rollback --apply` repeatedly for every owner.
Rollback downloads and verifies objects and restores bytea in bounded transactions;
objects remain intact. Verify BOTH acs_chunks and acs_upload_chunks have zero
non-null object_key rows. Only then disable object storage or deploy an old reader.
Allow database space/transfer for restored payloads. Do not drop columns while this
release may run. Snapshot restore must restore database and bucket coherently.

Verification
------------

`ACS_OBJECT_STORAGE=off npm test` runs deterministic PGlite regression tests.
`npx tsx scripts/object-storage.integration.ts` explicitly loads .env.local for real
bucket credentials, but binds all SQL to a fresh in-memory PGlite. It verifies a
256 KiB upload/read/rollback and deletes only the exact test object it created.
It prints byte counts, never credentials. It does not measure provider billing.
For browser tests clear DATABASE_URL and POSTGRES_URL explicitly and set
ACS_OBJECT_STORAGE=off; Next otherwise loads .env.local despite local PGlite config.

### Durable lifecycle cleanup

Run `npx tsx scripts/collect-objects.ts` from a scheduled job (for example hourly)
with the same explicit database and object credentials as the app. It does not
load dotenv files. `ACS_GC_LIMIT` defaults to 100 and accepts 1–1000; each run
examines at most that many enrolled keys. Run repeatedly to drain a backlog.
Monitor failures and queue age; physical storage is not reclaimed without this
runner. No deployment or schedule is installed by this change.

An autocommitted intent precedes each remote PUT. Chunk retirement triggers enroll
old keys in the same transaction as deletion/update, including existing keys from
before this release. Account wipe deliberately preserves this queue. Failed PUT,
verification, rollback and ambiguous database commits therefore remain retryable.
The collector holds the same account advisory lock as writes/migration, checks
both completed and staged references, and only then deletes an exact enrolled key.
Remote deletion failures roll back queue changes for retry. No bucket listing or
bucket-wide deletion is performed. Previously orphaned objects created before
intent tracking cannot safely be discovered by this runner.

The grace period is seven days. Referenced keys are retained. Tombstones are kept
and reconsidered every seven days, so late completion of an ambiguous PUT is
cleaned on a later pass. This bounds work per run, not queue metadata size or
physical bytes during the grace period. Failed authorized uploads can consume
storage until cleanup; logical quota is not a physical storage cap. Quota-rejected
uploads are checked before PUT under the account lock. The runner also expires at most `ACS_GC_LIMIT` staging sessions idle for seven
days under the account lock; their objects receive another seven-day grace.
Operators can delete the file or project to retire them immediately into the queue.

Only run GC against a database and bucket namespace with exclusive ownership.
A reference check cannot see independent database branches, snapshots, backups or
point-in-time history sharing that bucket. Seven days does not guarantee backup
retention: disable GC while such references may be restored, or give each branch
an isolated bucket/credentials and back up object bytes with database snapshots.
Restoring an older database after collection may leave missing objects. Never run
multiple independent databases' collectors against a shared bucket namespace.

`ACS_OBJECT_STORAGE=off` disables new object writes; existing object reads,
rollback and GC still use credentials. The single-connection embedded/test adapter
flushes intents after transaction settlement (including rollback); unlike hosted
Postgres it cannot guarantee crash durability between PUT and that flush. Use the
hosted Postgres backend for durable production object writes.
