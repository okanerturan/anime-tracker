'use strict';
// The catalog worker against a fake AniList (hosted mode, own process, throwaway data dir).
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-worker-'));
process.env.AUTH_MODE = 'accounts';
process.env.DATA_DIR = tmp;

const test = require('node:test');
const assert = require('node:assert');
const { catalogDb, db } = require('../server/db');
const worker = require('../server/catalog/worker');
const state = require('../server/state');

const reset = () => { catalogDb.exec("DELETE FROM catalog_jobs; DELETE FROM catalog_lease; DELETE FROM catalog_state WHERE key = 'catalogPaused'"); };
const media = (ids) => ({ status: 200, data: { Page: { media: ids.map((id) => ({ idMal: id })) } } });
const fakeAniList = (answer = (vars) => media(vars.ids)) => { const calls = []; return { calls, request: async (q, vars) => { calls.push(vars.ids); return answer(vars, calls.length); } }; };
const clock = (start = Date.parse('2026-05-01T00:00:00Z')) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

test('the same show asked for twice is one job with two waiting', () => {
  reset();
  worker.enqueue('full', { malId: 1 }); worker.enqueue('full', { malId: 1 }, { recency: 1 });
  const rows = catalogDb.prepare('SELECT key, waiting, priority FROM catalog_jobs').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].waiting, 2);
  assert.ok(rows[0].priority >= 10, 'recent plays raise priority');
});

test('25 queued shows go in one request; the 26th waits for the next', async () => {
  reset();
  for (let i = 1; i <= 26; i += 1) worker.enqueue('full', { malId: i });
  const fake = fakeAniList(); const stored = [];
  const w = worker.createWorker({ request: fake.request, store: (l) => stored.push(...l), fullQuery: 'q' });
  await w.tick();
  assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].length, 25);
  await w.tick();
  assert.equal(fake.calls.length, 2); assert.equal(fake.calls[1].length, 1);
  assert.equal(stored.length, 26);
  assert.equal(catalogDb.prepare("SELECT COUNT(*) n FROM catalog_jobs WHERE status = 'done'").get().n, 26);
});

test('only the lease holder works; another takes over once it expires', async () => {
  reset();
  for (let i = 1; i <= 3; i += 1) worker.enqueue('full', { malId: 100 + i });
  const c = clock(); const a = fakeAniList(); const b = fakeAniList();
  const wa = worker.createWorker({ holder: 'A', request: a.request, store: () => {}, fullQuery: 'q', now: c.now });
  const wb = worker.createWorker({ holder: 'B', request: b.request, store: () => {}, fullQuery: 'q', now: c.now });
  assert.equal((await wa.tick()).ran, true);
  worker.enqueue('full', { malId: 200 });
  assert.equal((await wb.tick()).why, 'lease', 'B waits while A holds the lease');
  c.advance(31e3); // A stopped renewing
  assert.equal((await wb.tick()).ran, true, 'B takes over');
  assert.equal(b.calls.length, 1);
});

test('never more than 30 requests a minute; Retry-After on 429 is honoured', async () => {
  reset();
  for (let i = 1; i <= 40 * 25; i += 1) worker.enqueue('full', { malId: 1000 + i });
  const c = clock(); const fake = fakeAniList();
  const w = worker.createWorker({ request: fake.request, store: () => {}, fullQuery: 'q', now: c.now });
  for (let i = 0; i < 40; i += 1) { await w.tick(); c.advance(1000); }
  assert.equal(fake.calls.length, worker.BUDGET, 'budget caps the minute');
  c.advance(60e3);
  await w.tick();
  assert.equal(fake.calls.length, worker.BUDGET + 1, 'a new minute, new budget');
  // 429 with Retry-After 20: nothing for 20 seconds.
  reset(); worker.enqueue('full', { malId: 5 });
  const limited = fakeAniList((vars, n) => (n === 1 ? { status: 429, retryAfter: 20 } : media(vars.ids)));
  const w2 = worker.createWorker({ request: limited.request, store: () => {}, fullQuery: 'q', now: c.now });
  await w2.tick(); c.advance(10e3);
  assert.equal((await w2.tick()).why, 'retry-after');
  c.advance(11e3);
  assert.equal((await w2.tick()).why, 'ok');
});

