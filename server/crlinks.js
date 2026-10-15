'use strict';
// Crunchyroll series links. Best first: the series you actually watched (history), AniList's streaming
// link, a series the extension found with Crunchyroll's own search, then a related season's series
// (Crunchyroll keeps every season on one series page). Failing all that, a search link whose query fits
// Crunchyroll's 30-character search box.
const { db } = require('./db');
const { normalizeTitle, parseJSONField } = require('./util');

const SERIES_RE = /crunchyroll\.com\/(?:[a-z-]+\/)?series\/([A-Z0-9]+)/i;
const TV = ['TV', 'TV_SHORT', 'ONA'];

const historyStmt = db.prepare(`SELECT series_id AS id FROM cr_history WHERE mal_id = ? AND series_id IS NOT NULL
  UNION ALL SELECT h.series_id FROM cr_season_map r JOIN cr_history h ON h.season_id = r.season_id WHERE r.mal_id = ? AND h.series_id IS NOT NULL LIMIT 1`);
const mediaStmt = db.prepare('SELECT title, title_english, format, external_links, cr_series_id FROM media WHERE mal_id = ?');
// Relations are stored on whichever show had full metadata, so follow them in both directions.
const neighboursStmt = db.prepare(`
  SELECT r.related_mal_id AS id FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id
    WHERE r.mal_id = ? AND r.relation_type IN ('PREQUEL','SEQUEL','PARENT') AND m.format IN ('TV','TV_SHORT','ONA')
  UNION
  SELECT r.mal_id FROM media_relation r JOIN media m ON m.mal_id = r.mal_id
    WHERE r.related_mal_id = ? AND r.relation_type IN ('PREQUEL','SEQUEL','PARENT') AND m.format IN ('TV','TV_SHORT','ONA')`);

/** This show's own Crunchyroll series id, without looking at related seasons. */
function ownSeries(malId) {
  const h = historyStmt.get(malId, malId);
  if (h?.id) return { id: h.id, source: 'history' };
  const m = mediaStmt.get(malId);
  if (!m) return null;
  const links = parseJSONField(m.external_links, []).filter((l) => /crunchyroll/i.test(l.site || '') && /crunchyroll\.com/i.test(l.url || ''));
  const series = links.find((l) => SERIES_RE.test(l.url));
  if (series) return { id: series.url.match(SERIES_RE)[1], source: 'anilist' };
  if (m.cr_series_id) return { id: m.cr_series_id, source: 'crunchyroll-search' };
  // Older AniList entries use Crunchyroll's pre-2022 URLs (crunchyroll.com/<slug>), which still redirect.
  if (links[0]) return { url: links[0].url.replace(/^http:/, 'https:'), source: 'anilist' };
  return null;
}

/** Series id for a show, borrowing a related TV season's series when it has none of its own. */
function seriesFor(malId) {
  const own = ownSeries(malId);
  if (own) return own;
  const m = mediaStmt.get(malId);
  if (m && !TV.includes(m.format)) return null; // movies and OVAs are usually separate entries on Crunchyroll
  const seen = new Set([malId]);
  let frontier = [malId];
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const { id: n } of neighboursStmt.all(id, id)) {
        if (seen.has(n)) continue;
        seen.add(n);
        const found = ownSeries(n);
        if (found) return { ...found, source: 'franchise' };
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

/** True once the extension searched Crunchyroll for this show and found nothing. */
function notOnCrunchyroll(malId) {
  return mediaStmt.get(malId)?.cr_series_id === '' && !seriesFor(malId);
}

/** A search query that survives Crunchyroll's 30-character search box: drop subtitles and season markers. */
function searchQuery(title) {
  const full = String(title || '');
  const sep = full.search(/\s*(?::\s|\s[-–—|]\s)/); // a subtitle separator, not "Re:ZERO" or "Laid-Off"
  let q = (sep >= 4 ? full.slice(0, sep) : full)
    .replace(/\b(season|part|cour)\s*\d+\b|\b\d+(st|nd|rd|th)\s+season\b|\b(ii|iii|iv)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  if (!q) q = String(title || '').trim();
  if (q.length > 30) q = q.slice(0, 30).replace(/\s+\S*$/, '');
  return q;
}

/** Shows worth looking up on Crunchyroll: library first, then their seasons, then recommendations. */
function wanted(limit = 25) {
  const candidates = db.prepare(`
    SELECT m.mal_id AS malId, COALESCE(m.title_english, m.title) AS title, 0 AS tier FROM watchlist w JOIN media m ON m.mal_id = w.mal_id
      WHERE m.cr_series_id IS NULL
    UNION ALL
    SELECT m.mal_id, COALESCE(m.title_english, m.title), 1 FROM media_relation r JOIN watchlist w ON w.mal_id = r.mal_id
      JOIN media m ON m.mal_id = r.related_mal_id
      WHERE r.relation_type IN ('SEQUEL','PREQUEL') AND m.cr_series_id IS NULL AND m.status IN ('FINISHED','RELEASING')
    UNION ALL
    SELECT m.mal_id, COALESCE(m.title_english, m.title), 2 FROM media_rec r JOIN media m ON m.mal_id = r.rec_mal_id
      WHERE m.cr_series_id IS NULL AND m.status IN ('FINISHED','RELEASING') AND r.rating >= 5
    ORDER BY tier LIMIT 400`).all();
  const out = []; const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.malId) || !c.title) continue;
    seen.add(c.malId);
    if (ownSeries(c.malId)) continue;
    out.push({ malId: c.malId, query: c.title.slice(0, 100) });
    if (out.length >= limit) break;
  }
  return out;
}

