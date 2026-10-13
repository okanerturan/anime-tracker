'use strict';
// Download or restore a tracker backup (the gzipped JSON the Cloudflare deployment writes to R2 nightly).
//
//   Download the latest:  TRACKER_URL=https://… TRACKER_KEY_FILE=/path/to/keyfile node scripts/backup.js download [--fresh]
//   Restore into SQLite:  node scripts/backup.js restore <file.json.gz> --local data/anime-tracker.db
//   Restore to Cloudflare: TRACKER_URL=… TRACKER_KEY_FILE=… node scripts/backup.js restore <file.json.gz> --cloud
//
// The key is read from a file (never from argv). The web app's Sync page has a download button too.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const option = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };

function remote() {
  const base = (process.env.TRACKER_URL || '').replace(/\/+$/, '');
  if (!base || !process.env.TRACKER_KEY_FILE) throw new Error('TRACKER_URL and TRACKER_KEY_FILE are required');
  return { base, headers: { Authorization: `Bearer ${fs.readFileSync(process.env.TRACKER_KEY_FILE, 'utf8').trim()}` } };
}

async function download() {
  const { base, headers } = remote();
  const res = await fetch(`${base}/api/backup${flag('--fresh') ? '?fresh=1' : ''}`, { headers });
  if (!res.ok) throw new Error(`backup download failed: ${res.status} ${await res.text()}`);
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `anime-tracker-${new Date().toISOString().slice(0, 10)}.json.gz`;
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}

function readBackup(file) {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  if (data.format !== 'anime-tracker-backup') throw new Error('not an anime-tracker backup');
  return data;
}

function restoreLocal(data, dbFile) {
  if (fs.existsSync(dbFile)) throw new Error(`${dbFile} exists; restore into a new file and swap it in yourself`);
  const Database = require('better-sqlite3');
  const { applySchema } = require('../server/schema');
  const db = new Database(dbFile);
  applySchema(db);
  const known = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name));
  db.transaction(() => {
    for (const [table, { columns, rows }] of Object.entries(data.tables)) {
      if (!known.has(table)) continue;
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of rows) stmt.run(...row);
      console.log(`  ${table}: ${rows.length} rows`);
    }
  })();
  db.close();
}

async function restoreCloud(data) {
  const { base, headers } = remote();
  for (const [table, { columns, rows }] of Object.entries(data.tables)) {
    if (table.startsWith('_') || table === 'app_state') continue;
    for (let i = 0; i < rows.length; i += 2000) {
      const res = await fetch(`${base}/internal/import`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ table, columns, rows: rows.slice(i, i + 2000) })
      });
      if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    }
    console.log(`  ${table}: ${rows.length} rows`);
  }
}

(async () => {
  if (cmd === 'download') return download();
  if (cmd === 'restore' && rest[0]) {
    const data = readBackup(rest[0]);
    console.log(`backup from ${data.createdAt}`);
    if (option('--local')) return restoreLocal(data, option('--local'));
    if (flag('--cloud')) return restoreCloud(data);
  }
  console.error('usage: backup.js download [--fresh] | restore <file> (--local <db> | --cloud)');
  process.exit(1);
})().catch((err) => { console.error(err.message); process.exit(1); });