test('a job failing 3 times is quarantined with its last error', async () => {
  reset(); worker.enqueue('full', { malId: 7 });
  const c = clock();
  const fake = fakeAniList(() => ({ status: 502, errors: [{ message: 'Bad Gateway' }] }));
  const w = worker.createWorker({ request: fake.request, store: () => {}, fullQuery: 'q', now: c.now });
  for (let i = 0; i < 3; i += 1) { await w.tick(); c.advance(60e3); }
  const job = catalogDb.prepare("SELECT status, attempts, last_error FROM catalog_jobs WHERE key = 'full:7'").get();
  assert.deepEqual([job.status, job.attempts, job.last_error], ['quarantined', 3, 'Bad Gateway']);
});

test('a block pauses catalog updates (the app keeps serving) and retries after 6 hours', async () => {
  reset(); worker.enqueue('full', { malId: 9 });
  const c = clock();
  const fake = fakeAniList((vars, n) => (n === 1 ? { status: 403, errors: [{ message: 'You have been manually blocked' }] } : media(vars.ids)));
  const w = worker.createWorker({ request: fake.request, store: () => {}, fullQuery: 'q', now: c.now });
  assert.equal((await w.tick()).why, 'blocked');
  assert.match(state.get('catalogPaused').reason, /blocked/);
  c.advance(3600e3);
  assert.equal((await w.tick()).why, 'paused');
  c.advance(5 * 3600e3 + 1);
  assert.equal((await w.tick()).why, 'ok', 'retried after 6 hours');
});

test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('in hosted mode, asking for show details queues jobs instead of calling AniList', async () => {
  reset();
  const anilist = require('../server/sources/anilist');
  const realFetch = global.fetch; let called = 0;
  global.fetch = async () => { called += 1; throw new Error('no network in this test'); };
  try {
    const r = await anilist.fetchFullByMalIds([11, 12, 11]);
    assert.equal(r.queued, true); assert.equal(r.deferred, 2);
    assert.equal(called, 0, 'no AniList call from a request');
    assert.deepEqual(catalogDb.prepare("SELECT key FROM catalog_jobs ORDER BY key").all().map((x) => x.key), ['full:11', 'full:12']);
  } finally { global.fetch = realFetch; }
});

test('a 4,000-play first sync needs no network and finishes in under 5 seconds', async () => {
  reset();
  const { withAccount } = require('../server/db');
  const crunchyroll = require('../server/crunchyroll');
  const realFetch = global.fetch; let called = 0;
  global.fetch = async () => { called += 1; throw new Error('network is off for this test'); };
  try {
    const plays = [];
    for (let s = 0; s < 80; s += 1) for (let e = 1; e <= 50; e += 1) {
      plays.push({ id: `p-${s}-${e}`, episodeId: `E${s}x${e}`, seasonId: `GSEASON${s}`, seriesTitle: `Unknown Show ${s}`, seasonTitle: `Unknown Show ${s}`,
        episodeNumber: e, datePlayed: new Date(Date.now() - (s * 50 + e) * 60e3).toISOString(), fullyWatched: true, playhead: 1400, durationS: 1440 });
    }
    const t0 = Date.now(); let deferred = 0;
    await withAccount('20', async () => {
      for (let i = 0; i < plays.length; i += 500) deferred += (await crunchyroll.ingest(plays.slice(i, i + 500))).deferred || 0;
    });
    const ms = Date.now() - t0;
    assert.equal(called, 0, 'no network during ingest');
    assert.ok(ms < 5000, `took ${ms} ms`);
    assert.equal(withAccount('20', () => require('../server/db').db.prepare('SELECT COUNT(*) n FROM cr_history').get().n), 4000, 'every play stored');
    assert.equal(catalogDb.prepare("SELECT COUNT(*) n FROM catalog_jobs WHERE type = 'search'").get().n, 80, 'one search job per unknown season');
    assert.ok(deferred > 0, 'their plays wait for the search');
  } finally { global.fetch = realFetch; }
});

