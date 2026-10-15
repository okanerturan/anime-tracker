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
const { applySchema, CATALOG_TABLES } = require('./schema');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = process.env.ANIME_DB || path.join(DATA_DIR, 'anime-tracker.db');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const ACCOUNTS_DIR = process.env.ACCOUNTS_DIR || path.join(DATA_DIR, 'accounts');
const MULTI = process.env.AUTH_MODE === 'accounts';
const MAX_OPEN = Number(process.env.DB_MAX_OPEN) || 200;
const CATALOG_FILE = process.env.CATALOG_DB || path.join(DATA_DIR, 'catalog.db');
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

function connect(file, part = 'all') {
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  applySchema(conn, part);
  // Hosted mode: the shared catalog is attached, so unqualified `media` (and friends) resolve to
  // it and the existing joins keep working with nothing copied into the account file.
  if (part === 'account') conn.prepare('ATTACH DATABASE ? AS catalog').run(CATALOG_FILE);
  return conn;
}

// The catalog's own writable connection (hosted mode): only the catalog worker uses it.
const catalogConn = MULTI ? connect(CATALOG_FILE, 'catalog') : null;

// An account connection may read the catalog but never write it (better-sqlite3 here can't attach
// read-only, so writes are refused when a statement is compiled).
const WRITE_TARGET = /^\s*(?:WITH\b[\s\S]*?\)\s*)?(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:catalog\.)?["`]?(\w+)/i;
function assertNoCatalogWrite(sql) {
  const m = sql.match(WRITE_TARGET);
  if (m && CATALOG_TABLES.has(m[1].toLowerCase())) {
    throw new Error(`catalog table "${m[1]}" is written only by the catalog worker, not from an account`);
  }
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
  entry = { conn: connect(fileFor(key), MULTI ? 'account' : 'all'), stmts: new Map() };
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
    if (!s) {
      if (MULTI) assertNoCatalogWrite(this.sql);
      s = entry.conn.prepare(this.sql);
      entry.stmts.set(this.sql, s);
    }
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
  exec: (sql) => { if (MULTI) assertNoCatalogWrite(sql); return current().conn.exec(sql); },
  pragma: (...args) => current().conn.pragma(...args),
  close: () => { for (const [k, e] of open) { e.conn.close(); open.delete(k); } catalogConn?.close(); },
  /** How many account files are open (tests and the status endpoint). */
  openCount: () => open.size,
  /** The path of an account's file (hosted mode), or the single file. */
  fileOf: (accountId) => fileFor(MULTI ? String(accountId) : 'main'),
  /** Close an account's file (before deleting or replacing it); returns its path. */
  forget: (accountId) => {
    const key = String(accountId);
    const e = open.get(key);
    if (e) { e.conn.close(); open.delete(key); }
    return fileFor(key);
  }
};

/** Hosted mode: the catalog worker's read-write connection to the shared catalog (null in single-user mode). */
const catalogDb = catalogConn;

/**
 * Where shared-catalog statements go: the catalog's own connection in hosted mode, the one database
 * in single-user mode. Same API as `db`, so catalog code reads the same in both.
 */
const catalog = MULTI ? {
  prepare: (sql) => catalogConn.prepare(sql),
  transaction: (fn) => catalogConn.transaction(fn),
  exec: (sql) => catalogConn.exec(sql),
  pragma: (...args) => catalogConn.pragma(...args)
} : db;

/** True when there is an account to write per-person data for (always, in single-user mode). */
const hasAccount = () => !MULTI || Boolean(accountContext.getStore()?.accountId);

module.exports = { db, catalog, hasAccount, catalogDb, ROOT, DATA_DIR, IMAGE_DIR, ACCOUNTS_DIR, CATALOG_FILE, MULTI, withAccount, accountContext };
