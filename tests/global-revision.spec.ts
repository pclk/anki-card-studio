import {test,expect} from '@playwright/test';
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);
const WHY='<p><b>Tests:</b> recalling the idea in its own words.</p><p><b>Why it matters:</b> later topics build on it, so a shaky grasp here causes errors in every exercise that uses it.</p><p><b>Common mistake:</b> mixing it up with the closely related idea from the same lecture.</p><p><b>Connects to:</b> the next chapter.</p>';
const java=(s:string)=>`<pre><code class="language-java">${s}</code></pre>`;

async function open(page:any,request:any,info:any,cards:any[]){
 const pid='glob'+Date.now().toString(36)+info.project.name;
 const headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction(`Store.on && curProject && !sync.dirty && S.deck===${JSON.stringify(pid)}`);   // curProject is set before the project has loaded
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#importFile').setInputFiles({name:'anki_bundle.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({deck:pid,cards}))});
 await expect(page.locator('#importResult')).toContainText(`${cards.length} new card`);
 await page.waitForFunction(`S.cards.length===${cards.length} && !sync.dirty`);
 return pid;
}
const CARDS=[
 {id:'g-java',type:'basic',front:'What does this print?'+java('int x = 1;'),back:'1',why:WHY,tags:['oop']},
 {id:'g-java2',type:'basic',front:'Which line fails?'+java('List&lt;int&gt; xs;'),back:'Generics need a reference type.',why:WHY},
 {id:'g-py',type:'basic',front:'What does this print?<pre><code class="language-python">print(1)</code></pre>',back:'1',why:WHY},
 {id:'g-text',type:'basic',front:'What is encapsulation?',back:'Hiding state behind methods.',why:WHY,tags:['oop']},
 {id:'g-math',type:'cloze',text:'Euler: \\(e^{i\\pi} + {{c1::1}} = 0\\)',extra:'',why:''}
];
const paste=(page:any,txt:string)=>page.evaluate((t:string)=>{ (document.querySelector('#fqPaste') as HTMLTextAreaElement).value=t; },txt);
// the settings these tests change are shared by every project: put them back afterwards
const keep=async(page:any)=>ev(page,`JSON.stringify({fixRules:SET.fixRules,fixPresets:SET.fixPresets,grTask:SET.grTask,grFilter:SET.grFilter})`);
const restore=async(page:any,old:string)=>{ const p=page.waitForResponse((r:any)=>r.url().endsWith('/api/settings') && r.request().method()==='PUT'); await ev(page,`Object.assign(SET,${old});saveSettings()`); await p; };

