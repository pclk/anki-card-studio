import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// studio.html is generated: it must match its canonical sources byte for byte (CI only re-checks the sanitizer)
const html = readFileSync('studio/studio.html', 'utf8');
const embedded = (id: string) => {
 const m = html.match(new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`));
 assert.ok(m, id); return m[1].replace(/^\n/, '');
};
for (const [id, path] of Object.entries({skillSrc:'skill/anki/SKILL.md', extractSrc:'skill/anki/scripts/extract.py',
 promptsSrc:'skill/anki/scripts/make_prompts.py', helperSrc:'skill/anki/scripts/anki_helper.py', bridgeSrc:'bridge/acs-bridge.mjs'}))
 test(`embedded ${path} is exactly the canonical file`, () => assert.equal(embedded(id), readFileSync(path, 'utf8')));
test('application script is exactly studio/src in manifest order', () => {
 const names: string[] = JSON.parse(readFileSync('studio/src/manifest.json', 'utf8'));
 const js = names.map(n => readFileSync('studio/src/' + n, 'utf8')).join('');
 const m = html.match(/<!-- app:start --><script>\n([\s\S]*?)<\/script><!-- app:end -->/);
 assert.ok(m); assert.equal(m[1], js);
});
