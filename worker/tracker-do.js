'use strict';
// The tracker's database and API live in one Durable Object (SQLite storage). The shared server
// modules run here unchanged through a small Node-style req/res adapter.
const { bind, db } = require('./sqlite-shim');
const images = require('./images');
const { applySchema } = require('../server/schema');
const routes = require('../server/routes');
const sync = require('../server/sync');
const backup = require('./backup');

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Built from the runtime's DurableObject base class (imported in the ESM entry). */
const makeTrackerDO = (DurableObject) => class TrackerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    bind(ctx.storage);
    // Insights read the timezone from process.env (nodejs_compat); default to UTC.
    if (typeof process !== 'undefined' && process.env) process.env.TIMEZONE = env.TIMEZONE || process.env.TIMEZONE || 'UTC';
    images.bindBucket(env.IMAGES);
    ctx.blockConcurrencyWhile(async () => { applySchema(db); });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/internal/cycle') {
      // Back up first so a failing refresh never blocks it.
      try { await backup.createIfDue(this.env.IMAGES); } catch (err) { console.error('backup failed', err); }
      await sync.refreshCycle();
      await sync.whenIdle();
      return Response.json(sync.status());
    }
    if (url.pathname === '/api/backup' && request.method === 'GET') {
      // Latest nightly backup; ?fresh=1 makes a new one first.
      if (url.searchParams.get('fresh') === '1') await backup.create(this.env.IMAGES);
      const obj = await backup.latest(this.env.IMAGES);
      if (!obj) return Response.json({ error: 'no backup yet' }, { status: 404 });
      return new Response(obj.body, { headers: {
        'Content-Type': 'application/gzip', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="anime-tracker-${obj.key.slice(8)}"`
      } });
    }
    if (url.pathname === '/internal/import' && request.method === 'POST') {
      // Migration: { table, columns, blobColumns, rows: [[...], ...] }; blobs arrive base64-encoded.
      const { table, columns, blobColumns = [], rows } = await request.json();
      const blobIdx = new Set(blobColumns.map((c) => columns.indexOf(c)));
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      db.transaction(() => {
        for (const row of rows) stmt.run(...row.map((v, i) => (blobIdx.has(i) && v != null ? base64ToBytes(v) : v)));
      })();
      return Response.json({ ok: true, rows: rows.length });
    }
    if (url.pathname === '/internal/r2' && request.method === 'PUT') {
      const key = url.searchParams.get('key');
      const mime = url.searchParams.get('mime') || 'image/jpeg';
      const body = await request.arrayBuffer();
      await this.env.IMAGES.put(key, body, { httpMetadata: { contentType: mime } });
      db.prepare('UPDATE image_cache SET file = ?, bytes = ? WHERE url = ?').run(key, body.byteLength, url.searchParams.get('url'));
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/r2-keys') {
      const keys = [];
      let cursor;
      do {
        const page = await this.env.IMAGES.list({ prefix: 'img/', cursor });
        keys.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return Response.json(keys);
    }
    if (url.pathname === '/internal/counts') {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all().map((r) => r.name);
      return Response.json(Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n])));
    }

    // Node-style adapter for the shared router.
    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const req = { method: request.method, url: url.pathname + url.search, headers, bodyText: ['GET', 'HEAD'].includes(request.method) ? '' : await request.text() };
    let status = 200; let outHeaders = {}; let resolveBody;
    const done = new Promise((r) => { resolveBody = r; });
    const res = {
      writeHead(s, h = {}) { status = s; outHeaders = h; },
      end(body) { resolveBody(body ?? null); }
    };
    const handled = await routes.handle(req, res, url);
    if (!handled) return new Response('Not found', { status: 404 });
    const body = await done;
    return new Response(status === 304 ? null : body, { status, headers: outHeaders });
  }
};

module.exports = { makeTrackerDO };
