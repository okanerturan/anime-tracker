'use strict';
// Hosted-mode sign-in endpoints and the gate in front of the app's data (D5, D7).
//
// The gate: a request belongs to an account through a session cookie or an extension device token
// (Authorization: Bearer). Without one, /api/* answers 401 and the page shell (which holds no data)
// sends the visitor to /signin.html. Cross-site requests can't forge a mutation: the cookie is
// SameSite=Lax and mutating routes require the X-Tracker-Client header (no CORS is offered).
const { adb, sha256 } = require('./store');
const sessions = require('./sessions');
const passkeys = require('./passkeys');
const invites = require('./invites');
const recovery = require('./recovery');
const limits = require('./limits');
const data = require('./data');
const devices = require('./devices');
const { withAccount } = require('../db');
const { sendJSON, parseBody } = require('../http');

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
/** Count an attempt; past the limit, answer 429 with Retry-After. */
function limit(rule, who) {
  const r = limits.hit(rule, who);
  if (!r.ok) throw fail(429, `Too many attempts. Try again in ${Math.ceil(r.retryAfter / 60)} min.`, { retryAfter: r.retryAfter });
}
const signedIn = (req, res) => {
  const who = authenticate(req, res);
  if (!who || who.via !== 'session') throw fail(401, 'Sign in first.');
  return who.accountId;
};

