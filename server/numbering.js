'use strict';
// Does a source's episode numbering line up with a MAL entry's? Checked before any TMDB episode is
// used (D5). TMDB numbers by its own seasons; MAL splits cours into separate entries, and Fribb's map
// often points both halves of a split cour at the same TMDB season. So the unit is a group: the MAL
// entries of one series (prequel/sequel chain) that map to the same TMDB TV id and season, in order.
// Each entry's TMDB episodes then start after the ones before it. The group must account for the
// whole TMDB season (finished) or fit inside it (airing); otherwise nothing is guessed. One exception:
// when the group starts the TMDB season (its first entry has no prequel, or the prequel is in TMDB's
// previous season), TMDB may list more episodes than MAL has so far (the next part isn't on MAL or in
// the map yet), and the group's episodes are simply TMDB's first ones.
const { db } = require('./db');

/**
 * `group`: [{ malId, episodes (total or null), aired, finished }] in airing order; `tmdbCount`: episodes
 * in the TMDB season; `startsSeason`: the group begins the TMDB season. Returns { offset } for `malId`
 * (TMDB episode = offset + MAL episode), or { skip: reason }.
 */
function lineUp(group, tmdbCount, malId, { startsSeason = false } = {}) {
  const at = group.findIndex((g) => g.malId === malId);
  if (at < 0) return { skip: 'not in its group' };
  if (!tmdbCount) return { skip: 'TMDB season has no episodes' };
  let before = 0;
  for (const g of group.slice(0, at)) {
    if (!g.finished || !g.episodes) return { skip: 'an earlier part of the same TMDB season has no final count' };
    before += g.episodes;
  }
  const self = group[at];
  const later = group.slice(at + 1);
  if (later.length || self.finished) {
    // The whole group must make up the TMDB season exactly.
    let total = before;
    for (const g of [self, ...later]) {
      if (g.finished && g.episodes) total += g.episodes;
      else if (g === group.at(-1)) { if (before + (g.aired || 0) > tmdbCount) return { skip: 'TMDB season is shorter than the aired episodes' }; total = null; break; }
      else return { skip: 'a part of the same TMDB season has no final count' };
    }
    if (total != null && total !== tmdbCount && !(startsSeason && total < tmdbCount)) return { skip: `${total} MAL episodes in this TMDB season, TMDB lists ${tmdbCount}` };
    return { offset: before };
  }
  // Airing, the last part: its aired episodes must fit, and TMDB can't list more than its total.
  if (before + (self.aired || 0) > tmdbCount) return { skip: 'TMDB season is shorter than the aired episodes' };
  if (self.episodes && tmdbCount > before + self.episodes && !startsSeason) return { skip: `TMDB lists ${tmdbCount}, more than ${before + self.episodes}` };
  return { offset: before };
}

const airedOf = (m) => require('./library').airedCount(m) ?? 0;
const mediaStmt = db.prepare('SELECT mal_id, episodes, status, next_airing_episode, start_date, format, is_full FROM media WHERE mal_id = ?');
const relStmt = db.prepare(`SELECT r.related_mal_id AS id FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id
  WHERE r.mal_id = ? AND r.relation_type = ? AND m.format IN ('TV','ONA','TV_SHORT')`);
const mapStmt = db.prepare('SELECT tmdb_tv_id, tmdb_season FROM catalog_idmap WHERE mal_id = ?');

