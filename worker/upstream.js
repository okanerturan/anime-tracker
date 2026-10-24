'use strict';
// Cloudflare build of server/upstream.js: Workers resolve hosts themselves, so UPSTREAM_DNS does not apply.
module.exports = { fetch: (...args) => fetch(...args), servers: [] };
