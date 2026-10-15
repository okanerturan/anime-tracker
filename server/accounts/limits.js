'use strict';
// In-process rate limits for sign-in (D13): one process, so a Map is enough. Each rule is a
// sliding window; `hit` records an attempt and says whether it is allowed (with Retry-After).
const windows = new Map(); // key -> [timestamps]

const RULES = {
  signinFail: { limit: 10, windowMs: 15 * 60e3 },   // failed passkey answers per IP
  recover: { limit: 10, windowMs: 60 * 60e3 },      // recovery code attempts per IP
  recoverAccount: { limit: 5, windowMs: 60 * 60e3 }, // wrong codes are anonymous; this caps per account once known
  signup: { limit: 20, windowMs: 60 * 60e3 },       // sign-up starts per IP
  invite: { limit: 10, windowMs: 60 * 60e3 }        // invalid invite tries per IP
};

/** Record an attempt under `rule` for `who`; returns { ok, retryAfter } (seconds). */
function hit(rule, who, now = Date.now()) {
  const { limit, windowMs } = RULES[rule];
  const key = `${rule}:${who}`;
  const recent = (windows.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    windows.set(key, recent);
    return { ok: false, retryAfter: Math.ceil((recent[0] + windowMs - now) / 1000) };
  }
  recent.push(now);
  windows.set(key, recent);
  return { ok: true, retryAfter: 0 };
}

/** Would another attempt be allowed? (Doesn't record one.) */
function check(rule, who, now = Date.now()) {
  const { limit, windowMs } = RULES[rule];
  const recent = (windows.get(`${rule}:${who}`) || []).filter((t) => now - t < windowMs);
  return recent.length < limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.ceil((recent[0] + windowMs - now) / 1000) };
}

function reset() { windows.clear(); }

/**
 * The client's address. Behind the front Worker the real one arrives in X-Client-IP, trusted only
 * when the origin secret matched (req.originTrusted is set by the origin lock); otherwise the socket.
 */
const clientIp = (req) => (req.originTrusted && req.headers['x-client-ip']) || req.socket?.remoteAddress || 'unknown';

module.exports = { hit, check, reset, clientIp, RULES };
