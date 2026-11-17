import {test,expect} from '@playwright/test';
import {mkdtempSync,writeFileSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// The Mac bridge end to end: add a device in Settings (token shown once), "▶ Run on Mac", the real bridge script
// picks the job up and runs a fake `claude`, and the Studio imports the cards by itself. Then the device is removed.
const HOME=realpathSync(mkdtempSync(join(tmpdir(),'acs-e2e-bridge-')));
const FAKE=join(HOME,'fake-claude.mjs');
writeFileSync(FAKE,`#!/usr/bin/env node
import fs from 'node:fs';
const p = fs.readFileSync('anki_prompt.txt','utf8');
const deck = (p.match(/Deck\\(("[^"]+")/) || [, '"Mac deck"'])[1];
fs.writeFileSync(process.env.ANKI_OUT_DIR + '/anki_bundle.json', JSON.stringify({format:'anki-studio/v1', deck: JSON.parse(deck), cards:[
  {id:'mac-c001', type:'basic', front:'Made on the Mac?', back:'Yes', why:'w'}, {id:'mac-c002', type:'cloze', text:'The bridge runs {{c1::claude}}.', why:'w'}]}));
console.log(JSON.stringify({type:'assistant', message:{content:[{type:'text', text:'Building the deck'}]}}));
console.log(JSON.stringify({type:'result', is_error:false, result:'Made 2 cards.'}));
`);
chmodSync(FAKE,0o755);

test('Settings → add a device, ▶ Run on Mac, the bridge runs it, the cards arrive; removing the device hides the button',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough: the bridge runs in this test process');
 const pid='br'+Date.now().toString(36), headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty',undefined,{timeout:8000});
 await expect(page.locator('#runPrompt')).toBeHidden();                 // no device yet

 // add a device: the token is shown once, the list shows only its last 4 characters
 await page.evaluate(()=>(window as any).eval('toggleSidebar(true)'));   // Settings sits in the sidebar
 await page.locator('#btnSettings').click();
 await expect(page.locator('#brSec')).toBeVisible();
 await page.locator('#brName').fill('Test Mac');
 await page.locator('#brAdd').click();
 const token=await page.locator('#brTok').inputValue();
 expect(token).toMatch(/^acsd_[A-Za-z0-9_-]{43}$/);
 // the steps: paste the command first, then copy the token, then Enter (pbpaste reads it from the clipboard)
 await expect(page.locator('#brCmd')).toHaveText('pbpaste | node ~/Downloads/acs-bridge.mjs setup --server http://127.0.0.1:3098 && node ~/Downloads/acs-bridge.mjs install');
 await expect(page.locator('#brNew li').nth(1)).toContainText("don't press Enter yet");
 await expect(page.locator('#brNew li').nth(2)).toContainText('Copy the device token, then press Enter');
 await expect(page.locator('#brDevices')).toContainText(`Test Mac · token …${token.slice(-4)}`);
 expect(await page.locator('#brDevices').innerText()).not.toContain(token.slice(5,20));
 const [script]=await Promise.all([page.waitForEvent('download'),page.locator('#brScript').click()]);
 expect(script.suggestedFilename()).toBe('acs-bridge.mjs');
 // what Claude Code runs with: model and effort (a bad model name is refused right there)
 const oldOpts=await page.evaluate(()=>JSON.stringify((window as any).eval('SET.bridgeOpts')));
 await expect(page.locator('#brOpts [data-bro]')).toHaveCount(5);
 await page.locator('#brOpts [data-bro=model]').fill('opus; rm -rf ~');await page.locator('#brOpts [data-bro=model]').dispatchEvent('change');
 await expect(page.locator('#brOpts [data-bro=model]')).toHaveClass(/bad/);
 await page.locator('#brOpts [data-bro=model]').fill('opus');await page.locator('#brOpts [data-bro=model]').dispatchEvent('change');
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
 await page.locator('#brOpts [data-bro=effort]').selectOption('high');
 await saved;
 expect(await page.evaluate(()=>JSON.stringify((window as any).eval('SET.bridgeOpts.claude')))).toBe('{"model":"opus","effort":"high"}');
 // Codex has its own (no fallback model or spend limit)
 await page.locator('#brAgent').selectOption('codex');
 await expect(page.locator('#brOpts [data-bro]')).toHaveCount(3);
 await expect(page.locator('#brOpts [data-bro=effort] option')).toContainText(['Default','minimal']);
 await page.locator('#brAgent').selectOption('claude');
 await page.locator('#setClose').click();

 // ▶ Run on Mac: the job waits for the bridge
 await page.locator('#tabs button[data-tab=prompt]').click();
 await expect(page.locator('#runPrompt')).toBeVisible();
 await page.locator('#runPrompt').click();
 await expect(page.locator('#brPill')).toContainText('1 waiting');
 // a device token can't read the project, only the bridge endpoints
 expect((await request.get('/api/project/'+pid,{headers:{authorization:`Bearer ${token}`}})).status()).toBe(403);

 // the bridge (the real script) picks it up and runs the fake claude
 process.env.ACS_BRIDGE_HOME=HOME; process.env.ACS_BRIDGE_CLAUDE=FAKE;
 const bridge=await import('../bridge/acs-bridge.mjs');
 const r=await bridge.serve({...bridge.loadConfig(),agents:['claude'],server:'http://127.0.0.1:3098',token},{once:true,log:()=>{}});
 expect(r?.ok).toBe(true);

 // the Studio imports the result by itself
 await expect.poll(()=>page.evaluate(()=>(window as any).eval('S.cards.map(c=>c.id).join()')),{timeout:20000}).toBe('mac-c001,mac-c002');
 await page.locator('#brPill').click();
 await expect(page.locator('#jobsList .job')).toContainText('done');
 await expect(page.locator('#jobsList .job')).toContainText('imported');
 await page.locator('#jobsList [data-ja=log]').click();
 await expect(page.locator('#jobsList pre.jlog')).toContainText('Building the deck');
 await expect(page.locator('#jobsList pre.jlog')).toContainText('Made 2 cards.');
 await expect(page.locator('#jobsList pre.jlog')).toContainText('Started with claude (model opus, effort high)');
 await expect(page.locator('#jobsList .job')).toContainText('Claude Code (opus · high effort)');
 await page.locator('#jobsClose').click();
 // a reload doesn't import it a second time
 await page.reload();await page.waitForFunction('Store.on && curProject && !sync.dirty && S.cards.length');
 await page.waitForTimeout(1500);
 expect(await page.evaluate(()=>(window as any).eval('S.cards.length'))).toBe(2);

 // remove the device: its token stops working and the button goes away
 page.on('dialog',d=>d.accept());
 await page.evaluate(()=>(window as any).eval('toggleSidebar(true)'));   // Settings sits in the sidebar
 await page.locator('#btnSettings').click();
 await page.locator('#brDevices [data-rm]').click();
 await expect(page.locator('#brDevices')).toContainText('No device yet.');
 expect((await request.post('/api/bridge/hello',{headers:{authorization:`Bearer ${token}`},data:{}})).status()).toBe(401);
 await page.locator('#setClose').click();
 await expect(page.locator('#runPrompt')).toBeHidden();
 const restored=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
 await page.evaluate(o=>{(window as any).eval('SET').bridgeOpts=JSON.parse(o);(window as any).eval('saveSettings')();},oldOpts);
 await restored;
});
