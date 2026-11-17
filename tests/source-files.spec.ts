import {test,expect,type Page} from '@playwright/test';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Prompts send the ORIGINAL source files (Claude has code execution), not just their text: Copy puts the prompt on
// the clipboard and downloads the files; a batch part gets only its pages of a PDF, with the original page numbers.
const nodeRequire=createRequire(process.cwd()+'/package.json');
const {PDFDocument,StandardFonts}=nodeRequire('pdf-lib');
// a python with pymupdf for the helper half (the skill always has it); CI installs it, locally set ACS_PYTHON
const PY=process.env.ACS_PYTHON||'python3';
const hasPymupdf=(()=>{ try { execFileSync(PY,['-c','import pymupdf']); return true; } catch { return false; } })();

async function lecturePdf(){
 const doc=await PDFDocument.create(), font=await doc.embedFont(StandardFonts.Helvetica);
 for (let n=1;n<=6;n++) doc.addPage([400,300]).drawText(`Page ${n}: fact number ${n} about classes.`,{x:30,y:200,size:14,font});
 return Buffer.from(await doc.save());
}
async function setup(page:Page,request:any,info:any,tag:string,cards:any[]=[]){
 for (const [url,file] of [['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','pdfjs-dist/build/pdf.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js','pdfjs-dist/build/pdf.worker.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js','pdf-lib/dist/pdf-lib.min.js']])
  await page.route(url,r=>r.fulfill({path:nodeRequire.resolve(file),contentType:'application/javascript'}));
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 const pid=tag+Date.now().toString(36)+info.project.name, headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:cards.length,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty && window.pdfjsLib');
 const pdf=await lecturePdf();
 await page.locator('#tabs button[data-tab=sources]').click();
 await page.locator('#srcFile').setInputFiles({name:'lecture.pdf',mimeType:'application/pdf',buffer:pdf});
 await expect(page.locator('#srcList')).toContainText('lecture.pdf');
 return pdf;
}
const downloads=async(page:Page,n:number,click:()=>Promise<void>)=>{
 const got:any[]=[]; const on=(d:any)=>got.push(d); page.on('download',on);
 await click(); await expect.poll(()=>got.length,{timeout:15000}).toBe(n); page.off('download',on); return got;
};
const clip=(page:Page)=>page.evaluate(()=>navigator.clipboard.readText());

