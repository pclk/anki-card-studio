import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const cancelAt of [1, 2]) test(`cancellation at input checkpoint ${cancelAt} prevents execution`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'acs-cancel-'));
  process.env.ACS_BRIDGE_HOME = home;
  const { runJob, loadConfig } = await import('../bridge/acs-bridge.mjs');
  let downloads = 0, finishes = 0, events = 0;
  try {
    const result = await runJob({
      events: async () => ({ cancel: ++events === cancelAt }),
      download: async () => { downloads++; return Buffer.from('Make cards'); },
      finish: async () => { finishes++; return {}; },
    }, { id: 'j123456789012', agent: 'claude', files: [{ name: 'anki_prompt.txt' }] }, loadConfig(), () => {});
    assert.equal(downloads, cancelAt - 1);
    assert.equal(finishes, 0);
    assert.equal(result.cancelled, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
