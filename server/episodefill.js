'use strict';
// The server-side episode sources, run for one show after AniList's streaming list and before the
// Jikan fallback (sync.syncEpisodes): TMDB (by the ID map, after the numbering check), then Kitsu for
// what is still empty. Facts go through the shared merge, so a source only wins the fields its rank
// allows. Each source is asked again only when it is due: airing shows every 12 hours while an aired
// episode lacks a title or still, finished shows at most monthly while one does, never otherwise.
const { catalog } = require('./db');
const episodes = require('./episodes');
const images = require('./images');
const { lineUp, tmdbGroup, lineUpAcross, seasonEpisode, tmdbChain } = require('./numbering');

const HOUR = 3600e3;
const getFetchStmt = catalog.prepare('SELECT fetched_at, outcome FROM catalog_episode_fetch WHERE mal_id = ? AND source = ?');
const putFetchStmt = catalog.prepare(`INSERT INTO catalog_episode_fetch (mal_id, source, fetched_at, outcome) VALUES (?, ?, ?, ?)
  ON CONFLICT(mal_id, source) DO UPDATE SET fetched_at = excluded.fetched_at, outcome = excluded.outcome`);
const idsStmt = catalog.prepare('SELECT kitsu_id FROM catalog_idmap WHERE mal_id = ?');
const gapsStmt = catalog.prepare(`SELECT episode_number n, title IS NULL AS noTitle, (image_url IS NULL AND image_blob IS NULL) AS noStill
  FROM catalog_episodes WHERE mal_id = ? AND episode_number <= ?`);

/** Aired episodes (1..aired) still missing a title or a still in the shared record. */
function gaps(malId, aired) {
  if (!aired) return { titles: 0, stills: 0 };
  const rows = new Map(gapsStmt.all(malId, aired).map((r) => [r.n, r]));
  let titles = 0; let stills = 0;
  for (let n = 1; n <= aired; n += 1) {
    const r = rows.get(n);
    if (!r || r.noTitle) titles += 1;
    if (!r || r.noStill) stills += 1;
  }
  return { titles, stills };
}

function due(malId, source, { airing, missing, now }) {
  const last = getFetchStmt.get(malId, source);
  if (!last) return true;
  if (!missing) return false;
  return now - Date.parse(last.fetched_at) >= (airing ? 12 * HOUR : 30 * 24 * HOUR);
}

const still = (url) => (url && images.isAllowed(url) ? url : null);
const record = (malId, source, outcome, now) => putFetchStmt.run(malId, source, new Date(now).toISOString(), outcome);

/**
 * Run TMDB then Kitsu for one show. `media`: its catalog row; `aired`: aired episode count. Returns
 * { tmdb, kitsu } outcomes ('ok', 'empty', 'unmapped', 'skip: …', 'paused', 'not due', or an error).
 */
