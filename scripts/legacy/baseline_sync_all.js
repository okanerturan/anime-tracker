const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8098);
const DELAY_MS = Number(process.env.DELAY_MS || 700);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 4);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callSync(malId, title) {
  const url = `http://localhost:${PORT}/api/sync-episodes?malId=${malId}&title=${encodeURIComponent(title)}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 180)}`);
    }
    return res.json();
  }
  throw new Error('Rate limited too many times');
}

(async () => {
  const db = new DatabaseSync('data/anime-tracker.db');
  const watchlist = db.prepare(`
    SELECT a.mal_id AS malId, a.title
    FROM watchlist w
    JOIN anime a ON a.mal_id = w.mal_id
    ORDER BY w.added_at DESC
  `).all();

  console.log(`watchlist_count=${watchlist.length}`);

  const ok = [];
  const failed = [];

  for (let i = 0; i < watchlist.length; i++) {
    const item = watchlist[i];
    try {
      const sync = await callSync(item.malId, item.title);
      ok.push({
        malId: item.malId,
        title: item.title,
        episodes: sync.episodesCount,
        watched: sync.watchedCount,
        unwatched: sync.unwatchedCount,
      });
    } catch (err) {
      failed.push({ malId: item.malId, title: item.title, error: String(err.message || err) });
    }

    if ((i + 1) % 10 === 0 || i + 1 === watchlist.length) {
      const watchedTotal = ok.reduce((s, x) => s + (x.watched || 0), 0);
      const episodeTotal = ok.reduce((s, x) => s + (x.episodes || 0), 0);
      console.log(`progress ${i + 1}/${watchlist.length} ok=${ok.length} failed=${failed.length} watched=${watchedTotal}/${episodeTotal}`);
    }

    await sleep(DELAY_MS);
  }

  const fs = require('fs');
  fs.writeFileSync('data/baseline-sync-ok.json', JSON.stringify(ok, null, 2));
  fs.writeFileSync('data/baseline-sync-failed.json', JSON.stringify(failed, null, 2));

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM watchlist) AS watchlist,
      (SELECT COUNT(*) FROM episode_sync) AS episodes,
      (SELECT COUNT(*) FROM episode_sync WHERE watched = 1) AS watched,
      (SELECT COUNT(*) FROM episode_sync WHERE watched = 0) AS unwatched,
      (SELECT COUNT(*) FROM episode_sync WHERE image_blob IS NOT NULL) AS images
  `).get();

  console.log(JSON.stringify({ ok: ok.length, failed: failed.length, counts }, null, 2));
})();
