'use strict';
// An account's own data, whole: export as JSON (data rights, D-data-rights), import it back (into a
// new account, or after a delete), and delete it. Runs inside withAccount for the account concerned.
const fs = require('fs');
const { db } = require('../db');
const { schemaFor } = require('../schema');

const FORMAT = 'anime-tracker-account-export';
const SKIP = { episode_sync: new Set(['image_blob', 'image_mime']) }; // stills travel as URLs
const tablesOfAccount = () => [...schemaFor('account').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

/** Everything that belongs to the current account, as plain JSON. */
function exportAccount() {
  const tables = {};
  for (const t of tablesOfAccount()) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name).filter((c) => !SKIP[t]?.has(c));
    tables[t] = { columns, rows: db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${t}"`).all().map((r) => columns.map((c) => r[c])) };
  }
  return { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), tables };
}

/** Load an export into the current account; existing rows win (nothing is overwritten). Returns counts. */
function importAccount(data) {
  if (!data || data.format !== FORMAT || !data.tables) throw Object.assign(new Error('That file isn\'t an Anime Tracker account export.'), { status: 400 });
  const counts = {};
  const allowed = new Set(tablesOfAccount());
  const run = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    for (const [t, { columns, rows }] of Object.entries(data.tables)) {
      if (!allowed.has(t) || !Array.isArray(columns) || !Array.isArray(rows)) continue;
      const known = new Set(db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name));
      const keep = columns.map((c, i) => [c, i]).filter(([c]) => known.has(c) && !SKIP[t]?.has(c));
      if (!keep.length) continue;
      const ins = db.prepare(`INSERT OR IGNORE INTO "${t}" (${keep.map(([c]) => `"${c}"`).join(', ')}) VALUES (${keep.map(() => '?').join(', ')})`);
      let n = 0;
      for (const r of rows) n += ins.run(...keep.map(([, i]) => r[i])).changes;
      counts[t] = n;
    }
  });
  run();
  return counts;
}

/** Delete the account's data file (the account must be the current one; its connection is closed first). */
function deleteFiles(accountId) {
  const file = db.forget(accountId);
  for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
}

module.exports = { exportAccount, importAccount, deleteFiles, FORMAT };
