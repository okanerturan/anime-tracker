const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/anime-tracker.db');
const delayMs = Number(process.env.DELAY_MS || 650);
const maxRetries = Number(process.env.MAX_RETRIES || 5);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchAnime(malId) {
  const url = `https://api.jikan.moe/v4/anime/${malId}`;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/1.0' } });
    if (res.status === 429) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
    }
    const json = await res.json();
    return json.data || null;
  }
  throw new Error('retry_exhausted');
}

const upsert = db.prepare(`
INSERT INTO anime (mal_id, title, title_english, image_url, synopsis, total_episodes, updated_at)
VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(mal_id) DO UPDATE SET
  title=excluded.title,
  title_english=excluded.title_english,
  image_url=excluded.image_url,
  synopsis=excluded.synopsis,
  total_episodes=excluded.total_episodes,
  updated_at=CURRENT_TIMESTAMP
`);

(async () => {
  const rows = db.prepare("SELECT mal_id AS malId, title FROM anime WHERE image_url IS NULL OR trim(image_url)='' ORDER BY mal_id").all();
  const ok = [];
  const failed = [];

  console.log(`to_backfill=${rows.length}`);

  for (let i = 0; i < rows.length; i++) {
    const { malId, title } = rows[i];
    try {
      const d = await fetchAnime(malId);
      if (!d) {
        failed.push({ malId, title, error: 'empty_response' });
      } else {
        upsert.run(
          malId,
          d.title || title,
          d.title_english || '',
          d.images?.jpg?.large_image_url || d.images?.jpg?.image_url || '',
          d.synopsis || 'No synopsis available.',
          d.episodes ?? null
        );
        ok.push(malId);
      }
    } catch (err) {
      failed.push({ malId, title, error: String(err.message || err) });
    }

    if ((i + 1) % 20 === 0 || i + 1 === rows.length) {
      console.log(`progress ${i + 1}/${rows.length} ok=${ok.length} failed=${failed.length}`);
    }
    await sleep(delayMs);
  }

  const fs = require('fs');
  fs.writeFileSync('data/backfill-ok.json', JSON.stringify(ok, null, 2));
  fs.writeFileSync('data/backfill-failed.json', JSON.stringify(failed, null, 2));

  const noimg = db.prepare("SELECT count(*) n FROM anime WHERE image_url IS NULL OR trim(image_url)='' ").get().n;
  console.log(JSON.stringify({ updated: ok.length, failed: failed.length, remainingWithoutImage: noimg }, null, 2));
})();
