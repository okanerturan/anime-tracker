'use strict';
// Persistent key/value state (JSON values). Unlike in-memory state it survives a server restart
// or a Durable Object being evicted between requests.
//
// Hosted mode (AUTH_MODE=accounts) keeps settings that are the same for everyone in the shared
// catalog (catalog_state): AniList's block flag, cached season lists, the push signing keys and the
// background jobs' reports. Everything about a person stays in their own file (app_state). In
// single-user mode it is all one table, as before.
const { db, catalog, MULTI } = require('./db');

const GLOBAL = /^(anilistBlocked|catalogPaused|pushKeys|refreshCycle|episodeRun|backup|seasonal:|idmap$)/;

const statements = (handle, table) => ({
  get: handle.prepare(`SELECT value, at FROM ${table} WHERE key = ?`),
  set: handle.prepare(`INSERT INTO ${table} (key, value, at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`)
});
const personal = statements(db, 'app_state');
const shared = MULTI ? statements(catalog, 'catalog_state') : personal;
const storeFor = (key) => (GLOBAL.test(key) ? shared : personal);

function get(key) {
  const row = storeFor(key).get.get(key);
  if (!row) return null;
  try { return { ...JSON.parse(row.value), at: row.at }; } catch { return null; }
}

function set(key, value) {
  storeFor(key).set.run(key, JSON.stringify(value));
}

module.exports = { get, set, GLOBAL };
