import {readFileSync,writeFileSync} from 'node:fs';
let html=readFileSync('studio/studio.html','utf8');
const names=JSON.parse(readFileSync('studio/src/manifest.json','utf8'));
const js=names.map(n=>readFileSync('studio/src/'+n,'utf8')).join('');
html=html.replace(/<!-- app:start -->[\s\S]*?<!-- app:end -->/,()=>`<!-- app:start --><script>\n${js}</script><!-- app:end -->`);
for(const [id,path] of Object.entries({skillSrc:'skill/anki/SKILL.md',extractSrc:'skill/anki/scripts/extract.py',promptsSrc:'skill/anki/scripts/make_prompts.py',helperSrc:'skill/anki/scripts/anki_helper.py',bridgeSrc:'bridge/acs-bridge.mjs',cliSrc:'bridge/acs-cli.mjs'})){
 const source=readFileSync(path,'utf8');
 if (/<\/script/i.test(source)) throw new Error('Embedded source contains an HTML script terminator: '+path);
 html=html.replace(new RegExp('(<script type="text/plain" id="'+id+'">)[\\s\\S]*?(</script>)'),(_,start,end)=>start+'\n'+source+end);
}
writeFileSync('studio/studio.html',html);
