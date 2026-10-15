'use strict';
// Crunchyroll history ingest. History rows arrive from the browser extension (or a manual export),
// are stored in cr_history, mapped to MAL entries, and applied as watched episodes.
//
// Mapping order for a row:
//   1. a season rule in cr_season_map (season id + episode range -> MAL id + offset)
//   2. episode-title match against episode titles already in the library
//   3. AniList search on "series + season" (auto rule, flagged for review)
const { db } = require('./db');
const anilist = require('./sources/anilist');
const library = require('./library');
const sync = require('./sync');
const { normalizeTitle, isWatchedPlay } = require('./util');

const upsertRowStmt = db.prepare(`
INSERT INTO cr_history (episode_id, series_id, series_title, season_id, season_title, season_number, episode_number,
  episode_title, duration_s, playhead, fully_watched, date_played, thumb_url, applied)
VALUES (@episode_id, @series_id, @series_title, @season_id, @season_title, @season_number, @episode_number,
  @episode_title, @duration_s, @playhead, @fully_watched, @date_played, @thumb_url, 0)
ON CONFLICT(episode_id) DO UPDATE SET
  playhead=excluded.playhead, fully_watched=MAX(cr_history.fully_watched, excluded.fully_watched),
  date_played=excluded.date_played, thumb_url=COALESCE(excluded.thumb_url, cr_history.thumb_url),
  applied=CASE WHEN excluded.date_played > cr_history.date_played OR excluded.fully_watched > cr_history.fully_watched THEN 0 ELSE cr_history.applied END
WHERE excluded.date_played >= cr_history.date_played
`);
const ruleStmt = db.prepare('SELECT * FROM cr_season_map WHERE season_id = ? AND ? BETWEEN ep_from AND ep_to ORDER BY ep_from DESC LIMIT 1');
const anyRuleStmt = db.prepare('SELECT * FROM cr_season_map WHERE season_id = ? LIMIT 1');
const insertRuleStmt = db.prepare(`INSERT OR REPLACE INTO cr_season_map (season_id, ep_from, ep_to, mal_id, ep_offset, source, series_title, season_title, needs_review)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const setMappingStmt = db.prepare('UPDATE cr_history SET mal_id = ?, mal_episode = ?, map_source = ? WHERE episode_id = ?');
const pendingStmt = db.prepare('SELECT * FROM cr_history WHERE applied = 0 ORDER BY date_played');
const markAppliedStmt = db.prepare('UPDATE cr_history SET applied = 1 WHERE episode_id = ?');
const getEpStmt = db.prepare('SELECT watched FROM episode_sync WHERE mal_id = ? AND episode_number = ?');
const insertEpStmt = db.prepare(`INSERT INTO episode_sync (mal_id, episode_number, season, title, url, aired, watched, watched_at, updated_at)
  VALUES (?, ?, 1, ?, '', NULL, 1, ?, CURRENT_TIMESTAMP)`);
const markEpStmt = db.prepare('UPDATE episode_sync SET watched = 1, watched_at = COALESCE(watched_at, ?), updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ? AND watched = 0');
const totalStmt = db.prepare('SELECT COALESCE(a.total_episodes, m.episodes) AS total FROM anime a LEFT JOIN media m USING(mal_id) WHERE a.mal_id = ?');
const logStmt = db.prepare('INSERT INTO sync_log (source, summary) VALUES (?, ?)');

/** Accepts either raw Crunchyroll watch-history items or the extension's compact rows. */
function normalizeRow(x) {
  if (x.panel || x.date_played) {
    const m = x.panel?.episode_metadata;
    if (!m) return null;
    const thumbs = x.panel?.images?.thumbnail?.[0] || [];
    const thumb = (thumbs.find((t) => t.width >= 600) || thumbs[thumbs.length - 1] || {}).source || null;
    return {
      episode_id: x.id || x.panel.id, series_id: m.series_id || x.parent_id || null, series_title: m.series_title,
      season_id: m.season_id || null, season_title: m.season_title || null, season_number: m.season_number ?? null,
      episode_number: m.episode_number ?? null, episode_title: x.panel.title || null,
      duration_s: Math.round((m.duration_ms || 0) / 1000), playhead: x.playhead || 0,
      fully_watched: x.fully_watched ? 1 : 0, date_played: x.date_played, thumb_url: thumb
    };
  }
  if (!x.episodeId || !x.seriesTitle || !x.datePlayed) return null;
  return {
    episode_id: x.episodeId, series_id: x.seriesId || null, series_title: x.seriesTitle, season_id: x.seasonId || null,
    season_title: x.seasonTitle || null, season_number: x.seasonNumber ?? null, episode_number: x.episodeNumber ?? null,
    episode_title: x.episodeTitle || null, duration_s: Number(x.durationS || 0), playhead: Number(x.playhead || 0),
    fully_watched: x.fullyWatched ? 1 : 0, date_played: x.datePlayed, thumb_url: x.thumb || null
  };
}

function titleIndex() {
  const index = new Map();
  for (const r of db.prepare(`SELECT mal_id, episode_number, title FROM episode_sync WHERE title IS NOT NULL AND title NOT LIKE 'Episode %'`).all()) {
    const key = normalizeTitle(r.title);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push([r.mal_id, r.episode_number]);
  }
  return index;
}

/** Try to map a whole Crunchyroll season from episode titles; returns a rule or null. */
function ruleFromTitles(rows, index) {
  const votes = new Map();
  for (const r of rows) {
    for (const [mal, ep] of index.get(normalizeTitle(r.episode_title)) || []) {
      const v = votes.get(mal) || { n: 0, offsets: new Map() };
      v.n += 1;
      if (r.episode_number) v.offsets.set(r.episode_number - ep, (v.offsets.get(r.episode_number - ep) || 0) + 1);
      votes.set(mal, v);
    }
  }
  const best = [...votes.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (!best) return null;
  const [mal, v] = best;
  if (v.n < Math.min(2, rows.length) || v.n / rows.length < 0.4) return null;
  const offset = [...v.offsets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return { mal, offset, source: 'title' };
}

function seasonQuery(row) {
  const st = row.season_title || '';
  if (!st || /^(season )?0?1$/i.test(st)) return row.series_title;
  if (normalizeTitle(st).includes(normalizeTitle(row.series_title).split(' ').slice(0, 2).join(' '))) return st;
  return `${row.series_title} ${st}`;
}

function pickCandidate(query, cands) {
  const q = normalizeTitle(query);
  const exact = cands.find((m) => [m.title?.english, m.title?.romaji].some((t) => normalizeTitle(t) === q));
  if (exact) return { media: exact, confident: true };
  const tv = cands.find((m) => ['TV', 'ONA', 'TV_SHORT'].includes(m.format));
  return { media: tv || cands[0], confident: false };
}

async function ruleFromAniList(row, minEpisode) {
  const query = seasonQuery(row);
  const cands = await anilist.search(query, 6);
  if (!cands.length) return null;
  const { media, confident } = pickCandidate(query, cands);
  if (!library.isInLibrary(media.idMal)) {
    library.addToLibrary(anilist.toLibraryAnime(media));
  }
  // Continuous numbering: season 2 starting at "13" after a 12-episode season 1 means offset 12.
  let offset = 0;
  if (minEpisode > 1) {
    await anilist.fetchFullByMalIds([media.idMal]).catch(() => {});
    // The offset comes from the prequel chain; without its metadata a guess would be saved for good.
    if (anilist.isBlocked() && !db.prepare('SELECT is_full FROM media WHERE mal_id = ?').get(media.idMal)?.is_full) throw new anilist.AniListBlockedError();
    let sum = 0; let cur = media.idMal; const chain = [];
    for (let hops = 0; hops < 6; hops += 1) {
      const prev = db.prepare(`SELECT m.mal_id, m.episodes, m.is_full FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id
        WHERE r.mal_id = ? AND r.relation_type = 'PREQUEL' AND m.format IN ('TV','ONA','TV_SHORT') ORDER BY m.start_date DESC LIMIT 1`).get(cur);
      if (!prev || !prev.episodes) break;
      sum += prev.episodes; chain.push(sum); cur = prev.mal_id;
      if (!prev.is_full) await anilist.fetchFullByMalIds([prev.mal_id]).catch(() => {});
    }
    // Use the largest prequel total that the first watched episode number lies beyond.
    offset = chain.filter((t) => minEpisode > t).pop() || 0;
  }
  return { mal: media.idMal, offset, source: confident ? 'anilist' : 'anilist-guess', needsReview: !confident };
}

function ensureInLibrary(malId) {
  const media = db.prepare('SELECT * FROM media WHERE mal_id = ?').get(malId);
  library.addToLibrary({ malId, title: media?.title || `MAL ${malId}`, titleEnglish: media?.title_english || '', imageUrl: media?.cover_url || '',
    releaseDate: media?.start_date || null, totalEpisodes: media?.episodes ?? null });
}

const startDateStmt = db.prepare('SELECT start_date, status FROM media WHERE mal_id = ?');

function applyRow(row) {
  if (!row.mal_id || !row.mal_episode || row.mal_episode < 1) return 'unmapped';
  if (!isWatchedPlay({ fullyWatched: row.fully_watched, playhead: row.playhead, durationS: row.duration_s })) return 'partial';
  // Premiere guard: a play from before the show aired belongs to a different season, so it never counts here.
  const media = startDateStmt.get(row.mal_id);
  // A season that hasn't aired can't have been watched (old imports put earlier seasons' plays on
  // sequels with no start date yet, where the date check below can't help).
  if (media?.status === 'NOT_YET_RELEASED') return 'before-premiere';
  const start = media?.start_date;
  if (start && row.date_played && new Date(row.date_played).getTime() < new Date(start).getTime() - 2 * 86400000) return 'before-premiere';
  const existing = getEpStmt.get(row.mal_id, row.mal_episode);
  if (existing) {
    if (existing.watched) return 'already';
    markEpStmt.run(row.date_played, row.mal_id, row.mal_episode);
    return 'marked';
  }
  const total = totalStmt.get(row.mal_id)?.total;
  if (total && row.mal_episode > total) return 'beyond-total';
  insertEpStmt.run(row.mal_id, row.mal_episode, row.episode_title || `Episode ${row.mal_episode}`, row.date_played);
  return 'marked';
}

/** Ingest rows, resolve mappings, apply watched state. */
async function ingest(rawRows, { source = 'extension' } = {}) {
  const rows = rawRows.map(normalizeRow).filter((r) => r && r.series_title && r.date_played);
  const store = db.transaction((list) => { for (const r of list) upsertRowStmt.run(r); });
  store(rows);

  const pending = pendingStmt.all();
  const index = titleIndex();
  const bySeason = new Map();
  for (const r of pending) {
    const key = r.season_id || `${r.series_title}|${r.season_title}`;
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key).push(r);
  }

  const summary = { received: rawRows.length, stored: rows.length, pending: pending.length, marked: 0, already: 0, partial: 0, unmapped: 0, newRules: 0, newAnime: 0, needsReview: 0 };
  const touched = new Set();
  const libraryBefore = new Set(db.prepare('SELECT mal_id FROM watchlist').all().map((r) => r.mal_id));

  for (const [seasonKey, seasonRows] of bySeason) {
    const sample = seasonRows[0];
    // Only resolve unknown seasons when at least one episode was actually watched.
    const anyWatched = seasonRows.some((r) => isWatchedPlay({ fullyWatched: r.fully_watched, playhead: r.playhead, durationS: r.duration_s }));
    if (!anyRuleStmt.get(seasonKey) && anyWatched && !seasonRows.every((r) => r.mal_id)) {
      let rule = ruleFromTitles(seasonRows, index);
      if (!rule) {
        const minEp = Math.min(...seasonRows.map((r) => r.episode_number).filter((n) => n != null), Infinity);
        try { rule = await ruleFromAniList(sample, Number.isFinite(minEp) ? minEp : 1); }
        catch (err) {
          // AniList is blocking the server: leave these plays pending; the browser relay answers the
          // search and the next sync maps them properly instead of saving an "unresolved" rule.
          if (err.code === 'anilist_blocked') { summary.deferred = (summary.deferred || 0) + seasonRows.length; continue; }
          rule = null;
        }
      }
      if (!rule) rule = { mal: 0, offset: 0, source: 'unresolved', needsReview: true };
      insertRuleStmt.run(seasonKey, 0, 100000, rule.mal, rule.offset, rule.source, sample.series_title, sample.season_title, rule.needsReview ? 1 : 0);
      summary.newRules += 1;
      if (rule.needsReview) summary.needsReview += 1;
    }
    for (const r of seasonRows) {
      if (!r.mal_id && r.episode_number != null) {
        const rule = ruleStmt.get(seasonKey, r.episode_number);
        if (rule && rule.mal_id) {
          const resolved = library.resolveOverflow(rule.mal_id, r.episode_number - rule.ep_offset);
          if (resolved.malId !== rule.mal_id && !library.isInLibrary(resolved.malId)) ensureInLibrary(resolved.malId);
          r.mal_id = resolved.malId;
          r.mal_episode = resolved.episodeNumber;
          r.map_source = rule.source;
          setMappingStmt.run(r.mal_id, r.mal_episode, r.map_source, r.episode_id);
        }
      } else if (!r.mal_id && r.episode_number == null) {
        // Movies have no episode number: treat as episode 1.
        const rule = ruleStmt.get(seasonKey, 1);
        if (rule && rule.mal_id) { r.mal_id = rule.mal_id; r.mal_episode = 1; r.map_source = rule.source; setMappingStmt.run(r.mal_id, 1, rule.source, r.episode_id); }
      }
      if (!r.mal_id && ruleStmt.get(seasonKey, r.episode_number ?? 1)?.mal_id === 0) { markAppliedStmt.run(r.episode_id); summary.unmapped += 1; continue; }
      const result = applyRow(r);
      if (result === 'marked') { summary.marked += 1; touched.add(r.mal_id); }
      else if (result === 'already') summary.already += 1;
      else if (result === 'partial') summary.partial += 1;
      else if (result === 'unmapped') summary.unmapped += 1;
      else if (result === 'before-premiere') summary.beforePremiere = (summary.beforePremiere || 0) + 1;
      if (result !== 'unmapped') markAppliedStmt.run(r.episode_id);
    }
  }

  const newAnime = db.prepare('SELECT mal_id FROM watchlist').all().map((r) => r.mal_id).filter((id) => !libraryBefore.has(id));
  summary.newAnime = newAnime.length;
  if (newAnime.length) {
    try { await anilist.fetchFullByMalIds(newAnime); } catch {}
  }
  summary.reactivated = library.reactivate(touched);
  for (const id of new Set([...touched, ...newAnime])) sync.enqueue(id);
  logStmt.run(source, JSON.stringify(summary));
  return summary;
}

/** Crunchyroll seasons whose MAL entry still lacks episode titles/thumbnails, or is airing (new episodes). */
function wantedSeasons(limit = 30) {
  return db.prepare(`
    SELECT r.season_id AS id, MAX(h.date_played) AS last FROM cr_season_map r
    JOIN cr_history h ON h.season_id = r.season_id
    LEFT JOIN media m ON m.mal_id = r.mal_id
    LEFT JOIN cr_season_fetch f ON f.season_id = r.season_id
    WHERE r.mal_id > 0 AND r.season_id NOT LIKE '%|%'
      AND (f.fetched_at IS NULL OR f.fetched_at < datetime('now', CASE WHEN m.status = 'RELEASING' THEN '-20 hours' ELSE '-14 days' END))
      AND (
      m.status = 'RELEASING'
      OR EXISTS (SELECT 1 FROM episode_sync e WHERE e.mal_id = r.mal_id AND (e.image_blob IS NULL OR e.title IS NULL OR e.title GLOB 'Episode [0-9]*'
        OR COALESCE(e.url, '') NOT LIKE '%crunchyroll.com/watch/%')))
    GROUP BY r.season_id ORDER BY last DESC LIMIT ?`).all(limit).map((r) => r.id);
}

const epRowStmt = db.prepare('SELECT title, image_blob IS NOT NULL AS hasImage FROM episode_sync WHERE mal_id = ? AND episode_number = ?');
const setEpMetaStmt = db.prepare(`UPDATE episode_sync SET title = CASE WHEN title IS NULL OR title GLOB 'Episode [0-9]*' THEN ? ELSE title END,
  aired = COALESCE(?, aired), url = CASE WHEN COALESCE(url,'') = '' THEN ? ELSE url END, updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ?`);
const insertAiredStmt = db.prepare(`INSERT OR IGNORE INTO episode_sync (mal_id, episode_number, season, title, url, aired, watched, updated_at)
  VALUES (?, ?, 1, ?, ?, ?, 0, CURRENT_TIMESTAMP)`);
const setEpImageStmt = db.prepare(`UPDATE episode_sync SET image_blob = ?, image_mime = ?, image_source = 'crunchyroll', updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ?`);

/** Apply full Crunchyroll season episode lists (titles, thumbnails, air dates) sent by the extension. */
async function applySeasonEpisodes(seasons) {
  const images = require('./images');
  const summary = { seasons: 0, titles: 0, images: 0, added: 0 };
  for (const season of seasons || []) {
    if (!season?.seasonId || !Array.isArray(season.episodes)) continue;
    summary.seasons += 1;
    db.prepare('INSERT OR REPLACE INTO cr_season_fetch (season_id, fetched_at) VALUES (?, CURRENT_TIMESTAMP)').run(season.seasonId);
    for (const ep of season.episodes) {
      try {
      if (ep.episodeNumber == null) continue;
      const rule = ruleStmt.get(season.seasonId, ep.episodeNumber);
      if (!rule || !rule.mal_id) continue;
      const { malId, episodeNumber } = library.resolveOverflow(rule.mal_id, ep.episodeNumber - rule.ep_offset);
      if (episodeNumber < 1) continue;
      if (!library.isInLibrary(malId)) {
        // Only fill shows already in the library; a rolled-over sequel is added when you watch it.
        if (malId !== rule.mal_id) continue;
        ensureInLibrary(malId);
      }
      const aired = ep.airDate && new Date(ep.airDate).getTime() <= Date.now();
      const url = ep.episodeId ? `https://www.crunchyroll.com/watch/${ep.episodeId}` : '';
      let row = epRowStmt.get(malId, episodeNumber);
      if (!row && aired) {
        const total = totalStmt.get(malId)?.total;
        if (!total || episodeNumber <= total) {
          insertAiredStmt.run(malId, episodeNumber, ep.title || `Episode ${episodeNumber}`, url, ep.airDate || null);
          summary.added += 1;
          row = epRowStmt.get(malId, episodeNumber);
        }
      }
      if (!row) continue;
      if (ep.title && (!row.title || /^Episode \d+$/.test(row.title))) summary.titles += 1;
      setEpMetaStmt.run(ep.title || null, ep.airDate || null, url, malId, episodeNumber);
      if (!row.hasImage && ep.thumb && images.isAllowed(ep.thumb)) {
        try {
          const res = await fetch(ep.thumb, { signal: AbortSignal.timeout(20000) });
          if (res.ok) {
            const out = images.optimizeBuffer(images.toBlob(await res.arrayBuffer()), (res.headers.get('content-type') || 'image/jpeg').split(';')[0]);
            setEpImageStmt.run(out.bytes, out.mime, malId, episodeNumber);
            summary.images += 1;
          }
        } catch {}
      }
      } catch (err) { summary.errors = (summary.errors || 0) + 1; }
    }
  }
  logStmt.run('cr-episodes', JSON.stringify(summary));
  return summary;
}

