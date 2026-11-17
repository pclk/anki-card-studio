import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('renaming media preserves literal dollar replacement characters in current and previous fields',()=>{
 const src=readFileSync('studio/src/12-image-dialog.js','utf8');
 const S={cards:[{type:'basic',front:'<img src="old.png">',prev:{type:'basic',front:'<img src="old.png">'}}],media:{'old.png':{}}};
 const ctx=vm.createContext({S,FIELDS:{basic:['front']},dropURL:()=>{}});
 vm.runInContext(src.slice(src.indexOf('function renameMedia('),src.indexOf("$('#dlgUse').onclick")),ctx);
 ctx.renameMedia('old.png','$&.png');
 assert.equal(S.cards[0].front,'<img src="$&.png">');assert.equal(S.cards[0].prev.front,S.cards[0].front);
});
test('visual cache bounds retained images and revokes URLs on eviction, replacement and clear',()=>{
 const src=readFileSync('studio/src/16-source-picture.js','utf8'); const revoked:string[]=[];
 const ctx=vm.createContext({URL:{revokeObjectURL:(url:string)=>revoked.push(url)}});
 vm.runInContext(src.slice(src.indexOf('const visCache'),src.indexOf('/** the visual')),ctx);
 vm.runInContext('for(let i=0;i<65;i++) visCache.set(i,{url:String(i)});',ctx);
 assert.equal(vm.runInContext('visCache.size',ctx),64);assert.deepEqual(revoked,['0']);
 vm.runInContext('visCache.set(1,{url:"new"}); visCache.clear()',ctx);
 assert.equal(revoked.length,66);assert.equal(new Set(revoked).size,66);
});
