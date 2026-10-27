// Service worker: syncs every 30 minutes (and whenever you open Crunchyroll).
importScripts('crunchyroll-api.js', 'anilist-relay.js'); /* global crunchyrollSync, runAniListRelay */

const DEFAULTS = { trackerUrl: 'http://localhost:8080', trackerKey: '', clientId: null, lastSync: null, lastResult: null, lastError: null, notifyNew: true, notified: null, overlay: true };
const get = () => chrome.storage.local.get(DEFAULTS);
const set = (v) => chrome.storage.local.set(v);

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 30, delayInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 30, delayInMinutes: 1 }));
// The hosted tracker moved off workers.dev (2026-10-28). The old address only redirects, and a redirect
// to another host drops the Authorization header, so syncs to it would fail: point saved settings at
// the new one.
const MOVED = { 'https://anime-tracker.okan.workers.dev': 'https://tsuzuku.okanerturan.com' };
chrome.storage.local.get({ trackerUrl: null }).then(({ trackerUrl }) => {
  if (MOVED[trackerUrl]) chrome.storage.local.set({ trackerUrl: MOVED[trackerUrl] });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sync') syncNow({ reason: 'alarm' }).catch(() => {});
  if (a.name === 'after-watch') syncNow({ reason: 'watch' }).catch(() => {});
});

// Leaving a Crunchyroll watch page (next episode, back to the series, tab closed) means an episode
// probably just finished. Sync two minutes later so the dashboard rolls over while it still matters;
// repeated navigations push the alarm out, so a binge syncs once at the end of each episode gap.
const WATCH_RE = /^https:\/\/www\.crunchyroll\.com\/(?:[a-z-]+\/)?watch\//;
const watchTabs = new Map(); // tabId -> last watch URL
function leftWatchPage() { chrome.alarms.create('after-watch', { delayInMinutes: 2 }); }
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const was = watchTabs.get(tabId);
  // Navigating to a site we have no permission for reports no URL at all; a watch tab that starts
  // loading something unknown has left the episode.
  if (!info.url) { if (was && info.status === 'loading') { watchTabs.delete(tabId); leftWatchPage(); } return; }
  if (WATCH_RE.test(info.url)) { if (was && was !== info.url) leftWatchPage(); watchTabs.set(tabId, info.url); }
  else if (was) { watchTabs.delete(tabId); leftWatchPage(); }
});
chrome.tabs.onRemoved.addListener((tabId) => { if (watchTabs.has(tabId)) { watchTabs.delete(tabId); leftWatchPage(); } });

// The hosted tracker (Cloudflare) needs the passphrase as a bearer key; the local one ignores it.
const VERSION = chrome.runtime.getManifest().version;
const authHeaders = (key) => ({ 'X-Extension-Version': VERSION, ...(key ? { Authorization: `Bearer ${key}` } : {}) });
let trackerKey = '';

async function trackerStatus(trackerUrl) {
  let res;
  try {
    res = await fetch(`${trackerUrl}/api/crunchyroll/status`, { headers: authHeaders(trackerKey) });
  } catch {
    throw new Error(`Can't reach the tracker at ${trackerUrl}. Is it running, and is the Tracker URL right?`);
  }
  if (res.status === 401) throw new Error('The tracker rejected the key. Check "Tracker key" (your passphrase).');
  if (!res.ok) throw new Error(await serverMessage(res, `tracker ${res.status}`));
  return res.json();
}

/** The tracker's own explanation of a refusal (paused sync, maintenance), or a fallback. */
async function serverMessage(res, fallback) {
  try { return (await res.json()).error || fallback; } catch { return fallback; }
}

