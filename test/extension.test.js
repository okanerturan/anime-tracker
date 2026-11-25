'use strict';
// The extension's service worker (extension/background.js), run in a sandbox with a fake chrome.* and
// a scripted Crunchyroll and tracker. It checks the worker's own logic; what only a real Chrome can
// show (site access prompts, content scripts on the page) is not covered here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');
const TRACKER = 'https://tracker.test';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/**
 * Start a service worker. `local` and `session` are its storage areas (pass the same objects again to
 * model Chrome stopping and restarting it); `net(url, opts, fail)` answers its requests, and
 * `fail(message)` throws the way a browser's fetch does when a host can't be reached.
 */
function startWorker({ local = {}, session = {}, net = () => json({}), siteAccess = true } = {}) {
  const listeners = {}; const alarms = []; const requests = []; const badge = {}; let writes = 0;
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const area = (store, counted) => ({
    get: async (defaults) => ({ ...defaults, ...Object.fromEntries(Object.keys(defaults || {}).filter((k) => k in store).map((k) => [k, store[k]])) }),
    set: async (values) => { if (counted) writes += 1; Object.assign(store, JSON.parse(JSON.stringify(values))); }
  });
  const chrome = {
    runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'), getManifest: () => ({ version: '9.9.9' }) },
    alarms: { create: (name) => alarms.push(name), onAlarm: on('alarm') },
    storage: { local: area(local, true), session: area(session, false) },
    tabs: { onUpdated: on('tabUpdated'), onRemoved: on('tabRemoved'), create: () => {} },
    permissions: { onAdded: on('accessAdded'), contains: async () => siteAccess },
    notifications: { create: () => {}, clear: () => {}, onClicked: on('notificationClicked') },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async ({ text }) => { badge.text = text; }, setTitle: async () => {} }
  };
  const context = vm.createContext({ chrome, console, URL, URLSearchParams, crypto: globalThis.crypto, btoa, setTimeout, clearTimeout });
  const fail = (message) => { throw new (vm.runInContext('TypeError', context))(message); };
  context.fetch = async (url, opts = {}) => { requests.push(`${opts.method || 'GET'} ${url}`); return net(String(url), opts, fail); };
  context.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), context, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  const send = (msg, sender = {}) => new Promise((resolve) => listeners.message(msg, sender, resolve));
  return { send, listeners, alarms, requests, badge, local, session, writes: () => writes };
}

const shows = (n) => Array.from({ length: n }, (_, i) => ({ malId: i + 1, title: `Show ${i + 1}`, nextEpisode: 2, watched: 1, remaining: 3,
  latestAiredAt: i < 2 ? new Date(Date.now() - 3600e3).toISOString() : '2026-01-01T00:00:00Z', synopsisTheListNeverShows: 'x'.repeat(400) }));
const play = { id: 'EP1', playhead: 1400, fully_watched: true, date_played: '2026-11-25T10:00:00Z',
  panel: { title: 'Episode one', images: {}, episode_metadata: { series_id: 'S1', series_title: 'Show', season_id: 'SE1', season_title: 'Season 1', season_number: 1, episode_number: 1, duration_ms: 1440000 } } };

/** A tracker and a Crunchyroll that both work; `posted` collects what the worker sends the tracker. */
function working(posted = {}) {
  return (url, opts) => {
    if (url === `${TRACKER}/api/crunchyroll/status`) return json({ latestPlayed: '2026-11-24T00:00:00Z', wantSeasons: ['SE9'], wantSeries: [], wantSeriesSeasons: [] });
    if (url.endsWith('/auth/v1/token')) return json({ access_token: 'SECRET-TOKEN', account_id: 'acc-1', profile_id: 'prof-1' });
    if (url.includes('/watch-history')) return json({ data: [play] });
    if (url.includes('/cms/seasons/')) return json({ data: [] });
    if (url === `${TRACKER}/api/crunchyroll/ingest`) { posted.ingest = JSON.parse(opts.body); return json({ marked: 1 }); }
    if (url === `${TRACKER}/api/crunchyroll/episodes`) return json({ ok: true });
    if (url === `${TRACKER}/api/anilist/relay`) return json({ jobs: [] });
    if (url === `${TRACKER}/api/up-next`) return json({ continueWatching: shows(10), newSeasons: [] });
    return json({ error: `unexpected ${url}` }, 500);
  };
}
const settled = { trackerUrl: TRACKER, trackerKey: 'pass', clientId: 'cid' };

