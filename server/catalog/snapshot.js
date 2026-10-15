'use strict';
// Nightly snapshots (D12, 8.2). Under a lease: a VACUUM INTO copy of accounts.db, catalog.db and every
// account file that changed since its last upload, gzipped, to the backups bucket under
// anime-tracker/YYYY-MM-DD/. Each day also gets manifest.json naming the newest copy of every file,
// wherever it lives, so a restore needs one day's manifest. Days older than 30 are deleted; a copy the
// newest manifest still needs is first copied forward into today (server-side), so an account that
// hasn't changed in months is never left without a backup.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { DATA_DIR, ACCOUNTS_DIR, CATALOG_FILE } = require('../db');
const { backups } = require('./r2');

const ROOT_PREFIX = 'anime-tracker/';
const KEEP_DAYS = 30;
const STATUS_FILE = () => path.join(DATA_DIR, 'last-snapshot.json');
const day = (t) => new Date(t).toISOString().slice(0, 10);

/** Every database to protect: [name in the backup, file on disk]. */
function files() {
  const out = [['accounts.db', process.env.ACCOUNTS_DB || path.join(DATA_DIR, 'accounts.db')], ['catalog.db', CATALOG_FILE]];
  if (fs.existsSync(ACCOUNTS_DIR)) {
    for (const f of fs.readdirSync(ACCOUNTS_DIR).sort()) if (/^[\w-]+\.db$/.test(f)) out.push([`accounts/${f}`, path.join(ACCOUNTS_DIR, f)]);
  }
  return out.filter(([, file]) => fs.existsSync(file));
}

/** When a database last changed: its file or its WAL, whichever is newer. */
function changedAt(file) {
  let t = fs.statSync(file).mtimeMs;
  try { t = Math.max(t, fs.statSync(`${file}-wal`).mtimeMs); } catch { /* no WAL */ }
  return t;
}

/** A consistent, compacted copy of a live database, gzipped. */
function snapshotOf(file) {
  const tmp = path.join(os.tmpdir(), `snap-${process.pid}-${Date.now()}-${path.basename(file)}`);
  const src = new Database(file, { readonly: true, fileMustExist: true });
  try { src.prepare('VACUUM INTO ?').run(tmp); } finally { src.close(); }
  try { return zlib.gzipSync(fs.readFileSync(tmp)); } finally { fs.rmSync(tmp, { force: true }); }
}

async function latestManifest(before) {
  const days = [...new Set((await backups.list(ROOT_PREFIX)).map((k) => k.slice(ROOT_PREFIX.length, ROOT_PREFIX.length + 10)))]
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= before).sort();
  for (const d of days.reverse()) {
    const m = await backups.get(`${ROOT_PREFIX}${d}/manifest.json`);
    if (m) return { day: d, manifest: JSON.parse(m.body.toString()), days: days.slice().reverse() };
  }
  return { day: null, manifest: { files: {} }, days: [] };
}

/**
 * The run's lease is a lock file on the volume, not a row in catalog.db: a row would change the
 * catalog it is about to compare. It keeps two containers (old and new, during a deploy) from
 * running together; a lock older than 2 hours is a crashed run and is taken over.
 */
function lock(holder, now) {
  const file = path.join(DATA_DIR, 'snapshot.lock');
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur.holder !== holder && now - cur.at < 2 * 3600e3) return null;
  } catch { /* no lock, or unreadable: take it */ }
  fs.writeFileSync(file, JSON.stringify({ holder, at: now }));
  return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).holder === holder) fs.rmSync(file, { force: true }); } catch { /* gone */ } };
}

/**
 * One run. Returns { uploaded, unchanged, carried, deleted } or { skipped }. `now` and `holder`
 * are for tests; the files' change times decide what is uploaded.
 */
async function run({ now = Date.now(), holder = `snap-${process.pid}` } = {}) {
  if (!backups.configured()) return { skipped: 'no backup bucket configured' };
  const unlock = lock(holder, now);
  if (!unlock) return { skipped: 'lease' };
  try { return await runLocked(now); } finally { unlock(); }
}

async function runLocked(now) {
  const today = day(now);
  const prefix = `${ROOT_PREFIX}${today}/`;
  const { manifest: prev } = await latestManifest(today);
  const manifest = { day: today, at: new Date(now).toISOString(), files: { ...prev.files } };
  const out = { uploaded: [], unchanged: 0, carried: 0, deleted: 0 };
  const onDisk = new Set();
  for (const [name, file] of files()) {
    onDisk.add(name);
    const t = changedAt(file);
    if (prev.files[name] && prev.files[name].changedAt >= t) { out.unchanged += 1; continue; }
    const body = snapshotOf(file);
    const key = `${prefix}${name}.gz`;
    await backups.put(key, body, 'application/gzip');
    manifest.files[name] = { key, changedAt: t, bytes: body.length };
    out.uploaded.push(name);
  }
  // A deleted account leaves the manifest (its old copies expire with their days).
  for (const name of Object.keys(manifest.files)) if (!onDisk.has(name)) delete manifest.files[name];

  // Retention: carry still-needed copies out of days about to expire, then delete those days.
  const cutoff = day(now - KEEP_DAYS * 86400e3);
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (entry.key.slice(ROOT_PREFIX.length, ROOT_PREFIX.length + 10) <= cutoff) {
      const key = `${prefix}${name}.gz`;
      await backups.copy(entry.key, key);
      manifest.files[name] = { ...entry, key };
      out.carried += 1;
    }
  }
  await backups.put(`${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 1)), 'application/json');
  for (const key of await backups.list(ROOT_PREFIX)) {
    if (key.slice(ROOT_PREFIX.length, ROOT_PREFIX.length + 10) <= cutoff) { await backups.del(key); out.deleted += 1; }
  }
  // For hub-check and the status page: the last good run, in a file on the volume (writing it into
  // catalog.db would make the catalog look changed to the next run).
  fs.writeFileSync(STATUS_FILE(), JSON.stringify({ lastSuccessAt: new Date(now).toISOString(), uploaded: out.uploaded.length, files: Object.keys(manifest.files).length }));
  return out;
}

/** Nightly at about 03:00 (TIMEZONE, else UTC): checked every 15 minutes, once per day. */
function start() {
  const tick = () => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: process.env.TIMEZONE || 'UTC' }).format(new Date()));
    let last = null; try { last = JSON.parse(fs.readFileSync(STATUS_FILE(), 'utf8')).lastSuccessAt; } catch { /* first run */ }
    if (hour >= 3 && (!last || Date.now() - Date.parse(last) > 20 * 3600e3)) run().catch((err) => console.error('snapshot failed', err.message));
  };
  setInterval(tick, 15 * 60e3).unref?.();
}

/** The last good run ({ lastSuccessAt, uploaded, files }), or null. */
function lastRun() { try { return JSON.parse(fs.readFileSync(STATUS_FILE(), 'utf8')); } catch { return null; } }

module.exports = { run, start, lastRun, files, latestManifest, ROOT_PREFIX, KEEP_DAYS };