test('a waiting season is matched when its search finishes, and its plays apply without another sync', async () => {
  reset(); catalogDb.exec('DELETE FROM catalog_waiters');
  const { withAccount, db: adb } = require('../server/db');
  const crunchyroll = require('../server/crunchyroll');
  const node = (id, title, extra = {}) => ({ id: id + 90000, idMal: id, type: 'ANIME', format: 'TV', status: 'FINISHED', episodes: 12, title: { romaji: title, english: title }, startDate: { year: 2024, month: 1, day: 1 }, coverImage: {}, ...extra });
  const play = (seasonId, title, ep, n) => ({ id: `${seasonId}-${ep}`, episodeId: `${seasonId}E${ep}`, seasonId, seriesTitle: title, seasonTitle: title, episodeNumber: ep, datePlayed: new Date(Date.now() - n * 60e3).toISOString(), fullyWatched: true, playhead: 1400, durationS: 1440 });
  // Fake AniList: searches by title; full fetches with a prequel chain (Sequel Show -> Prequel Show).
  const fake = { calls: [], request: async (q, vars) => {
    fake.calls.push(vars.s ? `search:${vars.s}` : `full:${vars.ids.join(',')}`);
    if (vars.s) return { status: 200, data: { Page: { media: /Sequel/.test(vars.s) ? [node(5002, 'Sequel Show Season 2')] : [node(5001, 'Fresh Show')] } } };
    return { status: 200, data: { Page: { media: vars.ids.map((id) => (id === 5002
      ? { ...node(5002, 'Sequel Show Season 2'), relations: { edges: [{ relationType: 'PREQUEL', node: node(5000, 'Sequel Show') }] }, recommendations: { nodes: [] }, tags: [], genres: [], externalLinks: [] }
      : { ...node(id, 'Sequel Show'), relations: { edges: [] }, recommendations: { nodes: [] }, tags: [], genres: [], externalLinks: [] })) } } };
  } };
  await withAccount('30', () => crunchyroll.ingest([1, 2, 3].map((e) => play('GFRESH', 'Fresh Show', e, e)).concat([13, 14, 15].map((e) => play('GSEQ', 'Sequel Show Season 2', e, e + 10)))));
  const watched = (mal) => withAccount('30', () => adb.prepare('SELECT episode_number FROM episode_sync WHERE mal_id = ? AND watched = 1 ORDER BY 1').all(mal).map((r) => r.episode_number));
  assert.deepEqual(watched(5001), [], 'nothing applied before the search');
  const w = worker.createWorker({ request: fake.request });
  for (let i = 0; i < 8; i += 1) await w.tick();
  assert.deepEqual(watched(5001), [1, 2, 3], 'Fresh Show: matched and applied by the worker');
  assert.deepEqual(watched(5002), [1, 2, 3], 'Sequel Show S2: episodes 13-15 land as 1-3 once the prequel (12 eps) is known');
  assert.ok(fake.calls.includes('full:5002') && fake.calls.includes('full:5000'), `fetched what the offset needed: ${fake.calls.join(' ')}`);
  assert.equal(catalogDb.prepare('SELECT COUNT(*) n FROM catalog_waiters').get().n, 0, 'nothing left waiting');
});

test('claims: one report does nothing, agreement promotes, disagreement is flagged, AniList data wins', () => {
  const claims = require('../server/catalog/claims');
  const { withAccount } = require('../server/db');
  catalogDb.exec('DELETE FROM cr_series_claims; DELETE FROM cr_season_claims');
  catalogDb.prepare("INSERT OR REPLACE INTO media (mal_id, title, cr_series_id) VALUES (601, 'Claimed', NULL), (602, 'Known', 'GKNOWN')").run();
  const cr = () => catalogDb.prepare('SELECT cr_series_id FROM media WHERE mal_id = 601').get().cr_series_id;
  assert.equal(withAccount('a1', () => claims.claimSeries('GNEW', 601)).promoted, false);
  assert.equal(cr(), null, 'one account is not enough');
  assert.equal(withAccount('a2', () => claims.claimSeries('GNEW', 601)).promoted, true);
  assert.equal(cr(), 'GNEW', 'two agreeing accounts promote it');
  withAccount('a1', () => claims.claimSeries('GOTHER', 602)); withAccount('a2', () => claims.claimSeries('GOTHER', 602));
  assert.equal(catalogDb.prepare('SELECT cr_series_id FROM media WHERE mal_id = 602').get().cr_series_id, 'GKNOWN', 'never replaces what AniList gave');
  withAccount('a1', () => claims.claimSeries('GSPLIT', 601)); const split = withAccount('a2', () => claims.claimSeries('GSPLIT', 999));
  assert.equal(split.conflict, true);
  assert.ok(claims.reviewList().series.some((r) => r.id === 'GSPLIT'), 'disagreement goes to the review list');
  // Seasons: three agree → consensus; a dissent removes it.
  for (const a of ['s1', 's2']) withAccount(a, () => claims.claimSeason('GSEASONX', 700, 12));
  assert.equal(claims.seasonConsensus('GSEASONX'), null, 'two are not enough for a season');
  withAccount('s3', () => claims.claimSeason('GSEASONX', 700, 12));
  assert.deepEqual(claims.seasonConsensus('GSEASONX'), { mal: 700, offset: 12 });
  withAccount('s4', () => claims.claimSeason('GSEASONX', 701, 0));
  assert.equal(claims.seasonConsensus('GSEASONX'), null, 'a disagreement stops the consensus');
  claims.purge('season', 'GSEASONX');
  assert.equal(catalogDb.prepare("SELECT COUNT(*) n FROM cr_season_claims WHERE season_id = 'GSEASONX'").get().n, 0);
});

