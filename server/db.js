'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { applySchema } = require('./schema');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = process.env.ANIME_DB || path.join(DATA_DIR, 'anime-tracker.db');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGE_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

applySchema(db);

module.exports = { db, ROOT, DATA_DIR, IMAGE_DIR };
