'use strict';
// The episode split: an old file's episode_sync table becomes episode_watch (yours) plus
// catalog_episodes (shared facts), keeping every watched mark and every real title.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { applySchema, installEpisodeView, schemaFor } = require('../server/schema');

const OLD_TABLE = `CREATE TABLE episode_sync (
  mal_id INTEGER NOT NULL, episode_number INTEGER NOT NULL, season INTEGER DEFAULT 1, title TEXT, url TEXT, aired TEXT,
  watched INTEGER DEFAULT 0, watched_at TEXT, image_blob BLOB, image_mime TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  image_source TEXT, image_url TEXT, PRIMARY KEY(mal_id, episode_number))`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-migrate-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function oldFile(name, rows, part = 'all') {
  const conn = new Database(path.join(dir, name));
  conn.exec(schemaFor(part));
  conn.exec(OLD_TABLE);
  for (const mal of new Set(rows.map((r) => r.mal))) if (mal !== 99) conn.prepare('INSERT INTO anime (mal_id, title) VALUES (?, ?)').run(mal, `Show ${mal}`);
  const ins = conn.prepare(`INSERT INTO episode_sync (mal_id, episode_number, title, url, aired, watched, watched_at, image_blob, image_mime, image_source, image_url)
    VALUES (@mal, @n, @title, @url, @aired, @watched, @at, @blob, @mime, @src, @img)`);
  for (const r of rows) ins.run({ url: '', aired: null, watched: 0, at: null, blob: null, mime: null, src: null, img: null, ...r });
  return conn;
}

const FIXTURE = [
  { mal: 1, n: 1, title: 'Crunchyroll Title', url: 'https://www.crunchyroll.com/watch/G1/x', watched: 1, at: '2026-01-01T20:00:00Z', src: 'crunchyroll', img: 'https://imgsrv.crunchyroll.com/a.jpg' },
  { mal: 1, n: 2, title: 'Episode 2', watched: 1, at: '2026-01-02T20:00:00Z' },
  { mal: 1, n: 3, title: 'Jikan Title', url: 'https://myanimelist.net/anime/1/x/episode/3', blob: Buffer.from([1, 2, 3]), mime: 'image/jpeg', src: 'jikan' },
  { mal: 2, n: 1, title: 'Episode 1 (from history)', watched: 1, at: '2025-05-05T10:00:00Z', aired: '2025-05-01' }
];
const ORPHAN = { mal: 99, n: 1, title: 'Show Gone', watched: 1, at: '2024-01-01T00:00:00Z' }; // no anime row

test('single-user file: every watched mark and every real title survive, sources are inferred', () => {
  const conn = oldFile('single.db', [...FIXTURE, ORPHAN]);
  applySchema(conn, 'all');
  assert.equal(conn.prepare("SELECT type FROM sqlite_master WHERE name = 'episode_sync'").get().type, 'view');
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM episode_sync_legacy').get().n, FIXTURE.length + 1, 'the old table is kept, orphan included');
  const rows = conn.prepare('SELECT mal_id, episode_number, title, watched, watched_at FROM episode_sync ORDER BY 1, 2').all();
  assert.deepEqual(rows.map((r) => [r.mal_id, r.episode_number, r.watched, r.watched_at]), FIXTURE.map((r) => [r.mal, r.n, r.watched || 0, r.at || null]));
  assert.deepEqual(rows.map((r) => r.title), ['Crunchyroll Title', 'Episode 2', 'Jikan Title', 'Episode 1'], 'placeholders read back as placeholders');
  const facts = conn.prepare('SELECT title_src, url_src, image_src, image_blob IS NOT NULL AS blob, aired_src FROM catalog_episodes ORDER BY mal_id, episode_number').all();
  assert.deepEqual(facts[0], { title_src: 'crunchyroll-other', url_src: 'crunchyroll-other', image_src: 'crunchyroll-other', blob: 0, aired_src: null });
  assert.equal(facts[1].title_src, null, 'a placeholder is not stored as a title');
  assert.deepEqual([facts[2].title_src, facts[2].url_src, facts[2].image_src, facts[2].blob], ['legacy', 'legacy', 'jikan', 1]);
  assert.equal(facts[3].aired_src, 'legacy');
  // Running it again is a no-op (the table is gone; the view stays).
  applySchema(conn, 'all');
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM episode_watch').get().n, FIXTURE.length);
  conn.close();
});

test('hosted: two account files merge their facts into one catalog, watched state stays in each file', () => {
  const catalog = new Database(path.join(dir, 'catalog.db'));
  applySchema(catalog, 'catalog');
  const a = oldFile('a.db', [{ mal: 5, n: 1, title: 'Episode 1', watched: 1, at: '2026-02-01T00:00:00Z' }, { mal: 5, n: 2, title: 'Second' }], 'account');
  const b = oldFile('b.db', [{ mal: 5, n: 1, title: 'First', url: 'https://www.crunchyroll.com/watch/G5/y' }, { mal: 5, n: 2, title: 'Other Second', watched: 1, at: '2026-03-01T00:00:00Z' }], 'account');
  for (const conn of [a, b]) {
    applySchema(conn, 'account', { catalog });
    conn.prepare('ATTACH DATABASE ? AS catalog').run(path.join(dir, 'catalog.db'));
    installEpisodeView(conn, 'account');
  }
  assert.deepEqual(catalog.prepare('SELECT episode_number n, title FROM catalog_episodes WHERE mal_id = 5 ORDER BY 1').all(),
    [{ n: 1, title: 'First' }, { n: 2, title: 'Second' }], 'one record per episode; the first real title stays');
  const watched = (conn) => conn.prepare('SELECT episode_number n FROM episode_sync WHERE watched = 1').all().map((r) => r.n);
  assert.deepEqual([watched(a), watched(b)], [[1], [2]]);
  assert.equal(a.prepare("SELECT COUNT(*) n FROM main.sqlite_master WHERE name = 'catalog_episodes'").get().n, 0, 'no facts in the account file');
  for (const conn of [a, b, catalog]) conn.close();
});