test('a season three accounts agreed on maps a new account\'s plays with zero searches', async () => {
  reset(); catalogDb.exec('DELETE FROM catalog_waiters; DELETE FROM cr_season_claims');
  const claims = require('../server/catalog/claims');
  const { withAccount, db: adb } = require('../server/db');
  const crunchyroll = require('../server/crunchyroll');
  catalogDb.prepare("INSERT OR REPLACE INTO media (mal_id, title, episodes, status) VALUES (800, 'Agreed Show S3', 12, 'FINISHED')").run();
  for (const a of ['c1', 'c2', 'c3']) withAccount(a, () => claims.claimSeason('GAGREED', 800, 24));
  const plays = [25, 26].map((e) => ({ id: `ag-${e}`, episodeId: `AG${e}`, seasonId: 'GAGREED', seriesTitle: 'Agreed Show', seasonTitle: 'Agreed Show Season 3', episodeNumber: e, datePlayed: new Date(Date.now() - e * 60e3).toISOString(), fullyWatched: true, playhead: 1400, durationS: 1440 }));
  await withAccount('newcomer', () => crunchyroll.ingest(plays));
  const watched = withAccount('newcomer', () => adb.prepare('SELECT episode_number FROM episode_sync WHERE mal_id = 800 AND watched = 1 ORDER BY 1').all().map((r) => r.episode_number));
  assert.deepEqual(watched, [1, 2], 'Crunchyroll 25-26 land as 1-2 via the agreed offset');
  assert.equal(catalogDb.prepare("SELECT COUNT(*) n FROM catalog_jobs WHERE type = 'search'").get().n, 0, 'no search needed');
});

test('fixing a season on the Sync page counts as that account\'s vote', async () => {
  catalogDb.exec('DELETE FROM cr_season_claims');
  const { withAccount } = require('../server/db');
  const crunchyroll = require('../server/crunchyroll');
  await withAccount('fixer', () => crunchyroll.remapSeason('GFIXED', 950, 12));
  const vote = catalogDb.prepare("SELECT mal_id, ep_offset, account_id FROM cr_season_claims WHERE season_id = 'GFIXED'").get();
  assert.deepEqual(vote, { mal_id: 950, ep_offset: 12, account_id: 'fixer' });
});

test('a known Crunchyroll series maps its third season by position, with zero searches', async () => {
  reset(); catalogDb.exec('DELETE FROM catalog_waiters; DELETE FROM cr_season_claims');
  const { withAccount, db: adb } = require('../server/db');
  const crunchyroll = require('../server/crunchyroll');
  const ins = catalogDb.prepare("INSERT OR REPLACE INTO media (mal_id, title, format, status, episodes, start_date, cr_series_id, is_full) VALUES (?, ?, 'TV', 'FINISHED', 12, ?, 'GREVIDX', 1)");
  ins.run(820, 'Long Runner', '2018-01-01'); ins.run(821, 'Long Runner II', '2020-01-01'); ins.run(822, 'Long Runner III', '2022-01-01');
  const plays = [1, 2].map((e) => ({ id: `rv-${e}`, episodeId: `RV${e}`, seriesId: 'GREVIDX', seasonId: 'GREVS3', seriesTitle: 'Long Runner', seasonTitle: 'Long Runner Season 3', seasonNumber: 3, episodeNumber: e, datePlayed: new Date(Date.now() - e * 60e3).toISOString(), fullyWatched: true, playhead: 1400, durationS: 1440 }));
  await withAccount('rv', () => crunchyroll.ingest(plays));
  const watched = withAccount('rv', () => adb.prepare('SELECT episode_number FROM episode_sync WHERE mal_id = 822 AND watched = 1 ORDER BY 1').all().map((r) => r.episode_number));
  assert.deepEqual(watched, [1, 2], 'season 3 of the series is its third TV entry');
  assert.equal(catalogDb.prepare("SELECT COUNT(*) n FROM catalog_jobs WHERE type = 'search'").get().n, 0, 'no search');
  assert.equal(withAccount('rv', () => adb.prepare("SELECT source FROM cr_season_map WHERE season_id = 'GREVS3'").get().source), 'cr-series');
});

