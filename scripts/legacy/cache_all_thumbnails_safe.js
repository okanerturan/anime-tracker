const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const PORT = Number(process.env.PORT || 8100);
const DELAY_MS = Number(process.env.DELAY_MS || 1300);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function cacheOne(malId) {
  const url = `http://localhost:${PORT}/api/cache-thumbnails`;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ malId })
    });

    if (res.status === 429 || res.status >= 500) {
      await sleep(1200 * (i + 1));
      continue;
    }

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 180)}`);
    }

    return res.json();
  }

  throw new Error('retry_exhausted');
}

(async () => {
  const db = new DatabaseSync('data/anime-tracker.db');
  const ids = db.prepare('select mal_id malId from watchlist order by mal_id').all().map((r) => r.malId);

  const ok = [];
  const failed = [];

  console.log(`watchlist_count=${ids.length}`);

  for (let i = 0; i < ids.length; i++) {
    const malId = ids[i];
    try {
      const out = await cacheOne(malId);
      ok.push({ malId, downloaded: out.total || 0 });
    } catch (err) {
      failed.push({ malId, error: String(err.message || err) });
    }

    if ((i + 1) % 10 === 0 || i + 1 === ids.length) {
      const downloadedTotal = ok.reduce((s, x) => s + (x.downloaded || 0), 0);
      console.log(`progress ${i + 1}/${ids.length} ok=${ok.length} failed=${failed.length} downloaded=${downloadedTotal}`);
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync('data/thumb-cache-ok.json', JSON.stringify(ok, null, 2));
  fs.writeFileSync('data/thumb-cache-failed.json', JSON.stringify(failed, null, 2));

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM episode_sync WHERE image_blob IS NOT NULL) AS images,
      (SELECT COUNT(*) FROM episode_sync) AS episodes,
      (SELECT COUNT(*) FROM watchlist) AS watchlist
  `).get();

  console.log(JSON.stringify({ ok: ok.length, failed: failed.length, counts }, null, 2));
})();
