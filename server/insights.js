'use strict';
// "What should I watch next", recommendations, and the viewing-habits study.
const { db } = require('./db');
const images = require('./images');
const anilist = require('./sources/anilist');
const library = require('./library');
const { parseJSONField } = require('./util');
const crlinks = require('./crlinks');

const DAY = 86400000;
const displayTitle = (r) => r.title_english || r.titleEnglish || r.title || '';
/** "Campfire Cooking ... Season 2" and "... Season 1" share a root, so a reason lists the franchise once. */
const franchiseRoot = (t) => String(t || '').toLowerCase()
  .replace(/\b(season|part|cour)\s*\d+\b|\b\d+(st|nd|rd|th)\s+season\b|\b(ii|iii|iv)\b|[:\-–].*$/g, '').replace(/\s+/g, ' ').trim();

function libraryState() {
  return db.prepare(`
    SELECT a.mal_id, a.title, a.title_english, COALESCE(m.cover_url, a.image_url) AS cover, w.list_status, w.rating, m.status, m.format,
           m.episodes, m.next_airing_episode, m.next_airing_at, m.average_score, m.genres, m.tags, m.duration, m.start_date,
           COUNT(e.episode_number) AS ep_rows, COALESCE(SUM(e.watched = 1), 0) AS watched,
           MAX(CASE WHEN e.watched = 1 THEN e.watched_at END) AS last_watched,
           MIN(CASE WHEN e.watched = 1 THEN e.watched_at END) AS first_watched,
           MIN(CASE WHEN e.watched = 0 THEN e.episode_number END) AS next_unwatched,
           MAX(CASE WHEN e.watched = 1 THEN e.episode_number END) AS max_watched
    FROM watchlist w JOIN anime a ON a.mal_id = w.mal_id
    LEFT JOIN media m ON m.mal_id = a.mal_id
    LEFT JOIN episode_sync e ON e.mal_id = a.mal_id
    GROUP BY a.mal_id`).all();
}

function card(r, extra = {}) {
  return {
    malId: r.mal_id,
    title: displayTitle(r),
    image: images.localUrl(r.cover),
    format: r.format,
    status: r.status,
    averageScore: r.average_score,
    ...extra
  };
}

