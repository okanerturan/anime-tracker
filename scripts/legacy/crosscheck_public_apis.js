const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join('data', 'anime-tracker.db');
const OUT_JSON = path.join('data', 'api-crosscheck-report.json');
const OUT_SUMMARY = path.join('data', 'api-crosscheck-summary.json');

const LIMIT = Number(process.env.LIMIT || 0);
const DELAY_MS = Number(process.env.DELAY_MS || 350);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);
const TARGET = String(process.env.TARGET || 'problematic'); // problematic | all

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(url, options);
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 220)}`);
    }
    return res;
  }
  throw lastErr || new Error('retry_exhausted');
}

async function fetchJikanByMal(malId) {
  const url = `https://api.jikan.moe/v4/anime/${malId}`;
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'anime-tracker-local/1.0' } });
  const json = await res.json();
  return json?.data || null;
}

async function fetchAniListByMal(malId) {
  const query = `
    query($idMal:Int){
      Media(idMal:$idMal, type:ANIME){
        idMal
        title { romaji english native }
        episodes
        startDate { year month day }
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
  return json?.data?.Media || null;
}

function formatAniDate(startDate) {
  if (!startDate || !startDate.year) return null;
  const mm = String(startDate.month || 1).padStart(2, '0');
  const dd = String(startDate.day || 1).padStart(2, '0');
  return `${startDate.year}-${mm}-${dd}`;
}

function toDay(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

function chooseTargets(db) {
  const baseQuery = `
    SELECT
      a.mal_id AS malId,
      a.title AS title,
      COALESCE(a.title_english, '') AS titleEnglish,
      a.release_date AS releaseDate,
      a.total_episodes AS totalEpisodes,
      COUNT(e.episode_number) AS episodesCount,
      COALESCE(SUM(CASE WHEN e.image_blob IS NOT NULL THEN 1 ELSE 0 END), 0) AS imageCount,
      COALESCE(SUM(CASE WHEN e.watched = 1 THEN 1 ELSE 0 END), 0) AS watchedCount
    FROM watchlist w
    JOIN anime a ON a.mal_id = w.mal_id
    LEFT JOIN episode_sync e ON e.mal_id = w.mal_id
    GROUP BY a.mal_id, a.title, a.title_english, a.release_date, a.total_episodes
  `;
  const rows = db.prepare(baseQuery).all();
  if (TARGET === 'all') return rows;
  return rows.filter((r) => {
    const eps = Number(r.episodesCount || 0);
    const imgs = Number(r.imageCount || 0);
    const coverage = eps > 0 ? imgs / eps : 0;
    return eps === 0 || coverage < 0.5 || !String(r.titleEnglish || '').trim() || !r.releaseDate || !r.totalEpisodes;
  });
}

(async () => {
  const db = new DatabaseSync(DB_PATH);
  let targets = chooseTargets(db);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  const report = [];
  let ok = 0;
  let failed = 0;

  console.log(`crosscheck_targets=${targets.length} target_mode=${TARGET}`);

  for (let i = 0; i < targets.length; i += 1) {
    const row = targets[i];
    const out = {
      malId: row.malId,
      title: row.title,
      db: {
        titleEnglish: row.titleEnglish || '',
        releaseDate: row.releaseDate || null,
        totalEpisodes: row.totalEpisodes ?? null,
        episodesCount: Number(row.episodesCount || 0),
        watchedCount: Number(row.watchedCount || 0),
        imageCount: Number(row.imageCount || 0)
      },
      jikan: null,
      anilist: null,
      findings: []
    };

    try {
      const [jikan, anilist] = await Promise.all([
        fetchJikanByMal(row.malId).catch(() => null),
        fetchAniListByMal(row.malId).catch(() => null)
      ]);

      out.jikan = jikan
        ? {
            titleEnglish: jikan.title_english || '',
            releaseDate: jikan.aired?.from || null,
            episodes: jikan.episodes ?? null
          }
        : null;
      out.anilist = anilist
        ? {
            titleEnglish: anilist.title?.english || '',
            releaseDate: formatAniDate(anilist.startDate),
            episodes: anilist.episodes ?? null
          }
        : null;

      const dbEps = Number(out.db.episodesCount || 0);
      const apiEpisodeCandidates = [out.jikan?.episodes, out.anilist?.episodes]
        .map((x) => Number(x || 0))
        .filter((x) => x > 0);
      const maxApiEpisodes = apiEpisodeCandidates.length ? Math.max(...apiEpisodeCandidates) : 0;

      if (dbEps === 0 && maxApiEpisodes > 0) {
        out.findings.push(`missing_local_episodes:${maxApiEpisodes}`);
      }

      const dbEn = String(out.db.titleEnglish || '').trim();
      const sourceEn = String(out.jikan?.titleEnglish || out.anilist?.titleEnglish || '').trim();
      if (!dbEn && sourceEn) {
        out.findings.push(`missing_english_title:${sourceEn}`);
      }

      const dbDate = toDay(out.db.releaseDate);
      const sourceDate = toDay(out.jikan?.releaseDate || out.anilist?.releaseDate);
      if (!dbDate && sourceDate) {
        out.findings.push(`missing_release_date:${sourceDate}`);
      } else if (dbDate && sourceDate && dbDate !== sourceDate) {
        out.findings.push(`release_date_mismatch:db=${dbDate},src=${sourceDate}`);
      }

      const imgCoverage = dbEps > 0 ? out.db.imageCount / dbEps : 0;
      if (dbEps > 0 && imgCoverage < 0.5) {
        out.findings.push(`low_thumbnail_coverage:${Math.round(imgCoverage * 100)}%`);
      }

      ok += 1;
    } catch (err) {
      out.findings.push(`crosscheck_error:${String(err.message || err)}`);
      failed += 1;
    }

    report.push(out);

    if ((i + 1) % 20 === 0 || i + 1 === targets.length) {
      const issues = report.filter((x) => x.findings.length > 0).length;
      console.log(`progress ${i + 1}/${targets.length} checked=${ok} failed=${failed} with_issues=${issues}`);
    }

    await sleep(DELAY_MS);
  }

  const withIssues = report.filter((x) => x.findings.length > 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    targetMode: TARGET,
    totalChecked: report.length,
    withIssues: withIssues.length,
    missingLocalEpisodes: withIssues.filter((x) => x.findings.some((f) => f.startsWith('missing_local_episodes'))).length,
    missingEnglishTitles: withIssues.filter((x) => x.findings.some((f) => f.startsWith('missing_english_title'))).length,
    missingReleaseDates: withIssues.filter((x) => x.findings.some((f) => f.startsWith('missing_release_date'))).length,
    releaseDateMismatches: withIssues.filter((x) => x.findings.some((f) => f.startsWith('release_date_mismatch'))).length,
    lowThumbnailCoverage: withIssues.filter((x) => x.findings.some((f) => f.startsWith('low_thumbnail_coverage'))).length
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
})();
