'use strict';
// Background sync: keeps AniList metadata fresh, adds newly aired episodes, fills episode titles
// and thumbnails. AniList is primary (streamingEpisodes carry Crunchyroll titles + thumbnails);
// Jikan is only a fallback for titles/thumbnails and is skipped while it is down.
const { db } = require('./db');
const anilist = require('./sources/anilist');
const jikan = require('./sources/jikan');
const library = require('./library');
const { sleep } = require('./util');
const images = require('./images');
const appState = require('./state');

const getMediaStmt = db.prepare('SELECT * FROM media WHERE mal_id = ?');
const episodeRowsStmt = db.prepare('SELECT episode_number AS n, title, image_blob IS NOT NULL AS hasImage FROM episode_sync WHERE mal_id = ?');
const insertPlaceholderStmt = db.prepare(`INSERT OR IGNORE INTO episode_sync (mal_id, episode_number, season, title, url, aired, watched, updated_at)
  VALUES (?, ?, 1, ?, '', NULL, 0, CURRENT_TIMESTAMP)`);
const setTitleStmt = db.prepare(`UPDATE episode_sync SET title = ?, url = CASE WHEN COALESCE(url,'') = '' THEN ? ELSE url END, updated_at = CURRENT_TIMESTAMP
  WHERE mal_id = ? AND episode_number = ?`);
const setImageStmt = db.prepare('UPDATE episode_sync SET image_blob = ?, image_mime = ?, image_source = ?, updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ?');
const setTotalStmt = db.prepare('UPDATE anime SET total_episodes = COALESCE(?, total_episodes), release_date = COALESCE(release_date, ?) WHERE mal_id = ?');
const markSyncedStmt = db.prepare('UPDATE watchlist SET synced_at = CURRENT_TIMESTAMP WHERE mal_id = ?');

const state = { running: false, queue: [], queued: new Set(), completed: 0, failed: 0, lastRunAt: null, lastError: null, phase: 'idle' };

const isPlaceholder = (title) => !title || /^Episode \d+( \(from history\))?$/i.test(title);

function parseStreamingEpisodes(json) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch {}
  const out = new Map();
  for (const ep of list) {
    const m = String(ep.title || '').match(/^Episode\s+(\d+)\s*[-–:]\s*(.+)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!out.has(n)) out.set(n, { title: m[2].trim(), thumbnail: ep.thumbnail, url: ep.url });
  }
  return out;
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/2.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!mime.startsWith('image/')) throw new Error('not an image');
  return images.optimizeBuffer(images.toBlob(await res.arrayBuffer()), mime);
}

/** Bring one library anime up to date using already-fetched AniList data (+ Jikan fallback). */
async function syncEpisodes(malId) {
  const media = getMediaStmt.get(malId);
  const aired = library.airedCount(media);
  if (media) setTotalStmt.run(media.episodes ?? null, media.start_date || null, malId);

  // 1. Make sure every aired episode exists.
  if (aired && aired > 0 && aired <= 2000) {
    for (let n = 1; n <= aired; n += 1) insertPlaceholderStmt.run(malId, n, `Episode ${n}`);
  }

  // 2. Titles + thumbnails from AniList streaming episodes.
  const streaming = parseStreamingEpisodes(media?.streaming_episodes);
  let rows = episodeRowsStmt.all(malId);
  let images = 0; let titles = 0;
  for (const row of rows) {
    const s = streaming.get(row.n);
    if (!s) continue;
    if (isPlaceholder(row.title) && s.title) { setTitleStmt.run(s.title, s.url || '', malId, row.n); titles += 1; }
    if (!row.hasImage && s.thumbnail) {
      try {
        const img = await downloadImage(s.thumbnail);
        setImageStmt.run(img.bytes, img.mime, 'anilist', malId, row.n);
        images += 1;
      } catch {}
    }
  }

  // 3. Jikan fallback only for what is still missing.
  rows = episodeRowsStmt.all(malId);
  const missingTitles = rows.filter((r) => isPlaceholder(r.title)).length;
  const missingImages = rows.filter((r) => !r.hasImage).length;
  if ((missingTitles || missingImages) && jikan.isAvailable()) {
    try {
      if (missingTitles) {
        for (const ep of await jikan.fetchEpisodes(malId)) {
          const n = Number(ep.mal_id);
          const row = rows.find((r) => r.n === n);
          if (row && isPlaceholder(row.title) && ep.title) { setTitleStmt.run(ep.title, ep.url || '', malId, n); titles += 1; }
        }
      }
      if (missingImages) {
        for (const v of await jikan.fetchEpisodeVideos(malId)) {
          const n = Number(String(v.episode || '').match(/(\d+)/)?.[1] || 0);
          const row = rows.find((r) => r.n === n);
          const url = v.images?.jpg?.image_url;
          if (row && !row.hasImage && url) {
            try { const img = await downloadImage(url); setImageStmt.run(img.bytes, img.mime, 'jikan', malId, n); images += 1; } catch {}
          }
        }
      }
    } catch {}
  }
  markSyncedStmt.run(malId);
  return { malId, aired, titles, images };
}

