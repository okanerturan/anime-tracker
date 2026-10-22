'use strict';
// Core behaviour tests: run with `npm test`. In-memory database, no network.
process.env.ANIME_DB = ':memory:';
process.env.TIMEZONE = 'UTC';
global.fetch = async () => { throw new Error('network disabled in tests'); };

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../server/db');
const { isWatchedPlay, normalizeTitle } = require('../server/util');
const crlinks = require('../server/crlinks');
const library = require('../server/library');
const crunchyroll = require('../server/crunchyroll');
const insights = require('../server/insights');
const anilist = require('../server/sources/anilist');
const appState = require('../server/state');

const media = (row) => db.prepare(`INSERT OR REPLACE INTO media (mal_id, title, title_english, format, status, episodes, start_date, is_full, duration, external_links, genres)
  VALUES (@mal_id, @title, @title_english, @format, @status, @episodes, @start_date, 1, 24, @external_links, @genres)`).run({
  title_english: null, format: 'TV', status: 'FINISHED', episodes: 12, start_date: '2020-01-01', external_links: '[]', genres: '["Action"]', ...row });
const addShow = (malId, title, extra = {}) => { media({ mal_id: malId, title, ...extra }); library.addToLibrary({ malId, title, titleEnglish: title, totalEpisodes: extra.episodes ?? 12 }); };
const relate = (a, b, type) => db.prepare('INSERT OR IGNORE INTO media_relation (mal_id, related_mal_id, relation_type) VALUES (?, ?, ?)').run(a, b, type);
const rule = (seasonId, malId, offset = 0) => db.prepare(`INSERT OR REPLACE INTO cr_season_map (season_id, ep_from, ep_to, mal_id, ep_offset, source, series_title, season_title, needs_review)
  VALUES (?, 0, 100000, ?, ?, 'test', 'S', 'S', 0)`).run(seasonId, malId, offset);
const play = (o) => ({ episodeId: o.id, seriesId: o.series || 'GSERIES', seriesTitle: o.seriesTitle || 'Series', seasonId: o.season, seasonTitle: o.seasonTitle || 'Season 1',
  seasonNumber: o.seasonNumber ?? 1, episodeNumber: o.ep, episodeTitle: `Ep ${o.ep}`, durationS: 1440, playhead: o.playhead ?? 1440,
  fullyWatched: o.full ?? true, datePlayed: o.at || '2026-10-01T20:00:00Z' });
const watched = (malId) => db.prepare('SELECT episode_number AS n FROM episode_sync WHERE mal_id = ? AND watched = 1 ORDER BY 1').all(malId).map((r) => r.n);

test('a play counts as watched when fully watched or at 80% of its length', () => {
  assert.equal(isWatchedPlay({ fullyWatched: true, playhead: 0, durationS: 1440 }), true);
  assert.equal(isWatchedPlay({ fullyWatched: false, playhead: 1152, durationS: 1440 }), true);
  assert.equal(isWatchedPlay({ fullyWatched: false, playhead: 950, durationS: 1440 }), false);
  assert.equal(isWatchedPlay({ fullyWatched: false, playhead: 500, durationS: 0 }), false);
});

test('titles normalise for matching', () => {
  assert.equal(normalizeTitle('Re:ZERO -Starting Life-'), 're zero starting life');
  assert.equal(normalizeTitle("JoJo's Bizarre Adventure"), normalizeTitle('JoJo’s Bizarre Adventure'));
  assert.equal(normalizeTitle('Frieren: Beyond Journey’s End'), normalizeTitle('frieren beyond journeys end'));
});

test('Crunchyroll search queries fit the 30-character box and keep real titles', () => {
  assert.equal(crlinks.searchQuery('Ranking of Kings: The Treasure Chest of Courage'), 'Ranking of Kings');
  assert.equal(crlinks.searchQuery('HELL MODE: The Hardcore Gamer Dominates Season 2'), 'HELL MODE');
  assert.equal(crlinks.searchQuery('The Laid-Off Cheat-Granting Mage Enjoys a Second Lease on Life'), 'The Laid-Off Cheat-Granting');
  assert.ok(crlinks.searchQuery('Re:ZERO -Starting Life in Another World- Season 3').startsWith('Re:ZERO'));
  for (const t of ['A very long title that keeps going and going and going', 'Mushoku Tensei: Jobless Reincarnation Season 2 Part 2']) assert.ok(crlinks.searchQuery(t).length <= 30);
});

