import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const html = readFileSync('studio/studio.html', 'utf8');
test('bundled sanitizer blocks active markup and keeps card formatting', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(html.match(/<!-- sanitizer:start -->\s*<script>([\s\S]*?)<\/script>/)![1]);
  w.eval(html.match(/function sanitizeInto\(el, html\)\{[\s\S]*?\n\}/)![0]);
  const el = w.document.createElement('div');
  w.sanitizeInto(el, '<a href="java&#10;script:alert(1)">bad</a><svg onload="alert(1)"><a xlink:href="javascript:alert(1)">x</a></svg><img src="photo.png" onerror="alert(1)"><iframe srcdoc="bad"></iframe><b>answer</b><math><mi>x</mi></math>');
  assert.equal(el.querySelector('iframe'), null);
  for (const n of el.querySelectorAll('*')) for (const a of n.attributes) {
    assert.ok(!/^on/i.test(a.name));
    assert.ok(!/javascript:/i.test(a.value.replace(/\s/g, '')));
  }
  assert.equal(el.querySelector('b')?.textContent, 'answer');
  assert.equal(el.querySelector('img')?.getAttribute('src'), 'photo.png');
  assert.ok(el.querySelector('math'));
  dom.window.close();
});

test('HTML text helpers use inert documents and retain readable text',()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});const w=dom.window;
 w.eval(html.match(/const stripHtml =[^\n]+/)![0]+';window.stripHtml=stripHtml;');
 w.eval(html.match(/function htmlToText\(h\)\{[\s\S]*?\n\}/)![0]);
 w.document.createElement=()=>{throw Error('must not create live elements');};
 assert.match(w.stripHtml('<image src=x onerror=alert(1)>Answer'),/Answer/);
 assert.match(w.htmlToText('<img src=x onerror=alert(1)>Answer'),/Answer/);
 dom.window.close();
});
for(const payload of ['<form><input></form>','<style>body{display:none}</style>','<a href="vbscript:evil">x</a>','<a href="data:text/html,evil">x</a>']) test('sanitizer rejects '+payload,()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});const w=dom.window;
 w.eval(html.match(/<!-- sanitizer:start -->\s*<script>([\s\S]*?)<\/script>/)![1]);
 w.eval(html.match(/function sanitizeInto\(el, html\)\{[\s\S]*?\n\}/)![0]);
 const el=w.document.createElement('div');w.sanitizeInto(el,payload);
 assert.equal(el.querySelector('form,input,style,[href]'),null);dom.window.close();
});
test('image max-width survives without unsafe inline CSS',()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});const w=dom.window;
 w.eval(html.match(/<!-- sanitizer:start -->\s*<script>([\s\S]*?)<\/script>/)![1]);
 w.eval(html.match(/function sanitizeInto\(el, html\)\{[\s\S]*?\n\}/)![0]);
 const el=w.document.createElement('div');w.sanitizeInto(el,'<img src="a.png" style="max-width:320px;position:fixed">');
 assert.equal(el.querySelector('img')?.style.maxWidth,'320px');
 assert.equal(el.querySelector('img')?.style.position,'');
 dom.window.close();
});
test('missing sanitizer falls back to literal text',()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});const w=dom.window;
 w.eval(html.match(/function sanitizeInto\(el, html\)\{[\s\S]*?\n\}/)![0]);
 const el=w.document.createElement('div');w.sanitizeInto(el,'<img src=x onerror=alert(1)>');
 assert.equal(el.children.length,0);assert.match(el.textContent!,/onerror/);dom.window.close();
});
