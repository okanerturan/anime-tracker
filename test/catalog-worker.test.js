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
