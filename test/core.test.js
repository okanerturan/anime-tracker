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
  addShow(600, 'Series S1', { episodes: 3, start_date: '2020-01-01' });
  addShow(601, 'Series S2', { episodes: 2, start_date: '2021-01-01' });
  media({ mal_id: 602, title: 'Series S3', episodes: 12, start_date: '2026-01-01' });
  relate(600, 601, 'SEQUEL'); relate(601, 602, 'SEQUEL');
  rule('GS600', 600); rule('GS601', 601);
  // Episode 2 of S1 is missing from history, but episode 3 was watched: progress is 3/3.
  await crunchyroll.ingest([
    play({ id: 'X1', series: 'GSERIES600', season: 'GS600', ep: 1, at: '2026-10-01T10:00:00Z' }),
    play({ id: 'X3', series: 'GSERIES600', season: 'GS600', ep: 3, at: '2026-10-01T11:00:00Z' }),
    play({ id: 'Y1', series: 'GSERIES600', season: 'GS601', ep: 1, at: '2026-10-02T10:00:00Z' }),
    play({ id: 'Y2', series: 'GSERIES600', season: 'GS601', ep: 2, at: '2026-10-02T11:00:00Z' })
  ], { source: 'test' });
  const info = crlinks.showsForSeries('GSERIES600');
  assert.deepEqual(info.shows.map((s) => [s.malId, s.watched, s.aired]), [[600, 3, 3], [601, 2, 2]]);
  assert.equal(info.nextSeason.malId, 602);
  assert.deepEqual(crlinks.showsForSeries('bad id!'), { shows: [], nextSeason: null });
});
