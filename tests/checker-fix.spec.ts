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
const saved=async(request:any,pid:string,id:string)=>(await (await request.get('/api/project/'+pid)).json()).cards.find((c:any)=>c.id===id);

const CARDS=[
 {id:'k-nowhy',type:'basic',front:'What is a closure?',back:'A function together with the variables it captured.'},
 {id:'k-multi',type:'basic',front:'<ol><li>What is a stack?</li><li>What is a queue?</li></ol>',back:'<ol><li>LIFO</li><li>FIFO</li></ol>',why:WHY},
 {id:'k-long',type:'basic',front:LONG,back:'Concurrency',why:WHY},
 {id:'k-ref',type:'basic',front:'What does TCP guarantee?',back:'In-order, reliable delivery.',why:WHY,refs:[{file:'net.pdf',quote:'reliable'}]},
 {id:'k-clean',type:'basic',front:'What is idempotence?',back:'Applying it twice equals applying it once.',why:WHY},
 {id:'k-fmt',type:'basic',front:'What does this print?',back:'It prints 3 because int x = 3; is assigned first.',why:WHY}
];

test('checker fixes: queue only the non-formatting checks, prompt per enabled check, apply why-only fixes, splits and re-checks',async({page,request},info)=>{
 const pid=await open(page,request,info,CARDS);
 // approve the card without a "why": a fix that changes it must ask for a re-check
 await ev(page,`setCardStatus(cardById('k-nowhy'),'ok');save()`);
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#fixPanel')).toBeVisible();
 await expect(page.locator('#kqUses')).toContainText('no "why"');
 await expect(page.locator('#kqUses')).toContainText('several questions');
 await expect(page.locator('#kqUses')).toContainText('source without a page');
 // the formatting-only card is not a candidate; the clean card neither
 expect(await ev(page,`fmtCandidates('K').map(c=>c.id).sort().join()`)).toBe('k-long,k-multi,k-nowhy,k-ref');
 await page.locator('#fixScope').selectOption('err');
 await expect(page.locator('#kqBuildInfo')).toHaveText('1 card(s) → 1 prompt(s)');
 expect(await ev(page,`fmtCandidates('K').map(c=>c.id).join()`)).toBe('k-multi');
 await page.locator('#fixScope').selectOption('flag');
 await page.locator('#fixSize').selectOption('10');
 await expect(page.locator('#kqBuildInfo')).toHaveText('4 card(s) → 1 prompt(s)');
 await page.locator('#kqBuild').click();
 await expect(page.locator('#kqPanel')).toBeVisible();
 await expect(page.locator('#kqList .qi')).toHaveCount(1);
 expect(await ev(page,`fmtItems('K').map(i=>i.id).join()`)).toBe('K1');
 expect(await ev(page,`fmtItems('F').length`)).toBe(0);
 // the formatting queue is separate and numbered on its own
 await page.locator('#fmtScope').selectOption('flag');
 expect(await ev(page,`fmtCandidates('F').map(c=>c.id).join()`)).toBe('k-fmt');
 await page.locator('#fqBuild').click();
 expect(await ev(page,`fmtItems('F').map(i=>i.id).join()`)).toBe('F1');
 await expect(page.locator('#fqList .qi')).toHaveCount(1);
 await expect(page.locator('#kqList .qi')).toHaveCount(1);

 const prompt:string=await ev(page,`fixPrompt(fmtItems('K')[0].cards)`);
 expect(prompt).toContain('**checker fix**');
 expect(prompt).toContain('at least 45 words');
 expect(prompt).toContain('at most 300 characters');
 expect(prompt).toContain('"after": "<original id>"');
 expect(prompt).toContain('at least 25 characters');
 expect(prompt).not.toContain('Answer too long');   // back_max_words is 0 (off) by default
 const block=JSON.parse(/<<<REVISE_CARDS id=r-[0-9a-f]{8}\n([\s\S]*?)\nREVISE_CARDS>>>/.exec(prompt)![1]);
 expect(block.cards.map((c:any)=>c.id).sort()).toEqual(['k-long','k-multi','k-nowhy','k-ref']);
 for (const c of block.cards) expect(c.feedback).toMatch(/^Checker fix - the checks found: /);
 expect(block.cards.find((c:any)=>c.id==='k-nowhy').feedback).toContain('no "why this card"');
 expect(block.cards.find((c:any)=>c.id==='k-ref').refs).toEqual([{file:'net.pdf',page:0,quote:'reliable'}]);
 // copying marks the prompt copied (N on the Revise tab copies the formatting queue first)
 await page.locator('#kqNext').click();
 await expect(page.locator('#kqList .pill')).toHaveText('copied');
 await expect(page.locator('#fqList .pill')).toHaveText('to do');

 // Claude's reply: a why-only fix, a split, a ref fix, an attempted delete (ignored)
 const reply={revision:true,cards:[
  {...CARDS[0],why:WHY},
  {...CARDS[1],front:'What is a stack?',back:'LIFO'},
  {id:'k-multi-b',type:'basic',front:'What is a queue?',back:'FIFO',why:WHY,after:'k-multi'},
  {...CARDS[3],refs:[{file:'net.pdf',page:12,quote:'TCP provides reliable, in-order delivery'}]},
  {id:'k-long',delete:true}]};
 await page.locator('#fixPanel details:has(#kqPaste) summary').click();
 await page.locator('#kqPaste').fill(JSON.stringify(reply));
 await page.locator('#kqApply').click();
 await expect(page.locator('#kqResult')).toContainText('Checker fix');
 await expect(page.locator('#kqResult')).toContainText('1 new card');
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#kqList .pill')).toHaveText('answered');
 await expect(page.locator('#fqList .pill')).toHaveText('to do');   // the formatting queue is untouched

 const st=JSON.parse(await ev(page,`JSON.stringify(S.cards.map(c=>({id:c.id,status:c.status,recheck:!!c.recheck,fmt:c.fmt||null,fmtDone:c.fmtDone||null,why:!!c.why})))`));
 const by=(id:string)=>st.find((c:any)=>c.id===id);
 expect(by('k-nowhy')).toMatchObject({status:'ok',recheck:true,fmt:null,fmtDone:'K1',why:true});
 expect(by('k-long')).toMatchObject({status:'new',fmtDone:'K1'});   // the delete was ignored
 expect(by('k-multi-b')).toMatchObject({status:'new'});
 expect(st.map((c:any)=>c.id).indexOf('k-multi-b')).toBe(st.map((c:any)=>c.id).indexOf('k-multi')+1);
 expect(by('k-fmt')).toMatchObject({fmt:'F1'});
 expect(await ev(page,`JSON.stringify(cardById('k-ref').refs)`)).toBe(JSON.stringify([{file:'net.pdf',page:12,quote:'TCP provides reliable, in-order delivery'}]));
 expect(await ev(page,`fixIssues(cardById('k-nowhy')).length+fixIssues(cardById('k-multi')).length+fixIssues(cardById('k-ref')).length`)).toBe(0);
 // the re-check diff shows the new "why"
 expect(await ev(page,`prevDiffHTML(cardById('k-nowhy'))`)).toContain('Why this card');
 await expect.poll(async()=>(await saved(request,pid,'k-nowhy'))?.recheck,{timeout:15000}).toBe(true);
 expect((await saved(request,pid,'k-nowhy')).why).toBe(WHY);
 expect((await saved(request,pid,'k-multi-b'))?.after).toBe('k-multi');

 // after a reload the queue and its numbering survive; a new queue continues at K2
 await page.reload();await page.waitForFunction('Store.on && curProject && S.cards.length===7');
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#kqList .qi')).toHaveCount(1);
 expect(await ev(page,`fmtCandidates('K').map(c=>c.id).join()`)).toBe('k-long');
 await page.locator('#kqBuild').click();
 expect(await ev(page,`fmtItems('K').map(i=>i.id).join()`)).toBe('K1,K2');
 // Clear removes only the checker-fix queue
 page.once('dialog',(d:any)=>d.accept());
 await page.locator('#kqClear').click();
 await expect(page.locator('#kqPanel')).toBeHidden();
 expect(await ev(page,`fmtItems('F').map(i=>i.id).join()`)).toBe('F1');
});

