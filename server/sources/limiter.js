'use strict';
// A request budget and a circuit breaker for one upstream source (TMDB, Kitsu). Background jobs only:
// a request waits for a free slot in the minute, and after `failures` failed requests in a row the
// source pauses for `openMs`; the first request after that is a probe (one more failure reopens it).
// A source can also be paused on purpose (a bad API key) until the given time.
const { sleep: realSleep } = require('../util');

function createLimiter({ name, perMinute, failures = 3, openMs = 30 * 60e3, now = () => Date.now(), sleep = realSleep } = {}) {
  const sent = [];
  let failed = 0;
  let pausedUntil = 0;
  let reason = null;

  const isAvailable = () => now() >= pausedUntil;

  /** Wait for a slot in the budget, then run `fn`; its outcome feeds the breaker. */
  async function run(fn) {
    if (!isAvailable()) throw Object.assign(new Error(`${name} paused${reason ? `: ${reason}` : ''}`), { paused: true });
    for (;;) {
      while (sent.length && now() - sent[0] >= 60e3) sent.shift();
      if (sent.length < perMinute) break;
      await sleep(60e3 - (now() - sent[0]) + 5);
    }
    sent.push(now());
    try {
      const out = await fn();
      failed = 0; reason = null;
      return out;
    } catch (err) {
      if (!err.notFailure) {
        failed += 1;
        if (failed >= failures) { pausedUntil = now() + openMs; reason = String(err.message || err); failed = failures - 1; }
      }
      throw err;
    }
  }

  /** Pause on purpose (e.g. 401: the key is wrong) for `ms`. */
  function pause(why, ms) { pausedUntil = now() + ms; reason = why; }

  const status = () => ({ name, available: isAvailable(), pausedUntil: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, reason, usedThisMinute: sent.filter((t) => now() - t < 60e3).length, perMinute });

  return { run, pause, isAvailable, status };
}

module.exports = { createLimiter };
