import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

test('tree counts nested decks without prefix collisions and reads each card once', () => {
 const dom = new JSDOM('<div id="tree"></div><input id="treeFilter">');
 let reads = 0;
 const S = {deck:'Root', scope:'root', nodes:[
  {id:'a', name:'Lesson 2', deck:'Root::A'},
  {id:'b', name:'Lesson 10', deck:'Root::AB'},
  {id:'c', name:'Child', deck:'Root::A::Child', parent:'a'},
 ], cards:[{deck:'Root::A'}, {deck:'Root::A::Child'}, {deck:'Root::AB'}]};
 const ctx = vm.createContext({S, projects:[{id:'p'}], curProject:'p', projName:()=> 'Root',
  cardDeck:(c:any)=>{reads++; return c.deck;}, esc:(s:any)=>String(s),
  $:(s:string)=>dom.window.document.querySelector(s), treeClosed:new Set()});
 const source = readFileSync('studio/src/02-tree.js','utf8');
 vm.runInContext(source.slice(0,source.indexOf('/* collapsed tree')) + source.slice(source.indexOf('function renderTree()'),source.indexOf('function renderScopeBar()')) + '\nfunction renderScopeBar(){}; renderTree.noScroll = true; renderTree();',ctx);
 const rows = Array.from(dom.window.document.querySelectorAll('.tn'));
 assert.deepEqual(rows.map(r=>r.querySelector('.nm')!.textContent), ['Root','Lesson 2','Child','Lesson 10']);
 assert.deepEqual(rows.map(r=>r.querySelector('.ct')!.textContent), ['3','2','1','1']);
 assert.equal(reads, S.cards.length);
});
