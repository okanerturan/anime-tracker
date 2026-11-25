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
  showAlert();
  chrome.permissions.contains({ origins: ['https://www.crunchyroll.com/*'] }).then((ok) => { $('allowCr').hidden = ok; showAlert(); });
  $('version').textContent = `Extension ${chrome.runtime.getManifest().version}`;
  $('url').value = s.trackerUrl;
  $('key').value = s.trackerKey || '';
  // Pairing codes are for a tracker with accounts (keys start trk_); a passphrase tracker never has a Connect page.
  $('pairBox').hidden = Boolean(s.trackerKey) && !/^trk_/.test(s.trackerKey);
  $('notify').checked = s.notifyNew !== false;
  $('overlay').checked = s.overlay !== false;
  $('open').href = `${s.trackerUrl}/#/up-next`;
  loadUpNext(s);
}

/** The alert under the header shows only when there is an error or Chrome blocks Crunchyroll. */
function showAlert() {
  if (!$('allowCr').hidden && !$('error').textContent) $('error').textContent = 'Chrome is blocking this extension from crunchyroll.com, so it can\'t read your history.';
  $('alert').hidden = !$('error').textContent && $('allowCr').hidden;
}

/** Settings swap in for the list (the gear in the header), so they never sit below a scroll. */
function showSettings(on) {
  $('gear').setAttribute('aria-pressed', String(on));
  $('settings').hidden = !on;
  $('upnextView').hidden = on;
  document.querySelector('main').scrollTop = 0;
}
$('gear').onclick = () => showSettings($('gear').getAttribute('aria-pressed') !== 'true');

function relTime(d) {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

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

/** What is on screen: the tracker it came from and the list itself, so an unchanged refresh redraws nothing. */
let drawn = { from: null, key: null };
const sourceOf = (s) => `${s.trackerUrl}\n${s.trackerKey || ''}`;

/**
 * The dashboard's "continue watching" shows. The copy kept from the last sync (or the last time the
 * popup was open) is drawn at once; the tracker is then asked, and the list redrawn only if it changed.
 * When the tracker can't be reached the kept list stays, with a line saying so.
 */
async function loadUpNext(s) {
  const box = $('upnext');
  const from = sourceOf(s);
  const kept = s.upNextCache && s.upNextCache.url === s.trackerUrl ? s.upNextCache : null;
  if (drawn.from !== from) {
    // Another tracker's list (the address or key just changed) must not stay up while this one loads.
    const other = drawn.from !== null;
    drawn = { from: null, key: null };
    $('stale').textContent = '';
    if (kept) drawList(s, kept.view);
    else if (other) { $('count').textContent = ''; box.replaceChildren(empty('Loading…')); }
  }
  try {
    const res = await fetch(`${s.trackerUrl}/api/up-next`, { headers: s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {} });
    if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'tracker key rejected' : `tracker ${res.status}`), { status: res.status });
    const view = upNextView(await res.json());
    $('stale').textContent = '';
    drawList(s, view);
    chrome.storage.local.set({ upNextCache: { url: s.trackerUrl, at: new Date().toISOString(), view } });
  } catch (err) {
    // A rejected key means the kept list may not be this tracker's to show: drop it.
    if (err.status === 401) chrome.storage.local.set({ upNextCache: null });
    if (drawn.from === from && err.status !== 401) {
      $('stale').textContent = `Couldn't refresh (${err.message}). This is the list from ${kept ? relTime(new Date(kept.at)) : 'earlier'}.`;
      return;
    }
    drawn = { from: null, key: null };
    $('stale').textContent = '';
    $('count').textContent = '';
    box.replaceChildren(empty(/key/.test(err.message) ? 'Set the tracker key in Settings (the gear at the top).' : `Can't reach the tracker (${err.message}).`));
  }
}