test('Crunchyroll series matches by exact title or series-title prefix, else records "not on Crunchyroll"', () => {
  addShow(2904, 'Code Geass: Lelouch of the Rebellion R2', { title_english: 'Code Geass: Lelouch of the Rebellion R2' });
  addShow(11061, 'Hunter x Hunter (2011)', { title_english: 'Hunter x Hunter (2011)' });
  const r = crlinks.applyResults([
    { malId: 2904, candidates: [{ id: 'GY2P9ED0Y', title: 'Code Geass' }, { id: 'X', title: 'BARTENDER Glass of God' }] },
    { malId: 11061, candidates: [{ id: 'GJ0H7Q5X9', title: 'The Fire Hunter' }] }
  ]);
  assert.deepEqual(r, { found: 1, missing: 1 });
  assert.equal(crlinks.seriesFor(2904).id, 'GY2P9ED0Y');
  assert.equal(crlinks.seriesFor(11061), null);
  assert.equal(crlinks.notOnCrunchyroll(11061), true);
});

test('a sequel borrows its prequel season\'s Crunchyroll series page', () => {
  addShow(40834, 'Ousama Ranking', { external_links: JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/G79H23W70/ranking-of-kings' }]) });
  media({ mal_id: 52657, title: 'Ousama Ranking: Yuuki no Takarabako' });
  relate(40834, 52657, 'SEQUEL');
  assert.equal(crlinks.seriesFor(52657).id, 'G79H23W70');
  assert.equal(crlinks.seriesFor(52657).source, 'franchise');
});

test('episodes past a finished season roll into its sequel', () => {
  media({ mal_id: 100, title: 'Show S2 Part 1', episodes: 12, status: 'FINISHED' });
  media({ mal_id: 101, title: 'Show S2 Part 2', episodes: 12, status: 'FINISHED', start_date: '2021-01-01' });
  relate(100, 101, 'SEQUEL');
  assert.deepEqual(library.resolveOverflow(100, 14), { malId: 101, episodeNumber: 2 });
  assert.deepEqual(library.resolveOverflow(100, 12), { malId: 100, episodeNumber: 12 });
});

test('ingest marks finished plays, keeps partial ones pending, and ignores plays before the premiere', async () => {
  addShow(200, 'Ingest Show', { start_date: '2026-09-01', episodes: 12 });
  rule('GSEASON200', 200);
  const summary = await crunchyroll.ingest([
    play({ id: 'E1', season: 'GSEASON200', ep: 1 }),
    play({ id: 'E2', season: 'GSEASON200', ep: 2, full: false, playhead: 700 }),
    play({ id: 'E3', season: 'GSEASON200', ep: 3, at: '2019-01-01T00:00:00Z' })
  ], { source: 'test' });
  assert.deepEqual(watched(200), [1]);
  assert.equal(summary.partial, 1);
});

test('the same episode in several dubs counts once in the study', async () => {
  addShow(300, 'Dubbed Show', { start_date: '2020-01-01' });
  rule('GJA', 300); rule('GEN', 300); rule('GDE', 300);
  await crunchyroll.ingest(['GJA', 'GEN', 'GDE'].flatMap((season, i) => [1, 2].map((ep) => play({ id: `${season}-${ep}`, season, ep, seriesTitle: 'Dubbed Show', seasonTitle: `Season 1 ${season}`, at: `2026-10-0${2 + i}T2${ep}:00:00Z` }))), { source: 'test' });
  const s = insights.study();
  const show = s.topShows.find((t) => t.malId === 300);
  assert.equal(show.episodes, 2);
});

test('list status and rating validate their input', () => {
  addShow(400, 'Rated Show');
  assert.throws(() => library.setListStatus(400, 'bogus'), /status/);
  assert.throws(() => library.setRating(400, 9), /rating/);
  library.setListStatus(400, 'dropped');
  library.setRating(400, 5);
  const row = library.getWatchlist('title_asc').find((x) => x.malId === 400);
  assert.equal(row.listStatus, 'dropped');
  assert.equal(row.rating, 5);
  assert.equal(library.reactivate([400]), 1);
});

test('an unreleased show cannot be marked as watched elsewhere', () => {
  media({ mal_id: 500, title: 'Future Season', status: 'NOT_YET_RELEASED', episodes: null, start_date: null });
  assert.throws(() => library.markWatchedElsewhere(500), /hasn't aired yet/);
  assert.equal(library.isInLibrary(500), false);
});

test('while AniList blocks the server, requests are queued for the browser relay and answered from it', async () => {
  appState.set('anilistBlocked', { until: Date.now() + 3600e3, message: 'test' });
  await assert.rejects(anilist.search('frieren', 3), (err) => err.code === 'anilist_blocked');
  const { jobs } = anilist.takeRelayJobs();
  const job = jobs.find((j) => j.variables.s === 'frieren');
  assert.ok(job);
  anilist.applyRelayAnswers([{ id: job.id, data: { Page: { media: [{ id: 1, idMal: 52991, title: { romaji: 'Sousou no Frieren' } }] } } }]);
  const found = await anilist.search('frieren', 3);
  assert.equal(found[0].idMal, 52991);

  const deferred = await anilist.fetchFullByMalIds([52991]);
  assert.equal(deferred.deferred, 1);
  assert.ok(anilist.takeRelayJobs().jobs.some((j) => j.id === 'full:52991'));
  appState.set('anilistBlocked', { until: 0 });
});

test('a Crunchyroll series page maps to your seasons, with furthest-episode progress and the next season', async () => {
  addShow(600, 'Series S1', { episodes: 4, start_date: '2020-01-01' });
  addShow(601, 'Series S2', { episodes: 2, start_date: '2021-01-01' });
  media({ mal_id: 602, title: 'Series S3', episodes: 12, start_date: '2026-01-01' });
  relate(600, 601, 'SEQUEL'); relate(601, 602, 'SEQUEL');
  rule('GS600', 600); rule('GS601', 601);
  // Episode 3 of S1 is missing from history, but the finale and 3 of 4 episodes were watched: 4/4.
  await crunchyroll.ingest([
    play({ id: 'X1', series: 'GSERIES600', season: 'GS600', ep: 1, at: '2026-10-01T10:00:00Z' }),
    play({ id: 'X2', series: 'GSERIES600', season: 'GS600', ep: 2, at: '2026-10-01T10:30:00Z' }),
    play({ id: 'X4', series: 'GSERIES600', season: 'GS600', ep: 4, at: '2026-10-01T11:00:00Z' }),
    play({ id: 'Y1', series: 'GSERIES600', season: 'GS601', ep: 1, at: '2026-10-02T10:00:00Z' }),
    play({ id: 'Y2', series: 'GSERIES600', season: 'GS601', ep: 2, at: '2026-10-02T11:00:00Z' })
  ], { source: 'test' });
  const info = crlinks.showsForSeries('GSERIES600');
  assert.deepEqual(info.shows.map((s) => [s.malId, s.watched, s.aired]), [[600, 4, 4], [601, 2, 2]]);
  assert.equal(info.nextSeason.malId, 602);
  assert.deepEqual(crlinks.showsForSeries('bad id!'), { shows: [], nextSeason: null });
});

test('progress forgives history gaps only when the finale and most episodes were watched', () => {
  assert.equal(library.progressOf(18, 24, 24), 24); // finished, a few gaps
  assert.equal(library.progressOf(8, 12, 12), 8);   // finale ticked but only 8 of 12: keep the count
  assert.equal(library.progressOf(1, 20, 20), 1);   // only the last episode: probably noise
  assert.equal(library.progressOf(5, 5, 12), 5);    // still watching
});

test('a finale ticked with most episodes unwatched is flagged as odd progress', async () => {
  addShow(700, 'Odd Show', { episodes: 12, start_date: '2020-01-01' });
  rule('GS700', 700);
  await crunchyroll.ingest([play({ id: 'O12', series: 'GSERIES700', season: 'GS700', ep: 12 })], { source: 'test' });
  assert.ok(library.suspiciousProgress().some((x) => x.malId === 700));
  library.setWatched(700, 12, false);
  assert.ok(!library.suspiciousProgress().some((x) => x.malId === 700));
});

test('a MyAnimeList export imports progress, ratings and list states without lowering existing progress', () => {
  addShow(800, 'Already Here', { episodes: 12 });
  library.markWatchedElsewhere(800); // 12/12 already
  const r = library.importMalList([
    { malId: 800, title: 'Already Here', episodes: 12, watched: 3, score: 8, status: 'watching' },
    { malId: 801, title: 'New Finished', episodes: 4, watched: 4, score: 9, status: 'completed' },
    { malId: 802, title: 'New Dropped', episodes: 24, watched: 2, score: 3, status: 'dropped' },
    { malId: 803, title: 'Someday', episodes: 12, watched: 0, score: 0, status: 'plan' }
  ]);
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);
  assert.deepEqual(watched(800).length, 12, 'existing progress is never lowered');
  assert.deepEqual(watched(801), [1, 2, 3, 4]);
  const lib = library.getWatchlist('title_asc');
  assert.equal(lib.find((x) => x.malId === 801).rating, 5);
  assert.equal(lib.find((x) => x.malId === 802).listStatus, 'dropped');
  assert.equal(library.isInLibrary(803), false);
});

test('importing with a list date keeps that date; without one the date stays unknown', () => {
  library.importMalList([
    { malId: 810, title: 'Dated', episodes: 2, watched: 2, status: 'completed', watchedAt: '2024-03-09' },
    { malId: 811, title: 'Undated', episodes: 2, watched: 2, status: 'completed', watchedAt: '0000-00-00' }
  ]);
  const at = (id) => db.prepare('SELECT MAX(watched_at) AS a FROM episode_sync WHERE mal_id = ? AND watched = 1').get(id).a;
  assert.equal(at(810), '2024-03-09T12:00:00Z');
  assert.equal(at(811), null);
});

test('watched-through reports the episodes it changed so Undo reverts exactly those', () => {
  library.addToLibrary({ malId: 820, title: 'Gappy', totalEpisodes: 6 });
  const ins = db.prepare(`INSERT INTO episode_sync (mal_id, episode_number, season, title, url, watched, updated_at) VALUES (?, ?, 1, '', '', ?, CURRENT_TIMESTAMP)`);
  for (let n = 1; n <= 6; n += 1) ins.run(820, n, n === 1 || n === 3 ? 1 : 0);
  const r = library.markWatchedThrough(820, 4);
  assert.deepEqual(r.episodes, [2, 4]);
  library.unmarkEpisodes(820, r.episodes);
  assert.deepEqual(watched(820), [1, 3]);
});

test('fixing a mis-guessed season clears what the wrong show got from it', async () => {
  addShow(830, 'Wrong Guess', { start_date: '2020-01-01', episodes: 12 });
  addShow(831, 'Right Show', { start_date: '2020-01-01', episodes: 12 });
  rule('GS830', 830);
  await crunchyroll.ingest([1, 2, 3].map((ep) => play({ id: `R${ep}`, season: 'GS830', ep })), { source: 'test' });
  assert.deepEqual(watched(830), [1, 2, 3]);
  await crunchyroll.remapSeason('GS830', 831, 0);
  assert.deepEqual(watched(831), [1, 2, 3]);
  assert.deepEqual(watched(830), [], 'the wrong show keeps nothing from that season');
  assert.equal(library.isInLibrary(830), false, 'and leaves the library when nothing else of it remains');
});

test('alternate titles are stored (Latin-alphabet ones only) and returned with the library', () => {
  library.addToLibrary({ malId: 840, title: 'Jujutsu Kaisen Test', totalEpisodes: 24 });
  anilist.storeFull([{ id: 840, idMal: 840, type: 'ANIME', title: { romaji: 'Jujutsu Kaisen Test' }, synonyms: ['JJK', 'Sorcery Fight', '咒术回战', 'Магическая битва'], genres: [], tags: [], externalLinks: [], relations: { edges: [] }, recommendations: { nodes: [] } }]);
  const x = library.getWatchlist('title_asc').find((s) => s.malId === 840);
  assert.deepEqual(x.synonyms, ['JJK', 'Sorcery Fight']);
});

test('seasons linked as sequel and prequel share a series id in the library', () => {
  for (const [id, t] of [[850, 'Series S1'], [851, 'Series S2'], [852, 'Series S3'], [853, 'Unrelated']]) library.addToLibrary({ malId: id, title: t, totalEpisodes: 12 });
  relate(851, 850, 'PREQUEL'); relate(851, 852, 'SEQUEL');
  const by = Object.fromEntries(library.getWatchlist('title_asc').filter((x) => x.malId >= 850 && x.malId <= 853).map((x) => [x.malId, x.series]));
  assert.equal(by[850], 850); assert.equal(by[851], 850); assert.equal(by[852], 850); assert.equal(by[853], 853);
});

test('removing a show and undoing it brings back its rating and list state', () => {
  library.addToLibrary({ malId: 860, title: 'Rated Show', totalEpisodes: 12 });
  library.setRating(860, 4);
  library.setListStatus(860, 'on_hold');
  const removed = library.removeFromLibrary(860);
  assert.equal(library.isInLibrary(860), false);
  library.restoreToLibrary(removed);
  const x = library.getWatchlist('title_asc').find((s) => s.malId === 860);
  assert.equal(x.rating, 4);
  assert.equal(x.listStatus, 'on_hold');
});

test('the study has a year in review with top shows', () => {
  const s = insights.study();
  assert.ok(Array.isArray(s.years) && s.years.length >= 1);
  const y = s.years[0];
  assert.ok(y.year && y.episodes > 0 && Array.isArray(y.top) && y.top.length >= 1);
  assert.ok(y.top[0].episodes >= (y.top[1]?.episodes ?? 0));
});

test('a library show knows its released sequel until you start watching it', () => {
  library.addToLibrary({ malId: 870, title: 'First Season', totalEpisodes: 12 });
  media({ mal_id: 871, title: 'Second Season', status: 'FINISHED', format: 'TV', episodes: 12, start_date: '2024-01-01' });
  relate(870, 871, 'SEQUEL');
  const seq = () => library.getWatchlist('title_asc').find((x) => x.malId === 870).sequel;
  assert.equal(seq()?.malId, 871);
  library.addToLibrary({ malId: 871, title: 'Second Season', totalEpisodes: 12 });
  db.prepare(`INSERT INTO episode_sync (mal_id, episode_number, season, title, url, watched, updated_at) VALUES (871, 1, 1, '', '', 1, CURRENT_TIMESTAMP)`).run();
  assert.equal(seq(), null);
});

test('calendar text is escaped and folded per RFC 5545 without splitting characters', () => {
  const { esc, fold } = require('../server/calendar');
  assert.equal(esc('Steins;Gate, part 1'), 'Steins\\;Gate\\, part 1');
  const bytes = (s) => new TextEncoder().encode(s).length;
  const out = fold(`SUMMARY:${'a'.repeat(64)}😀 and more text to fold`);
  for (const line of out.split('\r\n')) assert.ok(bytes(line) <= 75);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'no broken surrogate pair');
  assert.equal(out.replace(/\r\n /g, ''), `SUMMARY:${'a'.repeat(64)}😀 and more text to fold`);
});

test('continue-with skips seasons you finished, and the series time left adds later seasons', () => {
  library.addToLibrary({ malId: 880, title: 'Saga S1', totalEpisodes: 2 });
  library.addToLibrary({ malId: 881, title: 'Saga S2', totalEpisodes: 2 });
  media({ mal_id: 880, title: 'Saga S1', episodes: 2, start_date: '2020-01-01' });
  media({ mal_id: 881, title: 'Saga S2', episodes: 2, start_date: '2021-01-01' });
  media({ mal_id: 882, title: 'Saga S3', episodes: 3, start_date: '2022-01-01' });
  relate(880, 881, 'SEQUEL'); relate(881, 882, 'SEQUEL');
  const ins = db.prepare(`INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, season, title, url, watched, updated_at) VALUES (?, ?, 1, '', '', ?, CURRENT_TIMESTAMP)`);
  for (const n of [1, 2]) { ins.run(880, n, 1); ins.run(881, n, 1); }
  const d = library.getDetails(880);
  assert.equal(d.continueWith.malId, 882, 'S2 is finished, so S3 is next');
  assert.deepEqual(d.seriesLeft, { seasons: 1, episodes: 3, minutes: 72 });
});

test('web push: VAPID token verifies, requests are well-formed, gone subscriptions are dropped', async () => {
  const push = require('../server/push');
  const { publicKey } = await push.keys();
  assert.equal((await push.keys()).publicKey, publicKey, 'keys are made once');
  assert.equal(push.fromB64url(publicKey).length, 65, 'uncompressed P-256 point');
  push.subscribe({ endpoint: 'https://push.example.com/alive' }, 'https://tracker.example.com');
  push.subscribe({ endpoint: 'https://push.example.com/gone' }, 'https://tracker.example.com');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { seen.push({ url, opts }); return new Response(null, { status: url.endsWith('/gone') ? 410 : 201 }); };
  try {
    seen.length = 0;
    const only = await push.sendAll({ title: 't', body: 'b' }, { only: 'https://push.example.com/alive' });
    assert.equal(seen.length, 1, 'a test goes to one device');
    assert.equal(only.devices, 2, 'other devices are kept');
    seen.length = 0;
    const r = await push.sendAll({ title: 't', body: 'b', url: '/#/up-next' });
    assert.equal(r.sent, 1);
    assert.deepEqual(push.subscriptions().map((s) => s.endpoint), ['https://push.example.com/alive'], 'the 410 one is removed');
    const auth = seen[0].opts.headers.Authorization;
    const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, publicKey);
    assert.equal(seen[0].opts.headers.TTL, '86400');
    const [h64, p64, s64] = jwt.split('.');
    const claims = JSON.parse(new TextDecoder().decode(push.fromB64url(p64)));
    assert.equal(claims.aud, 'https://push.example.com');
    assert.equal(claims.sub, 'https://tracker.example.com');
    const key = await crypto.subtle.importKey('raw', push.fromB64url(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, push.fromB64url(s64), new TextEncoder().encode(`${h64}.${p64}`));
    assert.ok(ok, 'ES256 signature verifies with the public key');
    // New-episode detection: only episodes that aired since the last check.
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    const night = new Date(); night.setHours(3, 0, 0, 0);
    assert.equal(push.quietHours(night), true);
    assert.equal(push.quietHours(noon), false);
    assert.equal((await push.notifyNewEpisodes({ shows: [], now: night })).quiet, true);
    assert.equal(push.episodeLine({ aired: 8, nextEpisode: 4 }), "Episode 8 is out. You're on episode 4.");
    assert.equal(push.episodeLine({ aired: 5, nextEpisode: 5 }), 'Episode 5 is out.');
    const show = (o) => ({ malId: 1, title: 'Watching', airedEpisodes: 4, watchedCount: 4, listStatus: null, nextEpisode: 5, ...o });
    const today = new Date().toISOString().slice(0, 10);
    const base = [show(), show({ malId: 2, title: 'Upcoming', airedEpisodes: 0, watchedCount: 0 }), show({ malId: 3, title: 'Held', listStatus: 'on_hold' })];
    const first = await push.notifyNewEpisodes({ shows: base, seasons: [{ malId: 99, title: 'Old start', status: 'RELEASING', startDate: today }], now: noon });
    assert.equal(first.firstRun, true, 'the first run only records counts');
    // Episode 5 of the watched show is out (count 4 -> 5): announced, with a Play button.
    const ep = await push.notifyNewEpisodes({ shows: [show({ airedEpisodes: 5, nextEpisodeUrl: 'https://www.crunchyroll.com/watch/ABC/ep5', nextEpisodeUrlIsExact: true }), base[1], show({ malId: 3, title: 'Held', listStatus: 'on_hold', airedEpisodes: 9 })], now: noon });
    assert.equal(ep.fresh, 1, 'held shows are not announced');
    assert.equal(require('../server/state').get('pushLatest').title, 'New episode: Watching');
    assert.equal(require('../server/state').get('pushLatest').playLabel, 'Play E5');
    assert.equal((await push.notifyNewEpisodes({ shows: [show({ airedEpisodes: 5 })], now: noon })).fresh, 0, 'announced once');
    // Premiere: a show on the list goes from 0 to 1 aired.
    const pr = await push.notifyNewEpisodes({ shows: [show({ airedEpisodes: 5 }), show({ malId: 2, title: 'Upcoming', airedEpisodes: 1, watchedCount: 0 })], now: noon });
    assert.equal(pr.premieres, 1);
    assert.equal(require('../server/state').get('pushLatest').title, 'Premiere: Upcoming');
    // New season: only once it's airing (status), and once; one recorded at the first run stays quiet.
    const season = { malId: 100, title: 'Show Season 2', after: 'Show', inLibrary: false, status: 'NOT_YET_RELEASED', startDate: today };
    assert.equal((await push.notifyNewEpisodes({ shows: [], seasons: [season, { malId: 99, title: 'Old start', status: 'RELEASING', startDate: today }], now: noon })).premieres, 0, 'not before it airs');
    const ns = await push.notifyNewEpisodes({ shows: [], seasons: [{ ...season, status: 'RELEASING' }], now: noon });
    assert.equal(ns.premieres, 1);
    assert.equal(require('../server/state').get('pushLatest').title, 'New season: Show Season 2');
    assert.equal((await push.notifyNewEpisodes({ shows: [], seasons: [{ ...season, status: 'RELEASING' }], now: noon })).premieres, 0, 'a new season is announced once');
  } finally { global.fetch = realFetch; }
});

test('seasonal: an AniList failure after the cache expires keeps the last list', async () => {
  const insights = require('../server/insights');
  const anilist = require('../server/sources/anilist');
  const state = require('../server/state');
  const { db } = require('../server/db');
  const realGql = anilist.gql;
  const media = (id) => ({ id, idMal: id, title: { romaji: `Show ${id}` }, format: 'TV', status: 'RELEASING', episodes: 12, genres: ['Action'], tags: [], externalLinks: [], relations: { edges: [] }, coverImage: {}, popularity: 100 });
  try {
    anilist.gql = async () => ({ Page: { media: [media(900001), media(900002)] } });
    const first = await insights.seasonal({ refresh: true });
    assert.ok(first.items.length >= 1);
    anilist.gql = async () => { throw new Error('AniList blocked'); };
    const key = db.prepare("SELECT key FROM app_state WHERE key LIKE 'seasonal:%'").get().key;
    db.prepare("UPDATE app_state SET at = '2000-01-01T00:00:00Z' WHERE key = ?").run(key);
    const again = await insights.seasonal();
    assert.equal(again.items.length, first.items.length, 'stale list is served');
    assert.ok(state.get(key).list.length, 'cache kept');
  } finally { anilist.gql = realGql; }
});

test('unreleased seasons: old copied plays are unmarked, recent ones and released shows are kept', () => {
  addShow(960, 'Sequel Not Out', { status: 'NOT_YET_RELEASED', start_date: null });
  addShow(961, 'Out Already', { status: 'FINISHED' });
  const old = new Date(Date.now() - 400 * 86400e3).toISOString();
  const recent = new Date(Date.now() - 86400e3).toISOString();
  const mark = (id, n, at) => db.prepare(`INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, watched, watched_at) VALUES (?, ?, 1, ?)`).run(id, n, at);
  mark(960, 1, old); mark(960, 2, old); mark(960, 3, recent); mark(961, 1, old);
  db.prepare("UPDATE media SET fetched_at = CURRENT_TIMESTAMP WHERE mal_id IN (960, 961)").run();
  const r = library.repairUnreleasedWatches();
  assert.equal(r.episodes, 2);
  const w = (id, n) => db.prepare('SELECT watched FROM episode_sync WHERE mal_id = ? AND episode_number = ?').get(id, n).watched;
  assert.equal(w(960, 1), 0);
  assert.equal(w(960, 3), 1, 'a play from yesterday waits (AniList status may lag)');
  // Stale metadata: nothing is touched.
  mark(960, 1, old); db.prepare("UPDATE media SET fetched_at = '2020-01-01 00:00:00' WHERE mal_id = 960").run();
  assert.equal(library.repairUnreleasedWatches().episodes, 0, 'stale status is not trusted');
  db.prepare("UPDATE media SET fetched_at = CURRENT_TIMESTAMP WHERE mal_id = 960").run();
  library.repairUnreleasedWatches();
  assert.equal(w(961, 1), 1, 'released shows are untouched');
  assert.equal(library.repairUnreleasedWatches().episodes, 0, 'idempotent');
  // Past the total of a finished show: E21 of a 12-episode season.
  mark(961, 21, old); mark(961, 12, old);
  assert.equal(library.repairUnreleasedWatches().episodes, 1);
  assert.equal(w(961, 21), 0);
  assert.equal(w(961, 12), 1);
  // Past the total with a sequel: left for the sequel, not unmarked.
  mark(961, 21, old); relate(961, 962, 'SEQUEL');
  assert.equal(library.repairUnreleasedWatches().episodes, 0, 'overflow with a sequel is kept');
  assert.equal(w(961, 21), 1);
});

test('odd progress: Leave as is stops flagging a show, Undo flags it again', () => {
  addShow(970, 'Skipped To The End', { episodes: 12 });
  for (let n = 1; n <= 12; n += 1) db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, watched, watched_at) VALUES (?, ?, ?, ?)').run(970, n, n === 1 || n === 12 ? 1 : 0, n === 1 || n === 12 ? new Date().toISOString() : null);
  const flagged = () => library.suspiciousProgress().some((x) => x.malId === 970);
  assert.ok(flagged());
  library.acceptOddProgress(970);
  assert.ok(!flagged());
  library.acceptOddProgress(970, true);
  assert.ok(flagged());
});

