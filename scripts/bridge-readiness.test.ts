import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';
import {JSDOM} from 'jsdom';

function fixture(){
  const dom = new JSDOM(`<button class="brRun"></button><section id="brSec"></section>${['brOpts', 'brModels', 'brDevices', 'brAdd', 'brScript', 'brJobsOpen'].map(id => `<div id="${id}"></div>`).join('')}<select id="brAgent"><option>claude</option><option>codex</option></select>`);
  const document = dom.window.document;
  const ctx = createContext({document, Store: {hosted: true}, SET: {}, BR_OPTS: [],
    $: (s: string) => document.querySelector(s), $$: (s: string) => document.querySelectorAll(s),
    esc: (s: unknown) => String(s ?? ''), ago: () => 'a moment ago', saveSettings(){},
    applyCopyButtons(){ document.body.dataset.copyAvailable = String(!run('bridgeReady()')); },
  });
  const run = (s: string) => runInContext(s, ctx);
  const source = readFileSync(new URL('../studio/src/19-bridge.js', import.meta.url), 'utf8');
  run(source.split('/* ---- making a job:')[0]);
  const devices = (value: unknown[]) => {ctx.devices = value; run('BR.devices = devices');};
  return {run, devices, document};
}
const now = Date.now();
const device = (agents: string[], age = 0) => ({id: 'mac', name: 'Mac', info: {agents}, lastSeen: new Date(now - age).toISOString()});

test('readiness distinguishes pairing, unknown capability, recent and stale compatibility', () => {
  const {run, devices} = fixture();
  assert.equal(run('bridgeReadiness().state'), 'unpaired');
  devices([{id: 'new', info: null}]);
  assert.equal(run('bridgeReadiness().state'), 'paired');
  assert.equal(run('bridgeReady()'), true, 'unknown capability permits queuing during setup');
  devices([device(['claude'])]);
  assert.equal(run(`bridgeReadiness(${now}).state`), 'recent');
  devices([device(['claude'], 121000), device(['codex'])]);
  assert.equal(run(`bridgeReadiness(${now}).state`), 'stale', 'a recent incompatible Mac does not make the selected agent recent');
  assert.equal(run('bridgeReady()'), true, 'stale compatible Macs still allow queuing');
  devices([{...device(['claude']), lastSeen: 'invalid'}]);
  assert.equal(run('bridgeReadiness().state'), 'stale');
  run('Store.hosted = false');
  assert.equal(run('bridgeReady()'), false);
});

test('selected-agent changes disable incompatible runs, retain manual transfer, and update nearby status', () => {
  const {run, devices, document} = fixture();
  devices([device(['claude'])]);
  run('renderBridgeButtons()');
  const button = document.querySelector('button')!;
  assert.equal(button.disabled, false);
  run("$('#brAgent').onchange({target: {value: 'codex'}})");
  assert.equal(button.disabled, true);
  assert.equal(button.hidden, false, 'unsupported runs remain visible with an explanation');
  assert.equal(document.body.dataset.copyAvailable, 'true');
  assert.match(button.nextElementSibling!.textContent!, /No paired Mac reports Codex support/);
  assert.match(document.querySelector('#brReadiness')!.textContent!, /restart the bridge/);
  button.insertAdjacentElement('afterend', document.createElement('details'));
  run('renderBridgeButtons()');
  assert.equal(document.querySelectorAll('[data-br-readiness]').length, 1);
  devices([device(['codex'], 121000)]);
  run('renderBridgeButtons()');
  assert.equal(button.disabled, false);
  assert.match(document.querySelector('[data-br-readiness]')!.textContent!, /still queue/);
});

test('explicit empty capabilities block while any unknown device preserves queuing', () => {
  const {run, devices} = fixture();
  devices([device([])]);
  assert.equal(run('bridgeReadiness().state'), 'unsupported');
  assert.equal(run('bridgeReady()'), false);
  devices([device([]), {info: {}}]);
  assert.equal(run('bridgeReadiness().state'), 'paired');
  devices([device(['codex']), device(['claude'])]);
  assert.equal(run('bridgeReadiness().state'), 'recent');
});
