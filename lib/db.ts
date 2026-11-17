/**
 * Postgres access. Production uses Neon's HTTP driver (one round trip per statement, no connection pool to manage
 * inside serverless functions). Writes use request-scoped WebSocket transactions. Tests swap in PGlite (Postgres compiled to WASM) through setDb().
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { Pool, neonConfig, neon } from "@neondatabase/serverless";

export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

type Transaction = <T>(work: (q: Query) => Promise<T>) => Promise<T>;
const intents = new AsyncLocalStorage<{key:string;owner:string}[]>();
const context = new AsyncLocalStorage<Query>();
let transact: Transaction | null = null;
let query: Query | null = null;
let closeEmbedded: (() => Promise<void>) | null = null;
export async function closeDb(): Promise<void> { await closeEmbedded?.(); closeEmbedded=null; }
let ready: Promise<void> | null = null;

export function setDb(q: Query | null, transaction: Transaction | null = null): void {
  query = q;
  transact = transaction;
  ready = null;
}

export function db(): Query {
  const active = context.getStore();
  if (active) return active;
  if (!query) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    // local development without Neon: a Postgres kept in a folder (PGlite). Never used on Vercel.
    if (!url && process.env.ACS_PGLITE_DIR && !process.env.VERCEL) {
      const dir = process.env.ACS_PGLITE_DIR;
      const pg = import("@electric-sql/pglite").then(({ PGlite }) => new PGlite(dir));
      closeEmbedded = async () => { await (await pg).close(); };
      transact = async (work) => (await pg).transaction(async tx => work((async (text: string, params: unknown[] = []) => (await tx.query(text, params)).rows) as Query));
      query = (async (text: string, params: unknown[] = []) => (await (await pg).query(text, params)).rows) as Query;
      return query;
    }
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = neon(url);
    query = (async (text: string, params: unknown[] = []) => (await sql.query(text, params)) as never) as Query;
  }
  return query;
}

/** Autocommit before PUT; independent of the request's potentially ambiguous commit. */
export async function objectIntent(key: string, owner: string): Promise<void> {
  if (transact) { // Embedded test DB has one connection; flush after its transaction settles.
    const pending = intents.getStore();
    if (!pending) throw new Error('Object writes require transaction');
    pending.push({key,owner});
    return;
  }
  await context.exit(() => db()("insert into acs_object_gc(object_key,owner) values($1,$2) on conflict do nothing", [key,owner]));
}

/** Tables, created on first use (idempotent), so a fresh database needs no manual step. */
export const SCHEMA: string[] = [
  `create table if not exists acs_settings (
     owner text primary key,
     data text not null,
     updated timestamptz not null default now())`,
  `create table if not exists acs_index (
     owner text not null,
     id text not null,
     entry text not null,
     updated bigint not null default 0,
     primary key (owner, id))`,
  `create table if not exists acs_deleted (
     owner text not null,
     id text not null,
     at timestamptz not null default now(),
     primary key (owner, id))`,
  `create table if not exists acs_projects (
     owner text not null,
     id text not null,
     data text not null,
     rev integer not null default 0,
     updated timestamptz not null default now(),
     primary key (owner, id))`,
  `create table if not exists acs_history (
     owner text not null,
     id text not null,
     rev integer not null,
     data text not null,
     at timestamptz not null default now())`,
  `create index if not exists acs_history_by_project on acs_history (owner, id, at desc)`,
  `create table if not exists acs_files (
     owner text not null,
     project text not null,
     kind text not null,
     name text not null,
     mime text not null,
     size bigint not null default 0,
     chunks integer not null default 1,
     complete boolean not null default false,
     updated timestamptz not null default now(),
     primary key (owner, project, kind, name))`,
  `create table if not exists acs_users (
     owner text primary key,
     login text not null,
     name text,
     image text,
     role text not null default 'user',
     status text not null default 'active',
     quota_mb integer,
     signed_out timestamptz,
     first_seen timestamptz not null default now(),
     last_seen timestamptz not null default now())`,
  `create table if not exists acs_allowed (
     login text primary key,
     added_by text not null,
     at timestamptz not null default now())`,
  `create table if not exists acs_chunks (
     owner text not null,
     project text not null,
     kind text not null,
     name text not null,
     idx integer not null,
     data bytea not null,
     primary key (owner, project, kind, name, idx))`,
];

SCHEMA.push('create table if not exists acs_upload_files (like acs_files including all)',
  'create table if not exists acs_upload_chunks (like acs_chunks including all)',
  "alter table acs_files add column if not exists upload_id text not null default ''",
  "alter table acs_upload_files add column if not exists upload_id text not null default ''");

