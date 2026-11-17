/** Exercise the shipped Studio source in a fresh JS realm; promises gate races, never sleeps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return {promise, resolve};
}
function studio(fetch: (...args: any[]) => Promise<Response>) {
  const elements = new Map();
  const context = createContext({
    fetch, Blob, File, console,
    Store: {hosted: true, base: '', getBlob: async () => new Blob(['{"cards":[]}'])},
    curProject: 'p1', S: {cards: []}, SET: {},
    $: (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, {addEventListener() {}, hidden: true, open: false});
      return elements.get(selector);
    }, $$: () => [],
    setTimeout: () => 0, clearTimeout() {}, toast() {}, renderFmtPass() {},
    importFiles: async () => { context.applied++; return {sums: [{added: 1}]}; },
    summarize: () => ({ok: true}), afterImport: async () => {}, applied: 0,
  });
  runInContext(readFileSync(new URL('../studio/src/19-bridge.js', import.meta.url), 'utf8'), context);
  return {context, run: (code: string) => runInContext(code, context)};
}
const job = {id: 'j123456789012', project: 'p1', title: 'Lecture', kind: 'cards', status: 'done', importedAt: null};

test('switching projects during an import claim leaves the result available for automatic import', async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let claimed = false;
  const {context, run} = studio(async (url: string) => {
    if (url.endsWith('/imported')) {
      const first = !claimed; claimed = true; entered.resolve(); await release.promise;
      return Response.json({first});
    }
    return Response.json([{...job, importedAt: claimed ? '2026-01-01T00:00:00Z' : null}]);
  });
  context.job = job;
  const importing = run('importJob(job)');
  await entered.promise;
  context.curProject = 'p2'; release.resolve(); await importing;
  assert.equal(context.applied, 0, 'switch prevents applying into the wrong project');
  context.curProject = 'p1';
  await run('pollJobs()');
  assert.equal(context.applied, 1, 'returning to the original project must recover the unapplied result');
});

test('an old project poll response cannot overwrite the current project jobs', async () => {
  const oldResponse = deferred<Response>();
  const current = {...job, id: 'j222222222222', project: 'p2', status: 'queued'};
  const {context, run} = studio(async (url: string) => url.includes('project=p1') ? oldResponse.promise : Response.json([current]));
  const oldPoll = run('pollJobs()');
  context.curProject = 'p2'; await run('pollJobs()');
  assert.equal(run('BR.jobs[0].project'), 'p2');
  oldResponse.resolve(Response.json([{...job, status: 'queued'}])); await oldPoll;
  assert.equal(run('BR.jobs[0].project'), 'p2', 'late p1 response must not replace p2 jobs');
});
