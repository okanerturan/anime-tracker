// Thin API client. Mutating calls carry X-Tracker-Client so the server can reject cross-site posts.
import { answerNow } from './anilist-relay.js';

async function request(url, options = {}, relayRounds = 0) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  // The server is blocked by AniList and needs this exact request: run it from the browser, then retry.
  // A request can need several AniList answers (e.g. two pages), so allow a few relay rounds.
  if (res.status === 503 && body.code === 'anilist_blocked' && body.relay && relayRounds < 4) {
    await answerNow(body.relay);
    return request(url, options, relayRounds + 1);
  }
  // Signed out (cookie cleared or expired on the hosted tracker): go to the login page instead of
  // leaving every view saying "unauthorized". The local server never answers 401.
  if (res.status === 401 && body.error === 'unauthorized') { location.href = `/login?next=${encodeURIComponent(location.hash)}`; throw new Error('Signed out'); }
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}
// Short in-memory cache for the slower read-only views (Discover, Insights), so switching back to a
// tab within a minute paints at once. Any change made through the app (every POST) clears it.
const memo = new Map();
function cached(url, ttl = 60000) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = request(url);
  memo.set(url, { at: Date.now(), promise });
  promise.catch(() => memo.delete(url));
  return promise;
}
export function clearCache() { memo.clear(); }

const post = (url, data) => { memo.clear(); return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' }, body: JSON.stringify(data || {}) }); };

export const api = {
  upNext: () => request('/api/up-next'),
  watchlist: (sort) => request(`/api/watchlist?sort=${encodeURIComponent(sort || 'release_desc')}`),
  details: (malId) => request(`/api/anime/details?malId=${malId}`),
  anime: (malId, refresh) => request(`/api/anime?malId=${malId}${refresh ? '&refresh=1' : ''}`),
  episodes: (malId) => request(`/api/thumbnails?malId=${malId}`),
  toggleWatched: (malId, episodeNumber, watched) => post('/api/episode/toggle-watched', { malId, episodeNumber, watched }),
  watchedElsewhere: (malId) => post('/api/anime/watched-elsewhere', { malId }),
  setListStatus: (malId, status) => post('/api/anime/list-status', { malId, status }),
  setListStatusBatch: (malIds, status) => post('/api/anime/list-status-batch', { malIds, status }),
  setRating: (malId, rating) => post('/api/anime/rating', { malId, rating }),
  watchedThrough: (malId, episodeNumber) => post('/api/episode/watched-through', { malId, episodeNumber }),
  // Undo for watchedThrough / watchedElsewhere: unmark exactly the episodes those calls changed.
  unmark: (malId, episodes, removeFromLibrary = false) => post('/api/episode/unmark', { malId, episodes, removeFromLibrary }),
  syncAnime: (malId) => post('/api/sync-episodes', { malId }),
  add: (anime) => post('/api/watchlist/add', { anime }),
  remove: (malId) => post('/api/watchlist/remove', { malId }),
  restore: (removed) => post('/api/watchlist/restore', { removed }),
  search: (q) => request(`/api/search?q=${encodeURIComponent(q)}`),
  recommendations: (refresh) => (refresh ? (memo.clear(), request('/api/recommendations?refresh=1')) : cached('/api/recommendations')),
  dismiss: (malId, undo = false) => post('/api/recommendations/dismiss', { malId, undo }),
  study: () => cached('/api/study'),
  seasonal: () => cached('/api/seasonal'),
  history: (before) => request(`/api/history${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  crStatus: () => request('/api/crunchyroll/status'),
  crDismissPlay: (episodeId, undo = false) => post('/api/crunchyroll/dismiss-play', { episodeId, undo }),
  importMal: (entries) => post('/api/import/mal', { entries }),
  suspicious: () => request('/api/library/suspicious'),
  crTrack: (seasonId) => post('/api/crunchyroll/track', { seasonId }),
  crHideSampled: (seasonId, undo = false) => post('/api/crunchyroll/hide-sampled', { seasonId, undo }),
  crRemap: (seasonId, malId, offset) => post('/api/crunchyroll/remap', { seasonId, malId, offset }),
  crConfirm: (seasonId) => post('/api/crunchyroll/confirm', { seasonId }),
  crIngest: (rows) => post('/api/crunchyroll/ingest', { rows, source: 'manual' }),
  syncStatus: () => request('/api/sync-status'),
  runSync: () => post('/api/sync/run'),
  stats: () => request('/api/stats')
};
