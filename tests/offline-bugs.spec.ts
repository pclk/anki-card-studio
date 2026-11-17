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


// Bug: keepPending overwrites another offline tab's independent edits for the same project.
test('two offline tabs preserve independent card edits after reload',async({page,context,request,baseURL})=>{
 const {pid}=await setup(page,request,baseURL!,'two');
 const second=await context.newPage();
 await second.goto('/'); await second.waitForFunction('Store.on && curProject && !sync.dirty');
 await goOffline(page,context);
 await second.reload(); await second.waitForFunction('typeof Store!=="undefined" && Store.offline && curProject');
 await ev(page,"cardById('c1').back='first tab edit';(async()=>{await writeState();})()");
 await expect.poll(()=>ev(page,`Store.getPending('${pid}').then(p=>JSON.parse(p.json).cards[0].back)`)).toBe('first tab edit');
 await ev(second,"cardById('c2').back='second tab edit';(async()=>{await writeState();})()");
 await page.reload(); await page.waitForFunction('typeof Store!=="undefined" && Store.offline && curProject');
 expect(await ev(page,"cardById('c2').back")).toBe('second tab edit');
 expect(await ev(page,"cardById('c1').back")).toBe('first tab edit');
});

// Bug: choosing the remote version leaves rejected pending edits behind when no write is needed.
test('choosing all remote changes clears pending edits',async({page,context,request,baseURL})=>{
 const {pid,headers}=await setup(page,request,baseURL!,'reject');
 await goOffline(page,context);
 await ev(page,"cardById('c2').back='rejected offline edit';(async()=>{await writeState();})()");
 expect(await ev(page,`Store.getPending('${pid}').then(p=>!!p)`)).toBe(true);
 await otherDevice(request,headers,pid,st=>{st.cards.find((c:any)=>c.id==='c2').back='accepted phone edit';});
 await context.setOffline(false);
 await expect(page.locator('#syncDlg')).toBeVisible({timeout:30000});
 await page.locator('#syncTheirs').click(); await page.locator('#syncApply').click();
 await page.waitForFunction('sync.state==="ok" && !sync.dirty');
 expect(await ev(page,"cardById('c2').back")).toBe('accepted phone edit');
 await expect.poll(()=>ev(page,'Store.pendingIds()')).toEqual([]);
});
