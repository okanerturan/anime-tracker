'use strict';
// Download every poster/cover the UI can show (library, relations, recommendations) into the local
// image cache once, so the app never re-requests them from remote CDNs. Usage: node scripts/prefetch_images.js
const { db } = require('../server/db');
const images = require('../server/images');

(async () => {
  const urls = db.prepare(`
    SELECT COALESCE(m.cover_url, a.image_url) AS u FROM watchlist w JOIN anime a ON a.mal_id = w.mal_id LEFT JOIN media m ON m.mal_id = w.mal_id
    UNION SELECT cover_url FROM media WHERE cover_url IS NOT NULL
      AND (mal_id IN (SELECT rec_mal_id FROM media_rec) OR mal_id IN (SELECT related_mal_id FROM media_relation WHERE relation_type = 'SEQUEL'))
  `).all().map((r) => r.u).filter(Boolean);
  console.log(`prefetching ${urls.length} images`);
  const result = await images.prefetch(urls, 6, (done, total) => console.log(`  ${done}/${total}`));
  console.log(result, images.stats());
})();
