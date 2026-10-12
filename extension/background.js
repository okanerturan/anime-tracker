// Service worker: syncs every 30 minutes (and whenever you open Crunchyroll).
importScripts('crunchyroll-api.js'); /* global crunchyrollSync */

const DEFAULTS = { trackerUrl: 'http://localhost:8080', trackerKey: '', clientId: null, lastSync: null, lastResult: null, lastError: null };
const get = () => chrome.storage.local.get(DEFAULTS);
const set = (v) => chrome.storage.local.set(v);

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 30, delayInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sync', { periodInMinutes: 30, delayInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') syncNow({ reason: 'alarm' }).catch(() => {}); });

// The hosted tracker (Cloudflare) needs the passphrase as a bearer key; the local one ignores it.
const authHeaders = (key) => (key ? { Authorization: `Bearer ${key}` } : {});
let trackerKey = '';

async function trackerStatus(trackerUrl) {
  let res;
  try {
    res = await fetch(`${trackerUrl}/api/crunchyroll/status`, { headers: authHeaders(trackerKey) });
  } catch {
    throw new Error(`Can't reach the tracker at ${trackerUrl}. Is it running, and is the Tracker URL right?`);
  }
  if (res.status === 401) throw new Error('The tracker rejected the key. Check "Tracker key" (your passphrase).');
  if (!res.ok) throw new Error(`tracker ${res.status}`);
  return res.json();
}

async function postTracker(trackerUrl, path, payload) {
  const res = await fetch(`${trackerUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension', ...authHeaders(trackerKey) },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`tracker ${path} ${res.status}`);
  return res.json();
}

/** Crunchyroll's public web client id, read from the site's page config when no tab has shared it yet. */
async function ensureClientId(cfg) {
  if (cfg.clientId) return cfg.clientId;
  const html = await (await fetch('https://www.crunchyroll.com/', { credentials: 'include' })).text();
  const m = html.match(/"accountAuthClientId"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error('could not read Crunchyroll config; open crunchyroll.com in a tab');
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
      const got = data || await crunchyrollSync({ clientId, since: status.latestPlayed, full, wantSeasons: status.wantSeasons });
      const result = await postTracker(cfg.trackerUrl, '/api/crunchyroll/ingest', { rows: got.rows });
      const episodes = got.seasons && got.seasons.length ? await postTracker(cfg.trackerUrl, '/api/crunchyroll/episodes', { seasons: got.seasons }) : null;
      await set({ lastSync: new Date().toISOString(), lastResult: { ...result, episodes, reason, fetched: got.rows.length }, lastError: null });
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'cr-config' && msg.clientId) {
      await set({ clientId: msg.clientId });
      const { lastSync } = await get();
      // Opening Crunchyroll triggers a sync if the last one is older than 10 minutes.
      const stale = !lastSync || Date.now() - new Date(lastSync).getTime() > 10 * 60 * 1000;
      let since = null; let wantSeasons = [];
      try { const c = await get(); trackerKey = c.trackerKey || ''; const st = await trackerStatus(c.trackerUrl); since = st.latestPlayed; wantSeasons = st.wantSeasons || []; } catch {}
      reply({ shouldSync: stale, since, wantSeasons });
    } else if (msg.type === 'page-data') {
      reply(await syncNow({ data: msg.data, reason: 'page' }));
    } else if (msg.type === 'sync-now') {
      reply(await syncNow({ full: Boolean(msg.full), reason: msg.full ? 'full' : 'manual' }));
    } else if (msg.type === 'get-state') {
      reply(await get());
    } else if (msg.type === 'set-tracker-url') {
      await set({ trackerUrl: String(msg.url || DEFAULTS.trackerUrl).replace(/\/+$/, '') });
      reply({ ok: true });
    } else if (msg.type === 'set-tracker-key') {
      await set({ trackerKey: String(msg.key || '') });
      reply({ ok: true });
    }
  })();
  return true;
});
