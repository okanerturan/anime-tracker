'use strict';
// AniList GraphQL client: primary metadata source (titles, airing, episodes, relations, recommendations).
// AniList allows ~30 requests/minute right now; we space requests and honour Retry-After.
const { db, catalog, hasAccount } = require('../db');
const { sleep, dateFromParts } = require('../util');
const appState = require('../state');
const sha1 = require('../../worker/sha1');

const ENDPOINT = 'https://graphql.anilist.co';
const MIN_INTERVAL_MS = 2100;
let lastRequestAt = 0;
let chain = Promise.resolve();

// --- Relay for when AniList blocks this server ---------------------------------------------------
// AniList has blocked Cloudflare's network outright ("You have been manually blocked"). While blocked,
// requests are queued instead of sent; the browser extension and the open web app run them from the
// user's own connection and post the answers back (see takeRelayJobs / applyRelayAnswers).
const BLOCK_RETRY_MS = 6 * 3600 * 1000;
const RELAY_TTL_MS = 24 * 3600 * 1000;

class AniListBlockedError extends Error {
  constructor(relayJob) {
    super('AniList is blocking this server; your browser will fetch it instead');
    this.code = 'anilist_blocked';
    this.status = 503;
    this.relay = relayJob || null;
  }
}

function isBlocked() {
  const b = appState.get('anilistBlocked');
  return Boolean(b && b.until && Date.now() < b.until);
}
function markBlocked(message) {
  appState.set('anilistBlocked', { until: Date.now() + BLOCK_RETRY_MS, message });
}
function markUnblocked() {
  if (appState.get('anilistBlocked')?.until) appState.set('anilistBlocked', { until: 0 });
}

const relayKey = (query, variables) => sha1(`${query}\n${JSON.stringify(variables)}`);
const relayGetStmt = catalog.prepare('SELECT data, answered_at FROM anilist_relay WHERE key = ?');
const relayRequestStmt = catalog.prepare(`INSERT INTO anilist_relay (key, query, variables) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET requested_at = CURRENT_TIMESTAMP`);
const relayAnswerStmt = catalog.prepare(`UPDATE anilist_relay SET data = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key = ?`);
const pendingIdStmt = catalog.prepare('INSERT OR IGNORE INTO anilist_pending_ids (mal_id) VALUES (?)');

/** A relayed answer for this exact request, or queue it for the browser and throw. */
function fromRelay(query, variables) {
  const key = relayKey(query, variables);
  const row = relayGetStmt.get(key);
  if (row?.data && row.answered_at && Date.now() - new Date(row.answered_at).getTime() < RELAY_TTL_MS) return JSON.parse(row.data);
  relayRequestStmt.run(key, query, JSON.stringify(variables));
  throw new AniListBlockedError({ id: key, query, variables });
}

function gql(query, variables = {}) {
  if (isBlocked()) return Promise.resolve().then(() => fromRelay(query, variables));
  // Serialize all requests through one chain so concurrent callers share the rate budget.
  const run = async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      let res;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'anime-tracker/2.0 (+https://github.com/okturan/anime-tracker)' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(20000)
        });
      } catch (err) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (res.status === 429) {
        await sleep((Number(res.headers.get('retry-after')) || 30) * 1000 + 500);
        continue;
      }
      if (res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
      const json = await res.json().catch(() => ({}));
      const message = (json.errors || []).map((e) => e.message).join('; ');
      if (res.status === 403 || /blocked/i.test(message)) {
        markBlocked(message || `HTTP ${res.status}`);
        return fromRelay(query, variables);
      }
      if (json.errors && !json.data) throw new Error(`AniList: ${message}`);
      markUnblocked();
      return json.data;
    }
    throw new Error('AniList: retries exhausted');
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const NODE_FIELDS = `id idMal type format status episodes duration seasonYear
  title{romaji english} startDate{year month day} coverImage{extraLarge large color}
  genres averageScore popularity`;

