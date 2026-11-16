/* ====================================================================== APP DATA (all projects + settings) */
async function packState(st){
  const out = {...st, media: {}};
  for (const [n, m] of Object.entries(st.media || {})){ const e = {...m}; delete e.blob; delete e.remote; if (m.blob){ e.data = await blobToB64(m.blob); e.mime = m.blob.type; } out.media[n] = e; }
  return out;
}
function unpackState(st){
  const out = {...st, media: {}};
  for (const [n, m] of Object.entries(st.media || {})){ const e = {...m}; if (m.data){ e.blob = b64ToBlob(m.data, m.mime || MIME[extOf(n)] || 'application/octet-stream'); delete e.data; delete e.mime; } out.media[n] = e; }
  return out;
}
$('#btnExportApp').onclick = async () => {
  if (!window.JSZip) return toast('JSZip did not load - are you online?');
  await writeState();
  const z = new JSZip();
  z.file('settings.json', JSON.stringify({format: 'anki-studio/settings-v1', ...SET}, null, 2));
  z.file('projects.json', JSON.stringify({format: 'anki-studio/app-v1', exported: new Date().toISOString(), current: curProject, projects}, null, 2));
  for (const p of projects){
    const st = p.id === curProject ? snapshot() : await Store.getProject(p.id); if (!st) continue;
    toast(`Exporting ${p.name || p.id}…`, 60000);
    await ensureMedia(null, st, p.id);
    z.file(`projects/${p.id}.json`, JSON.stringify(await packState(st)));
    for (const src of st.sources || []){
      const d = await Store.getSource(p.id, src.id).catch(() => null); if (d) z.file(`projects/${p.id}/sources/${src.id}.json`, JSON.stringify(d));
      const bl = src.ext ? await Store.getSourceBlob(p.id, src.id, src.ext).catch(() => null) : null; if (bl) z.file(`projects/${p.id}/sources/${src.id}.${src.ext}`, bl);
    }
  }
  download(await z.generateAsync({type: 'blob', compression: 'DEFLATE'}), `acs-app-data-${new Date().toISOString().slice(0, 10)}.zip`);
};
$('#btnImportApp').onclick = () => $('#appFile').click();
$('#appFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importAppZip(f); };
async function importAppZip(f){
  if (!window.JSZip) return toast('JSZip did not load - are you online?');
  try {
    toast(`Reading ${f.name}…`, 60000);
    const z = await JSZip.loadAsync(f);
    if (!z.file('projects.json')) throw new Error('this zip is not an app-data export (no projects.json)');
    const idx = JSON.parse(await z.file('projects.json').async('string'));
    const list = idx.projects || [];
    if (!confirm(`Add ${list.length} project(s) from this file to the ones you have? (Projects with the same id are imported as copies.)`)) return;
    await writeState();
    // an untouched starter project ("Project 1" with nothing in it) is replaced by the import
    const cur0 = projects.find(x => x.id === curProject);
    const starter = cur0 && !S.cards.length && !(S.sources || []).length && !(S.nodes || []).length ? cur0.id : null;
    let n = 0, firstId = null;
    for (const p of list){
      toast(`Importing ${++n} of ${list.length}: ${p.name || p.id}…`, 60000);
      const zf = z.file(`projects/${p.id}.json`); if (!zf) continue;
      const st = unpackState(JSON.parse(await zf.async('string')));
      const id = projects.some(x => x.id === p.id) ? 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) : p.id;
      if (id !== p.id) st.projectName = (st.projectName || p.name || 'Project') + ' (imported)';   // a copy keeps its own name
      await Store.putProject(id, st, undefined, (done, all) => toast(`Importing ${n} of ${list.length}: ${p.name || p.id} - images ${done}/${all}`, 60000), true);
      for (const src of st.sources || []){
        const jf = z.file(`projects/${p.id}/sources/${src.id}.json`); if (!jf) continue;
        const bf = src.ext && z.file(`projects/${p.id}/sources/${src.id}.${src.ext}`);
        await Store.putSource(id, src.id, JSON.parse(await jf.async('string')), bf ? new Blob([await bf.async('uint8array')], {type: src.mime || ''}) : null);
      }
      // register it now (so it shows up straight away and the background sync can't drop it)
      const entry = {...p, id, name: p.name + (id !== p.id ? ' (imported)' : ''), updated: Date.now()};
      projects = projects.filter(x => x.id !== id).concat([entry]);
      await saveIndex(); renderProjects();
      firstId = firstId || id;
    }
    if (starter && firstId){ await switchProject(firstId); await Store.delProject(starter).catch(() => {}); projects = projects.filter(x => x.id !== starter); await saveIndex(); }
    const sf = z.file('settings.json');
    if (sf && confirm('Also replace your keys & settings with the ones in this file?')){ SET = mergeSettings(JSON.parse(await sf.async('string'))); saveSettings(); }
    renderProjects(); toast(`Imported ${list.length} project(s)`, 4000);
  } catch (er) { console.error(er); toast('Could not import: ' + er.message, 8000); }
}

