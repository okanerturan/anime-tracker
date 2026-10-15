'use strict';
// AUTH_MODE=accounts: each account's statements go to its own file. node --test runs every test
// file in its own process, so these settings don't leak into the single-user tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-facade-'));
process.env.AUTH_MODE = 'accounts';
process.env.DATA_DIR = tmp;
process.env.ACCOUNTS_DIR = path.join(tmp, 'accounts');
process.env.DB_MAX_OPEN = '3';

const test = require('node:test');
const assert = require('node:assert');
const { db, withAccount } = require('../server/db');

const add = db.prepare("INSERT INTO anime (mal_id, title) VALUES (?, ?)");
const titles = db.prepare('SELECT title FROM anime ORDER BY mal_id');
const tick = () => new Promise((r) => setImmediate(r));

test('two accounts interleaving never see each other\'s rows', async () => {
  await Promise.all([
    withAccount('1', async () => { add.run(1, 'Only in one'); await tick(); add.run(2, 'Also in one'); }),
    withAccount('2', async () => { await tick(); add.run(1, 'Only in two'); })
  ]);
  const one = await withAccount('1', async () => { await tick(); return titles.all().map((r) => r.title); });
  const two = withAccount('2', () => titles.all().map((r) => r.title));
  assert.deepEqual(one, ['Only in one', 'Also in one']);
  assert.deepEqual(two, ['Only in two']);
  assert.ok(fs.existsSync(path.join(tmp, 'accounts', '1.db')) && fs.existsSync(path.join(tmp, 'accounts', '2.db')));
});

test('a transaction runs on the caller\'s file and rolls back there', () => {
  const both = db.transaction((rows) => { for (const [id, t] of rows) add.run(id, t); });
  withAccount('3', () => both([[10, 'a'], [11, 'b']]));
  assert.throws(() => withAccount('3', () => both([[12, 'c'], [10, 'duplicate id']])));
  assert.deepEqual(withAccount('3', () => titles.all().map((r) => r.title)), ['a', 'b'], 'the failed batch left nothing behind');
  assert.deepEqual(withAccount('2', () => titles.all().map((r) => r.title)), ['Only in two'], 'other accounts untouched');
});

test('past DB_MAX_OPEN the least recently used file is closed, and reopens on use', () => {
  for (const id of ['4', '5', '6']) withAccount(id, () => titles.all());
  assert.equal(db.openCount(), 3);
  // Account 1 was the least recently used and got closed; using it again just reopens it.
  assert.deepEqual(withAccount('1', () => titles.all().map((r) => r.title)), ['Only in one', 'Also in one']);
  assert.equal(db.openCount(), 3);
});

test('no account in context, or an id that is not a plain id, is refused', () => {
  assert.throws(() => titles.all(), /outside an account/);
  assert.throws(() => withAccount('../escape', () => titles.all()), /invalid account id/);
});

test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('accounts read the shared catalog through the attachment, and never write it', () => {
  const { catalogDb } = require('../server/db');
  catalogDb.prepare('INSERT OR REPLACE INTO media (mal_id, title, status) VALUES (?, ?, ?)').run(700, 'Shared Show', 'FINISHED');
  const tables = withAccount('7', () => db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  assert.ok(tables.includes('watchlist') && !tables.includes('media'), 'the account file has no catalog tables');
  withAccount('7', () => {
    db.prepare('INSERT INTO anime (mal_id, title) VALUES (?, ?)').run(700, 'Mine');
    db.prepare('INSERT INTO watchlist (mal_id) VALUES (?)').run(700);
  });
  const joined = withAccount('7', () => db.prepare('SELECT m.title FROM watchlist w JOIN media m ON m.mal_id = w.mal_id').get());
  assert.equal(joined.title, 'Shared Show', 'unqualified media resolves to the catalog');
  assert.throws(() => withAccount('7', () => db.prepare('UPDATE media SET title = ? WHERE mal_id = ?').run('x', 700)), /catalog worker/);
  assert.throws(() => withAccount('7', () => db.prepare('INSERT OR REPLACE INTO catalog.media_rec (mal_id, rec_mal_id, rating) VALUES (1, 2, 3)').run()), /catalog worker/);
});

test('an AniList answer lands in the shared catalog, and the synopsis in the account that asked', () => {
  const anilist = require('../server/sources/anilist');
  const { catalogDb } = require('../server/db');
  withAccount('8', () => db.prepare('INSERT INTO anime (mal_id, title) VALUES (?, ?)').run(800, 'Asked For'));
  const media = { idMal: 800, id: 9800, title: { romaji: 'Asked For', english: 'Asked For' }, format: 'TV', status: 'FINISHED', episodes: 12,
    description: 'A <b>shared</b> synopsis.', genres: ['Action'], tags: [], externalLinks: [], relations: { edges: [] }, recommendations: { nodes: [] }, coverImage: {} };
  withAccount('8', () => anilist.applyRelayAnswers([{ id: 'full:800', data: { Page: { media: [media] } } }]));
  assert.equal(catalogDb.prepare('SELECT title FROM media WHERE mal_id = 800').get()?.title, 'Asked For', 'catalog row written');
  assert.equal(withAccount('8', () => db.prepare('SELECT synopsis FROM anime WHERE mal_id = 800').get().synopsis), 'A shared synopsis.');
  assert.equal(withAccount('7', () => db.prepare('SELECT title FROM media WHERE mal_id = 800').get()?.title), 'Asked For', 'every account sees it');
});
