/**
 * Upload, list and read back a tiny object using the linked Neon branch.
 * Run manually with: node scripts/neon-storage-smoke.mjs
 * Leaves the verified object in the private uploads bucket for inspection.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Files } from "files-sdk";
import { neon } from "files-sdk/neon";

async function main() {
  // Match Next.js's local-file priority and preserve injected environment vars.
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) loadEnvFile(file);
  }
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"]) {
    assert.ok(process.env[name], `${name} is missing; run neon env pull first`);
  }

  const bucket = "uploads";
  const key = "_smoke/anki-card-studio.txt";
  const expected = "Hello from Anki Card Studio and Neon Object Storage!\n";
  const files = new Files({ adapter: neon({ bucket }), timeout: 30_000, retries: 1 });

  await files.upload(key, expected, { contentType: "text/plain; charset=utf-8" });
  const { items } = await files.list({ prefix: key, limit: 10 });
  assert.ok(items.some((item) => item.key === key), "Uploaded object was absent from the bucket listing");
  const downloaded = await files.download(key);
  const actual = await downloaded.text();
  assert.equal(actual, expected, "Downloaded contents differ from the uploaded text");

  console.log(`Bucket: ${bucket}`);
  console.log(`Listed: ${items.map((item) => `${item.key} (${item.size} bytes)`).join(", ")}`);
  console.log(`Read back: ${actual.trimEnd()}`);
  console.log(`SHA-256: ${createHash("sha256").update(actual).digest("hex")}`);
  console.log("PASS: Files SDK upload, list and exact-content read-back");
}

main().catch((error) => {
  // Avoid emitting SDK errors that could contain signed URLs or credentials.
  console.error(`Neon storage verification failed (${error?.name ?? "unknown error"}).`);
  process.exitCode = 1;
});
