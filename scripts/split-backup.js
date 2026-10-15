'use strict';
// Turn a single-user tracker into the hosted layout: one shared catalog plus account #1's file.
//
//   node scripts/split-backup.js <backup.json.gz | tracker.db> <out-dir> [--account 1]
//
// Input is a backup from /api/backup (gzipped JSON, every table) or a SQLite file. Output is
// <out-dir>/catalog.db and <out-dir>/accounts/<id>.db with the hosted schemas. Settings are split
// the same way server/state.js routes them (global keys to the catalog). Prints row counts for
// every table on both sides and exits non-zero if any row went missing.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { applySchema, CATALOG_TABLES } = require('../server/schema');

const [input, outDir, ...rest] = process.argv.slice(2);
if (!input || !outDir) { console.error('usage: node scripts/split-backup.js <backup.json.gz | tracker.db> <out-dir> [--account 1]'); process.exit(2); }
const accountId = rest.includes('--account') ? rest[rest.indexOf('--account') + 1] : '1';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new Error('invalid account id');
// Same rule as server/state.js.
const GLOBAL_STATE = /^(anilistBlocked|catalogPaused|pushKeys|refreshCycle|episodeRun|backup|seasonal:)/;

/** { table: { columns, rows } } from either input format. */
function readInput(file) {
  if (/\.json(\.gz)?$/.test(file)) {
    const raw = fs.readFileSync(file);
    const data = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
    if (data.format !== 'anime-tracker-backup') throw new Error('not an anime-tracker backup');
    return data.tables;
  }
  const src = new Database(file, { readonly: true });
  const tables = {};
  for (const { name } of src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all()) {
    const columns = src.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((r) => r.name);
    tables[name] = { columns, rows: src.prepare(`SELECT * FROM "${name}"`).raw().all() };
  }
  src.close();
  return tables;
}

function open(file, part) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`${file} exists; use an empty output directory`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  applySchema(db, part);
  return db;
}

// Episode stills don't travel as bytes: hosted mode stores their source URL (the background sync
// fills it in again for seasons that lack one), so account files stay a few MB.
const SKIP = { episode_sync: new Set(['image_blob', 'image_mime']) };

function copy(db, table, columns, rows) {
  const known = new Set(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name));
  const keep = columns.map((c, i) => [c, i]).filter(([c]) => known.has(c) && !SKIP[table]?.has(c));
  if (!keep.length || !rows.length) return 0;
  const stmt = db.prepare(`INSERT INTO "${table}" (${keep.map(([c]) => `"${c}"`).join(', ')}) VALUES (${keep.map(() => '?').join(', ')})`);
  db.transaction(() => { for (const r of rows) stmt.run(keep.map(([, i]) => r[i])); })();
  return rows.length;
}

const tables = readInput(input);
const catalog = open(path.join(outDir, 'catalog.db'), 'catalog');
const account = open(path.join(outDir, 'accounts', `${accountId}.db`), 'account');
account.pragma('foreign_keys = OFF'); // rows arrive table by table, not in dependency order
const report = [];
let missing = 0;
for (const [table, { columns, rows }] of Object.entries(tables)) {
  let written = 0;
  if (table === 'app_state') {
    const k = columns.indexOf('key');
    const shared = rows.filter((r) => GLOBAL_STATE.test(r[k]));
    written = copy(catalog, 'catalog_state', columns, shared) + copy(account, 'app_state', columns, rows.filter((r) => !GLOBAL_STATE.test(r[k])));
    report.push([table, rows.length, written, `${shared.length} global → catalog_state`]);
  } else if (CATALOG_TABLES.has(table)) {
    written = copy(catalog, table, columns, rows); report.push([table, rows.length, written, 'catalog']);
  } else if (account.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
    written = copy(account, table, columns, rows); report.push([table, rows.length, written, `account ${accountId}`]);
  } else {
    report.push([table, rows.length, 0, 'not in the hosted schema: skipped']);
    continue;
  }
  if (written !== rows.length) missing += rows.length - written;
}
account.pragma('foreign_keys = ON');
const fk = account.prepare('PRAGMA foreign_key_check').all();
catalog.close(); account.close();

const w = Math.max(...report.map((r) => r[0].length));
for (const [t, inRows, outRows, where] of report) console.log(`${t.padEnd(w)}  ${String(inRows).padStart(7)} → ${String(outRows).padStart(7)}  ${where}`);
if (fk.length) console.log(`foreign key problems: ${fk.length} (first: ${JSON.stringify(fk[0])})`);
console.log(missing || fk.length ? `FAILED: ${missing} rows missing` : `ok: every row is in ${outDir}`);
process.exit(missing || fk.length ? 1 : 0);
