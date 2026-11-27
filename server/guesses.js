'use strict';
// Limits on guessing the passphrase (single-passphrase mode, server/passgate.js). Three things test a
// passphrase: the login form, a bearer key (the extension, scripts) and a session cookie (it is an
// HMAC keyed by the passphrase, so a made-up cookie is a guess too). All three count here.
//
// What counts is distinct wrong values, not attempts: an extension holding an old key, or a tab left
// open with an old cookie, sends the same wrong value over and over and is one guess, not hundreds.
// A caller that reaches a limit is refused without its value being looked at, until its oldest guess
// is 15 minutes old. Kept in memory: a restart (any deploy) clears every count and lock.
const crypto = require('crypto');

const WINDOW_MS = 15 * 60e3;
const PER_ADDRESS = 10;            // distinct wrong values from one address
const FROM_STRANGERS = 60;         // distinct wrong values from every address that has never signed in, together
const KNOWN_FOR_MS = 30 * 86400e3; // an address that signed in is not a stranger for this long
const MAX_ADDRESSES = 5000;

const wrongBy = new Map();   // address -> Map(hash of the wrong value -> when first seen)
const strangers = new Map(); // "address hash" -> when first seen; guesses from addresses that never signed in
const known = new Map();     // address -> known until

// Only a digest of a wrong value is kept: a near miss of the real passphrase shouldn't sit in memory.
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

/** Drop entries older than the window. Entries keep their first-seen time, so the map is in time order. */
function prune(map, now) {
  for (const [key, at] of map) { if (now - at < WINDOW_MS) break; map.delete(key); }
  return map;
}
const waitFor = (map, limit, now) => (map.size >= limit ? Math.max(1, Math.ceil((map.values().next().value + WINDOW_MS - now) / 1000)) : 0);
const isKnown = (address, now) => (known.get(address) || 0) > now;

/** Seconds this address must wait before a passphrase, key or cookie from it is looked at; 0 when it may try. */
function blocked(address, now = Date.now()) {
  const mine = wrongBy.get(address);
  const own = mine ? waitFor(prune(mine, now), PER_ADDRESS, now) : 0;
  if (mine && !mine.size) wrongBy.delete(address);
  const all = isKnown(address, now) ? 0 : waitFor(prune(strangers, now), FROM_STRANGERS, now);
  return Math.max(own, all);
}

/** A wrong value came from this address. */
function wrong(address, value, now = Date.now()) {
  const hash = digest(value);
  let mine = wrongBy.get(address);
  if (!mine) {
    if (wrongBy.size >= MAX_ADDRESSES) wrongBy.delete(wrongBy.keys().next().value);
    wrongBy.set(address, mine = new Map());
  }
  if (!prune(mine, now).has(hash)) mine.set(hash, now);
  if (!isKnown(address, now) && !prune(strangers, now).has(`${address} ${hash}`)) strangers.set(`${address} ${hash}`, now);
}

/**
 * The right passphrase, key or cookie came from this address: it is no stranger for 30 days. Its own
 * wrong guesses stay counted (someone else behind the same address must not get a clean slate each
 * time you load a page).
 */
function right(address, now = Date.now()) {
  if ((known.get(address) || 0) - now >= KNOWN_FOR_MS - 3600e3) return; // noted within the last hour
  known.delete(address); known.set(address, now + KNOWN_FOR_MS);        // re-inserted, so the map stays in expiry order
  while (known.size > MAX_ADDRESSES) known.delete(known.keys().next().value);
}

const PRIVATE = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i;
/**
 * Who is asking. Reached directly, it is the connection's peer. Behind a proxy on a private address
 * (kamal-proxy on the hub) it is the last X-Forwarded-For entry, the one that proxy wrote: kamal-proxy
 * replaces whatever the caller sent with the caller's real address (checked on the hub, 2026-11-25).
 */
function clientIp(req) {
  const plain = (a) => String(a || '').trim().replace(/^::ffff:/i, '');
  const peer = plain(req.socket?.remoteAddress) || 'unknown';
  if (!PRIVATE.test(peer)) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(plain).filter(Boolean).pop();
  return forwarded || peer;
}

/** "Try again in 12 minutes." */
const retryText = (seconds) => { const m = Math.max(1, Math.ceil(seconds / 60)); return `Try again in ${m} minute${m === 1 ? '' : 's'}.`; };

function reset() { wrongBy.clear(); strangers.clear(); known.clear(); }

module.exports = { blocked, wrong, right, clientIp, retryText, reset, WINDOW_MS, PER_ADDRESS, FROM_STRANGERS };
