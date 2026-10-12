'use strict';
// Re-compress already cached images (PNG -> JPEG, cap height at 720px). Usage: node scripts/optimize_images.js
const fs = require('fs');
const path = require('path');
const { db, IMAGE_DIR } = require('../server/db');
const images = require('../server/images');

const rows = db.prepare('SELECT url, file, mime, bytes FROM image_cache WHERE file IS NOT NULL').all();
const upd = db.prepare('UPDATE image_cache SET file = ?, mime = ?, bytes = ? WHERE url = ?');
let before = 0; let after = 0;
for (const r of rows) {
  if (!fs.existsSync(path.join(IMAGE_DIR, r.file))) continue;
  before += r.bytes;
  const opt = images.optimize(r.file, r.mime);
  const size = fs.statSync(path.join(IMAGE_DIR, opt.file)).size;
  after += size;
  if (opt.file !== r.file || size !== r.bytes) upd.run(opt.file, opt.mime, size, r.url);
}
console.log({ images: rows.length, beforeMB: Math.round(before / 1048576), afterMB: Math.round(after / 1048576) });
