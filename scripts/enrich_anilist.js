'use strict';
// Fetch AniList metadata (genres, tags, airing, relations, recommendations, streaming episodes)
// for every anime in the library. Usage: node scripts/enrich_anilist.js [--stale-hours=24]
const { db } = require('../server/db');
const anilist = require('../server/sources/anilist');

(async () => {
  const staleArg = process.argv.find((a) => a.startsWith('--stale-hours='));
  const staleHours = staleArg ? Number(staleArg.split('=')[1]) : 0;
  const ids = db.prepare(`
    SELECT w.mal_id AS id FROM watchlist w LEFT JOIN media m ON m.mal_id = w.mal_id
    WHERE m.is_full IS NOT 1 OR ? = 0 OR m.fetched_at < datetime('now', ?)
  `).all(staleHours, `-${staleHours} hours`).map((r) => r.id);
  console.log(`fetching ${ids.length} titles from AniList`);
  const result = await anilist.fetchFullByMalIds(ids, (done, total) => console.log(`  ${done}/${total}`));
  console.log(JSON.stringify(result));
})().catch((err) => { console.error(err); process.exit(1); });
