'use strict';
// AniList GraphQL client: primary metadata source (titles, airing, episodes, relations, recommendations).
// AniList allows ~30 requests/minute right now; we space requests and honour Retry-After.
const { db } = require('../db');
const { sleep, dateFromParts } = require('../util');

const ENDPOINT = 'https://graphql.anilist.co';
const MIN_INTERVAL_MS = 2100;
let lastRequestAt = 0;
let chain = Promise.resolve();

function gql(query, variables = {}) {
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
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
      const json = await res.json();
      if (json.errors && !json.data) throw new Error(`AniList: ${json.errors.map((e) => e.message).join('; ')}`);
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

const FULL_FIELDS = `${NODE_FIELDS} bannerImage siteUrl description(asHtml:false)
  tags{name rank isMediaSpoiler}
  externalLinks{site url type language}
  nextAiringEpisode{episode airingAt}
  streamingEpisodes{title thumbnail url site}
  relations{edges{relationType node{${NODE_FIELDS}}}}
  recommendations(sort:RATING_DESC,perPage:15){nodes{rating mediaRecommendation{${NODE_FIELDS}}}}`;

const upsertMediaStmt = db.prepare(`
INSERT INTO media (mal_id, anilist_id, title, title_english, format, status, episodes, duration, season_year,
  start_date, genres, tags, average_score, popularity, cover_url, banner_url, color, site_url,
  next_airing_episode, next_airing_at, streaming_episodes, external_links, description, is_full, fetched_at)
VALUES (@mal_id, @anilist_id, @title, @title_english, @format, @status, @episodes, @duration, @season_year,
  @start_date, @genres, @tags, @average_score, @popularity, @cover_url, @banner_url, @color, @site_url,
  @next_airing_episode, @next_airing_at, @streaming_episodes, @external_links, @description, @is_full, CURRENT_TIMESTAMP)
ON CONFLICT(mal_id) DO UPDATE SET
  anilist_id=excluded.anilist_id, title=excluded.title, title_english=excluded.title_english,
  format=excluded.format, status=excluded.status, episodes=excluded.episodes, duration=excluded.duration,
  season_year=excluded.season_year, start_date=excluded.start_date, genres=excluded.genres,
  tags=COALESCE(excluded.tags, media.tags), average_score=excluded.average_score, popularity=excluded.popularity,
  cover_url=excluded.cover_url, banner_url=COALESCE(excluded.banner_url, media.banner_url),
  color=excluded.color, site_url=COALESCE(excluded.site_url, media.site_url),
  next_airing_episode=CASE WHEN excluded.is_full=1 THEN excluded.next_airing_episode ELSE media.next_airing_episode END,
  next_airing_at=CASE WHEN excluded.is_full=1 THEN excluded.next_airing_at ELSE media.next_airing_at END,
  streaming_episodes=COALESCE(excluded.streaming_episodes, media.streaming_episodes),
  external_links=COALESCE(excluded.external_links, media.external_links),
  description=COALESCE(excluded.description, media.description),
  is_full=MAX(media.is_full, excluded.is_full),
  fetched_at=CASE WHEN excluded.is_full=1 OR media.is_full=0 THEN CURRENT_TIMESTAMP ELSE media.fetched_at END
`);
const deleteRelationsStmt = db.prepare('DELETE FROM media_relation WHERE mal_id = ?');
const insertRelationStmt = db.prepare('INSERT OR IGNORE INTO media_relation (mal_id, related_mal_id, relation_type) VALUES (?, ?, ?)');
const deleteRecsStmt = db.prepare('DELETE FROM media_rec WHERE mal_id = ?');
const insertRecStmt = db.prepare('INSERT OR REPLACE INTO media_rec (mal_id, rec_mal_id, rating) VALUES (?, ?, ?)');
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
    description: isFull && m.description ? m.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : null,
    is_full: isFull ? 1 : 0
  };
}

const storeFull = db.transaction((list) => {
  for (const m of list) {
    if (!m.idMal) continue;
    upsertMediaStmt.run(mediaRow(m, true));
    if (m.description) updateSynopsisStmt.run(m.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(), m.idMal);
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

/** Fetch full metadata (incl. relations + recommendations) for MAL ids, 25 per request. */
async function fetchFullByMalIds(malIds, onProgress) {
  const ids = [...new Set(malIds.map(Number).filter(Boolean))];
  const query = `query($ids:[Int]){Page(perPage:25){media(idMal_in:$ids,type:ANIME){${FULL_FIELDS}}}}`;
  const found = new Set();
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const data = await gql(query, { ids: chunk });
    const list = data?.Page?.media || [];
    storeFull(list);
    list.forEach((m) => found.add(m.idMal));
    if (onProgress) onProgress(Math.min(i + 25, ids.length), ids.length);
  }
  return { requested: ids.length, found: found.size, missing: ids.filter((id) => !found.has(id)) };
}

/** Search AniList; returns light-weight results with MAL ids. */
async function search(text, perPage = 8) {
  const query = `query($s:String,$n:Int){Page(perPage:$n){media(search:$s,type:ANIME){${NODE_FIELDS} description(asHtml:false)}}}`;
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
    averageScore: m.averageScore ?? null
  };
}

module.exports = { gql, fetchFullByMalIds, search, toLibraryAnime, storeFull };
