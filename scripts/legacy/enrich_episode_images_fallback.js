const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/anime-tracker.db');
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);
const DELAY_MS = Number(process.env.DELAY_MS || 300);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastErr = null;
  for (let i = 0; i <= MAX_RETRIES; i += 1) {
    const res = await fetch(url, options);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status} ${url}`);
      await sleep(500 * (i + 1));
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 220)}`);
    }
    return res;
  }
  throw lastErr || new Error(`retry_exhausted: ${url}`);
}

async function fetchAniListImageByMal(malId) {
  const query = `
    query($idMal:Int){
      Media(idMal:$idMal, type:ANIME){
        bannerImage
        coverImage { extraLarge large medium }
      }
    }
  `;
  const res = await fetchWithRetry('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'anime-tracker-local/1.0'
    },
    body: JSON.stringify({ query, variables: { idMal: malId } })
  });
  const json = await res.json();
  const media = json?.data?.Media;
  return media?.bannerImage || media?.coverImage?.extraLarge || media?.coverImage?.large || media?.coverImage?.medium || '';
}

async function fetchJikanImageByMal(malId) {
  const res = await fetchWithRetry(`https://api.jikan.moe/v4/anime/${malId}`, {
    headers: { 'User-Agent': 'anime-tracker-local/1.0' }
  });
  const json = await res.json();
  const d = json?.data;
  return d?.images?.jpg?.large_image_url || d?.images?.jpg?.image_url || '';
}

async function fetchBinary(url) {
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'anime-tracker-local/1.0' } });
  const mime = res.headers.get('content-type') || 'image/jpeg';
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime };
}

const getTargets = db.prepare(`
  SELECT
    a.mal_id AS malId,
    a.title AS title,
    COALESCE(a.image_url, '') AS imageUrl,
    COUNT(e.episode_number) AS episodes,
    COALESCE(SUM(CASE WHEN e.image_blob IS NOT NULL THEN 1 ELSE 0 END), 0) AS images
  FROM watchlist w
  JOIN anime a ON a.mal_id = w.mal_id
  LEFT JOIN episode_sync e ON e.mal_id = w.mal_id
  GROUP BY a.mal_id, a.title, a.image_url
  HAVING COUNT(e.episode_number) > 0
     AND COALESCE(SUM(CASE WHEN e.image_blob IS NOT NULL THEN 1 ELSE 0 END), 0) < COUNT(e.episode_number)
  ORDER BY (COUNT(e.episode_number) - COALESCE(SUM(CASE WHEN e.image_blob IS NOT NULL THEN 1 ELSE 0 END), 0)) DESC
`);

const fillMissing = db.prepare(`
  UPDATE episode_sync
  SET image_blob = ?, image_mime = ?, updated_at = CURRENT_TIMESTAMP
  WHERE mal_id = ? AND image_blob IS NULL
`);

(async () => {
  const targets = getTargets.all();
  let ok = 0;
  let failed = 0;
  let imagesFilled = 0;

  console.log(`fallback_targets=${targets.length}`);

  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    try {
      let url = t.imageUrl || '';
      if (!url) url = await fetchAniListImageByMal(t.malId);
      if (!url) url = await fetchJikanImageByMal(t.malId);
      if (!url) {
        failed += 1;
        console.log(`skip ${i + 1}/${targets.length} malId=${t.malId} no_image_source`);
        await sleep(DELAY_MS);
        continue;
      }

      const { bytes, mime } = await fetchBinary(url);
      const before = Number(t.images || 0);
      fillMissing.run(bytes, mime, t.malId);
      const after = db
        .prepare('SELECT COALESCE(SUM(CASE WHEN image_blob IS NOT NULL THEN 1 ELSE 0 END), 0) AS n FROM episode_sync WHERE mal_id = ?')
        .get(t.malId).n;
      imagesFilled += Math.max(0, Number(after) - before);
      ok += 1;
      console.log(`ok ${i + 1}/${targets.length} malId=${t.malId} filled=${Math.max(0, Number(after) - before)} title=${t.title}`);
    } catch (err) {
      failed += 1;
      console.log(`fail ${i + 1}/${targets.length} malId=${t.malId} error=${String(err.message || err)}`);
    }
    await sleep(DELAY_MS);
  }

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM episode_sync) AS episodes,
      (SELECT COUNT(*) FROM episode_sync WHERE image_blob IS NOT NULL) AS images
  `).get();
  const coverage = totals.episodes > 0 ? Math.round((totals.images * 1000) / totals.episodes) / 10 : 0;
  console.log(JSON.stringify({ targets: targets.length, ok, failed, imagesFilled, totals, coveragePct: coverage }, null, 2));
})();
