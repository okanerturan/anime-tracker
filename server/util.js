'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Apostrophes join words ("Journey's" -> "journeys") so straight, curly and missing ones all match.
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function readJSON(filePath, fallback = null) {
  try { return JSON.parse(require('fs').readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function parseJSONField(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function dateFromParts(d) {
  if (!d || !d.year) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.year}-${pad(d.month || 1)}-${pad(d.day || 1)}`;
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'")
    .trim();
}

/** Watched = Crunchyroll says fully watched, or at least 80% of the runtime was played. */
function isWatchedPlay({ fullyWatched, playhead, durationS }) {
  if (fullyWatched) return true;
  if (!durationS) return false;
  return Number(playhead || 0) / durationS >= 0.8;
}

module.exports = { sleep, normalizeTitle, readJSON, parseJSONField, dateFromParts, stripHtml, isWatchedPlay };
