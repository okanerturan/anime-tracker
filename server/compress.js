'use strict';
// Compressed text responses: JSON (through res.sendText, which server.js sets and sendJSON uses when
// it is there) and static files.
const zlib = require('zlib');

const MIN_BYTES = 1024; // below this the headers cost more than compression saves

/** The best encoding the client accepts: 'br', 'gzip' or null. */
function pick(req) {
  const accepted = new Set();
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
}

/** `level` is 'fast' for a response built per request, 'best' for one compressed once and kept. */
function encode(buf, encoding, level = 'fast') {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buf, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: level === 'best' ? 9 : 4,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length
    } });
  }
  return zlib.gzipSync(buf, { level: level === 'best' ? 9 : 6 });
}

/** Add to Vary without dropping what is there (the passphrase gate sets "Origin" for the extension). */
function vary(res, name) {
  const have = String(res.getHeader('Vary') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!have.some((h) => h.toLowerCase() === name.toLowerCase())) res.setHeader('Vary', [...have, name].join(', '));
}

/** Send a text body (string or Buffer), compressed when it is big enough and the client accepts it. */
function send(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  vary(res, 'Accept-Encoding');
  const encoding = buf.length >= MIN_BYTES ? pick(req) : null;
  const out = encoding ? encode(buf, encoding) : buf;
  res.writeHead(status, { ...headers, ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Content-Length': out.length });
  res.end(out);
}

module.exports = { pick, encode, vary, send, MIN_BYTES };
