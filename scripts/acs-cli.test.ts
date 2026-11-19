/** acs.mjs (bridge/acs-cli.mjs): the agent's view of a Studio project - the query language, the commands, the actions
 * it records and the cards it exports for the skill. The Studio side (the snapshot, Apply) is tests/assistant.spec.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error - a plain .mjs script without types
import * as cli from "../bridge/acs-cli.mjs";

const card = (id: string, o: Record<string, unknown>) => ({ id, type: "basic", deck: "Root::L01", status: "new", tags: [], refs: [], checks: [], facts: {}, measures: {}, langs: [], boxes: [], images: [], front: "", back: "", why: "", ...o });
const PROJECT = {
  format: "acs-project/v1", bundleFormat: "anki-studio/v1", project: "Algo", deck: "Root", tags: [], exported: "now", allIds: ["c1", "c2", "c3", "c4"], fixRules: ["why", "ref_page"],
  checkDefs: [{ key: "why", label: "Hidden notes", group: "Hidden notes" }, { key: "code_line_chars", label: "Code width", group: "Code" }],
  sources: [{ id: "s1", name: "lecture3.pdf", kind: "pdf" }],
  cards: [
    card("c1", { status: "ok", tags: ["oop"], plain: { q: "What does this print?", a: "It prints 1 because of the deadlock rule" }, facts: { code_block: true }, langs: ["java"], measures: { q_words: 4, a_words: 9 }, refs: [{ file: "lecture3.pdf", page: 12 }] }),
    card("c2", { deck: "Root::L02 Heaps", plain: { q: "What is a heap?", a: "A tree with the heap property", why: "" }, checks: [{ key: "why", level: "W", msg: "no notes" }], measures: { q_words: 4, a_words: 6 } }),
    card("c3", { type: "cloze", deck: "Root::L02 Heaps::Sift", status: "drop", plain: { q: "Sift {{c1::down}}", a: "" }, facts: { code_block: true }, langs: ["python"], measures: { q_words: 2, a_words: 0 }, tags: ["oop-ish"] }),
    card("c4", { status: "change", feedback: "too long", plain: { q: "Explain O(n^2) sorting", a: "Bubble sort compares pairs" }, checks: [{ key: "code_line_chars", level: "E", msg: "wide" }], measures: { q_words: 3, a_words: 4 } }),
  ],
};
function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-cli-"));
  fs.writeFileSync(path.join(dir, "acs_project.json"), JSON.stringify(PROJECT));
  fs.writeFileSync(path.join(dir, "acs_sources.json"), JSON.stringify({ sources: [{ id: "s1", name: "lecture3.pdf", pages: [{ page: 12, text: "A heap is a tree.\nThe heap property holds." }, { page: 13, text: "Deadlock needs four conditions." }] }] }));
  fs.copyFileSync("bridge/acs-cli.mjs", path.join(dir, "acs.mjs"));
  return dir;
}
const ids = (q: string) => cli.select(cli.load(folder()), q).map((c: { id: string }) => c.id).join();

test("terms side by side all match; or, not, - and ( ) combine them", () => {
  assert.equal(ids(""), "c1,c2,c3,c4");
  assert.equal(ids("has:code_block"), "c1,c3");
  assert.equal(ids("has:code_block -lang:python"), "c1");
  assert.equal(ids("has:code_block not lang:python"), "c1");
  assert.equal(ids("status:ok or status:change"), "c1,c4");
  assert.equal(ids("(status:ok or status:drop) has:code_block lang:python"), "c3");
  assert.equal(ids("!(status:ok or status:drop)"), "c2,c4");
  assert.equal(ids("status:approved and tag:oop"), "c1");
});

test("keys: decks, tags, ids, checks, text, regex, measures", () => {
  assert.equal(ids("deck:L02"), "c2,c3");             // a part of the name: the sub-deck and the ones under it
  assert.equal(ids("deck:\"L02 Heaps\""), "c2,c3");
  assert.equal(ids("deck:Root::L02*::Sift"), "c3");   // wildcards: the full name
  assert.equal(ids("tag:oop*"), "c1,c3");
  assert.equal(ids("id:c1,c4"), "c1,c4");
  assert.equal(ids("check:why"), "c2");
  assert.equal(ids("check:error"), "c4");
  assert.equal(ids("check:any"), "c2,c4");
  assert.equal(ids("heap"), "c2");
  assert.equal(ids("\"heap property\""), "c2");
  assert.equal(ids("a:/dead\\s*lock/"), "c1");
  assert.equal(ids("/o\\(n\\^2\\)/"), "c4");
  assert.equal(ids("q:\"what is\""), "c2");
  assert.equal(ids("a_words>=6"), "c1,c2");
  assert.equal(ids("a_words>=6 -a_words>8"), "c2");
  assert.equal(ids("page>=12 ref:lecture3"), "c1");
  assert.equal(ids("type:cloze"), "c3");
  assert.equal(ids("is:cloze or feedback"), "c3");
});

test("mistakes are explained", () => {
  const p = cli.load(folder());
  for (const [q, msg] of [["has:nope", /has: is one of/], ["check:nope", /check: is any/], ["colour:red", /unknown key/], ["(status:ok", /not closed/],
    ["zzz>3", /unknown measure/], ["status:maybe", /status: is one of/], ["a:/(/", /bad regex/], ["status:ok )", /unexpected/]] as const)
    assert.throws(() => cli.select(p, q), msg, q);
});

test("commands: info, cards, show, search, sources, and actions written for the Studio", () => {
  const dir = folder(), out = path.join(dir, "out");
  const run = (...a: string[]) => { const r = spawnSync(process.execPath, [path.join(dir, "acs.mjs"), ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, ANKI_OUT_DIR: out } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  assert.match(run("info").out, /Cards: 4/);
  assert.match(run("decks").out, /Heaps {2}2/);
  const t = run("cards", "has:code_block", "--fields", "id,status,a_words").out;
  assert.match(t, /^id +status +a_words/); assert.match(t, /c1 +ok +9/); assert.match(t, /\(2 cards\)/);
  assert.equal(run("cards", "status:ok or status:new", "--ids").out.trim(), "c1\nc2");
  assert.equal(run("cards", "--count").out.trim(), "4");
  assert.equal(run("cards", "--sort", "a_words", "--desc", "--ids", "--limit", "2").out.trim(), "c1\nc2");
  assert.match(run("show", "c4").out, /my feedback: too long[\s\S]*check ERROR code_line_chars: wide/);
  assert.match(run("search", "deadlock").out, /c1 \[ok\] Root::L01\n  …[^\n]*because of the deadlock rule…/);
  assert.match(run("source", "lecture3", "--grep", "heap").out, /p\.12: A heap is a tree\.\np\.12: The heap property holds\./);
  assert.match(run("source", "lecture3", "--page", "13").out, /Deadlock needs four/);
  const bad = run("cards", "has:nope"); assert.equal(bad.code, 1); assert.match(bad.err, /^acs: has: is one of/);
  // actions
  assert.match(run("status", "check:why", "change", "--feedback", "add notes", "--why", "no notes").out, /action 1: 1 card\(s\) -> change/);
  assert.match(run("tag", "add", "heaps", "deck:L02").out, /action 2/);
  assert.match(run("move", "id:c4", "Root::L02 Heaps").out, /action 3/);
  assert.match(run("feedback", "c1", "use", "Kotlin").out, /action 4/);
  assert.match(run("global-revision", "has:code_block", "--instr", "Convert to Kotlin", "--rules", "why").out, /action 5/);
  assert.equal(run("global-revision", "has:code_block", "--rules", "nope").code, 1);
  assert.equal(run("move", "id:c4", "Elsewhere").code, 1);   // only under the project's deck
  assert.equal(run("status", "id:none", "ok").code, 1);       // nothing matches: nothing recorded
  assert.match(run("drop-action", "3").out, /4 left/);
  const acts = JSON.parse(fs.readFileSync(path.join(out, "anki_actions.json"), "utf8"));
  assert.equal(acts.format, "acs-actions/v1");
  assert.deepEqual(acts.actions, [
    { op: "status", ids: ["c2"], status: "change", feedback: "add notes", why: "no notes" },
    { op: "tag", ids: ["c2", "c3"], add: ["heaps"] },
    { op: "feedback", id: "c1", text: "use Kotlin" },
    { op: "global_revision", ids: ["c1", "c3"], instr: "Convert to Kotlin", rules: ["why"], mode: "content", split: false, del: false },
  ]);
  assert.match(run("actions").out, /^1\. status 1 card\(s\)/);
  // export: a bundle the skill's Deck.load() reads, with every id of the project kept as existing
  assert.match(run("export", "id:c1", "-o", "cards.json", "--feedback", "make it Kotlin").out, /1 card\(s\) -> cards\.json/);
  const b = JSON.parse(fs.readFileSync(path.join(dir, "cards.json"), "utf8"));
  assert.deepEqual(b.existing_ids, ["c1", "c2", "c3", "c4"]);
  assert.equal(b.cards[0].feedback, "make it Kotlin");
  assert.equal(b.cards[0].plain, undefined);
  assert.equal(b.format, "anki-studio/v1");
});

test("other projects are read-only and searched only when asked; images; settings, export and project actions", () => {
  const dir = folder(), out = path.join(dir, "out");
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "acs_project.json"), "utf8"));
  pj.others = [{ id: "p2", name: "Biology", deck: "Bio", cards: [card("c1", { deck: "Bio", plain: { q: "What is a heap of cells?", a: "" } })] }];
  pj.mediaInfo = [{ filename: "heap.png", origin: "generated", caption: "a heap" }];
  pj.cards[1].images = ["heap.png"];
  fs.writeFileSync(path.join(dir, "acs_project.json"), JSON.stringify(pj));
  fs.writeFileSync(path.join(dir, "acs_media.json"), JSON.stringify({ images: { "heap.png": { type: "image/png", data: Buffer.from("PNGDATA").toString("base64") } } }));
  const run = (...a: string[]) => { const r = spawnSync(process.execPath, [path.join(dir, "acs.mjs"), ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, ANKI_OUT_DIR: out } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  assert.equal(run("cards", "heap", "--ids").out.trim(), "c2");                              // this project only
  assert.equal(run("cards", "heap", "--ids", "--all-projects").out.trim(), "c2\nc1");
  assert.match(run("cards", "project:biology", "--fields", "id,project").out, /c1 +Biology/);
  assert.match(run("projects").out, /Algo \(this one, 4 cards\)\nBiology \(1 cards, deck Bio; read-only\)/);
  assert.match(run("show", "c1").out, /Root::L01/);                                         // an id means this project's card
  const ro = run("status", "project:biology", "ok"); assert.equal(ro.code, 1); assert.match(ro.err, /read-only/);
  // images
  assert.match(run("images").out, /heap\.png +\(generated, "a heap"\) +used by c2/);
  assert.match(run("extract-images", "id:c2", "--dir", "imgs").out, /1 image\(s\) -> imgs\//);
  assert.equal(fs.readFileSync(path.join(dir, "imgs", "heap.png"), "utf8"), "PNGDATA");
  run("export", "id:c2", "-o", "c2.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "c2.json"), "utf8")).media, [{ filename: "heap.png", origin: "generated", caption: "a heap", data: Buffer.from("PNGDATA").toString("base64") }]);
  // settings, export, projects
  pj.checkSettings = { why: "warn", code_line_chars: 27 }; fs.writeFileSync(path.join(dir, "acs_project.json"), JSON.stringify(pj));
  assert.match(run("set-check", "code_line_chars", "40").out, /code_line_chars = 40 \(now 27\)/);
  assert.equal(run("set-check", "why", "loud").code, 1);
  assert.equal(run("set-check", "nope", "1").code, 1);
  assert.match(run("set-notes", "a", "mnemonic").out, /action 2/);
  assert.match(run("export-apkg", "status:ok", "--deck", "Root::Done").out, /1 card/);
  assert.match(run("new-project", "Heaps", "deck:L02", "--move").out, /"Heaps" with 2 card\(s\) \(moved\)/);
  assert.match(run("delete-project", "Biology").out, /delete the project "Biology"/);
  assert.equal(run("delete-project", "Algo").code, 1);                                       // only another project
  const acts = JSON.parse(fs.readFileSync(path.join(out, "anki_actions.json"), "utf8")).actions;
  assert.deepEqual(acts, [
    { op: "check_setting", key: "code_line_chars", value: 40 }, { op: "notes_spec", text: "a mnemonic" },
    { op: "export_apkg", ids: ["c1"], deck: "Root::Done" }, { op: "new_project", name: "Heaps", ids: ["c2", "c3"], move: true },
    { op: "delete_project", id: "p2", name: "Biology" }]);
});