test('season episode lists: a Crunchyroll watch link replaces a MyAnimeList link, an empty one keeps it', async () => {
  addShow(980, 'Linked Late', { episodes: 3 });
  rule('GLATE1', 980);
  const put = (n, url) => db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, title, url, watched) VALUES (?, ?, ?, ?, 0)').run(980, n, `Ep ${n}`, url);
  put(1, 'https://myanimelist.net/anime/980/x/episode/1');
  put(2, 'https://myanimelist.net/anime/980/x/episode/2');
  put(3, 'https://www.crunchyroll.com/watch/KEEP3/x');
  await crunchyroll.applySeasonEpisodes([{ seasonId: 'GLATE1', episodes: [
    { episodeNumber: 1, episodeId: 'NEW1', title: 'One' },
    { episodeNumber: 2, title: 'Two' },
    { episodeNumber: 3, episodeId: 'OTHER3', title: 'Three' }] }]);
  const url = (n) => db.prepare('SELECT url FROM episode_sync WHERE mal_id = 980 AND episode_number = ?').get(n).url;
  assert.equal(url(1), 'https://www.crunchyroll.com/watch/NEW1');
  assert.equal(url(2), 'https://myanimelist.net/anime/980/x/episode/2', 'no id: the old link stays');
  assert.equal(url(3), 'https://www.crunchyroll.com/watch/KEEP3/x', 'an existing watch link is kept');
});

