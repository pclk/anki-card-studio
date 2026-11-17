import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync('studio/src/03-sources.js','utf8');
const picture = readFileSync('studio/src/16-source-picture.js','utf8');
function setup(){
 let destroyed=0, loads=0, finish:any;
 const ready = new Promise(r=>{finish=r});
 const doc = {destroy:async()=>{destroyed++}};
 const ctx=vm.createContext({curProject:'a',S:{sources:[{id:'s'}]},window:{pdfjsLib:{}},Store:{getSourceBlob:async()=>new Blob(['pdf'])},pdfjsLib:{getDocument:()=>{loads++;return {promise:ready}}}});
 vm.runInContext(source.slice(source.indexOf('class SourceDocumentCache'), source.indexOf('const SRC_ICON'))+picture.slice(picture.indexOf('const pendingSourceDocuments'),picture.indexOf('/** find the quote')),ctx);
 return {ctx,finish:()=>finish(doc),destroyed:()=>destroyed,loads:()=>loads};
}
test('concurrent PDF requests share a load and clearing destroys the cached document',async()=>{
 const h=setup(); const a=vm.runInContext('srcDoc({id:"s"})',h.ctx),b=vm.runInContext('srcDoc({id:"s"})',h.ctx);
 h.finish(); assert.equal(await a,await b); assert.equal(h.loads(),1);
 vm.runInContext('clearSourceDocuments()',h.ctx); await Promise.resolve(); assert.equal(h.destroyed(),1);
});
test('PDF completion after project switch is destroyed and cannot populate the new cache',async()=>{
 const h=setup();const pending=vm.runInContext('srcDoc({id:"s"})',h.ctx);
 vm.runInContext('curProject="b"; clearSourceDocuments()',h.ctx);h.finish();
 assert.equal(await pending,null);assert.equal(h.destroyed(),1);assert.equal(vm.runInContext('srcDocCache.size',h.ctx),0);
});
