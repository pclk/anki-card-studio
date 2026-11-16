/**
 * Postgres access. Production uses Neon's HTTP driver (one round trip per statement, no connection pool to manage
 * inside serverless functions). Tests swap in PGlite (Postgres compiled to WASM) through setDb().
 */
import { neon } from "@neondatabase/serverless";

export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

let query: Query | null = null;
let ready: Promise<void> | null = null;

export function setDb(q: Query | null): void {
  query = q;
  ready = null;
}

export function db(): Query {
  if (!query) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    // local development without Neon: a Postgres kept in a folder (PGlite). Never used on Vercel.
    if (!url && process.env.ACS_PGLITE_DIR && !process.env.VERCEL) {
      const dir = process.env.ACS_PGLITE_DIR;
      const pg = import("@electric-sql/pglite").then(({ PGlite }) => new PGlite(dir));
      query = (async (text: string, params: unknown[] = []) => (await (await pg).query(text, params)).rows) as Query;
      return query;
    }
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = neon(url);
    query = (async (text: string, params: unknown[] = []) => (await sql.query(text, params)) as never) as Query;
  }
  return query;
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

export async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const s of SCHEMA) await db()(s);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
