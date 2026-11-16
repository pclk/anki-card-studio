/* ====================================================================== TREE: project › sub-projects (= sub-decks = batch prompts) */
const nodeById = id => S.nodes.find(n => n.id === id);
const scopeNode = () => S.scope && S.scope !== 'root' ? nodeById(S.scope) : null;
const natCmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, {numeric: true, sensitivity: 'base'});
const nodeKids = pid => S.nodes.filter(n => (n.parent || null) === (pid || null)).sort((a, b) => natCmp(a.name, b.name));
function nodeDeckOf(n){ return n.deck || `${S.deck}::${n.name}`; }
/** does the card belong to this node (or one of its children)? */
const inNode = (c, n) => { const d = cardDeck(c), nd = nodeDeckOf(n); return d === nd || d.startsWith(nd + '::'); };
const inScope = c => { const n = scopeNode(); return !n || inNode(c, n); };
function nodeSubtree(n){ const out = [n]; for (const k of nodeKids(n.id)) out.push(...nodeSubtree(k)); return out; }
function newNodeId(){ return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
/** find or create the sub-project for a deck name like "Root::L01 Intro" (or "Root::L01::Part a") */
function ensureNode(deck, name){
  if (!deck || deck === S.deck) return null;
  let n = S.nodes.find(x => nodeDeckOf(x) === deck); if (n) return n;
  const parts = deck.startsWith(S.deck + '::') ? deck.slice(S.deck.length + 2).split('::') : [deck.split('::').slice(-1)[0]];
  let parent = null, path = S.deck;
  parts.forEach((part, i) => {
    path = deck.startsWith(S.deck + '::') ? path + '::' + part : deck;
    let m = S.nodes.find(x => nodeDeckOf(x) === path);
    if (!m){ m = {id: newNodeId(), name: i === parts.length - 1 && name ? name : part, deck: path, parent: parent ? parent.id : null}; S.nodes.push(m); }
    parent = m;
  });
  return parent;
}
/** sub-projects follow the data: every sub-deck in the cards and every batch prompt gets one */
function syncTree(){
  if (!Array.isArray(S.nodes)) S.nodes = [];
  for (const d of new Set(S.cards.map(cardDeck))) if (d !== S.deck) ensureNode(d);
  if (S.batch) for (const it of S.batch.items){ const n = ensureNode(it.deck, it.title || it.id); if (n) it.node = n.id; }
  if (S.scope !== 'root' && !scopeNode()) S.scope = 'root';
}
/* collapsed tree branches - one remembered state per browser for every project ("p:<id>") and sub-deck (its id),
   whichever project is open */
const treeClosed = new Set((() => { try { return JSON.parse(localStorage.getItem('acs-tree-closed') || '[]'); } catch { return []; } })());
const saveTreeClosed = () => { try { localStorage.setItem('acs-tree-closed', JSON.stringify([...treeClosed])); } catch {} };
function renderTree(){
  const el = $('#tree'); if (!el) return;
  const pr = projects.find(x => x.id === curProject);
  if (pr){ pr.nodes = S.nodes.map(n => ({id: n.id, name: n.name, parent: n.parent || null})); pr.name = projName(); pr.cards = S.cards.length; }
  const q = ($('#treeFilter') ? $('#treeFilter').value : '').trim().toLowerCase();
  const hit = name => !q || String(name || '').toLowerCase().includes(q);
  const mark = name => { const t = esc(name); if (!q) return t; const i = String(name).toLowerCase().indexOf(q); return i < 0 ? t : esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length)); };
  const count = n => S.cards.filter(c => inNode(c, n)).length;
  const row = (cls, depth, tw, name, ct, data, togKey) => `<div class="tn ${cls}" ${data} style="padding-left:${6 + depth * 14}px"><span class="tw${togKey ? ' tog' : ''}" ${togKey ? `data-tog="${esc(togKey)}" title="Expand / collapse"` : ''}>${tw}</span><span class="nm" title="${esc(name)}">${mark(name)}</span><span class="ct">${ct}</span></div>`;
  // with a filter: show matches and the path to them, everything expanded
  const anyHit = (list, kidsOf, n) => hit(n.name) || kidsOf(n.id).some(k => anyHit(list, kidsOf, k));
  // the same drawing for every project: the open one counts cards live, the others show their saved sub-deck tree
  el.innerHTML = [...projects].sort((a, b) => natCmp(a.name, b.name)).map(p => {
    const cur = p.id === curProject, nodes = cur ? S.nodes : (p.nodes || []);
    const kidsOf = pid => nodes.filter(n => (n.parent || null) === (pid || null)).sort((a, b) => natCmp(a.name, b.name));
    const walk = (pid, depth) => kidsOf(pid).filter(n => !q || anyHit(nodes, kidsOf, n)).map(n => {
      const kids = kidsOf(n.id).length, open = q || !treeClosed.has(n.id);
      const sel = cur && S.scope === n.id ? 'tsel' : '', data = cur ? `data-node="${n.id}"` : `data-proj="${p.id}" data-pnode="${n.id}"`;
      return row((cur ? '' : 'other ') + sel, depth, kids ? (open ? '▾' : '▸') : '•', n.name, cur ? (count(n) || '') : '', data, kids ? n.id : null)
        + (kids && open ? walk(n.id, depth + 1) : '');
    }).join('');
    const name = cur ? projName() : (p.name || 'Untitled'), body = walk(null, 1);
    if (q && !hit(name) && !body) return '';
    const open = q || !treeClosed.has('p:' + p.id);
    return row('proj' + (cur ? (S.scope === 'root' ? ' tsel' : '') : ' other'), 0, nodes.length ? (open ? '▾' : '▸') : '•', name,
               (cur ? S.cards.length : p.cards) || '', `data-proj="${p.id}"`, nodes.length ? 'p:' + p.id : null) + (open ? body : '');
  }).join('') || '<div class="small muted" style="padding:6px">No match</div>';
  const sel = el.querySelector('.tsel'); if (sel && !renderTree.noScroll) sel.scrollIntoView({block: 'nearest'});
  renderScopeBar();
}
function renderScopeBar(){
  const n = scopeNode(), bar = $('#scopeBar'); if (!bar) return;
  const path = []; for (let x = n; x; x = x.parent ? nodeById(x.parent) : null) path.unshift(x.name);
  const cards = S.cards.filter(inScope).length, srcs = (S.sources || []).filter(srcInScope).length;
  bar.innerHTML = `📁 <b>${esc(projName())}</b>${path.map(p => ` › <b>${esc(p)}</b>`).join('')} <span>· ${cards} card(s) · ${srcs} source(s)${n ? ` · deck <code>${esc(nodeDeckOf(n))}</code>` : ''}</span>`;
}
async function setScope(id){
  for (let x = id && id !== 'root' ? nodeById(id) : null; x; x = x.parent ? nodeById(x.parent) : null) if (x.id !== id) treeClosed.delete(x.id);
  if (id && id !== 'root') treeClosed.delete('p:' + curProject);
  S.scope = id || 'root'; S.deckFilter = ''; save(); renderTree();
  const active = ($('#tabs button.active') || {dataset: {}}).dataset.tab || 'prompt'; showTab(active); buildPrompt();
}
$('#treeFilter').addEventListener('input', () => renderTree());
$('#treeFilter').addEventListener('keydown', e => { if (e.key === 'Escape'){ e.target.value = ''; renderTree(); } });
$('#tree').addEventListener('click', async e => {
  const tog = e.target.closest('[data-tog]');
  if (tog){
    const k = tog.dataset.tog;
    treeClosed.has(k) ? treeClosed.delete(k) : treeClosed.add(k); saveTreeClosed();
    renderTree.noScroll = true; renderTree(); renderTree.noScroll = false; return;
  }
  const t = e.target.closest('.tn'); if (!t) return;
  if (t.dataset.node) return setScope(t.dataset.node);
  const pid = t.dataset.proj;
  if (pid === curProject) return setScope('root');
  const p = projects.find(x => x.id === pid);
  await switchProject(pid);
  if (t.dataset.pnode && nodeById(t.dataset.pnode)) setScope(t.dataset.pnode);
});
$('#btnNewSub').onclick = () => {
  const parent = scopeNode();
  const n = prompt(`New sub-project in "${parent ? parent.name : projName()}":`, `L${String(nodeKids(parent ? parent.id : null).length + 1).padStart(2, '0')}`);
  if (n === null || !n.trim()) return;
  const node = {id: newNodeId(), name: n.trim(), parent: parent ? parent.id : null};
  node.deck = `${parent ? nodeDeckOf(parent) : S.deck}::${node.name.replace(/::/g, ' -')}`;
  S.nodes.push(node); setScope(node.id);
};
function renameNode(n, name){
  const oldDeck = nodeDeckOf(n), parent = n.parent ? nodeById(n.parent) : null;
  const newDeck = `${parent ? nodeDeckOf(parent) : S.deck}::${name.replace(/::/g, ' -')}`;
  for (const m of nodeSubtree(n)) if (m.deck) m.deck = newDeck + m.deck.slice(oldDeck.length);
  n.name = name; n.deck = newDeck;
  for (const c of S.cards) if (c.deck && (c.deck === oldDeck || c.deck.startsWith(oldDeck + '::'))) c.deck = newDeck + c.deck.slice(oldDeck.length);
  if (S.batch) for (const it of S.batch.items) if (it.deck === oldDeck || it.deck.startsWith(oldDeck + '::')) it.deck = newDeck + it.deck.slice(oldDeck.length);
}
// rename / delete act on the selected node, or on the project when the project row is selected
$('#btnRenameProject').onclick = () => {
  const n = scopeNode();
  const v = prompt(n ? 'Rename sub-project (its sub-deck is renamed too):' : 'Rename project:', n ? n.name : projName());
  if (v === null || !v.trim()) return;
  if (n) renameNode(n, v.trim()); else S.projectName = v.trim();
  save(); renderTree(); if ($('#tab-review').classList.contains('active')) renderReview();
};
const deleteProjectHandler = $('#btnDeleteProject').onclick;
$('#btnDeleteProject').onclick = async () => {
  const n = scopeNode(); if (!n) return deleteProjectHandler();
  const sub = nodeSubtree(n), cards = S.cards.filter(c => inNode(c, n)), srcs = (S.sources || []).filter(x => sub.some(m => m.id === x.node));
  const parent = n.parent ? nodeById(n.parent) : null;
  if (!confirm(`Delete the sub-project "${n.name}"?\n${cards.length} card(s) and ${srcs.length} source(s) move up to "${parent ? parent.name : projName()}".`)) return;
  const pDeck = parent ? nodeDeckOf(parent) : S.deck;
  for (const c of cards) c.deck = pDeck === S.deck ? undefined : pDeck;
  for (const x of srcs) x.node = parent ? parent.id : 'root';
  S.nodes = S.nodes.filter(m => !sub.includes(m));
  if (S.batch) for (const it of S.batch.items) if (sub.some(m => m.id === it.node)) delete it.node;
  S.scope = parent ? parent.id : 'root'; save(); renderTree(); showTab(($('#tabs button.active') || {dataset: {}}).dataset.tab || 'prompt');
};