async function postTracker(trackerUrl, path, payload) {
  const res = await fetch(`${trackerUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension', ...authHeaders(trackerKey) },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(await serverMessage(res, `tracker ${path} ${res.status}`));
  return res.json();
}

/** Crunchyroll's public web client id, read from the site's page config when no tab has shared it yet. */
async function ensureClientId(cfg) {
  if (cfg.clientId) return cfg.clientId;
  const html = await (await fetch('https://www.crunchyroll.com/', { credentials: 'include' })).text();
  const m = html.match(/"accountAuthClientId"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error("Couldn't reach your Crunchyroll account. Open crunchyroll.com in this browser, check you're signed in, and try again.");
  await set({ clientId: m[1] });
  return m[1];
}

let running = null;
async function syncNow({ full = false, data = null, reason = 'manual' } = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = await get();
    trackerKey = cfg.trackerKey || '';
    try {
      const status = await trackerStatus(cfg.trackerUrl);
      const clientId = data ? cfg.clientId : await ensureClientId(cfg);
      const got = data || await crunchyrollSync({ clientId, since: status.latestPlayed, full, wantSeasons: status.wantSeasons, wantSeries: status.wantSeries || [],
        // Library shows not played yet: the tracker picks their season from the series' list.
        wantSeriesSeasons: status.wantSeriesSeasons || [],
        chooseSeasons: async (items) => (await postTracker(cfg.trackerUrl, '/api/crunchyroll/series-seasons', { items })).seasonIds });
      const result = await postTracker(cfg.trackerUrl, '/api/crunchyroll/ingest', { rows: got.rows });
      const episodes = got.seasons && got.seasons.length ? await postTracker(cfg.trackerUrl, '/api/crunchyroll/episodes', { seasons: got.seasons }) : null;
      const links = got.series && got.series.length ? await postTracker(cfg.trackerUrl, '/api/crunchyroll/series', { results: got.series }).catch(() => null) : null;
      // AniList relay: answer what the tracker couldn't fetch itself, then re-run mapping for plays it deferred.
      let relay = null;
      try {
        relay = await runAniListRelay(cfg.trackerUrl, authHeaders(trackerKey), 'extension');
        if (relay.ran && result.deferred) Object.assign(result, await postTracker(cfg.trackerUrl, '/api/crunchyroll/ingest', { rows: [] }));
      } catch { /* the relay is best effort */ }
      await set({ lastSync: new Date().toISOString(), lastResult: { ...result, episodes, links, relay, reason, fetched: got.rows.length }, lastError: null });
      notifyNewEpisodes(cfg).catch(() => {});
      return { ok: true, result };
    } catch (err) {
      await set({ lastError: `${new Date().toLocaleString()}: ${err.message}` });
      return { ok: false, error: err.message };
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * New-episode notifications. After a sync, any show on Continue watching whose newest aired episode
 * is newer than what we last told you about gets one notification. The first run only records a
 * baseline, so installing the extension doesn't produce a flood.
 */
async function notifyNewEpisodes(cfg) {
  const notify = cfg.notifyNew !== false && Boolean(chrome.notifications);
  const res = await fetch(`${cfg.trackerUrl}/api/up-next`, { headers: authHeaders(cfg.trackerKey || '') });
  if (!res.ok) return;
  const data = await res.json();
  const seen = (await get()).notified;
  const next = { ...(seen || {}) };
  const fresh = [];
  for (const x of data.continueWatching || []) {
    if (!x.latestAiredAt) continue;
    const at = new Date(x.latestAiredAt).getTime();
    if (seen && (!seen[x.malId] || at > seen[x.malId]) && Date.now() - at < 3 * 86400000) fresh.push(x);
    next[x.malId] = Math.max(at, next[x.malId] || 0);
  }
  // Premieres: a season from "Coming soon" that started airing in the last 7 days, once per season.
  const premieres = [];
  for (const x of data.newSeasons || []) {
    if (x.status !== 'RELEASING' || !x.startDate) continue;
    const at = new Date(x.startDate).getTime();
    if (Number.isNaN(at) || Date.now() - at > 7 * 86400000 || at > Date.now()) continue;
    const key = `s${x.malId}`;
    if (seen && !seen[key]) premieres.push(x);
    next[key] = at;
  }
  await set({ notified: next });
  // Icon badge: shows with an episode out in the last 7 days that you haven't watched yet.
  const week = (data.continueWatching || []).filter((x) => x.latestAiredAt && Date.now() - new Date(x.latestAiredAt).getTime() < 7 * 86400000).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#f47521' });
    await chrome.action.setBadgeText({ text: week ? String(week) : '' });
    await chrome.action.setTitle({ title: week ? `Tsuzuku: ${week} show${week === 1 ? '' : 's'} with a new episode this week` : 'Tsuzuku' });
  } catch {}
  if (!notify) return;
  for (const x of premieres.slice(0, 3)) {
    chrome.notifications.create(`ep|${x.malId}|${x.crunchyrollUrl || `${cfg.trackerUrl}/#/up-next?anime=${x.malId}`}`, {
      type: 'basic', iconUrl: 'icons/icon-128.png', title: 'New season started',
      message: `${x.title}${x.after ? ` (after ${x.after})` : ''} is airing now`, priority: 0
    });
  }
  for (const x of fresh.slice(0, 3)) {
    chrome.notifications.create(`ep|${x.malId}|${x.nextEpisodeUrl || `${cfg.trackerUrl}/#/up-next`}`, {
      type: 'basic', iconUrl: 'icons/icon-128.png', title: 'New episode out',
      message: `${x.title} · episode ${x.nextEpisode}${x.nextEpisodeTitle && !/^Episode \d+$/.test(x.nextEpisodeTitle) ? `: ${x.nextEpisodeTitle}` : ''}`,
      priority: 0
    });
  }
  if (fresh.length > 3) chrome.notifications.create(`more|${Date.now()}|${cfg.trackerUrl}/#/up-next`, { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'New episodes out', message: `${fresh.length - 3} more shows have new episodes`, priority: 0 });
}
chrome.notifications?.onClicked.addListener((id) => {
  const url = id.split('|').slice(2).join('|');
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'cr-config' && msg.clientId) {
      await set({ clientId: msg.clientId });
      const { lastSync } = await get();
      // Opening Crunchyroll triggers a sync if the last one is older than 10 minutes.
      const stale = !lastSync || Date.now() - new Date(lastSync).getTime() > 10 * 60 * 1000;
      let since = null; let wantSeasons = []; let wantSeries = [];
      try { const c = await get(); trackerKey = c.trackerKey || ''; const st = await trackerStatus(c.trackerUrl); since = st.latestPlayed; wantSeasons = st.wantSeasons || []; wantSeries = st.wantSeries || []; } catch {}
      reply({ shouldSync: stale, since, wantSeasons, wantSeries });
    } else if (msg.type === 'page-data') {
      reply(await syncNow({ data: msg.data, reason: 'page' }));
    } else if (msg.type === 'bridge-hello' || msg.type === 'page-sync') {
      // Only the tracker this extension syncs to may ask (page-sync-bridge.js runs on any workers.dev page).
      const cfg = await get();
      let mine = false;
      try { mine = Boolean(sender.origin) && new URL(cfg.trackerUrl).origin === sender.origin; } catch {}
      if (!mine) reply({ ok: false });
      else if (msg.type === 'bridge-hello') reply({ ok: true });
      else {
        const r = await syncNow({ reason: 'page' });
        reply(r.ok ? { ok: true, marked: r.result?.marked ?? 0 } : { ok: false, error: r.error });
      }
    } else if (msg.type === 'sync-now') {
      reply(await syncNow({ full: Boolean(msg.full), reason: msg.full ? 'full' : 'manual' }));
    } else if (msg.type === 'get-state') {
      reply(await get());
    } else if (msg.type === 'connect-tracker') {
      // From tracker-bridge.js on the tracker's own page: the address must be the page's own origin.
      const origin = sender.url ? new URL(sender.url).origin : null;
      if (!origin || origin !== msg.url || !/^trk_/.test(String(msg.token || ''))) { reply({ ok: false, error: 'not from the tracker page' }); return; }
      await set({ trackerUrl: origin, trackerKey: msg.token, lastError: null });
      trackerKey = msg.token;
      reply({ ok: true });
      syncNow().catch(() => {});
      return;
    } else if (msg.type === 'set-tracker-url') {
      await set({ trackerUrl: String(msg.url || DEFAULTS.trackerUrl).replace(/\/+$/, '') });
      reply({ ok: true });
    } else if (msg.type === 'series-info') {
      // For the card on crunchyroll.com: which of your shows belong to this series, and your progress.
      try {
        const c = await get();
        if (c.overlay === false) { reply(null); return; }
        const res = await fetch(`${c.trackerUrl}/api/crunchyroll/series-info?seriesId=${encodeURIComponent(msg.seriesId)}`, { headers: authHeaders(c.trackerKey || '') });
        reply(res.ok ? { ...(await res.json()), trackerUrl: c.trackerUrl } : null);
      } catch { reply(null); }
    } else if (msg.type === 'rate') {
      // Star rating from the card on crunchyroll.com (finished, unrated shows).
      const malId = Number(msg.malId); const rating = Number(msg.rating);
      if (!Number.isInteger(malId) || malId <= 0 || !Number.isInteger(rating) || rating < 1 || rating > 5) { reply({ ok: false }); return; }
      try {
        const c = await get();
        const res = await fetch(`${c.trackerUrl}/api/anime/rating`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension', ...authHeaders(c.trackerKey || '') }, body: JSON.stringify({ malId, rating }) });
        reply({ ok: res.ok });
      } catch { reply({ ok: false }); }
    } else if (msg.type === 'list-status') {
      // Hold / Drop / back to active from the card on crunchyroll.com.
      const malId = Number(msg.malId); const status = msg.status ?? null;
      if (!Number.isInteger(malId) || malId <= 0 || ![null, 'on_hold', 'dropped'].includes(status)) { reply({ ok: false }); return; }
      try {
        const c = await get();
        const res = await fetch(`${c.trackerUrl}/api/anime/list-status`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension', ...authHeaders(c.trackerKey || '') }, body: JSON.stringify({ malId, status }) });
        reply({ ok: res.ok });
      } catch { reply({ ok: false }); }
    } else if (msg.type === 'set-overlay') {
      await set({ overlay: Boolean(msg.on) });
      reply({ ok: true });
    } else if (msg.type === 'set-notify') {
      await set({ notifyNew: Boolean(msg.on) });
      reply({ ok: true });
    } else if (msg.type === 'set-tracker-key') {
      await set({ trackerKey: String(msg.key || '') });
      reply({ ok: true });
    }
  })();
  return true;
});
