'use strict';

const MAX_BODY = 25 * 1024 * 1024;

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  // The Cloudflare adapter hands the body over as text; Node streams it.
  if (typeof req.bodyText === 'string') {
    try { return Promise.resolve(req.bodyText ? JSON.parse(req.bodyText) : {}); } catch (err) { return Promise.reject(err); }
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { const body = Buffer.concat(chunks).toString('utf8'); resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

module.exports = { sendJSON, parseBody };
