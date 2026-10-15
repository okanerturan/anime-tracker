'use strict';
// The catalog worker (hosted mode, D4): one in-process loop that talks to AniList for everyone.
// Jobs wait in catalog.db (deduplicated, prioritised); a lease makes sure only one worker runs;
// requests stay within a global budget of 30 a minute; full fetches go 25 ids per request; a job
// that fails 3 times is quarantined with its error; a block or sustained failure pauses catalog
// updates (the app keeps serving what it has) and retries every 6 hours.
const crypto = require('crypto');
const { catalog } = require('../db');
const state = require('../state');

const ENDPOINT = 'https://graphql.anilist.co';
const BUDGET = 30;                 // requests per minute
const LEASE_MS = 30e3;
const PAUSE_MS = 6 * 3600e3;
const MAX_ATTEMPTS = 3;

// ---- queue (5.1) ----
const enqueueStmt = catalog.prepare(`INSERT INTO catalog_jobs (key, type, payload, priority) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET waiting = catalog_jobs.waiting + 1,
    priority = MAX(catalog_jobs.priority, excluded.priority) + 1,
    status = CASE WHEN catalog_jobs.status = 'done' THEN 'queued' ELSE catalog_jobs.status END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
/**
 * Ask for something. `recency` (0..1, how recent the plays waiting on it are) raises priority; the
 * same key asked again by another account adds one more waiting account (and +1 priority).
 */
function enqueue(type, payload, { recency = 0 } = {}) {
  const key = type === 'search' ? `search:${String(payload.query).toLowerCase().trim()}` : `${type}:${payload.malId}`;
  enqueueStmt.run(key, type, JSON.stringify(payload), Math.max(0, Math.min(1, recency)) * 10);
  return key;
}
const nextJobs = (type, limit) => catalog.prepare(`SELECT key, payload, attempts FROM catalog_jobs WHERE status = 'queued' AND type = ?
  ORDER BY priority DESC, created_at LIMIT ?`).all(type, limit);
const doneStmt = catalog.prepare("UPDATE catalog_jobs SET status = 'done', last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = ?");
const failStmt = catalog.prepare(`UPDATE catalog_jobs SET attempts = attempts + 1, last_error = ?,
  status = CASE WHEN attempts + 1 >= ? THEN 'quarantined' ELSE status END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = ?`);

// ---- lease (5.2) ----
const leaseStmt = catalog.prepare(`INSERT INTO catalog_lease (name, holder, expires_at) VALUES ('catalog-worker', ?, ?)
  ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
  WHERE catalog_lease.holder = excluded.holder OR catalog_lease.expires_at < ?`);
/** Take or renew the worker lease; true when this holder has it. */
function lease(holder, now = Date.now()) {
  leaseStmt.run(holder, now + LEASE_MS, now);
  return catalog.prepare("SELECT holder FROM catalog_lease WHERE name = 'catalog-worker'").get()?.holder === holder;
}

// ---- AniList requests (raw: the worker decides about retries) ----
async function anilistRequest(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'anime-tracker/2.0 (+https://github.com/okturan/anime-tracker)' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || null, data: json.data || null, errors: json.errors || null };
}

/**
 * A worker. `request(query, vars)` → { status, retryAfter, data, errors } (a fake in tests);
 * `store(list)` saves full media (anilist.storeFull by default). Call tick() every 2 seconds.
 */
function createWorker({ holder = `w-${crypto.randomBytes(4).toString('hex')}`, request = anilistRequest, store = null, fullQuery = null, now = () => Date.now() } = {}) {
  const sent = []; // request times in the last minute (5.3)
  let waitUntil = 0;
  const anilist = () => require('../sources/anilist');
  const save = store || ((list) => anilist().storeFull(list));
  const query = () => fullQuery || anilist().FULL_QUERY;

  const paused = () => state.get('catalogPaused');
  function pause(reason) { state.set('catalogPaused', { reason: String(reason).slice(0, 200), until: new Date(now() + PAUSE_MS).toISOString() }); }

  async function tick() {
    const t = now();
    if (!lease(holder, t)) return { ran: false, why: 'lease' };
    const p = paused();
    if (p && Date.parse(p.until) > t) return { ran: false, why: 'paused' };
    if (t < waitUntil) return { ran: false, why: 'retry-after' };
    while (sent.length && t - sent[0] >= 60e3) sent.shift();
    if (sent.length >= BUDGET) return { ran: false, why: 'budget' };

    // 5.4: one request carries up to 25 queued full fetches.
    const jobs = nextJobs('full', 25);
    if (!jobs.length) return { ran: false, why: 'idle' };
    const ids = jobs.map((j) => JSON.parse(j.payload).malId);
    sent.push(t);
    let r;
    try { r = await request(query(), { ids }); } catch (err) { r = { status: 0, errors: [{ message: err.message }] }; }
    const message = (r.errors || []).map((e) => e.message).join('; ');
    if (r.status === 429) { waitUntil = t + (r.retryAfter || 30) * 1000; return { ran: true, why: '429' }; }
    if (r.status === 403 || /blocked/i.test(message)) { pause(message || `HTTP ${r.status}`); return { ran: true, why: 'blocked' }; }
    if (r.status >= 500 || r.status === 0 || (r.errors && !r.data)) {
      for (const j of jobs) failStmt.run(message || `HTTP ${r.status}`, MAX_ATTEMPTS, j.key);
      // Sustained failure: everything in this batch has failed out; pause like a block.
      if (jobs.every((j) => j.attempts + 1 >= MAX_ATTEMPTS)) pause(`AniList failing: ${message || `HTTP ${r.status}`}`);
      waitUntil = t + 3000 * Math.min(10, (jobs[0]?.attempts || 0) + 1); // 5xx backoff
      return { ran: true, why: 'failed' };
    }
    if (state.get('catalogPaused')) state.set('catalogPaused', { reason: null, until: new Date(0).toISOString() });
    const media = r.data?.Page?.media || [];
    save(media); // idempotent upserts (5.5)
    for (const j of jobs) doneStmt.run(j.key); // found or not: AniList answered, so the job is settled
    return { ran: true, why: 'ok', stored: media.length, ids: ids.length };
  }

  let timer = null;
  return {
    tick,
    start: (ms = 2000) => { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, ms); timer.unref?.(); } },
    stop: () => { clearInterval(timer); timer = null; },
    requestsLastMinute: () => sent.filter((x) => now() - x < 60e3).length
  };
}

/** For the status page: how much is waiting, quarantined, and whether updates are paused. */
function status() {
  const counts = Object.fromEntries(catalog.prepare('SELECT status, COUNT(*) n FROM catalog_jobs GROUP BY status').all().map((r) => [r.status, r.n]));
  const p = state.get('catalogPaused');
  return { queued: counts.queued || 0, quarantined: counts.quarantined || 0, paused: p && Date.parse(p.until) > Date.now() ? p : null };
}

module.exports = { enqueue, lease, createWorker, status, BUDGET };
