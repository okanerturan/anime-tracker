'use strict';
// TMDB (themoviedb.org): episode titles, air dates and stills by TV id and season, found through the ID
// map. Needs TMDB_API_READ_ACCESS_TOKEN (the v4 read token, sent as a bearer). 20 requests a minute
// (TMDB allows far more); three failures in a row pause it for 30 minutes; a 401 pauses it for a day
// (the token is wrong, retrying won't help). Without a token the source is simply off.
const { createLimiter } = require('./limiter');

const BASE = 'https://api.themoviedb.org/3';
const STILL_BASE = 'https://image.tmdb.org/t/p/w300';
const DAY_MS = 86400e3;

function createTmdb({ token = process.env.TMDB_API_READ_ACCESS_TOKEN, fetchImpl = null, now, sleep } = {}) {
  const limiter = createLimiter({ name: 'TMDB', perMinute: 20, now, sleep });
  const doFetch = fetchImpl || require('../upstream').fetch;
  const isAvailable = () => Boolean(token) && limiter.isAvailable();

  async function get(pathname) {
    if (!token) throw Object.assign(new Error('TMDB off (no TMDB_API_READ_ACCESS_TOKEN)'), { paused: true });
    return limiter.run(async () => {
      let res;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        res = await doFetch(`${BASE}${pathname}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15e3) });
        if (res.status !== 429) break;
        // Over TMDB's own limit: wait what it asks (capped) and try once more.
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 30);
        await (sleep || require('../util').sleep)(wait * 1000);
      }
      if (res.status === 401) { limiter.pause('TMDB refused the token (401)', DAY_MS); throw Object.assign(new Error('TMDB 401'), { notFailure: true }); }
      if (res.status === 404) throw Object.assign(new Error('TMDB 404'), { notFailure: true, notFound: true });
      if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
      return res.json();
    });
  }

  /** The show's seasons: [{ season, episodes }] (season 0 = specials, left out). */
  async function seasons(tvId) {
    const json = await get(`/tv/${Number(tvId)}?language=en-US`);
    return (json.seasons || []).filter((s) => s.season_number > 0).map((s) => ({ season: s.season_number, episodes: s.episode_count || 0 }));
  }

  /** One season's episodes: [{ episodeNumber, title, aired, imageUrl }] in TMDB's numbering. */
  async function season(tvId, seasonNumber) {
    const json = await get(`/tv/${Number(tvId)}/season/${Number(seasonNumber)}?language=en-US`);
    return (json.episodes || []).map((e) => ({
      episodeNumber: e.episode_number,
      // TMDB fills unknown titles with "Episode 7"; that's a placeholder, not a title.
      title: e.name && !/^Episode \d+$/i.test(e.name.trim()) ? e.name.trim() : null,
      aired: /^\d{4}-\d{2}-\d{2}$/.test(e.air_date || '') ? e.air_date : null,
      imageUrl: e.still_path ? `${STILL_BASE}${e.still_path}` : null
    }));
  }

  return { isAvailable, seasons, season, status: () => ({ ...limiter.status(), available: isAvailable(), configured: Boolean(token) }) };
}

const tmdb = createTmdb();
module.exports = { ...tmdb, createTmdb, STILL_BASE };
