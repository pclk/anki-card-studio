import {test,expect} from '@playwright/test';
// Offline editing in the online version: edits made without a connection are kept in the browser (a reload or a closed
// tab loses nothing), the app opens from those copies when offline, and everything goes to the account when the
// connection is back - merged 3-way with what other devices saved meanwhile.
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);
const DOT=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==','base64');
test.beforeEach(({},ti)=>test.skip(ti.project.name==='mobile','storage behaviour, the same on every screen'));

async function setup(page:any,request:any,baseURL:string,tag:string){
 const headers={origin:baseURL}, pid=tag+Date.now().toString(36), other=pid+'x';
 const cards=[{id:'c1',type:'basic',front:'Q1 <img src="dot.png">',back:'A1',why:'w',status:'new',extra:'',source:'',tags:[]},{id:'c2',type:'basic',front:'Q2',back:'A2',why:'w',status:'new',extra:'',source:'',tags:[]}];
 expect((await request.put(`/api/project/${pid}/media/dot.png`,{headers:{...headers,'content-type':'image/png'},data:DOT})).ok()).toBeTruthy();
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards,media:{'dot.png':{origin:'upload'}}}})).ok()).toBeTruthy();
 expect((await request.put('/api/project/'+other,{headers,data:{rev:1,projectName:other,deck:other,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:2,updated:Date.now()},{id:other,name:other,cards:0,updated:1}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>{ if(!sessionStorage.getItem('acs-test-init')){ sessionStorage.setItem('acs-test-init','1'); localStorage.setItem('acs-current',id); } },pid);
 page.on('dialog',(d:any)=>d.accept());
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.evaluate(()=>navigator.serviceWorker.ready);
 // the first visit isn't controlled by the worker yet: load once more so the page and the picture are kept
 await page.reload();await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 expect(await page.evaluate((u:string)=>fetch(u).then(r=>r.status),`/api/project/${pid}/media/dot.png`)).toBe(200);
 return {pid,other,headers};
}
const server=async(request:any,pid:string)=>(await request.get('/api/project/'+pid)).json();
async function otherDevice(request:any,headers:any,pid:string,change:(st:any)=>void){
 const st=await server(request,pid); change(st);
 const r=await request.put('/api/project/'+pid,{headers:{...headers,'X-ACS-Base-Rev':String(st.rev)},data:{...st,rev:st.rev+1}});
 expect(r.ok()).toBeTruthy();
}
async function goOffline(page:any,context:any){
 await context.setOffline(true);
 await page.reload();await page.waitForFunction('typeof Store!=="undefined" && Store.offline && curProject && S.cards',undefined,{timeout:15000});
}

test('edits survive offline reloads and merge with another device when the connection is back',async({page,context,request,baseURL})=>{
 const {pid,other,headers}=await setup(page,request,baseURL!,'off');
 // the connection drops in an open tab: the failed save leaves a copy in this browser
 await context.setOffline(true);
 await ev(page,"cardById('c1').front='offline A <img src=\"dot.png\">';save();");
 await page.waitForFunction('sync.kept && sync.state==="error"',undefined,{timeout:10000});
 // closing / reloading the tab offline opens the Studio from this browser, with the edit
 await page.reload();await page.waitForFunction('typeof Store!=="undefined" && Store.offline && curProject && S.cards',undefined,{timeout:15000});
 expect(await ev(page,'curProject')).toBe(pid);
 expect(await ev(page,"cardById('c1').front")).toContain('offline A');
 expect(await ev(page,'sync.state')).toBe('offline');
 await expect(page.locator('#syncInfo')).toContainText('Offline');
 // the card's picture still shows (kept by the service worker)
 await page.locator('#tabs button[data-tab="review"]').click();
 await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[...e.shadowRoot.querySelectorAll('img')]:[]).some(i=>/dot\.png$/.test(i.src)&&i.complete&&i.naturalWidth>0))).toBe(true);
 // more offline edits are kept too
 await ev(page,"cardById('c2').back='offline B';save();");
 await expect.poll(()=>ev(page,`Store.getPending('${pid}').then(p=>p&&p.json.includes('offline B'))`)).toBe(true);
 // a project this browser never opened can't open offline: the current one stays
 await ev(page,`switchProject('${other}')`);
 expect(await ev(page,'curProject')).toBe(pid);
 // deleting needs the account
 await ev(page,"$('#btnDeleteProject').onclick()");
 expect((await request.get('/api/project/'+pid)).ok()).toBeTruthy();
 // another device saves a different change meanwhile
 await otherDevice(request,headers,pid,st=>{st.cards.find((c:any)=>c.id==='c2').front='Q2 from the phone';});
 await context.setOffline(false);
 await expect.poll(async()=>{const st=await server(request,pid);const c1=st.cards.find((c:any)=>c.id==='c1'),c2=st.cards.find((c:any)=>c.id==='c2');return [c1.front.includes('offline A'),c2.back,c2.front];},{timeout:30000})
  .toEqual([true,'offline B','Q2 from the phone']);
 await page.waitForFunction('Store.on && sync.state==="ok" && !sync.dirty',undefined,{timeout:15000});
 expect(await ev(page,'Store.pendingIds()')).toEqual([]);
 expect(await ev(page,"cardById('c2').front")).toBe('Q2 from the phone');
});

