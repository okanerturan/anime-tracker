'use strict';
// Browser sessions (D5): a random cookie value, stored only as its hash; 180 days; rotated when
// used after 30 days; "sign out everywhere" bumps the account's session generation, which ends
// every session at once (device tokens are separate and keep working).
const { adb, sha256, secret } = require('./store');

const COOKIE = 'tracker_session';
const LIFETIME_MS = 180 * 86400e3;
const ROTATE_AFTER_MS = 30 * 86400e3;
const iso = (ms) => new Date(ms).toISOString();

/** Start a session; returns the raw value for the cookie (never stored). */
function create(accountId, { now = Date.now(), userAgent = null } = {}) {
  const raw = secret();
  const gen = adb().prepare('SELECT session_gen FROM accounts WHERE id = ?').get(accountId)?.session_gen;
  if (gen == null) throw new Error('no such account');
  adb().prepare('INSERT INTO sessions (id_hash, account_id, gen, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(raw), accountId, gen, iso(now), iso(now + LIFETIME_MS), userAgent ? String(userAgent).slice(0, 200) : null);
  return raw;
}

/**
 * The account a cookie belongs to, or null. When the session is older than 30 days it is replaced:
 * `rotated` holds the new raw value to set as the cookie.
 */
function resolve(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'string' || raw.length > 100) return null;
  const row = adb().prepare(`SELECT s.id_hash, s.account_id, s.gen, s.created_at, s.expires_at, s.user_agent, a.session_gen
    FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = ?`).get(sha256(raw));
  if (!row) return null;
  if (row.gen !== row.session_gen || Date.parse(row.expires_at) <= now) {
    adb().prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
    return null;
  }
  adb().prepare('UPDATE accounts SET last_active_at = ? WHERE id = ?').run(iso(now), row.account_id);
  let rotated = null;
  if (now - Date.parse(row.created_at) > ROTATE_AFTER_MS) {
    adb().prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash);
    rotated = create(row.account_id, { now, userAgent: row.user_agent });
  }
  return { accountId: row.account_id, rotated };
}

function end(raw) { if (raw) adb().prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(raw)); }

/** Sign out everywhere: every browser session of the account ends; device tokens are untouched. */
function endAll(accountId) {
  adb().prepare('UPDATE accounts SET session_gen = session_gen + 1 WHERE id = ?').run(accountId);
  adb().prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
}

/** Set-Cookie value for a session (or for clearing it with `raw = null`). */
function cookie(raw) {
  const base = `${COOKIE}=${raw || ''}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return raw ? `${base}; Max-Age=${Math.round(LIFETIME_MS / 1000)}` : `${base}; Max-Age=0`;
}

/** The session value from a request's Cookie header. */
function fromRequest(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

module.exports = { create, resolve, end, endAll, cookie, fromRequest, COOKIE };