const FULL_FIELDS = `${NODE_FIELDS} bannerImage siteUrl description(asHtml:false) synonyms
  tags{name rank isMediaSpoiler}
  externalLinks{site url type language}
  nextAiringEpisode{episode airingAt}
  streamingEpisodes{title thumbnail url site}
  relations{edges{relationType node{${NODE_FIELDS}}}}
  recommendations(sort:RATING_DESC,perPage:15){nodes{rating mediaRecommendation{${NODE_FIELDS}}}}`;

const upsertMediaStmt = catalog.prepare(`
INSERT INTO media (mal_id, anilist_id, title, title_english, format, status, episodes, duration, season_year,
  start_date, start_day_known, genres, tags, average_score, popularity, cover_url, banner_url, color, site_url,
  next_airing_episode, next_airing_at, streaming_episodes, external_links, description, synonyms, is_full, fetched_at)
VALUES (@mal_id, @anilist_id, @title, @title_english, @format, @status, @episodes, @duration, @season_year,
  @start_date, @start_day_known, @genres, @tags, @average_score, @popularity, @cover_url, @banner_url, @color, @site_url,
  @next_airing_episode, @next_airing_at, @streaming_episodes, @external_links, @description, @synonyms, @is_full, CURRENT_TIMESTAMP)
ON CONFLICT(mal_id) DO UPDATE SET
  anilist_id=excluded.anilist_id, title=excluded.title, title_english=excluded.title_english,
  format=excluded.format, status=excluded.status, episodes=excluded.episodes, duration=excluded.duration,
  season_year=excluded.season_year, start_date=excluded.start_date, start_day_known=excluded.start_day_known, genres=excluded.genres,
  tags=COALESCE(excluded.tags, media.tags), average_score=excluded.average_score, popularity=excluded.popularity,
  cover_url=excluded.cover_url, banner_url=COALESCE(excluded.banner_url, media.banner_url),
  color=excluded.color, site_url=COALESCE(excluded.site_url, media.site_url),
  next_airing_episode=CASE WHEN excluded.is_full=1 THEN excluded.next_airing_episode ELSE media.next_airing_episode END,
  next_airing_at=CASE WHEN excluded.is_full=1 THEN excluded.next_airing_at ELSE media.next_airing_at END,
  streaming_episodes=COALESCE(excluded.streaming_episodes, media.streaming_episodes),
  external_links=COALESCE(excluded.external_links, media.external_links),
  description=COALESCE(excluded.description, media.description),
  synonyms=COALESCE(excluded.synonyms, media.synonyms),
  is_full=MAX(media.is_full, excluded.is_full),
  fetched_at=CASE WHEN excluded.is_full=1 OR media.is_full=0 THEN CURRENT_TIMESTAMP ELSE media.fetched_at END
`);
const deleteRelationsStmt = catalog.prepare('DELETE FROM media_relation WHERE mal_id = ?');
const insertRelationStmt = catalog.prepare('INSERT OR IGNORE INTO media_relation (mal_id, related_mal_id, relation_type) VALUES (?, ?, ?)');
const deleteRecsStmt = catalog.prepare('DELETE FROM media_rec WHERE mal_id = ?');
const insertRecStmt = catalog.prepare('INSERT OR REPLACE INTO media_rec (mal_id, rec_mal_id, rating) VALUES (?, ?, ?)');
const updateSynopsisStmt = db.prepare(`UPDATE anime SET synopsis = ? WHERE mal_id = ? AND (synopsis IS NULL OR synopsis = '' OR synopsis = 'No synopsis available.')`);

