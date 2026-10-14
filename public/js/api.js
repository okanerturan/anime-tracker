// Thin API client. Mutating calls carry X-Tracker-Client so the server can reject cross-site posts.
import { answerNow } from './anilist-relay.js';

async function request(url, options = {}, retried = false) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  // The server is blocked by AniList and needs this exact request: run it from the browser, then retry.
  if (res.status === 503 && body.code === 'anilist_blocked' && body.relay && !retried) {
    await answerNow(body.relay);
    return request(url, options, true);
  }
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}
const post = (url, data) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' }, body: JSON.stringify(data || {}) });

export const api = {
  upNext: () => request('/api/up-next'),
  watchlist: (sort) => request(`/api/watchlist?sort=${encodeURIComponent(sort || 'release_desc')}`),
  details: (malId) => request(`/api/anime/details?malId=${malId}`),
  anime: (malId) => request(`/api/anime?malId=${malId}`),
  episodes: (malId) => request(`/api/thumbnails?malId=${malId}`),
  toggleWatched: (malId, episodeNumber, watched) => post('/api/episode/toggle-watched', { malId, episodeNumber, watched }),
  watchedElsewhere: (malId) => post('/api/anime/watched-elsewhere', { malId }),
  setListStatus: (malId, status) => post('/api/anime/list-status', { malId, status }),
  setRating: (malId, rating) => post('/api/anime/rating', { malId, rating }),
  watchedThrough: (malId, episodeNumber) => post('/api/episode/watched-through', { malId, episodeNumber }),
  syncAnime: (malId) => post('/api/sync-episodes', { malId }),
  add: (anime) => post('/api/watchlist/add', { anime }),
  remove: (malId) => post('/api/watchlist/remove', { malId }),
  search: (q) => request(`/api/search?q=${encodeURIComponent(q)}`),
  recommendations: (refresh) => request(`/api/recommendations${refresh ? '?refresh=1' : ''}`),
  dismiss: (malId) => post('/api/recommendations/dismiss', { malId }),
  study: () => request('/api/study'),
  crStatus: () => request('/api/crunchyroll/status'),
  crRemap: (seasonId, malId, offset) => post('/api/crunchyroll/remap', { seasonId, malId, offset }),
  crConfirm: (seasonId) => post('/api/crunchyroll/confirm', { seasonId }),
  crIngest: (rows) => post('/api/crunchyroll/ingest', { rows, source: 'manual' }),
  syncStatus: () => request('/api/sync-status'),
  runSync: () => post('/api/sync/run'),
  stats: () => request('/api/stats')
};
