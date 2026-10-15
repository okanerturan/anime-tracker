'use strict';
// Origin lock (D8, 8.5): behind the front Worker, the hub answers only requests that carry the
// shared secret in X-Origin-Auth, so its sslip.io name isn't a second front door. Two values are
// accepted while the secret rotates (ORIGIN_SECRET and ORIGIN_SECRET_PREVIOUS). Only kamal-proxy's
// health check (GET /up) is exempt. Without ORIGIN_SECRET (local runs) there is no lock.
const { same } = require('./store');

function check(req, pathname) {
  const secrets = [process.env.ORIGIN_SECRET, process.env.ORIGIN_SECRET_PREVIOUS].filter(Boolean);
  if (!secrets.length) return { ok: true, trusted: false };
  if (req.method === 'GET' && pathname === '/up') return { ok: true, trusted: false };
  const given = String(req.headers['x-origin-auth'] || '');
  const match = given.length > 0 && secrets.some((s) => same(given, s));
  return { ok: match, trusted: match };
}

module.exports = { check };
