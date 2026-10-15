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
  // Another request may have made a pair while this one awaited: keep the first, or a device
  // subscribed with it would never receive anything.
  const raced = state.get('pushKeys');
  if (raced?.publicKey && raced?.privateJwk) return raced;
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
async function sendAll(message, { only = null } = {}) {
  if (message) state.set('pushLatest', message);
  const all = subscriptions();
  const list = only ? all.filter((s) => s.endpoint === only) : all;
  if (!list.length) return { sent: 0 };
  const { publicKey, privateJwk } = await keys();
  const gone = new Set(); let sent = 0;
  for (const s of list) {
    try {
      const aud = new URL(s.endpoint).origin;
      const jwt = await vapidJwt(aud, s.origin && /^https:\/\//.test(s.origin) ? s.origin : 'mailto:anime-tracker@localhost', privateJwk);
      const res = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt}, k=${publicKey}`, TTL: '86400', Urgency: 'normal', 'Content-Length': '0' } });
      if (res.status === 404 || res.status === 410) { gone.add(s.endpoint); continue; } // unsubscribed or expired
      if (res.ok) sent += 1;
    } catch {}
  }
  // Re-read: a device may have subscribed or unsubscribed while the pushes were in flight.
  const now = subscriptions().filter((s) => !gone.has(s.endpoint));
  if (gone.size) saveSubscriptions(now);
  return { sent, devices: now.length };
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

/**
 * After each refresh: what's new since the last check, judged by each show's aired-episode count
 * (AniList's next airing episode). Counting works without the extension and without exact air times:
 * - a show you're watching (not held or dropped) whose count went up: new episode;
 * - a show on your list going from 0 to 1+: premiere;
 * - a sequel of something you watched that's now airing (not in your library): new season, once.
 * The first run only records counts, so turning notifications on doesn't announce the back catalogue.
 */
async function notifyNewEpisodes({ shows = [], seasons = [], now = new Date() } = {}) {
  // Nothing is recorded during quiet hours, so the first check after 8:00 picks it all up.
  if (quietHours(now) && subscriptions().length) return { sent: 0, quiet: true };
  const prev = state.get('pushAired')?.counts || null;
  const counts = {};
  const fresh = []; const premieres = [];
  for (const x of shows) {
    if (x.listStatus || x.airedEpisodes == null) continue;
    counts[x.malId] = x.airedEpisodes;
    const before = prev?.[x.malId];
    if (before == null || x.airedEpisodes <= before) continue;
    const title = x.titleEnglish || x.title;
    if ((x.progress ?? x.watchedCount ?? 0) > 0) {
      fresh.push({ malId: x.malId, title, aired: x.airedEpisodes, nextEpisode: x.nextEpisode, nextEpisodeUrl: x.nextEpisodeUrlIsExact ? x.nextEpisodeUrl : null });
    } else if (before === 0) premieres.push({ malId: x.malId, title, premiere: true });
  }
  state.set('pushAired', { counts: { ...(prev || {}), ...counts } });
  // New seasons: AniList flips a show to RELEASING once episode 1 is out, so the status (not a
  // date-only start date in another time zone) says it has started. Started in the last 14 days, once each.
  const recent = new Date(now.getTime() - 14 * 86400e3).toISOString().slice(0, 10);
  const told = new Set(state.get('pushSeasons')?.ids || []);
  const taken = new Set([...fresh, ...premieres].map((x) => x.malId));
  const started = (seasons || []).filter((s) => !s.inLibrary && !taken.has(s.malId) && !told.has(s.malId)
    && s.status && s.status !== 'NOT_YET_RELEASED' && s.startDate && s.startDate >= recent);
  if (started.length) state.set('pushSeasons', { ids: [...told, ...started.map((s) => s.malId)].slice(-200) });
  if (!prev) return { sent: 0, firstRun: true };
  premieres.push(...started);
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
    ? { title: `New episode: ${fresh[0].title}`, body: episodeLine(fresh[0]), url: `/#/library?anime=${fresh[0].malId}`,
      // A "Play" button (Android/desktop) straight to your next episode on Crunchyroll.
      ...(fresh[0].nextEpisodeUrl && /^https:\/\/www\.crunchyroll\.com\//.test(fresh[0].nextEpisodeUrl) ? { playUrl: fresh[0].nextEpisodeUrl, playLabel: `Play E${fresh[0].nextEpisode}` } : {}) }
    : { title: `${fresh.length} new episodes`, body: `${names.join(', ')}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}`, url: '/#/up-next' };
  if (premieres.length) message.body += ` · New: ${premieres.map((s) => s.title).slice(0, 2).join(', ')}`;
  return { ...(await sendAll(message)), fresh: fresh.length, premieres: premieres.length };
}

module.exports = { episodeLine, quietHours, keys, subscribe, unsubscribe, subscriptions, sendAll, notifyNewEpisodes, vapidJwt, b64url, fromB64url };