test('opening a Crunchyroll page asks the tracker nothing; it only says whether a sync is due', async () => {
  const fresh = startWorker({ local: { ...settled, lastSync: new Date(Date.now() - 60e3).toISOString() } });
  assert.equal((await fresh.send({ type: 'cr-config', clientId: 'cid' })).shouldSync, false);
  assert.deepEqual(fresh.requests, [], 'no request for a page load a minute after a sync');
  assert.equal(fresh.writes(), 0, 'an unchanged client id is not written again');

  const stale = startWorker({ local: { ...settled, clientId: null, lastSync: new Date(Date.now() - 3600e3).toISOString() } });
  assert.equal((await stale.send({ type: 'cr-config', clientId: 'new-id' })).shouldSync, true);
  assert.deepEqual(stale.requests, [], 'the sync that follows fetches what it needs');
  assert.equal(stale.local.clientId, 'new-id');
});

test('a sync sends the plays with the Crunchyroll account they belong to, then keeps the popup\'s list and sets the badge', async () => {
  const posted = {};
  const w = startWorker({ local: { ...settled }, net: working(posted) });
  const r = await w.send({ type: 'sync-now' });
  assert.equal(r.ok, true);
  assert.equal(posted.ingest.rows.length, 1);
  assert.equal(posted.ingest.rows[0].episodeId, 'EP1');
  assert.deepEqual(posted.ingest.account, { id: 'acc-1', profile: 'prof-1' });
  assert.ok(w.requests.every((q) => !q.includes('SECRET-TOKEN')), 'the Crunchyroll token is never in a URL');
  assert.equal(JSON.stringify(posted).includes('SECRET-TOKEN'), false, 'and never sent to the tracker');
  for (let i = 0; i < 50 && !w.local.upNextCache; i += 1) await tick();
  assert.equal(w.local.upNextCache.url, TRACKER);
  assert.equal(w.local.upNextCache.view.total, 10);
  assert.equal(w.local.upNextCache.view.fresh, 2);
  assert.equal(w.local.upNextCache.view.items.length, 6, 'only what the popup shows');
  assert.equal(w.local.upNextCache.view.items[0].synopsisTheListNeverShows, undefined, 'and only the fields it uses');
  assert.equal(w.badge.text, '2');
  assert.equal(w.local.lastError, null);
});

test('a first or full sync goes up in batches of 500 plays, and the popup gets one summed answer', async () => {
  const batches = [];
  const many = Array.from({ length: 1200 }, (_, i) => ({ ...play, id: `EP${i}` }));
  const net = (url, opts) => {
    if (url.includes('/watch-history')) return json({ data: /page=1&/.test(url) ? many.slice(0, 100) : [] });
    if (url === `${TRACKER}/api/crunchyroll/ingest`) {
      const body = JSON.parse(opts.body); batches.push(body);
      return json({ received: body.rows.length, stored: body.rows.length, marked: body.rows.length, newAnime: batches.length === 1 ? 2 : 0, needsReview: batches.length, deferred: batches.length === 2 });
    }
    return working()(url, opts);
  };
  // The page fallback hands the worker a whole history at once: 1,200 plays.
  const w = startWorker({ local: { ...settled }, net });
  const r = await w.send({ type: 'page-data', data: { rows: many.map((x) => ({ episodeId: x.id })), seasons: [], series: [], account: { id: 'acc-1', profile: null } } });
  assert.equal(r.ok, true);
  assert.deepEqual(batches.filter((b) => b.rows.length).map((b) => b.rows.length), [500, 500, 200]);
  assert.ok(batches.every((b) => b.account && b.account.id === 'acc-1'), 'each batch says whose history it is');
  assert.equal(batches[0].rows[0].episodeId, 'EP0'); assert.equal(batches[2].rows.at(-1).episodeId, 'EP1199');
  assert.equal(r.result.marked, 1200); assert.equal(r.result.received, 1200); assert.equal(r.result.newAnime, 2);
  assert.equal(r.result.needsReview, 3, 'a current count comes from the last batch, not a sum');
  // An ordinary sync with nothing new still sends one (empty) request, so the tracker logs the sync.
  const quiet = [];
  const w2 = startWorker({ local: { ...settled }, net: (url, opts) => { if (url.includes('/watch-history')) return json({ data: [] }); if (url.endsWith('/ingest')) quiet.push(JSON.parse(opts.body).rows.length); return working()(url, opts); } });
  assert.equal((await w2.send({ type: 'sync-now' })).ok, true);
  assert.deepEqual(quiet, [0]);
});