async function fill(malId, media, aired, { tmdb = require('./sources/tmdb'), kitsu = require('./sources/kitsu'), now = Date.now() } = {}) {
  const out = { tmdb: 'not due', kitsu: 'not due', titles: 0, stills: 0 };
  const airing = media?.status === 'RELEASING';
  const total = media?.episodes || null;
  const upTo = Math.max(aired || 0, media?.status === 'FINISHED' ? total || 0 : 0);
  if (!upTo) return { ...out, tmdb: 'nothing aired', kitsu: 'nothing aired' };
  const apply = (list, source, offset = 0) => {
    for (let n = 1; n <= upTo; n += 1) {
      const e = list.find((x) => x.episodeNumber === n + offset);
      if (!e) continue;
      const changed = episodes.merge(malId, n, { title: e.title, aired: e.aired, imageUrl: still(e.imageUrl) }, source, { now: new Date(now).toISOString() });
      if (changed.includes('title')) out.titles += 1;
      if (changed.includes('image')) out.stills += 1;
    }
  };

  // TMDB: outranks AniList for titles and stills, so it is asked once even when nothing is missing.
  const g0 = gaps(malId, upTo);
  if (due(malId, 'tmdb', { airing, missing: g0.titles + g0.stills, now })) {
    if (!tmdb.isAvailable()) out.tmdb = 'paused';
    else {
      const group = tmdbGroup(malId);
      if (!group) { out.tmdb = 'unmapped'; record(malId, 'tmdb', out.tmdb, now); }
      else {
        // When the mapped season doesn't line up (or doesn't exist), read TMDB's seasons as one run.
        const across = async (why) => {
          const c = tmdbChain(malId);
          const counts = c ? await tmdb.seasons(c.tvId) : [];
          const fit = c ? lineUpAcross(c.chain, counts, malId) : { skip: 'no series' };
          if (fit.skip) return `skip: ${why}; ${fit.skip}`;
          const seasons = new Map();
          const list = [];
          for (let n = 1; n <= upTo; n += 1) {
            const at = seasonEpisode(counts, fit.offset + n);
            if (!at) break;
            if (!seasons.has(at.season)) seasons.set(at.season, await tmdb.season(c.tvId, at.season));
            const e = seasons.get(at.season).find((x) => x.episodeNumber === at.episode);
            if (e) list.push({ ...e, episodeNumber: n });
          }
          apply(list, 'tmdb');
          return 'ok (across seasons)';
        };
        try {
          let list = null;
          try { list = await tmdb.season(group.tvId, group.season); } catch (err) { if (!err.notFound) throw err; }
          const fit = list ? lineUp(group.group, list.length, malId, { startsSeason: group.startsSeason }) : { skip: 'TMDB has no such season' };
          if (fit.skip) out.tmdb = await across(fit.skip);
          else { apply(list, 'tmdb', fit.offset); out.tmdb = list.length ? 'ok' : 'empty'; }
          record(malId, 'tmdb', out.tmdb, now);
        } catch (err) {
          out.tmdb = err.paused ? 'paused' : String(err.message || err);
        }
      }
    }
  }

  // Kitsu: only for what is still missing.
  const g1 = gaps(malId, upTo);
  if (g1.titles + g1.stills && due(malId, 'kitsu', { airing, missing: g1.titles + g1.stills, now })) {
    const kitsuId = idsStmt.get(malId)?.kitsu_id;
    if (!kitsuId) { out.kitsu = 'unmapped'; record(malId, 'kitsu', out.kitsu, now); }
    else if (!kitsu.isAvailable()) out.kitsu = 'paused';
    else {
      try {
        const { count, episodes: list } = await kitsu.episodes(kitsuId);
        const numbers = list.map((e) => e.episodeNumber);
        if (!list.length) out.kitsu = 'empty';
        // Per MAL entry: the count must match a finished show; any show's numbering must start at 1
        // (not continue a prequel's) and stay within its total.
        else if (media?.status === 'FINISHED' && total && count !== total) out.kitsu = `skip: Kitsu lists ${count}, MAL ${total}`;
        else if (Math.min(...numbers) !== 1) out.kitsu = `skip: Kitsu numbering starts at ${Math.min(...numbers)}`;
        else if (total && Math.max(...numbers) > total) out.kitsu = `skip: Kitsu numbers past ${total}`;
        else { apply(list, 'kitsu'); out.kitsu = 'ok'; }
        record(malId, 'kitsu', out.kitsu, now);
      } catch (err) {
        out.kitsu = err.paused ? 'paused' : String(err.message || err);
        if (err.notFound) record(malId, 'kitsu', 'skip: Kitsu has no such anime', now);
      }
    }
  }
  return out;
}

const skippedStmt = catalog.prepare(`SELECT f.mal_id AS malId, f.source, f.outcome, f.fetched_at AS at, m.title
  FROM catalog_episode_fetch f LEFT JOIN media m ON m.mal_id = f.mal_id WHERE f.outcome LIKE 'skip:%' ORDER BY f.fetched_at DESC LIMIT 200`);
/** Shows a source skipped because its numbering didn't line up (the review list). */
const skipped = () => skippedStmt.all().map((r) => ({ ...r, reason: r.outcome.slice(6) }));

function status() {
  return { tmdb: require('./sources/tmdb').status(), kitsu: require('./sources/kitsu').status(), skipped: skipped().length };
}

module.exports = { fill, gaps, skipped, status };
