'use strict';
// Library = the user's watchlist + per-episode watch state.
const { db } = require('./db');
const images = require('./images');
const { parseJSONField } = require('./util');

const upsertAnimeStmt = db.prepare(`
INSERT INTO anime (mal_id, title, title_english, release_date, image_url, synopsis, total_episodes, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(mal_id) DO UPDATE SET
  title=CASE WHEN trim(COALESCE(excluded.title,'')) <> '' THEN excluded.title ELSE anime.title END,
  title_english=CASE WHEN trim(COALESCE(excluded.title_english,'')) <> '' THEN excluded.title_english ELSE anime.title_english END,
  release_date=COALESCE(excluded.release_date, anime.release_date),
  image_url=CASE WHEN trim(COALESCE(excluded.image_url,'')) <> '' THEN excluded.image_url ELSE anime.image_url END,
  synopsis=CASE WHEN trim(COALESCE(excluded.synopsis,'')) <> '' AND excluded.synopsis <> 'No synopsis available.'
    THEN excluded.synopsis ELSE anime.synopsis END,
  total_episodes=COALESCE(excluded.total_episodes, anime.total_episodes),
  updated_at=CURRENT_TIMESTAMP
`);
const addWatchlistStmt = db.prepare('INSERT INTO watchlist (mal_id, added_at) VALUES (?, CURRENT_TIMESTAMP) ON CONFLICT(mal_id) DO NOTHING');
const removeWatchlistStmt = db.prepare('DELETE FROM watchlist WHERE mal_id = ?');
// Watched state is yours alone: it lives in episode_watch (episode facts are shared, see schema.js).
const setWatchedStmt = db.prepare('UPDATE episode_watch SET watched = ?, watched_at = ?, updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ?');
const getImageStmt = db.prepare('SELECT image_blob AS imageBlob, image_mime AS imageMime, updated_at AS updatedAt FROM episode_sync WHERE mal_id = ? AND episode_number = ?');
const inLibraryStmt = db.prepare('SELECT 1 FROM watchlist WHERE mal_id = ?');

function upsertAnime(a) {
  upsertAnimeStmt.run(a.malId, a.title || a.titleEnglish || `MAL ${a.malId}`, a.titleEnglish || '', a.releaseDate || null,
    a.imageUrl || '', a.synopsis || '', a.totalEpisodes ?? null);
}

function addToLibrary(anime) {
  upsertAnime(anime);
  addWatchlistStmt.run(anime.malId);
}

/** Remove from the library; returns the removed entry (rating, list state, added date) for Undo. */
function removeFromLibrary(malId) {
  const row = db.prepare('SELECT mal_id, added_at, synced_at, list_status, rating FROM watchlist WHERE mal_id = ?').get(malId) || null;
  removeWatchlistStmt.run(malId);
  return row;
}

/** Undo for removeFromLibrary: put the entry back exactly as it was. */
function restoreToLibrary(row) {
  if (!row || !Number(row.mal_id)) return false;
  db.prepare(`INSERT OR REPLACE INTO watchlist (mal_id, added_at, synced_at, list_status, rating) VALUES (?, ?, ?, ?, ?)`)
    .run(Number(row.mal_id), row.added_at || null, row.synced_at || null, LIST_STATUSES.includes(row.list_status) ? row.list_status : null,
      Number.isInteger(row.rating) && row.rating >= 1 && row.rating <= 5 ? row.rating : null);
  return true;
}
function isInLibrary(malId) { return Boolean(inLibraryStmt.get(malId)); }

/** Number of episodes that have aired according to AniList (null when unknown). */
function airedCount(media) {
  if (!media) return null;
  if (media.status === 'NOT_YET_RELEASED') return 0;
  if (media.next_airing_episode) return media.next_airing_episode - 1;
  return media.episodes ?? null;
}

const ORDER = {
  added_desc: 'w.added_at DESC',
  title_asc: 'a.title COLLATE NOCASE ASC',
  release_asc: '(a.release_date IS NULL) ASC, a.release_date ASC, a.title COLLATE NOCASE ASC',
  release_desc: '(a.release_date IS NULL) ASC, a.release_date DESC, a.title COLLATE NOCASE ASC',
  activity_desc: '(last_watched_at IS NULL) ASC, last_watched_at DESC'
};

/** The library list. Synopses are left out unless asked for: the grid never shows them and they are half the payload. */
function progressOf(watched, furthest, aired) {
  if (!aired || !furthest) return watched;
  return furthest >= aired && watched >= 0.75 * aired ? aired : watched;
}

