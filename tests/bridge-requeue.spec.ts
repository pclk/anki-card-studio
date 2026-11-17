import {test,expect} from '@playwright/test';
// What a Mac job leaves behind when it doesn't work out: a prompt that failed or was cancelled on the Mac is "to do"
// again (so "Run all on Mac" sends it again), and a result whose download failed is fetched again without a reload.
const headers={origin:'http://127.0.0.1:3098'};
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);

async function setup(page:any,request:any,tag:string){
 // every test shares the e2e account and the bridge takes its oldest waiting job: start with none
 for(const j of await (await request.get('/api/jobs')).json()){ await request.post(`/api/jobs/${j.id}/cancel`,{headers}); await request.delete(`/api/jobs/${j.id}`,{headers}); }
 const pid=tag+Date.now().toString(36);
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 const dev=await (await request.post('/api/devices',{headers,data:{name:'Requeue Mac'}})).json();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty',undefined,{timeout:8000});
 await page.waitForFunction('BR.devices && BR.devices.length');
 page.on('dialog',(d:any)=>d.accept());
 return {pid,dev,bearer:{authorization:`Bearer ${dev.token}`}};
}
/** the Mac takes the oldest waiting job and ends it the way the test says */
async function macEnds(request:any,bearer:any,how:'fail'|'cancel'|'ok'){
 const job=(await (await request.post('/api/bridge/claim',{headers:bearer,data:{agents:['claude']}})).json()).job;
 expect(job).toBeTruthy();
 if(how==='cancel') expect((await request.post(`/api/jobs/${job.id}/cancel`,{headers})).ok()).toBeTruthy();
 else {
  if(how==='ok') expect((await request.put(`/api/bridge/jobs/${job.id}/out/anki_bundle.json`,{headers:{...bearer,'content-type':'application/json'},
   data:JSON.stringify({format:'anki-studio/v1',deck:'D',cards:[{id:'rq-c001',type:'basic',front:'Q?',back:'A',why:'w'}]})})).ok()).toBeTruthy();
  expect((await request.post(`/api/bridge/jobs/${job.id}/finish`,{headers:bearer,data:{ok:how==='ok',error:how==='ok'?'':'model overloaded'}})).ok()).toBeTruthy();
 }
 return job;
}

test('a batch prompt that failed or was cancelled on the Mac is to do again; a manual copy is never undone',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','server-side jobs: one browser is enough');
 const {dev,bearer}=await setup(page,request,'rq');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#flowSeg button[data-flow=batch]').click();
 await page.locator('#qPasteWrap summary').click();
 await page.locator('#qPaste').fill(JSON.stringify({deck_root:'D',items:[{id:'L01',title:'Classes',content:'A class is a blueprint.'},{id:'L02',title:'Objects',content:'An object is an instance.'}]}));
 await page.locator('#btnQPaste').click();
 await page.locator('#runQueue').click();
 await expect.poll(()=>ev(page,'S.batch.items.map(i=>i.status).join()')).toBe('copied,copied');

 const j1=await macEnds(request,bearer,'fail');
 const j2=await macEnds(request,bearer,'cancel');
 await ev(page,'pollJobs()');
 await expect.poll(()=>ev(page,'S.batch.items.map(i=>i.status).join()')).toBe('todo,todo');
 await expect(page.locator('#qList')).not.toContainText('copied');
 // it happens once: a reload doesn't touch an item the user has since copied by hand
 await ev(page,`S.batch.items[0].status='copied'; S.batch.items[0].copiedAt=Date.now(); save()`);
 await page.waitForFunction('!sync.dirty');
 await page.reload();await page.waitForFunction('Store.on && curProject && !sync.dirty && S.batch');
 await ev(page,'pollJobs()');await page.waitForTimeout(800);
 expect(await ev(page,'S.batch.items.map(i=>i.status).join()')).toBe('copied,todo');
 // and sending again works: only the to-do one goes
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#runQueue').click();
 await expect.poll(()=>ev(page,'BR.jobs.filter(j=>j.status==="queued").map(j=>j.meta.batchItem).join()')).toBe('L02');
 for(const id of [j1.id,j2.id]) await request.delete(`/api/jobs/${id}`,{headers});
 await request.delete(`/api/devices/${dev.id}`,{headers});
});

test('a formatting prompt that failed on the Mac is to do again',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','server-side jobs: one browser is enough');
 const {dev,bearer}=await setup(page,request,'rqf');
 await ev(page,`S.cards=[{id:'f-c001',type:'basic',front:'Q?',back:'A',why:'w',status:'new',feedback:'',fmt:'F1',fmtSt:'todo'}]; save(); renderFmtPass()`);
 await page.waitForFunction('!sync.dirty');
 await ev(page,`$('#runFmt').onclick()`);
 await expect.poll(()=>ev(page,'S.cards[0].fmtSt')).toBe('copied');
 const j=await macEnds(request,bearer,'fail');
 await ev(page,'pollJobs()');
 await expect.poll(()=>ev(page,'S.cards[0].fmtSt')).toBe('todo');
 expect(await ev(page,'fmtItems("F")[0].status')).toBe('todo');
 await request.delete(`/api/jobs/${j.id}`,{headers});
 await request.delete(`/api/devices/${dev.id}`,{headers});
});

test('a result whose download failed is imported on a later poll, without a reload',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','server-side jobs: one browser is enough');
 const {dev,bearer}=await setup(page,request,'rqi');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#runPrompt').click();
 await expect(page.locator('#brPill')).toContainText('1 waiting');
 // the first download of the result fails (a network blip); later ones work
 let calls=0;
 await page.route('**/api/jobs/*/out/anki_bundle.json*',r=>calls++===0?r.abort():r.continue());
 await ev(page,'BR.retryMs=300');
 const j=await macEnds(request,bearer,'ok');
 await ev(page,'pollJobs()');
 await expect.poll(()=>ev(page,'S.cards.map(c=>c.id).join()'),{timeout:15000}).toBe('rq-c001');
 expect(calls).toBeGreaterThanOrEqual(2);
 await request.delete(`/api/jobs/${j.id}`,{headers});
 await request.delete(`/api/devices/${dev.id}`,{headers});
});
