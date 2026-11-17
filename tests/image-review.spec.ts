import {test,expect} from '@playwright/test';
// a valid 1×1 PNG
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ev=(page:any,js:string)=>page.evaluate((s:string)=>(window as any).eval(s),js);

test('image review: approve or mark broken → Revise builds the image-fix prompt → revision replaces the image',async({page,request},info)=>{
 const pid='img'+Date.now().toString(36)+info.project.name;
 const headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[]}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:0,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty');
 await page.locator('#tabs button[data-tab=prompt]').click();
 const cards=[
  {id:'img-a',type:'basic',front:'<figure><img src="a.png"><figcaption>Heart valves</figcaption></figure>Which valve is shown?',back:'Mitral',why:'w'},
  {id:'img-b',type:'basic',front:'What does the plot show?',back:'<img src="b.png">Growth',why:'w'},
  {id:'img-c',type:'basic',front:'No picture here?',back:'None',why:'w'}];
 await page.locator('#importFile').setInputFiles({name:'anki_bundle.json',mimeType:'application/json',
  buffer:Buffer.from(JSON.stringify({deck:pid,cards,media:[{filename:'a.png',data:PNG},{filename:'b.png',data:PNG}]}))});
 await expect(page.locator('#importResult')).toContainText('3 new cards');
 await page.locator('#tabs button[data-tab=review]').click();

 // open the image review (phones: the button under the card)
 await page.locator(info.project.name==='mobile'?'#hudImgs':'#btnImgReview').click();
 await expect(page.locator('#irDlg')).toBeVisible();
 await expect(page.locator('#irPos')).toHaveText('1 / 2');
 await expect(page.locator('#irSide')).toContainText('a.png');
 await expect(page.locator('#irSide')).toContainText('Heart valves');   // the card's caption
 await expect(page.locator('#irSide')).toContainText('img-a');
 await page.locator('#irNote').fill('labels overlap');
 await page.locator('#irBad').click();
 // the broken image leaves "Not reviewed"; the next one is b.png
 await expect(page.locator('#irPos')).toHaveText('1 / 1');
 await expect(page.locator('#irSide')).toContainText('b.png');
 if (info.project.name==='mobile'){
  // approve with a real right swipe on the image
  const box=(await page.locator('#irImg').boundingBox())!;
  const cdp=await page.context().newCDPSession(page), y=box.y+box.height/2;
  const touch=(type:'touchStart'|'touchMove'|'touchEnd',x:number)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y}]});
  await touch('touchStart',box.x+20);
  for (let x=box.x+40;x<=box.x+box.width-20;x+=30){ await touch('touchMove',x); await page.waitForTimeout(15); }
  await touch('touchEnd',0);
 } else await page.keyboard.press('d');
 await expect(page.locator('#irSide')).toContainText('Every image has been reviewed');
 await expect(page.locator('#irStats')).toHaveText('1 approved · 1 broken · 0 to review');
 // the verdicts are saved with the project
 const media=async()=>ev(page,`fetch('/api/project/'+encodeURIComponent(curProject),{cache:'no-store'}).then(r=>r.json()).then(p=>JSON.stringify(Object.fromEntries(Object.entries(p.media||{}).map(([n,m])=>[n,[m.rv||'',m.rvNote||'']]))))`);
 await expect.poll(media,{timeout:15000}).toBe(JSON.stringify({'a.png':['broken','labels overlap'],'b.png':['ok','']}));

 // Review: the "Broken images" filter and the images panel
 await page.locator('#irClose').click();
 expect(await ev(page,`S.filter='brokenimg';filtered().map(c=>c.id).join()`)).toBe('img-a');
 await ev(page,`S.curId='img-a';renderReview()`);
 await expect(page.locator('#imgList')).toContainText('broken');
 await expect(page.locator('#imgList')).toContainText('labels overlap');
 await ev(page,`S.filter='all';$('#filter').value='all';renderReview()`);
 await expect(page.locator('#tabReviseCount')).toHaveText('1');

 // Revise: the broken image is listed and the prompt asks Claude to redo it
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#biPanel')).toBeVisible();
 await expect(page.locator('#biList .imgrow')).toHaveCount(1);
 await expect(page.locator('#biStats')).toHaveText('1 image on 1 card');
 await page.locator('#biBuild').click();
 const prompt=await page.locator('#biOut').inputValue();
 expect(prompt).toContain('anki_revision.json');
 expect(prompt).toContain('NEW filename');
 const block=JSON.parse(/<<<REVISE_CARDS id=r-[0-9a-f]{8}\n([\s\S]*?)\nREVISE_CARDS>>>/.exec(prompt)![1]);
 expect(prompt).toMatch(/Deck\.load\("r-[0-9a-f]{8}"\)/);
 expect(block.cards.map((c:any)=>c.id)).toEqual(['img-a']);
 expect(block.cards[0].feedback).toMatch(/^Image fix - redo the broken image\(s\): a\.png \(labels overlap\)/);
 expect(block.media).toEqual([{filename:'a.png',origin:'generated',broken:true,problem:'labels overlap'}]);

 // Claude's anki_revision.json: the card now shows a new image
 const revision={format:'anki-studio/v1',revision:true,deck:pid,cards:[{...cards[0],front:cards[0].front.replace('a.png','a-v2.png')}],media:[{filename:'a-v2.png',data:PNG,origin:'generated'}]};
 await page.locator('#reviseFile').setInputFiles({name:'anki_revision.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(revision))});
 await expect(page.locator('#reviseResult')).toContainText('1 updated');
 await page.locator('#tabs button[data-tab=revise]').click();
 await expect(page.locator('#biPanel')).toBeHidden();
 expect(await ev(page,`JSON.stringify([cardById('img-a').status,cardById('img-a').revised,imgVerdict('a-v2.png'),[...imageUses().keys()].join()])`))
  .toBe(JSON.stringify(['new',true,'','a-v2.png,b.png']));
 // the new image is waiting for review
 await page.locator('#tabs button[data-tab=review]').click();
 await page.locator(info.project.name==='mobile'?'#hudImgs':'#btnImgReview').click();
 await expect(page.locator('#irPos')).toHaveText('1 / 1');
 await expect(page.locator('#irSide')).toContainText('a-v2.png');
});