function status() {
  const last = db.prepare(`SELECT at, source, summary FROM sync_log WHERE source IN ('extension','manual','seed') ORDER BY id DESC LIMIT 1`).get();
  const counts = db.prepare('SELECT COUNT(*) AS rows, MAX(date_played) AS latestPlayed, SUM(applied = 0) AS unapplied FROM cr_history').get();
  const review = db.prepare(`SELECT r.season_id AS seasonId, r.series_title AS seriesTitle, r.season_title AS seasonTitle, r.mal_id AS malId,
      r.ep_offset AS offset, r.source, COALESCE(m.title_english, m.title, a.title) AS mappedTitle
    FROM cr_season_map r LEFT JOIN media m ON m.mal_id = r.mal_id LEFT JOIN anime a ON a.mal_id = r.mal_id
    WHERE r.needs_review = 1 ORDER BY r.series_title`).all();
  const inProgress = db.prepare(`SELECT h.episode_id AS episodeId, h.series_title AS seriesTitle, h.season_title AS seasonTitle, h.episode_number AS episodeNumber,
      h.episode_title AS episodeTitle, h.playhead, h.duration_s AS durationS, h.date_played AS datePlayed, h.mal_id AS malId, h.thumb_url AS thumb, h.season_id AS seasonId
    FROM cr_history h WHERE h.fully_watched = 0 AND h.duration_s > 0 AND h.playhead > 30 AND 1.0 * h.playhead / h.duration_s < 0.8 AND COALESCE(h.dismissed, 0) = 0
      AND h.date_played > datetime('now','-30 days')
    ORDER BY h.date_played DESC LIMIT 12`).all();
  const images = require('./images');
  for (const p of inProgress) p.thumb = images.localUrl(p.thumb);
  // Seasons you sampled that aren't tracked: no rule yet, or a rule that says "skip" (mal_id 0).
  const sampled = db.prepare(`
    SELECT h.season_id AS seasonId, h.series_title AS seriesTitle, h.season_title AS seasonTitle, COUNT(*) AS plays,
           MAX(h.date_played) AS lastPlayed, MAX(h.thumb_url) AS thumb,
           SUM(h.fully_watched = 1 OR (h.duration_s > 0 AND 1.0 * h.playhead / h.duration_s >= 0.8)) AS watchedPlays
    FROM cr_history h LEFT JOIN cr_season_map r ON r.season_id = h.season_id
    WHERE h.season_id IS NOT NULL AND (r.season_id IS NULL OR r.mal_id = 0)
      AND h.season_title NOT LIKE '%Dub)%'
      AND h.season_id NOT IN (SELECT value FROM json_each(?))
    GROUP BY h.season_id ORDER BY lastPlayed DESC LIMIT 60`).all(JSON.stringify(hiddenSampled()));
  const imagesMod = require('./images');
  for (const s of sampled) s.thumb = imagesMod.localUrl(s.thumb);
  const seen = require('./state').get('extension');
  const extension = { seen: seen?.version || null, seenAt: seen?.at || null, latest: require('../extension/manifest.json').version };
  return { sampled, extension, wantSeasons: wantedSeasons(), wantSeries: require('./crlinks').wanted(), lastSync: last ? { at: last.at.replace(' ', 'T') + 'Z', source: last.source, summary: JSON.parse(last.summary) } : null, ...counts, needsReview: review, inProgress };
}

