'use strict';
// Hosted mode's refresh cycle (5.8): every 6 hours, for every account in turn, the same cycle the
// single-user tracker runs (stale metadata queued for the catalog worker, episode lists, repairs,
// recommendations, notifications), under one lease so only one runs, yielding between accounts so
// requests aren't held up.
const { withAccount } = require('../db');
const worker = require('./worker');

const holder = `sched-${process.pid}`;
const yieldNow = () => new Promise((r) => setImmediate(r));

/** Run the cycle for every account (ids from accounts.db). Returns how many ran. */
async function runAll({ accountIds = null, now = Date.now() } = {}) {
  // A lease long enough for a whole pass; another process (or an overlapping timer) skips it.
  if (!worker.lease(holder, now, 'refresh-cycle', 3 * 3600e3)) return { ran: 0, skipped: 'lease' };
  const ids = accountIds || require('../accounts/store').adb().prepare('SELECT id FROM accounts').all().map((r) => r.id);
  const sync = require('../sync');
  let ran = 0;
  for (const id of ids) {
    try { await withAccount(id, () => sync.refreshCycle()); ran += 1; } catch { /* one account's trouble doesn't stop the rest */ }
    await yieldNow();
  }
  require('../state').set('refreshCycle', { accounts: ran, at: new Date(now).toISOString() });
  return { ran };
}

function start({ intervalMs = 6 * 3600e3, firstAfterMs = 60e3 } = {}) {
  setTimeout(() => runAll().catch(() => {}), firstAfterMs).unref?.();
  setInterval(() => runAll().catch(() => {}), intervalMs).unref?.();
}

module.exports = { runAll, start };
