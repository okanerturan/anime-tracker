'use strict';
// The Node passphrase gate on a running server (the hub before accounts), with the origin lock.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PASS = 'correct horse battery';
const PORT = 8300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passgate-'));
let child;

test.before(async () => {
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, AUTH_MODE: 'passphrase', APP_PASSPHRASE: PASS, ORIGIN_SECRET: 'origin-s', NO_SYNC: '1', PORT: String(PORT), ANIME_DB: path.join(tmp, 'a.db'), DATA_DIR: tmp } });
  for (let i = 0; i < 50; i += 1) { try { await fetch(`${BASE}/up`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
test.after(() => { child?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const go = (p, opts = {}) => fetch(`${BASE}${p}`, { redirect: 'manual', ...opts, headers: { 'X-Origin-Auth': 'origin-s', ...(opts.headers || {}) } });

test('passphrase gate: same rules and same cookie as the Cloudflare build, behind the origin lock', async () => {
  assert.equal((await fetch(`${BASE}/api/up-next`)).status, 403, 'no origin secret: refused before anything else');
  assert.equal((await fetch(`${BASE}/up`)).status, 200, 'the health check needs nothing');
  assert.equal((await go('/api/up-next')).status, 401, 'API without the passphrase');
  assert.equal((await go('/')).headers.get('location'), '/login', 'pages send you to the login');
  assert.equal((await go('/login')).status, 200);
  const wrong = await go('/login', { method: 'POST', body: new URLSearchParams({ key: 'nope' }) });
  assert.equal(wrong.status, 401);
  const ok = await go('/login?next=%23%2Flibrary', { method: 'POST', body: new URLSearchParams({ key: PASS }) });
  assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/#/library');
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  // The Cloudflare build's token (Web Crypto HMAC), so sessions survive the move.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const cf = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('anime-tracker-session-v1')))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(cookie, `at_session=${cf}`, 'identical to the Cloudflare cookie');
  assert.equal((await go('/api/up-next', { headers: { Cookie: cookie } })).status, 200, 'cookie works');
  assert.equal((await go('/api/up-next', { headers: { Authorization: `Bearer ${PASS}` } })).status, 200, 'bearer works (extension)');
  const pre = await go('/api/crunchyroll/status', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
  assert.equal((await go('/calendar/' + '0'.repeat(48) + '.ics')).status, 404, 'calendar feed reaches the tracker, which checks the token');
});
