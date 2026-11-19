import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';

const source = readFileSync(new URL('../studio/src/19-bridge.js', import.meta.url), 'utf8');
function harness({missing = false, failUpload = false, gate = Promise.resolve()} = {}) {
  const box = {innerHTML: '', className: '', open: false};
  const calls: string[] = [];
  const context = createContext({Blob, console, FILE_NAME_RE: /^[A-Za-z0-9][A-Za-z0-9 ._()+,=@#&'\-[\]]{0,180}$/,
    document: {createElement: () => box}, esc: (x: any) => String(x).replaceAll('<', '&lt;'),
    $: () => ({textContent: 'support', insertAdjacentElement() {}}),
    fmtPages: (p: number[]) => p.join(','), bridgeReady: () => true,
    skillSource: () => 'skill', helperSource: () => 'helper', SET: {}, curProject: 'p1', forMac: (p: string) => p,
    brOpts: () => ({}), BR: {jobs: []}, renderJobs() {}, pollJobsSoon() {}, toast() {},
    attachmentBlob: async () => {if (missing) throw new Error('original missing'); return new Blob(['pdf']);},
    brCall: async (method: string, path: string, body: any) => {
      calls.push(`${method} ${path}`);
      if (body?.files) context.declarations = body.files;
      return {id: 'j1', status: path.endsWith('/queue') ? 'queued' : 'uploading'};
    },
    Store: {putBlob: async (path: string) => {calls.push(path); await gate; if (failUpload) throw new Error('network down');}},
  });
  runInContext(source.slice(source.indexOf('async function blobSha256'), source.indexOf('/* ---- following the jobs')), context);
  return {box, calls, context, run: (atts: any[]) => {context.atts = atts; return runInContext("runOnMac({kind:'cards',title:'Lecture',prompt:'hello',atts})", context);}};
}
const attachment = (name: string) => ({name, src: {id: name, name: 'Original.pdf'}, pages: [2, 3], cut: true});

test('server file limit includes all five support files, fails before preparing or creating', async () => {
  const h = harness();
  assert.equal(await h.run(Array.from({length: 20}, (_, i) => attachment(`s${i}.pdf`))), null);
  assert.deepEqual(h.calls, []);
  assert.match(h.box.innerHTML, /25 files exceeds.*24-file limit/);
});
test('19 attachments fit and declarations include exact prepared blob sizes', async () => {
  const h = harness();
  assert.equal((await h.run(Array.from({length: 19}, (_, i) => attachment(`s${i}.pdf`)))).status, 'queued');
  assert.equal(h.context.declarations.length, 24);
  assert.equal(h.context.declarations[5].size, 3);
  assert.match(h.box.innerHTML, /Original.pdf · pages 2,3 \(PDF excerpt\)/);
  assert.match(h.box.innerHTML, /Queued on Mac/);
});
test('missing originals give inline recovery and never create a job', async () => {
  const h = harness({missing: true});
  assert.equal(await h.run([attachment('slides.pdf')]), null);
  assert.deepEqual(h.calls, []);
  assert.match(h.box.innerHTML, /Preparation failed.*Check Sources and add the original file again/);
});
test('duplicate names, including support collisions, are actionable instead of silently dropped', async () => {
  const h = harness();
  assert.equal(await h.run([attachment('skill.md')]), null);
  assert.deepEqual(h.calls, []);
  assert.match(h.box.innerHTML, /Duplicate attachment name.*Rename one source/);
});
test('upload state is visible while pending and failure deletes partial job without queueing', async () => {
  let release!: () => void;
  const h = harness({failUpload: true, gate: new Promise<void>(r => {release = r;})});
  const pending = h.run([]);
  // Let asynchronous hash calculation and job creation settle without a timer.
  for (let i = 0; i < 20 && !h.calls.some(c => c.startsWith('jobs/')); i++) await Promise.resolve();
  assert.match(h.box.innerHTML, /Uploading 1\/5: anki_prompt.txt/);
  assert.match(h.box.innerHTML, /value="0"/);
  release();
  assert.equal(await pending, null);
  assert.ok(h.calls.includes('DELETE jobs/j1'));
  assert.ok(!h.calls.includes('POST jobs/j1/queue'));
  assert.match(h.box.innerHTML, /Upload failed: network down/);
});

test('chunk count size limit accepts boundary and rejects overflow before creating a job', async () => {
  const h = harness();
  h.context.Store.CHUNK = 3 * 1024 * 1024;
  h.context.files = [{name: 'large.pdf', blob: {size: 4096 * h.context.Store.CHUNK}}];
  assert.doesNotThrow(() => runInContext('validateBridgeSizes(files)', h.context));
  h.context.attachmentBlob = async () => ({size: 4096 * h.context.Store.CHUNK + 1});
  assert.equal(await h.run([attachment('large.pdf')]), null);
  assert.deepEqual(h.calls, []);
  assert.match(h.box.innerHTML, /exceeds the upload limit.*Select fewer PDF pages/);
});

test('each run flow locks before preparation and releases after failure', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => {release = r;});
  let submitted = 0;
  const buttons = Object.fromEntries(['runPrompt', 'runQueue', 'runRevision', 'runImageFix', 'runFmt'].map(id => [id, {disabled: false, onclick: async () => {submitted++; await gate; throw new Error('prepare failed');}}]));
  const ctx = createContext({$: (id: string) => buttons[id.slice(1)], bridgeReady: () => true});
  runInContext(source.slice(source.indexOf('// Lock before prompt preparation'), source.indexOf('// start: once')), ctx);
  const pending = buttons.runQueue.onclick();
  await buttons.runQueue.onclick();
  assert.equal(submitted, 1);
  assert.equal(buttons.runQueue.disabled, true);
  release();
  await assert.rejects(pending, /prepare failed/);
  assert.equal(buttons.runQueue.disabled, false);
});

test('manifest uses the explicit originating control regardless of focus or job kind', () => {
  const h = harness();
  let attached = false;
  h.context.origin = {insertAdjacentElement: () => {attached = true;}};
  runInContext("bridgeManifest('Image fix', [], 'revision', origin)", h.context);
  assert.equal(attached, true);
});
