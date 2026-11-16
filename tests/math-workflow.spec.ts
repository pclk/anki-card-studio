import {test,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const nodeRequire=createRequire(process.cwd()+'/package.json');
const JSZip=nodeRequire('jszip');
const initSqlJs=nodeRequire('sql.js');

test('math file import → formatting revision → saved re-check → Anki package',async({page,request},info)=>{
 // Serve the production CDN versions locally so export tests don't depend on network availability.
 await page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',r=>r.fulfill({path:nodeRequire.resolve('jszip/dist/jszip.min.js'),contentType:'application/javascript'}));
 await page.route('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/*',r=>r.fulfill({path:nodeRequire.resolve('sql.js/dist/'+r.request().url().split('/').pop()),contentType:r.request().url().endsWith('.wasm')?'application/wasm':'application/javascript'}));
 const pid='math'+Date.now().toString(36)+info.project.name;
 const headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
 const bad={id:'math-basic',type:'basic',front:'Simplify x^2.',back:'<code>\\frac{a}{b}</code>',why:'Practice powers and fractions.'};
 const clean={id:'math-cloze',type:'cloze',text:'The square is {{c1::\\(x^2\\)}}.',extra:'',why:'Recall notation.'};
 await page.locator('#importFile').setInputFiles({name:'anki_bundle.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({deck:pid,cards:[bad,clean]}))});
 await expect(page.locator('#importResult')).toContainText('2 new cards');
 await page.locator('#tabs button[data-tab=checker]').click();
 const old=await page.evaluate(()=>({...((window as any).eval('ck()'))}));
 try {
  for(const k of ['outside_refs','unshown_code','code_as_text','code_language','unshown_math']) await page.locator('#ck_'+k).selectOption('off');
  for(const k of ['math_as_text','math_in_code']) await page.locator('#ck_'+k).selectOption('warn');
  await page.locator('#tabs button[data-tab=review]').click();
  expect(await page.evaluate('S.curId')).toBe('math-basic');
  // The same keyboard approval action works on desktop and phones, outside field editors.
  await page.keyboard.press('d');
  await expect.poll(async()=> (await (await request.get('/api/project/'+pid)).json()).cards.find((c:any)=>c.id==='math-basic')?.status).toBe('ok');
  await page.locator('#tabs button[data-tab=revise]').click();
  await page.locator('#fmtScope').selectOption('flag');
  await page.locator('#fmtStatus').selectOption('any');
  await page.locator('#fqBuild').click();
  await expect(page.locator('#fqList')).toContainText('math-basic');
  await expect(page.locator('#fqList')).not.toContainText('math-cloze');
  const prompt=await page.evaluate(()=>(window as any).eval('fmtPrompt(fmtItems()[0].cards)'));
  expect(prompt).toContain('**Maths:**');expect(prompt).toContain('maths written as plain text');expect(prompt).toContain('maths inside code');
  const corrected={...bad,front:'Simplify \\(x^2\\).',back:'\\(\\frac{a}{b}\\)'};
  await page.locator('details:has(#fqPaste) summary').click();
  await page.locator('#fqPaste').fill(JSON.stringify({revision:true,cards:[corrected]}));
  await page.locator('#fqApply').click();
  await expect(page.locator('#fqResult')).toContainText('re-check');
  await expect.poll(async()=> (await (await request.get('/api/project/'+pid)).json()).cards.find((c:any)=>c.id==='math-basic')?.recheck).toBe(true);
  await page.reload();await page.waitForFunction('Store.on && curProject && S.cards.length===2');
  expect(await page.evaluate(()=>(window as any).eval("checksOf(S.cards.find(c=>c.id==='math-basic')).filter(x=>FMT_KEYS.has(x.key))"))).toEqual([]);
  await page.locator('#tabs button[data-tab=export]').click();
  await page.locator('input[name=exWhich][value=notdrop]').check();
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#btnExport').click();
  const download=await downloadPromise;
  const file=info.outputPath('math.apkg');await download.saveAs(file);
  const zip=await JSZip.loadAsync(await readFile(file));
  const SQL=await initSqlJs({locateFile:(f:string)=>nodeRequire.resolve('sql.js/dist/'+f)});
  const db=new SQL.Database(await zip.file('collection.anki2').async('uint8array'));
  try {
   expect(db.exec('select count(*) from notes')[0].values[0][0]).toBe(2);
   expect(db.exec('select count(*) from cards')[0].values[0][0]).toBe(2);
   const fields=db.exec('select flds from notes')[0].values.flat().join('\n');
   expect(fields).toContain('\\frac{a}{b}');expect(fields).toContain('{{c1::');expect(fields).not.toContain('<code>\\frac');
  } finally {db.close();}
 } finally {
  const settingsSaved=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
  await page.evaluate(C=>{(window as any).eval('SET').checks=C;(window as any).eval('saveSettings')();},old);
  await settingsSaved;
 }
});
