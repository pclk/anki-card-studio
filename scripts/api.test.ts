/**
 * API tests: the real handler and storage code against PGlite (Postgres in WASM), no network needed.
 *   npm test
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { setDb } from "../lib/db";
import { handleApi } from "../lib/api";
import { isPublicAddress, htmlToText, fetchReadable } from "../lib/fetch-readable";
import type { User } from "../lib/user";

const A: User = { owner: "gh:1", login: "alice" };
const B: User = { owner: "gh:2", login: "bob" };

before(async () => {
  const pg = new PGlite();
  setDb((async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows) as never);
});

function call(user: User | null, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  const url = new URL("http://studio.test/api/" + path);
  const req = new Request(url, { method, body, headers: { host: "studio.test", ...(method !== "GET" ? { origin: "http://studio.test" } : {}), ...headers } });
  return handleApi(req, url.pathname.replace(/^\/api\//, "").split("/"), user);
}

test("needs a signed-in user", async () => {
  const r = await call(null, "GET", "ping");
  assert.equal(r.status, 401);
});

test("ping says hosted", async () => {
  const j = await (await call(A, "GET", "ping")).json();
  assert.equal(j.ok, true);
  assert.equal(j.hosted, true);
  assert.equal(j.user.login, "alice");
});

test("refuses cross-site writes", async () => {
  const r = await call(A, "PUT", "settings", "{}", { origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("settings round trip, per user", async () => {
  assert.equal(await (await call(A, "GET", "settings")).text(), "null");
  await call(A, "PUT", "settings", JSON.stringify({ version: 2, keys: { approve: ["d"] } }));
  assert.deepEqual((await (await call(A, "GET", "settings")).json()).keys.approve, ["d"]);
  assert.equal(await (await call(B, "GET", "settings")).text(), "null");
  assert.equal((await call(A, "PUT", "settings", "{not json")).status, 400);
});

test("project list merges by id, newest wins, deleted never return", async () => {
  assert.equal(await (await call(A, "GET", "projects")).text(), "null");
  let r = await (await call(A, "PUT", "projects", JSON.stringify([{ id: "p1", name: "One", updated: 10 }, { id: "p2", name: "Two", updated: 10 }]))).json();
  assert.equal(r.length, 2);
  r = await (await call(A, "PUT", "projects", JSON.stringify([{ id: "p1", name: "Old", updated: 5 }]))).json();
  assert.equal(r.find((e: { id: string }) => e.id === "p1").name, "One");
  r = await (await call(A, "PUT", "projects", JSON.stringify([{ id: "p1", name: "Newer", updated: 20 }]))).json();
  assert.equal(r.find((e: { id: string }) => e.id === "p1").name, "Newer");
  await call(A, "DELETE", "project/p2");
  r = await (await call(A, "PUT", "projects", JSON.stringify([{ id: "p2", name: "Two again", updated: 99 }]))).json();
  assert.ok(!r.some((e: { id: string }) => e.id === "p2"));
  assert.equal(await (await call(B, "GET", "projects")).text(), "null");
});

test("projects: save, rev, optimistic locking", async () => {
  assert.equal((await call(A, "GET", "project/p1")).status, 404);
  let r = await call(A, "PUT", "project/p1", JSON.stringify({ rev: 1, cards: [1] }), { "x-acs-base-rev": "0" });
  assert.equal(r.status, 200);
  assert.equal((await (await call(A, "GET", "project/p1/rev")).json()).rev, 1);
  r = await call(A, "PUT", "project/p1", JSON.stringify({ rev: 2, cards: [1, 2] }), { "x-acs-base-rev": "1" });
  assert.equal(r.status, 200);
  r = await call(A, "PUT", "project/p1", JSON.stringify({ rev: 2, cards: ["stale"] }), { "x-acs-base-rev": "1" });
  assert.equal(r.status, 409);
  const c = await r.json();
  assert.equal(c.error, "conflict");
  assert.equal(c.rev, 2);
  assert.deepEqual((await (await call(A, "GET", "project/p1")).json()).cards, [1, 2]);
  assert.equal((await call(B, "GET", "project/p1")).status, 404, "other users can't see it");
  assert.equal((await call(A, "GET", "project/..%2Fx")).status, 400);
});

test("small files", async () => {
  const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  let r = await call(A, "PUT", "project/p1/media/a.png", png, { "content-type": "image/png" });
  assert.equal(r.status, 200);
  r = await call(A, "GET", "project/p1/media/a.png");
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.deepEqual(await (await call(A, "GET", "project/p1/media")).json(), ["a.png"]);
  assert.equal((await call(B, "GET", "project/p1/media/a.png")).status, 404);
  assert.equal((await call(A, "PUT", "project/p1/media/..%2Fevil", png)).status, 400);
  await call(A, "DELETE", "project/p1/media/a.png");
  assert.equal((await call(A, "GET", "project/p1/media/a.png")).status, 404);
});

test("large files travel in pieces", async () => {
  const big = Buffer.alloc(7 * 1024 * 1024 + 123);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  const size = 3 * 1024 * 1024, n = Math.ceil(big.length / size);
  for (let i = 0; i < n; i++) {
    const r = await call(A, "PUT", `project/p1/sources/s1.pdf?chunk=${i}&chunks=${n}`, big.subarray(i * size, (i + 1) * size), { "content-type": "application/pdf" });
    assert.equal(r.status, 200);
    if (i < n - 1) assert.equal((await call(A, "GET", "project/p1/sources/s1.pdf")).status, 404, "not readable until complete");
  }
  const r = await call(A, "GET", "project/p1/sources/s1.pdf");
  assert.equal(r.headers.get("x-acs-chunked"), "1");
  const meta = await r.json();
  assert.equal(meta.chunks, n);
  assert.equal(meta.size, big.length);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(Buffer.from(await (await call(A, "GET", `project/p1/sources/s1.pdf?chunk=${i}`)).arrayBuffer()));
  assert.ok(Buffer.concat(parts).equals(big));
  // re-uploading replaces it
  await call(A, "PUT", "project/p1/sources/s1.pdf?chunk=0&chunks=1", Buffer.from("small"), { "content-type": "application/pdf" });
  assert.equal(await (await call(A, "GET", "project/p1/sources/s1.pdf")).text(), "small");
  assert.equal((await call(A, "PUT", "project/p1/sources/x.pdf?chunk=1&chunks=2", Buffer.from("x"))).status, 409, "piece 0 first");
});

test("deleting a project removes its files", async () => {
  await call(A, "PUT", "project/p9", JSON.stringify({ rev: 1 }));
  await call(A, "PUT", "project/p9/media/x.png", Buffer.from("x"), { "content-type": "image/png" });
  await call(A, "DELETE", "project/p9");
  assert.equal((await call(A, "GET", "project/p9")).status, 404);
  assert.equal((await call(A, "GET", "project/p9/media/x.png")).status, 404);
});

test("web import refuses private addresses", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0", "100.64.0.1"])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://localhost:3000/", "file:///etc/passwd", "http://example.com:8080/", "http://[::1]/", "http://user:pw@example.com/"]) {
    await assert.rejects(fetchReadable(u), (e: { status?: number }) => e.status === 400, u);
  }
  const r = await call(A, "GET", "fetch?url=" + encodeURIComponent("http://169.254.169.254/"));
  assert.equal(r.status, 400);
});

test("readable text keeps structure and drops page chrome", () => {
  const { title, text } = htmlToText(
    `<html><head><title>Generics &amp; you</title><script>x()</script></head><body><nav>menu</nav>
     <h2>Invariance</h2><p>List&lt;Integer&gt; is not a List&lt;Object&gt;.</p><ul><li>one</li><li>two</li></ul>
     <pre>int  x = 1;</pre><footer>foot</footer></body></html>`,
  );
  assert.equal(title, "Generics & you");
  assert.match(text, /## Invariance/);
  assert.match(text, /List<Integer> is not a List<Object>\./);
  assert.match(text, /- one\n+- two/);
  assert.doesNotMatch(text, /Generics/);
  assert.match(text, /int {2}x = 1;/);
  assert.doesNotMatch(text, /menu|foot|x\(\)/);
});

test("an explicit import brings back a deleted project", async () => {
  await call(A, "PUT", "project/pz", JSON.stringify({ rev: 1 }));
  await call(A, "PUT", "projects", JSON.stringify([{ id: "pz", name: "Z", updated: 1 }]));
  await call(A, "DELETE", "project/pz");
  // an ordinary save of a deleted id (e.g. from a stale device) stays hidden from the list
  await call(A, "PUT", "project/pz", JSON.stringify({ rev: 2 }));
  let r = await (await call(A, "PUT", "projects", JSON.stringify([{ id: "pz", name: "Z", updated: 5 }]))).json();
  assert.ok(!r.some((e: { id: string }) => e.id === "pz"));
  // an import says so, and the project comes back
  await call(A, "PUT", "project/pz", JSON.stringify({ rev: 3 }), { "x-acs-restore": "1" });
  r = await (await call(A, "PUT", "projects", JSON.stringify([{ id: "pz", name: "Z again", updated: 6 }]))).json();
  assert.equal(r.find((e: { id: string }) => e.id === "pz").name, "Z again");
});

test("only the admin manages who can sign in", async () => {
  const ADMIN: User = { owner: "gh:9", login: "pclk", admin: true };
  assert.equal((await call(A, "GET", "people")).status, 403);
  assert.equal((await call(A, "POST", "people", JSON.stringify({ login: "eve" }))).status, 403);
  let j = await (await call(ADMIN, "GET", "people")).json();
  assert.deepEqual(j.admins, ["pclk"]);
  j = await (await call(ADMIN, "POST", "people", JSON.stringify({ login: "@Friend-1" }))).json();
  assert.deepEqual(j.added.map((x: { login: string }) => x.login), ["friend-1"]);
  const { allowedLogins } = await import("../lib/allow");
  assert.ok((await allowedLogins(true)).includes("friend-1"));
  assert.equal((await call(ADMIN, "POST", "people", JSON.stringify({ login: "bad name!" }))).status, 400);
  assert.equal((await call(ADMIN, "DELETE", "people/pclk")).status, 400, "admin can't remove themself");
  j = await (await call(ADMIN, "DELETE", "people/friend-1")).json();
  assert.equal(j.added.length, 0);
  assert.ok(!(await allowedLogins(true)).includes("friend-1"));
});
