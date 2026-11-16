/* ====================================================================== YANK */
function htmlToText(h){
  const d = new DOMParser().parseFromString('', 'text/html').body;
  d.innerHTML = String(h || '').replace(/<pre[^>]*>\s*(<code[^>]*?(?:language|lang)-([\w+#-]+)[^>]*>)?/gi, (m, c, lang) => '\n```' + (lang || '') + '\n' + (c || '')).replace(/<\/pre>/gi, '\n```\n')
    .replace(/<img[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, ' [image: $1] ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(p|div|li|tr|h\d|pre|figure|figcaption|ul|ol|table)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ');
  return (d.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function cardText(c){
  const out = [`Anki card ${c.id} (${c.type}) · deck: ${cardDeck(c)}`];
  for (const f of FIELDS[c.type]) if (c[f] && String(c[f]).trim()) out.push(`${FIELD_LABEL[f]}:\n${c.type === 'cloze' && f === 'text' ? htmlToText(c[f]) : htmlToText(c[f])}`);
  if (c.tags && c.tags.length) out.push('Tags: ' + c.tags.join(' '));
  return out.join('\n\n');
}
async function yankCard(){
  const c = curCard(); if (!c) return;
  await copyText(cardText(c));
  const wrap = shadow && shadow.querySelector('#pc .aa-wrap');
  if (wrap){ wrap.style.position = 'relative'; const fl = document.createElement('div'); fl.className = 'yank'; wrap.appendChild(fl); setTimeout(() => fl.remove(), 320); }
  toast('Card copied - paste it into a chat');
}

