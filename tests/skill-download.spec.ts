import {test,expect} from '@playwright/test';
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);

async function open(page:any,request:any,info:any){
 const pid='skdl'+Date.now().toString(36)+info.project.name;
 const headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript((id:string)=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && Store.hosted && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
}

test('the server hands out the skill without a sign-in',async({playwright})=>{
 const anon=await playwright.request.newContext({baseURL:'http://127.0.0.1:3098'});
 const z=await anon.get('/skill/anki.zip');
 expect(z.status()).toBe(200);
 expect(z.headers()['content-type']).toBe('application/zip');
 expect((await z.body()).subarray(0,2).toString()).toBe('PK');
 expect(await (await anon.get('/skill/SKILL.md')).text()).toContain('name: anki');
 expect((await anon.get('/skill/nope.txt')).status()).toBe(404);
 await anon.dispose();
});

test('"Claude downloads it": every skill prompt starts by downloading the skill; Mac jobs leave it out',async({page,request},info)=>{
 await open(page,request,info);
 const base=await ev(page,'location.origin');
 await expect(page.locator('#skillInstall')).toBeVisible();
 await expect(page.locator('#pOut')).toHaveValue(/^Use the \*\*anki\*\* skill/);
 await page.locator('input[name=pSkill][value=web]').check();
 await expect(page.locator('#skillInstall')).toBeHidden();
 await expect(page.locator('#pOut')).toHaveValue(/^## Get the anki skill first/);
 const single:string=await page.locator('#pOut').inputValue();
 expect(single).toContain(`curl -fsSL ${base}/skill/anki.zip -o anki-skill.zip`);
 expect(single).toContain('Use the **anki** skill to make Anki cards.');
 await expect(page.locator('#pSteps')).toContainText('Nothing to install');
 // revisions, global revisions, image fixes and batch planning too
 await ev(page,`applyBundle({cards:[{id:'c1',type:'basic',front:'Q?',back:'A'}]},'merge');S.cards[0].status='change';S.cards[0].feedback='x'`);
 await page.locator('#tabs button[data-tab=revise]').click();
 await page.locator('#btnMakeRevision').click();
 await expect(page.locator('#rvOut')).toHaveValue(/^## Get the anki skill first[\s\S]*Use the \*\*anki\*\* skill's revision workflow/);
 for (const js of [`fixPrompt(S.cards,['why'],null)`, `planPrompt(readPrompt())`])
  expect(await ev(page,js)).toMatch(/^## Get the anki skill first/);
 expect(await ev(page,`itemPrompt({id:'L01',prompt:'Use the **anki** skill to make cards from L01.'},0,1)`)).toMatch(/^## Get the anki skill first[\s\S]*from L01\.$/);
 // a Mac job brings the skill with it
 expect(await ev(page,`forMac($('#rvOut').value)`)).toMatch(/^Use the \*\*anki\*\* skill's revision workflow/);
 // back to installed: as before
 await page.locator('#tabs button[data-tab=prompt]').click();
 await page.locator('input[name=pSkill][value=installed]').check();
 await expect(page.locator('#pOut')).toHaveValue(/^Use the \*\*anki\*\* skill/);
});

test('without the skill, the AI can download anki_helper.py itself',async({page,request},info)=>{
 await open(page,request,info);
 const base=await ev(page,'location.origin');
 await page.locator('input[name=pMode][value=other]').check();
 await page.locator('input[name=pScript][value=web]').check();
 const t:string=await page.locator('#pOut').inputValue();
 expect(t).toContain(`exec(urllib.request.urlopen("${base}/skill/anki_helper.py").read().decode("utf-8"))`);
 expect(t).not.toContain('I attached **anki_helper.py**');
 expect(t).not.toContain('## anki_helper.py');
 await expect(page.locator('#pSteps')).toContainText('downloads anki_helper.py from this Studio');
 expect(await ev(page,`forMac($('#pOut').value)`)).toContain('it is in ./anki-skill/scripts');
 expect(await ev(page,`forMac($('#pOut').value)`)).not.toContain('/skill/anki_helper.py');
 await page.locator('input[name=pScript][value=attach]').check();
 await expect(page.locator('#pOut')).toHaveValue(/I attached \*\*anki_helper\.py\*\*/);
});
