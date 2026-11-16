/**
 * Independent review regression suite for Neon Object Storage migration:
 * exercises full HTTP API routes (handleApi + admin routes), cross-owner & cross-scope
 * authorization, staged upload retry/supersession, quota & remote-failure SQL rollback,
 * mixed legacy/object multi-chunk files, real objectStore() + files-sdk/neon HTTP path-style
 * S3 protocol against a local loopback server, retry egress bounds, and CLI validation.
 *
 * Uses only in-memory PGlite and local loopback mocks — never loads .env.local or live services.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { setDb, db, ensureSchema, type Query } from "../lib/db";
import {
  setObjectStore,
  objectStore,
  objectPrefix,
  objectKey,
  readObject,
  digest,
} from "../lib/object-storage";
import { handleApi } from "../lib/api";
import { applyRegistry, forgetUser, usage } from "../lib/users";
import { migrateChunk } from "../lib/storage-migration";
import type { User } from "../lib/user";

const AWS_VARS = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const k of [...AWS_VARS, "ACS_OBJECT_STORAGE", "DATABASE_URL", "POSTGRES_URL"]) {
  savedEnv.set(k, process.env[k]);
}

const pg = new PGlite();
const bucket = new Map<string, Buffer>();
let putCalls = 0;
let getCalls = 0;
let failPut = false;
let failGet = false;
let queryResultsBytes = 0;

function resetCounters() {
  putCalls = 0;
  getCalls = 0;
  failPut = false;
  failGet = false;
  queryResultsBytes = 0;
}

function installMockStore() {
  setObjectStore({
    async put(key, bytes) {
      putCalls++;
      if (failPut) throw new Error("Object upload failed");
      bucket.set(key, Buffer.from(bytes));
    },
    async get(key) {
      getCalls++;
      if (failGet) throw new Error("Object download failed");
      const found = bucket.get(key);
      if (!found) throw new Error("Object download failed");
      return Buffer.from(found);
    },
  });
}

before(async () => {
  const wrap = (exec: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>): Query =>
    (async (sql: string, params: unknown[] = []) => {
      const { rows } = await exec(sql, params);
      queryResultsBytes += Buffer.byteLength(JSON.stringify(rows));
      return rows;
    }) as Query;

  setDb(
    wrap((sql, params) => pg.query(sql, params)),
    async (work) => pg.transaction(async (tx) => work(wrap((sql, params) => tx.query(sql, params)))),
  );
  installMockStore();
  await ensureSchema();
});

after(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setDb(null);
  setObjectStore(undefined);
  forgetUser();
  await pg.close();
});

function apiCall(
  who: User | null,
  method: string,
  path: string,
  body?: BodyInit | Buffer,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL("https://studio.test/api/" + path);
  const req = new Request(url, {
    method,
    body: body as BodyInit | undefined,
    headers: {
      host: "studio.test",
      ...(method !== "GET" && method !== "HEAD" ? { origin: "https://studio.test" } : {}),
      ...headers,
    },
  });
  return handleApi(req, url.pathname.replace(/^\/api\//, "").split("/"), who);
}

async function registerUser(owner: string, login: string, quotaMb: number | null = null, envAdmins: string[] = []): Promise<User> {
  const u = (await applyRegistry({ owner, login }, null, envAdmins))!;
  if (quotaMb !== null) {
    await db()("update acs_users set quota_mb = $2 where owner = $1", [owner, quotaMb]);
    forgetUser(owner);
  }
  return (await applyRegistry({ owner, login }, null, envAdmins))!;
}

test("API single-chunk, zero-byte, multi-chunk, ETag 304 without S3 download, and deletion", async () => {
  installMockStore();
  resetCounters();
  const alice = await registerUser("gh:rev-alice", "rev-alice");

  // Single-chunk binary upload & conditional ETag read (304 must not hit object store)
  const img = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  assert.equal((await apiCall(alice, "PUT", "project/deck1/media/card.png", img, { "content-type": "image/png" })).status, 200);
  assert.equal(putCalls, 1);

  const get1 = await apiCall(alice, "GET", "project/deck1/media/card.png");
  assert.equal(get1.status, 200);
  assert.equal(get1.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await get1.arrayBuffer()), img);
  assert.equal(getCalls, 1);

  const etag = get1.headers.get("etag")!;
  assert.ok(etag);
  const get304 = await apiCall(alice, "GET", "project/deck1/media/card.png", undefined, { "if-none-match": etag });
  assert.equal(get304.status, 304);
  assert.equal(getCalls, 1, "304 Not Modified must not download object bytes");

  // Zero-byte object upload, read, rollback, and legacy read
  const empty = Buffer.alloc(0);
  assert.equal((await apiCall(alice, "PUT", "project/deck1/media/empty.bin", empty)).status, 200);
  const getEmpty = await apiCall(alice, "GET", "project/deck1/media/empty.bin");
  assert.equal(getEmpty.status, 200);
  assert.equal((await getEmpty.arrayBuffer()).byteLength, 0);

  // Multi-chunk upload & manifest read (manifest GET must not download chunks)
  const parts = [Buffer.from("chunk-zero-payload"), Buffer.from("chunk-one-payload"), Buffer.from("chunk-two")];
  for (let i = 0; i < parts.length; i++) {
    const res = await apiCall(alice, "PUT", `project/deck1/sources/slides.pdf?chunk=${i}&chunks=3&upload=u-slides`, parts[i], {
      "content-type": "application/pdf",
    });
    assert.equal(res.status, 200);
  }
  const beforeManifestGets = getCalls;
  const manifestRes = await apiCall(alice, "GET", "project/deck1/sources/slides.pdf");
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.headers.get("x-acs-chunked"), "1");
  assert.equal(getCalls, beforeManifestGets, "chunked manifest GET must not fetch S3 objects");
  const manifest = await manifestRes.json();
  assert.equal(manifest.chunks, 3);
  assert.equal(manifest.size, Buffer.concat(parts).length);

  const downloaded: Buffer[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await apiCall(alice, "GET", `project/deck1/sources/slides.pdf?chunk=${i}`);
    assert.equal(r.status, 200);
    downloaded.push(Buffer.from(await r.arrayBuffer()));
  }
  assert.deepEqual(Buffer.concat(downloaded), Buffer.concat(parts));

  // Deleting file and project removes metadata and makes chunks 404 via API
  assert.equal((await apiCall(alice, "DELETE", "project/deck1/media/card.png")).status, 200);
  assert.equal((await apiCall(alice, "GET", "project/deck1/media/card.png")).status, 404);
  assert.equal((await apiCall(alice, "DELETE", "project/deck1")).status, 200);
  assert.equal((await apiCall(alice, "GET", "project/deck1/sources/slides.pdf")).status, 404);
  assert.equal((await usage(alice.owner)).fileBytes, 0);
});

test("cross-owner and cross-scope isolation in API routes and readObject verification", async () => {
  installMockStore();
  resetCounters();
  const ownerA = await registerUser("gh:iso-a", "iso-a");
  const ownerB = await registerUser("gh:iso-b", "iso-b");

  const secretA = Buffer.from("owner-a-confidential-diagram");
  assert.equal((await apiCall(ownerA, "PUT", "project/sharedname/media/fig.png", secretA, { "content-type": "image/png" })).status, 200);
  const etagA = (await apiCall(ownerA, "GET", "project/sharedname/media/fig.png")).headers.get("etag")!;

  // Owner B cannot read, ETag-probe, list, delete, or admin-fetch Owner A's object-backed file
  assert.equal((await apiCall(ownerB, "GET", "project/sharedname/media/fig.png")).status, 404);
  assert.equal((await apiCall(ownerB, "GET", "project/sharedname/media/fig.png?chunk=0")).status, 404);
  assert.equal((await apiCall(ownerB, "GET", "project/sharedname/media/fig.png", undefined, { "if-none-match": etagA })).status, 404);
  assert.deepEqual(await (await apiCall(ownerB, "GET", "project/sharedname/media")).json(), []);
  assert.equal((await apiCall(ownerB, "DELETE", "project/sharedname/media/fig.png")).status, 200);
  assert.equal((await apiCall(ownerB, "GET", `admin/users/${ownerA.owner}/project/sharedname/files/media/fig.png`)).status, 403);

  // Owner A's file is completely untouched after Owner B's DELETE and same-path PUT
  assert.equal((await apiCall(ownerB, "PUT", "project/sharedname/media/fig.png", Buffer.from("owner-b-own-file"))).status, 200);
  assert.deepEqual(Buffer.from(await (await apiCall(ownerA, "GET", "project/sharedname/media/fig.png")).arrayBuffer()), secretA);

  // Prefix delimiter-collision resistance across tuple boundaries
  assert.notEqual(
    objectPrefix("gh:a", "p_media", "media", "x.png"),
    objectPrefix("gh:a_p", "media", "media", "x.png"),
  );
  assert.notEqual(
    objectPrefix("gh:a", "p", "media", "sources"),
    objectPrefix("gh:a", "p", "sources", "media"),
  );

  // Scope mismatch fails closed BEFORE calling store.get()
  const [rowA] = await db()<{ object_key: string; sha256: string; byte_size: string }>(
    "select object_key, sha256, byte_size from acs_chunks where owner = $1 and project = 'sharedname' and kind = 'media' and name = 'fig.png'",
    [ownerA.owner],
  );
  resetCounters();
  for (const badScope of [
    [ownerB.owner, "sharedname", "media", "fig.png"],
    [ownerA.owner, "otherproj", "media", "fig.png"],
    [ownerA.owner, "sharedname", "sources", "fig.png"],
    [ownerA.owner, "sharedname", "media", "other.png"],
  ] as const) {
    await assert.rejects(
      readObject(rowA.object_key, rowA.sha256, Number(rowA.byte_size), badScope[0], badScope[1], badScope[2], badScope[3]),
      /Object scope mismatch/,
    );
  }
  assert.equal(getCalls, 0, "scope mismatch must reject before touching object storage");

  // If SQL object_key is tampered to point at Owner A's key on Owner B's row, GET fails closed (500) without S3 read
  await db()(
    "update acs_chunks set object_key = $1, sha256 = $2, byte_size = $3 where owner = $4 and project = 'sharedname'",
    [rowA.object_key, rowA.sha256, Number(rowA.byte_size), ownerB.owner],
  );
  resetCounters();
  const log = console.error;
  try {
    console.error = () => {};
    const res = await apiCall(ownerB, "GET", "project/sharedname/media/fig.png");
    assert.equal(res.status, 500);
    assert.equal(getCalls, 0, "tampered cross-owner object_key must not trigger S3 download");
  } finally {
    console.error = log;
  }

  // Size mismatch in readObject fails closed even if content were truncated
  await assert.rejects(
    readObject(rowA.object_key, rowA.sha256, Number(rowA.byte_size) + 1, ownerA.owner, "sharedname", "media", "fig.png"),
    /Object integrity mismatch/,
  );
});

test("API staged multi-chunk retries, piece-0 re-send, out-of-order staging, and supersession", async () => {
  installMockStore();
  resetCounters();
  const u = await registerUser("gh:stage-u", "stage-u");
  const path = "project/pstage/sources/book.pdf";

  // Seed initial v1 live file
  assert.equal((await apiCall(u, "PUT", path, Buffer.from("live-v1"))).status, 200);

  // Start v2 (3 chunks) out of order: piece 0 then piece 2
  resetCounters();
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=0&chunks=3&upload=v2`, Buffer.from("V2-0"))).status, 200);
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=2&chunks=3&upload=v2`, Buffer.from("V2-2"))).status, 200);
  assert.equal(putCalls, 2);

  // Live GET still serves v1 while v2 is incomplete; usage charges both live (7) and staged (8)
  assert.equal(await (await apiCall(u, "GET", path)).text(), "live-v1");
  assert.equal((await usage(u.owner)).total, 7 + 8);

  // Re-sending piece 0 of same session is idempotent: 0 extra S3 puts and piece 2 stays staged
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=0&chunks=3&upload=v2`, Buffer.from("V2-0"))).status, 200);
  assert.equal(putCalls, 2, "idempotent staged retry must not re-upload to S3");

  // Mutating piece 0 or changing total chunks under same upload session fails with 409 and 0 S3 puts
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=0&chunks=3&upload=v2`, Buffer.from("DIFF"))).status, 409);
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=1&chunks=4&upload=v2`, Buffer.from("V2-1"))).status, 409);
  assert.equal(putCalls, 2);

  // Sending final missing piece 1 promotes v2; retrying piece 1 after promotion is idempotent with 0 extra S3 puts
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=1&chunks=3&upload=v2`, Buffer.from("V2-1"))).status, 200);
  assert.equal(putCalls, 3);
  assert.equal((await usage(u.owner)).total, 12, "promotion drops replaced v1 and staged rows from logical usage");
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=1&chunks=3&upload=v2`, Buffer.from("V2-1"))).status, 200);
  assert.equal(putCalls, 3, "post-promotion retry must not re-upload to S3");

  // Competing sessions: stale session A is superseded by B; A's subsequent piece is rejected before S3 put
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=0&chunks=2&upload=sessA`, Buffer.from("A0"))).status, 200);
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=0&chunks=2&upload=sessB`, Buffer.from("B0"))).status, 200);
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=1&chunks=2&upload=sessB`, Buffer.from("B1"))).status, 200);
  const putsBeforeStale = putCalls;
  assert.equal((await apiCall(u, "PUT", `${path}?chunk=1&chunks=2&upload=sessA`, Buffer.from("A1"))).status, 409);
  assert.equal(putCalls, putsBeforeStale, "superseded session piece>0 must reject before S3 upload");
  assert.equal(await (await apiCall(u, "GET", `${path}?chunk=0`)).text(), "B0");
  assert.equal(await (await apiCall(u, "GET", `${path}?chunk=1`)).text(), "B1");
});

test("API quota enforcement, remote S3 failure rollback, and concurrent quota race serialization", async () => {
  installMockStore();
  resetCounters();
  const admin = await registerUser("gh:q-admin", "q-admin", null, ["q-admin"]);
  const user = await registerUser("gh:q-user", "q-user", 1);

  // Fit 650 KB file inside 1 MB quota
  const base = Buffer.alloc(650_000, 0x41);
  assert.equal((await apiCall(user, "PUT", "project/qp/media/keep.bin", base)).status, 200);

  // Second 650 KB file exceeds 1 MB quota -> 413, SQL rolled back, keep.bin unaffected
  assert.equal((await apiCall(user, "PUT", "project/qp/media/reject.bin", base)).status, 413);
  assert.equal((await apiCall(user, "GET", "project/qp/media/reject.bin")).status, 404);
  assert.equal((await usage(user.owner)).total, 650_000);

  // Replacing keep.bin with a 2-chunk upload whose staged + live bytes exceed 1 MB rolls back on piece 0 (650 KB + 500 KB > 1 MB)
  const piece500k = Buffer.alloc(500_000, 0x42);
  assert.equal((await apiCall(user, "PUT", "project/qp/media/keep.bin?chunk=0&chunks=2&upload=over2", piece500k)).status, 413);
  assert.equal((await db()("select 1 from acs_upload_chunks where owner = $1", [user.owner])).length, 0);
  assert.deepEqual(Buffer.from(await (await apiCall(user, "GET", "project/qp/media/keep.bin")).arrayBuffer()), base);

  // Same-size single-chunk replacement succeeds because promotion removes old 650 KB before post-write checkQuota
  const replaced = Buffer.alloc(650_000, 0x43);
  assert.equal((await apiCall(user, "PUT", "project/qp/media/keep.bin", replaced)).status, 200);
  assert.deepEqual(Buffer.from(await (await apiCall(user, "GET", "project/qp/media/keep.bin")).arrayBuffer()), replaced);
  assert.equal((await usage(user.owner)).total, 650_000);

  // Admin users listing matches exact quota usage for object-backed files
  const listing = await (await apiCall(admin, "GET", "admin/users")).json();
  const listedUser = listing.users.find((x: { owner: string }) => x.owner === user.owner);
  assert.equal(listedUser.bytes, 650_000);

  // Remote S3 upload failure rolls back SQL and keeps previous file intact
  failPut = true;
  const log = console.error;
  try {
    console.error = () => {};
    const res = await apiCall(user, "PUT", "project/qp/media/keep.bin", Buffer.from("should-not-commit"));
    assert.ok(res.status >= 500);
  } finally {
    failPut = false;
    console.error = log;
  }
  assert.deepEqual(Buffer.from(await (await apiCall(user, "GET", "project/qp/media/keep.bin")).arrayBuffer()), replaced);

  // Concurrent uploads against a fresh 1 MB quota user permit exactly one 700 KB file
  const racer = await registerUser("gh:q-racer", "q-racer", 1);
  const statuses = (
    await Promise.all(
      ["r1.bin", "r2.bin"].map((n) => apiCall(racer, "PUT", `project/qp/media/${n}`, Buffer.alloc(700_000, 0x55))),
    )
  )
    .map((r) => r.status)
    .sort();
  assert.deepEqual(statuses, [200, 413]);
  assert.equal((await usage(racer.owner)).total, 700_000);
});

test("mixed legacy/object multi-chunk files, admin full download, multi-owner migration isolation, and verification rollback", async () => {
  const admin = await registerUser("gh:mix-admin", "mix-admin", null, ["mix-admin"]);
  const owner1 = await registerUser("gh:mix-1", "mix-1");
  const owner2 = await registerUser("gh:mix-2", "mix-2");

  // Write 2-chunk file for owner1 and 1-chunk file for owner2 in legacy Postgres-only mode
  setObjectStore(null);
  const c0 = Buffer.from("legacy-part-zero-");
  const c1 = Buffer.from("legacy-part-one!");
  assert.equal((await apiCall(owner1, "PUT", "project/mp/sources/manual.pdf?chunk=0&chunks=2&upload=m1", c0, { "content-type": "application/pdf" })).status, 200);
  assert.equal((await apiCall(owner1, "PUT", "project/mp/sources/manual.pdf?chunk=1&chunks=2&upload=m1", c1, { "content-type": "application/pdf" })).status, 200);
  assert.equal((await apiCall(owner2, "PUT", "project/mp/media/other.png", Buffer.from("owner2-legacy"))).status, 200);

  // Enable object storage and fail verification read on first migration attempt -> DB bytea must remain intact
  installMockStore();
  failGet = true;
  await assert.rejects(migrateChunk(owner1.owner), /Object download failed/);
  failGet = false;
  const [stillLegacy] = await db()<{ has_data: boolean; object_key: string | null }>(
    "select data is not null as has_data, object_key from acs_chunks where owner = $1 and idx = 0",
    [owner1.owner],
  );
  assert.equal(stillLegacy.has_data, true);
  assert.equal(stillLegacy.object_key, null);

  // Migrate ONLY 1 chunk of owner1 -> mixed state (chunk 0 in S3, chunk 1 in Postgres bytea)
  assert.equal(await migrateChunk(owner1.owner), c0.length);
  const rowsMixed = await db()<{ idx: number; has_data: boolean; has_key: boolean }>(
    "select idx, data is not null as has_data, object_key is not null as has_key from acs_chunks where owner = $1 order by idx",
    [owner1.owner],
  );
  assert.deepEqual(rowsMixed, [
    { idx: 0, has_data: false, has_key: true },
    { idx: 1, has_data: true, has_key: false },
  ]);

  // Both user chunked GETs and Admin concatenated file download work across mixed storage
  assert.deepEqual(Buffer.from(await (await apiCall(owner1, "GET", "project/mp/sources/manual.pdf?chunk=0")).arrayBuffer()), c0);
  assert.deepEqual(Buffer.from(await (await apiCall(owner1, "GET", "project/mp/sources/manual.pdf?chunk=1")).arrayBuffer()), c1);
  const adminDl = await apiCall(admin, "GET", `admin/users/${owner1.owner}/project/mp/files/sources/manual.pdf`);
  assert.equal(adminDl.status, 200);
  assert.deepEqual(Buffer.from(await adminDl.arrayBuffer()), Buffer.concat([c0, c1]));

  // Finish migrating owner1; owner2's legacy row must remain untouched
  assert.equal(await migrateChunk(owner1.owner), c1.length);
  assert.equal(await migrateChunk(owner1.owner), null);
  const [owner2Row] = await db()<{ has_data: boolean; object_key: string | null }>(
    "select data is not null as has_data, object_key from acs_chunks where owner = $1",
    [owner2.owner],
  );
  assert.equal(owner2Row.has_data, true);
  assert.equal(owner2Row.object_key, null);

  // Rollback owner1 one chunk at a time, then verify Postgres-only reads work with objectStore disabled
  assert.equal(await migrateChunk(owner1.owner, true), c0.length);
  assert.equal(await migrateChunk(owner1.owner, true), c1.length);
  assert.equal(await migrateChunk(owner1.owner, true), null);
  setObjectStore(null);
  const adminDlAfterRollback = await apiCall(admin, "GET", `admin/users/${owner1.owner}/project/mp/files/sources/manual.pdf`);
  assert.deepEqual(Buffer.from(await adminDlAfterRollback.arrayBuffer()), Buffer.concat([c0, c1]));
  installMockStore();
});

test("pre-migration legacy NULL-sha256 rows and object rows retry via handleApi without Postgres payload egress", async () => {
  installMockStore();
  const u = await registerUser("gh:pre-v3", "pre-v3");
  const payload = Buffer.alloc(512 * 1024, 0x6b); // 512 KiB

  // Simulate a genuine pre-v3 staged row where sha256, byte_size, and object_key are all NULL
  await db()(
    `insert into acs_upload_files (owner, project, kind, name, mime, size, chunks, complete, upload_id)
     values ($1, 'p', 'sources', 'old.pdf', 'application/pdf', $2, 2, false, 'legacy-sess')`,
    [u.owner, payload.length],
  );
  await db()(
    `insert into acs_upload_chunks (owner, project, kind, name, idx, data, object_key, sha256, byte_size)
     values ($1, 'p', 'sources', 'old.pdf', 0, decode($2, 'base64'), null, null, null)`,
    [u.owner, payload.toString("base64")],
  );

  resetCounters();
  const retryOk = await apiCall(u, "PUT", "project/p/sources/old.pdf?chunk=0&chunks=2&upload=legacy-sess", payload);
  assert.equal(retryOk.status, 200);
  assert.ok(queryResultsBytes < 1500, `expected tiny SQL result set on retry, got ${queryResultsBytes} bytes`);
  assert.equal(putCalls, 0);

  const retryConflict = await apiCall(u, "PUT", "project/p/sources/old.pdf?chunk=0&chunks=2&upload=legacy-sess", Buffer.from("tampered"));
  assert.equal(retryConflict.status, 409);
});

test("real objectStore() env handling and files-sdk/neon path-style S3 HTTP protocol via loopback server", async () => {
  setObjectStore(undefined);
  for (const k of AWS_VARS) delete process.env[k];
  delete process.env.ACS_OBJECT_STORAGE;

  // 0 AWS vars -> null (Postgres-only fallback)
  assert.equal(objectStore(), null);

  // Partial AWS vars (1..3 of 4) -> fail closed
  for (const missing of AWS_VARS) {
    for (const k of AWS_VARS) process.env[k] = "test-val";
    delete process.env[missing];
    assert.throws(() => objectStore(), /Incomplete object storage configuration/, `missing ${missing} must throw`);
  }

  // Start an isolated 127.0.0.1 HTTP S3 mock server verifying path-style /uploads/<key> requests
  const s3Objects = new Map<string, Buffer>();
  const seenPaths: string[] = [];
  let forceHttpStatus = 0;

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    seenPaths.push(`${req.method} ${reqUrl.pathname}`);
    if (forceHttpStatus) {
      res.writeHead(forceHttpStatus, { "content-type": "application/xml" });
      res.end(`<Error><Code>InternalError</Code><Message>secret=${process.env.AWS_SECRET_ACCESS_KEY}</Message></Error>`);
      return;
    }
    if (!reqUrl.pathname.startsWith("/uploads/")) {
      res.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(reqUrl.pathname.slice("/uploads/".length));
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        s3Objects.set(key, body);
        res.writeHead(200, { ETag: `"${digest(body)}"` }).end();
      });
      return;
    }
    if (req.method === "GET") {
      const found = s3Objects.get(key);
      if (!found) {
        res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(found.length),
      });
      res.end(found);
      return;
    }
    res.writeHead(405).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  try {
    process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${addr.port}`;
    process.env.AWS_REGION = "us-east-2";
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    delete process.env.ACS_OBJECT_STORAGE;

    const u = await registerUser("gh:s3-http", "s3-http");
    const body = Buffer.from("real-files-sdk-neon-adapter-payload");
    assert.equal((await apiCall(u, "PUT", "project/s3p/media/live.bin", body)).status, 200);
    assert.ok(seenPaths.some((p) => p.startsWith("PUT /uploads/acs/v1/")), `expected path-style PUT, saw ${seenPaths.join(", ")}`);

    const got = await apiCall(u, "GET", "project/s3p/media/live.bin");
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), body);
    assert.ok(seenPaths.some((p) => p.startsWith("GET /uploads/acs/v1/")));

    // Error messages from real adapter never leak secret key or endpoint URL
    const k = objectKey("gh:s3-http", "s3p", "media", "err.bin");
    forceHttpStatus = 500;
    await assert.rejects(
      objectStore()!.put(k, Buffer.from("fail")),
      (err: Error) => err.message === "Object upload failed" && !err.message.includes("EXAMPLE"),
    );
    await assert.rejects(
      objectStore()!.get(k),
      (err: Error) => err.message === "Object download failed" && !err.message.includes("EXAMPLE"),
    );
    forceHttpStatus = 0;

    // ACS_OBJECT_STORAGE=off disables objectStore()
    process.env.ACS_OBJECT_STORAGE = "off";
    assert.equal(objectStore(), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const k of AWS_VARS) delete process.env[k];
    delete process.env.ACS_OBJECT_STORAGE;
    installMockStore();
  }
});

test("migrate-objects CLI fails closed on missing owner or out-of-bounds limit without reading .env.local", async () => {
  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    ACS_OBJECT_STORAGE: "off",
  };

  // Missing ACS_MIGRATE_OWNER fails before touching DB
  const missingOwner = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-objects.ts"], {
    cwd: process.cwd(),
    env: cleanEnv,
    encoding: "utf8",
  });
  assert.notEqual(missingOwner.status, 0);
  assert.match(missingOwner.stderr, /Migration failed/);

  // Invalid ACS_MIGRATE_LIMIT fails closed against isolated PGlite directory
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pgliteDir = mkdtempSync(join(tmpdir(), "acs-mig-cli-"));
  try {
    for (const badLimit of ["0", "-1", "10001", "not-a-number"]) {
      const res = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-objects.ts", "--apply"], {
        cwd: process.cwd(),
        env: { ...cleanEnv, ACS_PGLITE_DIR: pgliteDir, ACS_MIGRATE_OWNER: "gh:cli", ACS_MIGRATE_LIMIT: badLimit },
        encoding: "utf8",
      });
      assert.notEqual(res.status, 0, `bad limit ${badLimit} must fail`);
    }
    const dryRun = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate-objects.ts"], {
      cwd: process.cwd(),
      env: { ...cleanEnv, ACS_PGLITE_DIR: pgliteDir, ACS_MIGRATE_OWNER: "gh:cli" },
      encoding: "utf8",
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /direction:\s*'objects'/);
  } finally {
    rmSync(pgliteDir, { recursive: true, force: true });
  }
});
