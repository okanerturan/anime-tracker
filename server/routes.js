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
    library.removeFromLibrary(num(body.malId));
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
  'POST /api/crunchyroll/dismiss-play': async (req, res) => {
    requireClientHeader(req);
    const body = await parseBody(req);
    if (!body.episodeId) return sendJSON(res, 400, { error: 'episodeId required' });
    return sendJSON(res, 200, crunchyroll.dismissPlay(String(body.episodeId), Boolean(body.undo)));
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
    episodes: db.prepare('SELECT COUNT(*) n, SUM(watched) w, SUM(image_blob IS NOT NULL) i FROM episode_sync').get(),
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

module.exports = { handle };
