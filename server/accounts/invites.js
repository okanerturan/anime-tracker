'use strict';
// Invite links and signup modes (D5): SIGNUP=closed|invite|open. An invite is a single-use secret
// (stored hashed) with an expiry; it is only spent once the new account's first passkey is saved,
// so a cancelled passkey prompt leaves the link usable.
const { adb, sha256, secret } = require('./store');
const switches = require('./switches');

const err = (status, message) => Object.assign(new Error(message), { status });

/** Make an invite; returns the raw code for the link (shown once). */
function create({ days = 14, note = null, now = Date.now() } = {}) {
  const code = secret(18);
  adb().prepare('INSERT INTO invites (code_hash, expires_at, note) VALUES (?, ?, ?)').run(sha256(code), new Date(now + days * 86400e3).toISOString(), note);
  return code;
}

function revoke(code) {
  adb().prepare("UPDATE invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code_hash = ?").run(sha256(code));
}

/** Can someone sign up with this code right now? Throws a readable error if not. */
function check(code, { now = Date.now() } = {}) {
  const mode = switches.get('SIGNUP');
  if (mode === 'closed') throw err(403, 'Sign-ups are closed for now.');
  if (mode === 'open' && !code) return null;
  if (!code) throw err(403, 'You need an invite link to sign up.');
  const row = adb().prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256(code));
  if (!row) throw err(403, 'That invite link isn\'t valid.');
  if (row.revoked_at) throw err(403, 'That invite link was withdrawn.');
  if (row.used_at) throw err(403, 'That invite link has already been used.');
  if (row.expires_at && Date.parse(row.expires_at) <= now) throw err(403, 'That invite link has expired.');
  return row;
}

/** Spend the invite on an account (after its first passkey is stored). */
function spend(code, accountId) {
  if (!code) return;
  adb().prepare("UPDATE invites SET used_by = ?, used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code_hash = ? AND used_at IS NULL").run(accountId, sha256(code));
}

module.exports = { create, revoke, check, spend };
