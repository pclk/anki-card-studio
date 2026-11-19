import {test,expect} from '@playwright/test';
import {mkdtempSync,writeFileSync,chmodSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
// The Assistant end to end: a request goes to the Mac with the project as files; the real bridge runs a fake agent that
// queries the project with acs.mjs, records actions and edits a card with the skill's helper; the Studio shows the
// answer and the proposed changes, and applies them only on Apply.
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);
const HOME=realpathSync(mkdtempSync(join(tmpdir(),'acs-e2e-ask-')));
const FAKE=join(HOME,'fake-claude.mjs');
const SKILL=resolve('skill/anki/scripts');
writeFileSync(FAKE,`#!/usr/bin/env node
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const acs = (...a) => execFileSync(process.execPath, ['acs.mjs', ...a], {encoding: 'utf8'});
const found = acs('cards', 'has:code_block -lang:python', '--ids').trim().split('\\n');
acs('tag', 'add', 'needs-kotlin', 'has:code_block', '--why', 'they have code');
acs('status', 'check:why', 'change', '--feedback', 'add hidden notes');
acs('export', 'id:a-java', '-o', 'cards.json');
execFileSync('python3', ['-c', 'import sys; sys.path.insert(0, ${JSON.stringify(SKILL)}); from anki_helper import *; d = Deck.load("cards.json"); d.update("a-java", back="Kotlin: <code>val x = 1</code>"); d.save(revision=True)'], {stdio: 'ignore'});
console.log(JSON.stringify({type:'result', is_error:false, result: '## Found\\nCards with non-Python code: **' + found.join(', ') + '**. Prompt had REQUEST: ' + fs.readFileSync('anki_prompt.txt','utf8').includes('<<<REQUEST')}));
`);
chmodSync(FAKE,0o755);
const WHY='<p>'+'word '.repeat(50)+'</p>';
const CARDS=[
 {id:'a-java',type:'basic',front:'What does this print?<pre><code class="language-java">int x = 1;</code></pre>',back:'1',why:WHY,tags:['oop']},
 {id:'a-py',type:'basic',front:'What does this print?<pre><code class="language-python">print(2)</code></pre>',back:'2',why:WHY},
 {id:'a-nowhy',type:'basic',front:'What is encapsulation?',back:'Hiding state.'},
 {id:'a-cloze',type:'cloze',text:'The {{c1::heap}} property.',why:WHY}
];
async function open(page:any,request:any,info:any){
 const pid='ask'+Date.now().toString(36)+info.project.name, headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction(`Store.on && Store.hosted && curProject && !sync.dirty && S.deck===${JSON.stringify(pid)}`);   // the project itself is loaded
 await ev(page,`applyBundle(${JSON.stringify({deck:pid,cards:CARDS})},'merge');setCardStatus(cardById('a-java'),'ok');save();afterImport()`);
 return pid;
}

