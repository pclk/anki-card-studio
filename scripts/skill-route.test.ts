/** /skill/...: the AI downloads the anki skill from the server itself (the Studio's "Claude downloads it" option). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { GET } from "../app/skill/[file]/route";
import { crc32 } from "../lib/zip";

const get = (file: string) => GET(new Request("http://x/skill/" + file), { params: Promise.resolve({ file }) });
const FILES = { "anki/SKILL.md": "skill/anki/SKILL.md", "anki/scripts/anki_helper.py": "skill/anki/scripts/anki_helper.py",
  "anki/scripts/extract.py": "skill/anki/scripts/extract.py", "anki/scripts/make_prompts.py": "skill/anki/scripts/make_prompts.py" };

test("anki.zip is the whole skill, in the layout of the Studio's own download", async () => {
  const r = await get("anki.zip");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  const z = await JSZip.loadAsync(new Uint8Array(await r.arrayBuffer()), { checkCRC32: true });
  assert.deepEqual(Object.keys(z.files).sort(), Object.keys(FILES).sort());
  for (const [name, path] of Object.entries(FILES)) assert.equal(await z.file(name)!.async("string"), readFileSync(path, "utf8"), name);
});

test("single files are served as text; anything else is not found", async () => {
  const md = await get("SKILL.md");
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type")!, /^text\/markdown/);
  assert.equal(await md.text(), readFileSync("skill/anki/SKILL.md", "utf8"));
  assert.equal(await (await get("anki_helper.py")).text(), readFileSync("skill/anki/scripts/anki_helper.py", "utf8"));
  for (const bad of ["../package.json", "scripts", "anki", ".env", "SKILL.MD"]) assert.equal((await get(bad)).status, 404, bad);
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
