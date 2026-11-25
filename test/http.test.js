'use strict';
// HTTP smoke test: every view's API answers on an empty database, writes need the client header.
process.env.ANIME_DB = ':memory:';
process.env.TIMEZONE = 'UTC';
const realFetch = global.fetch;
global.fetch = async () => { throw new Error('network disabled in tests'); };

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const routes = require('../server/routes');
const { serveStatic } = require('../server/static');

let base;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await routes.handle(req, res, url)) return;
  serveStatic(req, res, url.pathname);
});

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); })));
test.after(() => new Promise((resolve) => server.close(resolve)));

const get = (path) => realFetch(base + path);
const post = (path, body, headers = { 'X-Tracker-Client': 'app' }) => realFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('every view loads on an empty library', async () => {
  for (const path of ['/api/up-next', '/api/watchlist', '/api/study', '/api/history', '/api/library/suspicious', '/api/crunchyroll/status', '/api/sync-status', '/api/stats', '/api/recommendations', '/api/anilist/relay']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    await res.json();
  }
});

test('the empty Up Next has every shelf as an empty list', async () => {
  const d = await (await get('/api/up-next')).json();
  for (const k of ['continueWatching', 'newSeasons', 'stalled', 'onHold', 'recentlyFinished', 'comingSoon']) assert.deepEqual(d[k], [], k);
});

test('writes without the client header are refused', async () => {
  const res = await post('/api/watchlist/add', { anime: { malId: 1, title: 'x' } }, {});
  assert.equal(res.status, 403);
});

test('a show can be added, rated, held and removed through the API', async () => {
  assert.equal((await post('/api/watchlist/add', { anime: { malId: 7, title: 'Test Show', totalEpisodes: 12 } })).status, 200);
  assert.equal((await post('/api/anime/rating', { malId: 7, rating: 4 })).status, 200);
  assert.equal((await post('/api/anime/list-status-batch', { malIds: [7], status: 'on_hold' })).status, 200);
  const row = (await (await get('/api/watchlist')).json()).find((x) => x.malId === 7);
  assert.equal(row.rating, 4);
  assert.equal(row.listStatus, 'on_hold');
  assert.equal(row.synopsis, undefined, 'the list leaves synopses out');
  assert.equal((await post('/api/watchlist/remove', { malId: 7 })).status, 200);
  assert.equal((await (await get('/api/watchlist')).json()).some((x) => x.malId === 7), false);
});

test('bad input gets a 4xx with a message, not a crash', async () => {
  const bad = await post('/api/anime/rating', { malId: 99999, rating: 3 });
  assert.equal(bad.status, 404);
  assert.match((await bad.json()).error, /not in library/);
  const missing = await get('/api/anime?malId=424242');
  assert.equal(missing.status, 404);
});

test('the app shell and its scripts are served', async () => {
  for (const path of ['/', '/styles.css', '/js/main.js', '/js/views/upnext.js', '/manifest.webmanifest', '/sw.js']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
  }
});

test('history exports as a CSV download', async () => {
  const res = await get('/api/history.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="crunchyroll-history-/);
  assert.match(await res.text(), /^﻿?date_played,show,/);
});

test('the library exports as a CSV download', async () => {
  const res = await get('/api/library.csv');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^﻿?title,english_title,format,/);
});

test('seasonal scores the cached season and leaves out sequels of unwatched shows', async () => {
  // Prime the 12-hour cache so the test never reaches AniList.
  const m = new Date().getUTCMonth();
  const season = ['WINTER', 'SPRING', 'SUMMER', 'FALL'][Math.floor(m / 3)];
  const show = (idMal, title, extra = {}) => ({ id: idMal, idMal, title: { english: title }, format: 'TV', status: 'RELEASING', episodes: 12, genres: ['Action'], averageScore: 70, tags: [], externalLinks: [], relations: { edges: [] }, ...extra });
  require('../server/state').set(`seasonal:${season}:${new Date().getUTCFullYear()}`, { list: [
    show(9001, 'Fresh Show'),
    show(9002, 'Sequel Of Something', { relations: { edges: [{ relationType: 'PREQUEL', node: { idMal: 8000 } }] } })
  ] });
  const res = await get('/api/seasonal');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.season, season);
  assert.deepEqual(body.items.map((x) => x.title), ['Fresh Show']);
  assert.ok(body.items[0].match >= 0 && body.items[0].match <= 100);
});

test('CSV cells cannot start a spreadsheet formula', async () => {
  const { csvCell } = require('../server/routes');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-Prologue-'), "'-Prologue-");
  assert.equal(csvCell('Plain'), 'Plain');
});

test('stats are numbers (never null) on an empty library, so the Sync page can render', async () => {
  const s = await (await get('/api/stats')).json();
  for (const v of [s.library, s.episodes.n, s.episodes.w, s.episodes.i, s.images.cached]) assert.equal(typeof v, 'number');
});

test('the airing calendar is served only for the right token', async () => {
  const { path } = await (await get('/api/calendar')).json();
  assert.match(path, /^\/calendar\/[a-f0-9]{48}\.ics$/);
  const ok = await get(path);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/calendar/);
  const body = await ok.text();
  assert.match(body, /^BEGIN:VCALENDAR\r\n/);
  assert.equal((await get('/calendar/' + 'a'.repeat(48) + '.ics')).status, 404);
  const reset = await (await post('/api/calendar/reset', {})).json();
  assert.notEqual(reset.path, path);
  assert.equal((await get(path)).status, 404, 'the old link stops working');
});

test('the sync status the website asks for leaves out what only the extension fetches next', async () => {
  const { db } = require('../server/db');
  db.prepare("INSERT OR REPLACE INTO media (mal_id, title, episodes, status, format, is_full) VALUES (9911, 'Airing Show', 12, 'RELEASING', 'TV', 1)").run();
  db.prepare(`INSERT OR REPLACE INTO cr_season_map (season_id, ep_from, ep_to, mal_id, ep_offset, source, series_title, season_title, needs_review)
    VALUES ('GSWANT1', 1, 999, 9911, 0, 'auto', 'Airing Show', 'Season 1', 0)`).run();
  db.prepare(`INSERT OR REPLACE INTO cr_history (episode_id, series_id, series_title, season_id, season_title, season_number, episode_number,
      episode_title, duration_s, playhead, fully_watched, date_played, applied)
    VALUES ('GEWANT1', 'GSER1', 'Airing Show', 'GSWANT1', 'Season 1', 1, 1, 'One', 1440, 1440, 1, '2026-11-20T10:00:00Z', 1)`).run();
  const full = await (await get('/api/crunchyroll/status')).json();
  const page = await (await get('/api/crunchyroll/status?for=page')).json();
  assert.ok(full.wantSeasons.includes('GSWANT1'), 'the extension is told which season lists to fetch');
  assert.deepEqual([page.wantSeasons, page.wantSeriesSeasons, page.wantSeries], [[], [], []]);
  for (const k of ['rows', 'latestPlayed', 'unapplied']) assert.equal(page[k], full[k], k);
  assert.deepEqual(page.lastSync, full.lastSync);
  assert.deepEqual(page.needsReview, full.needsReview);
});
