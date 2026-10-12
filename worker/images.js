'use strict';
// Worker replacement for server/images.js: the fetch-once image cache lives in R2.
const { db } = require('./sqlite-shim');
const sha1 = require('./sha1');
const { sleep } = require('../server/util');

const ALLOWED_HOSTS = [
  'cdn.myanimelist.net', 's4.anilist.co', 'img1.ak.crunchyroll.com', 'www.crunchyroll.com',
  'imgsrv.crunchyroll.com', 'img.youtube.com', 'i.ytimg.com'
];
let bucket = null;
function bindBucket(b) { bucket = b; }

function isAllowed(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_HOSTS.includes(u.hostname);
  } catch { return false; }
}

const hashOf = (url) => sha1(url);
const keyOf = (url) => `img/${hashOf(url)}`;

function localUrl(url) {
  if (!url || !isAllowed(url)) return url || '';
  return `/img/${hashOf(url)}?u=${encodeURIComponent(url)}`;
}

const upsert = () => db.prepare(`INSERT INTO image_cache (url, file, mime, bytes, fetched_at, failed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, NULL)
  ON CONFLICT(url) DO UPDATE SET file=excluded.file, mime=excluded.mime, bytes=excluded.bytes, fetched_at=excluded.fetched_at, failed_at=NULL`);

async function ensure(url) {
  if (!isAllowed(url)) throw new Error('host not allowed');
  const key = keyOf(url);
  const hit = await bucket.get(key);
  if (hit) return hit;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'anime-tracker/2.0' } });
      if (res.status === 429 || res.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
      if (!res.ok) break;
      const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (!mime.startsWith('image/')) break;
      const body = await res.arrayBuffer();
      await bucket.put(key, body, { httpMetadata: { contentType: mime } });
      upsert().run(url, key, mime, body.byteLength);
      return bucket.get(key);
    } catch { await sleep(800 * (attempt + 1)); }
  }
  throw new Error('fetch failed');
}

async function handle(req, res, url) {
  const remote = url.searchParams.get('u') || '';
  try {
    const obj = await ensure(remote);
    const etag = `"${obj.key.slice(4)}"`;
    const headers = { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', ETag: etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    return res.end(await obj.arrayBuffer());
  } catch {
    if (isAllowed(remote)) { res.writeHead(302, { Location: remote, 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(404); return res.end();
  }
}

async function prefetch(urls, concurrency = 6) {
  const list = [...new Set(urls.filter(isAllowed))];
  let i = 0; let ok = 0; let failed = 0;
  async function worker() {
    while (i < list.length) {
      const u = list[i++];
      try { await ensure(u); ok += 1; } catch { failed += 1; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { total: list.length, ok, failed };
}

function stats() {
  return db.prepare('SELECT COUNT(file) AS cached, COALESCE(SUM(bytes),0) AS bytes, SUM(failed_at IS NOT NULL AND file IS NULL) AS failed FROM image_cache').get();
}

// No image tooling in Workers; images were already shrunk before migration.
const optimize = (file, mime) => ({ file, mime });
const optimizeBuffer = (bytes, mime) => ({ bytes, mime });
const toBlob = (arrayBuffer) => new Uint8Array(arrayBuffer);

module.exports = { bindBucket, toBlob, optimize, optimizeBuffer, ensure, localUrl, handle, prefetch, isAllowed, stats, keyOf };
