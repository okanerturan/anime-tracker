'use strict';
// Fetch-once image cache. Remote posters/covers are downloaded a single time into data/images/
// and then served locally with long-lived immutable cache headers, so neither the server nor
// the browser hits the same remote image again.
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { db, catalog, IMAGE_DIR } = require('./db');
const { sleep } = require('./util');

const ALLOWED_HOSTS = [
  'cdn.myanimelist.net', 's4.anilist.co', 'img1.ak.crunchyroll.com', 'www.crunchyroll.com',
  'imgsrv.crunchyroll.com', 'img.youtube.com', 'i.ytimg.com'
];
const RETRY_FAILED_AFTER_MS = 24 * 3600 * 1000;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

// The image index is shared catalog data (images are served without an account in hosted mode).
const getStmt = catalog.prepare('SELECT * FROM image_cache WHERE url = ?');
const putStmt = catalog.prepare(`INSERT INTO image_cache (url, file, mime, bytes, fetched_at, failed_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
  ON CONFLICT(url) DO UPDATE SET file=excluded.file, mime=excluded.mime, bytes=excluded.bytes, fetched_at=excluded.fetched_at, failed_at=NULL`);
const failStmt = catalog.prepare(`INSERT INTO image_cache (url, failed_at) VALUES (?, CURRENT_TIMESTAMP)
  ON CONFLICT(url) DO UPDATE SET failed_at=CURRENT_TIMESTAMP`);

const inflight = new Map();

function isAllowed(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_HOSTS.includes(u.hostname);
  } catch { return false; }
}

/**
 * Shrink large images in place: PNG covers become JPEG and anything taller than 540px is scaled down.
 * Uses macOS `sips` when available; elsewhere the original file is kept.
 */
function optimize(file, mime) {
  if (process.platform !== 'darwin') return { file, mime };
  const full = path.join(IMAGE_DIR, file);
  const size = fs.statSync(full).size;
  if (size < 60 * 1024 && mime === 'image/jpeg') return { file, mime };
  const outName = file.replace(/\.[a-z]+$/, '') + '.jpg';
  const out = path.join(IMAGE_DIR, outName === file ? `${file}.tmp.jpg` : outName);
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '--resampleHeight', '540', full, '--out', out], { stdio: 'ignore' });
    const newSize = fs.statSync(out).size;
    if (newSize >= size) { fs.unlinkSync(out); return { file, mime }; }
    if (out.endsWith('.tmp.jpg')) { fs.renameSync(out, full); return { file, mime: 'image/jpeg' }; }
    fs.unlinkSync(full);
    return { file: outName, mime: 'image/jpeg' };
  } catch {
    try { fs.unlinkSync(out); } catch {}
    return { file, mime };
  }
}

/** Shrink an in-memory episode thumbnail (PNG or >80KB) to a 480px-wide JPEG. Returns the original on failure. */
function optimizeBuffer(bytes, mime) {
  if (process.platform !== 'darwin' || (mime === 'image/jpeg' && bytes.length < 80 * 1024)) return { bytes, mime };
  const os = require('os');
  const tmpIn = path.join(os.tmpdir(), `at-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tmpOut = `${tmpIn}.jpg`;
  try {
    fs.writeFileSync(tmpIn, bytes);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '78', '--resampleWidth', '480', tmpIn, '--out', tmpOut], { stdio: 'ignore' });
    const out = fs.readFileSync(tmpOut);
    return out.length < bytes.length ? { bytes: out, mime: 'image/jpeg' } : { bytes, mime };
  } catch {
    return { bytes, mime };
  } finally {
    for (const f of [tmpIn, tmpOut]) { try { fs.unlinkSync(f); } catch {} }
  }
}

function hashOf(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

/** Returns { file, mime } for a cached image, downloading it once if needed. */
async function ensure(url) {
  if (!isAllowed(url)) throw new Error('host not allowed');
  const row = getStmt.get(url);
  if (row?.file && fs.existsSync(path.join(IMAGE_DIR, row.file))) return row;
  if (row?.failed_at && Date.now() - new Date(row.failed_at + 'Z').getTime() < RETRY_FAILED_AFTER_MS) {
    throw new Error('recently failed');
  }
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker-local/2.0' }, signal: AbortSignal.timeout(20000) });
        if (res.status === 429 || res.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
        if (!res.ok) break;
        const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
        if (!mime.startsWith('image/')) break;
        const bytes = Buffer.from(await res.arrayBuffer());
        const raw = hashOf(url) + (EXT[mime] || '.img');
        fs.writeFileSync(path.join(IMAGE_DIR, raw), bytes);
        const opt = optimize(raw, mime);
        putStmt.run(url, opt.file, opt.mime, fs.statSync(path.join(IMAGE_DIR, opt.file)).size);
        return getStmt.get(url);
      } catch {
        await sleep(800 * (attempt + 1));
      }
    }
    failStmt.run(url);
    throw new Error('fetch failed');
  })();
  inflight.set(url, job);
  try { return await job; } finally { inflight.delete(url); }
}

/** Local URL the browser should use for a remote image. */
function localUrl(url) {
  if (!url || !isAllowed(url)) return url || '';
  return `/img/${hashOf(url)}?u=${encodeURIComponent(url)}`;
}

function sendCached(req, res, row) {
  const etag = `"${row.file}"`;
  const headers = {
    'Content-Type': row.mime || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  fs.createReadStream(path.join(IMAGE_DIR, row.file)).pipe(res);
}

async function handle(req, res, url) {
  const remote = url.searchParams.get('u') || '';
  try {
    const row = await ensure(remote);
    sendCached(req, res, row);
  } catch {
    if (isAllowed(remote)) { res.writeHead(302, { Location: remote, 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(404); res.end();
  }
}

/** Pre-download a list of remote image urls with limited concurrency. */
async function prefetch(urls, concurrency = 6, onProgress) {
  const list = [...new Set(urls.filter(isAllowed))];
  let i = 0; let ok = 0; let failed = 0;
  async function worker() {
    while (i < list.length) {
      const url = list[i++];
      try { await ensure(url); ok += 1; } catch { failed += 1; }
      if (onProgress && (ok + failed) % 50 === 0) onProgress(ok + failed, list.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { total: list.length, ok, failed };
}

function stats() {
  return catalog.prepare('SELECT COUNT(file) AS cached, COALESCE(SUM(bytes),0) AS bytes, SUM(failed_at IS NOT NULL AND file IS NULL) AS failed FROM image_cache').get();
}

/** Binary value the database driver accepts (better-sqlite3 wants a Buffer). */
const toBlob = (arrayBuffer) => Buffer.from(arrayBuffer);

module.exports = { toBlob, optimize, optimizeBuffer, ensure, localUrl, handle, prefetch, isAllowed, stats };
