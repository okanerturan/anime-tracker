'use strict';
// better-sqlite3-compatible facade over Durable Object SQLite storage (ctx.storage.sql), so the shared
// server modules run unchanged. Statements are prepared lazily: modules call db.prepare() at load time,
// before the Durable Object exists, and execution binds to the storage handed over in bind().
let sql = null;
let storage = null;

function bind(ctxStorage) {
  storage = ctxStorage;
  sql = ctxStorage.sql;
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Statement {
  constructor(text) {
    // Named parameters (@name) become positional; remember their order.
    this.names = [];
    this.text = text.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => { this.names.push(name); return '?'; });
  }

  params(args) {
    if (this.names.length && args.length === 1 && args[0] && typeof args[0] === 'object' && !ArrayBuffer.isView(args[0])) {
      return this.names.map((n) => normalize(args[0][n]));
    }
    return args.flat().map(normalize);
  }

  exec(args) {
    if (!sql) throw new Error('database not bound');
    return sql.exec(this.text, ...this.params(args));
  }

  get(...args) { return this.exec(args).toArray()[0]; }
  all(...args) { return this.exec(args).toArray(); }
  run(...args) {
    const cursor = this.exec(args);
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }
}

const db = {
  prepare: (text) => new Statement(text),
  exec: (text) => { sql.exec(text); },
  pragma: () => [],
  transaction: (fn) => (...args) => storage.transactionSync(() => fn(...args))
};

module.exports = { db, bind };
