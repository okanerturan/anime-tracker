'use strict';
const { db } = require('./db');
const library = require('./library');
const images = require('./images');
const sync = require('./sync');
const crunchyroll = require('./crunchyroll');
const insights = require('./insights');
const anilist = require('./sources/anilist');
const { sendJSON, parseBody } = require('./http');

const num = (v) => Number(v) || 0;
/** One CSV cell: quoted when needed, and prefixed with ' when it would start a spreadsheet formula. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Requests that change data from outside the app (the extension) must carry this header.
// Browsers can't add custom headers cross-origin without a CORS preflight, which we never approve,
// so random websites cannot post fake history to the local server.
function requireClientHeader(req) {
  const value = req.headers['x-tracker-client'];
  if (value !== 'extension' && value !== 'app') { const e = new Error('missing X-Tracker-Client header'); e.status = 403; throw e; }
}

const routes = {
  'GET /api/watchlist': (req, res, url) => sendJSON(res, 200, library.getWatchlist(url.searchParams.get('sort') || 'release_desc')),
  'GET /api/anime': async (req, res, url) => {
    // ?refresh=1 fetches full AniList metadata first (queued for the browser relay when AniList blocks us).
    if (url.searchParams.get('refresh') === '1') await anilist.fetchFullByMalIds([num(url.searchParams.get('malId'))]).catch(() => {});
    const a = library.getAnime(num(url.searchParams.get('malId')));
    return a ? sendJSON(res, 200, a) : sendJSON(res, 404, { error: 'not in library' });
  },
  'GET /api/anime/details': (req, res, url) => sendJSON(res, 200, library.getDetails(num(url.searchParams.get('malId')))),
  'GET /api/watchlist-episodes': (req, res) => sendJSON(res, 200, library.getAllEpisodes()),
  'GET /api/thumbnails': (req, res, url) => sendJSON(res, 200, library.getEpisodes(num(url.searchParams.get('malId')))),

  'POST /api/watchlist/add': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const anime = body.anime || body;
    if (!anime?.malId) return sendJSON(res, 400, { error: 'anime.malId required' });
    library.addToLibrary(anime);
    anilist.fetchFullByMalIds([anime.malId]).then(() => sync.enqueue(anime.malId)).catch(() => sync.enqueue(anime.malId));
    return sendJSON(res, 200, { ok: true });
  },
  'POST /api/watchlist/remove': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!num(body.malId)) return sendJSON(res, 400, { error: 'malId required' });
    const removed = library.removeFromLibrary(num(body.malId));
    insights.invalidate();
    return sendJSON(res, 200, { ok: true, removed });
  },
  'POST /api/watchlist/restore': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!library.restoreToLibrary(body.removed)) return sendJSON(res, 400, { error: 'nothing to restore' });
    insights.invalidate();
    return sendJSON(res, 200, { ok: true });
  },
  'POST /api/episode/toggle-watched': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!num(body.malId) || !num(body.episodeNumber)) return sendJSON(res, 400, { error: 'malId and episodeNumber required' });
    if (body.watched) library.reactivate([num(body.malId)]);
    return sendJSON(res, 200, library.setWatched(num(body.malId), num(body.episodeNumber), Boolean(body.watched)));
  },
  'POST /api/anime/list-status': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const result = library.setListStatus(num(body.malId), body.status || null);
    insights.invalidate();
    return sendJSON(res, 200, result);
  },
  // Several shows at once (bulk hold/drop from the Library), capped to keep one request small.
  'POST /api/anime/list-status-batch': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const ids = (Array.isArray(body.malIds) ? body.malIds : []).map(num).filter(Boolean).slice(0, 500);
    const status = body.status || null;
    let changed = 0;
    db.transaction(() => { for (const id of ids) { try { library.setListStatus(id, status); changed += 1; } catch {} } })();
    insights.invalidate();
    return sendJSON(res, 200, { ok: true, changed, status });
  },
  'POST /api/anime/rating': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const result = library.setRating(num(body.malId), body.rating == null ? null : Number(body.rating));
    insights.invalidate();
    return sendJSON(res, 200, result);
  },
  'POST /api/anime/watched-elsewhere': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const malId = num(body.malId);
    if (!malId) return sendJSON(res, 400, { error: 'malId required' });
    await anilist.fetchFullByMalIds([malId]).catch(() => {});
    const result = library.markWatchedElsewhere(malId);
    insights.invalidate(); // it now counts toward your taste and its franchise leaves Discover
    sync.enqueue(malId); // fill in titles + thumbnails in the background
    return sendJSON(res, 200, result);
  },
  'POST /api/episode/unmark': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!num(body.malId) || !Array.isArray(body.episodes)) return sendJSON(res, 400, { error: 'malId and episodes required' });
    const r = library.unmarkEpisodes(num(body.malId), body.episodes.slice(0, 2000));
    if (body.removeFromLibrary) library.removeFromLibrary(num(body.malId));
    insights.invalidate();
    return sendJSON(res, 200, r);
  },
  'POST /api/episode/watched-through': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!num(body.malId) || !num(body.episodeNumber)) return sendJSON(res, 400, { error: 'malId and episodeNumber required' });
    library.reactivate([num(body.malId)]);
    return sendJSON(res, 200, library.markWatchedThrough(num(body.malId), num(body.episodeNumber)));
  },

  'GET /api/search': async (req, res, url) => {
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) return sendJSON(res, 400, { error: 'q must be at least 2 chars' });
    const results = (await anilist.search(q, 10)).map(anilist.toLibraryAnime)
      .map((a) => ({ ...a, image: images.localUrl(a.imageUrl), inLibrary: library.isInLibrary(a.malId) }));
    return sendJSON(res, 200, results);
  },

  'GET /api/sync-status': (req, res) => sendJSON(res, 200, { ...sync.status(), anilist: anilist.relayStatus() }),
  // AniList relay: the extension and the web app run queued AniList requests from the browser.
  'GET /api/anilist/relay': (req, res) => sendJSON(res, 200, anilist.takeRelayJobs()),
  'POST /api/anilist/relay': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const stored = anilist.applyRelayAnswers(Array.isArray(body.answers) ? body.answers.slice(0, 40) : []);
    for (const id of stored) if (library.isInLibrary(id)) sync.enqueue(id);
    if (stored.length) insights.invalidate();
    return sendJSON(res, 200, { stored: stored.length, ...anilist.relayStatus() });
  },
  'POST /api/sync/run': async (req, res) => { requireClientHeader(req); sync.refreshCycle(); return sendJSON(res, 200, { ok: true }); },
  'POST /api/sync-episodes': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const malId = num(body.malId);
    if (!malId) return sendJSON(res, 400, { error: 'malId required' });
    await anilist.fetchFullByMalIds([malId]).catch(() => {});
    await sync.syncEpisodes(malId);
    return sendJSON(res, 200, library.getEpisodes(malId));
  },

  'GET /api/up-next': (req, res) => sendJSON(res, 200, insights.upNext()),
  'GET /api/recommendations': async (req, res, url) => sendJSON(res, 200, await insights.recommendations({ refresh: url.searchParams.get('refresh') === '1' })),
  'POST /api/recommendations/dismiss': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    return sendJSON(res, 200, insights.dismiss(num(body.malId), { undo: Boolean(body.undo) }));
  },
  'GET /api/study': (req, res) => sendJSON(res, 200, insights.study()),
  // The whole history as CSV for spreadsheets: one row per episode, newest first.
  'GET /api/history.csv': (req, res) => {
    const { items } = insights.history({ limit: 100000 });
    const cell = csvCell;
    const lines = [['date_played', 'show', 'crunchyroll_series', 'season', 'episode', 'episode_title', 'percent_watched', 'myanimelist_id'].join(',')];
    for (const p of items) lines.push([p.datePlayed, p.title || p.seriesTitle, p.seriesTitle, p.seasonTitle, p.malEpisode || p.episodeNumber, p.episodeTitle, p.percent, p.malId > 0 ? p.malId : ''].map(cell).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="crunchyroll-history-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end('\ufeff' + lines.join('\r\n'));
  },
  // The library as CSV: one row per show with your progress, status and rating.
  'GET /api/library.csv': (req, res) => {
    const cell = csvCell;
    const status = (x) => {
      const aired = x.airedEpisodes ?? x.episodesCount; const done = x.progress ?? x.watchedCount;
      if (x.listStatus === 'dropped') return 'dropped';
      if (x.listStatus === 'on_hold') return 'on hold';
      if (!done) return x.status === 'NOT_YET_RELEASED' ? 'upcoming' : 'not started';
      if (aired && done >= aired) return x.status === 'RELEASING' ? 'caught up' : 'completed';
      return 'watching';
    };
    const lines = [['title', 'english_title', 'format', 'year', 'status', 'watched', 'episodes_aired', 'total_episodes', 'my_rating', 'community_score', 'last_watched', 'myanimelist_url'].join(',')];
    for (const x of library.getWatchlist('title_asc')) {
      lines.push([x.title, x.titleEnglish, x.format, x.releaseDate?.slice(0, 4), status(x), x.progress ?? x.watchedCount, x.airedEpisodes ?? x.episodesCount, x.totalEpisodes,
        x.rating, x.averageScore, x.lastWatchedAt?.slice(0, 10), `https://myanimelist.net/anime/${x.malId}`].map(cell).join(','));
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="anime-library-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end('\ufeff' + lines.join('\r\n'));
  },
  'GET /api/seasonal': async (req, res, url) => sendJSON(res, 200, await insights.seasonal({ refresh: url.searchParams.get('refresh') === '1' })),
  'GET /api/history': (req, res, url) => sendJSON(res, 200, insights.history({ before: url.searchParams.get('before') || null, limit: Math.min(200, Number(url.searchParams.get('limit')) || 60) })),

  'GET /api/crunchyroll/status': (req, res) => sendJSON(res, 200, crunchyroll.status()),
  'POST /api/crunchyroll/ingest': async (req, res) => {
    requireClientHeader(req);
    if (req.headers['x-extension-version']) { try { require('./state').set('extension', { version: String(req.headers['x-extension-version']).slice(0, 20) }); } catch {} }
    const body = await parseBody(req);
    const rows = Array.isArray(body) ? body : body.rows;
    if (!Array.isArray(rows)) return sendJSON(res, 400, { error: 'rows array required' });
    return sendJSON(res, 200, await crunchyroll.ingest(rows, { source: body.source === 'manual' ? 'manual' : 'extension' }));
  },
  'POST /api/crunchyroll/episodes': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    return sendJSON(res, 200, await crunchyroll.applySeasonEpisodes(body.seasons));
  },
  // Crunchyroll series search results from the extension: [{ malId, candidates: [{ id, title }] }].
  'POST /api/crunchyroll/series': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const result = require('./crlinks').applyResults(Array.isArray(body.results) ? body.results.slice(0, 50) : []);
    if (result.found) insights.invalidate();
    return sendJSON(res, 200, result);
  },
  // For the extension's card on crunchyroll.com series pages.
  // MyAnimeList export import (the page parses the XML and sends the entries).
  'POST /api/import/mal': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    const entries = Array.isArray(body.entries) ? body.entries.slice(0, 10000) : [];
    const summary = library.importMalList(entries);
    // Metadata, episode titles and thumbnails for the new shows fill in in the background.
    const ids = entries.map((e) => Number(e.malId)).filter(Boolean);
    anilist.fetchFullByMalIds(ids).catch(() => {}).finally(() => ids.slice(0, 300).forEach((id) => sync.enqueue(id)));
    insights.invalidate();
    return sendJSON(res, 200, summary);
  },
  'GET /api/library/suspicious': (req, res) => sendJSON(res, 200, library.suspiciousProgress()),
  'GET /api/crunchyroll/series-info': (req, res, url) => sendJSON(res, 200, require('./crlinks').showsForSeries(String(url.searchParams.get('seriesId') || ''))),
  'POST /api/crunchyroll/dismiss-play': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!body.episodeId) return sendJSON(res, 400, { error: 'episodeId required' });
    return sendJSON(res, 200, crunchyroll.dismissPlay(String(body.episodeId), Boolean(body.undo)));
  },
  'POST /api/crunchyroll/hide-sampled': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!body.seasonId) return sendJSON(res, 400, { error: 'seasonId required' });
    return sendJSON(res, 200, crunchyroll.hideSampled(String(body.seasonId).slice(0, 40), Boolean(body.undo)));
  },
  'POST /api/crunchyroll/track': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!body.seasonId) return sendJSON(res, 400, { error: 'seasonId required' });
    const result = await crunchyroll.trackSeason(String(body.seasonId));
    insights.invalidate();
    return sendJSON(res, 200, result);
  },
  'POST /api/crunchyroll/remap': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!body.seasonId || !num(body.malId)) return sendJSON(res, 400, { error: 'seasonId and malId required' });
    return sendJSON(res, 200, await crunchyroll.remapSeason(String(body.seasonId), num(body.malId), num(body.offset)));
  },
  'POST /api/crunchyroll/confirm': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    return sendJSON(res, 200, crunchyroll.confirmSeason(String(body.seasonId || '')));
  },

  'GET /api/stats': (req, res) => sendJSON(res, 200, {
    library: db.prepare('SELECT COUNT(*) n FROM watchlist').get().n,
    episodes: {
      ...db.prepare('SELECT COUNT(*) n, COALESCE(SUM(watched), 0) w FROM episode_sync INDEXED BY idx_episode_sync_progress').get(),
      i: db.prepare('SELECT COUNT(*) i FROM episode_sync WHERE image_blob IS NOT NULL').get().i
    },
    images: images.stats()
  }),

  'GET /api/episode-image': (req, res, url) => {
    const malId = num(url.searchParams.get('malId'));
    const ep = num(url.searchParams.get('episodeNumber'));
    const row = library.getEpisodeImage(malId, ep);
    if (!row?.imageBlob) { res.writeHead(404); return res.end(); }
    const etag = `"${malId}-${ep}-${String(row.updatedAt || '').replace(/\D/g, '')}"`;
    const headers = { 'Content-Type': row.imageMime || 'image/jpeg', ETag: etag,
      // Versioned URL (?v=) changes when the image changes, so it can be cached forever.
      'Cache-Control': url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    return res.end(row.imageBlob);
  }
};

async function handle(req, res, url) {
  if (url.pathname.startsWith('/img/')) { await images.handle(req, res, url); return true; }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return false;
  try {
    await handler(req, res, url);
  } catch (err) {
    sendJSON(res, err.status || 500, { error: String(err.message || err), ...(err.code ? { code: err.code } : {}), ...(err.relay ? { relay: err.relay } : {}) });
  }
  return true;
}

module.exports = { handle, csvCell };
