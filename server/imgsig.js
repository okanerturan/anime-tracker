'use strict';
// Signed image links (D9, 8.13). In hosted mode the front Worker serves /img/<sha1> straight from
// R2 without asking the hub, so the link itself carries proof that the app made it: an HMAC of the
// key and the current 7-day period. A link stays valid for 7 to 14 days (this period or the last);
// pages and the offline snapshots are re-rendered long before that. Unset key: links are unsigned.
const crypto = require('crypto');

const PERIOD_MS = 7 * 86400e3;
const period = (now = Date.now()) => Math.floor(now / PERIOD_MS);

function sign(hash, p = period(), key = process.env.IMAGE_SIGNING_KEY) {
  return crypto.createHmac('sha256', key).update(`${hash}.${p}`).digest('base64url').slice(0, 22);
}

/** The query suffix for a hashed image link ('' when signing is off). */
function suffix(hash, now = Date.now()) {
  return process.env.IMAGE_SIGNING_KEY ? `&s=${sign(hash, period(now))}` : '';
}

module.exports = { sign, suffix, period, PERIOD_MS };
