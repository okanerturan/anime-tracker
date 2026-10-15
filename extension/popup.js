const $ = (id) => document.getElementById(id);
const clean = (t) => (t && !/^Episode \d+$/.test(t) ? t.replace(/^Episode\s+\d+\s*[:\-–]\s*/i, '') : '');

function render(s) {
  const at = s.lastSync ? new Date(s.lastSync) : null;
  const fresh = at && Date.now() - at.getTime() < 2 * 3600000;
  $('last').textContent = at ? `synced ${relTime(at)}` : 'never synced';
  $('dot').className = `dot ${s.lastError ? 'bad' : fresh ? 'fresh' : ''}`;
  const r = s.lastResult;
  $('result').textContent = r ? `Last sync: ${r.fetched} plays · ${r.marked} newly watched${r.newAnime ? ` · ${r.newAnime} new shows` : ''}${r.needsReview ? ` · ${r.needsReview} need review` : ''}${r.links && r.links.found ? ` · ${r.links.found} Crunchyroll links` : ''}` : '';
  $('error').textContent = s.lastError || (s.lastSync ? '' : 'Not synced yet. Click “Sync now”.');
  $('url').value = s.trackerUrl;
  $('key').value = s.trackerKey || '';
  $('notify').checked = s.notifyNew !== false;
  $('overlay').checked = s.overlay !== false;
  $('open').href = `${s.trackerUrl}/#/up-next`;
  loadUpNext(s);
}

function relTime(d) {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** The dashboard's top four "continue watching" shows, with Play links that go straight to Crunchyroll. */
async function loadUpNext(s) {
  const box = $('upnext');
  try {
    const res = await fetch(`${s.trackerUrl}/api/up-next`, { headers: s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {} });
    if (!res.ok) throw new Error(res.status === 401 ? 'tracker key rejected' : `tracker ${res.status}`);
    const data = await res.json();
    const items = data.continueWatching.slice(0, 4);
    box.replaceChildren();
    if (!items.length) { box.append(empty("You're all caught up.")); return; }
    for (const x of items) {
      const name = clean(x.nextEpisodeTitle);
      const a = document.createElement('a');
      a.className = 'item';
      a.href = x.nextEpisodeUrl || `${s.trackerUrl}/#/up-next`;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = document.createElement('img');
      img.alt = '';
      // Image routes need the key too, and an <img> can't send a header: fetch, then show the blob.
      const src = (x.nextEpisodeImage || x.image || '').replace(/^\//, `${s.trackerUrl}/`);
      if (src) fetch(src, { headers: s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {} }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
      const text = document.createElement('div');
      const t = document.createElement('div'); t.className = 't';
      // "New": the latest episode aired in the last three days.
      if (x.latestAiredAt && Date.now() - new Date(x.latestAiredAt).getTime() < 3 * 86400000) {
        const n = document.createElement('span'); n.className = 'new'; n.textContent = 'New'; t.append(n);
      }
      t.append(x.title);
      const sub = document.createElement('div'); sub.className = 's'; sub.textContent = `E${x.nextEpisode}${name ? ` · ${name}` : ''} · ${x.remaining} to go`;
      text.append(t, sub);
      const play = document.createElement('span'); play.className = 'play'; play.textContent = x.nextEpisodeUrlIsExact ? '▶ Play' : `Open on ${x.nextEpisodeSite || 'Crunchyroll'}`;
      a.append(img, text, play);
      // ✓ beside the row (a link can't hold a button): watched it elsewhere, tick it off from here.
      const tick = document.createElement('button');
      tick.className = 'tick'; tick.type = 'button'; tick.textContent = '✓';
      tick.title = `Mark E${x.nextEpisode} watched`; tick.setAttribute('aria-label', `Mark episode ${x.nextEpisode} of ${x.title} watched`);
      tick.onclick = () => markWatched(s, x, sub, tick);
      const pair = document.createElement('div'); pair.className = 'pair';
      pair.append(a, tick);
      box.append(pair);
    }
  } catch (err) {
    box.replaceChildren(empty(/key/.test(err.message) ? 'Set the tracker key under Settings.' : `Can't reach the tracker (${err.message}).`));
  }
}

/** Tick the next episode off (Undo for a few seconds), then reload the list. */
async function markWatched(s, x, sub, tick) {
  const post = (path, body) => fetch(`${s.trackerUrl}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension', ...(s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {}) },
    body: JSON.stringify(body) }).then(async (r) => { if (!r.ok) throw new Error(`tracker ${r.status}`); return r.json(); });
  tick.disabled = true;
  try {
    const r = await post('/api/episode/watched-through', { malId: x.malId, episodeNumber: x.nextEpisode });
    sub.textContent = `E${x.nextEpisode} marked watched · `;
    const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'linkish'; undo.textContent = 'Undo';
    undo.onclick = async () => {
      undo.disabled = true;
      try { await post('/api/episode/unmark', { malId: x.malId, episodes: r.episodes || [x.nextEpisode] }); loadUpNext(s); }
      catch (err) { undo.disabled = false; sub.firstChild.textContent = `Undo failed (${err.message}) · `; }
    };
    sub.append(undo);
    setTimeout(() => { if (!undo.disabled) loadUpNext(s); }, 6000);
  } catch (err) { tick.disabled = false; sub.textContent = `Couldn't mark it: ${err.message}`; }
}

function empty(text) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = text; return d; }

function refresh() { chrome.runtime.sendMessage({ type: 'get-state' }, render); }
async function sync(full) {
  $('sync').disabled = $('full').disabled = true;
  $('result').textContent = 'Syncing…';
  chrome.runtime.sendMessage({ type: 'sync-now', full }, () => { $('sync').disabled = $('full').disabled = false; refresh(); });
}
$('sync').onclick = () => sync(false);
$('full').onclick = () => sync(true);
$('url').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-url', url: e.target.value }, refresh);
$('overlay').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-overlay', on: e.target.checked }, refresh);
$('notify').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-notify', on: e.target.checked }, refresh);
$('key').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-key', key: e.target.value }, refresh);
refresh();
