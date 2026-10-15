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