/** The MAL entries sharing `malId`'s TMDB season, in airing order (from the catalog). */
function tmdbGroup(malId) {
  const map = mapStmt.get(malId);
  if (!map?.tmdb_tv_id) return null;
  const season = map.tmdb_season ?? 1;
  const ids = new Set([malId]);
  const walk = (id, type) => {
    for (let hops = 0; hops < 8; hops += 1) {
      const next = relStmt.all(id, type).map((r) => r.id).find((x) => !ids.has(x));
      const m = next && mapStmt.get(next);
      if (!m || m.tmdb_tv_id !== map.tmdb_tv_id || (m.tmdb_season ?? 1) !== season) return;
      ids.add(next); id = next;
    }
  };
  walk(malId, 'PREQUEL'); walk(malId, 'SEQUEL');
  const group = [...ids].map((id) => {
    const m = mediaStmt.get(id) || { mal_id: id };
    return { malId: id, episodes: m.episodes || null, aired: airedOf(m), finished: m.status === 'FINISHED', start: m.start_date || '9999' };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.malId - b.malId);
  // Does the group begin the TMDB season? Its first entry has no TV prequel, or every TV prequel is
  // mapped to the same show's previous season. "No prequel" counts only once its relations are fetched.
  const prequels = relStmt.all(group[0].malId, 'PREQUEL').map((r) => mapStmt.get(r.id));
  const startsSeason = season >= 1 && ((!prequels.length && Boolean(mediaStmt.get(group[0].malId)?.is_full))
    || prequels.every((m) => m && m.tmdb_tv_id === map.tmdb_tv_id && (m.tmdb_season ?? 1) === season - 1));
  return { tvId: map.tmdb_tv_id, season, group, startsSeason };
}

/**
 * The fallback when a show doesn't line up with its mapped TMDB season: TMDB's seasons read as one
 * continuous run of episodes. `chain`: the series' MAL entries mapped to the same TMDB show (any
 * season), in airing order; `seasonCounts`: [{ season, episodes }] from TMDB. The show starts after the
 * earlier entries (each needs a final count). A finished show must end exactly where a TMDB season ends
 * (Gintama: 201 MAL episodes = TMDB seasons 1-4); an airing one must start exactly where one starts.
 * Returns { offset } in that continuous numbering, or { skip: reason }.
 */
function lineUpAcross(chain, seasonCounts, malId) {
  const at = chain.findIndex((g) => g.malId === malId);
  if (at < 0) return { skip: 'not in its series' };
  let before = 0;
  for (const g of chain.slice(0, at)) {
    if (!g.finished || !g.episodes) return { skip: 'an earlier season has no final count' };
    before += g.episodes;
  }
  const bounds = [0];
  for (const c of [...seasonCounts].sort((x, y) => x.season - y.season)) bounds.push(bounds.at(-1) + (c.episodes || 0));
  const total = bounds.at(-1);
  const self = chain[at];
  if (self.finished) {
    if (!self.episodes) return { skip: 'no final count' };
    const end = before + self.episodes;
    if (end > total || !bounds.includes(end)) return { skip: `episodes ${before + 1}-${end} across TMDB seasons don't end where a season ends` };
    return { offset: before };
  }
  if (!bounds.includes(before) || before + (self.aired || 0) > total) return { skip: 'across TMDB seasons, this season doesn\'t start where one starts' };
  return { offset: before };
}

/** In continuous numbering, which TMDB season and episode is episode `n`? (`bounds` as above.) */
function seasonEpisode(seasonCounts, n) {
  let start = 0;
  for (const c of [...seasonCounts].sort((x, y) => x.season - y.season)) {
    if (n <= start + c.episodes) return { season: c.season, episode: n - start };
    start += c.episodes;
  }
  return null;
}

/** The series' MAL entries mapped to `malId`'s TMDB show, any season, in airing order. */
function tmdbChain(malId) {
  const map = mapStmt.get(malId);
  if (!map?.tmdb_tv_id) return null;
  const ids = new Set([malId]);
  const walk = (id, type) => {
    for (let hops = 0; hops < 12; hops += 1) {
      const next = relStmt.all(id, type).map((r) => r.id).find((x) => !ids.has(x));
      if (!next || mapStmt.get(next)?.tmdb_tv_id !== map.tmdb_tv_id) return;
      ids.add(next); id = next;
    }
  };
  walk(malId, 'PREQUEL'); walk(malId, 'SEQUEL');
  const chain = [...ids].map((id) => {
    const m = mediaStmt.get(id) || { mal_id: id };
    return { malId: id, episodes: m.episodes || null, aired: airedOf(m), finished: m.status === 'FINISHED', start: m.start_date || '9999' };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.malId - b.malId);
  return { tvId: map.tmdb_tv_id, chain };
}

module.exports = { lineUp, tmdbGroup, lineUpAcross, seasonEpisode, tmdbChain };