function mediaRow(m, isFull) {
  return {
    mal_id: m.idMal,
    anilist_id: m.id,
    title: m.title?.romaji || m.title?.english || '',
    title_english: m.title?.english || null,
    format: m.format || null,
    status: m.status || null,
    episodes: m.episodes ?? null,
    duration: m.duration ?? null,
    season_year: m.seasonYear ?? null,
    start_date: dateFromParts(m.startDate),
    start_day_known: m.startDate?.year ? (m.startDate.day ? 1 : 0) : null,
    genres: JSON.stringify(m.genres || []),
    tags: isFull ? JSON.stringify((m.tags || []).filter((t) => !t.isMediaSpoiler).map((t) => ({ name: t.name, rank: t.rank }))) : null,
    average_score: m.averageScore ?? null,
    popularity: m.popularity ?? null,
    cover_url: m.coverImage?.extraLarge || m.coverImage?.large || null,
    banner_url: isFull ? m.bannerImage || null : null,
    color: m.coverImage?.color || null,
    site_url: isFull ? m.siteUrl || null : null,
    next_airing_episode: isFull ? m.nextAiringEpisode?.episode ?? null : null,
    next_airing_at: isFull ? m.nextAiringEpisode?.airingAt ?? null : null,
    streaming_episodes: isFull ? JSON.stringify(m.streamingEpisodes || []) : null,
    external_links: isFull ? JSON.stringify((m.externalLinks || []).filter((l) => l.type === 'STREAMING').map((l) => ({ site: l.site, url: l.url, language: l.language }))) : null,
    // Search aliases: keep short Latin-alphabet ones ("JJK", "SnK", "Mushoku Tensei"); other scripts can't be typed here anyway.
    synonyms: isFull ? JSON.stringify((m.synonyms || []).filter((x) => x && x.length <= 100 && /^[\x20-\x7E\u00C0-\u017F]+$/.test(x)).slice(0, 8)) : null,
    description: isFull && m.description ? m.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : null,
    is_full: isFull ? 1 : 0
  };
}

// Catalog rows in one catalog transaction; the synopsis copy in the account's own library row after
// it (hosted mode: only when there is an account, e.g. not from a background catalog job).
const storeCatalog = catalog.transaction((list) => {
  for (const m of list) {
    if (!m.idMal) continue;
    upsertMediaStmt.run(mediaRow(m, true));
    deleteRelationsStmt.run(m.idMal);
    for (const edge of m.relations?.edges || []) {
      const node = edge.node;
      if (!node?.idMal || node.type !== 'ANIME') continue;
      upsertMediaStmt.run(mediaRow(node, false));
      insertRelationStmt.run(m.idMal, node.idMal, edge.relationType);
    }
    deleteRecsStmt.run(m.idMal);
    for (const rec of m.recommendations?.nodes || []) {
      const node = rec.mediaRecommendation;
      if (!node?.idMal) continue;
      upsertMediaStmt.run(mediaRow(node, false));
      insertRecStmt.run(m.idMal, node.idMal, rec.rating ?? 0);
    }
  }
});
function storeFull(list) {
  storeCatalog(list);
  if (!hasAccount()) return;
  for (const m of list) {
    if (m?.idMal && m.description) updateSynopsisStmt.run(m.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(), m.idMal);
  }
}


/** Fetch full metadata (incl. relations + recommendations) for MAL ids, 25 per request. */
const FULL_QUERY = `query($ids:[Int]){Page(perPage:25){media(idMal_in:$ids,type:ANIME){${FULL_FIELDS}}}}`;

async function fetchFullByMalIds(malIds, onProgress) {
  const ids = [...new Set(malIds.map(Number).filter(Boolean))];
  const query = FULL_QUERY;
  const found = new Set();
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    let data;
    if (isBlocked()) {
      // Blocked: queue every remaining id for the browser relay rather than failing.
      catalog.transaction(() => { for (const id of ids.slice(i)) pendingIdStmt.run(id); })();
      return { requested: ids.length, found: found.size, deferred: ids.length - i, missing: [] };
    }
    try { data = await gql(query, { ids: chunk }); }
    catch (err) { if (err.code === 'anilist_blocked') { i -= 25; continue; } throw err; }
    const list = data?.Page?.media || [];
    storeFull(list);
    list.forEach((m) => found.add(m.idMal));
    if (onProgress) onProgress(Math.min(i + 25, ids.length), ids.length);
  }
  return { requested: ids.length, found: found.size, missing: ids.filter((id) => !found.has(id)) };
}

