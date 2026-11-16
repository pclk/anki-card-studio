/* ====================================================================== ANALYTICS */
const anaCountSoon = debounce(() => {
  const C = ck(), cs = J(C), live = S.cards.filter(c => c.status !== 'drop');
  const n = live.filter(c => checksOf(c, C, cs).some(x => x.level === 'E')).length;
  $('#tabAnaCount').textContent = n ? String(n) : ''; $('#tabAnaCount').hidden = !n;
}, 600);
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const wordsOf = h => decodeEnt(String(h || '').replace(/<pre[\s\S]*?<\/pre>/gi, ' ').replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean).length;
/** a one-series histogram; bins that fail the limit are drawn in the warning colour (and named in the key and tooltips) */
function histHTML(title, values, edges, fails, unit, note){
  const bins = edges.slice(0, -1).map((lo, i) => ({lo, hi: edges[i + 1], n: 0}));
  for (const v of values){ const b = bins.find(b => v >= b.lo && v < b.hi) || bins[bins.length - 1]; b.n++; }
  const max = Math.max(1, ...bins.map(b => b.n)), lab = b => b.hi === Infinity ? `${b.lo}+` : b.hi - b.lo === 1 ? `${b.lo}` : `${b.lo}–${b.hi - 1}`;
  const anyFail = bins.some(b => b.n && fails(b));
  return `<div class="panel"><b>${esc(title)}</b>${note ? `<div class="small muted">${note}</div>` : ''}
    <div class="hist" role="img" aria-label="${esc(title)}">${bins.map(b => `<div class="${fails(b) ? 'over' : ''}" title="${lab(b)} ${unit}: ${b.n} card${b.n === 1 ? '' : 's'}${fails(b) ? ' (outside the limit)' : ''}">`
      + `<em>${b.n || ''}</em><i style="height:${b.n ? Math.max(2, b.n / max * 78) : 0}px"></i></div>`).join('')}</div>
    <div class="hist-x">${bins.map(b => `<span title="${lab(b)}">${b.hi === Infinity ? b.lo + '+' : b.lo}</span>`).join('')}</div>
    <div class="ana-key"><span>${esc(unit)}</span>${anyFail ? '<span><i style="background:var(--warn)"></i>outside your limit</span>' : ''}</div></div>`;
}
const withEdge = (edges, v) => v ? [...new Set([...edges, v])].sort((a, b) => a - b) : edges;
function renderAnalytics(){
  const C = ck(), cs = J(C), sc = $('#anaScope').value, st = $('#anaStatus').value;
  const cards = S.cards.filter(c => (sc === 'all' || inScope(c)) && (st === 'live' ? c.status !== 'drop' : c.status === st));
  const root = $('#anaRoot');
  if (!cards.length){ root.innerHTML = '<div class="panel muted">No cards here yet.</div>'; return; }
  const res = new Map(cards.map(c => [c, checksOf(c, C, cs)]));
  const hasE = c => res.get(c).some(x => x.level === 'E'), hasAny = c => res.get(c).length > 0;
  const n = cards.length, cl = cards.filter(c => c.type === 'cloze').length, img = cards.filter(c => cardImages(c).length).length;
  const tile = (v, t, sub) => `<div class="ana-tile"><b>${v}</b><span>${t}</span>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  let h = `<div class="ana-tiles">${tile(n, 'cards', `${n - cl} basic · ${cl} cloze`)}${tile(pct(cards.filter(c => c.status === 'ok').length, n) + '%', 'approved')}`
    + `${tile(pct(img, n) + '%', 'have an image', `${img} card${img === 1 ? '' : 's'}`)}${tile(pct(cards.filter(c => !hasAny(c)).length, n) + '%', 'pass every check')}`
    + `${tile(cards.filter(hasE).length, 'with an error', `${cards.filter(c => hasAny(c) && !hasE(c)).length} with warnings only`)}</div>`;
  // checks
  const lvOf = k => k === 'missing_img' ? 'W' : ['why_min_words'].includes(k) ? (C.why === 'off' ? 'off' : C.why === 'error' ? 'E' : 'W')
    : ['front_max_chars', 'back_max_words', 'cloze_max_deletions', 'ref_quote_min_chars'].includes(k) ? (C[k] ? 'W' : 'off')
    : C[k] === 'off' ? 'off' : C[k] === 'error' ? 'E' : 'W';
  const setting = k => k === 'missing_img' ? 'Studio check' : k === 'why' ? C.why : k === 'why_min_words' ? `≥ ${C.why_min_words} words`
    : CHECK_DEFS.find(d => d.key === k).kind === 'num' ? (C[k] ? `${k.includes('min') ? '≥' : '≤'} ${C[k]} ${CHECK_DEFS.find(d => d.key === k).unit}` : 'no limit') : C[k];
  const rows = CHECK_ROWS.map(r => ({r, lv: lvOf(r.key), hit: cards.filter(r.test).length}));
  h += `<div class="panel ana-scroll"><b>Checker results</b><table class="ana-tbl" style="margin-top:6px"><thead><tr><th>Check</th><th>Setting</th><th class="num">Cards</th><th style="width:22%"></th><th></th></tr></thead><tbody>`
    + rows.map(({r, lv, hit}) => `<tr${lv === 'off' ? ' class="muted"' : ''}><td><details class="ck-how" style="color:inherit"><summary style="color:inherit;font-size:13px;width:auto">${esc(r.label)} <span class="muted" style="font-size:11px">ⓘ</span></summary><div class="small muted" style="margin-top:4px">${esc(CHECK_HOW[r.key] || '')}</div></details></td><td><span class="ana-lv ${lv}">${esc(setting(r.key))}</span></td>`
      + `<td class="num">${lv === 'off' ? '–' : `${hit} <span class="muted">(${pct(hit, n)}%)</span>`}</td>`
      + `<td>${lv === 'off' ? '' : `<div class="ana-meter" title="${hit} of ${n} cards"><i style="width:${pct(hit, n)}%;background:${lv === 'E' ? 'var(--bad)' : 'var(--warn)'}"></i></div>`}</td>`
      + `<td>${hit && lv !== 'off' ? `<button class="btn" data-anashow="${r.key}" style="padding:2px 10px">Show cards</button>` : ''}</td></tr>`).join('')
    + `</tbody></table></div>`;
  // distributions
  const basic = cards.filter(c => c.type !== 'cloze'), clz = cards.filter(c => c.type === 'cloze');
  const whyW = cards.map(c => wordsOf(c.why));
  const frontC = basic.map(c => decodeEnt(String(c.front || '').replace(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/gi, '').replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, '').replace(/<[^>]+>/g, '')).length);
  const backW = cards.map(c => wordsOf(c.type === 'cloze' ? (c.text || '') + ' ' + (c.extra || '') : c.back));
  const delN = clz.map(c => new Set([...String(c.text || '').matchAll(/\{\{c(\d+)::/g)].map(m => m[1])).size);
  h += `<div class="ana-grid">`
    + histHTML('"Why this card" length', whyW, withEdge([0, 1, 15, 30, 60, 90, 150, Infinity], C.why_min_words), b => C.why !== 'off' && (b.lo === 0 && b.hi === 1 || (C.why_min_words && b.hi <= C.why_min_words)), 'words',
        C.why === 'off' ? 'check off' : `minimum ${C.why_min_words} words`)
    + (basic.length ? histHTML('Front length (basic cards)', frontC, withEdge([0, 50, 100, 150, 200, 400, 600, Infinity], C.front_max_chars && C.front_max_chars + 1), b => C.front_max_chars && b.lo >= C.front_max_chars + 1, 'characters of prose',
        C.front_max_chars ? `limit ${C.front_max_chars}` : 'no limit') : '')
    + histHTML('Answer length', backW, withEdge([0, 10, 25, 50, 75, 100, 150, 250, Infinity], C.back_max_words && C.back_max_words + 1), b => C.back_max_words && b.lo >= C.back_max_words + 1, 'words (back, or cloze text + extra)',
        C.back_max_words ? `limit ${C.back_max_words}` : 'no limit set')
    + (clz.length ? histHTML('Cloze numbers per note', delN, [1, 2, 3, 4, 5, 6, Infinity], b => C.cloze_max_deletions && b.lo > C.cloze_max_deletions, 'c1…cN in one note',
        C.cloze_max_deletions ? `limit ${C.cloze_max_deletions}` : 'no limit') : '')
    + histHTML('Images per card', cards.map(c => cardImages(c).length), [0, 1, 2, 3, Infinity], () => false, 'images', 'the skill adds images only where they help')
    + `</div>`;
  // per deck
  const by = new Map(); for (const c of cards){ const d = cardDeck(c); if (!by.has(d)) by.set(d, []); by.get(d).push(c); }
  if (by.size > 1){
    const decks = [...by.keys()].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    h += `<div class="panel ana-scroll"><b>By sub-deck</b><table class="ana-tbl" style="margin-top:6px"><thead><tr><th>Deck</th><th class="num">Cards</th><th class="num">Approved</th><th class="num">With errors</th><th class="num">Warnings only</th><th class="num">Avg why</th><th class="num">With images</th></tr></thead><tbody>`
      + decks.map(d => { const cs2 = by.get(d), m = cs2.length, e = cs2.filter(hasE).length, w = cs2.filter(c => hasAny(c) && !hasE(c)).length;
        return `<tr><td title="${esc(d)}">${esc(d.split('::').slice(-1)[0])}</td><td class="num">${m}</td><td class="num">${pct(cs2.filter(c => c.status === 'ok').length, m)}%</td>`
          + `<td class="num">${e ? `<span style="color:var(--bad)">${e}</span>` : 0}</td><td class="num">${w}</td>`
          + `<td class="num">${Math.round(cs2.reduce((a, c) => a + wordsOf(c.why), 0) / m)}</td><td class="num">${pct(cs2.filter(c => cardImages(c).length).length, m)}%</td></tr>`; }).join('')
      + `</tbody></table></div>`;
  }
  root.innerHTML = h;
}
$('#anaRoot').addEventListener('click', e => { const b = e.target.closest('[data-anashow]'); if (b) showCheckCards(b.dataset.anashow, $('#anaScope').value === 'all'); });
['anaScope', 'anaStatus'].forEach(id => $('#' + id).onchange = renderAnalytics);
$('#anaToCk').onclick = e => { e.preventDefault(); showTab('checker'); };
/** the checker's verdict on what is about to be exported */
function renderExportCheck(cards){
  const C = ck(), cs = J(C), box = $('#exCheck'); if (!box) return;
  if (!cards.length){ box.hidden = true; return; } box.hidden = false;
  const res = new Map(cards.map(c => [c, checksOf(c, C, cs)]));
  const e = cards.filter(c => res.get(c).some(x => x.level === 'E')).length, w = cards.filter(c => res.get(c).length && !res.get(c).some(x => x.level === 'E')).length;
  const top = CHECK_ROWS.map(r => ({r, hit: cards.filter(r.test).length})).filter(x => x.hit).sort((a, b) => b.hit - a.hit).slice(0, 4);
  box.innerHTML = `<div class="row" style="flex-wrap:wrap;gap:8px"><b>Checker</b><span class="small">${e || w
      ? `Of the ${cards.length} cards to export, <b style="color:var(--bad)">${e}</b> have an error and <b>${w}</b> a warning.`
      : `All ${cards.length} cards to export pass your checks.`}</span><span class="spacer"></span>${SET.showAnalytics !== false ? '<button class="btn" id="exToAna">Open Analytics</button>' : ''}</div>`
    + (top.length ? `<div class="row small" style="flex-wrap:wrap;gap:6px">${top.map(({r, hit}) => `<button class="btn" data-anashow="${r.key}" style="padding:2px 10px">${esc(r.label)} · ${hit}</button>`).join('')}</div>` : '');
  if ($('#exToAna')) $('#exToAna').onclick = () => showTab('analytics');
  box.querySelectorAll('[data-anashow]').forEach(b => b.onclick = () => showCheckCards(b.dataset.anashow, !scopeNode() || ($('input[name=exScope]:checked') || {}).value !== 'scope'));
}
function renderExport(){
  if (!$('#exDeck').value) $('#exDeck').value = S.deck;
  $('#exWhy').checked = !!S.whyAll;
  const cards = exportCards(), missing = new Set();
  renderExportCheck(cards);
  cards.forEach(c => cardImages(c).forEach(n => { if (!['ok','inline'].includes(mediaState(n))) missing.add(n); }));
  const ch = S.cards.filter(c => c.status === 'change').length, un = S.cards.filter(c => c.status === 'new').length;
  const w = [];
  w.push(`<div class="note ${cards.length ? 'ok' : 'warn'}"><b>${cards.length}</b> card(s) will be exported${cards.length ? ` (${cards.filter(c => c.type === 'cloze').reduce((a, c) => a + Math.max(1, clozeNums(c.text).length), 0) + cards.filter(c => c.type === 'basic').length} Anki cards after cloze expansion)` : ''}.</div>`);
  if (ch) w.push(`<div class="note warn">${ch} card(s) still have change requests.</div>`);
  if (un && ($('input[name=exWhich]:checked') || {}).value === 'ok') w.push(`<div class="note warn">${un} card(s) are unreviewed and will be skipped.</div>`);
  if (missing.size) w.push(`<div class="note bad">${missing.size} image(s) still missing: ${esc([...missing].slice(0, 6).join(', '))}${missing.size > 6 ? '…' : ''}</div>`);
  $('#exWarn').innerHTML = w.join('');
  $('#exOrderWrap').hidden = !hasOrder();
  const decks = [...new Set(cards.map(cardDeck))];
  $('#exDecks').innerHTML = decks.length > 1 ? `Sub-decks (${decks.length}): ` + decks.map(d => `<code>${esc(d)}</code> ${cards.filter(c => cardDeck(c) === d).length}`).join(' · ') : '';
  const sn = scopeNode(); $('#exScopeWrap').hidden = !sn; if (sn) $('#exScopeName').textContent = `“${sn.name}” (${S.cards.filter(inScope).length} cards)`;
}
$('#tab-export').addEventListener('change', renderExport);
$('#exDeck').addEventListener('input', e => {
  const old = S.deck, nu = e.target.value;
  // keep sub-decks attached to the renamed parent
  if (old && nu) for (const c of S.cards) if (c.deck && (c.deck === old || c.deck.startsWith(old + '::'))) c.deck = nu + c.deck.slice(old.length);
  S.deck = nu; save(); renderExport();
});
const STRIP_MEDIA = s => String(s).replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, ' $1 ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
function stableInt(str, lo = 1e12){ return lo + parseInt(sha1hex(str).slice(0, 10), 16) % 9e11; }
function guidFor(deck, id){ const h = sha1hex('aas|' + deck + '|' + id); let n = BigInt('0x' + h.slice(0, 16)); const tbl = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~'; let s = ''; while (n > 0n){ s = tbl[Number(n % 91n)] + s; n /= 91n; } return s || 'a'; }
async function buildApkg(deckName, cards, {prefix, stripMissing, extra}){
  if (!window.initSqlJs) throw new Error('SQL engine (sql.js) did not load - are you online?');
  if (!window.JSZip) throw new Error('JSZip did not load - are you online?');
  const SQL = await initSqlJs({locateFile: f => CDN_SQL + f});
  const db = new SQL.Database();
  db.run(`CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn); CREATE INDEX ix_cards_usn on cards (usn); CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid); CREATE INDEX ix_cards_sched on cards (did, queue, due); CREATE INDEX ix_revlog_cid on revlog (cid); CREATE INDEX ix_notes_csum on notes (csum);`);
  const now = Date.now(), nowS = Math.floor(now / 1000);
  const deckId = stableInt('deck|' + deckName);
  const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
  const model = (id, name, type, flds, tmpls) => ({id, name, type, mod: nowS, usn: -1, sortf: 0, did: deckId,
    tmpls: tmpls.map((t, i) => ({name: t[0], ord: i, qfmt: t[1], afmt: t[2], did: null, bqfmt: '', bafmt: ''})),
    flds: flds.map((f, i) => ({name: f, ord: i, sticky: false, rtl: false, font: 'Arial', size: 20, media: []})),
    css: CARD_CSS + '\n' + HLJS_CSS, latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false, req: [[0, 'any', [0]]], tags: [], vers: []});
  const models = {
    [MODEL_BASIC_ID]: model(MODEL_BASIC_ID, 'AutoAnki Basic', 0, ['Front', 'Back', 'Extra', 'Source'], [['Card 1', TPL_BASIC_Q, TPL_BASIC_A]]),
    [MODEL_CLOZE_ID]: model(MODEL_CLOZE_ID, 'AutoAnki Cloze', 1, ['Text', 'Extra', 'Source'], [['Cloze', TPL_CLOZE_Q, TPL_CLOZE_A]])
  };
  const deckOf = c => (c.deck && c.deck !== S.deck) ? c.deck : deckName;
  const deckObj = (id, name) => ({id, name, mod: nowS, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0});
  const decks = {1: deckObj(1, 'Default'), [deckId]: deckObj(deckId, deckName)};
  for (const c of cards){ const dn = deckOf(c); const id2 = stableInt('deck|' + dn); if (!decks[id2]) decks[id2] = deckObj(id2, dn); }
  const dconf = {1: {id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: {bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20},
    lapse: {delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0},
    rev: {bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2}}};
  const conf = {activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: String(MODEL_BASIC_ID), nextPos: 1, sortType: 'noteFld', sortBackwards: false, addToCur: true};
  db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [nowS, now, now, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}']);

  const slug = deckName.split('::').pop().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase().slice(0, 30) || 'deck';
  const used = new Map();  // original name -> exported name
  const mediaName = n => { if (!used.has(n)) used.set(n, prefix && !n.startsWith(slug + '_') ? `${slug}_${n}` : n); return used.get(n); };
  const fixField = s => String(s || '').replace(/<figure[^>]*>\s*<img[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/figure>|<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (all, f1, f2) => {
    const n = f1 || f2; const st = mediaState(n);
    if (st === 'inline') return all;
    if (st !== 'ok') return stripMissing ? '' : all;
    return all.replace(/(src=["'])([^"']+)(["'])/i, (_, a, _n, b) => a + mediaName(n) + b);
  });
  let nid = now, cid = now, due = 0, nCards = 0;
  const insN = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insC = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const c of cards){
    const isCloze = c.type === 'cloze';
    const flds = isCloze ? [c.text, extraWithWhy(c), c.source] : [c.front, c.back, extraWithWhy(c), c.source];
    const fixed = flds.map(fixMath).map(fixField).map(bakeCode);
    if (extra && extra.html[c.id]) fixed[fixed.length - 1] += extra.html[c.id];
    const tags = [...new Set([...(S.tags || []), ...c.tags])].map(t => t.replace(/\s+/g, '_')).filter(Boolean);
    const sort = STRIP_MEDIA(fixed[0]);
    const csum = parseInt(sha1hex(sort).slice(0, 8), 16);
    nid++; due++;
    insN.run([nid, guidFor(deckName, c.id), isCloze ? MODEL_CLOZE_ID : MODEL_BASIC_ID, nowS, -1, tags.length ? ` ${tags.join(' ')} ` : '', fixed.join('\x1f'), sort, csum, 0, '']);
    const ords = isCloze ? (clozeNums(c.text).map(n => n - 1).length ? clozeNums(c.text).map(n => n - 1) : [0]) : [0];
    const did = stableInt('deck|' + deckOf(c));
    for (const ord of ords){ cid++; nCards++; insC.run([cid, nid, did, ord, nowS, -1, 0, 0, due, 0, 0, 0, 0, 0, 0, 0, 0, '']); }
  }
  insN.free(); insC.free();
  const zip = new JSZip();
  zip.file('collection.anki2', db.export());
  db.close();
  const mediaMap = {}; let i = 0;
  if (await ensureMedia([...used.keys()])) {}   // images that so far only exist in the account
  for (const [orig, out] of used){ const m = S.media[orig]; if (!m || !m.blob) continue; zip.file(String(i), m.blob); mediaMap[i] = out; i++; }
  for (const [name, bl] of (extra && extra.media) || []){ zip.file(String(i), bl); mediaMap[i] = name; i++; }
  zip.file('media', JSON.stringify(mediaMap));
  const blob = await zip.generateAsync({type: 'blob', compression: 'DEFLATE', compressionOptions: {level: 6}});
  return {blob, notes: cards.length, cards: nCards, media: i};
}
$('#btnExport').onclick = async () => {
  const cards = exportCards(); if (!cards.length) return toast('No cards to export with the current selection');
  const deckName = ($('#exDeck').value || S.deck || 'AI Generated Deck').trim();
  $('#btnExport').disabled = true; $('#exResult').innerHTML = '<div class="note">Building…</div>';
  try {
    let extra = null, pics = 0, passages = 0;
    if ($('#exSrcPics').checked && (S.sources || []).length){
      extra = {html: {}, media: []};
      const slug = deckName.split('::')[0].replace(/[^A-Za-z0-9]+/g, '_').toLowerCase().slice(0, 20) || 'deck';
      for (const [k, c] of cards.entries()){
        $('#exResult').innerHTML = `<div class="note">Source pictures ${k + 1} / ${cards.length}…</div>`;
        const v = await sourceVisual(c); if (!v) continue;
        if (v.blob){ const nm = `${slug}_src_${c.id.replace(/[^A-Za-z0-9_-]+/g, '_')}.jpg`; extra.media.push([nm, v.blob]); extra.html[c.id] = `<div class="aa-src-shot"><img src="${nm}"></div>`; pics++; }
        else { extra.html[c.id] = v.html; passages++; }
      }
    }
    const r = await buildApkg(deckName, cards, {prefix: $('#exPrefix').checked, stripMissing: $('#exStripMissing').checked, extra});
    const fname = deckName.replace(/::/g, ' - ').replace(/[\\/:*?"<>|]+/g, '_') + '.apkg';
    download(r.blob, fname);
    $('#exResult').innerHTML = `<div class="note ok">Downloaded <b>${esc(fname)}</b> - ${r.notes} notes → ${r.cards} cards, ${r.media} images (${(r.blob.size / 1024).toFixed(0)} KB)${pics || passages ? `; source pictures on ${pics} card(s), quoted passages on ${passages}` : ''}.</div>`;
  } catch (e) { console.error(e); $('#exResult').innerHTML = `<div class="note bad">Export failed: ${esc(e.message)}</div>`; }
  $('#btnExport').disabled = false;
};

