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

test('invites: each SIGNUP mode, single use, expiry and withdrawal', () => {
  const switches = require('../server/accounts/switches');
  const invites = require('../server/accounts/invites');
  const t0 = Date.parse('2026-02-01T00:00:00Z');
  switches.set('SIGNUP', 'closed');
  const code = invites.create({ now: t0 });
  assert.throws(() => invites.check(code, { now: t0 }), /closed/);
  switches.set('SIGNUP', 'invite');
  assert.throws(() => invites.check(null), /need an invite/);
  assert.throws(() => invites.check('made-up'), /isn.t valid/);
  assert.ok(invites.check(code, { now: t0 }));
  // A cancelled passkey prompt never spends it: still usable.
  assert.ok(invites.check(code, { now: t0 + 1000 }));
  invites.spend(code, newAccount('Invitee'));
  assert.throws(() => invites.check(code, { now: t0 }), /already been used/);
  const short = invites.create({ days: 1, now: t0 });
  assert.throws(() => invites.check(short, { now: t0 + 2 * DAY }), /expired/);
  const pulled = invites.create({ now: t0 }); invites.revoke(pulled);
  assert.throws(() => invites.check(pulled, { now: t0 }), /withdrawn/);
  switches.set('SIGNUP', 'open');
  assert.equal(invites.check(null), null, 'open signup needs no invite');
  switches.set('SIGNUP', 'invite');
  assert.throws(() => switches.set('SIGNUP', 'sometimes'), /must be one of/);
});

test('recovery codes: ten, one-time, hashed, and a new set cancels the old', () => {
  const recovery = require('../server/accounts/recovery');
  const id = newAccount('Recoverer');
  const codes = recovery.regenerate(id);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
  assert.equal(store.adb().prepare('SELECT COUNT(*) n FROM recovery_codes WHERE code_hash = ?').get(codes[0]).n, 0, 'not stored raw');
  assert.equal(recovery.use(codes[0].toUpperCase().replace('-', ' ')), id, 'case and separators don\'t matter');
  assert.equal(recovery.use(codes[0]), null, 'used once only');
  assert.equal(recovery.remaining(id), 9);
  const fresh = recovery.regenerate(id);
  assert.equal(recovery.use(codes[1]), null, 'the old set stopped working');
  assert.equal(recovery.use(fresh[0]), id);
});

test('rate limits: past the limit an attempt is refused with a Retry-After', () => {
  const limits = require('../server/accounts/limits');
  limits.reset();
  const t0 = Date.parse('2026-03-01T00:00:00Z');
  for (let i = 0; i < 10; i += 1) assert.ok(limits.hit('recover', '1.2.3.4', t0 + i).ok);
  const blocked = limits.hit('recover', '1.2.3.4', t0 + 20);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter > 3500 && blocked.retryAfter <= 3600);
  assert.ok(limits.hit('recover', '5.6.7.8', t0 + 20).ok, 'other addresses are not affected');
  assert.ok(limits.hit('recover', '1.2.3.4', t0 + 61 * 60e3).ok, 'the window slides');
  // X-Client-IP counts only when the origin secret was checked.
  assert.equal(limits.clientIp({ headers: { 'x-client-ip': '9.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(limits.clientIp({ originTrusted: true, headers: { 'x-client-ip': '9.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } }), '9.9.9.9');
});

test('log lines carry no tokens, cookies or codes', () => {
  const log = require('../server/accounts/log');
  const req = { method: 'GET', url: '/calendar/abcdef0123456789.ics?token=secret-value', headers: { cookie: 'tracker_session=sessionsecret', authorization: 'Bearer devicesecret' } };
  const res = { statusCode: 200 };
  const lineText = log.line(req, res, Date.now());
  for (const secret of ['abcdef0123456789', 'secret-value', 'sessionsecret', 'devicesecret']) assert.ok(!lineText.includes(secret), secret);
  assert.match(lineText, /^GET \/calendar\/\*\*\*\.ics 200 \d+ms$/);
});

test('quota: soft warns, hard allows only reads, auth and syncing new plays', () => {
  const quota = require('../server/accounts/quota');
  const file = path.join(tmp, 'padded.db');
  fs.writeFileSync(file, Buffer.alloc(3 * 1048576));
  process.env.QUOTA_SOFT_MB = '1'; process.env.QUOTA_HARD_MB = '2';
  assert.equal(quota.level(file), 'hard');
  assert.equal(quota.blocks('POST', '/api/episode/watched-through', 'hard'), true);
  assert.equal(quota.blocks('POST', '/api/crunchyroll/ingest', 'hard'), false, 'syncing new plays still works');
  assert.equal(quota.blocks('GET', '/api/up-next', 'hard'), false, 'reads still work');
  assert.equal(quota.blocks('POST', '/auth/account/delete', 'hard'), false, 'export and delete still work');
  quota.forget(file); process.env.QUOTA_HARD_MB = '10';
  assert.equal(quota.level(file), 'soft');
  delete process.env.QUOTA_SOFT_MB; delete process.env.QUOTA_HARD_MB; quota.forget(file);
  assert.equal(quota.level(file), 'ok');
});

