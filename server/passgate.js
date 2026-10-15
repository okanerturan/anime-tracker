'use strict';
// Passphrase gate for the Node server when it is reachable from outside (the hub, migration steps
// 3 and 4, AUTH_MODE=passphrase with APP_PASSPHRASE set). The same rules as the Cloudflare entry
// (worker/index.js): a session cookie for the browser, "Authorization: Bearer <passphrase>" for the
// extension and scripts, the calendar feed by its secret path. Same cookie name and token, so a
// browser signed in on the Cloudflare build stays signed in when its requests move to the hub.
const crypto = require('crypto');

const COOKIE = 'at_session';
const enabled = () => Boolean(process.env.APP_PASSPHRASE);
const passphrase = () => process.env.APP_PASSPHRASE;
const sessionToken = (p) => crypto.createHmac('sha256', p).update('anime-tracker-session-v1').digest('hex');

/** Constant-time comparison through fixed-length digests. */
function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(res, error = '', next = '') {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>Anime Tracker</title>
<style>
:root { color-scheme: dark; --bg: oklch(0.165 0.012 265); --surface: oklch(0.205 0.014 265); --line: oklch(0.31 0.018 265); --text: oklch(0.94 0.006 265); --accent: oklch(0.7 0.18 47); }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; padding: 1rem; }
form { display: flex; flex-direction: column; gap: 0.875rem; inline-size: min(100%, 22rem); padding: 1.5rem; border: 1px solid var(--line); border-radius: 1rem; background: var(--surface); }
h1 { margin: 0; font-size: 1.25rem; display: flex; align-items: center; gap: 0.5rem; }
h1::before { content: ""; inline-size: 0.75rem; block-size: 0.75rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0.75rem var(--accent); }
input { font-size: max(16px, 1rem); padding: 0.7em 0.8em; border-radius: 0.6rem; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
button { font: inherit; font-weight: 700; padding: 0.75em; border: 0; border-radius: 0.6rem; background: var(--accent); color: oklch(0.2 0.02 47); cursor: pointer; }
button:active { transform: scale(0.97); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.err { color: oklch(0.72 0.17 25); margin: 0; font-size: 0.9rem; }
</style></head><body>
<form method="post" action="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">
  <h1>Anime Tracker</h1>
  <label for="key">Passphrase</label>
  <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
  ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
  <button type="submit">Unlock</button>
</form></body></html>`;
  res.writeHead(error ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function readForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

/** The extension calls from a chrome-extension:// origin: allow it (it still needs the bearer key). */
function cors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin.startsWith('chrome-extension://')) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Tracker-Client, X-Extension-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  return true;
}

/** Answers the request itself (login, logout, refusal) and returns true, or returns false to let it through. */
async function handle(req, res, url) {
  const p = passphrase();
  if (cors(req, res) && req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      const form = await readForm(req);
      if (safeEqual(form.get('key') || '', p)) {
        const next = String(url.searchParams.get('next') || '');
        res.writeHead(303, {
          Location: `/${/^#\/[a-z-]+(\?[\w=&-]*)?$/.test(next) ? next : ''}`,
          'Set-Cookie': `${COOKIE}=${sessionToken(p)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
        });
        res.end(); return true;
      }
      await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
      loginPage(res, 'That passphrase is not right.', url.searchParams.get('next') || ''); return true;
    }
    loginPage(res, '', url.searchParams.get('next') || ''); return true;
  }
  if (url.pathname === '/logout') {
    res.writeHead(303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    res.end(); return true;
  }
  // The calendar feed: calendar apps can't send the cookie; the tracker checks the secret path.
  if (req.method === 'GET' && /^\/calendar\/[a-f0-9]{48}\.ics$/.test(url.pathname)) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const authed = (bearer && safeEqual(bearer, p)) || safeEqual(cookie(req, COOKIE) || '', sessionToken(p));
  if (authed) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/')) {
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true;
  }
  res.writeHead(303, { Location: '/login' }); res.end(); return true;
}

module.exports = { enabled, handle, sessionToken };
