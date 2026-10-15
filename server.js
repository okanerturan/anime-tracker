'use strict';
// Anime tracker — local server. See server/ for modules:
//   db.js (schema) · library.js (watchlist/episodes) · sync.js (background refresh)
//   sources/anilist.js (primary metadata) · sources/jikan.js (fallback)
//   crunchyroll.js (history ingest + MAL mapping) · insights.js (up next, recs, study) · images.js (fetch-once cache)
const http = require('http');
const routes = require('./server/routes');
const sync = require('./server/sync');
const { serveStatic } = require('./server/static');
const { MULTI, withAccount, db } = require('./server/db');
const quota = require('./server/accounts/quota');

const { sendJSON } = require('./server/http');

// Hosted mode (AUTH_MODE=accounts): requests belong to the account their session cookie or device
// token names (server/accounts/http.js). IMPLICIT_ACCOUNT=1 instead runs everything as that one
// account (local runs on a split backup, before anyone has signed up).
const IMPLICIT = MULTI ? process.env.IMPLICIT_ACCOUNT || null : null;
const auth = MULTI && !IMPLICIT ? require('./server/accounts/http') : null;
const asAccount = (fn) => (IMPLICIT ? withAccount(IMPLICIT, fn) : fn());

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (auth) {
    require('./server/accounts/log').attach(req, res);
    // Origin lock: only the front Worker (holding the secret) reaches the hub; then its
    // X-Client-IP can be trusted for rate limits.
    const lock = require('./server/accounts/origin').check(req, url.pathname);
    if (!lock.ok) return sendJSON(res, 403, { error: 'forbidden' });
    req.originTrusted = lock.trusted;
    if (req.method === 'GET' && url.pathname === '/up') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (await auth.handle(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
      const who = auth.authenticate(req, res);
      if (!who) return sendJSON(res, 401, { error: 'Sign in first.', signIn: '/signin.html' });
      // An extension's token reaches only what the extension uses.
      if (who.via === 'device' && !require('./server/accounts/devices').deviceMayUse(req.method, url.pathname)) return sendJSON(res, 403, { error: 'Not available to the extension.' });
      // Storage quota from the account file's size: warn past the soft limit; past the hard one only
      // reads and syncing new plays go through.
      const lvl = quota.level(db.fileOf(who.accountId));
      if (lvl !== 'ok') res.setHeader('X-Storage', lvl);
      if (quota.blocks(req.method, url.pathname, lvl)) return sendJSON(res, 507, { error: 'Your account is over its storage limit. Syncing new plays still works; export or tidy up to make changes again.' });
      if (await withAccount(who.accountId, () => routes.handle(req, res, url))) return;
      return sendJSON(res, 404, { error: 'not found' });
    }
    // Images and other non-API routes don't belong to anyone; the page shell holds no data.
    if (await routes.handle(req, res, url)) return;
    return serveStatic(req, res, url.pathname);
  }
  if (await asAccount(() => routes.handle(req, res, url))) return;
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Anime tracker running: http://localhost:${PORT}`);
  // Hosted mode refreshes per account from the scheduler (group 8); a single or implicit account here.
  if (process.env.NO_SYNC !== '1' && !auth) asAccount(() => sync.start());
  // Hosted mode: the catalog worker (AniList for everyone, one lease, one budget).
  if (MULTI && process.env.NO_SYNC !== '1') require('./server/catalog/worker').createWorker().start(2000);
  // Hosted mode: the refresh cycle for every account, every 6 hours (one lease).
  if (auth && process.env.NO_SYNC !== '1') require('./server/catalog/scheduler').start();
  // Hosted mode: daily account housekeeping (24-month inactivity, abandoned sign-ups).
  if (auth && process.env.NO_SYNC !== '1') {
    const sweep = () => { try { const r = require('./server/accounts/cleanup').sweep(); if (r.inactive || r.abandoned) console.log(`accounts cleanup: ${r.inactive} inactive, ${r.abandoned} abandoned`); } catch (err) { console.error('accounts cleanup failed', err.message); } };
    setTimeout(sweep, 60e3).unref(); setInterval(sweep, 86400e3).unref();
  }
});
