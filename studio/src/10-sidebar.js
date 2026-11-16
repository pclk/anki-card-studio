/* ====================================================================== SIDEBAR + COMPACT PANES */
function toggleSidebar(open){
  const on = open === undefined ? !document.body.classList.contains('sb-open') : open;
  document.body.classList.toggle('sb-open', on); try { localStorage.setItem('acs-sidebar', on ? '1' : '0'); } catch {}
  setTimeout(checkCompact, 200);
}
$('#sbHandle').onclick = () => toggleSidebar();
try { if (localStorage.getItem('acs-sidebar') === '1') document.body.classList.add('sb-open'); } catch {}
let PANE = 'preview';
try { PANE = localStorage.getItem('acs-pane') || 'preview'; } catch {}
function setPane(p){
  PANE = p; try { localStorage.setItem('acs-pane', p); } catch {}
  const r = $('#reviewUI'); r.classList.toggle('pane-preview', p === 'preview'); r.classList.toggle('pane-edit', p === 'edit');
  $$('#paneSeg button').forEach(b => b.classList.toggle('on', b.dataset.pane === p));
}
$('#paneSeg').onclick = e => { const b = e.target.closest('button'); if (b) setPane(b.dataset.pane); };
/* layout from the width actually available to the page (sidebar open or not):
   wide >= 1320px: 3 columns · compact: cards | editor+preview · phone < 700px: one column, drawer + bottom bar */
