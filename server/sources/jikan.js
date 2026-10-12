'use strict';
// Jikan (unofficial MAL API) — fallback only. A circuit breaker stops us from hammering it while it is down.
const { sleep } = require('../util');

const BASE = 'https://api.jikan.moe/v4';
const OPEN_FOR_MS = 30 * 60 * 1000;
let openUntil = 0;

function isAvailable() { return Date.now() >= openUntil; }

async function fetchJSON(url) {
  if (!isAvailable()) throw new Error('Jikan unavailable (circuit open)');
  let lastErr = null;
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/2.0' }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      lastErr = err;
      if (attempt >= 1) break; // network-level failure twice: treat as outage
      await sleep(1000);
      continue;
    }
    if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); await sleep(700 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  openUntil = Date.now() + OPEN_FOR_MS;
  throw lastErr || new Error('Jikan failed');
}

async function paged(pathname) {
  const out = [];
  for (let page = 1; page < 40; page += 1) {
    const json = await fetchJSON(`${BASE}${pathname}?page=${page}`);
    const rows = json.data || [];
    out.push(...rows);
    if (!rows.length || !json.pagination?.has_next_page) break;
  }
  return out;
}

const fetchEpisodes = (malId) => paged(`/anime/${malId}/episodes`);
const fetchEpisodeVideos = (malId) => paged(`/anime/${malId}/videos/episodes`);

module.exports = { isAvailable, fetchEpisodes, fetchEpisodeVideos };
