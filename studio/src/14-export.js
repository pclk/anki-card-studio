/* ====================================================================== EXPORT */
function exportCards(){ const which = ($('input[name=exWhich]:checked') || {}).value; const ord = ($('input[name=exOrder]:checked') || {}).value || 'source';
  const onlyScope = scopeNode() && ($('input[name=exScope]:checked') || {}).value === 'scope';
  return ordered(S.cards.filter(c => (which === 'ok' ? c.status === 'ok' : c.status !== 'drop') && (!onlyScope || inScope(c))), ord); }
