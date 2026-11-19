import {test,expect} from '@playwright/test';
// 2026-11-17 sweep: a revised card's previous version is its own copy. "Undo skip" on the card used to delete the skip
// from the previous version too (they shared one object), so the diff no longer showed what the revision changed.
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);
const WHY='<p><b>Tests:</b> recalling the idea in its own words.</p><p><b>Why it matters:</b> later topics build on it, so a shaky grasp here causes errors in every exercise that uses it.</p><p><b>Common mistake:</b> mixing it up with the closely related idea from the same lecture.</p><p><b>Connects to:</b> the next chapter.</p>';
const WIDE='<pre><code class="language-java">public ColoredCircle(Circle c, String colour) {</code></pre>';
const REF=[{file:'L01.pdf',page:3,quote:'a constructor'}];

test('Undo skip after a revision leaves the previous version as it was',async({page,request},info)=>{
 const pid='sweep'+Date.now().toString(36)+info.project.name, headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');
 // curProject is set just before its state loads: wait for the state too, or loadState would wipe the import below
 await page.waitForFunction((id:string)=>{const w=window as any;return w.eval('Store.on && curProject && !sync.dirty && S.projectName')===id;},pid);
 await ev(page,`applyBundle({deck:${JSON.stringify(pid)},cards:[{id:'w1',type:'basic',front:'What does this declare?',back:${JSON.stringify(WIDE)},why:${JSON.stringify(WHY)},refs:${JSON.stringify(REF)},skipped_checks:{code_line_chars:'the signature is what it tests'}}]},'merge');save();refreshAll()`);
 // a revision that changes the front and says nothing about the skips or the refs: the card keeps both
 await ev(page,`applyBundle({revision:true,cards:[{id:'w1',type:'basic',front:'What does this line declare?',back:${JSON.stringify(WIDE)},why:${JSON.stringify(WHY)}}]},'merge',{revision:true});save();refreshAll()`);
 expect(await ev(page,`JSON.stringify(cardById('w1').prev.skipped_checks)`)).toBe(JSON.stringify({code_line_chars:'the signature is what it tests'}));
 expect(await ev(page,`cardById('w1').prev.skipped_checks!==cardById('w1').skipped_checks && cardById('w1').prev.refs!==cardById('w1').refs`)).toBe(true);

 await page.locator('#tabs button[data-tab=review]').click();
 await ev(page,`select('w1')`);
 const box=page.locator('#curChecks');
 if (!(await box.evaluate((d:any)=>d.open))) await box.locator('summary').click();
 await box.locator('[data-unskip=code_line_chars]').click();
 // the card lost its skip; its previous version still has it, so the diff shows the change
 expect(await ev(page,`'skipped_checks' in cardById('w1')`)).toBe(false);
 expect(await ev(page,`JSON.stringify(cardById('w1').prev.skipped_checks)`)).toBe(JSON.stringify({code_line_chars:'the signature is what it tests'}));
 const diff:string=await ev(page,`prevDiffHTML(cardById('w1'))`);
 expect(diff).toContain('Checks skipped by AI');
 expect(diff).toContain('the signature is what it tests');
 // and it is saved that way
 await expect.poll(async()=>(await (await request.get('/api/project/'+pid)).json()).cards?.[0]?.prev?.skipped_checks,{timeout:15000}).toEqual({code_line_chars:'the signature is what it tests'});
});
