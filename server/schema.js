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
-- Episodes. What you watched is yours (episode_watch, in your file); what an episode is (title, air
-- date, still, Crunchyroll link, and which source said so) is shared (catalog_episodes). Reads use the
-- episode_sync view that joins them (installEpisodeView), so queries see one row per episode as before.
CREATE TABLE IF NOT EXISTS episode_watch (
  mal_id INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  season INTEGER DEFAULT 1,
  watched INTEGER DEFAULT 0,
  watched_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(mal_id, episode_number),
  FOREIGN KEY(mal_id) REFERENCES anime(mal_id) ON DELETE CASCADE
);
-- Covers the per-show progress summary (Library, Up Next).
CREATE INDEX IF NOT EXISTS idx_episode_watch_progress ON episode_watch(mal_id, watched, episode_number, watched_at);
CREATE TABLE IF NOT EXISTS catalog_episodes (
  mal_id INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  title TEXT, title_src TEXT, title_at TEXT,
  url TEXT, url_src TEXT,
  aired TEXT, aired_src TEXT,
  image_url TEXT, image_blob BLOB, image_mime TEXT, image_src TEXT, image_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(mal_id, episode_number)
);
-- Counting stored thumbnails without reading the rows that hold them.
CREATE INDEX IF NOT EXISTS idx_catalog_episodes_has_blob ON catalog_episodes(mal_id) WHERE image_blob IS NOT NULL;
-- Cross-site ids for a show (Fribb anime-lists, refreshed weekly).
CREATE TABLE IF NOT EXISTS catalog_idmap (
  mal_id INTEGER PRIMARY KEY,
  anilist_id INTEGER,
  kitsu_id INTEGER,
  tmdb_tv_id INTEGER,
  tmdb_season INTEGER,
  tvdb_id INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

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

-- Catalog worker (hosted mode): AniList jobs, deduplicated by key; priority grows with every
-- account that waits on a job and with how recent the plays waiting on it are.
CREATE TABLE IF NOT EXISTS catalog_jobs (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,               -- full | search | refresh
  payload TEXT NOT NULL,            -- JSON: { malId } or { query }
  priority REAL NOT NULL DEFAULT 0,
  waiting INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | done | quarantined
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result TEXT,                      -- search jobs: the candidates (JSON), for the accounts waiting on it
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Crowd-sourced Crunchyroll knowledge (D3): claims with one vote per account. A series id is
-- promoted at 2 agreeing accounts, a season mapping at 3; disagreement is flagged, never promoted.
CREATE TABLE IF NOT EXISTS cr_series_claims (
  series_id TEXT NOT NULL,
  mal_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (series_id, account_id)
);
CREATE TABLE IF NOT EXISTS cr_season_claims (
  season_id TEXT NOT NULL,
  mal_id INTEGER NOT NULL,
  ep_offset INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (season_id, account_id)
);
-- Which accounts wait on a search, for which of their Crunchyroll seasons.
CREATE TABLE IF NOT EXISTS catalog_waiters (
  job_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  season_key TEXT NOT NULL,
  min_episode INTEGER NOT NULL DEFAULT 1,
  sample TEXT NOT NULL,             -- { series_title, season_title }
  PRIMARY KEY (job_key, account_id, season_key)
);
CREATE INDEX IF NOT EXISTS idx_catalog_jobs_next ON catalog_jobs(status, priority DESC, created_at);
CREATE TABLE IF NOT EXISTS catalog_lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL       -- ms since epoch
);

-- Settings that are the same for everyone (hosted mode keeps them in the catalog; see state.js).
CREATE TABLE IF NOT EXISTS catalog_state (
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
  ['media', 'start_day_known', 'start_day_known INTEGER'],
];
// Columns the pre-split episode_sync table gained over time; added before migrating an old file.
const LEGACY_EPISODE_COLUMNS = [['image_source', 'image_source TEXT'], ['image_url', 'image_url TEXT']];

// Hosted mode splits the tables: what is the same for everyone (show metadata, relations,
// recommendations, the image index, AniList job queues, Crunchyroll season fetch times) lives in
// one catalog file; everything about a person lives in their account file. Single-user mode keeps
// all of it in one file, as before.
const CATALOG_TABLES = new Set(['media', 'media_relation', 'media_rec', 'image_cache', 'cr_season_fetch', 'anilist_relay', 'anilist_pending_ids', 'catalog_state', 'catalog_jobs', 'catalog_lease', 'catalog_waiters', 'cr_series_claims', 'cr_season_claims', 'catalog_episodes', 'catalog_idmap']);

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

const isTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * Move a pre-split episode_sync table into episode_watch (this file) and catalog_episodes (`facts`:
 * this file in single-user mode, the catalog connection in hosted mode). Sources are inferred where
 * the row shows them: a title next to a Crunchyroll link came from Crunchyroll (the extension or
 * AniList's Crunchyroll list), a still keeps its image_source; anything else is 'legacy', the lowest
 * rank, so any real source can improve it. A Crunchyroll link or still may be another audio version,
 * so it ranks below one the extension picked for your audio. Existing catalog facts win.
 * The old table is kept as episode_sync_legacy for one release.
 */
function migrateEpisodes(db, facts) {
  if (!isTable(db, 'episode_sync')) return null;
  const cols = db.prepare("SELECT name FROM pragma_table_info('episode_sync')").all().map((r) => r.name);
  for (const [column, ddl] of LEGACY_EPISODE_COLUMNS) if (!cols.includes(column)) db.exec(`ALTER TABLE episode_sync ADD COLUMN ${ddl}`);
  const rows = db.prepare('SELECT * FROM episode_sync').all();
  // A row whose show is gone (no anime row) was never shown; it stays in episode_sync_legacy only.
  const putWatch = db.prepare(`INSERT OR IGNORE INTO episode_watch (mal_id, episode_number, season, watched, watched_at, updated_at)
    SELECT @mal_id, @episode_number, @season, @watched, @watched_at, @updated_at WHERE EXISTS (SELECT 1 FROM main.anime WHERE mal_id = @mal_id)`);
  const putFacts = facts.prepare(`INSERT INTO catalog_episodes (mal_id, episode_number, title, title_src, url, url_src, aired, aired_src,
      image_url, image_blob, image_mime, image_src, updated_at)
    VALUES (@mal_id, @episode_number, @title, @title_src, @url, @url_src, @aired, @aired_src, @image_url, @image_blob, @image_mime, @image_src, @updated_at)
    ON CONFLICT(mal_id, episode_number) DO UPDATE SET
      title = COALESCE(catalog_episodes.title, excluded.title), title_src = COALESCE(catalog_episodes.title_src, excluded.title_src),
      url = COALESCE(catalog_episodes.url, excluded.url), url_src = COALESCE(catalog_episodes.url_src, excluded.url_src),
      aired = COALESCE(catalog_episodes.aired, excluded.aired), aired_src = COALESCE(catalog_episodes.aired_src, excluded.aired_src),
      image_url = COALESCE(catalog_episodes.image_url, excluded.image_url), image_src = COALESCE(catalog_episodes.image_src, excluded.image_src),
      image_blob = COALESCE(catalog_episodes.image_blob, excluded.image_blob), image_mime = COALESCE(catalog_episodes.image_mime, excluded.image_mime)`);
  const placeholder = (t) => !t || /^Episode \d+(\.0)?( \(from history\))?$/i.test(String(t).trim());
  const IMAGE_SOURCES = { crunchyroll: 'crunchyroll-other', anilist: 'anilist', jikan: 'jikan' };
  let orphans = 0;
  const move = () => {
    for (const r of rows) {
      const watch = { mal_id: r.mal_id, episode_number: r.episode_number, season: r.season ?? 1, watched: r.watched ? 1 : 0, watched_at: r.watched_at, updated_at: r.updated_at };
      if (!putWatch.run(watch).changes) { orphans += 1; continue; }
      const hasImage = r.image_blob != null || r.image_url != null;
      const fromCr = /crunchyroll\.com\//.test(r.url || '');
      putFacts.run({
        mal_id: r.mal_id, episode_number: r.episode_number,
        title: placeholder(r.title) ? null : r.title, title_src: placeholder(r.title) ? null : fromCr ? 'crunchyroll-other' : 'legacy',
        url: r.url || null, url_src: !r.url ? null : /crunchyroll\.com\/watch\//.test(r.url) ? 'crunchyroll-other' : 'legacy',
        aired: r.aired || null, aired_src: r.aired ? 'legacy' : null,
        image_url: r.image_url || null, image_blob: r.image_blob ?? null, image_mime: r.image_mime ?? null,
        image_src: hasImage ? (IMAGE_SOURCES[r.image_source] || 'legacy') : null,
        updated_at: r.updated_at
      });
    }
  };
  if (facts === db) db.transaction(move)(); else { facts.transaction(() => db.transaction(move)())(); }
  for (const idx of ['idx_episode_sync_mal', 'idx_episode_sync_progress', 'idx_episode_sync_has_image']) db.exec(`DROP INDEX IF EXISTS ${idx}`);
  db.exec('ALTER TABLE episode_sync RENAME TO episode_sync_legacy');
  return { rows: rows.length, orphans };
}

const EPISODE_VIEW = (temp) => `CREATE ${temp ? 'TEMP ' : ''}VIEW IF NOT EXISTS episode_sync AS
  SELECT w.mal_id, w.episode_number, w.season,
    COALESCE(c.title, 'Episode ' || w.episode_number) AS title,
    c.url, c.aired, w.watched, w.watched_at, c.image_blob, c.image_mime,
    COALESCE(c.updated_at, w.updated_at) AS updated_at, c.image_src AS image_source, c.image_url
  FROM episode_watch w LEFT JOIN catalog_episodes c ON c.mal_id = w.mal_id AND c.episode_number = w.episode_number`;

// Writes through the view. Watched state always goes to episode_watch. Facts go to catalog_episodes
// only in single-user mode (hosted mode writes facts through the catalog's merge, never from an
// account connection); a fact written this way is 'legacy' (lowest rank) and fills only what's empty
// on insert, as INSERT OR IGNORE into the old table did.
const WATCH_TRIGGERS = (temp) => `
CREATE ${temp ? 'TEMP ' : ''}TRIGGER IF NOT EXISTS episode_sync_insert INSTEAD OF INSERT ON episode_sync BEGIN
  INSERT INTO episode_watch (mal_id, episode_number, season, watched, watched_at, updated_at)
    VALUES (NEW.mal_id, NEW.episode_number, COALESCE(NEW.season, 1), COALESCE(NEW.watched, 0), NEW.watched_at, COALESCE(NEW.updated_at, CURRENT_TIMESTAMP));
  ${temp ? '' : `INSERT OR IGNORE INTO catalog_episodes (mal_id, episode_number) VALUES (NEW.mal_id, NEW.episode_number);
  UPDATE catalog_episodes SET
    title = CASE WHEN (title IS NULL) AND NEW.title IS NOT NULL AND NEW.title NOT GLOB 'Episode [0-9]*' THEN NEW.title ELSE title END,
    title_src = CASE WHEN (title IS NULL) AND NEW.title IS NOT NULL AND NEW.title NOT GLOB 'Episode [0-9]*' THEN 'legacy' ELSE title_src END,
    url = CASE WHEN url IS NULL AND COALESCE(NEW.url, '') <> '' THEN NEW.url ELSE url END,
    url_src = CASE WHEN url IS NULL AND COALESCE(NEW.url, '') <> '' THEN CASE WHEN NEW.url LIKE '%crunchyroll.com/watch/%' THEN 'crunchyroll-other' ELSE 'legacy' END ELSE url_src END,
    aired = COALESCE(aired, NEW.aired), aired_src = CASE WHEN aired IS NULL AND NEW.aired IS NOT NULL THEN 'legacy' ELSE aired_src END,
    image_url = COALESCE(image_url, NEW.image_url), image_blob = COALESCE(image_blob, NEW.image_blob), image_mime = COALESCE(image_mime, NEW.image_mime),
    image_src = CASE WHEN image_src IS NULL AND (NEW.image_url IS NOT NULL OR NEW.image_blob IS NOT NULL) THEN COALESCE(NEW.image_source, 'legacy') ELSE image_src END
  WHERE mal_id = NEW.mal_id AND episode_number = NEW.episode_number;`}
END;
CREATE ${temp ? 'TEMP ' : ''}TRIGGER IF NOT EXISTS episode_sync_update INSTEAD OF UPDATE ON episode_sync BEGIN
  UPDATE episode_watch SET season = NEW.season, watched = NEW.watched, watched_at = NEW.watched_at,
      updated_at = CASE WHEN NEW.watched IS NOT OLD.watched OR NEW.watched_at IS NOT OLD.watched_at THEN CURRENT_TIMESTAMP ELSE updated_at END
    WHERE mal_id = OLD.mal_id AND episode_number = OLD.episode_number;
  ${temp ? '' : `INSERT OR IGNORE INTO catalog_episodes (mal_id, episode_number) SELECT NEW.mal_id, NEW.episode_number
    WHERE NEW.title IS NOT OLD.title OR NEW.url IS NOT OLD.url OR NEW.aired IS NOT OLD.aired OR NEW.image_url IS NOT OLD.image_url OR NEW.image_blob IS NOT OLD.image_blob;
  UPDATE catalog_episodes SET
    title = CASE WHEN NEW.title IS NOT OLD.title THEN NULLIF(NEW.title, 'Episode ' || NEW.episode_number) ELSE title END,
    title_src = CASE WHEN NEW.title IS NOT OLD.title THEN 'legacy' ELSE title_src END,
    url = CASE WHEN NEW.url IS NOT OLD.url THEN NEW.url ELSE url END,
    url_src = CASE WHEN NEW.url IS NOT OLD.url THEN CASE WHEN NEW.url LIKE '%crunchyroll.com/watch/%' THEN 'crunchyroll-other' ELSE 'legacy' END ELSE url_src END,
    aired = CASE WHEN NEW.aired IS NOT OLD.aired THEN NEW.aired ELSE aired END,
    image_url = CASE WHEN NEW.image_url IS NOT OLD.image_url THEN NEW.image_url ELSE image_url END,
    image_blob = CASE WHEN NEW.image_blob IS NOT OLD.image_blob THEN NEW.image_blob ELSE image_blob END,
    image_mime = CASE WHEN NEW.image_mime IS NOT OLD.image_mime THEN NEW.image_mime ELSE image_mime END,
    image_src = CASE WHEN NEW.image_source IS NOT OLD.image_source THEN NEW.image_source ELSE image_src END,
    updated_at = CURRENT_TIMESTAMP
  WHERE mal_id = NEW.mal_id AND episode_number = NEW.episode_number
    AND (NEW.title IS NOT OLD.title OR NEW.url IS NOT OLD.url OR NEW.aired IS NOT OLD.aired OR NEW.image_url IS NOT OLD.image_url OR NEW.image_blob IS NOT OLD.image_blob OR NEW.image_source IS NOT OLD.image_source);`}
END;
CREATE ${temp ? 'TEMP ' : ''}TRIGGER IF NOT EXISTS episode_sync_delete INSTEAD OF DELETE ON episode_sync BEGIN
  DELETE FROM episode_watch WHERE mal_id = OLD.mal_id AND episode_number = OLD.episode_number;
END;`;

/**
 * The episode_sync view and its write triggers. Single-user file: stored in the file. Account
 * connection (hosted): TEMP, created after the catalog is attached (a stored view can't reach an
 * attached database), and its triggers write watched state only.
 */
function installEpisodeView(db, part = 'all') {
  const temp = part === 'account';
  db.exec(`${EPISODE_VIEW(temp)};\n${WATCH_TRIGGERS(temp)}`);
}

/**
 * part: 'all' (single-user file), 'account' (an account's file) or 'catalog' (the shared file).
 * `catalog`: the catalog connection when applying 'account', for migrating an old episode table.
 */
function applySchema(db, part = 'all', { catalog = null } = {}) {
  db.exec(schemaFor(part));
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    if (part !== 'all' && (part === 'catalog') !== CATALOG_TABLES.has(table)) continue;
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  if (part === 'all') { migrateEpisodes(db, db); installEpisodeView(db, 'all'); }
  if (part === 'account' && catalog) migrateEpisodes(db, catalog);
}

module.exports = { SCHEMA, CATALOG_TABLES, applySchema, schemaFor, installEpisodeView, migrateEpisodes };
