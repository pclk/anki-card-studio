import {test,expect} from '@playwright/test';
// Checks the AI skipped on purpose for one card ("skipped_checks": {check: reason}): the checker stops flagging them everywhere,
// Review shows each skip with its reason and can undo it, and a checker fix can add one (the helper side is scripts/skipped_checks_test.py).
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);
const WHY='<p><b>Tests:</b> recalling the idea in its own words.</p><p><b>Why it matters:</b> later topics build on it, so a shaky grasp here causes errors in every exercise that uses it.</p><p><b>Common mistake:</b> mixing it up with the closely related idea from the same lecture.</p><p><b>Connects to:</b> the next chapter.</p>';
const WIDE='<pre><code class="language-java">public ColoredCircle(Circle c, String colour) {</code></pre>';
const REASON='the constructor signature is what the card tests';
const CARDS=[
 {id:'s-skip',type:'basic',front:'What does this declare?',back:WIDE,why:WHY,skipped_checks:{code_line_chars:REASON}},
 {id:'s-wide',type:'basic',front:'And this?',back:WIDE,why:WHY},
 {id:'s-bad',type:'basic',front:'What is a stack?',back:'LIFO',why:WHY,skipped_checks:{nope:'x',why:'  ',ref_page:'web notes'}}
];
const saved=async(request:any,pid:string,id:string)=>(await (await request.get('/api/project/'+pid)).json()).cards.find((c:any)=>c.id===id);

test('skipped checks: stored with their reason, not flagged, shown and undone in Review, added by a checker fix',async({page,request},info)=>{
 const pid='skip'+Date.now().toString(36)+info.project.name, headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('#importFile').setInputFiles({name:'anki_bundle.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({deck:pid,cards:CARDS}))});
 await expect(page.locator('#importResult')).toContainText('3 new card');

 // stored as sent; unknown checks and empty reasons are dropped
 expect(await ev(page,`JSON.stringify(S.cards.map(c=>c.skipped_checks||null))`)).toBe(JSON.stringify([{code_line_chars:REASON},null,{ref_page:'web notes'}]));
 await expect.poll(async()=>(await saved(request,pid,'s-skip'))?.skipped_checks,{timeout:15000}).toEqual({code_line_chars:REASON});
 // the skipped check is not flagged on that card - only there - nor queued by a checker fix
 expect(await ev(page,`checksOf(cardById('s-skip')).map(x=>x.key).join()`)).toBe('');
 expect(await ev(page,`checksOf(cardById('s-wide')).map(x=>x.key).join()`)).toBe('code_line_chars');
 await page.locator('#tabs button[data-tab=revise]').click();
 expect(await ev(page,`fmtCandidates(['code_line_chars']).map(c=>c.id).join()`)).toBe('s-wide');

 // Review: the skip, its reason and what the check would say; a filter finds the cards with skips
 await page.locator('#tabs button[data-tab=review]').click();
 await ev(page,`select('s-skip')`);
 const box=page.locator('#curChecks');
 await expect(box).toBeVisible();
 await expect(box.locator('summary')).toContainText('1 skipped by AI');
 await box.locator('summary').click();
 await expect(box.locator('li.skip')).toContainText(`Skipped by AI: Longest line in a code block (fits a phone) - “${REASON}”`);
 await expect(box.locator('li.skip')).toContainText('would flag: 1 code line is longer than 27 characters');
 await expect(page.locator('#filter option[value=skipped]')).toHaveText('Checks skipped by AI · 2');
 await page.locator('#filter').selectOption('skipped');
 expect(await ev(page,`filtered().map(c=>c.id).join()`)).toBe('s-skip,s-bad');

 // the prompts carry the skips and say how to make one
 const rev:string=await ev(page,`fixPrompt([cardById('s-skip'),cardById('s-wide')],[...FMT_KEYS])`);
 expect(rev).toContain('"skipped_checks": {"code_line_chars": "the URL can\'t be broken"}');
 const block=JSON.parse(/<<<REVISE_CARDS id=r-[0-9a-f]{8}\n([\s\S]*?)\nREVISE_CARDS>>>/.exec(rev)![1]);
 expect(block.cards.map((c:any)=>c.skipped_checks||null)).toEqual([{code_line_chars:REASON},null]);

 // undo: the check applies again, and the change is saved
 await page.locator('#filter').selectOption('all');
 await ev(page,`select('s-skip')`);
 if (!(await box.evaluate((d:any)=>d.open))) await box.locator('summary').click();
 await box.locator('[data-unskip=code_line_chars]').click();
 expect(await ev(page,`checksOf(cardById('s-skip')).map(x=>x.key).join()`)).toBe('code_line_chars');
 await expect(box.locator('li.skip')).toHaveCount(0);
 await expect.poll(async()=>(await saved(request,pid,'s-skip'))?.skipped_checks ?? null,{timeout:15000}).toBe(null);

 // a checker fix that answers with a skip instead of a change: a change to an approved card, so a re-check with a diff
 await ev(page,`setCardStatus(cardById('s-wide'),'ok');cardById('s-wide').fmt='Q1';cardById('s-wide').fmtSt='copied';cardById('s-wide').fmtRules=[...FMT_KEYS];save()`);
 await page.locator('#tabs button[data-tab=revise]').click();
 await page.locator('details:has(#fqPaste) summary').click();
 await page.locator('#fqPaste').fill(JSON.stringify({revision:true,cards:[{...CARDS[1],skipped_checks:{code_line_chars:'one line on purpose'}}]}));
 await page.locator('#fqApply').click();
 await expect(page.locator('#fqResult')).toContainText('1 approved card changed');
 expect(await ev(page,`JSON.stringify({sk:cardById('s-wide').skipped_checks,rc:!!cardById('s-wide').recheck,st:cardById('s-wide').status,k:checksOf(cardById('s-wide')).length})`))
  .toBe(JSON.stringify({sk:{code_line_chars:'one line on purpose'},rc:true,st:'ok',k:0}));
 const diff:string=await ev(page,`prevDiffHTML(cardById('s-wide'))`);
 expect(diff).toContain('Checks skipped by AI');
 expect(diff).toContain('one line on purpose');
 // the same reply again changes nothing; a revision with {} removes the skips
 await ev(page,`cardById('s-wide').fmt='Q2';cardById('s-wide').fmtSt='copied'`);
 await page.locator('#fqPaste').fill(JSON.stringify({revision:true,cards:[{...CARDS[1],skipped_checks:{code_line_chars:'one line on purpose'}}]}));
 await page.locator('#fqApply').click();
 await expect(page.locator('#fqResult')).toContainText('1 needed no change');
 await ev(page,`applyBundle({revision:true,cards:[{...${JSON.stringify(CARDS[2])},skipped_checks:{}}]},'merge',{revision:true})`);
 expect(await ev(page,`'skipped_checks' in cardById('s-bad')`)).toBe(false);

 // kept across a reload
 await page.waitForFunction('!sync.dirty');
 await page.reload();await page.waitForFunction('Store.on && curProject && S.cards.length===3');
 expect(await ev(page,`JSON.stringify(cardById('s-wide').skipped_checks)`)).toBe(JSON.stringify({code_line_chars:'one line on purpose'}));
});