test('cleanup: 24 months idle and passkey-less sign-ups older than a day are removed', () => {
  const cleanup = require('../server/accounts/cleanup');
  const now = Date.parse('2030-01-01T00:00:00Z');
  const a = store.adb();
  const idle = a.prepare("INSERT INTO accounts (display_name, created_at, last_active_at) VALUES ('Idle', '2027-01-01T00:00:00Z', '2027-06-01T00:00:00Z')").run().lastInsertRowid;
  const active = a.prepare("INSERT INTO accounts (display_name, created_at, last_active_at) VALUES ('Active', '2027-01-01T00:00:00Z', '2029-12-01T00:00:00Z')").run().lastInsertRowid;
  a.prepare("INSERT INTO passkeys (id, account_id, public_key) VALUES ('pk-active', ?, x'00')").run(active);
  const abandoned = a.prepare("INSERT INTO accounts (display_name, created_at) VALUES ('Never finished', '2029-12-30T00:00:00Z')").run().lastInsertRowid;
  const fresh = a.prepare("INSERT INTO accounts (display_name, created_at) VALUES ('Signing up now', '2029-12-31T23:00:00Z')").run().lastInsertRowid;
  withAccount(String(idle), () => db.prepare('SELECT 1').get());
  const r = cleanup.sweep({ now });
  const left = new Set(a.prepare('SELECT id FROM accounts').all().map((x) => x.id));
  assert.ok(!left.has(Number(idle)), 'idle account removed');
  assert.ok(!left.has(Number(abandoned)), 'abandoned sign-up removed');
  assert.ok(left.has(Number(active)) && left.has(Number(fresh)), 'active and in-progress accounts kept');
  assert.ok(!fs.existsSync(path.join(tmp, 'accounts', `${idle}.db`)), 'its data file is gone');
  assert.ok(r.inactive >= 1 && r.abandoned >= 1);
});

test('devices: hashed tokens, a 10-browser limit, pairing codes once within 10 minutes, revoke', () => {
  const devices = require('../server/accounts/devices');
  const id = newAccount('Device owner');
  const token = devices.mint(id, 'Chrome on Mac');
  assert.match(token, /^trk_/);
  assert.equal(store.adb().prepare('SELECT COUNT(*) n FROM device_tokens WHERE token_hash = ?').get(token).n, 0, 'only the hash is stored');
  for (let i = 0; i < 9; i += 1) devices.mint(id, `Browser ${i}`);
  assert.throws(() => devices.mint(id, 'Eleventh'), /Disconnect one first/);
  devices.revoke(id, devices.list(id)[0].id);
  assert.ok(devices.mint(id, 'Room again'));
  const t0 = Date.now();
  const code = devices.pairingCode(id, { now: t0 });
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  devices.revoke(id, devices.list(id)[0].id);
  assert.match(devices.redeem(code.toLowerCase(), 'Paired'), /^trk_/, 'case and dash don\'t matter');
  assert.throws(() => devices.redeem(code, 'Again'), /isn.t valid/, 'single use');
  const late = devices.pairingCode(id, { now: t0 - 11 * 60e3 });
  assert.throws(() => devices.redeem(late, 'Late'), /isn.t valid/, 'expires after 10 minutes');
});

test('origin lock: only the secret gets in (two values during rotation); /up is exempt; no secret, no lock', () => {
  const origin = require('../server/accounts/origin');
  const req = (h = {}, method = 'GET') => ({ method, headers: h });
  delete process.env.ORIGIN_SECRET; delete process.env.ORIGIN_SECRET_PREVIOUS;
  assert.deepEqual(origin.check(req(), '/api/up-next'), { ok: true, trusted: false }, 'local runs have no lock');
  process.env.ORIGIN_SECRET = 'new-secret-value'; process.env.ORIGIN_SECRET_PREVIOUS = 'old-secret-value';
  assert.equal(origin.check(req(), '/api/up-next').ok, false);
  assert.equal(origin.check(req({ 'x-origin-auth': 'guess' }), '/api/up-next').ok, false);
  assert.deepEqual(origin.check(req({ 'x-origin-auth': 'new-secret-value' }), '/api/up-next'), { ok: true, trusted: true });
  assert.equal(origin.check(req({ 'x-origin-auth': 'old-secret-value' }), '/').ok, true, 'the previous value still works during rotation');
  assert.equal(origin.check(req(), '/up').ok, true, 'health check exempt');
  assert.equal(origin.check(req({}, 'POST'), '/up').ok, false, 'only GET /up');
  delete process.env.ORIGIN_SECRET; delete process.env.ORIGIN_SECRET_PREVIOUS;
});

test.after(() => { store.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
