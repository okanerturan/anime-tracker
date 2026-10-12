const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/anime-tracker.db');
const titles = JSON.parse(fs.readFileSync('data/crunchyroll-history-live-titles.json', 'utf8'));

const delayMs = Number(process.env.DELAY_MS || 900);
const maxRetries = Number(process.env.MAX_RETRIES || 4);

const upsertAnimeStmt = db.prepare(`
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
const addWatchlistStmt = db.prepare(`
INSERT INTO watchlist (mal_id, added_at) VALUES (?, CURRENT_TIMESTAMP)
ON CONFLICT(mal_id) DO NOTHING
`);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function searchAnime(query) {
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=8&sfw=true`;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/1.0' } });
    if (res.status === 429) {
      const wait = 1500 * (attempt + 1);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 120)}`);
    }
    const json = await res.json();
    return json.data || [];
  }
  throw new Error('Exceeded retry limit after rate-limit responses');
}

function pickBestMatch(inputTitle, rows) {
  if (!rows.length) return null;
  const key = normalizeTitle(inputTitle);
  const exact = rows.find((x) => normalizeTitle(x.title) === key || normalizeTitle(x.title_english) === key);
  return exact || rows[0];
}

(async () => {
  const inWatchlist = new Set(db.prepare('SELECT mal_id FROM watchlist').all().map((r) => r.mal_id));
  const animeByTitle = new Set(db.prepare('SELECT lower(title) t FROM anime').all().map((r) => r.t));

  const pending = titles.filter((t) => !animeByTitle.has(String(t).toLowerCase()));

  const imported = [];
  const missing = [];
  const failed = [];

  console.log(`total_titles=${titles.length} pending=${pending.length} already_in_db=${titles.length - pending.length}`);

  for (let i = 0; i < pending.length; i++) {
    const title = pending[i];
    try {
      const rows = await searchAnime(title);
      const best = pickBestMatch(title, rows);
      if (!best) {
        missing.push(title);
      } else {
        upsertAnimeStmt.run(
          best.mal_id,
          best.title,
          best.title_english || '',
          best.images?.jpg?.large_image_url || best.images?.jpg?.image_url || '',
          best.synopsis || 'No synopsis available.',
          best.episodes ?? null
        );
        addWatchlistStmt.run(best.mal_id);
        inWatchlist.add(best.mal_id);
        imported.push({ inputTitle: title, malId: best.mal_id, title: best.title });
      }
    } catch (err) {
      failed.push({ title, error: String(err.message || err) });
    }

    if ((i + 1) % 10 === 0 || i + 1 === pending.length) {
      console.log(`progress ${i + 1}/${pending.length} imported=${imported.length} missing=${missing.length} failed=${failed.length}`);
    }
    await sleep(delayMs);
  }

  fs.writeFileSync('data/imported-from-history-log.json', JSON.stringify(imported, null, 2));
  fs.writeFileSync('data/missing-from-history-log.json', JSON.stringify(missing, null, 2));
  fs.writeFileSync('data/failed-from-history-log.json', JSON.stringify(failed, null, 2));

  const finalCounts = {
    anime: db.prepare('select count(*) n from anime').get().n,
    watchlist: db.prepare('select count(*) n from watchlist').get().n,
  };

  console.log(JSON.stringify({
    imported: imported.length,
    missing: missing.length,
    failed: failed.length,
    finalCounts,
  }, null, 2));
})();
