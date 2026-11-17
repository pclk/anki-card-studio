import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// "📎 As a file": the Studio saves the prompt as a file, and the real anki_helper.py reads its blocks by id from it -
// the AI never retypes the material or the cards into code.
const helper=(dir:string,out:string,code:string)=>execFileSync('python3',['-c',`import sys,json;sys.path.insert(0,'skill/anki/scripts')\nfrom anki_helper import *\n${code}`],
 {env:{...process.env,ANKI_MATERIAL_DIR:dir,ANKI_OUT_DIR:out},encoding:'utf8'}).trim().split('\n').pop()!;
const sha8=(s:string)=>createHash('sha1').update(s).digest('hex').slice(0,8);

test('revision prompt as a file → helper loads the cards by id → its anki_revision.json applies',async({page,request,context},info)=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const pid='pf'+Date.now().toString(36)+info.project.name, headers={origin:'http://127.0.0.1:3098'};
 const cards=[{id:'c001',type:'basic',front:'What is a class?',back:'A blueprint',status:'change',feedback:'Add an example',tags:[],why:'w'},
  {id:'c002',type:'basic',front:'What is an object?',back:'An instance',status:'ok',feedback:'',tags:[],why:'w'}];
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:2,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty && S.cards.length===2');
 await page.locator('#tabs button[data-tab=revise]').click();
 const box=page.locator('#tab-revise .optPromptFile').last();
 await box.check();
 try {
  const dir=mkdtempSync(join(tmpdir(),'acs-pf-')), out=mkdtempSync(join(tmpdir(),'acs-pf-out-'));
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#btnCopyRevision').click()]);
  expect(dl.suggestedFilename()).toMatch(/^anki_prompt_r-[0-9a-f]{8}\.txt$/);
  await dl.saveAs(join(dir,dl.suggestedFilename()));
  // the clipboard holds only the short message
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toMatch(/^Follow the instructions in the attached anki_prompt file/);
  const text=readFileSync(join(dir,dl.suggestedFilename()),'utf8');
  const m=/<<<REVISE_CARDS id=(r-[0-9a-f]{8})\n([\s\S]*?)\nREVISE_CARDS>>>/.exec(text)!;
  expect(m).toBeTruthy();
  expect(dl.suggestedFilename()).toBe(`anki_prompt_${m[1]}.txt`);
  expect(m[1]).toBe('r-'+sha8(m[2]));                      // the id is the block's own hash
  expect(text).toContain(`Deck.load("${m[1]}")`);           // and the prompt tells Claude to use it
  // the AI's side: load by id (a few characters), change the card, save the revision
  const res=JSON.parse(helper(dir,out,`d=Deck.load("${m[1]}")\nd.update("c001", back=d.get("c001")["back"]+" - e.g. class Dog")\nd.save(revision=True)\nprint(json.dumps({"ids":[c["id"] for c in d.cards],"fb":d.feedback}))`));
  expect(res).toEqual({ids:['c001'],fb:{c001:'Add an example'}});
  const rev=readdirSync(out).find(f=>f==='anki_revision.json')!;
  await page.locator('#reviseFile').setInputFiles(join(out,rev));
  await expect(page.locator('#reviseResult')).toContainText('1 updated');
  expect(await page.evaluate(()=>(window as any).eval(`cardById('c001').back`))).toBe('A blueprint - e.g. class Dog');
 } finally {
  await box.uncheck();
  // the setting is saved for the user (every test shares one): wait until the server has it, or later tests inherit it
  await expect.poll(()=>page.evaluate(()=>fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then(j=>!!(j&&j.promptFile)))).toBe(false);
 }
 // unticked: Copy puts the whole prompt on the clipboard again
 await page.locator('#btnCopyRevision').click();
 await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('<<<REVISE_CARDS id=r-');
});

test('batch prompt as a file → helper loads the source material by id',async({page,request,context},info)=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const pid='pfs'+Date.now().toString(36)+info.project.name, headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#flowSeg button[data-flow=batch]').click();
 const content='[L01.pdf p.3]\nA class is a blueprint for objects.\n[L01.pdf p.4]\nAn object is an instance of a class.';
 await page.locator('#qPasteWrap summary').click();
 await page.locator('#qPaste').fill(JSON.stringify({deck_root:pid,items:[{id:'L01',title:'Classes',content}]}));
 await page.locator('#btnQPaste').click();
 const box=page.locator('#batchOut .optPromptFile');
 await box.check();
 try {
  const dir=mkdtempSync(join(tmpdir(),'acs-pfs-'));
  const [dl]=await Promise.all([page.waitForEvent('download'),page.locator('#btnCopyNext').click()]);
  await dl.saveAs(join(dir,dl.suggestedFilename()));
  const text=readFileSync(join(dir,dl.suggestedFilename()),'utf8');
  const id=/<<<SOURCE id=(s-[0-9a-f]{8})\n/.exec(text)![1];
  expect(dl.suggestedFilename()).toBe(`anki_prompt_${id}.txt`);
  expect(text).toContain(`deck.load_source("${id}")`);
  const pages=JSON.parse(helper(dir,mkdtempSync(join(tmpdir(),'acs-pfs-out-')),`d=Deck("x")\nd.load_source("${id}")\nprint(json.dumps({f:sorted(p) for f,p in d.source_pages.items()}))`));
  expect(pages).toEqual({'L01.pdf':[3,4]});
  await expect(page.locator('#qList')).toContainText('copied');
 } finally {
  await box.uncheck();
  // the setting is saved for the user (every test shares one): wait until the server has it, or later tests inherit it
  await expect.poll(()=>page.evaluate(()=>fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then(j=>!!(j&&j.promptFile)))).toBe(false);
 }
});
