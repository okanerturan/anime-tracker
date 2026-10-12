'use strict';
// Anime tracker — local server. See server/ for modules:
//   db.js (schema) · library.js (watchlist/episodes) · sync.js (background refresh)
//   sources/anilist.js (primary metadata) · sources/jikan.js (fallback)
//   crunchyroll.js (history ingest + MAL mapping) · insights.js (up next, recs, study) · images.js (fetch-once cache)
const http = require('http');
const routes = require('./server/routes');
const sync = require('./server/sync');
const { serveStatic } = require('./server/static');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (await routes.handle(req, res, url)) return;
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Anime tracker running: http://localhost:${PORT}`);
  if (process.env.NO_SYNC !== '1') sync.start();
});
