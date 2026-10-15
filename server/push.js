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
/** 23:00–08:00 in your time zone: hold notifications; the morning check sends what aired overnight. */
function quietHours(at = new Date()) {
  const tz = (typeof process !== 'undefined' && process.env && process.env.TIMEZONE) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(at));
  return hour >= 23 || hour < 8;
}

// The episode that just aired, and where you are if you're behind ("Episode 8 is out. You're on episode 4.").
function episodeLine(x) {
  const newest = x.aired || x.nextEpisode;
  if (!newest) return 'A new episode is out.';
  const behind = x.nextEpisode && x.nextEpisode < newest ? ` You're on episode ${x.nextEpisode}.` : '';
  return `Episode ${newest} is out.${behind}`;
}

async function notifyNewEpisodes(items, seasons = [], { now: nowAt = new Date() } = {}) {
  // Nothing is marked as told during quiet hours, so the first check after 8:00 picks it all up.
  if (quietHours(nowAt) && subscriptions().length) return { sent: 0, quiet: true };
  // (Own field name: state.get() overwrites `at` with the row's save time.)
  const checked = state.get('pushChecked')?.checkedAt;
  const last = checked ? new Date(checked).getTime() : Date.now();
  const now = Date.now();
  state.set('pushChecked', { checkedAt: new Date(now).toISOString() });
  const fresh = (items || []).filter((x) => x.latestAiredAt && new Date(x.latestAiredAt).getTime() > last && new Date(x.latestAiredAt).getTime() <= now);
  // A new season of a show you watched, on (or up to 3 days after) its start date, once per season.
  const today = new Date(now).toISOString().slice(0, 10);
  const recent = new Date(now - 3 * 86400e3).toISOString().slice(0, 10);
  const told = new Set(state.get('pushSeasons')?.ids || []);
  const seen = new Set(fresh.map((x) => x.malId));
  const premieres = (seasons || []).filter((s) => !seen.has(s.malId) && (seen.add(s.malId), true) && !s.inLibrary && s.startDate && s.startDate <= today && s.startDate >= recent && !told.has(s.malId));
  if (premieres.length) state.set('pushSeasons', { ids: [...told, ...premieres.map((s) => s.malId)].slice(-200) });
  if (!subscriptions().length || (!fresh.length && !premieres.length)) return { sent: 0, fresh: fresh.length, premieres: premieres.length };
  if (!fresh.length) {
    const p = premieres[0];
    const message = premieres.length === 1
      ? (p.premiere
        ? { title: `Premiere: ${p.title}`, body: 'Episode 1 is out. It was on your list.', url: `/#/library?anime=${p.malId}` }
        : { title: `New season: ${p.title}`, body: p.after ? `The sequel to ${p.after} has started.` : 'It has started.', url: '/#/up-next' })
      : { title: `${premieres.length} new seasons started`, body: premieres.slice(0, 3).map((s) => s.title).join(', '), url: '/#/up-next' };
    return { ...(await sendAll(message)), fresh: 0, premieres: premieres.length };
  }
  const names = fresh.slice(0, 3).map((x) => x.title);
  const message = fresh.length === 1
    ? { title: `New episode: ${fresh[0].title}`, body: episodeLine(fresh[0]), url: `/#/library?anime=${fresh[0].malId}` }
    : { title: `${fresh.length} new episodes`, body: `${names.join(', ')}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}`, url: '/#/up-next' };
  if (premieres.length) message.body += ` · New season: ${premieres.map((s) => s.title).slice(0, 2).join(', ')}`;
  return { ...(await sendAll(message)), fresh: fresh.length, premieres: premieres.length };
}

/** Shows you added before they aired (not held or dropped) whose start date has come; shaped like newSeasons cards. */
function libraryPremieres() {
  const { db } = require('./db');
  const recent = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`SELECT w.mal_id AS malId, COALESCE(m.title_english, m.title) AS title, m.start_date AS startDate
    FROM watchlist w JOIN media m ON m.mal_id = w.mal_id
    WHERE w.list_status IS NULL AND m.start_date BETWEEN ? AND ?`).all(recent, today)
    .map((r) => ({ ...r, inLibrary: false, premiere: true }));
}

module.exports = { episodeLine, quietHours, libraryPremieres, keys, subscribe, unsubscribe, subscriptions, sendAll, notifyNewEpisodes, vapidJwt, b64url, fromB64url };