const saveStmt = db.prepare('UPDATE media SET cr_series_id = ?, cr_checked_at = CURRENT_TIMESTAMP WHERE mal_id = ?');

/** Pick the Crunchyroll series matching a show from search candidates ([{id, title}]); '' when none does. */
function pick(malId, candidates) {
  const m = mediaStmt.get(malId);
  if (!m) return null;
  const titles = [m.title_english, m.title].filter(Boolean).map(normalizeTitle);
  for (const c of candidates || []) {
    const t = normalizeTitle(c.title);
    if (!t || !c.id) continue;
    // Exact title, or the series title is the start of a season's title ("Ranking of Kings" for
    // "Ranking of Kings: The Treasure Chest of Courage").
    if (titles.some((x) => x === t || (t.length >= 6 && x.startsWith(`${t} `)))) return String(c.id);
  }
  return '';
}

function applyResults(results) {
  let found = 0; let missing = 0;
  for (const r of results || []) {
    const malId = Number(r.malId);
    if (!malId || !Array.isArray(r.candidates)) continue;
    const id = pick(malId, r.candidates);
    if (id === null) continue;
    saveStmt.run(id, malId);
    if (id) found += 1; else missing += 1;
  }
  return { found, missing };
}

/** Library shows that belong to a Crunchyroll series (by history, mapping, search or AniList link), oldest season first. */
function showsForSeries(seriesId) {
  if (!/^[A-Z0-9]{6,16}$/i.test(seriesId || '')) return { shows: [], nextSeason: null };
  const ids = new Set();
  for (const r of db.prepare(`SELECT DISTINCT mal_id FROM cr_history WHERE series_id = ? AND mal_id > 0
      UNION SELECT DISTINCT r.mal_id FROM cr_season_map r JOIN cr_history h ON h.season_id = r.season_id WHERE h.series_id = ? AND r.mal_id > 0
      UNION SELECT mal_id FROM media WHERE cr_series_id = ? OR external_links LIKE ?`).all(seriesId, seriesId, seriesId, `%/series/${seriesId}%`)) ids.add(r.mal_id);
  const library = require('./library');
  const furthestStmt = db.prepare('SELECT MAX(episode_number) AS n FROM episode_sync WHERE mal_id = ? AND watched = 1');
  // The next episode's own Crunchyroll link, so the card on crunchyroll.com can jump straight to it.
  const epUrlStmt = db.prepare("SELECT url FROM episode_sync WHERE mal_id = ? AND episode_number = ? AND url LIKE '%crunchyroll.com/watch/%'");
  const rows = library.getWatchlist('release_asc').filter((x) => ids.has(x.malId));
  // Progress is the furthest episode watched, like Up Next: gaps in old history aren't "unwatched".
  const shows = rows.map((x) => {
    const aired = x.airedEpisodes ?? x.episodesCount;
    const furthest = furthestStmt.get(x.malId)?.n || 0;
    const watched = x.progress ?? x.watchedCount;
    const nextEpisode = watched < (aired || 0) ? Math.min(furthest + 1, aired) : null;
    return { malId: x.malId, title: x.titleEnglish || x.title, watched, aired, total: x.totalEpisodes,
      nextEpisode, nextEpisodeUrl: nextEpisode ? epUrlStmt.get(x.malId, nextEpisode)?.url || null : null, rating: x.rating, listStatus: x.listStatus, status: x.status };
  });
  // Everything watched: is there a released next season you haven't started?
  let nextSeason = null;
  const last = shows[shows.length - 1];
  if (last && last.aired && last.watched >= last.aired) {
    const next = library.getDetails(last.malId).continueWith;
    if (next && !(next.watched > 0)) nextSeason = { malId: next.malId, title: next.title, inLibrary: next.inLibrary };
  }
  return { shows, nextSeason };
}

module.exports = { seriesFor, notOnCrunchyroll, searchQuery, wanted, applyResults, showsForSeries };
