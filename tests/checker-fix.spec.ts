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

test('checker fixes: one queue, each prompt with its own rules; prompt per enabled check, why-only fixes, splits and re-checks',async({page,request},info)=>{
 const pid=await open(page,request,info,CARDS);
 // approve the card without a "why": a fix that changes it must ask for a re-check
 await ev(page,`setCardStatus(cardById('k-nowhy'),'ok');save()`);
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#fixPanel')).toBeVisible();
 await ev(page,`SET.fixRules=[...FIX_KEYS];renderFmtPass()`);   // local only: the shared settings stay as they are
 await expect(page.locator('#fxPresets .btn.on')).toHaveText('Others');
 await expect(page.locator('#fqUses')).toContainText('no hidden notes');
 await expect(page.locator('#fqUses')).toContainText('several questions');
 await expect(page.locator('#fqUses')).toContainText('source without a page');
 await expect(page.locator('#fqUses')).toContainText('Claude may rewrite content');
 // the formatting-only card is not a candidate; the clean card neither
 expect(await ev(page,`fmtCandidates().map(c=>c.id).sort().join()`)).toBe('k-long,k-multi,k-nowhy,k-ref');
 await page.locator('#fixScope').selectOption('err');
 await expect(page.locator('#fqBuildInfo')).toHaveText('1 card(s) → 1 prompt(s)');
 expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('k-multi');
 await page.locator('#fixScope').selectOption('flag');
 await page.locator('#fixSize').selectOption('10');
 await expect(page.locator('#fqBuildInfo')).toHaveText('4 card(s) → 1 prompt(s)');
 await page.locator('#fqBuild').click();
 await expect(page.locator('#fqPanel')).toBeVisible();
 await expect(page.locator('#fqList .qi')).toHaveCount(1);
 expect(await ev(page,`fmtItems().map(i=>i.id).join()`)).toBe('Q1');
 // switch to the Formatting preset and add to the same queue: numbered on, with its own rules
 await ev(page,`SET.fixRules=[...FMT_KEYS];renderFmtPass()`);
 await expect(page.locator('#fxPresets .btn.on')).toHaveText('Formatting');
 await expect(page.locator('#fqUses')).toContainText('Formatting only');
 expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('k-fmt');
 await page.locator('#fqBuild').click();
 expect(await ev(page,`fmtItems().map(i=>i.id).join()`)).toBe('Q1,Q2');
 await expect(page.locator('#fqList .qi')).toHaveCount(2);
 await expect(page.locator('#fqList .qi .tt').nth(0)).toContainText('Others');
 await expect(page.locator('#fqList .qi .tt').nth(1)).toContainText('Formatting');

 const prompt:string=await ev(page,`fixPrompt(fmtItems()[0].cards)`);
 expect(prompt).toContain('**checker fix**');
 expect(prompt).toContain('at least 45 words');
 expect(prompt).toContain('at most 300 characters');
 expect(prompt).toContain('"after": "<original id>"');
 expect(prompt).toContain('at least 25 characters');
 expect(prompt).not.toContain('Answer too long');   // back_max_words is 0 (off) by default
 expect(prompt).not.toContain('**Code:**');          // not a picked rule for this prompt
 const block=JSON.parse(/<<<REVISE_CARDS id=r-[0-9a-f]{8}\n([\s\S]*?)\nREVISE_CARDS>>>/.exec(prompt)![1]);
 expect(block.cards.map((c:any)=>c.id).sort()).toEqual(['k-long','k-multi','k-nowhy','k-ref']);
 for (const c of block.cards) expect(c.feedback).toMatch(/^Checker fix - the checks found: /);
 expect(block.cards.find((c:any)=>c.id==='k-nowhy').feedback).toContain('no hidden notes');
 expect(block.cards.find((c:any)=>c.id==='k-ref').refs).toEqual([{file:'net.pdf',page:0,quote:'reliable'}]);
 // the Formatting prompt is a formatting pass: no content changes, no splits
 const fp:string=await ev(page,`fixPrompt(fmtItems()[1].cards)`);
 expect(fp).toContain('**formatting pass, not a content review**');
 expect(fp).toContain('**Code:**');
 expect(fp).toContain('Do not delete, merge or split cards');
 expect(fp).not.toContain('at least 45 words');
 expect(JSON.parse(/<<<REVISE_CARDS id=r-[0-9a-f]{8}\n([\s\S]*?)\nREVISE_CARDS>>>/.exec(fp)![1]).cards[0].feedback).toMatch(/^Formatting pass - the checks found: /);
 // copying marks the next prompt copied
 await page.locator('#fqNext').click();
 await expect(page.locator('#fqList .pill').nth(0)).toHaveText('copied');
 await expect(page.locator('#fqList .pill').nth(1)).toHaveText('to do');

 // Claude's reply: a why-only fix, a split, a ref fix, an attempted delete (ignored)
 const reply={revision:true,cards:[
  {...CARDS[0],why:WHY},
  {...CARDS[1],front:'What is a stack?',back:'LIFO'},
  {id:'k-multi-b',type:'basic',front:'What is a queue?',back:'FIFO',why:WHY,after:'k-multi'},
  {...CARDS[3],refs:[{file:'net.pdf',page:12,quote:'TCP provides reliable, in-order delivery',box:[0.1,0.2,0.9,0.3]}]},
  {id:'k-long',delete:true}]};
 await page.locator('#fixPanel details:has(#fqPaste) summary').click();
 await page.locator('#fqPaste').fill(JSON.stringify(reply));
 await page.locator('#fqApply').click();
 await expect(page.locator('#fqResult')).toContainText('Global revision');
 await expect(page.locator('#fqResult')).toContainText('1 new card');
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#fqList .pill').nth(0)).toHaveText('answered');
 await expect(page.locator('#fqList .pill').nth(1)).toHaveText('to do');   // the formatting prompt is untouched

 const st=JSON.parse(await ev(page,`JSON.stringify(S.cards.map(c=>({id:c.id,status:c.status,recheck:!!c.recheck,fmt:c.fmt||null,fmtDone:c.fmtDone||null,why:!!c.why})))`));
 const by=(id:string)=>st.find((c:any)=>c.id===id);
 expect(by('k-nowhy')).toMatchObject({status:'ok',recheck:true,fmt:null,fmtDone:'Q1',why:true});
 expect(by('k-long')).toMatchObject({status:'new',fmtDone:'Q1'});   // the delete was ignored
 expect(by('k-multi-b')).toMatchObject({status:'new'});
 expect(st.map((c:any)=>c.id).indexOf('k-multi-b')).toBe(st.map((c:any)=>c.id).indexOf('k-multi')+1);
 expect(by('k-fmt')).toMatchObject({fmt:'Q2'});
 expect(await ev(page,`JSON.stringify(cardById('k-ref').refs)`)).toBe(JSON.stringify([{file:'net.pdf',page:12,quote:'TCP provides reliable, in-order delivery',box:[0.1,0.2,0.9,0.3]}]));
 expect(await ev(page,`fixIssues(cardById('k-nowhy')).length+fixIssues(cardById('k-multi')).length+fixIssues(cardById('k-ref')).length`)).toBe(0);
 // the re-check diff shows the new "why"
 expect(await ev(page,`prevDiffHTML(cardById('k-nowhy'))`)).toContain('Hidden notes');
 await expect.poll(async()=>(await saved(request,pid,'k-nowhy'))?.recheck,{timeout:15000}).toBe(true);
 expect((await saved(request,pid,'k-nowhy')).why).toBe(WHY);
 expect((await saved(request,pid,'k-multi-b'))?.after).toBe('k-multi');
 await expect.poll(async()=>(await saved(request,pid,'k-fmt'))?.fmtRules?.slice().sort(),{timeout:15000}).toEqual(await ev(page,'[...FMT_KEYS].sort()'));

 // after a reload the queue, each prompt's rules and the numbering survive; a new prompt continues at Q3
 await page.reload();await page.waitForFunction('Store.on && curProject && S.cards.length===7');
 await page.locator('#tabs button[data-tab=revise]').click();
 await ev(page,`SET.fixRules=[...FIX_KEYS];renderFmtPass()`);
 await expect(page.locator('#fqList .qi')).toHaveCount(2);
 await expect(page.locator('#fqList .qi .tt').nth(1)).toContainText('Formatting');
 expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('k-long');
 await page.locator('#fqBuild').click();
 expect(await ev(page,`fmtItems().map(i=>i.id).join()`)).toBe('Q1,Q2,Q3');
 // Clear removes the queue, and the cards' rules with it
 page.once('dialog',(d:any)=>d.accept());
 await page.locator('#fqClear').click();
 await expect(page.locator('#fqPanel')).toBeHidden();
 expect(await ev(page,`fmtItems().length+S.cards.filter(c=>c.fmtRules).length`)).toBe(0);
});

