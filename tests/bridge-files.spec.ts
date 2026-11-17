import {test,expect,type Page} from '@playwright/test';
import {createRequire} from 'node:module';
// ▶ Run on Mac with real source files: every attachment must have a name the server (and the bridge) accepts, and two
// sources must never collapse into one file. A failed upload must not leave a job stuck "sending".
const nodeRequire=createRequire(process.cwd()+'/package.json');
const {PDFDocument,StandardFonts}=nodeRequire('pdf-lib');
const NAME_RE=/^[A-Za-z0-9][A-Za-z0-9 ._()+,=@#&'\-[\]]{0,180}$/;   // lib/store.ts
const headers={origin:'http://127.0.0.1:3098'};

async function pdf(label:string){
 const doc=await PDFDocument.create(), font=await doc.embedFont(StandardFonts.Helvetica);
 for (let n=1;n<=3;n++) doc.addPage([400,300]).drawText(`${label} page ${n}`,{x:30,y:200,size:14,font});
 return Buffer.from(await doc.save());
}
async function setup(page:Page,request:any,tag:string,names:string[]){
 for (const [url,file] of [['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','pdfjs-dist/build/pdf.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js','pdfjs-dist/build/pdf.worker.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js','pdf-lib/dist/pdf-lib.min.js']])
  await page.route(url,r=>r.fulfill({path:nodeRequire.resolve(file),contentType:'application/javascript'}));
 const pid=tag+Date.now().toString(36);
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 const dev=await (await request.post('/api/devices',{headers,data:{name:'files test'}})).json();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty && window.pdfjsLib');
 await page.locator('#tabs button[data-tab=sources]').click();
 for (const name of names){
  await page.locator('#srcFile').setInputFiles({name,mimeType:'application/pdf',buffer:await pdf(name)});
  await expect(page.locator('#srcList')).toContainText(name);
 }
 await page.evaluate(()=>(window as any).eval('loadDevices()'));
 await page.locator('#tabs button[data-tab=prompt]').click();
 await expect(page.locator('#runPrompt')).toBeVisible();
 return {pid,dev};
}
const cleanup=async(request:any,pid:string,dev:{id:string})=>{
 for (const j of await (await request.get('/api/jobs?project='+pid)).json()) await request.post(`/api/jobs/${j.id}/cancel`,{headers});
 await request.delete('/api/devices/'+dev.id,{headers});
};

test('Run on Mac: sources with any name arrive as separate files with accepted names, and cite the original names',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough');
 const names=['Lecture 1 – Intro.pdf','Café ünits.pdf','Week 1: Intro.pdf','Week 1? Intro.pdf'];
 const {pid,dev}=await setup(page,request,'bf',names);
 try {
  await page.locator('#runPrompt').click();
  await expect(page.locator('#brPill')).toContainText('1 waiting');
  const auth={authorization:`Bearer ${dev.token}`};
  const job=(await (await request.post('/api/bridge/claim',{headers:auth,data:{agents:['claude']}})).json()).job;
  expect(job).toBeTruthy();
  const pdfs=job.files.map((f:any)=>f.name).filter((n:string)=>n.endsWith('.pdf'));
  expect(pdfs.length).toBe(4);                                         // none dropped, none merged
  for (const n of pdfs) expect(n).toMatch(NAME_RE);
  const prompt=await (await request.get(`/api/bridge/jobs/${job.id}/in/anki_prompt.txt`,{headers:auth})).text();
  for (const n of pdfs) expect(prompt).toContain(`**${n}**`);          // the prompt names the files it really attached
  for (const n of names) expect(prompt).toContain(n);                  // and the originals to cite
  // a renamed PDF carries the original name in its page map, so the helper still cites "Lecture 1 – Intro.pdf p.N"
  const renamed=pdfs.find((n:string)=>n.startsWith('Lecture 1'));
  const bytes=Buffer.from(await (await request.get(`/api/bridge/jobs/${job.id}/in/${encodeURIComponent(renamed)}`,{headers:auth})).body());
  const doc=await PDFDocument.load(bytes);
  expect(doc.getKeywords()).toContain(`acs-pages=${encodeURIComponent('Lecture 1 – Intro.pdf')}:1,2,3`);
  expect(doc.getPageCount()).toBe(3);
 } finally { await cleanup(request,pid,dev); }
});

test('Run on Mac: a failed upload removes the half-sent job instead of leaving it "sending"',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough');
 const {pid,dev}=await setup(page,request,'bu',['lecture.pdf']);
 try {
  await page.route(/\/api\/jobs\/j[a-z0-9]+\/in\/lecture\.pdf/,r=>r.abort());
  await page.locator('#runPrompt').click();
  await expect(page.locator('#toast, .toast').first()).toContainText('Could not send it to your Mac');
  await expect.poll(async()=>(await (await request.get('/api/jobs?project='+pid)).json()).length).toBe(0);
  await expect(page.locator('#brPill')).toBeHidden();
 } finally { await cleanup(request,pid,dev); }
});