test('a replaced picture starts its image review again; reloading a project keeps verdicts',async({page,request},info)=>{
 const pid='imgr'+Date.now().toString(36)+info.project.name;
 const headers={origin:'http://127.0.0.1:3098'};
 expect((await request.put('/api/project/'+pid,{headers,data:{rev:1,projectName:pid,deck:pid,cards:[{id:'r1',type:'basic',front:'<img src="p.png">Q',back:'A',status:'new'}],media:{'p.png':{origin:'generated'}}}})).ok()).toBeTruthy();
 expect((await request.put('/api/projects',{headers,data:[{id:pid,name:pid,cards:1,updated:Date.now()}]})).ok()).toBeTruthy();
 await page.addInitScript(id=>localStorage.setItem('acs-current',id),pid);
 await page.goto('/');await page.waitForFunction('Store.on && curProject && !sync.dirty && S.cards.length');
 await ev(page,`setMediaBlob('p.png', new Blob([new Uint8Array([1])],{type:'image/png'}));setImgVerdict('p.png','ok');''`);
 await page.waitForFunction('!sync.dirty');
 await page.reload();await page.waitForFunction('Store.on && curProject && !sync.dirty && S.cards.length');
 expect(await ev(page,`imgVerdict('p.png')`)).toBe('ok');
 // a URL image downloading again is the same picture: the verdict stays
 await ev(page,`setMediaBlob('p.png', new Blob([new Uint8Array([1])],{type:'image/png'}), {}, false);''`);
 expect(await ev(page,`imgVerdict('p.png')`)).toBe('ok');
 // a new picture under the same name (dropped image, image dialog, revision with data) is reviewed again
 await ev(page,`setMediaBlob('p.png', new Blob([new Uint8Array([2])],{type:'image/png'}));''`);
 expect(await ev(page,`imgVerdict('p.png')`)).toBe('');
});
