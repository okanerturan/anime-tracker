'use strict';
// Limits on guessing the passphrase: the counting rules with a clock we control (server/guesses.js),
// then the real server as the hub runs it (passphrase mode, no origin lock, behind a proxy that puts
// the caller's address in X-Forwarded-For).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const guesses = require('../server/guesses');

const MIN = 60e3;

test('counting: distinct wrong values, per address, for 15 minutes; a repeated wrong value is one guess', () => {
  guesses.reset();
  const t0 = Date.parse('2026-11-25T12:00:00Z');
  // An extension with an old key, or a tab with an old cookie, sends the same wrong value all day.
  for (let i = 0; i < 500; i += 1) guesses.wrong('1.1.1.1', 'an old key', t0 + i * 1000);
  assert.equal(guesses.blocked('1.1.1.1', t0 + 500e3), 0);

  for (let i = 0; i < guesses.PER_ADDRESS - 1; i += 1) guesses.wrong('2.2.2.2', `guess ${i}`, t0 + i * 1000);
  assert.equal(guesses.blocked('2.2.2.2', t0 + 10e3), 0, 'one short of the limit');
  guesses.wrong('2.2.2.2', 'one more', t0 + 10e3);
  const wait = guesses.blocked('2.2.2.2', t0 + 10e3);
  assert.equal(wait, 15 * 60 - 10, 'until the oldest guess is 15 minutes old');
  assert.equal(guesses.retryText(wait), 'Try again in 15 minutes.');
  assert.equal(guesses.retryText(40), 'Try again in 1 minute.');
  assert.equal(guesses.blocked('3.3.3.3', t0 + 10e3), 0, 'another address is not affected');
  assert.equal(guesses.blocked('2.2.2.2', t0 + 15 * MIN + 1), 0, 'the oldest guess aged out: one more try');
  guesses.wrong('2.2.2.2', 'and again', t0 + 15 * MIN + 1);
  assert.ok(guesses.blocked('2.2.2.2', t0 + 15 * MIN + 2) > 0, 'which uses it up again');
  assert.equal(guesses.blocked('2.2.2.2', t0 + 31 * MIN), 0, 'all forgotten after a quiet 15 minutes');
});

test('counting: signing in doesn\'t wipe an address\'s wrong guesses, and every address that never signed in shares one allowance', () => {
  guesses.reset();
  const t0 = Date.parse('2026-11-25T12:00:00Z');
  // Someone else behind your address must not get a clean slate each time your browser loads a page.
  for (let i = 0; i < guesses.PER_ADDRESS; i += 1) guesses.wrong('9.9.9.9', `guess ${i}`, t0);
  guesses.right('9.9.9.9', t0 + 1);
  assert.ok(guesses.blocked('9.9.9.9', t0 + 2) > 0);

  // A guesser spread over many addresses: 9 guesses each stays under every per-address limit.
  guesses.reset();
  guesses.right('5.5.5.5', t0); // your own address, signed in earlier
  let made = 0;
  for (let a = 0; made < guesses.FROM_STRANGERS; a += 1) {
    for (let i = 0; i < 9 && made < guesses.FROM_STRANGERS; i += 1, made += 1) {
      assert.equal(guesses.blocked(`20.0.0.${a}`, t0 + made), 0);
      guesses.wrong(`20.0.0.${a}`, `guess ${a}-${i}`, t0 + made);
    }
  }
  assert.ok(guesses.blocked('20.0.9.9', t0 + 1000) > 0, 'a brand-new address is refused: the strangers\' allowance is spent');
  assert.equal(guesses.blocked('5.5.5.5', t0 + 1000), 0, 'an address that has signed in is no stranger');
  guesses.wrong('5.5.5.5', 'my typo', t0 + 1000);
  assert.ok(guesses.blocked('20.0.9.9', t0 + 14 * MIN) > 0, 'and its own typos don\'t count against strangers either way');
  assert.equal(guesses.blocked('20.0.9.9', t0 + 15 * MIN + 100), 0, 'strangers get tries back as guesses age out');
});

test('whose address: the proxy\'s X-Forwarded-For entry when the peer is a proxy, the peer itself otherwise', () => {
  const req = (peer, headers = {}, originTrusted = false) => ({ socket: { remoteAddress: peer }, headers, originTrusted });
  assert.equal(guesses.clientIp(req('172.19.0.3', { 'x-forwarded-for': '81.2.3.4' })), '81.2.3.4', 'kamal-proxy on the docker network');
  assert.equal(guesses.clientIp(req('::ffff:172.19.0.3', { 'x-forwarded-for': '9.9.9.9, 81.2.3.4' })), '81.2.3.4', 'the last entry is the one our proxy wrote');
  assert.equal(guesses.clientIp(req('203.0.113.7', { 'x-forwarded-for': '1.2.3.4' })), '203.0.113.7', 'reached directly: a header anyone can send is ignored');
  assert.equal(guesses.clientIp(req('127.0.0.1')), '127.0.0.1');
  assert.equal(guesses.clientIp(req('172.19.0.3', { 'x-client-ip': '8.8.8.8', 'x-forwarded-for': '81.2.3.4' })), '81.2.3.4', 'X-Client-IP means nothing without the origin lock');
  assert.equal(guesses.clientIp(req('172.19.0.3', { 'x-client-ip': '8.8.8.8', 'x-forwarded-for': '104.16.0.1' }, true)), '8.8.8.8', 'with it, the front Worker\'s word is taken');
});

