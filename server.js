'use strict';
// Anime tracker — local server. See server/ for modules:
//   db.js (schema) · library.js (watchlist/episodes) · sync.js (background refresh)
//   sources/anilist.js (primary metadata) · sources/jikan.js (fallback)
//   crunchyroll.js (history ingest + MAL mapping) · insights.js (up next, recs, study) · images.js (fetch-once cache)
const http = require('http');
const routes = require('./server/routes');
const sync = require('./server/sync');
const { serveStatic } = require('./server/static');
const { MULTI, withAccount } = require('./server/db');

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
    if (await auth.handle(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
      const who = auth.authenticate(req, res);
      if (!who) return sendJSON(res, 401, { error: 'Sign in first.', signIn: '/signin.html' });
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
});
