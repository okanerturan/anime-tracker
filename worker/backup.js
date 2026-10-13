'use strict';
// Nightly database backup to R2: every table as gzipped JSON under backups/YYYY-MM-DD.json.gz.
// Episode thumbnails (episode_sync.image_blob) are left out; the background sync re-fetches them.
const { db } = require('./sqlite-shim');
const appState = require('../server/state');

const PREFIX = 'backups/';
const KEEP = 30;
const SKIP_COLUMNS = { episode_sync: ['image_blob'] };

function snapshot() {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\'`).all().map((r) => r.name);
  const out = { format: 'anime-tracker-backup', version: 1, createdAt: new Date().toISOString(), tables: {} };
  for (const table of tables) {
    const skip = SKIP_COLUMNS[table] || [];
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name).filter((c) => !skip.includes(c));
    const rows = db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM ${table}`).all().map((r) => columns.map((c) => r[c]));
    out.tables[table] = { columns, rows };
  }
  return out;
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function listBackups(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: PREFIX, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects.sort((a, b) => a.key.localeCompare(b.key));
}

async function create(bucket) {
  const data = snapshot();
  const body = await gzip(JSON.stringify(data));
  const key = `${PREFIX}${data.createdAt.slice(0, 10)}.json.gz`;
  await bucket.put(key, body, { httpMetadata: { contentType: 'application/gzip' } });
  const all = await listBackups(bucket);
  const old = all.slice(0, Math.max(0, all.length - KEEP)).map((o) => o.key);
  if (old.length) await bucket.delete(old);
  const rows = Object.values(data.tables).reduce((n, t) => n + t.rows.length, 0);
  const info = { key, bytes: body.byteLength, rows, kept: Math.min(all.length, KEEP) };
  appState.set('backup', info);
  return info;
}

/** Runs a backup when the last one is older than `maxAgeHours`. */
async function createIfDue(bucket, maxAgeHours = 20) {
  const last = appState.get('backup');
  if (last?.at && Date.now() - new Date(last.at).getTime() < maxAgeHours * 3600e3) return null;
  return create(bucket);
}

async function latest(bucket) {
  const all = await listBackups(bucket);
  return all.length ? bucket.get(all[all.length - 1].key) : null;
}

module.exports = { create, createIfDue, latest };
