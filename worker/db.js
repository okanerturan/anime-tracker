'use strict';
// Worker replacement for server/db.js: same exports, backed by Durable Object SQLite.
const { db } = require('./sqlite-shim');

module.exports = { db, ROOT: '', DATA_DIR: '', IMAGE_DIR: '' };
