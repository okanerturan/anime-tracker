const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/anime-tracker.db');
const raw = JSON.parse(fs.readFileSync('data/crunchyroll-history-live-raw.json', 'utf8'));

const updateImageStmt = db.prepare(`
UPDATE episode_sync
SET image_blob = ?, image_mime = ?, updated_at = CURRENT_TIMESTAMP
WHERE mal_id = ? AND episode_number = ?
`);

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeTitle(value).split(' ').filter(Boolean));
}

function jaccardScore(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const t of a) if (b.has(t)) i += 1;
  const u = a.size + b.size - i;
  return u ? i / u : 0;
}

function pickThumbSource(images) {
  const groups = images?.thumbnail;
  if (!Array.isArray(groups) || groups.length === 0) return '';
  const flat = groups.flat().filter((x) => x?.source);
  if (flat.length === 0) return '';
  flat.sort((a, b) => (b.width || 0) - (a.width || 0));
  return flat[0].source;
}

const historyMap = new Map();
for (const row of raw) {
  const title = row?.panel?.episode_metadata?.series_title;
  const episode = Number(row?.panel?.episode_metadata?.episode_number || 0);
  const source = pickThumbSource(row?.panel?.images);
  if (!title || !episode || !source) continue;

  const key = normalizeTitle(title);
  if (!historyMap.has(key)) historyMap.set(key, { episodes: new Map(), title });
  const entry = historyMap.get(key);
  if (!entry.episodes.has(episode)) entry.episodes.set(episode, source);
}

function findHistoryEntry(title, titleEnglish) {
  const candidates = [title, titleEnglish].filter(Boolean);
  for (const t of candidates) {
    const exact = historyMap.get(normalizeTitle(t));
    if (exact) return exact;
  }

  let best = null;
  let bestScore = 0;
  const candidateSets = candidates.map((x) => tokenSet(x));
  for (const [key, entry] of historyMap.entries()) {
    const keySet = new Set(key.split(' ').filter(Boolean));
    for (const cSet of candidateSets) {
      const s = jaccardScore(cSet, keySet);
      if (s > bestScore) {
        bestScore = s;
        best = entry;
      }
    }
  }
  return bestScore >= 0.52 ? best : null;
}

async function fetchBinary(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = res.headers.get('content-type') || 'image/jpeg';
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const rows = db.prepare(`
    SELECT e.mal_id AS malId, a.title, a.title_english AS titleEnglish, e.episode_number AS episodeNumber
    FROM episode_sync e
    JOIN anime a ON a.mal_id = e.mal_id
    WHERE e.watched = 1 AND e.image_blob IS NULL
    ORDER BY e.mal_id, e.episode_number
  `).all();

  let updated = 0;
  let checked = 0;
  const failures = [];

  console.log(`targets=${rows.length}`);

  for (const row of rows) {
    checked += 1;
    const entry = findHistoryEntry(row.title, row.titleEnglish);
    const imageUrl = entry?.episodes?.get(row.episodeNumber);
    if (!imageUrl) continue;

    try {
      const { bytes, mime } = await fetchBinary(imageUrl);
      updateImageStmt.run(bytes, mime, row.malId, row.episodeNumber);
      updated += 1;
      await sleep(160);
    } catch (err) {
      failures.push({ malId: row.malId, episodeNumber: row.episodeNumber, error: String(err.message || err) });
    }

    if (checked % 100 === 0) {
      console.log(`progress ${checked}/${rows.length} updated=${updated} failures=${failures.length}`);
    }
  }

  fs.writeFileSync('data/thumb-history-backfill-failures.json', JSON.stringify(failures, null, 2));
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM episode_sync WHERE image_blob IS NOT NULL) AS images,
      (SELECT COUNT(*) FROM episode_sync) AS episodes,
      (SELECT COUNT(*) FROM episode_sync WHERE watched=1 AND image_blob IS NULL) AS watchedMissing
  `).get();

  console.log(JSON.stringify({ checked, updated, failures: failures.length, counts }, null, 2));
})();
