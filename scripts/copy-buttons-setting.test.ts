/** Settings → Prompts → "Show the 📋 Copy buttons": off by default (also for settings saved before it existed), kept
    when saved, and hiding the buttons only while a Mac is paired. The shipped Studio source, in a fresh JS realm. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

/** anything the settings code touches on the page: every property and call gives back the same stub */
function stub(): any {
  const f: any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k in el ? el[k as string] : f), set: (_t, k, v) => { el[k as string] = v; return true; }, apply: () => f });
  const el: Record<string, unknown> = {};
  return f;
}
function settings(stored: unknown, bridge: { ready: boolean } = { ready: true }) {
  const local = new Map<string, string>(stored === undefined ? [] : [["acs-settings", JSON.stringify(stored)]]);
  const cls = new Set<string>(), brRun = [{ cls: new Set<string>(), classList: null as any }], put: unknown[] = [];
  for (const b of brRun) b.classList = { toggle: (c: string, on: boolean) => (on ? b.cls.add(c) : b.cls.delete(c)) };
  const ctx = createContext({
    JSON, Object, Array, Number, String, Math, Set, Map, console,
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => local.set(k, v) },
    Store: { putSettings: async (s: unknown) => { put.push(JSON.parse(JSON.stringify(s))); } },
    document: { body: { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) } }, addEventListener() {} },
    $: () => stub(), $$: (q: string) => (q === ".brRun" ? brRun : []),
    CHECK_DEFAULTS: {}, CHECK_DEFS: [], FMT_KEYS: [], FIX_RULES: [], J: JSON.stringify,
    bridgeReady: () => bridge.ready, addEventListener() {}, innerWidth: 1000, innerHeight: 800, window: { addEventListener() {}, matchMedia: () => stub() }, navigator: {},
  });
  runInContext(readFileSync(new URL("../studio/src/11-settings.js", import.meta.url), "utf8") + "\n;globalThis.__get = () => SET; globalThis.__set = v => { SET = v; };", ctx);
  const run = (code: string) => runInContext(code, ctx);
  run("loadSettings()");
  return { ctx, run, cls, brRun, local, put, get SET() { return run("__get()"); } };
}

test("the Copy buttons are off by default, and for settings saved before the option existed", () => {
  assert.equal(settings(undefined).run("DEFAULT_SETTINGS.showCopy"), false);
  for (const old of [undefined, { version: 2, showAnalytics: true, promptFile: true }, { showCopy: "yes" }, { showCopy: 1 }, { showCopy: null }]) {
    const s = settings(old);
    assert.equal(s.SET.showCopy, false, JSON.stringify(old));
    assert.equal(s.run("copyHidden()"), true);
  }
  assert.equal(settings({ promptFile: true }).SET.promptFile, true, "the other settings are kept");
});

test("turning them on is saved (this browser and the account) and survives a reload", () => {
  const s = settings({ version: 2 });
  s.run("SET.showCopy = true; saveSettings()");
  assert.equal(JSON.parse(s.local.get("acs-settings")!).showCopy, true);
  assert.equal((s.put.at(-1) as { showCopy: boolean }).showCopy, true);
  const again = settings(JSON.parse(s.local.get("acs-settings")!));
  assert.equal(again.SET.showCopy, true);
  assert.equal(again.run("copyHidden()"), false);
  // and an exported settings file brings it along (mergeSettings is what import uses)
  assert.equal(s.run("mergeSettings({showCopy: true}).showCopy"), true);
});

test("hidden: the page gets hide-copy and ▶ Run on Mac becomes the main button; shown: neither", () => {
  const s = settings(undefined);
  s.run("applyCopyButtons()");
  assert.ok(s.cls.has("hide-copy")); assert.ok(s.brRun[0].cls.has("primary"));
  s.run("SET.showCopy = true; saveSettings()");   // saving re-applies it
  assert.ok(!s.cls.has("hide-copy")); assert.ok(!s.brRun[0].cls.has("primary"));
});

test("without a paired Mac the Copy buttons always show: there is no other way to send a prompt", () => {
  const bridge = { ready: false }, s = settings(undefined, bridge);
  s.run("applyCopyButtons()");
  assert.equal(s.run("copyHidden()"), false); assert.ok(!s.cls.has("hide-copy"));
  bridge.ready = true; s.run("applyCopyButtons()");     // a device is added
  assert.ok(s.cls.has("hide-copy"));
  bridge.ready = false; s.run("applyCopyButtons()");    // and removed again
  assert.ok(!s.cls.has("hide-copy"));
});

test("before the bridge code has loaded, nothing is hidden and nothing throws", () => {
  const s = settings(undefined);
  s.run("bridgeReady = () => { throw new ReferenceError('BR is not defined'); }");
  assert.equal(s.run("copyHidden()"), false);
  s.run("renderKeyHints()");
  assert.ok(!s.cls.has("hide-copy"));
});

test("every prompt Copy button, its 'As a file' box and its attach note carry the class the setting hides", () => {
  const html = readFileSync(new URL("../studio/studio.html", import.meta.url), "utf8"), page = html.slice(0, html.indexOf("<!-- app:start -->"));
  assert.match(page, /body\.hide-copy \.copyBtn\{display:none !important\}/, "display:none: out of the layout and the tab order");
  for (const id of ["btnCopyPrompt", "btnCopyNext", "biCopy", "fqNext", "btnCopyRevision", "btnSrcFiles", "pAttachInfo"])
    assert.match(page, new RegExp(`class="[^"]*\\bcopyBtn\\b[^"]*" id="${id}"`), id);
  const boxes = page.match(/<label class="check small[^"]*"[^>]*><input type="checkbox" class="optPromptFile">/g)!;
  assert.ok(boxes.length >= 5 && boxes.every((b) => b.includes("copyBtn")));
  // the Run on Mac buttons and other copy buttons (skill, script, plan, device setup) are not affected
  for (const id of ["runPrompt", "runQueue", "runImageFix", "runFmt", "runRevision", "btnCopyPlan", "btnCopySkill", "btnCopyScript"])
    assert.doesNotMatch(page, new RegExp(`class="[^"]*\\bcopyBtn\\b[^"]*" id="${id}"`), id);
  // the rows the queues draw
  for (const f of ["05-batch.js", "13-revise.js"]) assert.match(readFileSync(new URL(`../studio/src/${f}`, import.meta.url), "utf8"), /class="btn sm copyBtn" data-f?q="copy"/, f);
  assert.match(page, /<input type="checkbox" id="setCopy">/);
});