test('▶ Run on Mac: the agent searches the project with acs.mjs, the answer shows up, its changes apply on Apply',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough: the bridge runs in this test process');
 const pid=await open(page,request,info), headers={origin:'http://127.0.0.1:3098'};
 const dev=await (await request.post('/api/devices',{headers,data:{name:'Ask Mac'}})).json();
 try {
  await ev(page,'loadDevices()');
  await page.locator('#tabs button[data-tab=assistant]').click();
  await expect(page.locator('#askRun')).toBeVisible();
  await expect(page.locator('#askInfo')).toContainText('4 cards');
  await page.locator('#askText').fill('Which cards have code that is not Python? Tag the code cards and fix the Java one.');
  await page.locator('#askWrite').check();
  await page.locator('#askRun').click();
  await expect(page.locator('#askList .ask-item')).toHaveCount(1);
  await expect(page.locator('#askList .ask-item')).toContainText('waiting for your Mac');
  // the device token still reaches nothing but the bridge
  expect((await request.get('/api/project/'+pid,{headers:{authorization:`Bearer ${dev.token}`}})).status()).toBe(403);
  // the bridge takes the account's oldest waiting job: cancel any an earlier, interrupted run left behind
  for (const j of await (await request.get('/api/jobs')).json()) if (j.project!==pid && ['uploading','queued'].includes(j.status)) await request.post(`/api/jobs/${j.id}/cancel`,{headers});
  process.env.ACS_BRIDGE_HOME=HOME; process.env.ACS_BRIDGE_CLAUDE=FAKE;
  const bridge=await import('../bridge/acs-bridge.mjs');
  const r=await bridge.serve({...bridge.loadConfig(),agents:['claude'],server:'http://127.0.0.1:3098',token:dev.token,keepJobs:true},{once:true,log:()=>{}});
  expect(r?.ok, r?.error).toBe(true);
  const dir=String(r!.dir);
  // what the job got: the project as files and the CLI
  const snap=JSON.parse(readFileSync(join(dir,'acs_project.json'),'utf8'));
  expect(snap.cards.map((c:any)=>c.id)).toEqual(['a-java','a-py','a-nowhy','a-cloze']);
  expect(snap.cards[0]).toMatchObject({status:'ok',langs:['java'],facts:{code_block:true},deck:pid});
  expect(snap.cards[2].checks.map((x:any)=>x.key)).toContain('why');
  expect(readFileSync(join(dir,'acs.mjs'),'utf8')).toBe(readFileSync('bridge/acs-cli.mjs','utf8'));
  // the answer, and the proposal waiting for Apply (nothing changed yet)
  await ev(page,'pollJobs()');
  await expect(page.locator('#askList .ask-reply')).toContainText('Cards with non-Python code: a-java',{timeout:20000});
  await expect(page.locator('#askList .ask-reply h4')).toHaveText('Found');
  await expect(page.locator('#askList .ask-reply')).toContainText('Prompt had REQUEST: true');
  const prop=page.locator('#askList .ask-prop');
  await expect(prop).toContainText('1 changed');
  await expect(prop).toContainText('Tags add needs-kotlin');
  await expect(prop).toContainText('they have code');
  await expect(prop).toContainText('Set status → change requested: “add hidden notes”');
  expect(await ev(page,`cardById('a-java').back`)).toBe('1');
  expect(await ev(page,`cardById('a-py').tags.join()`)).toBe('');
  await prop.locator('[data-ask=apply]').click();
  await expect(page.locator('#askResult')).toContainText('2 action(s) applied to 3 card(s)');
  const st=JSON.parse(await ev(page,`JSON.stringify(['a-java','a-py','a-nowhy'].map(i=>{const c=cardById(i);return {s:c.status,rc:!!c.recheck,tags:c.tags,back:c.back,fb:c.feedback,pf:c.prev&&c.prev.feedback}}))`));
  expect(st[0]).toMatchObject({s:'ok',rc:true,tags:['oop','needs-kotlin'],back:'Kotlin: <code>val x = 1</code>'});
  expect(st[0].pf).toMatch(/^Assistant: Which cards have code/);
  expect(st[1]).toMatchObject({s:'new',tags:['needs-kotlin'],back:'2'});
  expect(st[2]).toMatchObject({s:'change',fb:'add hidden notes'});
  await expect(page.locator('#askList')).toContainText('were applied or discarded');
  // applied once: a reload doesn't offer it again
  await page.reload();await page.waitForFunction('Store.on && curProject && !sync.dirty && S.cards.length');
  await ev(page,'loadDevices()'); await page.locator('#tabs button[data-tab=assistant]').click(); await ev(page,'pollJobs()');
  await expect(page.locator('#askList .ask-reply')).toContainText('a-java');
  await expect(page.locator('#askList .ask-prop')).toHaveCount(0);
 } finally { await request.delete('/api/devices/'+dev.id,{headers}); }
});

