const $ = (id) => document.getElementById(id);
function render(s) {
  $('last').textContent = s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never';
  const r = s.lastResult;
  $('result').textContent = r ? `Fetched ${r.fetched} · newly watched ${r.marked} · new shows ${r.newAnime}${r.episodes ? ` · ${r.episodes.images} thumbnails` : ''}${r.needsReview ? ` · ${r.needsReview} need review` : ''}${r.relay && r.relay.ran ? ` · ${r.relay.ran} AniList lookups` : ''}` : '';
  $('error').textContent = s.lastError || (s.lastSync ? '' : 'Not synced yet. Click “Sync now”.');
  $('url').value = s.trackerUrl;
  $('key').value = s.trackerKey || '';
}
function refresh() { chrome.runtime.sendMessage({ type: 'get-state' }, render); }
async function sync(full) {
  $('sync').disabled = $('full').disabled = true;
  $('result').textContent = 'Syncing…';
  chrome.runtime.sendMessage({ type: 'sync-now', full }, () => { $('sync').disabled = $('full').disabled = false; refresh(); });
}
$('sync').onclick = () => sync(false);
$('full').onclick = () => sync(true);
$('url').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-url', url: e.target.value }, refresh);
$('key').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-key', key: e.target.value }, refresh);
refresh();