// ---- The real server, started the way the hub runs it. ----
const PASS = 'correct horse battery';
const PORT = 8800 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guesses-'));
let child;
test.before(async () => {
  const env = { ...process.env, AUTH_MODE: 'passphrase', APP_PASSPHRASE: PASS, NO_SYNC: '1', PORT: String(PORT), ANIME_DB: path.join(tmp, 'a.db'), DATA_DIR: tmp };
  delete env.ORIGIN_SECRET; delete env.ORIGIN_SECRET_PREVIOUS;
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env });
  for (let i = 0; i < 50; i += 1) { try { await fetch(`${BASE}/up`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => { child?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A request as it reaches the app behind the proxy: `from` is the caller's address. */
const ask = (from, { key = null, cookie = null, path: p = '/api/stats', ...opts } = {}) => fetch(`${BASE}${p}`, { redirect: 'manual', ...opts,
  headers: { 'X-Forwarded-For': from, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
const login = (from, key) => ask(from, { path: '/login', method: 'POST', body: new URLSearchParams({ key }) });

test('on the server: ten different wrong keys lock an address out, even with the right key; other addresses and signed-in browsers carry on', async () => {
  const signedIn = (await login('81.0.0.1', PASS)).headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 10; i += 1) assert.equal((await ask('81.0.0.1', { key: `wrong ${i}` })).status, 401, `guess ${i}`);
  const refused = await ask('81.0.0.1', { key: 'wrong again' });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 14 * 60);
  assert.match((await refused.json()).error, /^Too many wrong passphrases from your network\. Try again in 15 minutes\.$/);
  assert.equal((await ask('81.0.0.1', { key: PASS })).status, 429, 'the right key isn\'t looked at either: that is what stops guessing');
  const page = await login('81.0.0.1', PASS);
  assert.equal(page.status, 429);
  assert.match(await page.text(), /Too many wrong passphrases/);
  assert.equal((await ask('81.0.0.1', { cookie: signedIn })).status, 200, 'a browser that is already signed in is never locked out');
  assert.equal((await ask('81.0.0.2', { key: PASS })).status, 200, 'another address is not affected');
  assert.equal((await ask('81.0.0.1')).status, 401, 'no key at all is not a guess: the plain answer');
  // The extension's requests carry an Origin: the refusal must be readable by it.
  const ext = await ask('81.0.0.1', { key: 'wrong again', headers: { Origin: 'chrome-extension://abc' } });
  assert.equal(ext.status, 429);
  assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
});

test('on the server: the same wrong key or cookie, however often, never locks anyone; a wrong cookie is cleared', async () => {
  for (let i = 0; i < 40; i += 1) assert.equal((await ask('82.0.0.1', { key: 'an old key' })).status, 401);
  assert.equal((await ask('82.0.0.1', { key: PASS })).status, 200, 'the extension with an old key, then the right one');

  const stale = 'at_session=' + 'a'.repeat(64);
  for (let i = 0; i < 40; i += 1) {
    const r = await ask('82.0.0.2', { cookie: stale });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('set-cookie'), /^at_session=; .*Max-Age=0/, 'the browser is told to drop it');
  }
  const home = await ask('82.0.0.2', { cookie: stale, path: '/' });
  assert.equal(home.status, 303); assert.equal(home.headers.get('location'), '/login');
  assert.match(home.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await login('82.0.0.2', PASS)).status, 303, 'and signing in again works');
});

test('on the server: wrong passphrases in the login form and made-up cookies count like wrong keys', async () => {
  assert.equal((await login('83.0.0.1', 'nope 1')).status, 401);
  assert.equal((await login('83.0.0.1', 'nope 2')).status, 401);
  for (let i = 0; i < 4; i += 1) assert.equal((await ask('83.0.0.1', { key: `wrong ${i}` })).status, 401);
  for (let i = 0; i < 4; i += 1) assert.equal((await ask('83.0.0.1', { cookie: `at_session=${String(i).repeat(64)}` })).status, 401);
  assert.equal((await login('83.0.0.1', PASS)).status, 429, 'two form tries, four keys and four cookies: ten guesses');
});

test('on the server: a guesser spread over many addresses uses up one shared allowance; addresses that have signed in are not held up by it', async () => {
  assert.equal((await ask('84.0.0.1', { key: PASS })).status, 200); // you, earlier today
  let refusedAt = null;
  for (let n = 0; n < 200 && refusedAt === null; n += 1) {
    const r = await ask(`90.0.${Math.floor(n / 5)}.${n % 5}`, { key: `spread ${n}` }); // five guesses per address
    if (r.status === 429) refusedAt = n; else assert.equal(r.status, 401);
  }
  assert.ok(refusedAt !== null && refusedAt <= 60, `strangers were cut off (after ${refusedAt} more guesses)`);
  assert.equal((await ask('91.0.0.1', { key: PASS })).status, 429, 'a new address can\'t try a passphrase while the guessing goes on');
  assert.equal((await ask('84.0.0.1', { key: PASS })).status, 200, 'yours still can');
  assert.equal((await ask('91.0.0.1', { path: '/login' })).status, 200, 'the login page itself still shows');
});
