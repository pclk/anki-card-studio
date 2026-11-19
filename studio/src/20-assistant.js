/* ====================================================================== ASSISTANT */
/* "Ask Claude": a request about this project in your own words, run on the Mac bridge. The job gets the project as
   files - acs_project.json (every card with its fields, status, sub-deck, hidden notes, sources, the Checker's results
   and facts about its make-up), acs_sources.json (the text of the sources), optionally the source files, and acs.mjs
   (bridge/acs-cli.mjs), a command-line tool that lists, filters and searches them - so the agent can look at
   everything, and it answers in reply.md. When the request allows changes it can also edit cards (anki_revision.json:
   applied like a global revision - statuses kept, approved cards it changes wait for a re-check) and propose actions
   (anki_actions.json: statuses, tags, sub-decks, feedback, notes on the card, global revisions, Checker settings, the
   hidden-notes setting, .apkg exports, new projects, deleting another project). Optionally the card images
   (acs_media.json) and the user's other projects (read-only) come along too. Nothing is applied until you look at it
   and click Apply - or, if you chose so, as soon as it arrives (deleting a project always asks). Without a bridge, "Copy for a chat" gives the same prompt and downloads the
   files to attach; the chat's files are then dropped here. */
const cliSource = () => $('#cliSrc').textContent.replace(/^\n/, '');
const ASK = {replies: new Map(), proposals: new Map(), done: new Set()};   // per job: its reply.md, its proposal; handled here
/** the has: facts: the filter's conditions that take no value */
const askFacts = () => COND_DEFS.filter(d => !d.args);
function cardMeasures(c){
  const pl = cardPlain(c), cl = codeLines(c), cloze = c.type === 'cloze';
  return {q_words: wordsIn(pl.q), a_words: wordsIn(pl.a), notes_words: wordsIn(pl.why),
    front_chars: cloze ? 0 : decodeEnt(String(c.front || '').replace(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/gi, '').replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, '').replace(/<[^>]+>/g, '')).length,
    images: cardImages(c).length, code_lines: cl.filter(l => l.trim()).length, code_width: Math.max(0, ...cl.map(l => l.length)),
    cloze_n: cloze ? new Set([...String(c.text || '').matchAll(/\{\{c(\d+)::/g)].map(m => m[1])).size : 0,
    q_marks: (pl.q.match(/\?/g) || []).length, refs: cardRefs(c).length, tags: (c.tags || []).length, time: Math.round(c.time || 0)};
}
/** one card as the agent sees it: its content, its review state, and what the Checker and the filter know about it.
    ctx: another project's deck and "hidden notes on every card" (that project isn't the open one) */
function askCard(c, ctx = null){
  const o = {id: c.id, type: c.type, deck: ctx ? c.deck || ctx.deck : cardDeck(c), status: c.status};
  for (const f of FIELDS[c.type]) o[f] = c[f] || '';
  Object.assign(o, {why: c.why || '', tags: c.tags || [], refs: c.refs || [], feedback: c.feedback || ''});
  for (const k of ['skipped_checks', 'edited', 'revised', 'recheck', 'ord']) if (c[k] !== undefined && c[k] !== false) o[k] = c[k];
  const pl = cardPlain(c);
  o.notesOnCard = ctx ? !!(c.why && c.why.trim()) && (c.whyOnCard === true || (c.whyOnCard !== false && !!ctx.whyAll)) : whyOn(c);
  o.plain = {q: pl.q, a: pl.a, why: pl.why, source: pl.source};
  o.checks = checksOf(c).concat(!ctx && cardMissing(c) ? [{key: 'missing_img', level: 'W', msg: 'An image is missing or not loaded.'}] : []);
  o.facts = Object.fromEntries(askFacts().map(d => { try { return [d.key, !!d.test(c, {}, null)]; } catch { return [d.key, false]; } }));
  o.facts.notes_on_card = o.notesOnCard;
  o.measures = cardMeasures(c);
  o.langs = codeLangs(c); o.boxes = [...new Set([...cardHTMLAll(c).matchAll(/aa-box aa-([\w-]+)/g)].map(m => m[1]))]; o.images = cardImages(c);
  return o;
}
const askCards = () => S.cards.filter(c => $('#askScope').value !== 'scope' || inScope(c));
const mediaInfo = (media, names) => names.filter(n => media[n]).map(n => { const m = media[n], e = {filename: n, origin: m.origin}; for (const k of ['url', 'hint', 'caption', 'credit']) if (m[k]) e[k] = m[k]; return e; });
/** the user's other projects, read-only (their cards as the agent sees them, without the sources) */
async function askOthers(){
  const out = [];
  for (const pr of projects.filter(x => x.id !== curProject)){
    try { const st = await Store.getProject(pr.id); if (!st) continue;
      out.push({id: pr.id, name: st.projectName || st.deck || pr.name, deck: st.deck || pr.name, cards: (st.cards || []).map(c => askCard(c, {deck: st.deck || pr.name, whyAll: !!st.whyAll}))}); } catch {}
  }
  return out;
}
/** acs_project.json (and the sources' text, which source files go along, and the card images when asked) */
async function askSnapshot(withFiles, {images = false, others = false} = {}){
  const n = $('#askScope').value === 'scope' ? scopeNode() : null;
  const atts = withFiles ? planAttachments(S.sources.filter(hasFile).map(src => ({src, pages: null}))) : [];
  const project = {format: 'acs-project/v1', bundleFormat: FORMAT, project: S.projectName || S.deck, deck: S.deck, scope: n ? nodeDeckOf(n) : null,
    tags: S.tags || [], exported: new Date().toISOString(), notesSpec: notesSpec(), checkSettings: ck(),
    checkDefs: CHECK_DEFS.map(d => ({key: d.key, label: d.label, group: d.group})), fixRules: FIX_RULES,
    factLabels: Object.fromEntries(askFacts().map(d => [d.key, d.label])), allIds: S.cards.map(c => c.id), mediaInfo: mediaInfo(S.media, Object.keys(S.media)),
    sources: S.sources.map(s => ({id: s.id, name: s.name, kind: s.kind, ...((atts.find(a => a.src.id === s.id) || {}).name ? {file: atts.find(a => a.src.id === s.id).name} : {})})),
    cards: askCards().map(c => askCard(c)), ...(others ? {others: await askOthers()} : {})};
  let media = null;
  if (images){
    const names = [...new Set(project.cards.flatMap(c => c.images))]; await ensureMedia(names);
    media = {format: 'acs-media/v1', images: {}};
    for (const n of names){ const b = S.media[n] && S.media[n].blob; if (b) media.images[n] = {type: b.type, data: await blobToB64(b)}; }
  }
  const sources = [];
  for (const s of S.sources){ try { sources.push({id: s.id, name: s.name, kind: s.kind, pages: (await loadSourcePages(s)).map(p => ({page: p.page, text: p.text}))}); } catch {} }
  return {project, sources: {format: 'acs-sources/v1', sources}, media, atts};
}
function askPrompt(req, {write, atts, chat, images, others}){
  const n = $('#askScope').value === 'scope' ? scopeNode() : null, here = chat ? 'I attached' : 'This folder has';
  return `${chat ? skillGetSection() : ''}You are helping me with my Anki Card Studio project "${S.projectName || S.deck}". My request:

<<<REQUEST
${req}
REQUEST>>>

## The project
${here} the whole project${n ? ` (only the sub-deck "${nodeDeckOf(n)}")` : ''}: **acs_project.json** (every card with its fields, status, sub-deck, tags, hidden notes ("why"), sources and my feedback, plus what the Checker found and facts about each card's make-up), **acs_sources.json** (the text of my source files, page by page)${atts.length ? `, and the source files themselves (${attachNames(atts)})` : ''}, ${images ? ', **acs_media.json** (the card images: `node acs.mjs images`, `extract-images`)' : ''}${others ? ', my other projects inside acs_project.json (read-only: `node acs.mjs projects`, search them with `--all-projects` or `project:NAME`)' : ''} and **acs.mjs**, a command-line tool for them${chat ? ' (save the files in one folder)' : ''}.
- Start with \`node acs.mjs info\` and \`node acs.mjs help\`: it explains the query language, e.g. \`node acs.mjs cards 'has:code_block -lang:java status:ok'\`, \`node acs.mjs search '/\\bdeadlock/'\`, \`node acs.mjs show c012\`, \`node acs.mjs source lecture3 --grep heap\`.
- For anything the tool doesn't do, read the JSON yourself (Python or jq).
- Statuses: new = unreviewed, ok = approved, change = I asked for a change, drop = excluded. Each card's hidden notes hold ${notesSpec() || 'why it was made'}.

## What you may do
${write ? `- **Change cards' content** with the anki skill: \`node acs.mjs export QUERY -o cards.json\`, then \`deck = Deck.load("cards.json")\` with the skill's helper, change the cards (keep their ids; follow the skill's card-writing rules), \`deck.validate()\`, and \`deck.save(revision=True)\` → anki_revision.json in the output folder. Each card keeps its status: approved cards you change wait for my re-check, new cards (splits, additions) come in unreviewed.
- **Everything else** with the tool's actions: \`status\`, \`tag\`, \`move\`, \`feedback\`, \`notes-on-card\`, \`global-revision\`, \`set-check\`, \`set-notes\`, \`export-apkg\`, \`new-project\` and \`delete-project\` (see help). They are written to anki_actions.json in the output folder; give each a \`--why\`.
- I see every change and action, and apply them myself. Change only what the request is about.${chat ? '\n- Give me anki_revision.json and anki_actions.json (whichever you made) as downloads.' : ''}`
  : `- **Only look and answer.** Don't change cards, and don't make anki_revision.json or anki_actions.json.`}

## Your reply
End with a short answer in Markdown: what you found (with card ids), and ${write ? 'what you changed or propose' : 'what you would suggest'}.${chat ? '' : ' It is shown to me in the Studio.'}`;
}
const askFilesFor = (snap, prompt) => [
  {name: 'acs_project.json', blob: new Blob([JSON.stringify(snap.project)], {type: 'application/json'})},
  {name: 'acs_sources.json', blob: new Blob([JSON.stringify(snap.sources)], {type: 'application/json'})},
  ...(snap.media ? [{name: 'acs_media.json', blob: new Blob([JSON.stringify(snap.media)], {type: 'application/json'})}] : []),
  {name: 'acs.mjs', blob: new Blob([cliSource()], {type: 'text/javascript'})}, ...(prompt ? [{name: 'anki_prompt.txt', blob: new Blob([prompt], {type: 'text/plain'})}] : [])];
function askRequest(){ const t = $('#askText').value.trim(); if (!t) toast('Write what you want Claude to do first'); return t; }
const askOpts = () => ({images: $('#askImages').checked, others: $('#askOthers').checked});
$('#askRun').onclick = async () => {
  const req = askRequest(); if (!req) return;
  const write = $('#askWrite').checked, o = askOpts(), snap = await askSnapshot($('#askFiles').checked, o);
  const j = await runOnMac({kind: 'ask', title: shorten(req, 120), prompt: askPrompt(req, {write, atts: snap.atts, ...o}), atts: snap.atts, extra: askFilesFor(snap), meta: {ask: {write, auto: write && $('#askAuto').checked}}});
  if (j){ toast('🖥 Sent to your Mac - the answer appears below', 4000); renderAsk(); }
};
$('#askCopy').onclick = async () => {
  const req = askRequest(); if (!req) return;
  const write = $('#askWrite').checked, o = askOpts(), snap = await askSnapshot($('#askFiles').checked, o);
  await copyPrompt(askPrompt(req, {write, atts: snap.atts, chat: true, ...o}));
  const files = askFilesFor(snap); for (const f of files) download(f.blob, f.name);
  if (snap.atts.length) await downloadAttachments(snap.atts);
  toast(`Prompt copied - attach ${files.map(f => f.name).join(', ')}${snap.atts.length ? ' and the source files' : ''} (in Downloads), then paste it`, 6000);
};
$('#askScope').onchange = renderAskInfo;
$('#askWrite').onchange = () => { $('#askAuto').disabled = !$('#askWrite').checked; };
function renderAskInfo(){
  const n = askCards().length, dev = (BR.devices || []).find(d => d.info && d.info.version);
  $('#askInfo').textContent = `${n} card${n === 1 ? '' : 's'}${$('#askScope').value === 'scope' && scopeNode() ? ` in ${nodeDeckOf(scopeNode())}` : ''} · ${S.sources.length} source${S.sources.length === 1 ? '' : 's'}`
    + (dev && +dev.info.version < 3 ? ' · your Mac bridge is an older version: download acs-bridge.mjs again (Settings → Mac bridge) and run install, so it can send back proposed actions' : '');
}

/* ---- what comes back: the answer, and a proposal (card changes and actions) to look at and apply */
const ACT_LABEL = {status: 'Set status', tag: 'Tags', move: 'Move to sub-deck', feedback: 'Request a change', notes_on_card: 'Hidden notes on the card', global_revision: 'Queue a global revision',
  check_setting: 'Checker setting', notes_spec: 'Hidden-notes setting', export_apkg: 'Export an Anki package', new_project: 'New project', delete_project: 'Delete a project'};
const STATUS_WORD = {new: 'unreviewed', ok: 'approved', change: 'change requested', drop: 'excluded'};
function describeAct(a){
  const n = a.ids ? `${a.ids.length} card${a.ids.length === 1 ? '' : 's'}` : esc(a.id || '');
  const what = a.op === 'status' ? `→ ${STATUS_WORD[a.status] || esc(a.status)}${a.feedback ? `: “${esc(a.feedback)}”` : ''}` : a.op === 'tag' ? [a.add && a.add.length && `add ${esc(a.add.join(' '))}`, a.remove && a.remove.length && `remove ${esc(a.remove.join(' '))}`].filter(Boolean).join(', ')
    : a.op === 'move' ? `→ ${esc(a.deck)}` : a.op === 'feedback' ? `“${esc(a.text)}”` : a.op === 'notes_on_card' ? (a.on ? 'on' : 'off')
    : a.op === 'global_revision' ? `${a.instr ? `“${esc(shorten(a.instr, 80))}”` : ''}${a.rules && a.rules.length ? ` + fix ${esc(a.rules.join(', '))}` : ''}`
    : a.op === 'check_setting' ? `${esc(a.key)} → ${esc(String(a.value))} <span class="muted">(now ${esc(String(ck()[a.key]))})</span>` : a.op === 'notes_spec' ? (a.text ? `“${esc(shorten(a.text, 100))}”` : 'the default (why each card was made)')
    : a.op === 'export_apkg' ? (a.deck ? `as ${esc(a.deck)}` : '') : a.op === 'new_project' ? `“${esc(a.name)}”${a.move ? ' (moved out of this one)' : ' (copies)'}`
    : a.op === 'delete_project' ? `<b style="color:var(--bad)">“${esc(a.name)}”</b> (you type its name to confirm)` : '';
  if (!a.ids && !a.id || a.op === 'delete_project') return `<b>${esc(ACT_LABEL[a.op] || a.op)}</b> ${what}${a.why ? `<div class="small muted">${esc(a.why)}</div>` : ''}`;
  const ids = a.ids ? a.ids.slice(0, 8).map(i => `<a href="#" data-card="${esc(i)}">${esc(i)}</a>`).join(', ') + (a.ids.length > 8 ? ' …' : '') : `<a href="#" data-card="${esc(a.id)}">${esc(a.id)}</a>`;
  return `<b>${esc(ACT_LABEL[a.op] || a.op)}</b> ${what} <span class="muted">· ${n}: ${ids}</span>${a.why ? `<div class="small muted">${esc(a.why)}</div>` : ''}`;
}
function proposalHTML(p, key){
  const rv = p.revision, cards = rv ? (rv.cards || []) : [], acts = p.actions || [];
  if (!cards.length && !acts.length) return '';
  const ch = cards.filter(c => !c.delete && !c.not_applicable && cardById(c.id)), add = cards.filter(c => !c.delete && !c.not_applicable && !cardById(c.id)), del = cards.filter(c => c.delete);
  return `<div class="ask-prop"><b>Proposed changes</b>
    ${cards.length ? `<div class="small">Cards: ${[ch.length && `${ch.length} changed`, add.length && `${add.length} new`, del.length && `${del.length} excluded`].filter(Boolean).join(', ') || 'none'} <span class="muted">(${[...ch, ...del].slice(0, 10).map(c => `<a href="#" data-card="${esc(c.id)}">${esc(c.id)}</a>`).join(', ')}${ch.length + del.length > 10 ? ' …' : ''})</span> - they keep their status; approved ones wait for a re-check.</div>` : ''}
    ${acts.length ? `<ol class="small" style="margin:4px 0;padding-left:18px">${acts.map(a => `<li>${describeAct(a)}</li>`).join('')}</ol>` : ''}
    <div class="row"><span class="spacer"></span><button class="btn sm" data-ask="discard" data-key="${esc(key)}">Discard</button><button class="btn sm primary" data-ask="apply" data-key="${esc(key)}">Apply</button></div></div>`;
}
/** minimal Markdown for the answer: code blocks, inline code, bold, headings and lists - everything else is text */
function mdLite(md){
  const blocks = String(md || '').split(/```[^\n]*\n([\s\S]*?)```/g);
  return blocks.map((b, i) => i % 2 ? `<pre>${esc(b)}</pre>` : b.split(/\n{2,}/).map(par => {
    const line = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const ls = par.split('\n').filter(l => l.trim());
    if (!ls.length) return '';
    if (ls.every(l => /^\s*(?:[-*]|\d+\.)\s/.test(l))) return `<ul>${ls.map(l => `<li>${line(l.replace(/^\s*(?:[-*]|\d+\.)\s/, ''))}</li>`).join('')}</ul>`;
    if (/^#{1,4}\s/.test(ls[0])) return `<h4>${line(ls[0].replace(/^#+\s/, ''))}</h4>${ls.length > 1 ? `<p>${ls.slice(1).map(line).join('<br>')}</p>` : ''}`;
    return `<p>${ls.map(line).join('<br>')}</p>`;
  }).join('')).join('');
}
const askJobs = () => BR.jobs.filter(j => j.kind === 'ask');
async function loadAskResult(j){
  if (ASK.replies.has(j.id) || ASK.loading === j.id) return;
  ASK.loading = j.id;
  try {
    const get = async n => (j.outputs || []).includes(n) ? Store.getBlob(`jobs/${j.id}/out/${n}`).then(b => b ? b.text() : null).catch(() => null) : null;
    const [reply, rv, acts] = await Promise.all([get('reply.md'), get('anki_revision.json'), get('anki_actions.json')]);
    ASK.replies.set(j.id, reply || '');
    const parse = t => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
    ASK.proposals.set(j.id, {revision: parse(rv), actions: (parse(acts) || {}).actions || [], job: j});
  } finally { ASK.loading = null; }
  // "apply as soon as it arrives": not when it would delete a project (that always waits for you)
  const p = ASK.proposals.get(j.id);
  if (j.meta && j.meta.ask && j.meta.ask.auto && !j.importedAt && p && ((p.revision && (p.revision.cards || []).length) || p.actions.length) && !p.actions.some(a => a.op === 'delete_project')){
    try { await applyProposal(j.id); } catch (er) { toast(er.message); }
    return;
  }
  renderAsk();
}
function renderAsk(){
  if (!$('#askList')) return;
  $('#askRun').hidden = !bridgeReady();
  renderAskInfo();
  const jobs = askJobs();
  $('#askList').innerHTML = jobs.length ? jobs.map(j => {
    const reply = ASK.replies.get(j.id), p = ASK.proposals.get(j.id), handled = j.importedAt || ASK.done.has(j.id);
    if (j.status === 'done' && reply === undefined) loadAskResult(j);
    return `<div class="ask-item" data-job="${esc(j.id)}"><div class="row" style="gap:8px"><b style="min-width:0;overflow-wrap:anywhere">${esc(j.title)}</b><span class="spacer"></span>
      <span class="pill ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'running' ? 'warn' : ''}">${JOB_LABEL[j.status] || esc(j.status)}</span><span class="small muted">${esc(ago(j.created))}</span></div>
      ${j.error && j.status !== 'cancelled' ? `<div class="small" style="color:var(--bad)">${esc(j.error)}</div>` : ''}
      ${reply ? `<div class="ask-reply">${mdLite(reply)}</div>` : j.status === 'done' ? '<div class="small muted">Loading the answer…</div>' : JOB_OPEN.includes(j.status) ? '<div class="small muted">Working on it… (🖥 Mac jobs shows the live log)</div>' : ''}
      ${p && !handled ? proposalHTML(p, j.id) : p && (p.revision || (p.actions || []).length) ? '<div class="small muted">Its proposed changes were applied or discarded.</div>' : ''}</div>`;
  }).join('') : '<div class="small muted">No questions yet.</div>';
  const pend = ASK.proposals.get('drop');
  $('#askPending').innerHTML = pend && !ASK.done.has('drop') ? proposalHTML(pend, 'drop') : '';
}
/** apply the actions; returns what was done and what couldn't be (unknown cards, bad values) */
async function applyActions(actions){
  const out = {done: 0, cards: new Set(), errors: [], later: []}, rulesOk = new Set(FIX_RULES);
  const cardsOf = a => (a.ids || []).map(id => cardById(id)).filter(Boolean);
  for (const [k, a] of actions.entries()){
    if (['check_setting', 'notes_spec', 'delete_project'].includes(a.op)){ const e = await applySetting(a); if (e) out.errors.push(`${k + 1}. ${e}`); else out.done++; continue; }
    const missing = (a.ids || (a.id ? [a.id] : [])).filter(id => !cardById(id));
    if (missing.length) out.errors.push(`${k + 1}. unknown card${missing.length > 1 ? 's' : ''} ${missing.slice(0, 5).join(', ')}`);
    const cs = a.id ? [cardById(a.id)].filter(Boolean) : cardsOf(a);
    if (!cs.length) continue;
    if (a.op === 'status' && ['new', 'ok', 'change', 'drop'].includes(a.status)) cs.forEach(c => { setCardStatus(c, a.status); if (a.feedback && a.status === 'change') c.feedback = String(a.feedback); });
    else if (a.op === 'tag') cs.forEach(c => { const t = new Set(c.tags || []); (a.add || []).forEach(x => t.add(String(x))); (a.remove || []).forEach(x => t.delete(String(x))); c.tags = [...t]; });
    else if (a.op === 'move' && typeof a.deck === 'string' && (a.deck === S.deck || a.deck.startsWith(S.deck + '::'))) cs.forEach(c => { if (a.deck === S.deck) delete c.deck; else c.deck = a.deck; });
    else if (a.op === 'feedback' && a.text) cs.forEach(c => { setCardStatus(c, 'change'); c.feedback = String(a.text); });
    else if (a.op === 'notes_on_card') cs.forEach(c => { c.whyOnCard = !!a.on; });
    else if (a.op === 'global_revision'){
      const rules = (a.rules || []).filter(r => rulesOk.has(r)), instr = String(a.instr || '').trim(), q = cs.filter(c => !c.fmt && c.status !== 'drop');
      if (!rules.length && !instr){ out.errors.push(`${k + 1}. a global revision needs an instruction or rules`); continue; }
      queueRevision(q, rules, instr ? {instr, mode: a.mode === 'format' ? 'format' : 'content', split: !!a.split, del: !!a.del} : null);
      if (q.length < cs.length) out.errors.push(`${k + 1}. ${cs.length - q.length} card(s) were already queued or excluded`);
    } else if (a.op === 'export_apkg'){
      try { const r = await exportApkg(ordered(cs, S.order || 'source'), String(a.deck || S.deck).trim()); toast(`Downloaded ${r.fname}`); }
      catch (er) { out.errors.push(`${k + 1}. the export failed: ${er.message}`); continue; }
    } else if (a.op === 'new_project' && String(a.name || '').trim()){ out.later.push({...a, cards: cs}); continue; }
    else { out.errors.push(`${k + 1}. not understood: ${shorten(J(a), 80)}`); continue; }
    out.done++; cs.forEach(c => out.cards.add(c.id));
  }
  return out;
}
/** a setting the agent proposed; returns what went wrong, if anything */
async function applySetting(a){
  if (a.op === 'check_setting'){
    const d = CHECK_DEFS.find(x => x.key === a.key); if (!d) return `no Checker setting ${a.key}`;
    const v = d.kind === 'level' ? String(a.value) : Number(a.value);
    if (d.kind === 'level' ? !['error', 'warn', 'off'].includes(v) : !(Number.isInteger(v) && v >= 0)) return `${a.key} can't be ${a.value}`;
    SET.checks = {...ck(), [d.key]: v}; saveSettings(); renderCheckSettings(); return '';
  }
  if (a.op === 'notes_spec'){ S.prompt = {...(S.prompt || {}), pNotes: String(a.text || '')}; writePrompt(S.prompt); buildPrompt(); return ''; }
  // deleting another project: only the user, by typing its name
  const pr = projects.find(x => x.id === a.id); if (!pr) return `there is no project ${a.name}`;
  if (pr.id === curProject) return 'the open project is deleted from the sidebar, not from here';
  const typed = prompt(`Claude proposes to delete the project “${pr.name}”${a.why ? ` (${a.why})` : ''}.\nType its name to delete it, or leave this empty to keep it:`, '');
  if ((typed || '').trim() !== pr.name) return `kept the project ${pr.name}`;
  await Store.delProject(pr.id); projects = projects.filter(x => x.id !== pr.id); await Store.putIndex(projects); renderProjects(); return '';
}
/** a new project with copies of the cards (and the images they use); with move, they leave this one. Comes back here */
async function newProjectFrom(name, cards, move){
  const names = [...new Set(cards.flatMap(cardImages))]; await ensureMedia(names);
  const media = [];
  for (const m of mediaInfo(S.media, names)){ const b = S.media[m.filename].blob; media.push(b ? {...m, data: await blobToB64(b), mime: b.type} : m); }
  const root = S.deck, back = curProject;
  const copies = cards.map(c => { const o = JSON.parse(J(c)); for (const k of ['fmt', 'fmtSt', 'fmtJob', 'fmtDone', 'fmtRules', 'fmtTask', 'fmtNA']) delete o[k];
    if (o.deck && o.deck.startsWith(root + '::')) o.deck = name + o.deck.slice(root.length); else delete o.deck; return o; });
  if (move){ const gone = new Set(cards.map(c => c.id)); S.cards = S.cards.filter(c => !gone.has(c.id)); syncTree(); save(); await writeState(); }
  await newProject(name, {projectName: name, deck: name});
  applyBundle({format: PROJECT_FORMAT, deck: name, cards: copies, media}, 'merge');
  await writeState();
  await switchProject(back);
}
async function applyProposal(key){
  const p = ASK.proposals.get(key); if (!p) return;
  // a job's result is applied once, even with several windows open
  if (p.job && !(await brCall('POST', `jobs/${p.job.id}/imported`)).first) return toast('Another window already applied or discarded it'), ASK.done.add(key), renderAsk();
  let msg = [];
  if (p.revision && (p.revision.cards || []).length){
    const r = await importFiles([new File([J({...p.revision, revision: true})], 'anki_revision.json', {type: 'application/json'})], 'merge', {revision: true, keepStatus: true, note: p.job ? 'Assistant: ' + p.job.title : 'Assistant'});
    const s = summarize(r); msg.push(s.html);
  }
  let later = [];
  if ((p.actions || []).length){
    const a = await applyActions(p.actions); syncTree(); later = a.later;
    msg.push(`<div class="note ${a.errors.length ? 'warn' : 'ok'}" style="margin-top:6px">${a.done} action(s) applied to ${a.cards.size} card(s).${a.errors.length ? `<br>${a.errors.map(esc).join('<br>')}` : ''}</div>`);
  }
  ASK.done.add(key); if (p.job) p.job.importedAt = new Date().toISOString();
  save(); await afterImport(); renderFmtPass();
  // new projects last: making one opens it for a moment, then this project again
  for (const a of later){ await newProjectFrom(String(a.name).trim(), a.cards, !!a.move); msg.push(`<div class="note ok" style="margin-top:6px">New project “${esc(String(a.name).trim())}” with ${a.cards.length} card(s)${a.move ? ', moved out of this one' : ''} - open it from the sidebar.</div>`); }
  renderAsk();
  $('#askResult').innerHTML = msg.join('');
  toast('Applied - re-check the changed approved cards in Review', 4000);
}
$('#tab-assistant').addEventListener('click', async e => {
  const c = e.target.closest('[data-card]');
  if (c){ e.preventDefault(); if (!cardById(c.dataset.card)) return toast('That card is not in this project'); S.filter = 'all'; $('#filter').value = 'all'; select(c.dataset.card); showTab('review'); return; }
  const b = e.target.closest('[data-ask]'); if (!b) return;
  const key = b.dataset.key, p = ASK.proposals.get(key);
  try {
    if (b.dataset.ask === 'apply') await applyProposal(key);
    if (b.dataset.ask === 'discard'){ if (!confirm('Discard these proposed changes?')) return;
      if (p && p.job) await brCall('POST', `jobs/${p.job.id}/imported`); ASK.done.add(key); if (p && p.job) p.job.importedAt = new Date().toISOString(); renderAsk(); }
  } catch (er) { toast(er.message); }
});
// a chat's files: dropped here, looked at, then applied the same way
wireDrop($('#askDrop'), $('#askFile'), async files => {
  const p = {revision: null, actions: []};
  for (const f of files){
    try { const d = JSON.parse(await f.text());
      if (d && d.format === 'acs-actions/v1') p.actions.push(...(d.actions || []));
      else if (d && Array.isArray(d.cards)) p.revision = p.revision ? {...p.revision, cards: [...p.revision.cards, ...d.cards]} : d;
      else toast(`${f.name}: not an anki_revision.json or anki_actions.json`);
    } catch (er) { toast(`${f.name}: ${er.message}`); }
  }
  ASK.proposals.set('drop', p); ASK.done.delete('drop'); renderAsk();
});
