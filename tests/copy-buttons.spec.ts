import {test,expect,type Page} from '@playwright/test';
// Prompt Copy defaults to hidden, including without a Mac. Manual transfer reveals it and persists the preference.
const headers={origin:'http://127.0.0.1:3098'};
const COPY=['#btnCopyPrompt'], BATCH=['#btnCopyNext','#batchOut .optPromptFile','#qList [data-q=copy]'];

async function open(page:Page,request:any,tag:string){
 const pid=tag+Date.now().toString(36);
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
 return pid;
}
const toBatch=async(page:Page)=>{
 await page.locator('#flowSeg button[data-flow=batch]').click();
 if (!(await page.locator('#qList .qi').count())){
  await page.locator('#qPasteWrap summary').click();
  await page.locator('#qPaste').fill(JSON.stringify({deck_root:'D',items:[{id:'L01',title:'Classes',content:'[n.txt p.1]\nA class is a blueprint.'},{id:'L02',title:'Objects',content:'[n.txt p.2]\nAn object is an instance.'}]}));
  await page.locator('#btnQPaste').click();
 }
 await expect(page.locator('#qList .qi')).toHaveCount(2);
};
const setShowCopy=async(page:Page,on:boolean)=>{
 await page.evaluate(()=>(window as any).eval('toggleSidebar(true)'));
 await page.locator('#btnSettings').click();
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
 if (on) await page.locator('#setCopy').check(); else await page.locator('#setCopy').uncheck();
 await saved;
 await page.locator('#setClose').click();
};

test('Copy buttons: hidden by default with or without a Mac; Manual transfer and Settings reveal them',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough');
 const pid=await open(page,request,'cpy');
 let dev:{id:string}|null=null;
 try {
  // No Mac: Manual transfer is the visible fallback and saves the reveal preference.
  expect(await page.evaluate(()=>(window as any).eval('SET.showCopy'))).toBe(false);
  for (const q of COPY) await expect(page.locator(q)).toBeHidden();
  await expect(page.locator('#runPrompt')).toBeHidden();
  await page.locator('#singleOut .manualTransfer').click();
  for (const q of COPY) await expect(page.locator(q)).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then(j=>j.showCopy))).toBe(true);
  await page.reload();
  await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty');
  await page.locator('#tabs button[data-tab=prompt]').click();
  for (const q of COPY) await expect(page.locator(q)).toBeVisible();
  await setShowCopy(page,false);

  // a Mac is paired: Copy goes, ▶ Run on Mac is the main button
  dev=await (await request.post('/api/devices',{headers,data:{name:'copy test'}})).json();
  await page.evaluate(()=>(window as any).eval('loadDevices()'));
  await expect(page.locator('#runPrompt')).toBeVisible();
  for (const q of COPY) await expect(page.locator(q)).toBeHidden();
  await expect(page.locator('#singleOut .optPromptFile')).toBeHidden();
  await expect(page.locator('#runPrompt')).toHaveClass(/\bprimary\b/);
  // out of the tab order: a hidden button can't take focus, and Tab from Run on Mac goes past it
  await page.locator('#btnCopyPrompt').evaluate(b=>(b as HTMLElement).focus());
  expect(await page.evaluate(()=>document.activeElement?.id)).not.toBe('btnCopyPrompt');
  await page.locator('#runPrompt').focus();
  for (let i=0;i<4;i++){ await page.keyboard.press('Tab'); expect(await page.evaluate(()=>!!document.activeElement?.closest('.copyBtn'))).toBe(false); }
  // the batch queue: no Copy next, no 📋 per row, and N does nothing
  await toBatch(page);
  await expect(page.locator('#runQueue')).toBeVisible();
  for (const q of BATCH) await expect(page.locator(q).first()).toBeHidden();
  await page.locator('body').click({position:{x:2,y:2}});
  await page.keyboard.press('n');
  await expect(page.locator('#qList .qi.todo')).toHaveCount(2);   // nothing was copied
  // the row's other buttons still work and keep their place
  await expect(page.locator('#qList [data-q=view]').first()).toBeVisible();
  await expect(page.locator('#qList [data-q=done]').first()).toBeVisible();

  // Settings → show them: everything is back, N copies again, and it stays after a reload
  await setShowCopy(page,true);
  for (const q of BATCH) await expect(page.locator(q).first()).toBeVisible();
  await expect(page.locator('#runQueue')).not.toHaveClass(/\bprimary\b/);
  await page.locator('body').click({position:{x:2,y:2}});
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.keyboard.press('n');
  await expect(page.locator('#qList .qi.copied')).toHaveCount(1);
  await page.reload();await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty && BR.devices && BR.devices.length');
  expect(await page.evaluate(()=>(window as any).eval('SET.showCopy'))).toBe(true);
  await page.locator('#tabs button[data-tab=prompt]').click();
  await page.locator('#flowSeg button[data-flow=single]').click();
  for (const q of COPY) await expect(page.locator(q)).toBeVisible();
  await expect(page.locator('#runPrompt')).toBeVisible();

  // and hidden again
  await setShowCopy(page,false);
  for (const q of COPY) await expect(page.locator(q)).toBeHidden();
 } finally {
  // the setting and the devices are shared by every test (one user): leave them as they were
  await page.evaluate(()=>{ const w=window as any; w.eval('SET.showCopy=false; saveSettings()'); });
  await expect.poll(()=>page.evaluate(()=>fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then(j=>!!(j&&j.showCopy)))).toBe(false);
  if (dev) await request.delete('/api/devices/'+dev.id,{headers});
  await request.delete('/api/project/'+pid,{headers}).catch(()=>{});
 }
});

test('settings saved before the option existed hide Copy too',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough');
 // an older Studio's settings: no showCopy at all (the user's real settings are put back afterwards)
 const before=await (await request.get('/api/settings',{headers})).text();
 expect((await request.put('/api/settings',{headers,data:{version:2,showAnalytics:true,promptFile:false,bridgeAgent:'claude'}})).ok()).toBeTruthy();
 const dev=await (await request.post('/api/devices',{headers,data:{name:'old settings'}})).json();
 const pid=await open(page,request,'cpo');
 try {
  await page.waitForFunction('BR.devices && BR.devices.length');
  expect(await page.evaluate(()=>(window as any).eval('SET.showCopy'))).toBe(false);
  await expect(page.locator('#btnCopyPrompt')).toBeHidden();
  await expect(page.locator('#runPrompt')).toBeVisible();
  await page.evaluate(()=>(window as any).eval('toggleSidebar(true)'));
  await page.locator('#btnSettings').click();
  await expect(page.locator('#setCopy')).not.toBeChecked();
  await page.locator('#setClose').click();
 } finally {
  await request.delete('/api/devices/'+dev.id,{headers});
  await request.delete('/api/project/'+pid,{headers}).catch(()=>{});
  await request.put('/api/settings',{headers,data:before&&before!=='null'?JSON.parse(before):{}});
 }
});
