'use strict';
// Database schema shared by the local server (better-sqlite3) and the Cloudflare Durable Object (SQLite storage).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS anime (
  mal_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  title_english TEXT,
  release_date TEXT,
  image_url TEXT,
  synopsis TEXT,
  total_episodes INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS watchlist (
  mal_id INTEGER PRIMARY KEY,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP,
  synced_at TEXT,
  FOREIGN KEY(mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS episode_sync (
  mal_id INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  season INTEGER DEFAULT 1,
  title TEXT,
  url TEXT,
  aired TEXT,
  watched INTEGER DEFAULT 0,
  watched_at TEXT,
  image_blob BLOB,
  image_mime TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(mal_id, episode_number),
  FOREIGN KEY(mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_episode_sync_mal ON episode_sync(mal_id);

-- AniList metadata for any title we know about (library, relations, recommendations)
CREATE TABLE IF NOT EXISTS media (
  mal_id INTEGER PRIMARY KEY,
  anilist_id INTEGER,
  title TEXT,
  title_english TEXT,
  format TEXT,
  status TEXT,
  episodes INTEGER,
  duration INTEGER,
  season_year INTEGER,
  start_date TEXT,
  genres TEXT,            -- JSON array
  tags TEXT,              -- JSON array of {name, rank}
  average_score INTEGER,
  popularity INTEGER,
  cover_url TEXT,
  banner_url TEXT,
  color TEXT,
  site_url TEXT,
  next_airing_episode INTEGER,
  next_airing_at INTEGER,
  streaming_episodes TEXT, -- JSON array of {title, thumbnail, url, site}
  is_full INTEGER DEFAULT 0, -- 1 when relations/recommendations were fetched
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS media_relation (
  mal_id INTEGER NOT NULL,
  related_mal_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  PRIMARY KEY(mal_id, related_mal_id, relation_type)
);
CREATE TABLE IF NOT EXISTS media_rec (
  mal_id INTEGER NOT NULL,
  rec_mal_id INTEGER NOT NULL,
  rating INTEGER,
  PRIMARY KEY(mal_id, rec_mal_id)
);
CREATE INDEX IF NOT EXISTS idx_media_rec_rec ON media_rec(rec_mal_id);
CREATE TABLE IF NOT EXISTS rec_dismissed (
  mal_id INTEGER PRIMARY KEY,
  at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Remote images fetched once and stored on disk (posters, covers)
CREATE TABLE IF NOT EXISTS image_cache (
  url TEXT PRIMARY KEY,
  file TEXT,
  mime TEXT,
  bytes INTEGER,
  fetched_at TEXT,
  failed_at TEXT
);

-- Crunchyroll watch history (one row per Crunchyroll episode id)
CREATE TABLE IF NOT EXISTS cr_history (
  episode_id TEXT PRIMARY KEY,
  series_id TEXT,
  series_title TEXT,
  season_id TEXT,
  season_title TEXT,
  season_number INTEGER,
  episode_number INTEGER,
  episode_title TEXT,
  duration_s INTEGER,
  playhead INTEGER,
  fully_watched INTEGER,
  date_played TEXT,
  thumb_url TEXT,
  mal_id INTEGER,
  mal_episode INTEGER,
  map_source TEXT,
  applied INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cr_history_season ON cr_history(season_id);
CREATE INDEX IF NOT EXISTS idx_cr_history_played ON cr_history(date_played);
-- Rules mapping a Crunchyroll season (and episode range) to a MAL entry
CREATE TABLE IF NOT EXISTS cr_season_map (
  season_id TEXT NOT NULL,
  ep_from INTEGER NOT NULL,
  ep_to INTEGER NOT NULL,
  mal_id INTEGER NOT NULL,
  ep_offset INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  series_title TEXT,
  season_title TEXT,
  needs_review INTEGER DEFAULT 0,
  PRIMARY KEY(season_id, ep_from)
);
CREATE TABLE IF NOT EXISTS cr_season_fetch (
  season_id TEXT PRIMARY KEY,
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT CURRENT_TIMESTAMP,
  source TEXT,
  summary TEXT
);
`;

// Columns added after the first release; ALTER only when missing.
const ADDED_COLUMNS = [
  ['anime', 'release_date', 'release_date TEXT'],
  ['watchlist', 'synced_at', 'synced_at TEXT'],
  ['episode_sync', 'image_source', 'image_source TEXT'],
  ['media', 'external_links', 'external_links TEXT'],
  ['media', 'description', 'description TEXT']
];

function applySchema(db) {
  db.exec(SCHEMA);
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

module.exports = { SCHEMA, applySchema };
