'use strict';
// Cross-site ids for every show (catalog_idmap): MyAnimeList -> AniList, Kitsu, TMDB (TV id and
// season) and TVDB, from Fribb's anime-lists (github.com/Fribb/anime-lists, updated weekly). Loaded at
// most once a week with If-None-Match; a failed or unreadable download keeps the map we have.
const { catalog } = require('../db');
const state = require('../state');

const URL = process.env.IDMAP_URL || 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const WEEK_MS = 7 * 86400e3;

const countStmt = catalog.prepare('SELECT COUNT(*) n FROM catalog_idmap');
const putStmt = catalog.prepare(`INSERT INTO catalog_idmap (mal_id, anilist_id, kitsu_id, tmdb_tv_id, tmdb_season, tvdb_id, updated_at)
  VALUES (@mal_id, @anilist_id, @kitsu_id, @tmdb_tv_id, @tmdb_season, @tvdb_id, @updated_at)
  ON CONFLICT(mal_id) DO UPDATE SET anilist_id = excluded.anilist_id, kitsu_id = excluded.kitsu_id, tmdb_tv_id = excluded.tmdb_tv_id,
    tmdb_season = excluded.tmdb_season, tvdb_id = excluded.tvdb_id, updated_at = excluded.updated_at`);
const getStmt = catalog.prepare('SELECT * FROM catalog_idmap WHERE mal_id = ?');

const id = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** One row per MAL id from Fribb's entries; when two entries share a MAL id, known ids fill the gaps. */
function rowsFrom(entries) {
  const out = new Map();
  for (const e of entries) {
    const row = {
      anilist_id: id(e.anilist_id), kitsu_id: id(e.kitsu_id), tmdb_tv_id: id(e.themoviedb_id?.tv),
      tmdb_season: Number.isInteger(e.season?.tmdb) ? e.season.tmdb : null, tvdb_id: id(e.tvdb_id)
    };
    for (const mal of [].concat(e.mal_id ?? [])) {
      if (!id(mal)) continue;
      const prev = out.get(mal);
      if (!prev) { out.set(mal, { mal_id: mal, ...row }); continue; }
      for (const k of Object.keys(row)) if (prev[k] == null) prev[k] = row[k];
      // The TMDB season belongs to its TV id: never pair one entry's id with another's season.
      if (prev.tmdb_tv_id === row.tmdb_tv_id && prev.tmdb_season == null) prev.tmdb_season = row.tmdb_season;
    }
  }
  return [...out.values()];
}

/**
 * Download and load the map when it is a week old (or `force`). Returns { status: 'loaded' |
 * 'unchanged' | 'fresh' | 'failed', rows }. `fetchImpl` is for tests and the upstream-DNS fetch.
 */
async function refresh({ fetchImpl = require('../upstream').fetch, force = false, now = Date.now() } = {}) {
  const last = state.get('idmap');
  const have = countStmt.get().n;
  if (!force && have && last?.checkedAt && now - Date.parse(last.checkedAt) < WEEK_MS) return { status: 'fresh', rows: have };
  const checkedAt = new Date(now).toISOString();
  try {
    const headers = { 'User-Agent': 'Tsuzuku (anime tracker; github.com/okanerturan/anime-tracker)' };
    if (have && last?.etag) headers['If-None-Match'] = last.etag;
    const res = await fetchImpl(URL, { headers, signal: AbortSignal.timeout(120e3) });
    if (res.status === 304) { state.set('idmap', { ...last, checkedAt }); return { status: 'unchanged', rows: have }; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();
    if (!Array.isArray(entries) || entries.length < 1000) throw new Error(`unexpected map (${Array.isArray(entries) ? entries.length : typeof entries} entries)`);
    const rows = rowsFrom(entries);
    catalog.transaction(() => { for (const r of rows) putStmt.run({ ...r, updated_at: checkedAt }); })();
    state.set('idmap', { etag: res.headers.get('etag') || null, checkedAt, loadedAt: checkedAt, rows: rows.length });
    return { status: 'loaded', rows: rows.length };
  } catch (err) {
    // Keep the old map; try again at the next cycle rather than in a week.
    state.set('idmap', { ...(last || {}), lastError: String(err.message || err), failedAt: checkedAt });
    return { status: 'failed', rows: have, error: String(err.message || err) };
  }
}

/** The ids we know for a show, or null. */
const lookup = (malId) => getStmt.get(malId) || null;

module.exports = { refresh, lookup, rowsFrom, URL };