test('the same field changed offline and on another device asks which to keep',async({page,context,request,baseURL})=>{
 const {pid,headers}=await setup(page,request,baseURL!,'offc');
 await goOffline(page,context);
 await ev(page,"cardById('c2').back='A2 offline';save();");
 await expect.poll(()=>ev(page,`Store.getPending('${pid}').then(p=>!!p)`)).toBe(true);
 await otherDevice(request,headers,pid,st=>{st.cards.find((c:any)=>c.id==='c2').back='A2 phone';});
 await context.setOffline(false);
 await expect(page.locator('#syncDlg')).toBeVisible({timeout:30000});
 await page.locator('#syncApply').click();   // "this window" is chosen by default
 await expect.poll(async()=>(await server(request,pid)).cards.find((c:any)=>c.id==='c2').back,{timeout:15000}).toBe('A2 offline');
 await expect.poll(()=>ev(page,'Store.pendingIds()')).toEqual([]);
});

test('a project made offline and edits to another project reach the account',async({page,context,request,baseURL})=>{
 const {pid}=await setup(page,request,baseURL!,'offn');
 await goOffline(page,context);
 await ev(page,"newProject('Made offline')");
 const made=await ev(page,'curProject');
 expect(made).not.toBe(pid);
 await ev(page,"S.cards.push(normCard({id:'n1',type:'basic',front:'new Q',back:'new A',why:'w'}));save();");
 await expect.poll(()=>ev(page,`Store.getPending('${made}').then(p=>p&&p.json.includes('new Q'))`)).toBe(true);
 // back to the first project (it was cached), edit it, then reload: both are still kept
 await ev(page,`switchProject('${pid}')`);
 expect(await ev(page,'curProject')).toBe(pid);
 await ev(page,"S.projectName='Renamed offline';save();");
 await expect.poll(()=>ev(page,`Store.getPending('${pid}').then(p=>p&&p.json.includes('Renamed offline'))`)).toBe(true);
 await page.reload();await page.waitForFunction('typeof Store!=="undefined" && Store.offline && curProject',undefined,{timeout:15000});
 expect(await ev(page,'S.projectName')).toBe('Renamed offline');
 expect(await ev(page,'projects.some(p=>p.name==="Made offline")')).toBe(true);
 await context.setOffline(false);
 await expect.poll(async()=>(await server(request,pid)).projectName,{timeout:30000}).toBe('Renamed offline');
 // the other project isn't open: it goes up in the background
 await expect.poll(async()=>{const r=await request.get('/api/project/'+made);return r.ok()?(await r.json()).cards.map((c:any)=>c.front):null;},{timeout:30000}).toEqual(['new Q']);
 await expect.poll(async()=>(await (await request.get('/api/projects')).json()).some((p:any)=>p.id===made)).toBe(true);
 await expect.poll(()=>ev(page,'Store.pendingIds()')).toEqual([]);
});

test('signing out removes the copies kept for offline use',async({page,context,request,baseURL})=>{
 const {pid}=await setup(page,request,baseURL!,'offs');
 await goOffline(page,context);
 await ev(page,"S.projectName='not sent';save();");
 await expect.poll(()=>ev(page,`Store.getPending('${pid}').then(p=>!!p)`)).toBe(true);
 await context.setOffline(false);
 await page.waitForFunction('Store.on',undefined,{timeout:30000});
 await expect.poll(()=>ev(page,'Store.pendingIds()')).toEqual([]);
 // a pending edit again (the account refuses it for now), so signing out has to ask
 await page.route('**/api/project/'+pid,(r:any)=>r.request().method()==='PUT'?r.fulfill({status:503,body:'down'}):r.continue());
 await ev(page,"S.projectName='still not sent';save();");
 await page.waitForFunction('sync.kept && sync.state==="error"',undefined,{timeout:10000});
 await page.route('**/api/auth/signout',(r:any)=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>bye</title>'}));
 let asked='';page.removeAllListeners('dialog');page.on('dialog',(d:any)=>{asked=d.message();d.accept();});
 await page.locator('#btnSignOut').evaluate((a:HTMLElement)=>a.click());
 await page.waitForURL('**/api/auth/signout');
 expect(asked).toContain("haven't reached your account");
 const left=await page.evaluate(()=>new Promise<string[]>(res=>{const r=indexedDB.open('anki-card-studio',1);r.onsuccess=()=>{const g=r.result.transaction('kv').objectStore('kv').getAllKeys();g.onsuccess=()=>res(g.result.map(String));};}));
 expect(left.filter(k=>/^(off:|cache:project:)/.test(k))).toEqual([]);
 expect(await page.evaluate(()=>caches.has('acs-media'))).toBe(false);
 expect(await page.evaluate(()=>localStorage.getItem('acs-user'))).toBeNull();
});
