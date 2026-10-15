'use strict';
// Per-account storage quota from the size of the account's file (D13): soft 50 MB (responses say
// so), hard 200 MB (only syncing new Crunchyroll plays is still accepted). QUOTA_SOFT_MB and
// QUOTA_HARD_MB override the limits (tests).
const fs = require('fs');

const mb = (name, fallback) => Number(process.env[name]) || fallback;
const sizes = new Map(); // file -> { bytes, at }

/** The file's size in bytes, measured at most once a minute (plus its WAL). */
function sizeOf(file, now = Date.now()) {
  const hit = sizes.get(file);
  if (hit && now - hit.at < 60e3) return hit.bytes;
  let bytes = 0;
  for (const f of [file, `${file}-wal`]) { try { bytes += fs.statSync(f).size; } catch {} }
  sizes.set(file, { bytes, at: now });
  return bytes;
}

/** 'ok' | 'soft' | 'hard' for this file. */
function level(file, now) {
  const bytes = sizeOf(file, now);
  if (bytes >= mb('QUOTA_HARD_MB', 200) * 1048576) return 'hard';
  if (bytes >= mb('QUOTA_SOFT_MB', 50) * 1048576) return 'soft';
  return 'ok';
}

// What still works past the hard limit: reads, sign-out, export and delete, and syncing new plays.
const ALLOWED_WHEN_FULL = /^\/(api\/crunchyroll\/ingest|auth\/)/;
const blocks = (method, pathname, lvl) => lvl === 'hard' && method !== 'GET' && !ALLOWED_WHEN_FULL.test(pathname);

const forget = (file) => sizes.delete(file);

module.exports = { level, blocks, sizeOf, forget };
