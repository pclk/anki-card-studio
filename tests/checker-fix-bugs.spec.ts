import {test,expect} from '@playwright/test';
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);
const WHY='<p><b>Tests:</b> recalling the idea in its own words.</p><p><b>Why it matters:</b> later topics build on it, so a shaky grasp here causes errors in every exercise that uses it.</p><p><b>Common mistake:</b> mixing it up with the closely related idea from the same lecture.</p><p><b>Connects to:</b> the next chapter.</p>';
const LONG='Consider a system where '+'several interacting parts exchange messages, '.repeat(8)+'what is the term for this?';

async function open(page:any,request:any,info:any,cards:any[]){
 const pid='fix'+Date.now().toString(36)+info.project.name;
 const headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#importFile').setInputFiles({name:'anki_bundle.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({deck:pid,cards}))});
 await expect(page.locator('#importResult')).toContainText(`${cards.length} new card`);
 return pid;
}

const CARD={id:'bug-card',type:'basic',front:'What is a stack?',back:'LIFO'};

test('checker refs-only fix must show the changed references in the re-check diff',async({page,request},info)=>{
 await open(page,request,info,[{...CARD,why:WHY,refs:[{file:'notes.pdf',page:0,quote:'short'}]}]);
 await ev(page,`setCardStatus(cardById('bug-card'),'ok');cardById('bug-card').fmt='K1';`);
 const result=await ev(page,`applyBundle({revision:true,cards:[{...cardForAI(cardById('bug-card'),false),refs:[{file:'notes.pdf',page:12,quote:'A stack removes the most recently added item first.'}]}]},'merge',{revision:true});prevDiffHTML(cardById('bug-card'))`);
 expect(result).toContain('notes.pdf');
 expect(result).toContain('12');
});

test('marking a partially answered checker batch answered must retain every member',async({page,request},info)=>{
 await open(page,request,info,[CARD,{...CARD,id:'bug-second'}]);
 // Persisted state after one member has been answered, with another still pending.
 await ev(page,`cardById('bug-card').fmtDone='K1';cardById('bug-second').fmt='K1';cardById('bug-second').fmtSt='copied';showTab('revise')`);
 await page.locator('#kqList [data-fq=done]').click();
 expect(await ev(page,`fmtItems('K')[0].cards.map(c=>c.id).sort()`)).toEqual(['bug-card','bug-second']);
});

test('checker prompt must not request reference pages when the page check is off',async({page,request},info)=>{
 await open(page,request,info,[{...CARD,refs:[{file:'notes.pdf',page:1,quote:'short'}]}]);
 // Local-only settings avoid changing shared server settings for other tests.
 await ev(page,`SET.checks={...ck(),ref_page:'off',ref_quote_min_chars:25}`);
 const prompt=await ev(page,`fixPrompt([cardById('bug-card')])`);
 expect(prompt).not.toContain('give each reference the page it is on');
});
