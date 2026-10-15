'use strict';
// accounts.db: who people are and how they sign in, kept apart from every account's data file
// (hosted mode, D5). Accounts, sessions, passkeys, recovery codes, device tokens, invites and the
// runtime switches (D14). Secrets are stored only as SHA-256 hashes; the raw value exists once, in
// the response that hands it out.
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  display_name TEXT,
  email TEXT UNIQUE,
  session_gen INTEGER NOT NULL DEFAULT 0,      -- bumped by "sign out everywhere"
  last_active_at TEXT,
  codes_at TEXT                                 -- when recovery codes were last made (removing the last passkey needs fresh ones)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gen INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,                          -- credential id, base64url
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys(account_id);
CREATE TABLE IF NOT EXISTS recovery_codes (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (account_id, code_hash)
);
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_account ON device_tokens(account_id);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  used_by INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  used_at TEXT,
  revoked_at TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`;

let conn = null;
/** The accounts database (opened on first use; ACCOUNTS_DB overrides the path, e.g. in tests). */
function adb() {
  if (conn) return conn;
  conn = new Database(process.env.ACCOUNTS_DB || path.join(DATA_DIR, 'accounts.db'));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  conn.exec(SCHEMA);
  return conn;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** A random secret: 32 bytes as base64url (43 characters). */
const secret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
/** Constant-time comparison of two strings. */
function same(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function close() { if (conn) { conn.close(); conn = null; } }

module.exports = { adb, sha256, secret, same, close, SCHEMA };