/** Manually fix a season mapping and re-apply its rows. */
async function remapSeason(seasonId, malId, offset = 0) {
  const sample = db.prepare('SELECT series_title, season_title FROM cr_history WHERE season_id = ? LIMIT 1').get(seasonId) || {};
  // Undo what the old mapping did: unmark episodes of the previously mapped show(s) that only this
  // season's plays marked, and drop such a show from the library if nothing else of it remains.
  const old = db.prepare(`SELECT DISTINCT mal_id, mal_episode FROM cr_history WHERE season_id = ? AND mal_id > 0 AND mal_id <> ?`).all(seasonId, malId);
  const otherPlay = db.prepare('SELECT 1 FROM cr_history WHERE mal_id = ? AND mal_episode = ? AND season_id <> ? LIMIT 1');
  const byShow = new Map();
  for (const r of old) { if (!otherPlay.get(r.mal_id, r.mal_episode, seasonId)) { if (!byShow.has(r.mal_id)) byShow.set(r.mal_id, []); byShow.get(r.mal_id).push(r.mal_episode); } }
  for (const [oldId, eps] of byShow) {
    library.unmarkEpisodes(oldId, eps);
    const stillUsed = db.prepare('SELECT 1 FROM cr_history WHERE mal_id = ? AND season_id <> ? LIMIT 1').get(oldId, seasonId)
      || db.prepare('SELECT 1 FROM episode_sync WHERE mal_id = ? AND watched = 1 LIMIT 1').get(oldId)
      || db.prepare('SELECT 1 FROM watchlist WHERE mal_id = ? AND (rating IS NOT NULL OR list_status IS NOT NULL)').get(oldId);
    if (!stillUsed) library.removeFromLibrary(oldId);
  }
  db.prepare('DELETE FROM cr_season_map WHERE season_id = ?').run(seasonId);
  insertRuleStmt.run(seasonId, 0, 100000, malId, offset, 'manual', sample.series_title || null, sample.season_title || null, 0);
  db.prepare('UPDATE cr_history SET mal_id = NULL, mal_episode = NULL, map_source = NULL, applied = 0 WHERE season_id = ?').run(seasonId);
  if (!library.isInLibrary(malId)) {
    ensureInLibrary(malId);
    await anilist.fetchFullByMalIds([malId]).catch(() => {});
  }
  return ingest([], { source: 'manual' });
}