test('the scheduled cycle runs for every account, each in its own file, and only once at a time', async () => {
  reset(); catalogDb.exec("DELETE FROM catalog_lease");
  const { withAccount, db: adb } = require('../server/db');
  const scheduler = require('../server/catalog/scheduler');
  const realFetch = global.fetch; global.fetch = async () => { throw new Error('offline'); };
  try {
    // Two accounts, each with an unaired sequel that an old import marked watched (the repair's job),
    // and a show whose metadata is stale (queued for the worker).
    catalogDb.prepare("INSERT OR REPLACE INTO media (mal_id, title, status, fetched_at, is_full) VALUES (901, 'Unaired S2', 'NOT_YET_RELEASED', CURRENT_TIMESTAMP, 1), (902, 'Stale Show', 'RELEASING', '2020-01-01 00:00:00', 1)").run();
    const old = new Date(Date.now() - 400 * 86400e3).toISOString();
    for (const a of ['k1', 'k2']) withAccount(a, () => {
      adb.prepare("INSERT OR REPLACE INTO anime (mal_id, title) VALUES (901, 'Unaired S2'), (902, 'Stale Show')").run();
      adb.prepare('INSERT OR IGNORE INTO watchlist (mal_id) VALUES (901), (902)').run();
      adb.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, watched, watched_at) VALUES (901, 1, 1, ?)').run(old);
    });
    const first = await scheduler.runAll({ accountIds: ['k1', 'k2'] });
    assert.equal(first.ran, 2);
    for (const a of ['k1', 'k2']) assert.equal(withAccount(a, () => adb.prepare('SELECT watched FROM episode_sync WHERE mal_id = 901').get().watched), 0, `${a} repaired in its own file`);
    assert.ok(catalogDb.prepare("SELECT COUNT(*) n FROM catalog_jobs WHERE key = 'full:902'").get().n === 1, 'stale metadata queued once for both accounts');
    const again = await scheduler.runAll({ accountIds: ['k1', 'k2'], now: Date.now() });
    assert.equal(again.ran, 2, 'the same process can run its next pass');
    catalogDb.prepare("UPDATE catalog_lease SET holder = 'someone-else', expires_at = ? WHERE name = 'refresh-cycle'").run(Date.now() + 3600e3);
    assert.equal((await scheduler.runAll({ accountIds: ['k1'] })).skipped, 'lease', 'another holder blocks a second run');
  } finally { global.fetch = realFetch; }
});

test('hosted images go to R2 once under img/<sha1>, and a second request does not download again', async () => {
  const images = require('../server/images');
  const r2 = require('../server/catalog/r2');
  Object.assign(process.env, { R2_ENDPOINT: 'https://fake-s3.test', R2_BUCKET: 'anime-tracker', R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret' });
  r2.reset();
  const stored = new Map(); const calls = { image: 0, put: 0, signed: 0 };
  const realFetch = global.fetch;
  global.fetch = async (input, opts = {}) => {
    const req = input instanceof Request ? input : new Request(input, opts);
    const url = req.url;
    if (url.startsWith('https://fake-s3.test/')) {
      if (/AWS4-HMAC-SHA256 Credential=test-key\//.test(req.headers.get('authorization') || '')) calls.signed += 1;
      const key = decodeURIComponent(url.replace('https://fake-s3.test/anime-tracker/', ''));
      if (req.method === 'PUT') { calls.put += 1; stored.set(key, { body: Buffer.from(await req.arrayBuffer()), type: req.headers.get('content-type') }); return new Response(null, { status: 200 }); }
      const hit = stored.get(key);
      return hit ? new Response(hit.body, { status: 200, headers: { 'content-type': hit.type } }) : new Response(null, { status: 404 });
    }
    if (url.startsWith('https://s4.anilist.co/')) { calls.image += 1; return new Response(Buffer.from('fake-jpeg-bytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } }); }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const poster = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test-poster.jpg';
    const a = await images.ensure(poster);
    const b = await images.ensure(poster);
    const key = `img/${require('crypto').createHash('sha1').update(poster).digest('hex')}`;
    assert.equal(a.file, `r2:${key}`); assert.equal(b.file, `r2:${key}`);
    assert.equal(calls.image, 1, 'downloaded once'); assert.equal(calls.put, 1, 'written to R2 once');
    assert.ok(calls.signed >= 1, 'requests to R2 are signed (SigV4)');
    assert.equal(stored.get(key).type, 'image/jpeg');
  } finally {
    global.fetch = realFetch;
    for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete process.env[k];
    r2.reset();
  }
});