test('global revision: allow / deny filter, instruction prompt, re-check, not applicable, deletes only when allowed',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','the settings are shared: one browser is enough');
 await open(page,request,info,CARDS);
 const old=await keep(page);
 try {
  for (const id of ['g-java','g-java2','g-py','g-text']) await ev(page,`setCardStatus(cardById('${id}'),'ok')`);
  await ev(page,`save()`);
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#fixPanel h2')).toHaveText('Global revision');
  // no rules and no instruction: nothing to do
  await ev(page,`setFixRules([]);setGrTask({instr:''});setGrFilter({match:'all',conds:[]})`);
  await expect(page.locator('#fxRules [data-rule]:checked')).toHaveCount(0);
  await expect(page.locator('#fqUses')).toContainText('pick some rules, or write an instruction');
  await expect(page.locator('#fqBuild')).toBeDisabled();
  // an instruction alone picks every card that isn't excluded; "Which cards" needs rules
  await page.locator('#grInstr').fill('Rewrite the Java code in Kotlin');
  await expect(page.locator('#fixScope')).toBeDisabled();
  await expect(page.locator('#grOpts')).toBeVisible();
  await expect(page.locator('#fqBuildInfo')).toHaveText('5 card(s) → 1 prompt(s)');
  // allow: has a code block; deny: code in Python
  await page.locator('#grAdd').click();
  await expect(page.locator('#grConds .gr-cond')).toHaveCount(1);
  await expect(page.locator('#grConds .gr-cond [data-cn]')).toHaveText('3 cards');
  await page.locator('#grAdd').click();
  const deny=page.locator('#grConds .gr-cond').nth(1);
  await deny.locator('[data-cm=deny]').selectOption('1');
  await deny.locator('[data-cm=key]').selectOption('code_lang');
  await expect(deny).toHaveClass(/deny/);
  await expect(deny.locator('[data-cn]')).toHaveText('incomplete - ignored');
  await expect(page.locator('#fqBuildInfo')).toHaveText('3 card(s) → 1 prompt(s)');
  await deny.locator('[data-ca=q]').pressSequentially('pyth');
  await expect(deny.locator('[data-ca=q]')).toBeFocused();   // typing keeps the row
  await expect(deny.locator('[data-cn]')).toHaveText('0 cards');
  await deny.locator('[data-ca=q]').pressSequentially('on');
  await expect(deny.locator('[data-cn]')).toHaveText('1 card');
  await expect(page.locator('#fqBuildInfo')).toHaveText('2 card(s) → 1 prompt(s)');
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('g-java,g-java2');
  // all vs any of the allow conditions
  await ev(page,`setGrFilter({match:'all',conds:[{key:'code_block'},{key:'tag',a:{q:'oop'}}]})`);
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('g-java');
  await page.locator('#grMatch').selectOption('any');
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('g-java,g-java2,g-py,g-text');
  // a Checker condition, a bad regex (ignored), a text regex
  await ev(page,`setGrFilter({match:'all',conds:[{key:'check',a:{v:'why'}}]})`);
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('g-math');
  await ev(page,`setGrFilter({match:'all',conds:[{key:'regex',a:{f:'q',q:'(unclosed'}},{key:'regex',a:{f:'html',q:'language-(java|python)'}}]})`);
  await expect(page.locator('#grConds .gr-cond.bad')).toHaveCount(1);
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('g-java,g-java2,g-py');
  // the Review filter shows the same cards
  await page.locator('#grShow').click();
  await expect(page.locator('#tab-review')).toHaveClass(/active/);
  expect(await ev(page,`filtered().map(c=>c.id).join()`)).toBe('g-java,g-java2,g-py');
  await page.locator('#tabs button[data-tab=revise]').click();
  // build: the cards carry the instruction; the prompt has it, the not-applicable rule, and no deletes
  await page.locator('#fqBuild').click();
  await expect(page.locator('#fqList .qi')).toHaveCount(1);
  await expect(page.locator('#fqList .qi .tt')).toContainText('“Rewrite the Java code in Kotlin”');
  expect(await ev(page,`JSON.stringify(cardById('g-java').fmtTask)`)).toBe(JSON.stringify({instr:'Rewrite the Java code in Kotlin',mode:'content',split:false,del:false}));
  const pr:string=await ev(page,`fixPrompt(fmtItems()[0].cards)`);
  expect(pr).toContain('global revision');
  expect(pr).toContain('<<<INSTRUCTION\nRewrite the Java code in Kotlin\nINSTRUCTION>>>');
  expect(pr).toContain('"not_applicable"');
  expect(pr).toContain('Never delete cards.');
  expect(pr).toContain('Do not split or merge cards.');
  const block=JSON.parse(pr.match(/<<<REVISE_CARDS id=\S+\n([\s\S]*?)\nREVISE_CARDS>>>/)![1]);
  expect(block.cards.map((c:any)=>c.id)).toEqual(['g-java','g-java2','g-py']);
  expect(block.cards[0].feedback).toBe('Global revision - Rewrite the Java code in Kotlin');
  // the reply: one changed, one not applicable, and a delete that wasn't allowed (a queued card)
  const kotlin='What does this print?<pre><code class="language-kotlin">val x = 1</code></pre>';
  await paste(page,JSON.stringify({revision:true,cards:[{...CARDS[0],front:kotlin},{id:'g-java2',not_applicable:'Java generics have no direct Kotlin equivalent here'},{id:'g-py',delete:true}]}));
  await ev(page,"$('#fqApply').click()");
  await expect(page.locator('#fqResult')).toContainText('1 approved card changed');
  await expect(page.locator('#fqResult')).toContainText('Left as is');
  await expect(page.locator('#fqResult')).toContainText('g-java2');
  const st=JSON.parse(await ev(page,`JSON.stringify(['g-java','g-java2','g-py'].map(i=>{const c=cardById(i);return {status:c.status,recheck:!!c.recheck,na:c.fmtNA||null,fmt:c.fmt||null,fb:c.prev&&c.prev.feedback}}))`));
  expect(st[0]).toEqual({status:'ok',recheck:true,na:null,fmt:null,fb:'Global revision: Rewrite the Java code in Kotlin'});
  expect(st[1]).toMatchObject({status:'ok',recheck:false,na:'Java generics have no direct Kotlin equivalent here',fmt:null});
  expect(st[2]).toMatchObject({status:'ok',recheck:false,fmt:null});   // deleting wasn't allowed: no change
  expect(await ev(page,`cardById('g-java2').front`)).toBe(CARDS[1].front);
  await page.locator('#tabs button[data-tab=revise]').click();
  await expect(page.locator('#fqList .pill').first()).toHaveText('answered');
  await expect(page.locator('#fqList .qi .sub')).toContainText('1 left as is');
  // "left as is" is a condition too, and a badge in Review
  await ev(page,`setGrFilter({match:'all',conds:[{key:'left_as_is'}]})`);
  expect(await ev(page,`fmtCandidates().map(c=>c.id).join()`)).toBe('g-java2');
  await ev(page,`select('g-java2')`); await page.locator('#tabs button[data-tab=review]').click();
  await expect(page.locator('#curBadges')).toContainText('left as is');
  // deletes when allowed
  await page.locator('#tabs button[data-tab=revise]').click();
  await ev(page,`setGrFilter({match:'all',conds:[{key:'id',a:{q:'g-text, g-py'}}]})`);
  await page.locator('#grDel').check();
  await page.locator('#grMode').selectOption('format');
  await page.locator('#fqBuild').click();
  const pr2:string=await ev(page,`fixPrompt(fmtNext().cards)`);
  expect(pr2).toContain('delete it: `{"id": "c007", "delete": true}`');
  expect(pr2).toContain('Change only how a card is written');
  // a reply that also touches a card in no waiting prompt: that part is left out, and said so
  await paste(page,JSON.stringify({revision:true,cards:[{id:'g-text',delete:true},{...CARDS[4],text:'changed {{c1::x}}'}]}));
  await ev(page,"$('#fqApply').click()");
  expect(await ev(page,`cardById('g-text').status`)).toBe('drop');
  await expect(page.locator('#fqResult')).toContainText("Left out 1 card the reply changed that isn't in a waiting prompt: g-math");
  expect(await ev(page,`cardById('g-math').text`)).toBe(CARDS[4].text);
  expect(await ev(page,`cardById('g-py').status+':'+!!cardById('g-py').recheck`)).toBe('ok:false');   // left out: fine as it was
 } finally { await restore(page,old); }
});