test('single prompt: Copy puts the prompt on the clipboard and downloads the original file; pasted text stays as text',async({page,request},info)=>{
 const pdf=await setup(page,request,info,'sf');
 await page.locator('details:has(#srcPaste) summary').click();
 await page.locator('#srcPasteName').fill('my notes');
 await page.locator('#srcPaste').fill('Objects bundle state and behaviour.');
 await page.locator('#btnSrcPaste').click();
 await expect(page.locator('#srcList')).toContainText('my notes');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await expect(page.locator('#pAttachInfo')).toContainText('lecture.pdf');
 const [dl]=await downloads(page,1,()=>page.locator('#btnCopyPrompt').click());
 expect(dl.suggestedFilename()).toBe('lecture.pdf');
 const dir=mkdtempSync(join(tmpdir(),'acs-sf-')); await dl.saveAs(join(dir,'lecture.pdf'));
 expect(readFileSync(join(dir,'lecture.pdf')).equals(pdf)).toBe(true);     // the very file that was added
 const prompt=await clip(page);
 expect(prompt).toContain('## The material: attached files');
 expect(prompt).toContain('**lecture.pdf**: the whole file');
 expect(prompt).not.toContain('fact number 3');                         // the PDF's text is not pasted in
 expect(prompt).not.toContain('You cannot crop figures');
 expect(prompt).toMatch(/## Source material \(text sources with no file\)[\s\S]*<<<SOURCE id=s-[0-9a-f]{8}\n\[my notes p\.1\]\nObjects bundle state/);
 // "⬇ Source files" downloads it again
 const [again]=await downloads(page,1,()=>page.locator('#btnSrcFiles').click());
 expect(again.suggestedFilename()).toBe('lecture.pdf');
});

test('batch: each prompt gets only its pages of the PDF, and the helper cites the original pages',async({page,request},info)=>{
 await setup(page,request,info,'sfb');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#flowSeg button[data-flow=batch]').click();
 await page.locator('#qPasteWrap summary').click();
 await page.locator('#qPaste').fill(JSON.stringify({items:[{id:'P1',title:'Part one',sources:[{file:'lecture.pdf',pages:'3-5'}]},{id:'P2',title:'Part two',sources:[{file:'lecture.pdf',pages:'6'}]}]}));
 await page.locator('#btnQPaste').click();
 await expect(page.locator('#qList')).toContainText('lecture_p3-5.pdf');
 const [dl]=await downloads(page,1,()=>page.locator('#btnCopyNext').click());
 expect(dl.suggestedFilename()).toBe('lecture_p3-5.pdf');
 const dir=mkdtempSync(join(tmpdir(),'acs-sfb-')), path=join(dir,'lecture_p3-5.pdf'); await dl.saveAs(path);
 const ex=await PDFDocument.load(readFileSync(path),{updateMetadata:false});
 expect(ex.getPageCount()).toBe(3);
 expect(ex.getKeywords()).toBe('acs-pages=lecture.pdf:3,4,5');
 const prompt=await clip(page);
 expect(prompt).toContain('part 1 of 2 - Part one');
 expect(prompt).toContain('**lecture_p3-5.pdf**: pages 3-5 of lecture.pdf, in order (page 1 of the attachment is lecture.pdf p.3)');
 expect(prompt).not.toContain('<<<SOURCE');
 await expect(page.locator('#qList .qi').first()).toContainText('copied');
 // the row's ⬇ downloads the part's file again
 const [again]=await downloads(page,1,()=>page.locator('#qList button[data-q=files]').first().click());
 expect(again.suggestedFilename()).toBe('lecture_p3-5.pdf');
 if (hasPymupdf){
  const out=execFileSync(PY,['-c',`import sys,json;sys.path.insert(0,'skill/anki/scripts')\nfrom anki_helper import *\nd=Deck("x");d.load_source(${JSON.stringify(path)})\nprint(json.dumps([orig_page(${JSON.stringify(path)},2),{f:sorted(p) for f,p in d.source_pages.items()},"fact number 4" in d.source_pages["lecture.pdf"][4]]))`],
   {env:{...process.env,ANKI_OUT_DIR:mkdtempSync(join(tmpdir(),'acs-sfb-out-'))},encoding:'utf8'}).trim().split('\n').pop()!;
  expect(JSON.parse(out)).toEqual([['lecture.pdf',4],{'lecture.pdf':[3,4,5]},true]);
 }
});

test('image fix: the prompt attaches the source pages the cards point at, to re-snip from',async({page,request},info)=>{
 const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
 await setup(page,request,info,'sfi');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#importFile').setInputFiles({name:'anki_bundle.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({cards:[
  {id:'f1',type:'basic',front:'<img src="fig.png">What is shown?',back:'A class diagram',why:'w',refs:[{file:'lecture.pdf',page:4,quote:'fact number 4 about classes'}]}],media:[{filename:'fig.png',data:PNG}]}))});
 await expect(page.locator('#importResult')).toContainText('1 new card');
 await page.evaluate(()=>(window as any).eval(`setImgVerdict('fig.png','broken','cut off')`));
 await page.locator('#tabs button[data-tab=revise]').click();
 const [dl]=await downloads(page,1,()=>page.locator('#biCopy').click());
 expect(dl.suggestedFilename()).toBe('lecture_p4.pdf');
 const prompt=await clip(page);
 expect(prompt).toContain('**lecture_p4.pdf**: page 4 of lecture.pdf (page 1 of the attachment is lecture.pdf p.4)');
 expect(prompt).toContain('<<<REVISE_CARDS id=r-');
});
