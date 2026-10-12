'use strict';
// Episodes can't be watched before their show premiered. Older title-based imports copied season 1
// plays onto sequels; this clears those marks and re-applies the real Crunchyroll history for the
// affected shows. Usage: node scripts/repair_impossible_watches.js [--dry]
const { db } = require('../server/db');
const crunchyroll = require('../server/crunchyroll');

(async () => {
  const dry = process.argv.includes('--dry');
  const bad = db.prepare(`SELECT e.mal_id, e.episode_number FROM episode_sync e JOIN media m USING(mal_id)
    WHERE e.watched = 1 AND e.watched_at IS NOT NULL AND m.start_date IS NOT NULL AND e.watched_at < date(m.start_date, '-2 days')`).all();
  const shows = [...new Set(bad.map((b) => b.mal_id))];
  console.log({ impossibleRows: bad.length, shows: shows.length });
  if (dry || !bad.length) return;
  db.transaction(() => {
    const clear = db.prepare('UPDATE episode_sync SET watched = 0, watched_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE mal_id = ? AND episode_number = ?');
    for (const b of bad) clear.run(b.mal_id, b.episode_number);
    // Re-apply genuine history for those shows (the premiere guard in ingest skips impossible plays).
    const reset = db.prepare('UPDATE cr_history SET applied = 0 WHERE mal_id = ?');
    for (const id of shows) reset.run(id);
    db.prepare('INSERT INTO sync_log (source, summary) VALUES (?, ?)').run('repair-impossible-watches', JSON.stringify({ rows: bad.length, shows: shows.length }));
  })();
  const result = await crunchyroll.ingest([], { source: 'manual' });
  console.log('re-applied', { marked: result.marked, already: result.already });
  setTimeout(() => process.exit(0), 300);
})();
