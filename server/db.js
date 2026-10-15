'use strict';
// The database every server module uses. In single-user mode (the default, AUTH_MODE unset or
// 'passphrase') it is one SQLite file, exactly as before. With AUTH_MODE=accounts each account has
// its own file, and this module routes every statement to the file of the account the current
// request belongs to (AsyncLocalStorage), so the modules' top-level `db.prepare(...)` calls keep
// working unchanged. Statements are compiled once per connection; at most DB_MAX_OPEN files are
// open at a time (least recently used closed first). The Cloudflare build swaps this file out.
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const Database = require('better-sqlite3');
const { applySchema } = require('./schema');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = process.env.ANIME_DB || path.join(DATA_DIR, 'anime-tracker.db');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const ACCOUNTS_DIR = process.env.ACCOUNTS_DIR || path.join(DATA_DIR, 'accounts');
const MULTI = process.env.AUTH_MODE === 'accounts';
const MAX_OPEN = Number(process.env.DB_MAX_OPEN) || 200;
fs.mkdirSync(IMAGE_DIR, { recursive: true });
if (MULTI) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

const accountContext = new AsyncLocalStorage();
/** Run `fn` (and everything it awaits) as `accountId`: its statements use that account's file. */
function withAccount(accountId, fn) { return accountContext.run({ accountId: String(accountId) }, fn); }

const open = new Map(); // key -> { conn, stmts: Map<sql, Statement> }, in least-recently-used order

function fileFor(key) {
  if (!MULTI) return DB_FILE;
  // Account ids become file names: only plain ids, never a path.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error(`invalid account id: ${key}`);
  return path.join(ACCOUNTS_DIR, `${key}.db`);
}

function connect(file) {
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  applySchema(conn);
  return conn;
}

/** The connection for the current request's account (single-user mode: the one file). */
function current() {
  let key = 'main';
  if (MULTI) {
    const store = accountContext.getStore();
    if (!store?.accountId) throw new Error('database used outside an account (wrap the work in withAccount)');
    key = store.accountId;
  }
  let entry = open.get(key);
  if (entry) { open.delete(key); open.set(key, entry); return entry; }
  entry = { conn: connect(fileFor(key)), stmts: new Map() };
  open.set(key, entry);
  // Close the least recently used files beyond the cap (never one mid-transaction).
  for (const [k, e] of open) {
    if (open.size <= MAX_OPEN) break;
    if (k === key || e.conn.inTransaction) continue;
    e.conn.close();
    open.delete(k);
  }
  return entry;
}

/** A statement that compiles itself on the connection of whoever runs it. */
class LazyStatement {
  constructor(sql) { this.sql = sql; }
  compiled() {
    const entry = current();
    let s = entry.stmts.get(this.sql);
    if (!s) { s = entry.conn.prepare(this.sql); entry.stmts.set(this.sql, s); }
    return s;
  }
  run(...args) { return this.compiled().run(...args); }
  get(...args) { return this.compiled().get(...args); }
  all(...args) { return this.compiled().all(...args); }
  iterate(...args) { return this.compiled().iterate(...args); }
}

const db = {
  prepare: (sql) => new LazyStatement(sql),
  /** Like better-sqlite3's: returns a function that runs `fn` in a transaction on the caller's connection. */
  transaction: (fn) => (...args) => current().conn.transaction(fn)(...args),
  exec: (sql) => current().conn.exec(sql),
  pragma: (...args) => current().conn.pragma(...args),
  close: () => { for (const [k, e] of open) { e.conn.close(); open.delete(k); } },
  /** How many account files are open (tests and the status endpoint). */
  openCount: () => open.size
};

module.exports = { db, ROOT, DATA_DIR, IMAGE_DIR, ACCOUNTS_DIR, MULTI, withAccount, accountContext };
