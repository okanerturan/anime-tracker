'use strict';
// Airing calendar (iCalendar feed) for the shows you follow. Calendar apps can't log in, so the feed
// lives at a secret URL: /calendar/<token>.ics. The token is random, kept in app_state, and can be
// reset from the Sync page. The feed holds only show titles and air times.
// Web APIs only (crypto.getRandomValues, TextEncoder): the same code runs in Node and in the Worker,
// whose bundle can't load node:crypto from here.
const bytes = (s) => new TextEncoder().encode(s).length;
const { db } = require('./db');
const state = require('./state');

function token(reset = false) {
  let t = state.get('calendar')?.token;
  if (!t || reset) {
    t = [...globalThis.crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
    state.set('calendar', { token: t });
  }
  return t;
}

function checkToken(candidate) {
  const t = state.get('calendar')?.token;
  if (!t || typeof candidate !== 'string' || candidate.length !== t.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < t.length; i += 1) diff |= t.charCodeAt(i) ^ candidate.charCodeAt(i);
  return diff === 0;
}

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Lines longer than 75 octets are folded with CRLF + space (RFC 5545). */
function fold(line) {
  const out = []; let rest = line;
  while (bytes(rest) > 75) {
    let cut = 75; while (bytes(rest.slice(0, cut)) > 75) cut -= 1;
    out.push(rest.slice(0, cut)); rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

/** The next episode at its announced time, plus up to three more at the usual weekly slot. */
function feed() {
  const rows = db.prepare(`SELECT m.mal_id AS malId, COALESCE(m.title_english, m.title) AS title, m.next_airing_episode AS ep,
      m.next_airing_at AS at, m.episodes, m.duration FROM watchlist w JOIN media m ON m.mal_id = w.mal_id
    WHERE m.status = 'RELEASING' AND m.next_airing_at IS NOT NULL AND m.next_airing_episode IS NOT NULL AND w.list_status IS NULL`).all();
  const now = Date.now();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//anime-tracker//airing//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Anime airing', 'X-PUBLISHED-TTL:PT6H', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H'];
  for (const r of rows) {
    const first = Number(r.at) < 1e12 ? Number(r.at) * 1000 : Number(r.at);
    for (let k = 0; k < 4; k += 1) {
      const ep = Number(r.ep) + k;
      if (r.episodes && ep > r.episodes) break;
      const start = first + k * 7 * 86400000;
      if (start < now - 86400000) continue;
      lines.push('BEGIN:VEVENT', `UID:${r.malId}-${ep}@anime-tracker`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`,
        `DTEND:${stamp(start + (r.duration || 24) * 60000)}`, fold(`SUMMARY:${esc(`${r.title} · E${ep}`)}`),
        fold(`DESCRIPTION:${esc(k === 0 ? 'Air time from AniList.' : 'Expected at the usual weekly time; updates when AniList confirms it.')}`),
        'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
  }
  // Premieres: announced shows in your library and announced sequels of your shows, as all-day events.
  // AniList month-only dates are stored as the 1st, so only dates with a real day are included.
  const premieres = db.prepare(`SELECT DISTINCT m.mal_id AS malId, COALESCE(m.title_english, m.title) AS title, m.start_date AS date FROM media m
    WHERE m.status = 'NOT_YET_RELEASED' AND length(m.start_date) = 10 AND m.start_date NOT LIKE '%-01'
      AND (m.mal_id IN (SELECT mal_id FROM watchlist WHERE list_status IS NULL)
        OR m.mal_id IN (SELECT r.related_mal_id FROM media_relation r JOIN watchlist w ON w.mal_id = r.mal_id WHERE r.relation_type = 'SEQUEL' AND w.list_status IS NULL))`).all();
  const day = (iso) => iso.replace(/-/g, '');
  for (const p of premieres) {
    const start = new Date(`${p.date}T00:00:00Z`).getTime();
    if (Number.isNaN(start) || start < now - 86400000) continue;
    lines.push('BEGIN:VEVENT', `UID:premiere-${p.malId}@anime-tracker`, `DTSTAMP:${stamp(now)}`, `DTSTART;VALUE=DATE:${day(p.date)}`,
      `DTEND;VALUE=DATE:${day(new Date(start + 86400000).toISOString().slice(0, 10))}`, fold(`SUMMARY:${esc(`${p.title} premieres`)}`),
      fold(`DESCRIPTION:${esc('Premiere date from AniList; the exact time is added once the first episode is scheduled.')}`),
      'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { token, checkToken, feed };
