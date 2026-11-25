'use strict';

const MAX_BODY = 25 * 1024 * 1024;

function sendJSON(res, status, payload) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const body = JSON.stringify(payload);
  // The Node server compresses (server.js sets res.sendText from server/compress.js); on Cloudflare
  // and in handler tests there is none, and the body goes out as it is.
  if (typeof res.sendText === 'function') return res.sendText(status, headers, body);
  res.writeHead(status, headers);
  res.end(body);
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
