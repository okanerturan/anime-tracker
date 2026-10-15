'use strict';
// Hosted accounts layer (AUTH_MODE=accounts). Runs in its own process with a throwaway data dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-accounts-'));
process.env.AUTH_MODE = 'accounts';
process.env.DATA_DIR = tmp;
process.env.ACCOUNTS_DIR = path.join(tmp, 'accounts');

const test = require('node:test');
const assert = require('node:assert');
const { db, withAccount } = require('../server/db');
const store = require('../server/accounts/store');
const sessions = require('../server/accounts/sessions');

const newAccount = (name = 'Someone') => store.adb().prepare('INSERT INTO accounts (display_name) VALUES (?)').run(name).lastInsertRowid;
const DAY = 86400e3;

test('accounts.db holds sign-in data; an account data file holds none of it', () => {
  const t = store.adb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const name of ['accounts', 'sessions', 'passkeys', 'recovery_codes', 'device_tokens', 'invites', 'settings']) assert.ok(t.includes(name), name);
  const own = withAccount('1', () => db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const name of ['accounts', 'sessions', 'passkeys', 'recovery_codes', 'device_tokens', 'invites']) assert.ok(!own.includes(name), `${name} not in the data file`);
});

test('sessions: stored hashed, valid 180 days, rotated after 30, ended by sign out everywhere', () => {
  const id = newAccount();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const raw = sessions.create(id, { now: t0, userAgent: 'test' });
  assert.equal(store.adb().prepare('SELECT COUNT(*) n FROM sessions WHERE id_hash = ?').get(raw).n, 0, 'the raw value is not stored');
  assert.equal(sessions.resolve(raw, { now: t0 + DAY }).accountId, id);
  assert.equal(sessions.resolve(raw, { now: t0 + DAY }).rotated, null);
  // Used after 30 days: a new value replaces it, the old one stops working.
  const later = sessions.resolve(raw, { now: t0 + 31 * DAY });
  assert.equal(later.accountId, id);
  assert.ok(later.rotated && later.rotated !== raw);
  assert.equal(sessions.resolve(raw, { now: t0 + 31 * DAY }), null);
  // Expired.
  const old = sessions.create(id, { now: t0 });
  assert.equal(sessions.resolve(old, { now: t0 + 181 * DAY }), null);
  // Sign out everywhere ends all of them.
  const a = sessions.create(id, { now: t0 + 40 * DAY }); const b = sessions.create(id, { now: t0 + 40 * DAY });
  sessions.endAll(id);
  assert.equal(sessions.resolve(a, { now: t0 + 41 * DAY }), null);
  assert.equal(sessions.resolve(b, { now: t0 + 41 * DAY }), null);
  // A fresh session after that works again.
  assert.equal(sessions.resolve(sessions.create(id, { now: t0 + 42 * DAY }), { now: t0 + 42 * DAY }).accountId, id);
});

test('session cookie is HttpOnly, Secure, SameSite=Lax and parsed back from the header', () => {
  const c = sessions.cookie('abc');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=15552000']) assert.ok(c.includes(part), part);
  assert.ok(sessions.cookie(null).includes('Max-Age=0'));
  assert.equal(sessions.fromRequest({ headers: { cookie: `other=1; ${sessions.COOKIE}=xyz; more=2` } }), 'xyz');
});

test.after(() => { store.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
