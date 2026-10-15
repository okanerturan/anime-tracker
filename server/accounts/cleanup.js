'use strict';
// Daily account housekeeping (3.14): accounts unused for 24 months are deleted (a notice 30 days
// ahead once email sign-in exists), and sign-ups that never saved a passkey are cleared after a day.
const { adb } = require('./store');
const { withAccount } = require('../db');
const data = require('./data');

const MONTHS_24 = 730 * 86400e3;

function sweep({ now = Date.now() } = {}) {
  const cutoff = new Date(now - MONTHS_24).toISOString();
  const dayAgo = new Date(now - 86400e3).toISOString();
  const stale = adb().prepare('SELECT id FROM accounts WHERE COALESCE(last_active_at, created_at) < ?').all(cutoff).map((r) => r.id);
  const abandoned = adb().prepare(`SELECT id FROM accounts a WHERE created_at < ?
    AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.account_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM recovery_codes r WHERE r.account_id = a.id)`).all(dayAgo).map((r) => r.id);
  const gone = [...new Set([...stale, ...abandoned])];
  for (const id of gone) {
    withAccount(id, () => data.deleteFiles(id));
    adb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }
  return { inactive: stale.length, abandoned: abandoned.filter((id) => !stale.includes(id)).length };
}

module.exports = { sweep };
