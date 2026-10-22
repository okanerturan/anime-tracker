'use strict';
// Nightly database copies on the hub's own disk (BACKUP_DIR, e.g. /data/backups = /srv/anime-tracker/backups
// on the host). The box's restic job ships that folder to the offsite Storage Box, so this only has to
// make consistent copies: VACUUM INTO, gzip, one folder per day, the last KEEP days kept.
// Single-user mode copies the one database; accounts mode copies accounts.db, catalog.db and every account.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { MULTI, DATA_DIR } = require('./db');

const KEEP = 14;
const dir = () => process.env.BACKUP_DIR;
const day = (t) => new Date(t).toISOString().slice(0, 10);

function files() {
  if (MULTI) return require('./catalog/snapshot').files();
  return [['anime-tracker.db', process.env.ANIME_DB || path.join(DATA_DIR, 'anime-tracker.db')]];
}

/** One run: today's folder (replaced if it exists), then old days pruned. */
function run({ now = Date.now() } = {}) {
  const root = dir();
  if (!root) return { skipped: 'no BACKUP_DIR' };
  const today = path.join(root, day(now));
  const tmp = `${today}.partial`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  let count = 0; let bytes = 0;
  for (const [name, file] of files()) {
    if (!fs.existsSync(file)) continue;
    const copy = path.join(tmp, `${name.replace(/\//g, '__')}.tmp`);
    const src = new Database(file, { readonly: true, fileMustExist: true });
    try { src.prepare('VACUUM INTO ?').run(copy); } finally { src.close(); }
    const gz = zlib.gzipSync(fs.readFileSync(copy));
    fs.writeFileSync(path.join(tmp, `${name.replace(/\//g, '__')}.gz`), gz);
    fs.rmSync(copy, { force: true });
    count += 1; bytes += gz.length;
  }
  fs.rmSync(today, { recursive: true, force: true });
  fs.renameSync(tmp, today); // a day folder is either complete or absent
  for (const d of fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().slice(0, -KEEP)) {
    fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
  const status = { lastSuccessAt: new Date(now).toISOString(), files: count, bytes };
  fs.writeFileSync(path.join(root, 'last-backup.json'), JSON.stringify(status));
  return status;
}

/** Around 03:00 (TIMEZONE, else UTC), checked every 15 minutes, once per day; also soon after start if none today. */
function start() {
  const tick = () => {
    let last = null; try { last = JSON.parse(fs.readFileSync(path.join(dir(), 'last-backup.json'), 'utf8')).lastSuccessAt; } catch {}
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: process.env.TIMEZONE || 'UTC' }).format(new Date()));
    const due = !last || (hour >= 3 && Date.now() - Date.parse(last) > 20 * 3600e3) || Date.now() - Date.parse(last) > 26 * 3600e3;
    if (due) { try { const r = run(); console.log(`backup: ${r.files} files, ${Math.round(r.bytes / 1024)} KB`); } catch (err) { console.error('backup failed', err.message); } }
  };
  setTimeout(tick, 60e3).unref?.();
  setInterval(tick, 15 * 60e3).unref?.();
}

module.exports = { run, start, KEEP };
