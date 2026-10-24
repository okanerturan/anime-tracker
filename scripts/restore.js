#!/usr/bin/env node
'use strict';
// Restore from the nightly snapshots (8.3) into a directory, never over the live data:
//   node scripts/restore.js --to /srv/restore-drill [--day 2026-10-14] [--account 12 ...] [--all]
// Takes the newest manifest on or before --day (default today), always restores accounts.db and
// catalog.db, plus the named accounts (or every account with --all), and prints their counts.
// Then, to put one account back: stop the app, copy <to>/accounts/<id>.db over the live file, start it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function args(argv) {
  const out = { accounts: [], all: false, day: new Date().toISOString().slice(0, 10), to: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--to') out.to = argv[++i];
    else if (argv[i] === '--day') out.day = argv[++i];
    else if (argv[i] === '--account') out.accounts.push(String(argv[++i]));
    else if (argv[i] === '--all') out.all = true;
  }
  return out;
}

/** Row counts that say whether a restore is whole. */
function counts(file, name) {
  const Database = require('better-sqlite3');
  const d = new Database(file, { readonly: true });
  const n = (t) => { try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; } };
  try {
    if (name === 'accounts.db') return { accounts: n('accounts'), passkeys: n('passkeys') };
    if (name === 'catalog.db') return { media: n('media'), image_cache: n('image_cache') };
    return { watchlist: n('watchlist'), episode_watch: n('episode_watch'), cr_history: n('cr_history') };
  } finally { d.close(); }
}

async function restore({ to, day, accounts = [], all = false }) {
  if (!to) throw new Error('--to <directory> is required (never the live data directory)');
  const { backups } = require('../server/catalog/r2');
  const { latestManifest } = require('../server/catalog/snapshot');
  if (!backups.configured()) throw new Error('Set R2_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID and R2_BACKUP_SECRET_ACCESS_KEY first.');
  const { day: found, manifest } = await latestManifest(day);
  if (!found) throw new Error(`No snapshot on or before ${day}.`);
  const wanted = Object.keys(manifest.files).filter((name) => name === 'accounts.db' || name === 'catalog.db'
    || all || accounts.includes(path.basename(name, '.db')));
  const missing = accounts.filter((a) => !manifest.files[`accounts/${a}.db`]);
  if (missing.length) throw new Error(`Not in the ${found} snapshot: account ${missing.join(', ')}`);
  const out = { day: found, files: {} };
  for (const name of wanted) {
    const obj = await backups.get(manifest.files[name].key);
    if (!obj) throw new Error(`Missing in R2: ${manifest.files[name].key}`);
    const target = path.join(to, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zlib.gunzipSync(obj.body));
    out.files[name] = counts(target, path.basename(name) === name ? name : 'account');
  }
  return out;
}

if (require.main === module) {
  restore(args(process.argv.slice(2))).then((r) => {
    console.log(`Restored from the ${r.day} snapshot:`);
    for (const [name, c] of Object.entries(r.files)) console.log(`  ${name.padEnd(24)} ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { restore, counts };
