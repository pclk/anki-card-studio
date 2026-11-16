/**
 * Independent review regression suite for durable object lifecycle & GC:
 *  1. Reproduces GC snapshot-outside-lock TOCTOU race where concurrent retirement
 *     (overwrite, delete, rollback) postpones eligible_at via trigger, yet collectObjects()
 *     skips rechecking eligible_at under the owner advisory lock and deletes immediately
 *     with zero grace period (breaking unlocked concurrent GETs and rollback safety).
 *  2. Reproduces overlapping collectObjects() race where staged-upload expiration loses
 *     its documented 7-day post-expiration grace and already-collected keys receive
 *     duplicate remote DELETEs.
 *  3. Reproduces documented `ACS_OBJECT_STORAGE=off` test-runner regression where
 *     `ACS_OBJECT_STORAGE=off` overrides setObjectStore() mocks in object-lifecycle.test.ts.
 *  4. Verifies production autocommit objectIntent (transact === null), real loopback S3
 *     DELETE + ACS_OBJECT_STORAGE=off read/rollback/GC behavior, preflight checkQuota
 *     before S3 PUT/intent, admin missing-chunk/size-mismatch 500s, and collect-objects CLI.
 *
 * Strictly isolated: uses in-memory PGlite and 127.0.0.1 loopback HTTP only; never reads .env.local.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { setDb, db, ensureSchema, objectIntent, type Query } from "../lib/db";
import { setObjectStore, objectKey, readObject, digest } from "../lib/object-storage";
import { writeChunk, readChunk } from "../lib/store";
import { migrateChunk } from "../lib/storage-migration";
import { collectObjects } from "../lib/object-gc";
import { handleApi } from "../lib/api";
import { applyRegistry, forgetUser } from "../lib/users";
import type { User } from "../lib/user";

const ENV_KEYS = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "ACS_OBJECT_STORAGE",
  "DATABASE_URL",
  "POSTGRES_URL",
  "ACS_PGLITE_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);

before(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

after(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setDb(null);
  setObjectStore(undefined);
  forgetUser();
});

function bindPGlite(
  pg: PGlite,
  onOuterQuery?: (sql: string, params: unknown[]) => Promise<void> | void,
) {
  const outer: Query = (async (sql: string, params: unknown[] = []) => {
    const { rows } = await pg.query(sql, params);
    await onOuterQuery?.(sql, params);
    return rows;
  }) as Query;
  setDb(
    outer,
    async (work) =>
      pg.transaction(async (tx) =>
        work((async (sql: string, params: unknown[] = []) => (await tx.query(sql, params)).rows) as Query),
      ),
  );
}

test("BUG REPRO: collectObjects must recheck eligible_at under owner lock after concurrent retirement postpones grace", async () => {
  const pg = new PGlite();
  const objects = new Map<string, Buffer>();
  let hookArmed = false;
  let hookFired = false;

  bindPGlite(pg, async (sql) => {
    if (hookArmed && sql.includes("from acs_object_gc where eligible_at <= now()")) {
      hookArmed = false;
      hookFired = true;
      // Concurrent writer replaces the >7-day-old live file AFTER collectObjects snapshotted
      // acs_object_gc, but BEFORE collectObjects acquires transaction(owner).
      // The acs_object_retirement trigger postpones v1's eligible_at to now() + 7 days.
      await writeChunk("gh:race", "deck", "media", "fig.png", "image/png", 0, 1, Buffer.from("v2-bytes"));
    }
  });

  setObjectStore({
    async put(k, b) {
      objects.set(k, Buffer.from(b));
    },
    async get(k) {
      const found = objects.get(k);
      if (!found) throw new Error("Object download failed");
      return Buffer.from(found);
    },
    async delete(k) {
      objects.delete(k);
    },
  });

  try {
    await ensureSchema();
    const v1Bytes = Buffer.from("v1-live-for-8-days");
    await writeChunk("gh:race", "deck", "media", "fig.png", "image/png", 0, 1, v1Bytes);

    // Capture v1 metadata as seen by an unlocked in-flight GET reader right before replacement
    const [v1Chunk] = await db()<{ object_key: string; sha256: string; byte_size: number }>(
      "select object_key, sha256, byte_size from acs_chunks where owner = 'gh:race'",
    );
    assert.ok(v1Chunk?.object_key);

    // Simulate 8 days elapsed since initial upload: v1 is STILL live in acs_chunks,
    // and its initial objectIntent row in acs_object_gc is now due (eligible_at <= now()).
    await db()("update acs_object_gc set eligible_at = now() - interval '1 day' where object_key = $1", [
      v1Chunk.object_key,
    ]);

    hookArmed = true;
    const deletedCount = await collectObjects(100);
    assert.equal(hookFired, true, "interception hook must fire right after unlocked GC snapshot");

    // Verify retirement trigger DID set eligible_at ~7 days in the future before GC locked owner
    const [gcRow] = await db()<{ future: boolean }>(
      "select eligible_at > now() + interval '6 days' as future from acs_object_gc where object_key = $1",
      [v1Chunk.object_key],
    );
    assert.equal(gcRow.future, true);

    // v1 was JUST retired milliseconds ago (eligible_at = now() + 7 days); GC must NOT delete it!
    assert.equal(deletedCount, 0, "freshly retired object with future eligible_at must not be collected");
    assert.equal(
      objects.has(v1Chunk.object_key),
      true,
      "v1 object must remain in bucket for its 7-day grace period",
    );

    // An unlocked concurrent GET reader holding v1Chunk metadata must still succeed without 500
    const concurrentRead = await readObject(
      v1Chunk.object_key,
      v1Chunk.sha256,
      Number(v1Chunk.byte_size),
      "gh:race",
      "deck",
      "media",
      "fig.png",
    );
    assert.deepEqual(concurrentRead, v1Bytes);
  } finally {
    setDb(null);
    setObjectStore(undefined);
    await pg.close();
  }
});

test("BUG REPRO: overlapping collectObjects runs must preserve 7-day post-expiration grace on staged uploads and avoid duplicate DELETEs", async () => {
  const pg = new PGlite();
  const objects = new Map<string, Buffer>();
  const deleteCounts = new Map<string, number>();
  let interceptSecondWorker = false;

  bindPGlite(pg, async (sql) => {
    if (interceptSecondWorker && sql.includes("from acs_object_gc where eligible_at <= now()")) {
      interceptSecondWorker = false;
      // Session crosses the 7-day idle threshold as Worker A runs:
      // Worker A expires acs_upload_files/acs_upload_chunks (trigger sets chunk-0 eligible_at = now() + 7 days)
      // and collects orphanKey once (setting orphanKey eligible_at = now() + 7 days).
      await db()("update acs_upload_files set updated = now() - interval '8 days' where owner = 'gh:overlap'");
      await collectObjects(100);
    }
  });

  setObjectStore({
    async put(k, b) {
      objects.set(k, Buffer.from(b));
    },
    async get(k) {
      const found = objects.get(k);
      if (!found) throw new Error("Object download failed");
      return Buffer.from(found);
    },
    async delete(k) {
      deleteCounts.set(k, (deleteCounts.get(k) ?? 0) + 1);
      objects.delete(k);
    },
  });

  try {
    await ensureSchema();
    // 1. Multi-chunk staged upload: chunk 0 uploaded 8d ago (intent eligible_at <= now()),
    //    chunk 1 uploaded just under 7d ago (so Worker B's initial stale scan skips it, then Worker A expires it).
    await writeChunk("gh:overlap", "p", "sources", "draft.pdf", "application/pdf", 0, 3, Buffer.from("part0"), "s-abandoned");
    const [staged0] = await db()<{ object_key: string }>(
      "select object_key from acs_upload_chunks where owner = 'gh:overlap' and idx = 0",
    );
    await writeChunk("gh:overlap", "p", "sources", "draft.pdf", "application/pdf", 1, 3, Buffer.from("part1"), "s-abandoned");
    await db()("update acs_upload_files set updated = now() - interval '6 days 23 hours' where owner = 'gh:overlap'");
    await db()("update acs_object_gc set eligible_at = now() - interval '1 day' where object_key = $1", [
      staged0.object_key,
    ]);

    // 2. Already-unreferenced due orphan key
    const orphanKey = objectKey("gh:overlap", "p", "media", "orphan.bin");
    objects.set(orphanKey, Buffer.from("orphan"));
    await db()(
      "insert into acs_object_gc(object_key, owner, eligible_at) values ($1, 'gh:overlap', now() - interval '1 day')",
      [orphanKey],
    );

    interceptSecondWorker = true;
    const workerBDeleted = await collectObjects(100);

    // Staged upload was JUST expired by Worker A; per docs/OBJECT-STORAGE.md it must get another 7-day grace!
    assert.equal(
      objects.has(staged0.object_key),
      true,
      "newly expired staged upload object must retain its 7-day post-expiration grace",
    );
    // orphanKey was already deleted by Worker A and bumped +7 days; Worker B must not delete it a second time
    assert.equal(deleteCounts.get(orphanKey), 1, "overlapping GC workers must not issue duplicate remote DELETEs");
    assert.equal(workerBDeleted, 0);
  } finally {
    setDb(null);
    setObjectStore(undefined);
    await pg.close();
  }
});

test("BUG REPRO: documented `ACS_OBJECT_STORAGE=off` test command must not break mock-backed object-lifecycle.test.ts", () => {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "scripts/object-lifecycle.test.ts"],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        ACS_OBJECT_STORAGE: "off",
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(
    res.status,
    0,
    `ACS_OBJECT_STORAGE=off broke scripts/object-lifecycle.test.ts:\n${res.stdout}\n${res.stderr}`,
  );
});

test("production autocommit objectIntent path (transact === null), loopback S3 DELETE + ACS_OBJECT_STORAGE=off lifecycle, quota preflight, admin chunk errors, and collect-objects CLI", async () => {
  const pg = new PGlite();
  try {
    // 1. Exercise production objectIntent path (transact === null -> context.exit(() => db()(...)))
    const rawQuery: Query = (async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows) as Query;
    setDb(rawQuery, null);
    await ensureSchema();

    const prodKey = objectKey("gh:prod-intent", "p", "media", "a.png");
    await objectIntent(prodKey, "gh:prod-intent");
    await objectIntent(prodKey, "gh:prod-intent"); // idempotent on conflict do nothing
    const enrolled = await db()<{ object_key: string; owner: string }>(
      "select object_key, owner from acs_object_gc where object_key = $1",
      [prodKey],
    );
    assert.equal(enrolled.length, 1);
    assert.equal(enrolled[0].owner, "gh:prod-intent");

    // Verify objectIntent fails closed if DB autocommit fails (preventing untracked PUT)
    setDb((async () => {
      throw new Error("neon http unavailable");
    }) as Query, null);
    await assert.rejects(
      objectIntent(objectKey("gh:prod-intent", "p", "media", "b.png"), "gh:prod-intent"),
      /neon http unavailable/,
    );

    // 2. Real loopback HTTP S3 server verifying DELETE wire protocol + ACS_OBJECT_STORAGE=off read/rollback/GC
    bindPGlite(pg);
    setObjectStore(undefined);
    const s3 = new Map<string, Buffer>();
    const methods: string[] = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      methods.push(`${req.method} ${u.pathname}`);
      if (!u.pathname.startsWith("/uploads/")) {
        res.writeHead(404).end();
        return;
      }
      const key = decodeURIComponent(u.pathname.slice("/uploads/".length));
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
          const buf = Buffer.concat(chunks);
          s3.set(key, buf);
          res.writeHead(200, { ETag: `"${digest(buf)}"` }).end();
        });
        return;
      }
      if (req.method === "GET") {
        const found = s3.get(key);
        if (!found) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-length": String(found.length) }).end(found);
        return;
      }
      if (req.method === "DELETE") {
        s3.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${port}`;
      process.env.AWS_REGION = "us-east-1";
      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
      process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      delete process.env.ACS_OBJECT_STORAGE;

      await writeChunk("gh:s3gc", "p", "media", "obj.bin", "application/octet-stream", 0, 1, Buffer.from("in-s3"));
      assert.equal(s3.size, 1);

      // Flip ACS_OBJECT_STORAGE=off: new writes go to Postgres bytea, while S3 reads, rollback, and GC still work!
      process.env.ACS_OBJECT_STORAGE = "off";
      await writeChunk("gh:s3gc", "p", "media", "pg.bin", "application/octet-stream", 0, 1, Buffer.from("in-pg"));
      assert.equal(s3.size, 1, "ACS_OBJECT_STORAGE=off must not upload new objects");
      assert.deepEqual(await readChunk("gh:s3gc", "p", "media", "obj.bin", 0), Buffer.from("in-s3"));
      assert.deepEqual(await readChunk("gh:s3gc", "p", "media", "pg.bin", 0), Buffer.from("in-pg"));

      // Rollback obj.bin to bytea while ACS_OBJECT_STORAGE=off, then age GC queue and collect via real HTTP DELETE
      assert.equal(await migrateChunk("gh:s3gc", true), 5);
      await db()("update acs_object_gc set eligible_at = now() - interval '1 minute' where owner = 'gh:s3gc'");
      assert.equal(await collectObjects(10), 1);
      assert.equal(s3.size, 0);
      assert.ok(methods.some((m) => m.startsWith("DELETE /uploads/acs/v1/")));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const k of ENV_KEYS) delete process.env[k];
    }

    // 3. Preflight checkQuota rejects before any objectIntent or S3 PUT
    let putAttempts = 0;
    setObjectStore({
      async put() {
        putAttempts++;
      },
      async get() {
        return Buffer.alloc(0);
      },
      async delete() {},
    });
    const qUser = (await applyRegistry({ owner: "gh:q-pre", login: "q-pre" }, null, []))!;
    await db()("update acs_users set quota_mb = 1 where owner = 'gh:q-pre'");
    forgetUser("gh:q-pre");

    const beforeGcCount = (await db()("select 1 from acs_object_gc where owner = 'gh:q-pre'")).length;
    await assert.rejects(
      writeChunk("gh:q-pre", "p", "media", "too-big.bin", "application/octet-stream", 0, 1, Buffer.alloc(1_200_000, 1)),
      /storage limit reached/,
    );
    await assert.rejects(
      writeChunk("gh:q-pre", "p", "sources", "staged-big.pdf", "application/pdf", 0, 2, Buffer.alloc(1_200_000, 2), "u-over"),
      /storage limit reached/,
    );
    const afterGcCount = (await db()("select 1 from acs_object_gc where owner = 'gh:q-pre'")).length;
    assert.equal(putAttempts, 0, "quota-rejected writes must never call storage.put");
    assert.equal(afterGcCount, beforeGcCount, "quota-rejected writes must never enroll acs_object_gc intents");
    assert.ok(qUser);

    // 4. Admin file download returns 500 (not 200 partial bytes) on missing chunk or size mismatch
    const admin: User = (await applyRegistry({ owner: "gh:adm-chk", login: "adm-chk" }, null, ["adm-chk"]))!;
    const target: User = (await applyRegistry({ owner: "gh:usr-chk", login: "usr-chk" }, null, []))!;
    setObjectStore(null);
    await writeChunk(target.owner, "p", "sources", "doc.pdf", "application/pdf", 0, 2, Buffer.from("AAAA"), "u-doc");
    await writeChunk(target.owner, "p", "sources", "doc.pdf", "application/pdf", 1, 2, Buffer.from("BBBB"), "u-doc");

    const adminGet = () => {
      const url = new URL(`https://studio.test/api/admin/users/${target.owner}/project/p/files/sources/doc.pdf`);
      return handleApi(new Request(url, { method: "GET", headers: { host: "studio.test" } }), url.pathname.slice(5).split("/"), admin);
    };
    assert.equal((await adminGet()).status, 200);

    const origError = console.error;
    try {
      console.error = () => {};
      // Corrupt size first
      await db()("update acs_files set size = 999 where owner = $1", [target.owner]);
      assert.equal((await adminGet()).status, 500, "size mismatch must fail closed with 500");
      await db()("update acs_files set size = 8 where owner = $1", [target.owner]);

      // Delete chunk 1 row to simulate missing chunk
      await db()("delete from acs_chunks where owner = $1 and idx = 1", [target.owner]);
      assert.equal((await adminGet()).status, 500, "missing chunk must fail closed with 500");
    } finally {
      console.error = origError;
    }

    // 5. collect-objects.ts CLI argument & ACS_GC_LIMIT validation without reading .env.local
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
    };
    const withArg = spawnSync(process.execPath, ["--import", "tsx", "scripts/collect-objects.ts", "--extra"], {
      cwd: process.cwd(),
      env: cleanEnv,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(withArg.status, 0);
    assert.match(withArg.stderr, /No arguments supported/);

    for (const badLimit of ["0", "-1", "1001", "1.5", "nan"]) {
      const bad = spawnSync(process.execPath, ["--import", "tsx", "scripts/collect-objects.ts"], {
        cwd: process.cwd(),
        env: { ...cleanEnv, ACS_GC_LIMIT: badLimit },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.notEqual(bad.status, 0, `ACS_GC_LIMIT=${badLimit} must fail`);
      assert.match(bad.stderr, /Invalid GC limit/);
    }
  } finally {
    setDb(null);
    setObjectStore(undefined);
    await pg.close();
  }
});