/** Search AniList; returns light-weight results with MAL ids. */
async function search(text, perPage = 8) {
  const query = `query($s:String,$n:Int){Page(perPage:$n){media(search:$s,type:ANIME){${NODE_FIELDS} description(asHtml:false) externalLinks{site url type}}}}`;
  const data = await gql(query, { s: String(text).slice(0, 100), n: perPage });
  return (data?.Page?.media || []).filter((m) => m.idMal);
}

function toLibraryAnime(m) {
  return {
    malId: m.idMal,
    title: m.title?.romaji || m.title?.english || '',
    titleEnglish: m.title?.english || '',
    releaseDate: dateFromParts(m.startDate),
    imageUrl: m.coverImage?.extraLarge || m.coverImage?.large || '',
    synopsis: m.description ? m.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : 'No synopsis available.',
    totalEpisodes: m.episodes ?? null,
    format: m.format || null,
    averageScore: m.averageScore ?? null,
    status: m.status || null,
    crunchyrollUrl: (m.externalLinks || []).find((l) => l.type === 'STREAMING' && /crunchyroll/i.test(l.site || ''))?.url?.replace(/^http:/, 'https:') || null,
    watchOn: (m.externalLinks || []).filter((l) => l.type === 'STREAMING').map((l) => l.site)
  };
}

/** Work for the browser relay: queued metadata ids (25 per request) and other queued queries. */
function takeRelayJobs({ maxBatches = 8, maxQueries = 10 } = {}) {
  const ids = db.prepare('SELECT mal_id FROM anilist_pending_ids ORDER BY requested_at LIMIT ?').all(maxBatches * 25).map((r) => r.mal_id);
  const jobs = [];
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    jobs.push({ id: `full:${chunk.join(',')}`, query: FULL_QUERY, variables: { ids: chunk } });
  }
  // Full-metadata requests go through anilist_pending_ids above, so skip their relay rows here.
  const queries = db.prepare(`SELECT key, query, variables FROM anilist_relay WHERE (answered_at IS NULL OR answered_at < requested_at) AND query <> ?
    ORDER BY requested_at DESC LIMIT ?`).all(FULL_QUERY, maxQueries);
  for (const q of queries) jobs.push({ id: q.key, query: q.query, variables: JSON.parse(q.variables) });
  const blocked = appState.get('anilistBlocked');
  return { blocked: isBlocked(), blockedMessage: blocked?.message || null, jobs };
}

/** Answers posted by the relay. Returns the MAL ids whose full metadata was stored. */
function applyRelayAnswers(answers) {
  const stored = [];
  for (const a of answers || []) {
    if (!a || typeof a.id !== 'string' || !a.data || typeof a.data !== 'object') continue;
    if (a.id.startsWith('full:')) {
      const requested = a.id.slice(5).split(',').map(Number).filter(Boolean);
      const list = (a.data.Page?.media || []).filter((m) => requested.includes(m.idMal));
      storeFull(list);
      stored.push(...list.map((m) => m.idMal));
      // Ids AniList doesn't know are dropped too, or they would be requested forever.
      const del = catalog.prepare('DELETE FROM anilist_pending_ids WHERE mal_id = ?');
      for (const id of requested) del.run(id);
    } else {
      relayAnswerStmt.run(JSON.stringify(a.data), a.id);
    }
  }
  catalog.prepare(`DELETE FROM anilist_relay WHERE requested_at < datetime('now','-3 days')`).run();
  return stored;
}

function relayStatus() {
  const b = appState.get('anilistBlocked');
  return {
    blocked: isBlocked(), until: b?.until || null, message: b?.message || null,
    pendingIds: db.prepare('SELECT COUNT(*) n FROM anilist_pending_ids').get().n,
    pendingQueries: db.prepare('SELECT COUNT(*) n FROM anilist_relay WHERE (answered_at IS NULL OR answered_at < requested_at) AND query <> ?').get(FULL_QUERY).n
  };
}

module.exports = { gql, fetchFullByMalIds, search, toLibraryAnime, storeFull, takeRelayJobs, applyRelayAnswers, relayStatus, isBlocked, AniListBlockedError };
