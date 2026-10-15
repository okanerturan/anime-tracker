'use strict';
// Web Push for the installed app (phones without the extension). Notifications carry no payload:
// the push is a signed wake-up (VAPID), and the service worker fetches /api/push/latest for the
// text, so no message encryption is needed. Uses Web Crypto only, so it runs in Node and the Worker.
const state = require('./state');

const subtle = globalThis.crypto.subtle;
// Web APIs only (btoa/atob, TextEncoder): Buffer isn't guaranteed in the Worker runtime.
const utf8 = (s) => new TextEncoder().encode(s);
const b64url = (bytes) => { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** The VAPID key pair, made once and kept in app_state. */
async function keys() {
  const saved = state.get('pushKeys');
  if (saved?.publicKey && saved?.privateJwk) return saved;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
  state.set('pushKeys', { publicKey, privateJwk });
  return { publicKey, privateJwk };
}

async function vapidJwt(audience, subject, privateJwk) {
  const enc = (o) => b64url(utf8(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const key = await subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Web Crypto's ECDSA signature is already r||s (the JWS ES256 format).
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned)));
  return `${unsigned}.${b64url(sig)}`;
}

function subscriptions() { return state.get('pushSubs')?.list || []; }
function saveSubscriptions(list) { state.set('pushSubs', { list: list.slice(-10) }); }

function subscribe(sub, origin) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw Object.assign(new Error('bad subscription'), { status: 400 });
  const list = subscriptions().filter((s) => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, origin: String(origin || ''), at: new Date().toISOString() });
  saveSubscriptions(list);
  return { ok: true, devices: list.length };
}

function unsubscribe(endpoint) {
  const list = subscriptions().filter((s) => s.endpoint !== endpoint);
  saveSubscriptions(list);
  return { ok: true, devices: list.length };
}

/** Wake every subscribed device; drops subscriptions the push service says are gone. */
async function sendAll(message) {
  if (message) state.set('pushLatest', message);
  const list = subscriptions();
  if (!list.length) return { sent: 0 };
  const { publicKey, privateJwk } = await keys();
  const keep = []; let sent = 0;
  for (const s of list) {
    try {
      const aud = new URL(s.endpoint).origin;
      const jwt = await vapidJwt(aud, s.origin && /^https:\/\//.test(s.origin) ? s.origin : 'mailto:anime-tracker@localhost', privateJwk);
      const res = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt}, k=${publicKey}`, TTL: '86400', Urgency: 'normal', 'Content-Length': '0' } });
      if (res.status === 404 || res.status === 410) continue; // unsubscribed or expired
      keep.push(s);
      if (res.ok) sent += 1;
    } catch { keep.push(s); }
  }
  saveSubscriptions(keep);
  return { sent, devices: keep.length };
}

/**
 * After a refresh: tell devices about episodes that aired since the last check (once per episode).
 * `items` are Up Next's continue-watching cards (title, malId, nextEpisode, latestAiredAt).
 */
async function notifyNewEpisodes(items) {
  // (Own field name: state.get() overwrites `at` with the row's save time.)
  const checked = state.get('pushChecked')?.checkedAt;
  const last = checked ? new Date(checked).getTime() : Date.now();
  const now = Date.now();
  state.set('pushChecked', { checkedAt: new Date(now).toISOString() });
  const fresh = (items || []).filter((x) => x.latestAiredAt && new Date(x.latestAiredAt).getTime() > last && new Date(x.latestAiredAt).getTime() <= now);
  if (!fresh.length || !subscriptions().length) return { sent: 0, fresh: fresh.length };
  const names = fresh.slice(0, 3).map((x) => x.title);
  const message = fresh.length === 1
    ? { title: `New episode: ${fresh[0].title}`, body: fresh[0].nextEpisode ? `Episode ${fresh[0].nextEpisode} is out.` : 'A new episode is out.', url: `/#/library?anime=${fresh[0].malId}` }
    : { title: `${fresh.length} new episodes`, body: `${names.join(', ')}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}`, url: '/#/up-next' };
  return { ...(await sendAll(message)), fresh: fresh.length };
}

module.exports = { keys, subscribe, unsubscribe, subscriptions, sendAll, notifyNewEpisodes, vapidJwt, b64url, fromB64url };
