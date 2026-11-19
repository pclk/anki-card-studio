import {test,expect} from '@playwright/test';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {writeFileSync,mkdirSync} from 'node:fs';
// The source picture of a card with a section box: exactly that section of the PDF page, sharp enough to read, with the
// quote highlighted inside it - and without a box, the band around the quote as before.
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);

async function pdf(){
 const doc=await PDFDocument.create(), p=doc.addPage([600,800]), f=await doc.embedFont(StandardFonts.Helvetica);
 p.drawText('Lecture 3 - Networks',{x:50,y:740,size:20,font:f});
 p.drawText('TCP guarantees in-order, reliable delivery of a byte stream.',{x:50,y:600,size:12,font:f});
 p.drawText('It retransmits lost segments and controls congestion.',{x:50,y:584,size:12,font:f});
 p.drawRectangle({x:300,y:200,width:250,height:150,color:rgb(0.2,0.4,0.8)});   // a "figure"
 p.drawText('Figure 1: a link',{x:340,y:180,size:10,font:f});
 p.drawText('UDP makes no delivery guarantees at all.',{x:50,y:300,size:12,font:f});
 return Buffer.from(await doc.save());
}

test('a section box crops the source picture to exactly that section',async({page},info)=>{
 test.skip(info.project.name!=='desktop','one browser is enough');
 await page.goto('/');await page.waitForFunction('Store.on && curProject && window.pdfjsLib');
 const b64=(await pdf()).toString('base64');
 const shots=JSON.parse(await ev(page,`(async()=>{
   const bytes=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));
   const src={id:'sx-test',name:'net.pdf',kind:'pdf'};
   srcDocCache.set(src.id, await pdfjsLib.getDocument({data:bytes}).promise);
   const out={};
   const one=async(k,ref)=>{ const s=await refSnapshot(src,ref); const bm=await createImageBitmap(s.blob);
     out[k]={w:bm.width,h:bm.height,found:s.found,url:await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(s.blob);})}; };
   const quote='TCP guarantees in-order, reliable delivery';
   await one('paragraph',{page:1,quote,box:[0.07,0.24,0.93,0.29]});        // the TCP paragraph
   await one('figure',{page:1,quote:'',box:[0.48,0.55,0.95,0.79]});         // the blue figure and its caption
   await one('nobox',{page:1,quote});
   srcDocCache.delete(src.id);
   return JSON.stringify(out);
 })()`));
 mkdirSync('test-results/source-section',{recursive:true});
 for (const [k,v] of Object.entries<any>(shots)) writeFileSync(`test-results/source-section/${k}.jpg`,Buffer.from(v.url.split(',')[1],'base64'));
 // the paragraph: a wide, short strip (its box is 0.86 x 0.05 of the page), at full width
 expect(shots.paragraph.found).toBe(true);
 expect(shots.paragraph.w).toBe(1000);
 expect(shots.paragraph.h/shots.paragraph.w).toBeGreaterThan(0.06);
 expect(shots.paragraph.h/shots.paragraph.w).toBeLessThan(0.11);
 // the figure: its own shape (0.47 x 0.24 of a 600 x 800 page = 282 x 192 pt), rendered sharper rather than blown up
 expect(shots.figure.w).toBe(1000);
 expect(Math.abs(shots.figure.h/shots.figure.w - 192/282*1.02)).toBeLessThan(0.08);
 // without a box: the band around the quote, as wide as the page
 expect(shots.nobox.found).toBe(true);
 expect(shots.nobox.h).toBeGreaterThan(shots.paragraph.h*2);
 // the figure crop is mostly the blue rectangle
 const blue=await ev(page,`(async()=>{ const im=new Image(); im.src=${JSON.stringify(shots.figure.url)}; await im.decode();
   const c=document.createElement('canvas'); c.width=im.width; c.height=im.height; const x=c.getContext('2d'); x.drawImage(im,0,0);
   const d=x.getImageData(0,0,c.width,c.height).data; let n=0; for (let i=0;i<d.length;i+=4) if (d[i+2]>150 && d[i]<100) n++; return n/(d.length/4); })()`);
 expect(blue).toBeGreaterThan(0.5);
});
