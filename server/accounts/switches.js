'use strict';
// Runtime switches (D14): SYNC_PAUSED, THUMBNAILS, SIGNUP, READ_ONLY. Stored in accounts.db and read
// on every request (cached 10 s), so flipping one takes seconds and no deploy. Environment variables
// only give the first value while the table has none.
const { adb } = require('./store');

const DEFAULTS = { SYNC_PAUSED: '', THUMBNAILS: 'on', SIGNUP: 'invite', READ_ONLY: 'off' };
const ALLOWED = { THUMBNAILS: ['on', 'off'], SIGNUP: ['closed', 'invite', 'open'], READ_ONLY: ['on', 'off'] };
let cache = null; let cachedAt = 0;

function all({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 10e3) return cache;
  const rows = Object.fromEntries(adb().prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
  cache = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, rows[k] ?? process.env[k] ?? DEFAULTS[k]]));
  cachedAt = Date.now();
  return cache;
}

const get = (key) => all()[key];

/** Flip a switch. SYNC_PAUSED takes a message ('' resumes). */
function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown switch ${key}`);
  const v = String(value ?? '');
  if (ALLOWED[key] && !ALLOWED[key].includes(v)) throw new Error(`${key} must be one of ${ALLOWED[key].join(', ')}`);
  adb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(key, v);
  cache = null;
  return all({ fresh: true });
}

const SYNC_ROUTES = new Set(['/api/crunchyroll/ingest', '/api/crunchyroll/episodes', '/api/crunchyroll/series']);
const MAINTENANCE = 'The tracker is in maintenance for a few minutes. Nothing was lost; try again shortly.';

/**
 * The request a switch refuses, as { status, body }, or null. READ_ONLY refuses every write except
 * signing in and out (sessions live in accounts.db, not in an account's file); SYNC_PAUSED refuses
 * the extension's sync routes with the operator's message, which its popup shows.
 */
function refuse(method, pathname) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const s = all();
  if (s.READ_ONLY === 'on' && (pathname.startsWith('/api/') || pathname.startsWith('/auth/'))
    && !pathname.startsWith('/auth/signin/') && pathname !== '/auth/signout') {
    return { status: 503, body: { error: MAINTENANCE, readOnly: true } };
  }
  if (s.SYNC_PAUSED && SYNC_ROUTES.has(pathname)) return { status: 503, body: { error: s.SYNC_PAUSED, paused: true } };
  return null;
}

/** Episode stills are off (hosted mode only): pages fall back to the show's poster. */
const thumbnailsOff = () => process.env.AUTH_MODE === 'accounts' && get('THUMBNAILS') === 'off';

module.exports = { all, get, set, refuse, thumbnailsOff, DEFAULTS };