function enqueue(malId) {
  if (state.queued.has(malId)) return;
  state.queued.add(malId);
  state.queue.push(malId);
  if (!state.running) runQueue();
}

async function runQueue() {
  state.running = true;
  while (state.queue.length) {
    const malId = state.queue.shift();
    state.queued.delete(malId);
    try {
      await syncEpisodes(malId);
      state.completed += 1;
    } catch (err) {
      state.failed += 1;
      state.lastError = String(err.message || err);
    }
    state.lastRunAt = new Date().toISOString();
    await sleep(150);
  }
  state.running = false;
  saveRun();
}

function saveRun() {
  try { appState.set('episodeRun', { completed: state.completed, failed: state.failed, lastError: state.lastError }); } catch {}
}

/** Full refresh cycle: refresh stale AniList data, then sync episodes for titles that need it. */
async function refreshCycle() {
  if (state.phase !== 'idle') return;
  const summary = { metadataRefreshed: 0, episodesQueued: 0, error: null };
  try {
    state.phase = 'metadata';
    // Airing / upcoming titles go stale after 6h; finished titles after 30 days.
    const stale = db.prepare(`
      SELECT w.mal_id AS id FROM watchlist w LEFT JOIN media m ON m.mal_id = w.mal_id
      WHERE m.is_full IS NOT 1
         OR (m.status IN ('RELEASING','NOT_YET_RELEASED') AND m.fetched_at < datetime('now','-6 hours'))
         OR m.fetched_at < datetime('now','-30 days')
         OR m.synonyms IS NULL
    `).all().map((r) => r.id);
    if (stale.length) await anilist.fetchFullByMalIds(stale);
    summary.metadataRefreshed = stale.length;

    state.phase = 'episodes';
    const need = db.prepare(`
      SELECT w.mal_id AS id FROM watchlist w
      LEFT JOIN media m ON m.mal_id = w.mal_id
      LEFT JOIN (SELECT mal_id, COUNT(*) c, SUM(image_blob IS NOT NULL) i,
                        SUM(title IS NULL OR title LIKE 'Episode %') p FROM episode_sync GROUP BY mal_id) e ON e.mal_id = w.mal_id
      WHERE w.synced_at IS NULL
         OR COALESCE(e.c,0) < COALESCE(CASE WHEN m.next_airing_episode IS NOT NULL THEN m.next_airing_episode - 1 ELSE m.episodes END, 0)
         OR (m.status = 'RELEASING' AND w.synced_at < datetime('now','-6 hours'))
         OR (COALESCE(e.c,0) > 0 AND (e.i < e.c OR e.p > 0) AND w.synced_at < datetime('now','-3 days'))
    `).all().map((r) => r.id);
    need.forEach(enqueue);
    summary.episodesQueued = need.length;

    // Warm Discover: recompute recommendations now so the page opens without a wait.
    state.phase = 'recommendations';
    try { await require('./insights').recommendations({ refresh: true }); summary.recommendationsWarmed = true; } catch (err) { summary.recommendationsError = String(err.message || err); }
    // Phone notifications: episodes that aired since the last cycle, once each.
    try { const up = await require('./insights').upNext(); summary.push = await require('./push').notifyNewEpisodes(up.continueWatching); } catch (err) { summary.pushError = String(err.message || err); }
  } catch (err) {
    state.lastError = String(err.message || err);
    summary.error = state.lastError;
  } finally {
    state.phase = 'idle';
    try { appState.set('refreshCycle', summary); } catch {}
  }
}

function start({ intervalMs = 6 * 3600 * 1000 } = {}) {
  setTimeout(refreshCycle, 5000);
  setInterval(refreshCycle, intervalMs).unref();
}

/** Resolves once the episode queue is empty (used by the Cloudflare cron run). */
async function whenIdle(maxMs = 10 * 60 * 1000) {
  const until = Date.now() + maxMs;
  while ((state.running || state.queue.length) && Date.now() < until) await sleep(500);
}

function status() {
  // In-memory counters reset whenever the process (or Durable Object) restarts; fall back to the saved run.
  const savedRun = appState.get('episodeRun');
  const cycle = appState.get('refreshCycle');
  return {
    queueLength: state.queue.length, running: state.running ? 1 : 0, phase: state.phase,
    completed: state.completed, failed: state.failed,
    lastRunAt: state.lastRunAt || savedRun?.at || null,
    lastError: state.lastError || savedRun?.lastError || null,
    lastCycle: cycle, lastBackup: appState.get('backup'),
    jikanAvailable: jikan.isAvailable()
  };
}

module.exports = { syncEpisodes, enqueue, refreshCycle, start, status, whenIdle };
