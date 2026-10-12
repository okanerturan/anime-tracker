'use strict';
// One-time repair: episodes stored beyond a finished MAL entry's length (from Crunchyroll's continuous
// numbering of split-cour seasons) are moved to the sequel entry. Usage: node scripts/repair_split_cours.js [--dry]
const { db } = require('../server/db');
const library = require('../server/library');
const anilist = require('../server/sources/anilist');

(async () => {
  const dry = process.argv.includes('--dry');
  // Sequel chains need relations of the intermediate entries too.
  for (let pass = 0; pass < 3; pass += 1) {
    const missing = db.prepare(`SELECT DISTINCT r.related_mal_id AS id FROM media_relation r JOIN media m ON m.mal_id = r.related_mal_id
      WHERE r.relation_type = 'SEQUEL' AND m.is_full = 0 AND r.mal_id IN (SELECT mal_id FROM episode_sync e JOIN media mm USING(mal_id)
        WHERE mm.status = 'FINISHED' AND mm.episodes IS NOT NULL AND e.episode_number > mm.episodes)`).all().map((r) => r.id);
    if (!missing.length) break;
    await anilist.fetchFullByMalIds(missing);
  }
  const over = db.prepare(`SELECT e.mal_id, e.episode_number, e.title, e.watched, e.watched_at, m.episodes
    FROM episode_sync e JOIN media m ON m.mal_id = e.mal_id
    WHERE m.status = 'FINISHED' AND m.episodes IS NOT NULL AND e.episode_number > m.episodes
    ORDER BY e.mal_id, e.episode_number`).all();
  const moves = []; const orphans = [];
  for (const r of over) {
    const to = library.resolveOverflow(r.mal_id, r.episode_number);
    if (to.malId === r.mal_id) orphans.push(r); else moves.push({ ...r, to });
  }
  const targets = [...new Set(moves.map((m) => m.to.malId))];
  const summary = { overflowRows: over.length, moved: moves.length, movedWatched: moves.filter((m) => m.watched).length,
    noSequel: orphans.length, targets: targets.length };
  console.log(summary);
  for (const id of [...new Set(orphans.map((o) => o.mal_id))]) {
    const t = db.prepare('SELECT title FROM anime WHERE mal_id = ?').get(id)?.title;
    console.log('  no sequel for', id, t, orphans.filter((o) => o.mal_id === id).length, 'rows');
  }
  if (dry) return;
  db.transaction(() => {
    for (const id of targets) {
      if (!library.isInLibrary(id)) {
        const m = db.prepare('SELECT * FROM media WHERE mal_id = ?').get(id);
        library.addToLibrary({ malId: id, title: m?.title || `MAL ${id}`, titleEnglish: m?.title_english || '', imageUrl: m?.cover_url || '', releaseDate: m?.start_date, totalEpisodes: m?.episodes });
      }
    }
    const ins = db.prepare(`INSERT INTO episode_sync (mal_id, episode_number, season, title, url, aired, watched, watched_at, updated_at)
      VALUES (?, ?, 1, 'Episode ' || ?, '', NULL, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mal_id, episode_number) DO UPDATE SET watched = MAX(episode_sync.watched, excluded.watched),
        watched_at = COALESCE(episode_sync.watched_at, excluded.watched_at)`);
    const del = db.prepare('DELETE FROM episode_sync WHERE mal_id = ? AND episode_number = ?');
    const totalOf = db.prepare('SELECT episodes FROM media WHERE mal_id = ?');
    for (const m of moves) {
      const total = totalOf.get(m.to.malId)?.episodes;
      if (!total || m.to.episodeNumber <= total) ins.run(m.to.malId, m.to.episodeNumber, m.to.episodeNumber, m.watched, m.watched_at);
      del.run(m.mal_id, m.episode_number);
    }
    db.prepare('INSERT INTO sync_log (source, summary) VALUES (?, ?)').run('repair-split-cours', JSON.stringify(summary));
  })();
  // Pass 2: history rows mapped to the right sequel but numbered past its end (continuous numbering).
  // Renumber relative to the last Crunchyroll episode of the same season that maps to the prequel.
  const bad = db.prepare(`SELECT h.episode_id, h.season_id, h.episode_number, h.mal_id, h.mal_episode, m.episodes FROM cr_history h JOIN media m ON m.mal_id = h.mal_id
    WHERE m.episodes IS NOT NULL AND h.mal_episode > m.episodes AND h.episode_number IS NOT NULL`).all();
  // A sequel's episodes come right after the prequel's last Crunchyroll episode in the same season.
  let renumbered = 0;
  db.transaction(() => {
    for (const b of bad) {
      const prequelLast = db.prepare(`SELECT MAX(h.episode_number) AS last FROM cr_history h
        JOIN media_relation r ON r.related_mal_id = h.mal_id AND r.mal_id = ? AND r.relation_type = 'PREQUEL'
        WHERE h.season_id = ? AND h.episode_number < ?`).get(b.mal_id, b.season_id, b.episode_number)?.last;
      if (!prequelLast) {
        // Fall back to the most common offset used by sibling rows of the same season and MAL entry.
        const sib = db.prepare(`SELECT episode_number - mal_episode AS off, COUNT(*) n FROM cr_history
          WHERE season_id = ? AND mal_id = ? AND mal_episode <= ? GROUP BY off ORDER BY n DESC LIMIT 1`).get(b.season_id, b.mal_id, b.episodes);
        const ep2 = sib ? b.episode_number - sib.off : 0;
        if (sib && sib.n >= 2 && ep2 >= 1 && ep2 <= b.episodes) {
          db.prepare('UPDATE cr_history SET mal_episode = ?, applied = 0, map_source = ? WHERE episode_id = ?').run(ep2, 'repair-sibling-offset', b.episode_id);
          renumbered += 1;
        }
        continue;
      }
      const ep = b.episode_number - prequelLast;
      if (ep < 1 || ep > b.episodes) continue;
      db.prepare('UPDATE cr_history SET mal_episode = ?, applied = 0, map_source = ? WHERE episode_id = ?').run(ep, 'repair-renumber', b.episode_id);
      renumbered += 1;
    }
  })();
  console.log({ renumbered });
  await anilist.fetchFullByMalIds(targets.filter((id) => !db.prepare('SELECT is_full FROM media WHERE mal_id = ?').get(id)?.is_full)).catch(() => {});
  console.log('done');
})();
