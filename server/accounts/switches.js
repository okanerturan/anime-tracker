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

module.exports = { all, get, set, DEFAULTS };
