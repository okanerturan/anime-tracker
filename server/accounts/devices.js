'use strict';
// Extension device tokens (D7): what a browser extension syncs with. Random, stored hashed, named
// after the browser, revocable, at most 10 per account. A token reaches only the routes the
// extension uses (sync, its popup, the Crunchyroll page card), never account settings.
const crypto = require('crypto');
const { adb, sha256, secret } = require('./store');

const MAX_DEVICES = 10;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Exactly what extension/*.js calls. Everything else answers 403 for a device token.
const DEVICE_ROUTES = new Set([
  'GET /api/crunchyroll/status', 'POST /api/crunchyroll/ingest', 'POST /api/crunchyroll/episodes', 'POST /api/crunchyroll/series-seasons', 'POST /api/crunchyroll/series',
  'GET /api/crunchyroll/series-info', 'GET /api/up-next', 'POST /api/episode/watched-through', 'POST /api/episode/unmark',
  'POST /api/anime/rating', 'POST /api/anime/list-status', 'GET /api/anilist/relay', 'GET /api/episode-image'
]);
const deviceMayUse = (method, pathname) => DEVICE_ROUTES.has(`${method} ${pathname}`);

/** A new token for an account (shown once). */
function mint(accountId, name) {
  const n = adb().prepare('SELECT COUNT(*) n FROM device_tokens WHERE account_id = ? AND revoked_at IS NULL').get(accountId).n;
  if (n >= MAX_DEVICES) throw fail(409, `You have ${MAX_DEVICES} connected browsers. Disconnect one first.`);
  const token = `trk_${secret()}`;
  adb().prepare('INSERT INTO device_tokens (token_hash, account_id, name) VALUES (?, ?, ?)').run(sha256(token), accountId, String(name || 'Browser').slice(0, 60));
  return token;
}

function list(accountId) {
  return adb().prepare(`SELECT rowid AS id, name, created_at AS connectedAt, last_used_at AS lastSyncAt FROM device_tokens
    WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at`).all(accountId);
}

function revoke(accountId, id) {
  const r = adb().prepare("UPDATE device_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = ? AND account_id = ? AND revoked_at IS NULL").run(Number(id), accountId);
  if (!r.changes) throw fail(404, 'No such connected browser.');
}

// Pairing codes: when the website can't hand the token to the extension directly (another Chrome
// profile, managed browser), it shows an 8-character code the popup accepts. 10 minutes, once.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normal = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function pairingCode(accountId, { now = Date.now() } = {}) {
  const code = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
  adb().prepare('INSERT INTO pairing_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)').run(sha256(code), accountId, new Date(now + 10 * 60e3).toISOString());
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
/** Trade a pairing code for a device token. */
function redeem(code, name, { now = Date.now() } = {}) {
  const hash = sha256(normal(code));
  const row = adb().prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(hash);
  if (!row || row.used_at || Date.parse(row.expires_at) <= now) throw fail(401, 'That code isn\'t valid any more. Make a new one on the Connect page.');
  adb().prepare("UPDATE pairing_codes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code_hash = ?").run(hash);
  return mint(row.account_id, name);
}

module.exports = { mint, list, revoke, pairingCode, redeem, deviceMayUse, DEVICE_ROUTES, MAX_DEVICES };