const LAYOUT_WIDE = 1320, LAYOUT_PHONE = 700;
function checkCompact(){
  const r = $('#reviewUI'); if (!r) return;
  const w = $('main').clientWidth;
  const mode = w < LAYOUT_PHONE ? 'phone' : w < LAYOUT_WIDE ? 'compact' : 'wide';
  const was = r.classList.contains('phone') ? 'phone' : r.classList.contains('compact') ? 'compact' : 'wide';
  if (mode === was) return;
  r.classList.toggle('compact', mode !== 'wide');
  r.classList.toggle('phone', mode === 'phone');
  if (mode !== 'phone') r.classList.remove('cards-open');
  const pc = $('#previewCol'), ed = $('#editorCol'), bar = $('#mobileBar');
  if (mode === 'phone'){ r.insertBefore(pc, ed); r.insertBefore(bar, ed); }          // card, request-change box, then the rest
  else {
    r.insertBefore(bar, $('#swipeGlow'));
    if (mode === 'compact'){ if (pc.parentNode !== ed) ed.insertBefore(pc, ed.children[1]); }
    else r.insertBefore(pc, $('#cardsScrim'));
  }
  document.body.classList.toggle('rv-phone', mode === 'phone');
  setPane(mode === 'phone' && was !== 'phone' ? 'preview' : PANE);
}
const isPhone = () => $('#reviewUI').classList.contains('phone');
new ResizeObserver(debounce(checkCompact, 60)).observe($('main'));
/* ---- phone: card drawer, bottom bar */
$('#btnCards').onclick = () => $('#reviewUI').classList.toggle('cards-open');
$('#cardsScrim').onclick = () => $('#reviewUI').classList.remove('cards-open');
$('#cardItems').addEventListener('click', e => { if (e.target.closest('.ci') && isPhone()) setTimeout(() => $('#reviewUI').classList.remove('cards-open'), 60); });
function syncMobileBar(){
  const c = curCard(), ta = $('#mbNote'); if (!c || !ta) return;
  if (document.activeElement !== ta && ta.dataset.card !== c.id){ ta.value = c.status === 'change' ? (c.feedback || '') : ''; ta.dataset.card = c.id; }
  $('#mbNext').textContent = ta.value.trim() ? 'Request change ›' : 'Next ›';
  $('#mbNext').classList.toggle('warn', !!ta.value.trim());
  if (ta.dataset.sized !== ta.value && ta.offsetParent){ ta.dataset.sized = ta.value; ta.style.height = 'auto'; ta.style.height = Math.min(110, ta.scrollHeight + 2) + 'px'; }
}
$('#mbNote').addEventListener('input', syncMobileBar);
$('#mbNext').onclick = () => {
  const c = curCard(); if (!c) return;
  const t = $('#mbNote').value.trim();
  if (t){ c.feedback = t; setCardStatus(c, 'change'); save(); $('#edFeedback').value = t; toast('Change requested'); delete $('#mbNote').dataset.card; renderReviewSoft(); setTimeout(nextUnreviewed, 120); }
  else move(1);
};
$('#hudPrev').onclick = () => move(-1);
$('#hudEdit').onclick = () => { const f = $('#fieldsPanel'); f.scrollIntoView({behavior: 'smooth', block: 'start'}); };
$('#hudNext').onclick = () => move(1);
$('#mbChange').onclick = () => { leader = {shown: false}; showLeader($('#mbChange')); };
/* ---- swipe the card (touch): right = approve, left = exclude, tap = flip.
   A swipe may be diagonal (Settings → Swiping sets the angle and distance); steeper movements scroll the card. */
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const STAR = 'M12 1.5l3.1 7 7.6.7-5.8 5 1.8 7.4L12 17.7l-6.7 3.9 1.8-7.4-5.8-5 7.6-.7z';
const SPARK = 'M12 0c.6 6.5 5.5 11.4 12 12-6.5.6-11.4 5.5-12 12-.6-6.5-5.5-11.4-12-12C6.5 11.4 11.4 6.5 12 0z';
function burst(dir, from){
  if (!SET.swipe.effects) return;
  const g = $(dir > 0 ? '#swipeGlow .g-ok' : '#swipeGlow .g-drop');
  // the lit half flares to full, holds a moment, then fades
  g.classList.add('flash'); g.style.opacity = 0;
  g.animate([{opacity: .95}, {opacity: 1, offset: .25}, {opacity: 0}], {duration: 1100, easing: 'ease-out'}).onfinish = () => g.classList.remove('flash');
  if (reducedMotion()) return;
  const layer = $('#fxLayer'), pal = dir > 0 ? ['#22c55e', '#4ade80', '#86efac', '#16a34a', '#bbf7d0', '#facc15'] : ['#ef4444', '#f87171', '#fca5a5', '#dc2626', '#fecaca', '#fb923c'];
  // two sprays that fill the lit half: from the card, and inward from the edge the card left through
  const W = innerWidth, edge = dir > 0 ? W - 12 : 12, n = 60;
  for (let i = 0; i < n; i++){
    const fromEdge = i % 3 !== 0, x0 = fromEdge ? edge : Math.min(W - 40, Math.max(40, from.x)), y0 = fromEdge ? from.y + (Math.random() - .5) * innerHeight * .5 : from.y;
    const size = 9 + Math.pow(Math.random(), 1.4) * 34, el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('width', size); el.setAttribute('height', size);
    el.innerHTML = `<path d="${Math.random() < .6 ? STAR : SPARK}" fill="${pal[i % pal.length]}"/>`;
    el.style.filter = `drop-shadow(0 0 ${Math.round(size / 3)}px ${pal[i % pal.length]})`;
    layer.appendChild(el);
    // fly out mostly in the swipe direction, fanned up and down, then drift down a little
    const ang = fromEdge ? (dir > 0 ? Math.PI : 0) + (Math.random() - .5) * 2.4 : (dir > 0 ? 0 : Math.PI) + (Math.random() - .5) * 3.4;
    const sp = (fromEdge ? 90 : 120) + Math.random() * W * .55;
    const dx = Math.cos(ang) * sp, dy = Math.sin(ang) * sp * .9 - 60 * Math.random(), rot = (Math.random() - .5) * 720, dur = 900 + Math.random() * 800;
    el.animate([
      {transform: `translate(${x0 - size / 2}px,${y0 - size / 2}px) scale(.3) rotate(0deg)`, opacity: 1},
      {transform: `translate(${x0 + dx * .45 - size / 2}px,${y0 + dy * .45 - size / 2}px) scale(1.35) rotate(${rot * .4}deg)`, opacity: 1, offset: .3},
      {transform: `translate(${x0 + dx * .8 - size / 2}px,${y0 + dy * .8 - size / 2}px) scale(1) rotate(${rot * .75}deg)`, opacity: .9, offset: .7},
      {transform: `translate(${x0 + dx - size / 2}px,${y0 + dy + 90 - size / 2}px) scale(.6) rotate(${rot}deg)`, opacity: 0},
    ], {duration: dur, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards'}).onfinish = () => el.remove();
  }
}
let undoTimer = null, undoInfo = null;
function offerUndo(info){
  undoInfo = info; clearTimeout(undoTimer);
  $('#undoText').textContent = info.status === 'ok' ? 'Approved' : 'Excluded';
  $('#undoPill .dot').style.background = info.status === 'ok' ? '#22c55e' : '#ef4444';
  $('#undoPill').classList.add('show');
  undoTimer = setTimeout(() => $('#undoPill').classList.remove('show'), 4000);
}
$('#undoBtn').onclick = () => {
  const u = undoInfo; if (!u) return; undoInfo = null; $('#undoPill').classList.remove('show');
  const c = cardById(u.id); if (!c) return;
  c.status = u.prev || 'new'; if (u.recheck) c.recheck = true; save(); select(u.id); toast('Undone');
};
(function swipe(){
  const host = $('#previewHost'), so = $('#stampOk'), sd = $('#stampDrop'), gOk = $('#swipeGlow .g-ok'), gDrop = $('#swipeGlow .g-drop');
  let st = null;
  const paint = dx => {
    const k = Math.min(1, Math.abs(dx) / Math.max(60, host.offsetWidth * SET.swipe.dist / 100));
    host.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    so.style.opacity = dx > 0 ? k : 0; sd.style.opacity = dx < 0 ? k : 0;
    so.style.transform = `rotate(-14deg) scale(${.8 + k * .35})`; sd.style.transform = `rotate(14deg) scale(${.8 + k * .35})`;
    if (SET.swipe.effects){ gOk.classList.remove('flash'); gDrop.classList.remove('flash'); gOk.style.opacity = dx > 0 ? k * .95 : 0; gDrop.style.opacity = dx < 0 ? k * .95 : 0; }
  };
  // the nearest element under the finger (inside the card) that can scroll sideways
  const hScroller = e => {
    for (const el of e.composedPath()){
      if (el === host || el.nodeType !== 1) break;
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return el;
    }
    return null;
  };
  const canScrollX = (el, dir) => dir > 0 ? el.scrollLeft < el.scrollWidth - el.clientWidth - 1 : el.scrollLeft > 1;
  const reset = () => { host.style.transform = ''; host.style.opacity = ''; so.style.opacity = sd.style.opacity = 0; if (!gOk.classList.contains('flash')) gOk.style.opacity = 0; if (!gDrop.classList.contains('flash')) gDrop.style.opacity = 0; };
  host.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || !curCard()){ st = null; return; }
    const t = e.touches[0];
    st = {x: t.clientX, y: t.clientY, t: performance.now(), mode: null, dx: 0, dy: 0, sc: hScroller(e)};
  }, {passive: true});
  host.addEventListener('touchmove', e => {
    if (!st) return;
    if (e.touches.length !== 1){ st = null; reset(); return; }
    const t = e.touches[0]; st.dx = t.clientX - st.x; st.dy = t.clientY - st.y;
    if (!st.mode){
      if (Math.hypot(st.dx, st.dy) < 9) return;                       // too small to tell the direction yet
      const deg = Math.atan2(Math.abs(st.dy), Math.abs(st.dx)) * 180 / Math.PI;
      // within the allowed angle -> it's a swipe (we take the gesture); steeper -> the card scrolls as usual
      st.mode = deg <= SET.swipe.angle && e.cancelable ? 'swipe' : 'scroll';
      // started on something that scrolls sideways (code, a wide table or equation): it scrolls first.
      // Only once it is already at its end in that direction does the same movement swipe the card.
      if (st.mode === 'swipe' && st.sc && canScrollX(st.sc, st.dx < 0 ? 1 : -1)) st.mode = 'scroll';
      if (st.mode === 'swipe'){ host.classList.remove('back', 'fly'); host.classList.add('swiping'); }
    }
    if (st.mode !== 'swipe') return;
    e.preventDefault();
    paint(st.dx);
  }, {passive: false});
  const end = e => {
    if (!st) return;
    const s0 = st; st = null; host.classList.remove('swiping');
    const dt = performance.now() - s0.t;
    if (!s0.mode){
      // a tap flips the card (not on links / form controls)
      if (e.type === 'touchend' && dt < 350 && !(e.target.closest && e.target.closest('a,button,input,textarea,select,summary'))){ side = side === 'front' ? 'back' : 'front'; renderPreview(); }
      return;
    }
    if (s0.mode !== 'swipe') return;
    const need = Math.max(50, host.offsetWidth * SET.swipe.dist / 100);
    const far = Math.abs(s0.dx) > need, fast = Math.abs(s0.dx) > 40 && Math.abs(s0.dx) / dt > 0.65;
    if (e.type === 'touchend' && (far || fast)){
      const dir = s0.dx > 0 ? 1 : -1, c = curCard(), r = host.getBoundingClientRect();
      const info = {id: c.id, prev: c.status, recheck: !!c.recheck, status: dir > 0 ? 'ok' : 'drop'};
      burst(dir, {x: r.left + r.width / 2 + s0.dx * .5, y: Math.max(80, Math.min(innerHeight - 80, r.top + Math.min(r.height, innerHeight) * .42 + s0.dy * .5))});
      // a frozen copy of this card flies away; the real card box draws the next card underneath at once,
      // so the old card never shows again
      const ghost = document.createElement('div');
      ghost.className = 'preview-host swipe-ghost';
      ghost.style.cssText = `position:absolute;left:${host.offsetLeft}px;top:${host.offsetTop}px;width:${host.offsetWidth}px;height:${host.offsetHeight}px;` +
        `margin:0;z-index:8;pointer-events:none;transform:${host.style.transform}`;
      ghost.attachShadow({mode: 'open'}).innerHTML = host.shadowRoot ? host.shadowRoot.innerHTML : host.innerHTML;
      host.parentNode.insertBefore(ghost, host.nextSibling);
      host.classList.remove('swiping'); host.style.transition = 'none'; host.style.transform = ''; host.style.opacity = '0';
      so.style.opacity = sd.style.opacity = 0;
      // set (never toggle) the status, then draw the next card straight away into the hidden real box
      setCardStatus(c, info.status); save(); nextUnreviewed();   // nextUnreviewed re-renders list, counts and preview
      requestAnimationFrame(() => {
        host.style.transition = '';
        host.animate([{transform: 'scale(.95)', opacity: 0}, {transform: 'scale(1)', opacity: 1}], {duration: 220, easing: 'ease-out', fill: 'none'});
        host.style.opacity = '';
      });
      ghost.animate([{transform: ghost.style.transform, opacity: 1}, {transform: `translate(${dir * 130}vw, ${s0.dy * 1.5}px) rotate(${dir * 24}deg)`, opacity: 0}],
                    {duration: 280, easing: 'cubic-bezier(.4,0,.9,.6)', fill: 'forwards'}).onfinish = () => ghost.remove();
      if (navigator.vibrate) try { navigator.vibrate(dir > 0 ? 14 : [10, 40, 10]); } catch {}
      offerUndo(info);
    } else { host.classList.add('back'); reset(); setTimeout(() => host.classList.remove('back'), 300); }
  };
  host.addEventListener('touchend', end); host.addEventListener('touchcancel', end);
})();
window.addEventListener('resize', debounce(checkCompact, 80));

