import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('late PDF page rendering cannot replace the latest selected page', async () => {
  const pending: (()=>void)[] = [];
  const elements = new Map();
  let drawn: any;
  const ctx: any = {safeName:()=>"image",$: (s: string) => { if (!elements.has(s)) elements.set(s, {value:'',addEventListener(){}}); return elements.get(s); }, document:{createElement:()=>({getContext:()=>({fillRect(){}})})}, S:{media:{}}, source: {kind:'pdf',page:1,pages:2,pdf:{getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:new Promise<void>(r=>pending.push(r))})})}}};
  const source = readFileSync('studio/src/12-image-dialog.js','utf8');
  runInNewContext(source + '\nrenderSources=()=>{};updateSel=()=>{};drawStage=()=>{ captured(curSource.canvas); };globalThis.show=showSource;', Object.assign(ctx,{captured:(v:any)=>drawn=v}));
  const first=ctx.show(ctx.source); await new Promise(r=>setImmediate(r));
  ctx.source.page=2; const second=ctx.show(ctx.source); await new Promise(r=>setImmediate(r));
  pending[1](); await second; const newest=drawn;
  pending[0](); await first;
  assert.equal(ctx.source.canvas,newest);
});