test('ingest: a recent play counts on a show still cached as not yet released (premiere lag)', () => {
  addShow(990, 'Fresh Premiere', { status: 'NOT_YET_RELEASED', start_date: null });
  rule('GFRESH1', 990);
  const now = new Date().toISOString();
  crunchyroll.ingest([{ id: 'p-fresh-1', episodeId: 'EPF1', seasonId: 'GFRESH1', seriesTitle: 'Fresh Premiere', seasonTitle: 'Fresh Premiere', episodeNumber: 1, datePlayed: now, fullyWatched: true, playhead: 1400, durationS: 1440 }]);
  const row = db.prepare('SELECT watched FROM episode_sync WHERE mal_id = 990 AND episode_number = 1').get();
  assert.equal(row?.watched, 1);
});

test('episode stills are stored as a source URL and served through the image cache, not as a blob', async () => {
  const images = require('../server/images');
  addShow(995, 'Stills Show', { episodes: 2 });
  rule('GSTILL1', 995);
  db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, title, watched) VALUES (995, 1, ?, 0)').run('Episode 1');
  const thumb = 'https://imgsrv.crunchyroll.com/cdn-cgi/image/fit=contain,format=auto,quality=85,width=480/catalog/crunchyroll/abc.jpg';
  await crunchyroll.applySeasonEpisodes([{ seasonId: 'GSTILL1', episodes: [{ episodeNumber: 1, episodeId: 'S1E1', title: 'First', thumb }] }]);
  const row = db.prepare('SELECT image_blob, image_url FROM episode_sync WHERE mal_id = 995 AND episode_number = 1').get();
  assert.equal(row.image_blob, null, 'no bytes in the account database');
  if (images.isAllowed(thumb)) {
    assert.equal(row.image_url, thumb);
    const ep = library.getEpisodes(995).seasons.flatMap((s) => s.episodes).find((e) => e.episodeNumber === 1);
    assert.ok(ep.image.startsWith('/img/'), `served through the image cache, got ${ep.image}`);
  }
});