/**
 * "Track this": a show the user only sampled (no play counted as watched) never gets resolved by
 * ingest. Resolve its season now, add it to the library, and apply whatever plays exist.
 */
async function trackSeason(seasonId) {
  const rows = db.prepare('SELECT * FROM cr_history WHERE season_id = ? ORDER BY episode_number').all(seasonId);
  if (!rows.length) throw Object.assign(new Error('unknown season'), { status: 404 });
  const existing = anyRuleStmt.get(seasonId);
  if (existing?.mal_id) {
    if (!library.isInLibrary(existing.mal_id)) ensureInLibrary(existing.mal_id);
    return { malId: existing.mal_id, title: db.prepare('SELECT COALESCE(title_english, title) AS t FROM media WHERE mal_id = ?').get(existing.mal_id)?.t || rows[0].series_title };
  }
  let rule = ruleFromTitles(rows, titleIndex());
  if (!rule) {
    const minEp = Math.min(...rows.map((r) => r.episode_number).filter((n) => n != null), Infinity);
    rule = await ruleFromAniList(rows[0], Number.isFinite(minEp) ? minEp : 1);
  }
  if (!rule || !rule.mal) throw Object.assign(new Error(`Couldn't find “${rows[0].series_title}” on AniList`), { status: 404 });
  db.prepare('DELETE FROM cr_season_map WHERE season_id = ?').run(seasonId);
  insertRuleStmt.run(seasonId, 0, 100000, rule.mal, rule.offset, rule.source, rows[0].series_title, rows[0].season_title, rule.needsReview ? 1 : 0);
  if (!library.isInLibrary(rule.mal)) ensureInLibrary(rule.mal);
  await anilist.fetchFullByMalIds([rule.mal]).catch(() => {});
  db.prepare('UPDATE cr_history SET applied = 0 WHERE season_id = ?').run(seasonId);
  await ingest([], { source: 'manual' });
  sync.enqueue(rule.mal);
  const title = db.prepare('SELECT COALESCE(title_english, title) AS t FROM media WHERE mal_id = ?').get(rule.mal)?.t || rows[0].series_title;
  return { malId: rule.mal, title, needsReview: Boolean(rule.needsReview) };
}

/** Hide (or bring back) a paused episode on the Started-on-Crunchyroll shelf. */
function dismissPlay(episodeId, undo = false) {
  const info = db.prepare('UPDATE cr_history SET dismissed = ? WHERE episode_id = ?').run(undo ? 0 : 1, episodeId);
  if (!info.changes) throw Object.assign(new Error('unknown play'), { status: 404 });
  return { ok: true, dismissed: !undo };
}

function confirmSeason(seasonId) {
  db.prepare('UPDATE cr_season_map SET needs_review = 0 WHERE season_id = ?').run(seasonId);
  return { ok: true };
}

/** Sampled seasons the user said "not interested" to (kept in app_state). */
function hiddenSampled() { return require('./state').get('sampledHidden')?.ids || []; }
function hideSampled(seasonId, undo = false) {
  const ids = new Set(hiddenSampled());
  if (undo) ids.delete(seasonId); else ids.add(seasonId);
  require('./state').set('sampledHidden', { ids: [...ids].slice(-2000) });
  return { ok: true };
}

module.exports = { hideSampled, ingest, status, remapSeason, confirmSeason, trackSeason, dismissPlay, normalizeRow, applySeasonEpisodes, wantedSeasons };