/** Buckets: continue watching, new episodes airing soon, new seasons available, stalled shows. */
function upNext() {
  const now = Date.now();
  const rows = libraryState();
  const byId = new Map(rows.map((r) => [r.mal_id, r]));
  const continueWatching = []; const airingSoon = []; const stalled = []; const caughtUpAiring = []; const onHold = [];
  let dropped = 0;

  for (const r of rows) {
    if (!r.watched) continue;
    // Dropped shows leave Up Next entirely; held ones get their own shelf.
    if (r.list_status === 'dropped') { dropped += 1; continue; }
    const aired = library.airedCount({ status: r.status, next_airing_episode: r.next_airing_episode, episodes: r.episodes }) ?? r.ep_rows;
    // Progress = furthest episode watched; isolated gaps before it are usually history noise, not "unwatched".
    const furthest = r.max_watched || 0;
    const remaining = Math.max(0, (aired || 0) - furthest);
    const lastAgeDays = r.last_watched ? (now - new Date(r.last_watched).getTime()) / DAY : 9999;
    const nextEp = remaining > 0 ? furthest + 1 : null;
    const nextRow = nextEp ? db.prepare('SELECT title, url, image_blob IS NOT NULL AS hasImage, updated_at FROM episode_sync WHERE mal_id = ? AND episode_number = ?').get(r.mal_id, nextEp) : null;
    // Where "Play" goes: the exact episode when Crunchyroll's URL is known, else the series page.
    const nextUrl = nextRow?.url && /crunchyroll\.com\/watch\//.test(nextRow.url) ? nextRow.url.replace(/^http:/, 'https:')
      : (() => { const s = crlinks.seriesFor(r.mal_id); return s ? (s.url || `https://www.crunchyroll.com/series/${s.id}`) : null; })();
    const latestAired = remaining > 0 ? db.prepare(`SELECT MAX(aired) AS at FROM episode_sync WHERE mal_id = ? AND episode_number > ? AND aired IS NOT NULL AND aired <= strftime('%Y-%m-%dT%H:%M:%SZ','now')`).get(r.mal_id, furthest)?.at : null;
    const info = card(r, {
      watched: r.watched, furthest, aired, remaining, lastWatchedAt: r.last_watched, latestAiredAt: latestAired || null,
      // Episodes left in the whole season (null when the season's length isn't announced).
      totalEpisodes: r.episodes ?? null, leftInSeason: r.episodes ? Math.max(0, r.episodes - furthest) : null,
      nextEpisode: nextEp, nextEpisodeTitle: nextRow?.title || null, nextEpisodeUrl: nextUrl, nextEpisodeUrlIsExact: Boolean(nextRow?.url && /watch\//.test(nextRow.url)),
      nextEpisodeImage: nextRow?.hasImage ? library.episodeImageUrl(r.mal_id, nextEp, nextRow.updated_at) : null,
      nextAiringEpisode: r.next_airing_episode, nextAiringAt: r.next_airing_at ? r.next_airing_at * 1000 : null
    });
    if (r.list_status === 'on_hold') { onHold.push({ ...info, lastAgeDays: Math.round(lastAgeDays) }); continue; }
    if (r.status === 'RELEASING' && r.next_airing_at && remaining === 0 && lastAgeDays <= 120) {
      if (r.next_airing_at * 1000 - now < 8 * DAY) airingSoon.push(info);
      else caughtUpAiring.push(info);
    }
    if (remaining > 0 && nextEp) {
      const progress = furthest / Math.max(aired || 1, 1);
      // Recently active or well underway → continue; otherwise it's stalled.
      if (lastAgeDays <= 120 || (progress >= 0.5 && lastAgeDays <= 365)) continueWatching.push({ ...info, score: remaining <= 3 ? 2 : 1, lastAgeDays });
      else stalled.push({ ...info, lastAgeDays: Math.round(lastAgeDays) });
    }
  }
  continueWatching.sort((a, b) => (a.lastAgeDays - b.lastAgeDays));
  airingSoon.sort((a, b) => a.nextAiringAt - b.nextAiringAt);
  stalled.sort((a, b) => a.remaining - b.remaining || a.lastAgeDays - b.lastAgeDays);

  // New seasons: sequels of things you watched that are out and you haven't started.
  const newSeasons = db.prepare(`
    SELECT DISTINCT r.related_mal_id AS mal_id, src.mal_id AS src_id, m.title, m.title_english, m.cover_url AS cover, m.status, m.format,
           m.episodes, m.average_score, m.start_date, m.next_airing_episode
    FROM media_relation r
    JOIN watchlist sw ON sw.mal_id = r.mal_id
    JOIN anime src ON src.mal_id = r.mal_id
    JOIN media m ON m.mal_id = r.related_mal_id
    WHERE r.relation_type = 'SEQUEL'
      AND m.status IN ('FINISHED','RELEASING')
      AND m.format IN ('TV','TV_SHORT','ONA','MOVIE','OVA','SPECIAL')
      AND COALESCE(sw.list_status, '') <> 'dropped'
      AND NOT EXISTS (SELECT 1 FROM watchlist dw WHERE dw.mal_id = r.related_mal_id AND dw.list_status = 'dropped')
      AND EXISTS (SELECT 1 FROM episode_sync e WHERE e.mal_id = r.mal_id AND e.watched = 1)
      AND NOT EXISTS (SELECT 1 FROM episode_sync e WHERE e.mal_id = r.related_mal_id AND e.watched = 1)
  `).all();
  const seen = new Set();
  const newSeasonCards = [];
  for (const s of newSeasons) {
    if (seen.has(s.mal_id)) continue;
    seen.add(s.mal_id);
    const src = byId.get(s.src_id);
    // Only suggest sequels for shows you finished (or nearly).
    const srcAired = src ? (library.airedCount({ status: src.status, next_airing_episode: src.next_airing_episode, episodes: src.episodes }) ?? src.ep_rows) : 0;
    if (src && srcAired && src.watched / srcAired < 0.75) continue;
    newSeasonCards.push(card(s, { after: src ? displayTitle(src) : null, inLibrary: library.isInLibrary(s.mal_id), episodes: s.episodes, startDate: s.start_date }));
  }
  newSeasonCards.sort((a, b) => (b.format === 'TV') - (a.format === 'TV') || (b.averageScore || 0) - (a.averageScore || 0));

  onHold.sort((a, b) => a.lastAgeDays - b.lastAgeDays);
  return { continueWatching, airingSoon, newSeasons: newSeasonCards, caughtUpAiring, stalled, onHold, dropped };
}

// Your rating scales a show's pull on recommendations: 5 stars counts double, 1-2 stars count against.
const RATING_FACTOR = { 5: 2, 4: 1.4, 3: 1, 2: 0, 1: 0 };
const isDisliked = (r) => r.list_status === 'dropped' || (r.rating && r.rating <= 2);

/** Engagement weight per library show: how much of it you watched, how recently, and your rating. */
function engagementWeights(rows) {
  const now = Date.now();
  const weights = new Map();
  for (const r of rows) {
    if (!r.watched || isDisliked(r)) continue;
    const aired = library.airedCount({ status: r.status, next_airing_episode: r.next_airing_episode, episodes: r.episodes }) || r.ep_rows || r.watched;
    let completion = Math.min(1, r.watched / Math.max(1, aired));
    if (r.rating) completion = Math.max(completion, 0.6); // a rating is a deliberate signal even for a show you're mid-way through
    else if (completion < 0.34 && r.watched < 4) continue; // sampled and dropped: not a taste signal
    const ageYears = r.last_watched ? (now - new Date(r.last_watched).getTime()) / (365 * DAY) : 5;
    const recency = 1 / (1 + ageYears * 0.5);
    weights.set(r.mal_id, completion * (0.5 + recency) * (r.rating ? RATING_FACTOR[r.rating] : 1));
  }
  return weights;
}

function tasteProfile(rows, weights) {
  const genres = new Map(); const tags = new Map();
  let total = 0;
  for (const r of rows) {
    const w = weights.get(r.mal_id);
    if (!w) continue;
    total += w;
    for (const g of parseJSONField(r.genres, [])) genres.set(g, (genres.get(g) || 0) + w);
    for (const t of parseJSONField(r.tags, [])) if (t.rank >= 60) tags.set(t.name, (tags.get(t.name) || 0) + w * (t.rank / 100));
  }
  const norm = (map) => [...map.entries()].map(([k, v]) => [k, v / (total || 1)]).sort((a, b) => b[1] - a[1]);
  return { genres: norm(genres), tags: norm(tags) };
}

function similarity(profile, media) {
  const g = new Map(profile.genres); const t = new Map(profile.tags);
  let s = 0;
  for (const genre of parseJSONField(media.genres, [])) s += (g.get(genre) || 0) * 0.6;
  for (const tag of parseJSONField(media.tags, [])) s += (t.get(tag.name) || 0) * (tag.rank / 100);
  return s;
}

let recCache = null;

/** Recommendations for unseen shows, built from AniList community recommendations of shows you engaged with. */
async function recommendations({ limit = 120, refresh = false } = {}) {
  if (recCache && !refresh && Date.now() - recCache.at < 15 * 60 * 1000) return recCache.data;
  const rows = libraryState();
  const weights = engagementWeights(rows);
  const profile = tasteProfile(rows, weights);
  const watchedIds = new Set(rows.filter((r) => r.watched > 0).map((r) => r.mal_id));
  const dismissed = new Set(db.prepare('SELECT mal_id FROM rec_dismissed').all().map((r) => r.mal_id));
  // Everything in the same franchise as something you've watched is excluded (that's "new seasons", not discovery).
  const franchise = new Set(watchedIds);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const r of db.prepare('SELECT mal_id, related_mal_id, relation_type FROM media_relation').all()) {
      if (['CHARACTER', 'OTHER', 'SUMMARY'].includes(r.relation_type)) continue;
      if (franchise.has(r.mal_id)) franchise.add(r.related_mal_id);
      if (franchise.has(r.related_mal_id)) franchise.add(r.mal_id);
    }
  }

  // Shows you dropped or rated 1-2 stars push their recommendations down instead of up.
  const disliked = new Set(rows.filter((r) => r.watched && isDisliked(r)).map((r) => r.mal_id));
  const penalty = new Map();
  const scores = new Map();
  for (const rec of db.prepare('SELECT mal_id, rec_mal_id, rating FROM media_rec WHERE rating > 0').all()) {
    if (disliked.has(rec.mal_id)) { penalty.set(rec.rec_mal_id, (penalty.get(rec.rec_mal_id) || 0) + 0.6 * Math.log1p(rec.rating)); continue; }
    const w = weights.get(rec.mal_id);
    if (!w || franchise.has(rec.rec_mal_id) || dismissed.has(rec.rec_mal_id)) continue;
    const entry = scores.get(rec.rec_mal_id) || { score: 0, because: [] };
    entry.score += w * Math.log1p(rec.rating);
    entry.because.push({ malId: rec.mal_id, w: w * Math.log1p(rec.rating) });
    scores.set(rec.rec_mal_id, entry);
  }
  const mediaStmt = db.prepare('SELECT * FROM media WHERE mal_id = ?');
  for (const [id, p] of penalty) if (scores.has(id)) scores.get(id).score -= p;
  let candidates = [...scores.entries()].filter(([, e]) => e.score > 0).map(([id, e]) => ({ id, ...e, media: mediaStmt.get(id) }))
    .filter((c) => c.media && !['MUSIC'].includes(c.media.format) && c.media.status !== 'NOT_YET_RELEASED' && c.media.status !== 'CANCELLED')
    .sort((a, b) => b.score - a.score)
    .slice(0, 200);

  // Fetch tags/relations for the top candidates so we can (a) rank by taste similarity, (b) drop sequels of unseen shows.
  const needFull = candidates.filter((c) => !c.media.is_full).map((c) => c.id);
  if (needFull.length) {
    try { await anilist.fetchFullByMalIds(needFull); } catch {}
    candidates = candidates.map((c) => ({ ...c, media: mediaStmt.get(c.id) }));
  }
  const hasPrequel = db.prepare(`SELECT 1 FROM media_relation WHERE mal_id = ? AND relation_type IN ('PREQUEL','PARENT') LIMIT 1`);
  const titleOf = new Map(rows.map((r) => [r.mal_id, displayTitle(r)]));
  const maxScore = Math.max(...candidates.map((c) => c.score), 1);
  const out = candidates
    .filter((c) => !hasPrequel.get(c.id))
    .map((c) => {
      const sim = similarity(profile, c.media);
      const quality = (c.media.average_score || 60) / 100;
      const final = (c.score / maxScore) * 0.55 + Math.min(sim, 1.5) / 1.5 * 0.3 + quality * 0.15;
      const seenRoots = new Set();
      const because = c.because.sort((a, b) => b.w - a.w).map((b) => titleOf.get(b.malId)).filter((t) => {
        const root = franchiseRoot(t);
        if (!t || seenRoots.has(root)) return false;
        seenRoots.add(root); return true;
      }).slice(0, 3);
      const sharedGenres = parseJSONField(c.media.genres, []).filter((g) => profile.genres.slice(0, 8).some(([pg]) => pg === g));
      return {
        malId: c.id, title: c.media.title_english || c.media.title, image: images.localUrl(c.media.cover_url),
        format: c.media.format, status: c.media.status, episodes: c.media.episodes, year: c.media.season_year,
        averageScore: c.media.average_score, genres: parseJSONField(c.media.genres, []), siteUrl: c.media.site_url,
        duration: c.media.duration, onCrunchyroll: Boolean(crlinks.seriesFor(c.id)),
        because, sharedGenres, inLibrary: library.isInLibrary(c.id), match: Math.round(final * 100)
      };
    })
    .sort((a, b) => b.match - a.match)
    .slice(0, limit);
  const data = { profile: { genres: profile.genres.slice(0, 12), tags: profile.tags.slice(0, 20) }, items: out };
  recCache = { at: Date.now(), data };
  return data;
}