test('without a bridge: copy for a chat downloads the project files; a chat\'s actions are looked at, then applied',async({page,request},info)=>{
 const pid=await open(page,request,info);
 await page.locator('#tabs button[data-tab=assistant]').click();
 await expect(page.locator('#askRun')).toBeHidden();
 await page.locator('#askText').fill('Move the cloze cards to their own sub-deck');
 const names:string[]=[], got:Record<string,string>={};
 page.on('download',async(d:any)=>{ names.push(d.suggestedFilename()); const p=await d.path(); if (p) got[d.suggestedFilename()]=readFileSync(p,'utf8'); });
 await page.locator('#askCopy').click();
 await expect.poll(()=>names.sort().join()).toBe('acs.mjs,acs_project.json,acs_sources.json');
 await expect.poll(()=>!!got['acs_project.json']).toBe(true);
 const snap=JSON.parse(got['acs_project.json']);
 expect(snap.cards.find((c:any)=>c.id==='a-cloze')).toMatchObject({type:'cloze',measures:{cloze_n:1}});
 expect(snap.factLabels.code_block).toBe('Has a code block');
 // read-only by default: the prompt says only to answer
 const prompt:string=await ev(page,`askPrompt('x',{write:false,atts:[],chat:true})`);
 expect(prompt).toContain('**Only look and answer.**');
 expect(prompt).toContain('I attached the whole project');
 // the chat's anki_actions.json, dropped here
 const acts={format:'acs-actions/v1',actions:[{op:'move',ids:['a-cloze'],deck:pid+'::Cloze'},{op:'notes_on_card',ids:['a-py'],on:true},
   {op:'global_revision',ids:['a-java','a-py'],instr:'Convert to Kotlin',rules:['why']},{op:'move',ids:['a-py'],deck:'Elsewhere'},{op:'status',ids:['nope'],status:'ok'}]};
 await page.locator('#askFile').setInputFiles({name:'anki_actions.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(acts))});
 const prop=page.locator('#askPending .ask-prop');
 await expect(prop.locator('li')).toHaveCount(5);
 await expect(prop).toContainText('Queue a global revision “Convert to Kotlin” + fix why');
 await prop.locator('[data-ask=apply]').click();
 await expect(page.locator('#askResult')).toContainText('3 action(s) applied');
 await expect(page.locator('#askResult')).toContainText('not understood');   // the move out of the project
 await expect(page.locator('#askResult')).toContainText('unknown card nope');
 expect(await ev(page,`cardDeck(cardById('a-cloze'))`)).toBe(pid+'::Cloze');
 expect(await ev(page,`S.nodes.some(n=>nodeDeckOf(n)===${JSON.stringify(pid+'::Cloze')})`)).toBe(true);
 expect(await ev(page,`cardById('a-py').whyOnCard`)).toBe(true);
 expect(await ev(page,`JSON.stringify(['a-java','a-py'].map(i=>[cardById(i).fmt,cardById(i).fmtTask&&cardById(i).fmtTask.instr]))`)).toBe(JSON.stringify([['Q1','Convert to Kotlin'],['Q1','Convert to Kotlin']]));
 await expect(page.locator('#askPending .ask-prop')).toHaveCount(0);
});

test('settings, an Anki package, a new project and deleting one - each applied only as the user says',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','the settings are shared: one browser is enough');
 const pid=await open(page,request,info), headers={origin:'http://127.0.0.1:3098'};
 // another project, to delete
 const other='del'+pid;
 await request.put('/api/project/'+other,{headers,data:{rev:1,projectName:other,deck:other,cards:[]}});
 const list=await (await request.get('/api/projects')).json();
 await request.put('/api/projects',{headers,data:[...list,{id:other,name:other,cards:0,updated:Date.now()}]});
 await ev(page,'Store.getIndex().then(x=>{projects=x})'); await page.waitForFunction(`projects.some(x=>x.id===${JSON.stringify(other)})`);
 const oldChecks=await ev(page,'JSON.stringify(SET.checks)');
 try {
  await page.locator('#tabs button[data-tab=assistant]').click();
  // the snapshot can carry the other projects (read-only) and the card images
  const snap=JSON.parse(await ev(page,`(async()=>{ const s=await askSnapshot(false,{images:true,others:true}); return JSON.stringify({others:s.project.others.map(o=>o.name), media:!!s.media}); })()`));
  expect(snap.others).toContain(other); expect(snap.media).toBe(true);
  const acts={format:'acs-actions/v1',actions:[{op:'check_setting',key:'code_line_chars',value:40},{op:'check_setting',key:'why',value:'loud'},
   {op:'notes_spec',text:'a mnemonic'},{op:'export_apkg',ids:['a-java','a-cloze'],deck:pid+'::Out'},
   {op:'new_project',name:'Cloze only '+pid,ids:['a-cloze'],move:true},{op:'delete_project',id:other,name:other,why:'empty'}]};
  await page.locator('#askFile').setInputFiles({name:'anki_actions.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(acts))});
  const prop=page.locator('#askPending .ask-prop');
  await expect(prop).toContainText('Checker setting code_line_chars → 40');
  await expect(prop).toContainText(`Delete a project “${other}” (you type its name to confirm)`);
  page.once('dialog',(d:any)=>d.accept(other));                               // typed the name: deleted
  const dl=page.waitForEvent('download');
  await prop.locator('[data-ask=apply]').click();
  expect((await dl).suggestedFilename()).toBe(`${pid} - Out.apkg`);
  await expect(page.locator('#askResult')).toContainText(`New project “Cloze only ${pid}” with 1 card(s), moved out of this one`,{timeout:20000});
  await expect(page.locator('#askResult')).toContainText("why can't be loud");
  expect(await ev(page,'ck().code_line_chars')).toBe(40);
  expect(await ev(page,'S.prompt.pNotes')).toBe('a mnemonic');
  expect(await ev(page,'curProject')).toBe(pid);                               // back in this project
  expect(await ev(page,`S.cards.map(c=>c.id).join()`)).toBe('a-java,a-py,a-nowhy');
  const idx=await (await request.get('/api/projects')).json();
  expect(idx.some((x:any)=>x.id===other)).toBe(false);
  const made=idx.find((x:any)=>x.name==='Cloze only '+pid);
  expect(made).toBeTruthy();
  const np=await (await request.get('/api/project/'+made.id)).json();
  expect(np.cards.map((c:any)=>[c.id,c.type])).toEqual([['a-cloze','cloze']]);
  // deleting asks every time: an empty answer keeps the project (a new one: a deleted id never comes back)
  const keep='keep'+pid;
  await request.put('/api/project/'+keep,{headers,data:{rev:1,projectName:keep,deck:keep,cards:[]}});
  await request.put('/api/projects',{headers,data:[...idx,{id:keep,name:keep,cards:0,updated:Date.now()}]});
  await ev(page,'Store.getIndex().then(x=>{projects=x})'); await page.waitForFunction(`projects.some(x=>x.id===${JSON.stringify(keep)})`);
  await page.locator('#askFile').setInputFiles({name:'anki_actions.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'acs-actions/v1',actions:[{op:'delete_project',id:keep,name:keep}]}))});
  page.once('dialog',(d:any)=>d.accept(''));
  await page.locator('#askPending [data-ask=apply]').click();
  await expect(page.locator('#askResult')).toContainText(`kept the project ${keep}`);
  expect((await (await request.get('/api/projects')).json()).some((x:any)=>x.id===keep)).toBe(true);
 } finally {
  const saved=page.waitForResponse((r:any)=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
  await ev(page,`SET.checks=${oldChecks};saveSettings()`); await saved;
 }
});

test('"apply as soon as they arrive": the changes are applied without a click',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough: the bridge runs in this test process');
 const pid=await open(page,request,info), headers={origin:'http://127.0.0.1:3098'};
 const dev=await (await request.post('/api/devices',{headers,data:{name:'Auto Mac'}})).json();
 try {
  await ev(page,'loadDevices()');
  await page.locator('#tabs button[data-tab=assistant]').click();
  await page.locator('#askText').fill('Tag the code cards.');
  await expect(page.locator('#askAuto')).toBeDisabled();
  await page.locator('#askWrite').check();
  await page.locator('#askAuto').check();
  await page.locator('#askRun').click();
  await expect(page.locator('#askList .ask-item')).toHaveCount(1);
  for (const j of await (await request.get('/api/jobs')).json()) if (j.project!==pid && ['uploading','queued'].includes(j.status)) await request.post(`/api/jobs/${j.id}/cancel`,{headers});
  process.env.ACS_BRIDGE_HOME=HOME; process.env.ACS_BRIDGE_CLAUDE=FAKE;
  const bridge=await import('../bridge/acs-bridge.mjs');
  const r=await bridge.serve({...bridge.loadConfig(),agents:['claude'],server:'http://127.0.0.1:3098',token:dev.token},{once:true,log:()=>{}});
  expect(r?.ok, r?.error).toBe(true);
  await ev(page,'pollJobs()');
  await expect.poll(()=>ev(page,`cardById('a-py').tags.join()`),{timeout:20000}).toBe('needs-kotlin');
  expect(await ev(page,`cardById('a-java').recheck`)).toBe(true);
  await expect(page.locator('#askList .ask-prop')).toHaveCount(0);
 } finally { await request.delete('/api/devices/'+dev.id,{headers}); }
});
