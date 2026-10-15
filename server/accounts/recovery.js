'use strict';
// Recovery codes (D5): ten one-time codes per account, stored hashed. Signing in with one is
// followed by registering a new passkey; making a new set cancels the old one.
const crypto = require('crypto');
const { adb, sha256 } = require('./store');

// 10 characters from an alphabet without look-alikes (no 0/O, 1/l/I), shown as xxxxx-xxxxx.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function oneCode() {
  const bytes = crypto.randomBytes(10);
  const s = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normal = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A fresh set of 10; the previous set stops working. Returns the raw codes (shown once). */
function regenerate(accountId) {
  const codes = Array.from({ length: 10 }, oneCode);
  const tx = adb().transaction(() => {
    adb().prepare('DELETE FROM recovery_codes WHERE account_id = ?').run(accountId);
    const ins = adb().prepare('INSERT INTO recovery_codes (account_id, code_hash) VALUES (?, ?)');
    for (const c of codes) ins.run(accountId, sha256(normal(c)));
  });
  tx();
  return codes;
}

/**
 * Sign in with a recovery code: returns the account id and spends the code, or null. Codes are
 * looked up by hash alone (they are long and random enough to be unique), so no username is needed.
 */
function use(code) {
  const hash = sha256(normal(code));
  const row = adb().prepare('SELECT account_id FROM recovery_codes WHERE code_hash = ? AND used_at IS NULL').get(hash);
  if (!row) return null;
  adb().prepare("UPDATE recovery_codes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id = ? AND code_hash = ?").run(row.account_id, hash);
  return row.account_id;
}

const remaining = (accountId) => adb().prepare('SELECT COUNT(*) n FROM recovery_codes WHERE account_id = ? AND used_at IS NULL').get(accountId).n;

module.exports = { regenerate, use, remaining };
