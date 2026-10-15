#!/usr/bin/env node
'use strict';
// Flip a hosted-mode kill switch (D14). Takes effect within 10 seconds, no deploy:
//   bin/kamal app exec 'node scripts/switch.js'                              (show all)
//   bin/kamal app exec 'node scripts/switch.js SYNC_PAUSED "Crunchyroll changed something; fix coming"'
//   bin/kamal app exec 'node scripts/switch.js SYNC_PAUSED ""'               (resume)
//   bin/kamal app exec 'node scripts/switch.js THUMBNAILS off|on'
//   bin/kamal app exec 'node scripts/switch.js SIGNUP closed|invite|open'
//   bin/kamal app exec 'node scripts/switch.js READ_ONLY on|off'
process.env.AUTH_MODE = process.env.AUTH_MODE || 'accounts';
const switches = require('../server/accounts/switches');

const [key, ...rest] = process.argv.slice(2);
try {
  const now = key ? switches.set(key, rest.join(' ')) : switches.all({ fresh: true });
  for (const [k, v] of Object.entries(now)) console.log(`${k.padEnd(12)} ${v === '' ? '(off)' : v}`);
} catch (err) {
  console.error(err.message);
  console.error(`Switches: ${Object.keys(switches.DEFAULTS).join(', ')}`);
  process.exit(1);
}
