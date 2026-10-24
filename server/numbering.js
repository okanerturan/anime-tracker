'use strict';
// Does a source's episode numbering line up with a MAL entry's? Checked before any TMDB episode is
// used (D5). TMDB numbers by its own seasons; MAL splits cours into separate entries, and Fribb's map
// often points both halves of a split cour at the same TMDB season. So the unit is a group: the MAL
// entries of one series (prequel/sequel chain) that map to the same TMDB TV id and season, in order.
// Each entry's TMDB episodes then start after the ones before it. The group must account for the
// whole TMDB season (finished) or fit inside it (airing); otherwise nothing is guessed.
const { db } = require('./db');

/**
 * `group`: [{ malId, episodes (total or null), aired, finished }] in airing order; `tmdbCount`: episodes
 * in the TMDB season. Returns { offset } for `malId` (TMDB episode = offset + MAL episode), or
 * { skip: reason }.
 */
function lineUp(group, tmdbCount, malId) {
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
    if (total != null && total !== tmdbCount) return { skip: `${total} MAL episodes in this TMDB season, TMDB lists ${tmdbCount}` };
    return { offset: before };
  }
  // Airing, the last part: its aired episodes must fit, and TMDB can't list more than its total.
  if (before + (self.aired || 0) > tmdbCount) return { skip: 'TMDB season is shorter than the aired episodes' };
  if (self.episodes && tmdbCount > before + self.episodes) return { skip: `TMDB lists ${tmdbCount}, more than ${before + self.episodes}` };
  return { offset: before };
}

const airedOf = (m) => require('./library').airedCount(m) ?? 0;
const mediaStmt = db.prepare('SELECT mal_id, episodes, status, next_airing_episode, start_date, format FROM media WHERE mal_id = ?');
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
  return { tvId: map.tmdb_tv_id, season, group };
}

module.exports = { lineUp, tmdbGroup };