test('Just finished: seasons of one series finished together are one row; a separate show keeps its own', async () => {
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  addShow(9101, 'Binge Show', { start_date: '2024-01-01' });
  addShow(9102, 'Binge Show Season 2', { start_date: '2025-01-01' });
  addShow(9103, 'Unrelated Show', { start_date: '2023-01-01' });
  relate(9101, 9102, 'SEQUEL');
  const ep = db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, watched, watched_at) VALUES (?, ?, 1, ?)');
  for (const id of [9101, 9102, 9103]) for (let n = 1; n <= 12; n += 1) ep.run(id, n, recent);
  const rows = (await insights.upNext()).recentlyFinished.filter((x) => [9101, 9102, 9103].includes(x.malId));
  const binge = rows.find((x) => x.seasons === 2);
  assert.ok(binge, JSON.stringify(rows.map((x) => [x.malId, x.seasons])));
  assert.equal(binge.malId, 9102, 'the newest season stands for the group');
  assert.deepEqual([...binge.seasonIds].sort(), [9101, 9102]);
  assert.equal(rows.find((x) => x.malId === 9103)?.seasons, 1, 'an unrelated show stays on its own');
  assert.equal(rows.length, 2);
});

test('audio versions: a link picked for the audio you watch replaces another language\'s; the season is asked for again until then', async () => {
  addShow(985, 'Sub Watcher', { episodes: 2 });
  rule('GS00999990JAJP', 985);
  const put = (n, url) => db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, title, url, watched) VALUES (?, ?, ?, ?, 0)').run(985, n, `Ep ${n}`, url);
  put(1, 'https://www.crunchyroll.com/watch/GE00999991ENUS');
  put(2, 'https://www.crunchyroll.com/watch/GE00999992ENUS');
  db.prepare("INSERT INTO cr_history (episode_id, season_id, series_title, season_title, episode_number, date_played, mal_id, mal_episode, applied) VALUES ('GE00999991JAJP', 'GS00999990JAJP', 'Sub Watcher', 'Sub Watcher', 1, '2026-10-01T20:00:00Z', 985, 1, 1)").run();
  assert.ok(crunchyroll.wantedSeasons(1000).includes('GS00999990JAJP'), 'English links on a Japanese season: asked for again');
  await crunchyroll.applySeasonEpisodes([{ seasonId: 'GS00999990JAJP', episodes: [
    { episodeNumber: 1, episodeId: 'GE00999991ENUS', audioMatched: false, title: 'One' }] }]);
  const url = (n) => db.prepare('SELECT url FROM episode_sync WHERE mal_id = 985 AND episode_number = ?').get(n).url;
  assert.equal(url(1), 'https://www.crunchyroll.com/watch/GE00999991ENUS', 'an old extension (no audio choice) does not replace links');
  await crunchyroll.applySeasonEpisodes([{ seasonId: 'GS00999990JAJP', episodes: [
    { episodeNumber: 1, episodeId: 'GE00999991JAJP', audioMatched: true, title: 'One' },
    { episodeNumber: 2, episodeId: 'GE00999992JAJP', audioMatched: true, title: 'Two' }] }]);
  assert.equal(url(1), 'https://www.crunchyroll.com/watch/GE00999991JAJP');
  assert.equal(url(2), 'https://www.crunchyroll.com/watch/GE00999992JAJP');
  db.prepare("UPDATE cr_season_fetch SET fetched_at = datetime('now', '-2 hours') WHERE season_id = 'GS00999990JAJP'").run();
  db.prepare("UPDATE media SET status = 'FINISHED' WHERE mal_id = 985").run();
  assert.ok(!crunchyroll.wantedSeasons(1000).includes('GS00999990JAJP'), 'matched now: not asked for again');
});

