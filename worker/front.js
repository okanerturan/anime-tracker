// Front Worker for the hosted tracker (D8, 8.8). It keeps the workers.dev address while the app runs
// on the hub: /img/* comes straight from R2 when the link is signed (8.13) and the image is there,
// everything else goes to the hub origin with the shared secret and the visitor's IP. When the hub
// has failed for a minute, visitors get a maintenance page instead of an error.
// Env: ORIGIN_URL, ORIGIN_SECRET, IMAGE_SIGNING_KEY (secrets), IMAGES (R2 binding).

const PERIOD_MS = 7 * 86400e3;
const FAIL_WINDOW_MS = 60e3;
let failingSince = 0; // per isolate: good enough to stop hammering a dead origin

const MAINTENANCE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anime Tracker</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:0 16px;background:Canvas;color:CanvasText}main{max-width:28rem}</style>
<main><h1>Back in a few minutes</h1><p>The tracker is being updated or restarted. Your history is safe, and the extension will sync again by itself.</p></main>`;

async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

/** True when `s` signs `hash` for this 7-day period or the previous one. */
export async function validSignature(hash, s, key, now = Date.now()) {
  if (!key || !s) return false;
  const p = Math.floor(now / PERIOD_MS);
  for (const q of [p, p - 1]) if ((await hmac(key, `${hash}.${q}`)) === s) return true;
  return false;
}

async function toOrigin(request, env, url) {
  const target = new URL(url.pathname + url.search, env.ORIGIN_URL);
  const headers = new Headers(request.headers);
  headers.set('X-Origin-Auth', env.ORIGIN_SECRET);
  headers.set('X-Client-IP', request.headers.get('CF-Connecting-IP') || '');
  headers.delete('Host');
  try {
    const res = await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' });
    // A deliberate 503 (maintenance, paused sync) carries this header: pass its message on.
    if (res.status < 500 || res.status === 501 || res.headers.get('X-Tracker-Maintenance')) { failingSince = 0; return res; }
    throw new Error(`origin ${res.status}`);
  } catch (err) {
    const now = Date.now();
    if (!failingSince) failingSince = now;
    if (now - failingSince >= FAIL_WINDOW_MS && request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html')) {
      return new Response(MAINTENANCE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' } });
    }
    return new Response(JSON.stringify({ error: 'The tracker is restarting. Try again in a minute.' }), { status: 502, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/img\/([0-9a-f]{40})$/);
    if (m && request.method === 'GET') {
      if (!(await validSignature(m[1], url.searchParams.get('s'), env.IMAGE_SIGNING_KEY))) return new Response('Forbidden', { status: 403 });
      const obj = await env.IMAGES.get(`img/${m[1]}`);
      if (obj) {
        return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: obj.httpEtag || '' } });
      }
      // Not in R2 yet: the hub downloads it once (and stores it in R2 for next time).
    }
    return toOrigin(request, env, url);
  }
};

export const _test = { reset: () => { failingSince = 0; } };
