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
-- Covers the per-show progress summary (Library, Up Next) without touching rows that hold thumbnails.
CREATE INDEX IF NOT EXISTS idx_episode_sync_progress ON episode_sync(mal_id, watched, episode_number, watched_at);
-- Counting stored thumbnails without reading the rows that hold them.
CREATE INDEX IF NOT EXISTS idx_episode_sync_has_image ON episode_sync(mal_id) WHERE image_blob IS NOT NULL;

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
-- Per-show lookups (Crunchyroll links, sampled shows) run hundreds of times per page.
CREATE INDEX IF NOT EXISTS idx_cr_history_mal ON cr_history(mal_id);
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
CREATE INDEX IF NOT EXISTS idx_cr_season_map_mal ON cr_season_map(mal_id);
CREATE TABLE IF NOT EXISTS cr_season_fetch (
  season_id TEXT PRIMARY KEY,
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Small key/value store for state that must survive restarts (last refresh, last backup).
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- AniList relay: requests the server couldn't make (AniList blocks some hosting networks, e.g. Cloudflare)
-- wait here until the browser extension or the open web app runs them and posts the answers back.
CREATE TABLE IF NOT EXISTS anilist_relay (
  key TEXT PRIMARY KEY,
  query TEXT,
  variables TEXT,
  data TEXT,
  requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS anilist_pending_ids (
  mal_id INTEGER PRIMARY KEY,
  requested_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  // Your own list state: NULL (active), 'on_hold' or 'dropped'; and a 1-5 rating.
  ['watchlist', 'list_status', 'list_status TEXT'],
  ['watchlist', 'rating', 'rating INTEGER'],
  // Crunchyroll series id found by the extension's search ('' = searched, not on Crunchyroll).
  ['media', 'cr_series_id', 'cr_series_id TEXT'],
  // A paused play the user dismissed from the Started-on-Crunchyroll shelf.
  ['cr_history', 'dismissed', 'dismissed INTEGER DEFAULT 0'],
  ['media', 'cr_checked_at', 'cr_checked_at TEXT'],
  ['media', 'description', 'description TEXT'],
  // Alternate titles from AniList (JSON array, short Latin-alphabet ones only: "JJK", "AoT").
  ['media', 'synonyms', 'synonyms TEXT'],
  // 1 when AniList gave the start day (month-only dates are stored as the 1st), 0 when it didn't.
  ['media', 'start_day_known', 'start_day_known INTEGER']
];

// Hosted mode splits the tables: what is the same for everyone (show metadata, relations,
// recommendations, the image index, AniList job queues, Crunchyroll season fetch times) lives in
// one catalog file; everything about a person lives in their account file. Single-user mode keeps
// all of it in one file, as before.
const CATALOG_TABLES = new Set(['media', 'media_relation', 'media_rec', 'image_cache', 'cr_season_fetch', 'anilist_relay', 'anilist_pending_ids']);

/** The table a CREATE TABLE / CREATE INDEX statement is about. */
function tableOf(statement) {
  const m = statement.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i) || statement.match(/\bON\s+(\w+)\s*\(/i);
  return m ? m[1] : null;
}

function schemaFor(part) {
  if (part === 'all') return SCHEMA;
  return SCHEMA.split(/;\s*\n/).filter((st) => st.trim()).filter((st) => {
    const t = tableOf(st);
    return t && (part === 'catalog' ? CATALOG_TABLES.has(t) : !CATALOG_TABLES.has(t));
  }).join(';\n') + ';';
}

/** part: 'all' (single-user file), 'account' (an account's file) or 'catalog' (the shared file). */
function applySchema(db, part = 'all') {
  db.exec(schemaFor(part));
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    if (part !== 'all' && (part === 'catalog') !== CATALOG_TABLES.has(table)) continue;
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

module.exports = { SCHEMA, CATALOG_TABLES, applySchema, schemaFor };
