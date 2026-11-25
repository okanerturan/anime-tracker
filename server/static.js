'use strict';
// Static file serving for the local Node server (on Cloudflare, Workers Static Assets serves public/).
// Each file is read once and kept with its compressed forms; a browser that already has it gets a
// 304 (the files are served "no-cache", so every load asks, and the ETag answers without the body).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('./db');
const compress = require('./compress');

const PUBLIC_DIR = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const TEXT = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
const KEEP_BELOW = 2 * 1024 * 1024; // larger files are read per request and never kept in memory

const kept = new Map(); // file path -> { mtimeMs, size, data, etag, encoded: { br, gzip } }

/** Does If-None-Match name this file's content (in any encoding; weak or strong)? */
function sameContent(header, etag) {
  return String(header || '').split(',').some((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, '').split('-')[0] === etag);
}

function respond(req, res, filePath, entry) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  const text = TEXT.has(ext);
  if (text) compress.vary(res, 'Accept-Encoding');
  const encoding = text && entry.size >= compress.MIN_BYTES ? compress.pick(req) : null;
  // One ETag per encoding (they are different bytes); any of them proves the browser has this content.
  headers.ETag = `"${entry.etag}${encoding ? `-${encoding}` : ''}"`;
  if (sameContent(req.headers['if-none-match'], entry.etag)) { res.writeHead(304, headers); return res.end(); }
  let body = entry.data;
  if (encoding) {
    body = entry.encoded[encoding] || (entry.encoded[encoding] = compress.encode(entry.data, encoding, 'best'));
    headers['Content-Encoding'] = encoding;
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { res.writeHead(400); return res.end('Bad request'); }
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const have = kept.get(filePath);
    if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return respond(req, res, filePath, have);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const entry = { mtimeMs: st.mtimeMs, size: data.length, data, etag: crypto.createHash('sha1').update(data).digest('hex').slice(0, 20), encoded: {} };
      if (data.length < KEEP_BELOW) kept.set(filePath, entry);
      respond(req, res, filePath, entry);
    });
  });
}

module.exports = { serveStatic };
