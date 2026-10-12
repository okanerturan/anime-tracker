'use strict';
// Cloudflare entry: passphrase gate, static assets, API/images forwarded to the tracker Durable Object,
// and a cron trigger for the background metadata refresh.

const COOKIE = 'at_session';
const enc = new TextEncoder();

async function sessionToken(passphrase) {
  const key = await crypto.subtle.importKey('raw', enc.encode(passphrase), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('anime-tracker-session-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (via fixed-length digests). */
async function safeEqual(a, b) {
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(da); const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function cookieValue(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function loginPage(error = '') {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>Anime Tracker</title>
<style>
:root { color-scheme: dark; --bg: oklch(0.165 0.012 265); --surface: oklch(0.205 0.014 265); --line: oklch(0.31 0.018 265); --text: oklch(0.94 0.006 265); --muted: oklch(0.72 0.018 265); --accent: oklch(0.7 0.18 47); }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; padding: 1rem; }
form { display: flex; flex-direction: column; gap: 0.875rem; inline-size: min(100%, 22rem); padding: 1.5rem; border: 1px solid var(--line); border-radius: 1rem; background: var(--surface); }
h1 { margin: 0; font-size: 1.25rem; display: flex; align-items: center; gap: 0.5rem; }
h1::before { content: ""; inline-size: 0.75rem; block-size: 0.75rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0.75rem var(--accent); }
input { font-size: max(16px, 1rem); padding: 0.7em 0.8em; border-radius: 0.6rem; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
button { font: inherit; font-weight: 700; padding: 0.75em; border: 0; border-radius: 0.6rem; background: var(--accent); color: white; cursor: pointer; }
button:active { transform: scale(0.97); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.err { color: oklch(0.72 0.17 25); margin: 0; font-size: 0.9rem; }
</style></head><body>
<form method="post" action="/login">
  <h1>Anime Tracker</h1>
  <label for="key">Passphrase</label>
  <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
  ${error ? `<p class="err" role="alert">${error}</p>` : ''}
  <button type="submit">Unlock</button>
</form></body></html>`;
  return new Response(html, { status: error ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function tracker(env) {
  return env.TRACKER.get(env.TRACKER.idFromName('main'));
}

// The sync extension calls the API from a chrome-extension:// origin. Allow that cross-origin call;
// it still has to carry the passphrase as a bearer key.
function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin.startsWith('chrome-extension://')) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Tracker-Client',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function withCors(response, cors) {
  if (!cors) return response;
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

module.exports = {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (cors && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    return withCors(await handle(request, env), cors);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tracker(env).fetch('https://tracker.internal/internal/cycle', { method: 'POST' }));
  }
};

async function handle(request, env) {
    const url = new URL(request.url);
    const passphrase = env.APP_PASSPHRASE;
    if (!passphrase) return new Response('APP_PASSPHRASE secret is not set', { status: 500 });

    if (url.pathname === '/login') {
      if (request.method === 'POST') {
        const form = await request.formData();
        if (await safeEqual(String(form.get('key') || ''), passphrase)) {
          const token = await sessionToken(passphrase);
          return new Response(null, { status: 303, headers: {
            Location: '/',
            'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
          } });
        }
        await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
        return loginPage('That passphrase is not right.');
      }
      return loginPage();
    }
    if (url.pathname === '/logout') {
      return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
    }

    // The browser uses the session cookie; the extension and migration scripts send "Authorization: Bearer <passphrase>".
    const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const viaBearer = bearer ? await safeEqual(bearer, passphrase) : false;
    const viaCookie = await safeEqual(cookieValue(request, COOKIE) || '', await sessionToken(passphrase));
    const authed = viaBearer || viaCookie;

    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/');
    if (url.pathname.startsWith('/internal/')) {
      if (!viaBearer) return new Response('Forbidden', { status: 403 });
      return tracker(env).fetch(request);
    }
    if (!authed) {
      if (isApi) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.redirect(new URL('/login', url).toString(), 303);
    }
    if (isApi) return tracker(env).fetch(request);
    return env.ASSETS.fetch(request);
}
