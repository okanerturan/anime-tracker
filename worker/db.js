'use strict';
// Worker replacement for server/db.js: same exports, backed by Durable Object SQLite.
const { db } = require('./sqlite-shim');

// Single-user on Cloudflare: the shared catalog is the same database, and there is always an account.
module.exports = { db, catalog: db, catalogDb: null, hasAccount: () => true, MULTI: false, ROOT: '', DATA_DIR: '', IMAGE_DIR: '' };
