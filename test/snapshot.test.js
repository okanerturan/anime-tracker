'use strict';
// Nightly snapshots and restore (8.2, 8.3) against an in-memory S3. Own process, throwaway data dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
Object.assign(process.env, {
  AUTH_MODE: 'accounts', DATA_DIR: tmp, R2_ENDPOINT: 'https://fake-s3.test', R2_BACKUP_ACCESS_KEY_ID: 'k', R2_BACKUP_SECRET_ACCESS_KEY: 's'
});
const { fakeS3 } = require('./fake-s3');
const s3 = fakeS3().install();
const { withAccount, db, catalog } = require('../server/db');
const store = require('../server/accounts/store');
const snapshot = require('../server/catalog/snapshot');
const { restore, counts } = require('../scripts/restore');

const DAY = 86400e3;
const t0 = Date.parse('2026-10-01T03:00:00Z');
const bump = (ms = 5) => new Promise((r) => setTimeout(r, ms)); // let file times move on
const keys = () => s3.keys('hub-backups');

test.after(() => { s3.uninstall(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('snapshots: full first run, nothing twice, only what changed, copies carried past 30 days, restore matches', async () => {
  store.adb();
  catalog.prepare("INSERT OR REPLACE INTO media (mal_id, title) VALUES (1, 'Catalog Show')").run();
  for (const id of ['1', '2']) withAccount(id, () => {
    db.prepare("INSERT OR REPLACE INTO anime (mal_id, title) VALUES (1, 'Catalog Show')").run();
    db.prepare('INSERT OR IGNORE INTO watchlist (mal_id) VALUES (1)').run();
    db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, watched) VALUES (1, 1, 1)').run();
  });

  const first = await snapshot.run({ now: t0 });
  assert.deepEqual(first.uploaded.sort(), ['accounts.db', 'accounts/1.db', 'accounts/2.db', 'catalog.db']);
  assert.ok(keys().includes('anime-tracker/2026-10-01/manifest.json'), "the day's prefix exists");
  assert.equal(s3.calls.unsigned, 0, 'every request signed');
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'last-snapshot.json'))).lastSuccessAt.startsWith('2026-10-01'), 'success time recorded for hub-check');

  const again = await snapshot.run({ now: t0 + 3600e3 });
  assert.deepEqual(again.uploaded, [], 'same night, nothing changed: nothing uploaded');

  await bump();
  withAccount('1', () => db.prepare('INSERT OR REPLACE INTO episode_sync (mal_id, episode_number, watched) VALUES (1, 2, 1)').run());
  const third = await snapshot.run({ now: t0 + 2 * 3600e3 });
  assert.deepEqual(third.uploaded, ['accounts/1.db'], 'only the changed account');

  fs.writeFileSync(path.join(tmp, 'snapshot.lock'), JSON.stringify({ holder: 'other-container', at: t0 + 3500e3 }));
  assert.deepEqual((await snapshot.run({ now: t0 + 3600e3 })), { skipped: 'lease' }, 'a run in progress elsewhere blocks this one');
  assert.ok((await snapshot.run({ now: t0 + 3500e3 + 3 * 3600e3 })).uploaded, 'a lock left by a crashed run expires after 2 hours');

  // A month on: account 2 never changed, so its only copy is in the 2026-10-01 day, which expires.
  const later = await snapshot.run({ now: t0 + 31 * DAY });
  assert.ok(later.carried >= 1, 'still-needed copies carried forward');
  assert.ok(later.deleted >= 1, 'the old day deleted');
  assert.ok(!keys().some((k) => k.startsWith('anime-tracker/2026-10-01/')), 'nothing older than 30 days left');

  const out = path.join(tmp, 'restore-drill');
  const r = await restore({ to: out, day: '2026-11-01', accounts: ['2'] });
  assert.equal(r.day, '2026-11-01');
  const live = counts(db.fileOf('2'), 'account');
  assert.deepEqual(r.files['accounts/2.db'], live, 'the restored account matches the live one');
  assert.deepEqual(live, { watchlist: 1, episode_watch: 1, cr_history: 0 }, 'real rows compared, not two empty files');
  const r1 = await restore({ to: path.join(tmp, 'drill-2'), day: '2026-11-01', accounts: ['1'] });
  assert.equal(r1.files['accounts/1.db'].episode_watch, 2, "account 1's later change is in its restore");
  assert.equal(r.files['catalog.db'].media, 1);
  assert.ok(!fs.existsSync(path.join(out, 'accounts', '1.db')), 'only the asked-for account');
  await assert.rejects(restore({ to: out, day: '2026-09-01' }), /No snapshot on or before/);
});