test('a failed sync names what failed; a Crunchyroll failure carries what the page needs to fetch the history itself', async () => {
  const noCr = startWorker({ local: { ...settled }, net: (url, opts, fail) => (url.includes('crunchyroll.com') ? fail('Failed to fetch') : working()(url, opts)) });
  const a = await noCr.send({ type: 'sync-now' });
  assert.equal(a.ok, false);
  assert.match(a.error, /Couldn't reach crunchyroll\.com/);
  assert.equal(a.since, '2026-11-24T00:00:00Z');
  assert.deepEqual([...a.wantSeasons], ['SE9']);
  assert.match(noCr.local.lastError, /crunchyroll\.com/);

  const noTracker = startWorker({ local: { ...settled }, net: (url, opts, fail) => fail('Failed to fetch') });
  const b = await noTracker.send({ type: 'sync-now' });
  assert.match(b.error, /Can't reach the tracker at https:\/\/tracker\.test/);
  assert.equal('since' in b, false, 'nothing to hand the page when the tracker never answered');

  const blocked = startWorker({ local: { ...settled }, net: working(), siteAccess: false });
  const c = await blocked.send({ type: 'sync-now' });
  assert.match(c.error, /Chrome is blocking this extension from crunchyroll\.com/);
  assert.ok(blocked.requests.every((q) => !q.includes('crunchyroll.com')), 'no Crunchyroll request without site access');

  const refused = startWorker({ local: { ...settled }, net: (url, opts) => (url.endsWith('/api/crunchyroll/ingest') ? json({ error: 'Crunchyroll is signed in to a different account.' }, 409) : working()(url, opts)) });
  assert.equal((await refused.send({ type: 'sync-now' })).error, 'Crunchyroll is signed in to a different account.', 'the tracker\'s own words');
});

test('changing the tracker address or key drops the kept list; a typed address gets https and an old one its new home', async () => {
  const kept = { url: TRACKER, at: '2026-11-25T00:00:00Z', view: { total: 1, fresh: 0, items: [] } };
  const w = startWorker({ local: { ...settled, upNextCache: kept } });
  await w.send({ type: 'set-tracker-key', key: 'other' });
  assert.equal(w.local.upNextCache, null);
  w.local.upNextCache = kept;
  await w.send({ type: 'set-tracker-url', url: 'tsuzuku.okanerturan.com/' });
  assert.equal(w.local.trackerUrl, 'https://tsuzuku.okanerturan.com');
  assert.equal(w.local.upNextCache, null);
  await w.send({ type: 'set-tracker-url', url: 'https://anime-tracker.okan.workers.dev' });
  assert.equal(w.local.trackerUrl, 'https://tsuzuku.okanerturan.com');
  await w.send({ type: 'set-tracker-url', url: 'localhost:8080' });
  assert.equal(w.local.trackerUrl, 'http://localhost:8080');
  // A saved old address is mapped on any read, not only at start.
  w.local.trackerUrl = 'https://anime-tracker.okan.workers.dev';
  assert.equal((await w.send({ type: 'get-state' })).trackerUrl, 'https://tsuzuku.okanerturan.com');
});

test('an episode tab is remembered across the worker being stopped, so leaving it still schedules the sync', async () => {
  const session = {};
  const before = startWorker({ local: { ...settled }, session });
  before.listeners.tabUpdated(7, { url: 'https://www.crunchyroll.com/watch/GABC123/some-episode' });
  await tick();
  assert.deepEqual(before.alarms, [], 'nothing yet: the episode just started');
  // Chrome stops the idle worker mid-episode; a new one starts for the next event.
  const after = startWorker({ local: { ...settled }, session });
  after.listeners.tabRemoved(7);
  await tick();
  assert.deepEqual(after.alarms, ['after-watch']);
  after.listeners.tabRemoved(8);
  await tick();
  assert.deepEqual(after.alarms, ['after-watch'], 'a tab that was never on an episode schedules nothing');
});

/**
 * A content script on a page: `deliver(data)` is the page posting a message to itself, `posted` what
 * the script posted back. `runtime.alive = false` models the extension having been reloaded since the
 * page opened, when every chrome.runtime call throws.
 */
function onPage(file, answer = () => ({}), alive = true) {
  const handlers = []; const posted = []; const sent = [];
  const window = { addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); }, postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) };
  const gone = () => { throw new Error('Extension context invalidated.'); };
  const runtime = { alive, lastError: undefined,
    getManifest() { if (!this.alive) gone(); return { version: '9.9.9' }; },
    sendMessage(msg, cb) { if (!this.alive) gone(); sent.push(msg.type); if (cb) cb(answer(msg)); } };
  const context = vm.createContext({ window, location: { origin: TRACKER }, chrome: { runtime }, console });
  vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), context, { filename: file });
  const deliver = (data) => { for (const fn of handlers) fn({ source: window, origin: TRACKER, data }); };
  return { deliver, posted, sent, runtime };
}