function deviceAccount(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S{20,200})$/);
  if (!m) return null;
  const row = adb().prepare('SELECT account_id FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(m[1]));
  if (!row) return null;
  adb().prepare("UPDATE device_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(sha256(m[1]));
  // The extension syncing counts as using the account (the 24-month inactivity rule must not
  // delete someone who only ever syncs).
  adb().prepare("UPDATE accounts SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.account_id);
  return row.account_id;
}

/**
 * Which account this request is, or null. A session older than 30 days is rotated here (the new
 * cookie goes out on this response).
 */
function authenticate(req, res) {
  const device = deviceAccount(req);
  if (device) return { accountId: device, via: 'device' };
  const s = sessions.resolve(sessions.fromRequest(req));
  if (!s) return null;
  if (s.rotated) res.setHeader('Set-Cookie', sessions.cookie(s.rotated));
  return { accountId: s.accountId, via: 'session' };
}

function startSession(req, res, accountId) {
  res.setHeader('Set-Cookie', sessions.cookie(sessions.create(accountId, { userAgent: req.headers['user-agent'] })));
}

const deviceName = (req, given) => String(given || '').trim().slice(0, 60)
  || (/iPhone|iPad/.test(req.headers['user-agent'] || '') ? 'iPhone or iPad' : /Android/.test(req.headers['user-agent'] || '') ? 'Android' : /Mac/.test(req.headers['user-agent'] || '') ? 'Mac' : 'This device');

// Mutating auth endpoints need the same header as the rest of the API (stops cross-site posts).
function requireClient(req) {
  if (!/^(app|extension)$/.test(String(req.headers['x-tracker-client'] || ''))) throw fail(403, 'missing X-Tracker-Client');
}

const ROUTES = {
  /** Public: is this browser signed in? */
  'GET /auth/state': (req, res) => {
    const who = authenticate(req, res);
    if (!who) return sendJSON(res, 200, { signedIn: false });
    const a = adb().prepare('SELECT id, display_name AS name FROM accounts WHERE id = ?').get(who.accountId);
    const keys = adb().prepare('SELECT COUNT(*) n FROM passkeys WHERE account_id = ?').get(who.accountId).n;
    return sendJSON(res, 200, { signedIn: true, account: a, passkeys: keys, recoveryCodesLeft: recovery.remaining(who.accountId) });
  },

  /** Sign up step 1: check the invite, make the account, and ask the browser for a passkey. */
  'POST /auth/signup/options': async (req, res) => {
    requireClient(req);
    const b = await parseBody(req);
    limit('signup', limits.clientIp(req));
    try { invites.check(b.invite || null); } catch (err) { limit('invite', limits.clientIp(req)); throw err; }
    const name = String(b.name || '').trim().slice(0, 40) || null;
    // The account exists from here, but without a passkey it can't be used; the invite is spent
    // only when the passkey is saved, and accounts left without one are cleared by a daily job.
    const accountId = adb().prepare('INSERT INTO accounts (display_name) VALUES (?)').run(name).lastInsertRowid;
    const { flow, options } = await passkeys.registrationOptions(accountId, name || `account-${accountId}`);
    return sendJSON(res, 200, { flow, options });
  },

  /** Sign up step 2: save the passkey, spend the invite, sign in, hand out recovery codes once. */
  'POST /auth/signup/verify': async (req, res) => {
    requireClient(req);
    const b = await parseBody(req);
    invites.check(b.invite || null);
    const passkeyId = await passkeys.finishRegistration(b.flow, b.response, deviceName(req, b.deviceName));
    const accountId = adb().prepare('SELECT account_id FROM passkeys WHERE id = ?').get(passkeyId).account_id;
    invites.spend(b.invite || null, accountId);
    startSession(req, res, accountId);
    return sendJSON(res, 200, { ok: true, recoveryCodes: recovery.regenerate(accountId) });
  },

  'POST /auth/signin/options': async (req, res) => { requireClient(req); return sendJSON(res, 200, await passkeys.authenticationOptions()); },
  'POST /auth/signin/verify': async (req, res) => {
    requireClient(req);
    const b = await parseBody(req);
    const ip = limits.clientIp(req);
    const allowed = limits.check('signinFail', ip);
    if (!allowed.ok) throw fail(429, `Too many failed sign-ins. Try again in ${Math.ceil(allowed.retryAfter / 60)} min.`, { retryAfter: allowed.retryAfter });
    let accountId;
    try { accountId = await passkeys.finishAuthentication(b.flow, b.response); } catch (err) { limits.hit('signinFail', ip); throw err; }
    startSession(req, res, accountId);
    return sendJSON(res, 200, { ok: true });
  },

  /** Lost every passkey: a recovery code signs in, and the page then asks for a new passkey. */
  'POST /auth/recover': async (req, res) => {
    requireClient(req);
    const b = await parseBody(req);
    limit('recover', limits.clientIp(req));
    const accountId = recovery.use(b.code);
    if (!accountId) throw fail(401, 'That code isn\'t valid or was already used.');
    startSession(req, res, accountId);
    return sendJSON(res, 200, { ok: true, addPasskey: true, recoveryCodesLeft: recovery.remaining(accountId) });
  },

  /** Signed in: add a passkey (another device, or after a recovery code). */
  'POST /auth/passkey/options': async (req, res) => {
    requireClient(req);
    const who = authenticate(req, res);
    if (!who || who.via !== 'session') throw fail(401, 'Sign in first.');
    return sendJSON(res, 200, await passkeys.registrationOptions(who.accountId));
  },
  'POST /auth/passkey/verify': async (req, res) => {
    requireClient(req);
    const who = authenticate(req, res);
    if (!who || who.via !== 'session') throw fail(401, 'Sign in first.');
    const b = await parseBody(req);
    await passkeys.finishRegistration(b.flow, b.response, deviceName(req, b.deviceName));
    return sendJSON(res, 200, { ok: true });
  },

  /** Signed in: the account's passkeys (named by device), for the account page. */
  'GET /auth/passkeys': (req, res) => {
    const accountId = signedIn(req, res);
    const list = adb().prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE account_id = ? ORDER BY created_at').all(accountId);
    return sendJSON(res, 200, { passkeys: list, recoveryCodesLeft: recovery.remaining(accountId) });
  },
  'POST /auth/passkeys/rename': async (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    const b = await parseBody(req);
    const r = adb().prepare('UPDATE passkeys SET name = ? WHERE id = ? AND account_id = ?').run(String(b.name || '').trim().slice(0, 60) || null, String(b.id || ''), accountId);
    if (!r.changes) throw fail(404, 'No such passkey.');
    return sendJSON(res, 200, { ok: true });
  },
  /** Remove a passkey. The last one only goes after a fresh set of recovery codes (made in the last 15 min). */
  'POST /auth/passkeys/remove': async (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    const b = await parseBody(req);
    const count = adb().prepare('SELECT COUNT(*) n FROM passkeys WHERE account_id = ?').get(accountId).n;
    if (count <= 1) {
      const at = adb().prepare('SELECT codes_at FROM accounts WHERE id = ?').get(accountId)?.codes_at;
      if (!at || Date.now() - Date.parse(at) > 15 * 60e3) throw fail(409, 'This is your last passkey. Make new recovery codes first, so you can still get in.', { needCodes: true });
    }
    const r = adb().prepare('DELETE FROM passkeys WHERE id = ? AND account_id = ?').run(String(b.id || ''), accountId);
    if (!r.changes) throw fail(404, 'No such passkey.');
    return sendJSON(res, 200, { ok: true });
  },
  /** A new set of recovery codes (the old set stops working); shown once. */
  'POST /auth/recovery/regenerate': (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    return sendJSON(res, 200, { recoveryCodes: recovery.regenerate(accountId) });
  },

  /** Everything that's yours, as a JSON download. */
  'GET /auth/account/export': (req, res) => {
    const accountId = signedIn(req, res);
    const body = JSON.stringify(withAccount(accountId, () => data.exportAccount()));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="anime-tracker-export-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(body);
  },
  /** Load an export into this account (rows already here win). */
  'POST /auth/account/import': async (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    const b = await parseBody(req);
    return sendJSON(res, 200, { imported: withAccount(accountId, () => data.importAccount(b)) });
  },
  /** Deleting the account is confirmed with a passkey (step 1 asks the browser) or a recovery code. */
  'POST /auth/account/delete/options': async (req, res) => { requireClient(req); signedIn(req, res); return sendJSON(res, 200, await passkeys.authenticationOptions()); },
  'POST /auth/account/delete': async (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    const b = await parseBody(req);
    let confirmed = null;
    if (b.code) { limit('recover', limits.clientIp(req)); confirmed = recovery.use(b.code); }
    else if (b.flow && b.response) confirmed = await passkeys.finishAuthentication(b.flow, b.response);
    if (confirmed !== accountId) throw fail(403, 'Confirm with one of this account\'s passkeys or recovery codes.');
    data.deleteFiles(accountId);
    adb().prepare('DELETE FROM accounts WHERE id = ?').run(accountId); // sessions, passkeys, codes, tokens go with it
    res.setHeader('Set-Cookie', sessions.cookie(null));
    return sendJSON(res, 200, { ok: true, deleted: true });
  },

  /** Connect page: a token for this browser's extension (handed to it directly), or a pairing code. */
  'POST /auth/device/connect': async (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    const b = await parseBody(req);
    return sendJSON(res, 200, { token: devices.mint(accountId, deviceName(req, b.name)) });
  },
  'POST /auth/device/pairing-code': (req, res) => { requireClient(req); return sendJSON(res, 200, { code: devices.pairingCode(signedIn(req, res)), minutes: 10 }); },
  /** The extension trades a pairing code for its token (no session: the code is the proof). */
  'POST /auth/device/pair': async (req, res) => {
    requireClient(req);
    limit('recover', limits.clientIp(req));
    const b = await parseBody(req);
    return sendJSON(res, 200, { token: devices.redeem(b.code, b.name) });
  },
  'GET /auth/devices': (req, res) => sendJSON(res, 200, { devices: devices.list(signedIn(req, res)), max: devices.MAX_DEVICES }),
  'POST /auth/devices/revoke': async (req, res) => {
    requireClient(req);
    const accountId = signedIn(req, res);
    const b = await parseBody(req);
    devices.revoke(accountId, b.id);
    return sendJSON(res, 200, { ok: true });
  },

  'POST /auth/signout': (req, res) => { requireClient(req); sessions.end(sessions.fromRequest(req)); res.setHeader('Set-Cookie', sessions.cookie(null)); return sendJSON(res, 200, { ok: true }); },
  'POST /auth/signout-everywhere': (req, res) => {
    requireClient(req);
    const who = authenticate(req, res);
    if (!who || who.via !== 'session') throw fail(401, 'Sign in first.');
    sessions.endAll(who.accountId);
    res.setHeader('Set-Cookie', sessions.cookie(null));
    return sendJSON(res, 200, { ok: true });
  }
};

/** Handles /auth/* routes; returns true when it answered. */
async function handle(req, res, url) {
  const route = ROUTES[`${req.method} ${url.pathname}`];
  if (!route) return false;
  try { await route(req, res); } catch (err) {
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    sendJSON(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.', ...(err.needCodes ? { needCodes: true } : {}) });
  }
  return true;
}

module.exports = { handle, authenticate };
