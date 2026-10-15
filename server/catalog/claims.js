'use strict';
// Crowd-sourced Crunchyroll knowledge as claims with votes (D3, 5.10). An account's own mapping is
// always authoritative for that account; claims only decide what other accounts start from.
// Claims never overwrite catalog-worker data (a series id AniList already gave stays).
const { catalog, accountContext } = require('../db');

const SERIES_AGREE = 2;
const SEASON_AGREE = 3;
const who = () => accountContext.getStore()?.accountId || null;

/** This account says Crunchyroll series `seriesId` is show `malId`. Returns { promoted, conflict }. */
function claimSeries(seriesId, malId) {
  const account = who();
  if (!account || !seriesId || !malId) return { promoted: false };
  catalog.prepare(`INSERT INTO cr_series_claims (series_id, mal_id, account_id) VALUES (?, ?, ?)
    ON CONFLICT(series_id, account_id) DO UPDATE SET mal_id = excluded.mal_id, at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(seriesId, malId, String(account));
  const groups = catalog.prepare('SELECT mal_id, COUNT(*) n FROM cr_series_claims WHERE series_id = ? GROUP BY mal_id').all(seriesId);
  if (groups.length > 1) return { promoted: false, conflict: true };
  if (groups[0].n < SERIES_AGREE) return { promoted: false };
  // Promote only into an empty field: the worker's AniList data wins.
  const r = catalog.prepare("UPDATE media SET cr_series_id = ?, cr_checked_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND COALESCE(cr_series_id, '') = ''").run(seriesId, malId);
  return { promoted: r.changes > 0 };
}

/** This account maps Crunchyroll season `seasonId` to show `malId` with `offset` (a fix, or a confident match). */
function claimSeason(seasonId, malId, offset = 0) {
  const account = who();
  if (!account || !seasonId || !malId) return;
  catalog.prepare(`INSERT INTO cr_season_claims (season_id, mal_id, ep_offset, account_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(season_id, account_id) DO UPDATE SET mal_id = excluded.mal_id, ep_offset = excluded.ep_offset, at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(seasonId, malId, offset || 0, String(account));
}

/** The agreed mapping of a season (3+ accounts, no disagreement), or null. */
function seasonConsensus(seasonId) {
  const groups = catalog.prepare('SELECT mal_id AS mal, ep_offset AS offset, COUNT(*) n FROM cr_season_claims WHERE season_id = ? GROUP BY mal_id, ep_offset').all(seasonId);
  if (groups.length !== 1 || groups[0].n < SEASON_AGREE) return null;
  return { mal: groups[0].mal, offset: groups[0].offset };
}

/** Disagreements for the operator: series or seasons claimed as more than one show. */
function reviewList() {
  return {
    series: catalog.prepare(`SELECT series_id AS id, GROUP_CONCAT(mal_id || ':' || n) AS claims FROM (SELECT series_id, mal_id, COUNT(*) n FROM cr_series_claims GROUP BY series_id, mal_id)
      GROUP BY series_id HAVING COUNT(*) > 1`).all(),
    seasons: catalog.prepare(`SELECT season_id AS id, GROUP_CONCAT(mal_id || '+' || ep_offset || ':' || n) AS claims FROM (SELECT season_id, mal_id, ep_offset, COUNT(*) n FROM cr_season_claims GROUP BY season_id, mal_id, ep_offset)
      GROUP BY season_id HAVING COUNT(*) > 1`).all()
  };
}

/** Remove every claim about a series or a season (operator). */
function purge(kind, id) {
  if (kind === 'series') catalog.prepare('DELETE FROM cr_series_claims WHERE series_id = ?').run(id);
  else catalog.prepare('DELETE FROM cr_season_claims WHERE season_id = ?').run(id);
}

module.exports = { claimSeries, claimSeason, seasonConsensus, reviewList, purge, SERIES_AGREE, SEASON_AGREE };
