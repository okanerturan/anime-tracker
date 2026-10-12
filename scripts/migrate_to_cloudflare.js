'use strict';
// Copy the local database and cached images into the Cloudflare deployment.
// Usage: TRACKER_URL=https://anime-tracker.<you>.workers.dev TRACKER_KEY_FILE=/path/to/keyfile node scripts/migrate_to_cloudflare.js
// The key is read from a file (never from argv) and sent as "Authorization: Bearer".
const fs = require('fs');
const path = require('path');
const { db, IMAGE_DIR } = require('../server/db');

const BASE = (process.env.TRACKER_URL || '').replace(/\/+$/, '');
const KEY = fs.readFileSync(process.env.TRACKER_KEY_FILE, 'utf8').trim();
if (!BASE || !KEY) throw new Error('TRACKER_URL and TRACKER_KEY_FILE are required');
const auth = { Authorization: `Bearer ${KEY}` };

const TABLES = ['anime', 'watchlist', 'episode_sync', 'media', 'media_relation', 'media_rec', 'rec_dismissed',
  'image_cache', 'cr_history', 'cr_season_map', 'cr_season_fetch', 'sync_log'];
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

async function post(pathname, body) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(BASE + pathname, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`${pathname} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

async function copyTable(table) {
  const columns = db.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all();
  const names = columns.map((c) => c.name);
  const blobColumns = columns.filter((c) => /BLOB/i.test(c.type)).map((c) => c.name);
  let batch = []; let bytes = 0; let total = 0;
  const flush = async () => {
    if (!batch.length) return;
    await post('/internal/import', { table, columns: names, blobColumns, rows: batch });
    total += batch.length; batch = []; bytes = 0;
  };
  for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
    const values = names.map((n) => (Buffer.isBuffer(row[n]) ? row[n].toString('base64') : row[n]));
    const size = values.reduce((a, v) => a + (v == null ? 4 : String(v).length), 0);
    if (bytes + size > MAX_BATCH_BYTES) await flush();
    batch.push(values); bytes += size;
  }
  await flush();
  console.log(`  ${table}: ${total} rows`);
}

async function uploadImages() {
  const crypto = require('crypto');
  const rows = db.prepare('SELECT url, file, mime FROM image_cache WHERE file IS NOT NULL').all();
  // Resume: skip images the deployment already has.
  const done = new Set(await (await fetch(`${BASE}/internal/r2-keys`, { headers: auth })).json());
  console.log(`  ${done.size} images already uploaded`);
  let i = 0; let ok = 0; let missing = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      const file = path.join(IMAGE_DIR, r.file);
      if (!fs.existsSync(file)) { missing += 1; continue; }
      const key = `img/${crypto.createHash('sha1').update(r.url).digest('hex')}`;
      const qs = new URLSearchParams({ key, mime: r.mime || 'image/jpeg', url: r.url });
      if (done.has(key)) { ok += 1; continue; }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const res = await fetch(`${BASE}/internal/r2?${qs}`, { method: 'PUT', headers: auth, body: fs.readFileSync(file) });
          if (res.ok) { ok += 1; break; }
        } catch { /* network hiccup: retry */ }
        await new Promise((res2) => setTimeout(res2, 1500 * (attempt + 1)));
      }
      if ((ok + missing) % 200 === 0) console.log(`  images ${ok + missing}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`  images: ${ok} uploaded, ${missing} missing locally`);
}

(async () => {
  console.log(`migrating to ${BASE}`);
  if (!process.argv.includes('--images-only')) for (const t of TABLES) await copyTable(t);
  await uploadImages();
  const counts = await (await fetch(`${BASE}/internal/counts`, { headers: auth })).json();
  console.log('remote counts', counts);
})().catch((err) => { console.error(err); process.exit(1); });
