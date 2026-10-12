const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const db = new DatabaseSync('data/anime-tracker.db');
const DELAY_MS = Number(process.env.DELAY_MS || 500);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 4);

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

async function fetchJSON(url) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/1.0' } });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (i + 1));
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 140)}`);
    }
    return res.json();
  }
  throw new Error('retry_exhausted');
}

function isLikelyMainline(title) {
  const t = String(title || '').toLowerCase();
  const bad = ['cm', 'pv', 'special', 'recap', 'digest', 'trailer', 'manner movie'];
  return !bad.some((x) => t.includes(x));
}

(async () => {
  const existing = new Set(db.prepare('SELECT mal_id FROM watchlist').all().map((r) => r.mal_id));
  const seedIds = [...existing];

  const added = [];
  const failed = [];

  for (let i = 0; i < seedIds.length; i++) {
    const malId = seedIds[i];
    try {
      const rel = await fetchJSON(`https://api.jikan.moe/v4/anime/${malId}/relations`);
      const relations = Array.isArray(rel.data) ? rel.data : [];
      const targets = [];

      for (const r of relations) {
        const relName = String(r.relation || '');
        if (!['Sequel', 'Prequel'].includes(relName)) continue;
        for (const entry of (r.entry || [])) {
          if (entry.type !== 'anime') continue;
          targets.push(entry.mal_id);
        }
      }

      for (const targetId of targets) {
        if (existing.has(targetId)) continue;
        try {
          const details = await fetchJSON(`https://api.jikan.moe/v4/anime/${targetId}`);
          const d = details.data;
          if (!d || !isLikelyMainline(d.title)) continue;

          upsertAnimeStmt.run(
            d.mal_id,
            d.title,
            d.title_english || '',
            d.images?.jpg?.large_image_url || d.images?.jpg?.image_url || '',
            d.synopsis || 'No synopsis available.',
            d.episodes ?? null
          );
          addWatchlistStmt.run(d.mal_id);
          existing.add(d.mal_id);
          added.push({ from: malId, malId: d.mal_id, title: d.title, type: d.type, episodes: d.episodes });
          await sleep(350);
        } catch (err) {
          failed.push({ from: malId, malId: targetId, error: String(err.message || err) });
        }
      }
    } catch (err) {
      failed.push({ from: malId, error: String(err.message || err) });
    }

    if ((i + 1) % 20 === 0 || i + 1 === seedIds.length) {
      console.log(`progress ${i + 1}/${seedIds.length} added=${added.length} failed=${failed.length}`);
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync('data/relations-added.json', JSON.stringify(added, null, 2));
  fs.writeFileSync('data/relations-failed.json', JSON.stringify(failed, null, 2));

  const counts = db.prepare(`select
    (select count(*) from anime) anime,
    (select count(*) from watchlist) watchlist
  `).get();

  console.log(JSON.stringify({ added: added.length, failed: failed.length, counts }, null, 2));
})();