function getWatchlist(sort = 'release_desc', { withSynopsis = false } = {}) {
  const crlinks = require('./crlinks');
  const rows = db.prepare(`
    SELECT a.mal_id AS malId, a.title, COALESCE(a.title_english, '') AS titleEnglish,
           COALESCE(a.release_date, m.start_date) AS releaseDate,
           COALESCE(m.cover_url, a.image_url, '') AS remoteImage, COALESCE(a.synopsis, '') AS synopsis,
           COALESCE(a.total_episodes, m.episodes) AS totalEpisodes,
           m.format, m.status, m.genres, m.average_score AS averageScore, m.color,
           m.next_airing_episode AS nextAiringEpisode, m.next_airing_at AS nextAiringAt, m.episodes AS mediaEpisodes, m.external_links, m.duration AS episodeMinutes, m.synonyms,
           COUNT(e.episode_number) AS episodesCount,
           COALESCE(SUM(e.watched = 1), 0) AS watchedCount,
           MAX(CASE WHEN e.watched = 1 THEN e.episode_number END) AS furthest,
           MAX(CASE WHEN e.watched = 1 THEN e.watched_at END) AS last_watched_at,
           w.added_at AS addedAt, w.list_status AS listStatus, w.rating
    FROM watchlist w
    JOIN anime a ON a.mal_id = w.mal_id
    LEFT JOIN media m ON m.mal_id = a.mal_id
    LEFT JOIN episode_sync e ON e.mal_id = a.mal_id
    GROUP BY a.mal_id
    ORDER BY ${ORDER[sort] || ORDER.release_desc}
  `).all();
  const nextStmt = db.prepare(`SELECT episode_number AS n, url FROM episode_sync WHERE mal_id = ? AND episode_number > COALESCE((SELECT MAX(episode_number) FROM episode_sync WHERE mal_id = ? AND watched = 1), 0) ORDER BY episode_number LIMIT 1`);
  // Released sequels you haven't watched any of, so a finished show can say "Sequel out".
  // If any sequel of a show has been watched, you've moved on: no hint (a side movie isn't "next").
  // Otherwise prefer a TV/ONA season over a movie, earliest first.
  const sequels = new Map(); const movedOn = new Set();
  for (const r of db.prepare(`SELECT r.mal_id AS id, s.mal_id AS sid, COALESCE(s.title_english, s.title) AS title, s.status, s.format,
        EXISTS (SELECT 1 FROM episode_sync e WHERE e.mal_id = s.mal_id AND e.watched = 1) AS seen
      FROM media_relation r JOIN media s ON s.mal_id = r.related_mal_id
      WHERE r.relation_type = 'SEQUEL'
      ORDER BY CASE WHEN s.format = 'MOVIE' THEN 1 ELSE 0 END, s.start_date`).all()) {
    if (r.seen) { movedOn.add(r.id); continue; }
    if (sequels.has(r.id) || !['FINISHED', 'RELEASING'].includes(r.status) || !['TV', 'TV_SHORT', 'ONA', 'MOVIE'].includes(r.format)) continue;
    sequels.set(r.id, { malId: r.sid, title: r.title, airing: r.status === 'RELEASING' });
  }
  for (const id of movedOn) sequels.delete(id);
  // Series grouping: seasons in your library linked as sequel/prequel share one id (the lowest MAL id).
  const parent = new Map(rows.map((r) => [r.malId, r.malId]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const e of db.prepare(`SELECT mal_id AS a, related_mal_id AS b FROM media_relation WHERE relation_type IN ('SEQUEL','PREQUEL','PARENT')`).all()) {
    if (!parent.has(e.a) || !parent.has(e.b)) continue;
    const ra = find(e.a); const rb = find(e.b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  return rows.map((r) => {
    const aired = airedCount({ status: r.status, next_airing_episode: r.nextAiringEpisode, episodes: r.mediaEpisodes });
    // Next episode for shows in progress, and E1 for released shows you haven't started.
    const next = (r.watchedCount || (aired ?? 0) > 0) && r.watchedCount < (aired ?? r.episodesCount) ? nextStmt.get(r.malId, r.malId) : null;
    // Play target: the exact episode, else the show's Crunchyroll page, else the first service AniList lists.
    let nextUrl = next?.url && /crunchyroll\.com\/watch\//.test(next.url) ? next.url.replace(/^http:/, 'https:') : null;
    let nextSite = 'Crunchyroll';
    let nextExact = Boolean(nextUrl);
    if (next && !nextUrl) {
      const s = crlinks.seriesFor(r.malId);
      if (s) nextUrl = s.url || `https://www.crunchyroll.com/series/${s.id}`;
      else { const other = parseJSONField(r.external_links, []).find((l) => l.url); if (other) { nextUrl = other.url; nextSite = other.site; } }
    }
    return {
      malId: r.malId,
      series: find(r.malId),
      sequel: sequels.get(r.malId) || null,
      synonyms: parseJSONField(r.synonyms, []),
      episodeMinutes: r.episodeMinutes || null,
      nextEpisode: next?.n ?? null,
      nextEpisodeUrl: nextUrl,
      nextEpisodeSite: nextSite,
      nextEpisodeUrlIsExact: nextExact,
      title: r.title,
      titleEnglish: r.titleEnglish,
      releaseDate: r.releaseDate,
      imageUrl: images.localUrl(r.remoteImage),
      synopsis: withSynopsis ? r.synopsis : undefined,
      totalEpisodes: r.totalEpisodes,
      format: r.format,
      status: r.status,
      genres: parseJSONField(r.genres, []),
      averageScore: r.averageScore,
      color: r.color,
      nextAiringEpisode: r.nextAiringEpisode,
      nextAiringAt: r.nextAiringAt,
      airedEpisodes: aired,
      episodesCount: r.episodesCount,
      watchedCount: r.watchedCount,
      // Progress for badges and filters: a finished show with a few gaps in old history counts as
      // finished (finale watched and at least 75% of episodes), otherwise the plain count.
      progress: progressOf(r.watchedCount, r.furthest, aired),
      unwatchedCount: Math.max(0, r.episodesCount - r.watchedCount),
      lastWatchedAt: r.last_watched_at,
      addedAt: r.addedAt,
      listStatus: r.listStatus || null,
      rating: r.rating || null
    };
  });
}

/**
 * "Watched elsewhere" (Netflix, another service): add the show if needed and mark every aired episode watched.
 * Needs AniList metadata first so the aired episode count is known; the caller fetches it.
 */
function markWatchedElsewhere(malId) {
  const m = db.prepare('SELECT * FROM media WHERE mal_id = ?').get(malId);
  if (!m) throw Object.assign(new Error('unknown show'), { status: 404 });
  const wasInLibrary = isInLibrary(malId);
  // An unreleased show has nothing to mark; adding it with zero episodes only leaves an empty entry.
  if (m.status === 'NOT_YET_RELEASED' || airedCount(m) === 0) throw Object.assign(new Error(`${m.title_english || m.title} hasn't aired yet`), { status: 400 });
  if (!isInLibrary(malId)) {
    addToLibrary({ malId, title: m.title, titleEnglish: m.title_english || '', imageUrl: m.cover_url || '', releaseDate: m.start_date, totalEpisodes: m.episodes });
  }
  const aired = airedCount(m) ?? m.episodes ?? 1;
  const insert = db.prepare('INSERT OR IGNORE INTO episode_watch (mal_id, episode_number, season, watched) VALUES (?, ?, 1, 0)');
  db.transaction(() => { for (let n = 1; n <= aired; n += 1) insert.run(malId, n); })();
  return { malId, aired, addedToLibrary: !wasInLibrary, ...markWatchedThrough(malId, aired) };
}

function getAnime(malId) {
  const inLib = getWatchlist('title_asc', { withSynopsis: true }).find((x) => x.malId === malId);
  if (inLib) return { ...inLib, inLibrary: true };
  // Not in the library (a recommendation or sequel): build the same shape from AniList metadata.
  const m = db.prepare('SELECT * FROM media WHERE mal_id = ?').get(malId);
  if (!m) return null;
  return {
    malId, title: m.title, titleEnglish: m.title_english || '', releaseDate: m.start_date, imageUrl: images.localUrl(m.cover_url),
    synopsis: m.description || '', totalEpisodes: m.episodes, format: m.format, status: m.status,
    genres: parseJSONField(m.genres, []), averageScore: m.average_score, nextAiringEpisode: m.next_airing_episode,
    nextAiringAt: m.next_airing_at, airedEpisodes: airedCount(m), episodesCount: 0, watchedCount: 0, inLibrary: false, episodeMinutes: m.duration || null
  };
}

function episodeImageUrl(malId, episodeNumber, updatedAt, imageUrl = null) {
  if (process.env.AUTH_MODE === 'accounts' && require('./accounts/switches').thumbnailsOff()) return ''; // THUMBNAILS=off: posters only
  if (imageUrl) return images.localUrl(imageUrl);
  const v = updatedAt ? encodeURIComponent(String(updatedAt).replace(/\D/g, '')) : '0';
  return `/api/episode-image?malId=${malId}&episodeNumber=${episodeNumber}&v=${v}`;
}

function groupBySeason(episodes) {
  const map = new Map();
  for (const ep of episodes) {
    if (!map.has(ep.season)) map.set(ep.season, { season: ep.season, estimated: false, episodes: [] });
    map.get(ep.season).episodes.push(ep);
  }
  return [...map.values()].sort((a, b) => a.season - b.season);
}

function buildPayload(malId, items) {
  const episodes = items.map((row) => ({
    episodeNumber: row.episodeNumber,
    season: row.season,
    estimatedSeason: false,
    title: row.title || `Episode ${row.episodeNumber}`,
    url: row.url || '',
    aired: row.aired || null,
    watched: Boolean(row.watched),
    watchedAt: row.watchedAt || null,
    image: row.hasImage ? episodeImageUrl(malId, row.episodeNumber, row.updatedAt, row.imageUrl) : ''
  }));
  const watchedCount = episodes.filter((x) => x.watched).length;
  return { malId, episodesCount: episodes.length, watchedCount, unwatchedCount: Math.max(0, episodes.length - watchedCount), seasons: groupBySeason(episodes) };
}

const EP_COLUMNS = `e.mal_id AS malId, e.episode_number AS episodeNumber, e.season, e.title, e.url, e.aired,
  e.watched, e.watched_at AS watchedAt, e.updated_at AS updatedAt, (e.image_blob IS NOT NULL OR e.image_url IS NOT NULL) AS hasImage, e.image_url AS imageUrl`;

function getEpisodes(malId) {
  const rows = db.prepare(`SELECT ${EP_COLUMNS} FROM episode_sync e WHERE e.mal_id = ? ORDER BY e.season, e.episode_number`).all(malId);
  const payload = buildPayload(malId, rows);
  // Crunchyroll watch links: from synced episode URLs, else from your own history of that episode.
  const fromHistory = new Map(db.prepare(`SELECT mal_episode AS n, episode_id AS id FROM cr_history
    WHERE mal_id = ? AND mal_episode IS NOT NULL ORDER BY date_played`).all(malId).map((r) => [r.n, r.id]));
  for (const season of payload.seasons) {
    for (const ep of season.episodes) {
      const id = fromHistory.get(ep.episodeNumber);
      // The version you played (your audio) first; then the synced link.
      ep.crunchyrollUrl = id ? `https://www.crunchyroll.com/watch/${id}`
        : /crunchyroll\.com\/watch\//.test(ep.url) ? ep.url.replace(/^http:/, 'https:') : null;
    }
  }
  return payload;
}

const RELATION_ORDER = ['PREQUEL', 'PARENT', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY'];

/** Franchise neighbours + external links for the detail drawer. */
function getDetails(malId) {
  const media = db.prepare('SELECT title, title_english, site_url, external_links, is_full FROM media WHERE mal_id = ?').get(malId) || {};
  const anime = db.prepare('SELECT title, title_english FROM anime WHERE mal_id = ?').get(malId) || {};
  const relations = db.prepare(`
    SELECT r.related_mal_id AS malId, r.relation_type AS relationType, COALESCE(m.title_english, m.title) AS title,
           m.format, m.status, m.episodes, m.start_date AS startDate, m.cover_url AS cover,
           (SELECT 1 FROM watchlist w WHERE w.mal_id = r.related_mal_id) AS inLibrary,
           (SELECT COUNT(*) FROM episode_sync e WHERE e.mal_id = r.related_mal_id AND e.watched = 1) AS watched
    FROM media_relation r LEFT JOIN media m ON m.mal_id = r.related_mal_id
    WHERE r.mal_id = ? AND r.relation_type IN (${RELATION_ORDER.map(() => '?').join(',')})
  `).all(malId, ...RELATION_ORDER)
    .sort((a, b) => RELATION_ORDER.indexOf(a.relationType) - RELATION_ORDER.indexOf(b.relationType) || String(a.startDate).localeCompare(String(b.startDate)))
    .map((r) => ({ ...r, inLibrary: Boolean(r.inLibrary), image: images.localUrl(r.cover), cover: undefined }));
  const crlinks = require('./crlinks');
  const series = crlinks.seriesFor(malId);
  const name = anime.title_english || media.title_english || anime.title || media.title || '';
  // "Continue with": the next TV season, following SEQUEL links through OVAs and specials
  // (AniList chains Slime S1 -> an OVA -> S2, so one hop is not enough).
  const seqStmt = db.prepare(`SELECT r.related_mal_id AS malId, m.format, m.status, COALESCE(m.title_english, m.title) AS title, m.cover_url AS cover, m.episodes,
      (SELECT 1 FROM watchlist w WHERE w.mal_id = r.related_mal_id) AS inLibrary,
      (SELECT COUNT(*) FROM episode_sync e WHERE e.mal_id = r.related_mal_id AND e.watched = 1) AS watched,
      (SELECT MAX(episode_number) FROM episode_sync e WHERE e.mal_id = r.related_mal_id AND e.watched = 1) AS furthest,
      m.next_airing_episode AS nae
    FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id WHERE r.mal_id = ? AND r.relation_type = 'SEQUEL' ORDER BY m.start_date LIMIT 1`);
  // "Finished" uses the Library's rule (finale + 3/4 of episodes), so the panel and the badges agree.
  const airedOf = (m) => airedCount({ status: m.status, next_airing_episode: m.nae ?? m.next_airing_episode, episodes: m.episodes }) ?? m.episodes ?? 0;
  const effWatched = (m) => progressOf(m.watched, m.furthest, airedOf(m));
  let continueWith = null;
  for (let cur = malId, hops = 0; hops < 8; hops += 1) {
    const s = seqStmt.get(cur);
    if (!s) break;
    // A season you've already finished isn't "next": keep following the chain past it.
    const finished = airedOf(s) > 0 && effWatched(s) >= airedOf(s);
    if (['TV', 'TV_SHORT', 'ONA'].includes(s.format) && s.status !== 'NOT_YET_RELEASED' && !finished) { continueWith = { ...s, inLibrary: Boolean(s.inLibrary), image: images.localUrl(s.cover), cover: undefined }; break; }
    cur = s.malId;
  }
  // Time left in the series: this show's unwatched aired episodes plus every later released TV
  // season on the sequel chain (through OVAs/specials), at each season's episode length.
  const seqAllStmt = db.prepare(`SELECT r.related_mal_id AS malId, m.format, m.status, m.episodes, m.duration, m.next_airing_episode AS nae,
      (SELECT COUNT(*) FROM episode_sync e WHERE e.mal_id = r.related_mal_id AND e.watched = 1) AS watched,
      (SELECT MAX(episode_number) FROM episode_sync e WHERE e.mal_id = r.related_mal_id AND e.watched = 1) AS furthest
    FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id WHERE r.mal_id = ? AND r.relation_type = 'SEQUEL' ORDER BY m.start_date LIMIT 1`);
  const leftOf = (m, watched, furthest) => {
    const aired = airedCount({ status: m.status, next_airing_episode: m.nae ?? m.next_airing_episode, episodes: m.episodes }) ?? m.episodes ?? 0;
    return Math.max(0, aired - progressOf(watched, furthest, aired));
  };
  const ownRow = db.prepare('SELECT COUNT(*) AS n, MAX(episode_number) AS f FROM episode_sync WHERE mal_id = ? AND watched = 1').get(malId);
  const ownWatched = ownRow.n; const ownFurthest = ownRow.f;
  const own = db.prepare('SELECT status, episodes, duration, next_airing_episode FROM media WHERE mal_id = ?').get(malId) || {};
  let seriesLeft = { seasons: 0, episodes: leftOf(own, ownWatched, ownFurthest), minutes: leftOf(own, ownWatched, ownFurthest) * (own.duration || 24) };
  for (let cur = malId, hops = 0, seen = new Set([malId]); hops < 10; hops += 1) {
    const s2 = seqAllStmt.get(cur);
    if (!s2 || seen.has(s2.malId)) break;
    seen.add(s2.malId); cur = s2.malId;
    if (s2.status === 'NOT_YET_RELEASED' || !['TV', 'TV_SHORT', 'ONA'].includes(s2.format)) continue;
    const left = leftOf(s2, s2.watched, s2.furthest);
    if (left) { seriesLeft.seasons += 1; seriesLeft.episodes += left; seriesLeft.minutes += left * (s2.duration || 24); }
  }
  if (!seriesLeft.seasons) seriesLeft = null; // only worth saying when later seasons are involved

  // "More like this": AniList's community recommendations for this show, minus anything you've
  // watched or that belongs to this show's own franchise.
  const relatedIds = new Set(relations.map((r) => r.malId));
  const similar = db.prepare(`
    SELECT r.rec_mal_id AS malId, r.rating, COALESCE(m.title_english, m.title) AS title, m.cover_url AS cover, m.format, m.episodes,
           m.average_score AS averageScore, m.season_year AS year, m.status,
           (SELECT 1 FROM watchlist w WHERE w.mal_id = r.rec_mal_id) AS inLibrary,
           (SELECT COUNT(*) FROM episode_sync e WHERE e.mal_id = r.rec_mal_id AND e.watched = 1) AS watched
    FROM media_rec r JOIN media m ON m.mal_id = r.rec_mal_id
    WHERE r.mal_id = ? AND r.rating > 0 AND m.status IN ('FINISHED','RELEASING')
    ORDER BY r.rating DESC LIMIT 12`).all(malId)
    .filter((s) => !s.watched && !relatedIds.has(s.malId))
    .slice(0, 6)
    .map((s) => ({ ...s, inLibrary: Boolean(s.inLibrary), image: images.localUrl(s.cover), cover: undefined }));
  return {
    partial: !media.is_full,
    relations,
    seriesLeft,
    similar,
    continueWith,
    // Official streaming services from AniList (Crunchyroll, Netflix, HIDIVE, Prime Video, ...), one per site.
    watchOn: [...new Map(parseJSONField(media.external_links, []).map((l) => [l.site, l])).values()],
    links: {
      myAnimeList: `https://myanimelist.net/anime/${malId}`,
      aniList: media.site_url || null,
      crunchyroll: series ? (series.url || `https://www.crunchyroll.com/series/${series.id}`) : `https://www.crunchyroll.com/search?q=${encodeURIComponent(crlinks.searchQuery(name))}`,
      crunchyrollIsSearch: !series,
      crunchyrollSource: series?.source || null,
      notOnCrunchyroll: !series && crlinks.notOnCrunchyroll(malId)
    }
  };
}

function getAllEpisodes() {
  const rows = db.prepare(`SELECT ${EP_COLUMNS} FROM episode_sync e WHERE e.mal_id IN (SELECT mal_id FROM watchlist) ORDER BY e.mal_id, e.season, e.episode_number`).all();
  const byMal = new Map();
  for (const row of rows) {
    if (!byMal.has(row.malId)) byMal.set(row.malId, []);
    byMal.get(row.malId).push(row);
  }
  const out = {};
  for (const [malId, items] of byMal) out[malId] = buildPayload(malId, items);
  return out;
}

function setWatched(malId, episodeNumber, watched) {
  const at = watched ? new Date().toISOString() : null;
  setWatchedStmt.run(watched ? 1 : 0, at, malId, episodeNumber);
  return { ok: true, watched: Boolean(watched), watchedAt: at };
}

/** Mark every aired episode up to and including `episodeNumber` as watched. */
/**
 * Mark every episode up to `episodeNumber` watched. Returns which episodes actually changed, so an
 * Undo can revert exactly those. `at` is the watch date (ISO string), `null` when unknown (imports
 * without a date), or omitted for "now".
 */
function markWatchedThrough(malId, episodeNumber, at = new Date().toISOString()) {
  const episodes = db.prepare('SELECT episode_number AS n FROM episode_sync WHERE mal_id = ? AND episode_number <= ? AND watched = 0 ORDER BY 1')
    .all(malId, episodeNumber).map((r) => r.n);
  const info = db.prepare(`UPDATE episode_watch SET watched = 1, watched_at = COALESCE(watched_at, ?), updated_at = CURRENT_TIMESTAMP
    WHERE mal_id = ? AND episode_number <= ? AND watched = 0`).run(at, malId, episodeNumber);
  return { ok: true, changed: info.changes, episodes };
}

/** Unmark specific episodes (the other half of an Undo). */
function unmarkEpisodes(malId, episodes) {
  const stmt = db.prepare('UPDATE episode_watch SET watched = 0, watched_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ?');
  let changed = 0;
  db.transaction(() => { for (const n of episodes || []) changed += stmt.run(malId, Number(n)).changes || 0; })();
  return { ok: true, changed };
}

/**
 * Unmark "watched" episodes that can't be: seasons AniList says haven't aired (an old import copied
 * earlier seasons' plays onto them), and episodes past a finished show's total. Only plays over a
 * week old, in case AniList's data lags.
 */
function repairUnreleasedWatches() {
  // Also: a finished show can't have a watched episode numbered past its total (old bulk-mark
  // leftovers like "E21 of 12"; new overflow is rolled into the sequel by resolveOverflow on ingest).
  // Only on metadata fetched in the last 3 days (a stale status must not unmark real watches), only
  // plays over a month old, and never past-the-total episodes of a show with a sequel: those belong
  // to the sequel (resolveOverflow), so they're left for a remap instead of being thrown away.
  const rows = db.prepare(`SELECT e.mal_id, e.episode_number FROM episode_sync e JOIN media m ON m.mal_id = e.mal_id
    WHERE e.watched = 1 AND e.watched_at < ? AND m.fetched_at > datetime('now', '-3 days') AND (m.status = 'NOT_YET_RELEASED'
      OR (m.status = 'FINISHED' AND m.episodes > 0 AND e.episode_number > m.episodes
          AND NOT EXISTS (SELECT 1 FROM media_relation r WHERE r.mal_id = e.mal_id AND r.relation_type = 'SEQUEL')))`)
    .all(new Date(Date.now() - 30 * 86400e3).toISOString());
  const byShow = new Map();
  for (const r of rows) byShow.set(r.mal_id, [...(byShow.get(r.mal_id) || []), r.episode_number]);
  let changed = 0;
  for (const [malId, eps] of byShow) changed += unmarkEpisodes(malId, eps).changed;
  return { shows: byShow.size, episodes: changed };
}

const LIST_STATUSES = [null, 'on_hold', 'dropped'];

/** Put a show on hold, drop it, or make it active again (status null). */
function setListStatus(malId, status) {
  if (!LIST_STATUSES.includes(status)) throw Object.assign(new Error('status must be on_hold, dropped or null'), { status: 400 });
  if (!isInLibrary(malId)) throw Object.assign(new Error('not in library'), { status: 404 });
  db.prepare('UPDATE watchlist SET list_status = ? WHERE mal_id = ?').run(status, malId);
  return { ok: true, malId, listStatus: status };
}

/** Your own 1-5 rating; null clears it. */
function setRating(malId, rating) {
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw Object.assign(new Error('rating must be 1-5 or null'), { status: 400 });
  if (!isInLibrary(malId)) throw Object.assign(new Error('not in library'), { status: 404 });
  db.prepare('UPDATE watchlist SET rating = ? WHERE mal_id = ?').run(rating, malId);
  return { ok: true, malId, rating };
}

/** Watching a held or dropped show again makes it active. */
function listStatusOf(malId) { return db.prepare('SELECT list_status FROM watchlist WHERE mal_id = ?').get(malId)?.list_status || null; }

function reactivate(malIds) {
  const stmt = db.prepare('UPDATE watchlist SET list_status = NULL WHERE mal_id = ? AND list_status IS NOT NULL');
  let n = 0;
  for (const id of malIds) n += stmt.run(id).changes || 0;
  return n;
}

function getEpisodeImage(malId, episodeNumber) { return getImageStmt.get(malId, episodeNumber); }

const mediaEpisodesStmt = db.prepare('SELECT episodes, status FROM media WHERE mal_id = ?');
const sequelStmt = db.prepare(`SELECT r.related_mal_id AS id FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id
  WHERE r.mal_id = ? AND r.relation_type = 'SEQUEL' AND m.format IN ('TV','TV_SHORT','ONA') ORDER BY m.start_date LIMIT 1`);

/**
 * Crunchyroll often numbers split-cour seasons continuously (e.g. S2 eps 1-24) while MAL has
 * "Part 1" (12) and "Part 2" (12). Roll an episode number past a finished entry's length into its sequel.
 */
function resolveOverflow(malId, episodeNumber) {
  let mal = malId; let ep = episodeNumber;
  for (let hops = 0; hops < 4; hops += 1) {
    const m = mediaEpisodesStmt.get(mal);
    if (!m || !m.episodes || m.status !== 'FINISHED' || ep <= m.episodes) break;
    const next = sequelStmt.get(mal);
    if (!next) break;
    ep -= m.episodes; mal = next.id;
  }
  return { malId: mal, episodeNumber: ep };
}

/** Shows whose finale is ticked but most episodes aren't: usually a mapping slip or a stray bulk mark. */
function suspiciousProgress() {
  // One pass over episode counts; the aired count is refined in JS (it depends on airing status).
  const rows = db.prepare(`
    SELECT a.mal_id AS malId, COALESCE(NULLIF(a.title_english, ''), m.title_english, a.title) AS title, COALESCE(m.cover_url, a.image_url) AS cover,
           m.status, m.episodes, m.next_airing_episode, COUNT(e.episode_number) AS rows_, SUM(e.watched = 1) AS watched,
           MAX(CASE WHEN e.watched = 1 THEN e.episode_number END) AS furthest
    FROM watchlist w JOIN anime a ON a.mal_id = w.mal_id LEFT JOIN media m ON m.mal_id = a.mal_id
    JOIN episode_sync e ON e.mal_id = a.mal_id
    GROUP BY a.mal_id
    HAVING watched > 0 AND furthest >= 4`).all();
  const accepted = new Set(require('./state').get('oddAccepted')?.ids || []);
  return rows.map((r) => ({ ...r, aired: airedCount({ status: r.status, next_airing_episode: r.next_airing_episode, episodes: r.episodes }) ?? r.rows_ }))
    .filter((r) => !accepted.has(r.malId) && r.aired >= 4 && r.furthest >= r.aired && r.watched / r.aired < 0.5)
    .map((r) => ({ malId: r.malId, title: r.title, image: images.localUrl(r.cover), watched: r.watched, aired: r.aired }));
}

/** "Leave as is" on an odd-progress show (you really did skip ahead): stop flagging it. `undo` flags it again. */
function acceptOddProgress(malId, undo = false) {
  const state = require('./state');
  const ids = new Set(state.get('oddAccepted')?.ids || []);
  if (undo) ids.delete(Number(malId)); else ids.add(Number(malId));
  state.set('oddAccepted', { ids: [...ids].slice(-500) });
  return { ok: true };
}

/**
 * Import a MyAnimeList list export (already parsed): [{ malId, title, episodes, watched, score, status }].
 * Uses only what the file contains, so it works without AniList; metadata fills in afterwards.
 * Never un-watches anything and never lowers progress the tracker already has.
 */
function importMalList(entries) {
  const summary = { shows: 0, added: 0, episodesMarked: 0, rated: 0, held: 0, dropped: 0, skipped: 0 };
  const insertEp = db.prepare('INSERT OR IGNORE INTO episode_watch (mal_id, episode_number, season, watched) VALUES (?, ?, 1, 0)');
  const ratingStmt = db.prepare('UPDATE watchlist SET rating = ? WHERE mal_id = ? AND rating IS NULL');
  const statusStmt = db.prepare('UPDATE watchlist SET list_status = ? WHERE mal_id = ? AND list_status IS NULL');
  db.transaction(() => {
    for (const e of entries || []) {
      const malId = Number(e.malId);
      const watched = Math.max(0, Math.floor(Number(e.watched) || 0));
      if (!malId || !e.title) { summary.skipped += 1; continue; }
      // Plan-to-watch entries with nothing watched are skipped: they'd only clutter "Not started".
      if (!watched && e.status === 'plan') { summary.skipped += 1; continue; }
      summary.shows += 1;
      if (!isInLibrary(malId)) { addToLibrary({ malId, title: e.title, titleEnglish: '', totalEpisodes: Number(e.episodes) || null }); summary.added += 1; }
      if (watched) {
        for (let n = 1; n <= watched; n += 1) insertEp.run(malId, n);
        // The list's own finish/start date when it has one; otherwise no date at all, so imported
        // shows don't look "watched today" in Up Next, the rating strip or recommendation recency.
        const at = /^(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(e.watchedAt || '') ? `${e.watchedAt.slice(0, 10)}T12:00:00Z` : null;
        summary.episodesMarked += markWatchedThrough(malId, watched, at).changed || 0;
      }
      const score = Number(e.score) || 0;
      if (score > 0 && ratingStmt.run(Math.max(1, Math.min(5, Math.round(score / 2))), malId).changes) summary.rated += 1;
      if (e.status === 'onhold' && statusStmt.run('on_hold', malId).changes) summary.held += 1;
      if (e.status === 'dropped' && statusStmt.run('dropped', malId).changes) summary.dropped += 1;
    }
  })();
  return summary;
}

module.exports = {
  unmarkEpisodes,
  repairUnreleasedWatches,
  acceptOddProgress,
  listStatusOf,
  importMalList,
  suspiciousProgress,
  progressOf,
  resolveOverflow,
  upsertAnime, addToLibrary, removeFromLibrary, restoreToLibrary, isInLibrary, airedCount,
  getWatchlist, getAnime, getEpisodes, getDetails, markWatchedElsewhere, getAllEpisodes, setWatched, markWatchedThrough, setListStatus, setRating, reactivate, getEpisodeImage, episodeImageUrl
};