function invalidate() { recCache = null; }

function dismiss(malId) {
  db.prepare('INSERT OR REPLACE INTO rec_dismissed (mal_id) VALUES (?)').run(malId);
  recCache = null;
  return { ok: true };
}

/** The viewing-habits study, built from Crunchyroll timestamps + library state. */
function study() {
  const allPlays = db.prepare(`SELECT h.*, m.genres, m.format, m.average_score
    FROM cr_history h LEFT JOIN media m ON m.mal_id = h.mal_id
    WHERE (h.fully_watched = 1 OR (h.duration_s > 0 AND 1.0*h.playhead/h.duration_s >= 0.8)) AND h.date_played IS NOT NULL
    ORDER BY h.date_played`).all();
  // Crunchyroll keeps each dub as its own season with its own episode ids, so one episode marked
  // watched in ten languages shows up ten times. Count each episode once (its first play).
  const seenEpisodes = new Set();
  const plays = allPlays.filter((p) => {
    // Mapped plays are keyed by MAL episode: Crunchyroll's own season numbers changed over the years.
    const key = p.mal_id > 0 && p.mal_episode ? `mal:${p.mal_id}:${p.mal_episode}`
      : `cr:${p.series_id || p.series_title}|${p.season_number ?? ''}|${p.episode_number ?? p.episode_title}`;
    if (seenEpisodes.has(key)) return false;
    seenEpisodes.add(key);
    return true;
  });
  // Times are shown in your timezone (TIMEZONE env var on Cloudflare, where the runtime clock is UTC).
  const tz = (typeof process !== 'undefined' && process.env && process.env.TIMEZONE) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const local = (d) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return { year: Number(p.year), month: p.month, day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: WD[p.weekday] };
  };
  const byYear = {}; const byWeekday = Array(7).fill(0); const byHour = Array(24).fill(0); const byMonth = {};
  let minutes = 0;
  const perDayShow = new Map();
  // Plays stamped less than 8 minutes after the previous one can't be real viewing (episodes run ~24 min):
  // they're bulk "mark as watched" actions. Count them in totals, keep them out of habits and binges.
  const order = plays.map((p) => new Date(p.date_played).getTime()).sort((a, b) => a - b);
  const bulkTimes = new Set();
  for (let i = 1; i < order.length; i += 1) if (order[i] - order[i - 1] < 8 * 60000) { bulkTimes.add(order[i]); bulkTimes.add(order[i - 1]); }
  let bulk = 0;
  for (const p of plays) {
    const d = new Date(p.date_played);
    const mins = (p.duration_s || 1440) / 60;
    minutes += mins;
    if (bulkTimes.has(d.getTime())) {
      bulk += 1;
      const y0 = local(d).year;
      byYear[y0] = byYear[y0] || { episodes: 0, hours: 0, shows: new Set() };
      byYear[y0].episodes += 1; byYear[y0].hours += mins / 60; byYear[y0].shows.add(p.series_title);
      continue;
    }
    const L = local(d);
    const y = L.year;
    byYear[y] = byYear[y] || { episodes: 0, hours: 0, shows: new Set() };
    byYear[y].episodes += 1; byYear[y].hours += mins / 60; byYear[y].shows.add(p.series_title);
    const ym = `${y}-${L.month}`;
    byMonth[ym] = (byMonth[ym] || 0) + mins / 60;
    byWeekday[L.weekday] += 1;
    byHour[L.hour] += 1;
    const key = `${L.day}|${p.series_title}`;
    perDayShow.set(key, (perDayShow.get(key) || 0) + 1);
  }
  const binges = [...perDayShow.entries()].filter(([, n]) => n >= 6).map(([k, n]) => ({ day: k.split('|')[0], show: k.split('|')[1], episodes: n }))
    .sort((a, b) => b.episodes - a.episodes);

  const rows = libraryState();
  const weights = engagementWeights(rows);
  const profile = tasteProfile(rows, weights);
  let finished = 0; let started = 0; let dropped = 0; let scoreSum = 0; let scoreN = 0;
  const formats = {};
  for (const r of rows) {
    if (!r.watched) continue;
    started += 1;
    const aired = library.airedCount({ status: r.status, next_airing_episode: r.next_airing_episode, episodes: r.episodes }) || r.ep_rows;
    const c = r.watched / Math.max(1, aired);
    if (c >= 0.9) finished += 1; else if (c < 0.34 || r.list_status === 'dropped') dropped += 1;
    if (r.average_score) { scoreSum += r.average_score; scoreN += 1; }
    formats[r.format || 'UNKNOWN'] = (formats[r.format || 'UNKNOWN'] || 0) + 1;
  }
  const perShow = new Map();
  for (const p of plays) {
    const s = perShow.get(p.series_title) || { title: p.series_title, episodes: 0, seconds: 0 };
    s.episodes += 1; s.seconds += p.duration_s || 0;
    perShow.set(p.series_title, s);
  }
  const topShows = [...perShow.values()].sort((a, b) => b.episodes - a.episodes).slice(0, 15)
    .map((s) => ({ title: s.title, episodes: s.episodes, hours: Math.round(s.seconds / 360) / 10 }));
  const recentYears = Object.keys(byYear).map(Number).sort();
  return {
    timezone: tz,
    bulkMarked: bulk,
    totals: { episodes: plays.length, hours: Math.round(minutes / 60), days: Math.round(minutes / 60 / 24 * 10) / 10, showsStarted: started, showsFinished: finished, showsDropped: dropped, firstPlay: plays.reduce((a, p) => (!a || p.date_played < a ? p.date_played : a), null) },
    byYear: recentYears.map((y) => ({ year: y, episodes: byYear[y].episodes, hours: Math.round(byYear[y].hours), shows: byYear[y].shows.size })),
    byMonth: Object.entries(byMonth).sort().slice(-24).map(([month, hours]) => ({ month, hours: Math.round(hours * 10) / 10 })),
    byWeekday, byHour,
    binges: binges.slice(0, 10),
    topShows,
    taste: { genres: profile.genres.slice(0, 10).map(([name, v]) => ({ name, weight: Math.round(v * 100) })), tags: profile.tags.slice(0, 15).map(([name, v]) => ({ name, weight: Math.round(v * 100) })) },
    formats,
    averageCommunityScore: scoreN ? Math.round(scoreSum / scoreN) : null
  };
}

module.exports = { upNext, recommendations, dismiss, study, invalidate };
