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

// Raw responses (fetch would decode them): status, headers and the bytes as sent.
const http = require('http');
const zlib = require('zlib');
const raw = (p, headers = {}, method = 'GET', body = null) => new Promise((resolve, reject) => {
  const req = http.request(`${BASE}${p}`, { method, headers: { 'X-Origin-Auth': 'origin-s', Authorization: `Bearer ${PASS}`, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end(body);
});

test('JSON and static text go out compressed when the client accepts it, the same bytes once decoded; small answers and clients that ask for nothing get them plain', async () => {
  for (let id = 1; id <= 12; id += 1) {
    const add = await raw('/api/watchlist/add', { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' }, 'POST', JSON.stringify({ anime: { malId: 9000 + id, title: `A Show With A Fairly Long Title, Season ${id}`, totalEpisodes: 12 } }));
    assert.equal(add.status, 200);
  }
  const plain = await raw('/api/watchlist');
  assert.equal(plain.headers['content-encoding'], undefined, 'nothing asked, nothing encoded (health checks, scripts)');
  assert.ok(plain.body.length > 1024 && JSON.parse(plain.body).length === 12);
  assert.match(plain.headers.vary, /Accept-Encoding/);

  const br = await raw('/api/watchlist', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(Number(br.headers['content-length']), br.body.length);
  assert.ok(br.body.length < plain.body.length / 2, 'actually smaller');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), plain.body);

  const gz = await raw('/api/watchlist', { 'Accept-Encoding': 'br;q=0, gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip', 'q=0 means "not this one"');
  assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);

  const small = await raw('/api/stats', { 'Accept-Encoding': 'br' });
  assert.equal(small.status, 200);
  assert.equal(small.headers['content-encoding'], undefined, 'a tiny answer is not worth encoding');

  // The extension's requests carry an Origin: the gate's "Vary: Origin" must survive.
  const ext = await raw('/api/watchlist', { 'Accept-Encoding': 'br', Origin: 'chrome-extension://abc' });
  assert.match(ext.headers.vary, /Origin/); assert.match(ext.headers.vary, /Accept-Encoding/);
  assert.equal(ext.headers['access-control-allow-origin'], 'chrome-extension://abc');

  // Errors keep working through the same path.
  assert.equal((await raw('/api/nope', { 'Accept-Encoding': 'br' })).status, 404);
});

test('static files: compressed, with an ETag, and a 304 with no body for a browser that already has the file', async () => {
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'));
  const plain = await raw('/styles.css');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, onDisk);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.match(plain.headers.etag, /^"[0-9a-f]{20}"$/);

  const br = await raw('/styles.css', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.deepEqual(zlib.brotliDecompressSync(br.body), onDisk);
  assert.ok(br.body.length < onDisk.length / 3);
  assert.notEqual(br.headers.etag, plain.headers.etag, 'different bytes, different ETag');
  const gz = await raw('/styles.css', { 'Accept-Encoding': 'gzip' });
  assert.deepEqual(zlib.gunzipSync(gz.body), onDisk);

  for (const tag of [plain.headers.etag, br.headers.etag, `W/${gz.headers.etag}`, `"zzz", ${br.headers.etag}`]) {
    const again = await raw('/styles.css', { 'Accept-Encoding': 'gzip, br', 'If-None-Match': tag });
    assert.equal(again.status, 304, tag);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers.etag, br.headers.etag);
  }
  assert.equal((await raw('/styles.css', { 'If-None-Match': '"0000"' })).status, 200, 'an old copy gets the new file');
  assert.equal((await raw('/js/main.js', { 'Accept-Encoding': 'br' })).headers['content-encoding'], 'br');
  assert.equal((await raw('/favicon.svg', { 'Accept-Encoding': 'br' })).status, 200);
  assert.equal((await raw('/icons/nope.png')).status, 404);
  assert.equal((await raw('/js')).status, 404, 'a directory is not a file');
  assert.equal((await raw('/%E0%A4%A')).status, 400, 'a broken escape is refused, not a crash');
  assert.equal((await raw('/up')).body.toString(), 'ok');
});
