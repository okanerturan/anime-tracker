'use strict';
// Persistent key/value state (JSON values). Unlike in-memory state it survives a server restart
// or a Durable Object being evicted between requests.
const { db } = require('./db');

const getStmt = db.prepare('SELECT value, at FROM app_state WHERE key = ?');
const setStmt = db.prepare(`INSERT INTO app_state (key, value, at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`);

function get(key) {
  const row = getStmt.get(key);
  if (!row) return null;
  try { return { ...JSON.parse(row.value), at: row.at }; } catch { return null; }
}

function set(key, value) {
  setStmt.run(key, JSON.stringify(value));
}

module.exports = { get, set };
