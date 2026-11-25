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

/**
 * Is a backup due? One per "backup day", which starts at 03:00 local time (TIMEZONE, else UTC): the
 * first check after 03:00 makes it, so the copy is fresh when the server's offsite job runs in the
 * early morning. (It used to run 20 hours after the last one, which drifted four hours earlier every
 * day.) Also due when there is none yet, or the last is over 26 hours old whatever the clock says.
 */
function isDue(lastIso, now = Date.now(), timeZone = process.env.TIMEZONE || 'UTC') {
  const last = lastIso ? Date.parse(lastIso) : NaN;
  if (Number.isNaN(last) || now - last > 26 * 3600e3) return true;
  const backupDay = (t) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const date = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    return new Date(Number(parts.hour) >= 3 ? date : date - 86400e3).toISOString().slice(0, 10);
  };
  return backupDay(now) !== backupDay(last);
}

/** Checked a minute after start and then every 15 minutes. */
function start() {
  const tick = () => {
    let last = null; try { last = JSON.parse(fs.readFileSync(path.join(dir(), 'last-backup.json'), 'utf8')).lastSuccessAt; } catch {}
    if (isDue(last)) { try { const r = run(); console.log(`backup: ${r.files} files, ${Math.round(r.bytes / 1024)} KB`); } catch (err) { console.error('backup failed', err.message); } }
  };
  setTimeout(tick, 60e3).unref?.();
  setInterval(tick, 15 * 60e3).unref?.();
}

/** The last good run, for the Sync page: { at, files, bytes, days, keep }, or null (no BACKUP_DIR, or no run yet). */
function status() {
  const root = dir();
  if (!root) return null;
  try {
    const last = JSON.parse(fs.readFileSync(path.join(root, 'last-backup.json'), 'utf8'));
    const days = fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).length;
    return { at: last.lastSuccessAt, files: last.files, bytes: last.bytes, days, keep: KEEP };
  } catch { return null; }
}

module.exports = { run, start, status, isDue, KEEP };