/** Draw a list (see upnext-view.js) unless the same one from the same tracker is already showing. */
function drawList(s, view) {
  const box = $('upnext');
  const from = sourceOf(s);
  const key = JSON.stringify(view);
  if (drawn.from === from && drawn.key === key) return;
  drawn = { from, key };
  const auth = s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {};
  $('count').textContent = [view.total ? `${view.total} show${view.total === 1 ? '' : 's'}` : '', view.fresh ? `${view.fresh} new this week` : ''].filter(Boolean).join(' · ');
  box.replaceChildren();
  if (!view.items.length) { box.append(empty("You're all caught up.")); return; }
  for (const x of view.items) {
    const name = clean(x.nextEpisodeTitle);
    const url = x.nextEpisodeUrl || `${s.trackerUrl}/#/library?anime=${x.malId}`;
    const item = el('div', 'item');
    // Episode still with its number. No bar along the bottom: there it reads as how far into this
    // episode you got (Crunchyroll's playhead), and the show's progress is in the details line.
    const thumb = el('div', 'thumb');
    const img = el('img'); img.alt = '';
    // Image routes need the key too, and an <img> can't send a header: fetch, then show the blob.
    const src = (x.nextEpisodeImage || x.image || '').replace(/^\//, `${s.trackerUrl}/`);
    if (src) fetch(src, { headers: auth }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
    thumb.append(img, el('span', 'ep', `E${x.nextEpisode}`));
    // Title (stretched link over the card), episode name, then the details line.
    const text = el('div', 'text');
    const t = el('a', 't'); t.href = url; t.target = '_blank'; t.rel = 'noopener';
    t.title = x.title;
    // The same rule as the icon's badge (background.js).
    if (isNewEpisode(x)) t.append(el('span', 'new', 'New'));
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
}

/** Tick the next episode off (Undo for a few seconds), then reload the list. */
async function markWatched(s, x, sub, tick) {
  const post = (path, body) => fetch(`${s.trackerUrl}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension', ...(s.trackerKey ? { Authorization: `Bearer ${s.trackerKey}` } : {}) },
    body: JSON.stringify(body) }).then(async (r) => { if (!r.ok) throw new Error(`tracker ${r.status}`); return r.json(); });
  tick.disabled = true;
  try {
    const r = await post('/api/episode/watched-through', { malId: x.malId, episodeNumber: x.nextEpisode });
    // The list on screen and the kept copy are out of date from here: the next load redraws, and a
    // popup closed before then opens on a fresh list, not on the episode just ticked.
    drawn.key = null;
    chrome.storage.local.set({ upNextCache: null });
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
// Chrome withholding site access: ask for crunchyroll.com (needs this click), then sync.
// The background syncs as soon as access is granted (permissions.onAdded), even if this popup closes.
$('allowCr').onclick = async () => {
  const ok = await chrome.permissions.request({ origins: ['https://www.crunchyroll.com/*', 'https://graphql.anilist.co/*'] }).catch(() => false);
  if (ok) { $('allowCr').hidden = true; $('error').textContent = ''; showAlert(); $('last').textContent = 'syncing…'; setTimeout(refresh, 4000); return; }
  $('alert').hidden = false;
  $('error').textContent = 'Chrome didn\'t give access. In chrome://extensions, open Tsuzuku\'s Details and set Site access to "On all sites".';
};
$('sync').onclick = () => sync(false);
$('full').onclick = () => sync(true);
$('url').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-url', url: e.target.value }, refresh);
$('overlay').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-overlay', on: e.target.checked }, refresh);
$('notify').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-notify', on: e.target.checked }, refresh);
$('key').onchange = (e) => chrome.runtime.sendMessage({ type: 'set-tracker-key', key: e.target.value }, refresh);
// Pairing code from the tracker's Connect page: trade it for this browser's sync token.
$('pairGo').onclick = async () => {
  const out = $('pairResult');
  out.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ type: 'get-state' }, async (s) => {
    try {
      const res = await fetch(`${s.trackerUrl}/auth/device/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension' }, body: JSON.stringify({ code: $('pair').value, name: 'Chrome extension' }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `tracker ${res.status}`);
      chrome.runtime.sendMessage({ type: 'set-tracker-key', key: j.token }, () => { out.textContent = 'Connected. Syncing now.'; $('pair').value = ''; chrome.runtime.sendMessage({ type: 'sync-now' }); refresh(); });
    } catch (err) { out.textContent = err.message; }
  });
};
refresh();