test('the tracker page\'s Sync now gets an answer even after the extension was reloaded under it', () => {
  const p = onPage('page-sync-bridge.js', (msg) => (msg.type === 'bridge-hello' ? { ok: true } : { ok: true, marked: 3 }));
  assert.deepEqual(p.posted, [{ source: 'anime-tracker-ext', type: 'hello', version: '9.9.9' }]);
  p.deliver({ source: 'anime-tracker-page', type: 'sync-now' });
  assert.deepEqual(p.posted.at(-1), { source: 'anime-tracker-ext', type: 'sync-done', ok: true, marked: 3 });
  p.runtime.alive = false;
  p.deliver({ source: 'anime-tracker-page', type: 'sync-now' });
  assert.deepEqual(p.posted.at(-1), { source: 'anime-tracker-ext', type: 'sync-done', ok: false, error: 'The extension was reloaded; refresh this page.' },
    'the page is told, so its button stops spinning');
  assert.doesNotThrow(() => p.deliver({ source: 'anime-tracker-page', type: 'ping' }));
  // A page opened while the extension is already gone: no error, no button.
  assert.doesNotThrow(() => onPage('page-sync-bridge.js', () => ({}), false));
});

test('the Crunchyroll page bridge: asks for a sync when one is due, hands a failed one to the page, and stays quiet once cut off', () => {
  const due = onPage('page-bridge.js', (msg) => (msg.type === 'cr-config' ? { shouldSync: true }
    : { ok: false, error: 'token 401', since: '2026-11-24T00:00:00Z', wantSeasons: ['SE9'], wantSeries: [] }));
  due.deliver({ source: 'anime-tracker-main', type: 'cr-config', clientId: 'cid' });
  assert.deepEqual(due.sent, ['cr-config', 'sync-now']);
  assert.deepEqual(due.posted, [{ source: 'anime-tracker-bridge', type: 'fetch-history', since: '2026-11-24T00:00:00Z', wantSeasons: ['SE9'], wantSeries: [] }]);

  const notDue = onPage('page-bridge.js', () => ({ shouldSync: false }));
  notDue.deliver({ source: 'anime-tracker-main', type: 'cr-config', clientId: 'cid' });
  assert.deepEqual(notDue.sent, ['cr-config'], 'no sync asked for');

  const trackerDown = onPage('page-bridge.js', (msg) => (msg.type === 'cr-config' ? { shouldSync: true } : { ok: false, error: "Can't reach the tracker at https://tracker.test." }));
  trackerDown.deliver({ source: 'anime-tracker-main', type: 'cr-config', clientId: 'cid' });
  assert.deepEqual(trackerDown.posted, [], 'the page can\'t help when it is the tracker that is unreachable');

  const cutOff = onPage('page-bridge.js');
  cutOff.runtime.alive = false;
  assert.doesNotThrow(() => cutOff.deliver({ source: 'anime-tracker-main', type: 'cr-config', clientId: 'cid' }));
  assert.doesNotThrow(() => cutOff.deliver({ source: 'anime-tracker-main', type: 'history-data', data: {} }));
  assert.deepEqual(cutOff.posted, []);
});
