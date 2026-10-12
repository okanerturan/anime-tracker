'use strict';
// One-shot relay for a browser-driven Crunchyroll sync (stand-in for the extension).
// GET /params -> { since, wantSeasons } from the tracker; POST / with { rows, seasons } -> forwarded
// to the tracker's ingest endpoints. Only https://www.crunchyroll.com may call it. Exits after one sync
// or after 5 minutes. Usage: node scripts/cr_relay.js
const http = require('http');
const TRACKER = process.env.TRACKER_URL || 'http://127.0.0.1:8080';
const ORIGIN = 'https://www.crunchyroll.com';
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Private-Network': 'true' };
const post = (path, body) => fetch(TRACKER + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'extension' }, body: JSON.stringify(body) }).then((r) => r.json());

const server = http.createServer(async (req, res) => {
  if (req.headers.origin && req.headers.origin !== ORIGIN) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET' && req.url === '/params') {
    const st = await fetch(`${TRACKER}/api/crunchyroll/status`).then((r) => r.json());
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ since: st.latestPlayed, wantSeasons: st.wantSeasons || [] }));
  }
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const ingest = await post('/api/crunchyroll/ingest', { rows: data.rows || [] });
    const episodes = (data.seasons || []).length ? await post('/api/crunchyroll/episodes', { seasons: data.seasons }) : null;
    const summary = { fetched: (data.rows || []).length, marked: ingest.marked, newAnime: ingest.newAnime, needsReview: ingest.needsReview, episodes };
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    console.log(JSON.stringify(summary));
    setTimeout(() => process.exit(0), 200);
    return;
  }
  res.writeHead(404, cors); res.end();
});
server.listen(47123, '127.0.0.1', () => console.log('relay ready'));
setTimeout(() => { console.log('relay timeout'); process.exit(1); }, 5 * 60 * 1000);