test('your own preset keeps the instruction and the filter',async({page,request},info)=>{
 test.skip(info.project.name!=='desktop','the settings are shared: one browser is enough');
 await open(page,request,info,CARDS);
 const old=await keep(page);
 try {
  await page.locator('#tabs button[data-tab=revise]').click();
  await ev(page,`SET.fixRules=['why'];setGrTask({instr:'Add a mnemonic'});setGrFilter({match:'any',conds:[{key:'math'},{key:'tag',deny:true,a:{q:'oop'}}]})`);
  page.once('dialog',(d:any)=>d.accept('Mnemonics'));
  await page.locator('#fxSave').click();
  await expect(page.locator('#fxPresets .btn.on')).toHaveText(/Mnemonics/);
  await ev(page,`SET.fixRules=[];setGrTask({instr:''});setGrFilter({match:'all',conds:[]})`);
  await expect(page.locator('#fxPresets .btn.on')).toHaveCount(0);
  await page.locator('#fxPresets [data-preset]',{hasText:'Mnemonics'}).click();
  await expect(page.locator('#grInstr')).toHaveValue('Add a mnemonic');
  await expect(page.locator('#grConds .gr-cond')).toHaveCount(2);
  await expect(page.locator('#grMatch')).toHaveValue('any');
  expect(await ev(page,`pickedRules().join()`)).toBe('why');
  // saved settings are cleaned up
  expect(await ev(page,`JSON.stringify((s=>[s.grTask,s.grFilter,s.fixPresets])(mergeSettings({grTask:{instr:5,mode:'x',del:1},grFilter:{match:'?',conds:[{key:'tag',a:{q:'x',bad:{}}},{nokey:1}]},fixPresets:[{name:'T',rules:[],task:{instr:'Do it'}},{name:'E',rules:[]}]})))`))
   .toBe(JSON.stringify([{instr:'',mode:'content',split:false,del:true},{match:'all',conds:[{key:'tag',deny:false,a:{q:'x'}}]},[{name:'T',rules:[],task:{instr:'Do it',mode:'content',split:false,del:false}}]]));
 } finally { await restore(page,old); }
});

