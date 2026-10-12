'use strict';
// One-time seed: load the merged Crunchyroll history export into cr_history using the reviewed
// row -> MAL mapping from 2026-10-12, and derive cr_season_map rules for future episodes.
// Usage: node scripts/seed_crunchyroll.js
const path = require('path');
const { db, DATA_DIR } = require('../server/db');
const { normalizeRow } = require('../server/crunchyroll');
const { readJSON } = require('../server/util');

const raw = readJSON(path.join(DATA_DIR, 'crunchyroll-history-live-raw.json'), []);
const rowmap = readJSON(path.join(DATA_DIR, 'cr-rowmap-2026-10-12.json'), []);
const byId = new Map(rowmap.map((r) => [r.id, r]));

const insertRow = db.prepare(`INSERT OR REPLACE INTO cr_history (episode_id, series_id, series_title, season_id, season_title, season_number,
  episode_number, episode_title, duration_s, playhead, fully_watched, date_played, thumb_url, mal_id, mal_episode, map_source, applied)
  VALUES (@episode_id, @series_id, @series_title, @season_id, @season_title, @season_number, @episode_number, @episode_title,
  @duration_s, @playhead, @fully_watched, @date_played, @thumb_url, @mal_id, @mal_episode, @map_source, 1)`);
const insertRule = db.prepare(`INSERT OR REPLACE INTO cr_season_map (season_id, ep_from, ep_to, mal_id, ep_offset, source, series_title, season_title, needs_review)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`);

const seasons = new Map();
let rows = 0;
db.transaction(() => {
  for (const item of raw) {
    const r = normalizeRow(item);
    if (!r) continue;
    const m = byId.get(r.episode_id);
    insertRow.run({ ...r, mal_id: m?.mal ?? null, mal_episode: m?.ep ?? null, map_source: m ? `seed-${m.src}` : null });
    rows += 1;
    const key = r.season_id || `${r.series_title}|${r.season_title}`;
    if (!seasons.has(key)) seasons.set(key, { sample: r, maps: [] });
    if (m && r.episode_number != null) seasons.get(key).maps.push({ cr: r.episode_number, mal: m.mal, ep: m.ep });
    else if (m) seasons.get(key).maps.push({ cr: 1, mal: m.mal, ep: m.ep });
  }
  let rules = 0; let skipped = 0;
  for (const [key, { sample, maps }] of seasons) {
    if (!maps.length) {
      // Only watched rows were mapped; unmapped seasons with a watched play were deliberately skipped (extras, OVAs).
      const watched = db.prepare('SELECT COUNT(*) n FROM cr_history WHERE (season_id = ? OR (season_id IS NULL AND series_title = ?)) AND (fully_watched = 1 OR (duration_s > 0 AND 1.0*playhead/duration_s >= 0.8))')
        .get(sample.season_id, sample.series_title).n;
      if (watched) { insertRule.run(key, 0, 100000, 0, 0, 'skipped', sample.series_title, sample.season_title); skipped += 1; }
      continue;
    }
    // Group by MAL id; each gets a contiguous Crunchyroll episode range and its most common offset.
    const byMal = new Map();
    for (const x of maps) {
      if (!byMal.has(x.mal)) byMal.set(x.mal, []);
      byMal.get(x.mal).push(x);
    }
    const ranges = [...byMal.entries()].map(([mal, list]) => {
      const offsets = new Map();
      list.forEach((x) => offsets.set(x.cr - x.ep, (offsets.get(x.cr - x.ep) || 0) + 1));
      const offset = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { mal, offset, from: Math.min(...list.map((x) => x.cr)), to: Math.max(...list.map((x) => x.cr)), n: list.length };
    }).sort((a, b) => a.from - b.from);
    // Open-ended: first range starts at 0, last range extends to future episodes.
    ranges.forEach((r, i) => {
      const from = i === 0 ? 0 : r.from;
      const to = i === ranges.length - 1 ? 100000 : Math.max(r.to, ranges[i + 1].from - 1);
      insertRule.run(key, from, to, r.mal, r.offset, 'seed', sample.series_title, sample.season_title);
      rules += 1;
    });
  }
  db.prepare('INSERT INTO sync_log (source, summary) VALUES (?, ?)').run('seed', JSON.stringify({ rows, rules, skipped }));
  console.log({ rows, seasons: seasons.size, rules, skipped });
})();