test('the rule picker: presets, ticking rules, your own presets; kept with the settings',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','the settings are shared: one browser is enough');
 await open(page,request,info,CARDS);
 const old=await ev(page,`JSON.stringify({fixRules:SET.fixRules,fixPresets:SET.fixPresets})`);
 try {
  await page.locator('#tabs button[data-tab=revise]').click();
  await page.locator('#fxPresets [data-preset]',{hasText:'Others'}).click();
  await expect(page.locator('#fxPresets .btn.on')).toHaveText('Others');
  await expect(page.locator('#fxRules [data-rule=why]')).toBeChecked();
  await expect(page.locator('#fxRules [data-rule=code_as_text]')).not.toBeChecked();
  // the Sources preset, then tick one more rule by hand: no preset matches any more
  await page.locator('#fxPresets [data-preset]',{hasText:'Sources'}).click();
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('k-ref');
  await page.locator('#fxRules [data-rule=multi_question]').check();
  await expect(page.locator('#fxPresets .btn.on')).toHaveCount(0);
  expect(await ev(page,`pickedRules().join()`)).toBe('multi_question,ref_quote_min_chars,ref_page,ref_section');
  expect(await ev(page,`fmtCandidates().map(c=>c.id).sort().join()`)).toBe('k-multi,k-ref');
  await expect(page.locator('#fxRules label',{hasText:'source without a page'})).toContainText('(warn)');
  // save it as a preset of your own
  page.once('dialog',(d:any)=>d.accept('Splits and refs'));
  const savedP=page.waitForResponse((r:any)=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
  await page.locator('#fxSave').click();
  await savedP;
  await expect(page.locator('#fxPresets .btn.on')).toContainText('Splits and refs');
  // it survives a reload (from the server settings), and selecting it brings its rules back
  await page.locator('#fxPresets [data-preset]',{hasText:'Formatting'}).click();
  await page.waitForFunction('!sync.dirty');
  await page.reload();await page.waitForFunction('Store.on && curProject && S.cards.length===6');
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#fxPresets .btn.on')).toHaveText('Formatting');
  await page.locator('#fxPresets [data-preset]',{hasText:'Splits and refs'}).click();
  expect(await ev(page,`pickedRules().join()`)).toBe('multi_question,ref_quote_min_chars,ref_page,ref_section');
  // nothing picked: nothing to build
  for (const k of ['multi_question','ref_quote_min_chars','ref_page','ref_section']) await page.locator(`#fxRules [data-rule=${k}]`).uncheck();
  await expect(page.locator('#fqUses')).toContainText('pick some rules');
  await expect(page.locator('#fqBuild')).toBeDisabled();
  await expect(page.locator('#fxSave')).toBeDisabled();
  // delete the preset
  page.once('dialog',(d:any)=>d.accept());
  await page.locator('#fxPresets [data-rm-preset]').click();
  await expect(page.locator('#fxPresets')).not.toContainText('Splits and refs');
  expect(await ev(page,`SET.fixPresets.length`)).toBe(0);
  // bad settings are cleaned up: unknown rules dropped, empty presets removed
  expect(await ev(page,`JSON.stringify((({fixRules,fixPresets})=>({fixRules,fixPresets}))(mergeSettings({fixRules:['why','nope'],fixPresets:[{name:' A ',rules:['ref_page','x']},{name:'B',rules:['x']},{name:'',rules:['why']}]})))`))
   .toBe(JSON.stringify({fixRules:['why'],fixPresets:[{name:'A',rules:['ref_page']}]}));
 } finally {
  const settingsSaved=page.waitForResponse((r:any)=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
  await ev(page,`Object.assign(SET,${old});saveSettings()`);
  await settingsSaved;
 }
});

test('checker fixes follow the Checker settings: switched-off checks are neither queued nor asked for',async({page,request},info)=>{
 await open(page,request,info,[CARDS[0],CARDS[2]]);
 await page.locator('#tabs button[data-tab=checker]').click();
 const old=await page.evaluate(()=>({...((window as any).eval('ck()'))})), oldRules=await ev(page,'SET.fixRules');
 await ev(page,`SET.fixRules=[...FIX_KEYS]`);
 try {
  await page.locator('#ck_why').selectOption('off');
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#fqUses')).not.toContainText('"why"');
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('k-long');
  await page.locator('#fqBuild').click();
  const prompt:string=await ev(page,`fixPrompt(fmtItems()[0].cards)`);
  expect(prompt).not.toContain('a short "why"');
  expect(prompt).toContain('Front too long');
  await page.locator('#tabs button[data-tab=checker]').click();
  await page.locator('#ck_front_max_chars').fill('0');await page.locator('#ck_front_max_chars').dispatchEvent('change');
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#fqUses')).not.toContainText('long front');
  await expect(page.locator('#fqBuildInfo')).toHaveText('no cards to add with these settings');
  // a card whose problem the settings no longer flag says so in the prompt
  const p2:string=await ev(page,`fixPrompt(fmtItems()[0].cards)`);
  expect(p2).toContain("the checks don't flag this card");
 } finally {
  const settingsSaved=page.waitForResponse((r:any)=>r.url().endsWith('/api/settings') && r.request().method()==='PUT');
  await page.evaluate(([C,R]:any)=>{(window as any).eval('SET').checks=C;(window as any).eval('SET').fixRules=R;(window as any).eval('saveSettings')();},[old,oldRules]);
  await settingsSaved;
 }
});

test('a formatting reply that only changes the "why" or refs is applied, and a delete counts as no change',async({page,request},info)=>{
 await open(page,request,info,[CARDS[5]]);
 await page.locator('#tabs button[data-tab=revise]').click();
 await ev(page,`SET.fixRules=[...FMT_KEYS];renderFmtPass()`);
 await page.locator('#fqBuild').click();
 await page.locator('details:has(#fqPaste) summary').click();
 await page.locator('#fqPaste').fill(JSON.stringify({revision:true,cards:[{id:'k-fmt',delete:true}]}));
 await page.locator('#fqApply').click();
 await expect(page.locator('#fqResult')).toContainText('1 needed no change');
 await expect(page.locator('#fqResult')).not.toContainText('Nothing found');
 expect(await ev(page,`cardById('k-fmt').status`)).toBe('new');
 // prompts from the old separate queues keep their fixed rules; new ones carry theirs
 expect(await ev(page,`[itemRules([{fmt:'K3'}]).join(),itemRules([{fmtDone:'F2'}]).join(),itemRules([{fmt:'Q4',fmtRules:['ref_page','why']}]).join()].join(' | ')`))
  .toBe(await ev(page,`[[...FIX_KEYS].join(),[...FMT_KEYS].join(),'why,ref_page'].join(' | ')`));
});
