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