test('the extension picks the episode version of the season you watched, else the original audio', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'extension', 'crunchyroll-api.js'), 'utf8');
  const pickVersion = new Function(`${src.slice(src.indexOf('function pickVersion'), src.indexOf('async function fetchSeasons'))}; return pickVersion;`)();
  const ep = { id: 'GE1ENUS', versions: [
    { guid: 'GE1ENUS', audio_locale: 'en-US', season_guid: 'GS1ENUS', original: false },
    { guid: 'GE1JAJP', audio_locale: 'ja-JP', season_guid: 'GS1JAJP', original: true },
    { guid: 'GE1DEDE', audio_locale: 'de-DE', season_guid: 'GS1DEDE', original: false }] };
  assert.deepEqual(pickVersion(ep, 'GS1JAJP'), { episodeId: 'GE1JAJP', audioMatched: true });
  assert.deepEqual(pickVersion(ep, 'GS1DEDE'), { episodeId: 'GE1DEDE', audioMatched: true }, 'a German-dub watcher keeps German');
  assert.deepEqual(pickVersion(ep, 'GSOTHER'), { episodeId: 'GE1JAJP', audioMatched: true }, 'unknown season: the original audio');
  assert.deepEqual(pickVersion({ id: 'GOLD1' }, 'GS1JAJP'), { episodeId: 'GOLD1', audioMatched: false }, 'no versions listed: as before');
});