test('checker fixes follow the Checker settings: switched-off checks are neither queued nor asked for',async({page,request},info)=>{
 await open(page,request,info,[CARDS[0],CARDS[2]]);
 await page.locator('#tabs button[data-tab=checker]').click();
 const old=await page.evaluate(()=>({...((window as any).eval('ck()'))}));
 try {
  await page.locator('#ck_why').selectOption('off');
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#kqUses')).not.toContainText('"why"');
  expect(await ev(page,`fmtCandidates('K').map(c=>c.id).join()`)).toBe('k-long');
  await page.locator('#kqBuild').click();
  const prompt:string=await ev(page,`fixPrompt(fmtItems('K')[0].cards)`);
  expect(prompt).not.toContain('a short "why"');
  expect(prompt).toContain('Front too long');
  await page.locator('#tabs button[data-tab=checker]').click();
  await page.locator('#ck_front_max_chars').fill('0');await page.locator('#ck_front_max_chars').dispatchEvent('change');
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#kqUses')).not.toContainText('long front');
  await expect(page.locator('#kqBuildInfo')).toHaveText('no cards to add with these settings');
  // a card whose problem the settings no longer flag says so in the prompt
  const p2:string=await ev(page,`fixPrompt(fmtItems('K')[0].cards)`);
  expect(p2).toContain('the checks no longer flag this card');
 } finally {
  const settingsSaved=page.waitForResponse((r:any)=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
  await page.evaluate((C:any)=>{(window as any).eval('SET').checks=C;(window as any).eval('saveSettings')();},old);
  await settingsSaved;
 }
});

test('a formatting reply that only changes the "why" or refs is applied, and a delete counts as no change',async({page,request},info)=>{
 await open(page,request,info,[CARDS[5]]);
 await page.locator('#tabs button[data-tab=revise]').click();
 await page.locator('#fqBuild').click();
 await page.locator('details:has(#fqPaste) summary').click();
 await page.locator('#fqPaste').fill(JSON.stringify({revision:true,cards:[{id:'k-fmt',delete:true}]}));
 await page.locator('#fqApply').click();
 await expect(page.locator('#fqResult')).toContainText('1 needed no change');
 await expect(page.locator('#fqResult')).not.toContainText('Nothing found');
 expect(await ev(page,`cardById('k-fmt').status`)).toBe('new');
 // job replies are routed by the prompt id
 expect(await ev(page,`[passOf('K3'),passOf('F2'),passOf(undefined)].join()`)).toBe('K,F,F');
});
