'use strict';
// Convert stored episode thumbnails (PNG / large JPEG blobs) to compact JPEGs, then VACUUM.
// Stop the server first (VACUUM needs exclusive access). Usage: node scripts/optimize_episode_thumbs.js
const { db } = require('../server/db');
const images = require('../server/images');

const rows = db.prepare(`SELECT mal_id, episode_number, image_mime AS mime, length(image_blob) AS size FROM episode_sync
  WHERE image_blob IS NOT NULL AND (image_mime <> 'image/jpeg' OR length(image_blob) > 80*1024)`).all();
const get = db.prepare('SELECT image_blob FROM episode_sync WHERE mal_id = ? AND episode_number = ?');
const upd = db.prepare('UPDATE episode_sync SET image_blob = ?, image_mime = ? WHERE mal_id = ? AND episode_number = ?');
let before = 0; let after = 0;
for (const r of rows) {
  const { image_blob: blob } = get.get(r.mal_id, r.episode_number);
  const out = images.optimizeBuffer(blob, r.mime);
  before += blob.length; after += out.bytes.length;
  if (out.bytes.length < blob.length) upd.run(out.bytes, out.mime, r.mal_id, r.episode_number);
}
console.log({ converted: rows.length, beforeMB: Math.round(before / 1048576), afterMB: Math.round(after / 1048576) });
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
console.log('vacuumed');
