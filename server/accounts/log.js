'use strict';
// One access-log line per request in hosted mode. Never the query string, headers, cookies or
// bodies; calendar feed tokens in the path are masked. So no session, device token, recovery code
// or invite ever reaches a log (3.15).
function redactPath(pathname) {
  return String(pathname || '/')
    .replace(/^\/calendar\/[^/]+\.ics$/, '/calendar/***.ics')
    .slice(0, 200);
}

function line(req, res, startedAt) {
  return `${req.method} ${redactPath(new URL(req.url, 'http://x').pathname)} ${res.statusCode} ${Date.now() - startedAt}ms`;
}

/** Log the request when its response is done. */
function attach(req, res, write = (s) => console.log(s)) {
  const startedAt = Date.now();
  res.on('finish', () => write(line(req, res, startedAt)));
}

module.exports = { attach, line, redactPath };
