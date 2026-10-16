const $ = (id) => document.getElementById(id);
const clean = (t) => (t && !/^Episode \d+$/.test(t) ? t.replace(/^Episode\s+\d+\s*[:\-–]\s*/i, '') : '');

function render(s) {
  const at = s.lastSync ? new Date(s.lastSync) : null;
  const fresh = at && Date.now() - at.getTime() < 2 * 3600000;
  $('last').textContent = at ? `synced ${relTime(at)}` : 'never synced';
  $('dot').className = `dot ${s.lastError ? 'bad' : fresh ? 'fresh' : ''}`;
  const r = s.lastResult;
  // The header says when; this line only speaks up when the last sync changed something or needs you.
  const news = r ? [r.marked ? `${r.marked} newly watched` : '', r.newAnime ? `${r.newAnime} new show${r.newAnime === 1 ? '' : 's'}` : '', r.needsReview ? `${r.needsReview} to review in Sync` : ''].filter(Boolean) : [];
  $('result').textContent = news.length ? `Last sync: ${news.join(' · ')}` : '';
  $('status').title = r ? `Last sync read ${r.fetched} plays from Crunchyroll` : '';
  $('error').textContent = s.lastError || (s.lastSync ? '' : 'Not synced yet. Press the sync button above.');
  $('url').value = s.trackerUrl;
  $('key').value = s.trackerKey || '';
  $('notify').checked = s.notifyNew !== false;
  $('overlay').checked = s.overlay !== false;
  $('open').href = `${s.trackerUrl}/#/up-next`;
  $('all').href = `${s.trackerUrl}/#/up-next`;
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

const SHOWN = 6;
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "E6 18:30" (today), "E6 tomorrow", "E6 Sat", "E6 Oct 24": when the next episode airs. */
function airs(ep, at) {
  const d = new Date(at); const now = new Date();
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (d < now) return ''; // already out (the list catches up at the next sync)
  const when = dayDiff <= 0 ? d.toTimeString().slice(0, 5) : dayDiff === 1 ? 'tomorrow' : dayDiff < 7 ? days[d.getDay()] : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `E${ep} ${when}`;
}
/** "~3 h" or "~45 min" for what's left. */
const timeLeft = (eps, min) => { const m = eps * (min || 24); return m >= 90 ? `~${Math.round(m / 60)} h` : `~${m} min`; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The dashboard's "continue watching" shows: episode still, progress, and Play straight to Crunchyroll. */
async function loadUpNext(s) {
  const box = $('upnext');
  const auth = s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {};
  try {
    const res = await fetch(`${s.trackerUrl}/api/up-next`, { headers: auth });
    if (!res.ok) throw new Error(res.status === 401 ? 'tracker key rejected' : `tracker ${res.status}`);
    const data = await res.json();
    const all = data.continueWatching;
    const items = all.slice(0, SHOWN);
    $('count').textContent = all.length > SHOWN ? `${SHOWN} of ${all.length}` : all.length ? String(all.length) : '';
    $('all').hidden = all.length <= SHOWN;
    box.replaceChildren();
    if (!items.length) { box.append(empty("You're all caught up.")); return; }
    for (const x of items) {
      const name = clean(x.nextEpisodeTitle);
      const url = x.nextEpisodeUrl || `${s.trackerUrl}/#/library?anime=${x.malId}`;
      const item = el('div', 'item');
      // Episode still with its number and the show's progress along the bottom.
      const thumb = el('div', 'thumb');
      const img = el('img'); img.alt = '';
      // Image routes need the key too, and an <img> can't send a header: fetch, then show the blob.
      const src = (x.nextEpisodeImage || x.image || '').replace(/^\//, `${s.trackerUrl}/`);
      if (src) fetch(src, { headers: auth }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
      const bar = el('div', 'bar'); const fill = el('i');
      const of = x.totalEpisodes || x.aired;
      if (of) fill.style.width = `${Math.min(100, Math.round((100 * x.watched) / of))}%`;
      bar.append(fill);
      thumb.append(img, el('span', 'ep', `E${x.nextEpisode}`), bar);
      // Title (stretched link over the card), episode name, then the details line.
      const text = el('div', 'text');
      const t = el('a', 't'); t.href = url; t.target = '_blank'; t.rel = 'noopener';
      t.title = x.title;
      if (x.latestAiredAt && Date.now() - new Date(x.latestAiredAt).getTime() < 3 * 86400000) t.append(el('span', 'new', 'New'));
      t.append(x.title);
      const sub = el('div', 's', name ? `E${x.nextEpisode} · ${name}` : `Episode ${x.nextEpisode}`);
      sub.title = sub.textContent;
      const facts = [
        `${x.watched}/${x.totalEpisodes || x.aired || '?'}`,
        `${x.remaining} left`,
        timeLeft(x.remaining, x.episodeMinutes),
        x.status === 'RELEASING' && x.nextAiringEpisode && x.nextAiringAt ? airs(x.nextAiringEpisode, x.nextAiringAt) : ''
      ].filter(Boolean);
      const meta = el('div', 'm', facts.join(' · '));
      text.append(t, sub, meta);
      // Play goes straight to the episode on Crunchyroll; ✓ ticks it off when you watched it elsewhere.
      const acts = el('div', 'acts');
      const play = el('a', `play${x.nextEpisodeUrlIsExact ? '' : ' quiet'}`, x.nextEpisodeUrlIsExact ? '▶ Play' : 'Open');
      play.href = url; play.target = '_blank'; play.rel = 'noopener';
      if (!x.nextEpisodeUrlIsExact) play.title = `Opens the show on ${x.nextEpisodeSite || 'Crunchyroll'}`;
      const tick = el('button', 'tick', '✓'); tick.type = 'button';
      tick.title = `Mark E${x.nextEpisode} watched`; tick.setAttribute('aria-label', `Mark episode ${x.nextEpisode} of ${x.title} watched`);
      tick.onclick = () => markWatched(s, x, sub, tick);
      acts.append(play, tick);
      text.append(acts);
      item.append(thumb, text);
      box.append(item);
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
  $('sync').classList.add('busy');
  $('last').textContent = 'syncing…';
  chrome.runtime.sendMessage({ type: 'sync-now', full }, () => { $('sync').disabled = $('full').disabled = false; $('sync').classList.remove('busy'); refresh(); });
}
$('sync').onclick = () => sync(false);
$('full').onclick = () => sync(true);
$('url').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-url', url: e.target.value }, refresh);
$('overlay').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-overlay', on: e.target.checked }, refresh);
$('notify').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-notify', on: e.target.checked }, refresh);
$('key').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-key', key: e.target.value }, refresh);
refresh();