// Additive migration: legacy payloads remain valid; object rows carry logical byte size.
for (const table of ['acs_chunks', 'acs_upload_chunks']) SCHEMA.push(
  `alter table ${table} alter column data drop not null`,
  `alter table ${table} add column if not exists object_key text`,
  `alter table ${table} add column if not exists sha256 text`,
  `alter table ${table} add column if not exists byte_size bigint`
);

// Queue survives account deletion. Triggers also enroll pre-existing object references.
SCHEMA.push(`create table if not exists acs_object_gc (
 object_key text primary key, owner text not null,
 eligible_at timestamptz not null default now() + interval '7 days')`,
 `create index if not exists acs_object_gc_due on acs_object_gc(eligible_at)`,
 `create or replace function acs_queue_object() returns trigger language plpgsql as $$
 begin
 if OLD.object_key is not null then
 insert into acs_object_gc(object_key,owner) values(OLD.object_key,OLD.owner)
 on conflict(object_key) do update set eligible_at=now()+interval '7 days';
 end if;
 if TG_OP = 'DELETE' then return OLD; end if;
 return NEW;
 end $$`);
for (const table of ['acs_chunks','acs_upload_chunks']) SCHEMA.push(
 `create index if not exists ${table}_object_key on ${table}(object_key) where object_key is not null`,
 `create or replace trigger acs_object_retirement before delete or update of object_key on ${table}
 for each row execute function acs_queue_object()`);

// the Mac bridge (lib/bridge.ts): device tokens, jobs and their progress
SCHEMA.push(

  `create table if not exists acs_devices (
     id text primary key,
     owner text not null,
     name text not null,
     token_hash text not null unique,
     hint text not null,
     created timestamptz not null default now(),
     last_seen timestamptz,
     last_info text,
     revoked_at timestamptz)`,
  `create index if not exists acs_devices_owner on acs_devices (owner)`,
  `create table if not exists acs_jobs (
     id text primary key,
     owner text not null,
     project text not null,
     kind text not null,
     agent text not null,
     title text not null,
     status text not null,
     files text not null default '[]',
     meta text not null default '{}',
     device text,
     created timestamptz not null default now(),
     claimed_at timestamptz,
     heartbeat_at timestamptz,
     finished_at timestamptz,
     imported_at timestamptz,
     error text,
     outputs text not null default '[]',
     events integer not null default 0)`,
  `create index if not exists acs_jobs_owner on acs_jobs (owner, status, created)`,
  // the highest event number (n) the bridge sent: a retried post whose first answer was lost isn't logged twice
  "alter table acs_jobs add column if not exists client_seq integer not null default 0",
  // what the job asks the agent for (model, effort, limits), checked against OPTION_RULES in lib/bridge.ts
  "alter table acs_jobs add column if not exists options text not null default '{}'",
  `create table if not exists acs_job_events (
     job text not null,
     seq integer not null,
     at timestamptz not null default now(),
     type text not null,
     text text not null,
     primary key (job, seq))`);

/** which SCHEMA a database was last brought up to: kept as the comment on acs_projects */
export const SCHEMA_FINGERPRINT = "acs-schema " + createHash("sha256").update(SCHEMA.join("\n")).digest("hex").slice(0, 32);

/**
 * A cold start asks once whether the database already has this exact SCHEMA (one statement that can't fail) and only
 * runs the DDL when it doesn't: some of it (alter table, create or replace trigger) takes strong table locks, and each
 * statement is a round trip. force (npm run db:migrate) runs it all anyway, e.g. to repair a database changed by hand.
 */
export async function ensureSchema(force = false): Promise<void> {
  if (!ready || force) {
    ready = (async () => {
      const [cur] = await db()<{ v: string | null }>("select obj_description(to_regclass('acs_projects'), 'pg_class') as v");
      if (cur?.v === SCHEMA_FINGERPRINT && !force) return;
      for (const s of SCHEMA) await db()(s);
      await db()(`comment on table acs_projects is '${SCHEMA_FINGERPRINT}'`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** One request-scoped connection; nested storage calls share the transaction. */
export async function transaction<T>(owner: string, work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work();
  await ensureSchema();
  const run = async (q: Query) => context.run(q, async () => {
    await q("select pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
    return work();
  });
  if (transact) {
    const pending: {key:string;owner:string}[] = [];
    try { return await intents.run(pending, () => transact!(run)); }
    finally { for (const i of pending) await query!("insert into acs_object_gc(object_key,owner) values($1,$2) on conflict do nothing", [i.key,i.owner]); }
  }
  neonConfig.webSocketConstructor = WebSocket;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await run((async (text: string, params: unknown[] = []) => (await client!.query(text, params)).rows) as Query);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client?.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