test('hidden notes follow the Prompt page; PDF sources need their section',async({page,request},info)=>{
 await open(page,request,info,[...CARDS,
  {id:'g-ref',type:'basic',front:'What does TCP guarantee?',back:'In-order delivery.',why:WHY,refs:[{file:'net.pdf',page:3,quote:'TCP guarantees in-order, reliable delivery'}]},
  {id:'g-refbox',type:'basic',front:'What does UDP guarantee?',back:'Nothing.',why:WHY,refs:[{file:'net.pdf',page:4,quote:'UDP makes no delivery guarantees at all',box:[0.1,0.2,0.9,0.35]}]},
  {id:'g-web',type:'basic',front:'What is QUIC?',back:'A transport over UDP.',why:WHY,refs:[{file:'https://example.org/quic',page:0,quote:'QUIC is a transport protocol built on UDP'}]}]);
 expect(await ev(page,`['g-ref','g-refbox','g-web'].map(i=>checksOf(cardById(i)).some(x=>x.key==='ref_section')).join()`)).toBe('true,false,false');
 expect(await ev(page,`refBox({box:[0.5,0.2,0.4,0.3]})`)).toBeNull();
 // the condition on the section box
 expect(await ev(page,`(()=>{const F=compileFilter({match:'all',conds:[{key:'ref_box'}]});return S.cards.filter(c=>filterPass(c,F)).map(c=>c.id).join()})()`)).toBe('g-refbox');
 // the review panel and the checker say "hidden notes"
 await ev(page,`select('g-math')`); await page.locator('#tabs button[data-tab=review]').click();
 await expect(page.locator('#whyBox')).toContainText('Hidden notes');
 expect(await ev(page,`checksOf(cardById('g-math')).find(x=>x.key==='why').msg`)).toContain('no hidden notes');
 // what the Prompt page says the notes hold goes to new cards and to revisions
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#pNotes').fill('a mnemonic and the exam question it prepares for');
 await expect(page.locator('#pOut')).toHaveValue(/Hidden notes \(why=\): a mnemonic and the exam question it prepares for/);
 expect(await ev(page,`fixPrompt([cardById('g-math')],['why'],null)`)).toContain('## Hidden notes');
 expect(await ev(page,`fixPrompt([cardById('g-math')],['why'],null)`)).toContain('a mnemonic and the exam question it prepares for');
 await page.locator('#pNotes').fill('');
 await expect(page.locator('#pOut')).toHaveValue(/Hidden notes \(why=\): the default/);
 // the prompt asks for the exact section
 await expect(page.locator('#pOut')).toHaveValue(/refs to the exact section it was made from/);
});
