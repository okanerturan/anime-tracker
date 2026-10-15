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

// Hosted layout before the accounts layer exists: IMPLICIT_ACCOUNT=1 runs every request and the
// background refresh as that account (its own file plus the shared catalog).
const IMPLICIT = MULTI ? process.env.IMPLICIT_ACCOUNT || null : null;
if (MULTI && !IMPLICIT) throw new Error('AUTH_MODE=accounts needs the accounts layer; until then set IMPLICIT_ACCOUNT');
const asAccount = (fn) => (IMPLICIT ? withAccount(IMPLICIT, fn) : fn());

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (await asAccount(() => routes.handle(req, res, url))) return;
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Anime tracker running: http://localhost:${PORT}`);
  if (process.env.NO_SYNC !== '1') asAccount(() => sync.start());
});
