import {test,expect} from '@playwright/test';
test.beforeEach(async ({page,request},info)=>{
 const id='test'+Date.now().toString(36)+info.testId.replace(/[^a-z0-9]/gi,'').slice(-12);
 const headers={origin:'http://127.0.0.1:3098'};
 const r=await request.put('/api/project/'+id,{headers,data:{rev:1,deck:id,projectName:id,cards:[{id:id+'seed',type:'basic',front:'Seed question',back:'Seed answer',status:'new'}]}});
 expect(r.ok()).toBeTruthy();
 await request.put('/api/projects',{headers,data:[{id,name:id,cards:1,updated:Date.now()}]});
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),id);
});
test('approval made with a real click (desktop) or swipe (phone) persists for the imported card',async({page},info)=>{
 const tag=`rv${Date.now().toString(36)}${info.project.name}`;
 await page.goto('/');
 await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click({timeout:5000});
 await page.evaluate(()=>document.querySelector('details:has(#importText)')?.setAttribute('open',''));
 await page.locator('#importText').fill(JSON.stringify({deck:tag,cards:[{id:tag+'-a',type:'basic',front:`<img src=x onerror="window.pwned=1">Q ${tag}`,back:'A'}]}));
 await page.locator('#btnImport').click({timeout:5000});
 await expect(page.locator('#importResult')).toContainText(/Imported|updated/);
 await page.locator('#tabs button[data-tab=review]').click({timeout:5000});
 // the shared e2e database may hold unreviewed cards from earlier runs: open this run's card explicitly
 await page.evaluate(id=>{(window as any).eval('S').curId=id;(window as any).eval('renderReview')();},tag+'-a');
 await expect(page.locator('body')).toContainText(`Q ${tag}`);
 // the hostile attribute never reaches the rendered card
 expect(await page.locator('[onerror]').count()).toBe(0);
 if (info.project.name==='mobile'){
  // phones hide the approve button: approve with a real right swipe on the card (CDP touch events)
  const host=page.locator('.preview-host:not(.swipe-ghost)').first();
  await host.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const box=(await host.boundingBox())!;
  const cdp=await page.context().newCDPSession(page), y=box.y+box.height/2;
  const touch=(type:'touchStart'|'touchMove'|'touchEnd',x:number)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  await touch('touchStart',box.x+40);
  for (let x=box.x+60;x<=box.x+box.width-20;x+=30) { await touch('touchMove',x); await page.waitForTimeout(20); }
  await touch('touchEnd',0);
 } else await page.locator('#stOk').click({timeout:5000});
 const stored=async()=>page.evaluate(async id=>{
  const pid=(window as any).eval('curProject');const p=await (await fetch('/api/project/'+encodeURIComponent(pid),{cache:'no-store'})).json();
  return (p.cards||[]).find((c:any)=>c.id===id)?.status;},tag+'-a');
 await expect.poll(stored,{timeout:15000}).toBe('ok');
 await page.reload();
 await page.waitForFunction('Store.on && curProject');
 await expect.poll(stored).toBe('ok');
 expect(await page.evaluate(()=>(window as any).pwned)).toBeUndefined();
});
test('offline reload shows the offline state instead of the browser-only mode',async({page,context})=>{
 await page.goto('/');await page.waitForFunction('Store.on && curProject');
 await page.evaluate(()=>navigator.serviceWorker?.ready);
 // the first visit is not controlled by the worker yet, so it is not cached: load once more while online
 await page.reload();await page.waitForFunction('Store.on && curProject');
 await context.setOffline(true);
 await page.reload();
 await page.waitForFunction('typeof Store!=="undefined" && Store.status && Store.status!=="detecting"',undefined,{timeout:10000}).catch(()=>{});
 expect(await page.evaluate('Store.status')).toBe('offline');
 await context.setOffline(false);
});
test('a tab restores its edits after another device deletes its project',async({page})=>{
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.waitForFunction('sync.base && S.cards.length > 0');
 const pid=await page.evaluate('curProject');
 await page.evaluate(async id=>{const r=await fetch('/api/project/'+id,{method:'DELETE'});if(!r.ok)throw Error('delete failed');},pid);
 page.on('dialog',dialog=>dialog.accept());
 await page.evaluate(()=>{(window as any).eval("S.projectName='Restored from stale tab';save();");});
 await expect.poll(async()=>page.evaluate(async id=>{const r=await fetch('/api/project/'+id);return r.ok?(await r.json()).projectName:null;},pid),{timeout:15000}).toBe('Restored from stale tab');
 expect(await page.evaluate('sync.paused')).toBe(false);
});
