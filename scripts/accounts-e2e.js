'use strict';
// End-to-end check of hosted sign-in against the real app server: invite → passkey sign-up →
// data → sign out → passkey sign-in → recovery code → sign out everywhere. Headless Chrome with its
// virtual authenticator plays the browser.   node scripts/accounts-e2e.js   (needs Google Chrome)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-e2e-'));
const PORT = 8318;
const ORIGIN = `http://localhost:${PORT}`;
const env = { ...process.env, AUTH_MODE: 'accounts', DATA_DIR: tmp, RP_ID: 'localhost', APP_ORIGIN: ORIGIN, NO_SYNC: '1', PORT: String(PORT), HOST: 'localhost', SIGNUP: 'invite' };

// An invite, made the way an operator would (straight against accounts.db).
const invite = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./server/accounts/invites').create({ note: 'e2e' }))"], { cwd: ROOT, env }).toString();
const invite2 = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./server/accounts/invites').create({ note: 'e2e second' }))"], { cwd: ROOT, env }).toString();

const HELPERS = `
window.b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
window.unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
window.post = async (p, body) => { const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
window.httpStatus = async (p) => (await fetch(p)).status;
window.attest = (cred) => ({ id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: {}, response: { clientDataJSON: b64(cred.response.clientDataJSON), attestationObject: b64(cred.response.attestationObject), transports: cred.response.getTransports() } });
window.assertion = (cred) => ({ id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: {}, response: { clientDataJSON: b64(cred.response.clientDataJSON), authenticatorData: b64(cred.response.authenticatorData), signature: b64(cred.response.signature), userHandle: cred.response.userHandle ? b64(cred.response.userHandle) : undefined } });
window.create = async (o) => navigator.credentials.create({ publicKey: { ...o, challenge: unb64(o.challenge), user: { ...o.user, id: unb64(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: unb64(c.id) })) } });
window.getCred = async (o) => navigator.credentials.get({ publicKey: { ...o, challenge: unb64(o.challenge), allowCredentials: [] } });
'done'`;

function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const waits = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
  return { ready: new Promise((r) => { ws.onopen = r; }), send: (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 40 && !/running/.test(log); i += 1) await new Promise((r) => setTimeout(r, 250));
  const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=9335', '--no-first-run', `${ORIGIN}/manifest.webmanifest`], { stdio: 'ignore' });
  let ok = true;
  const check = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); if (!cond) ok = false; };
  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try { page = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find((t) => t.type === 'page'); } catch {}
    }
    if (!page) throw new Error('Chrome did not start');
    const p = cdp(page.webSocketDebuggerUrl); await p.ready;
    await p.send('Page.navigate', { url: `${ORIGIN}/favicon.svg` });
    await new Promise((r) => setTimeout(r, 800));
    await p.send('WebAuthn.enable');
    await p.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    const run = async (expr) => { const r = await p.send('Runtime.evaluate', { expression: `(async () => { try { return await (${expr}); } catch (e) { return { error: e.message }; } })()`, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
    await run(`(() => { ${HELPERS} })()`);

    check('data needs sign-in', (await run("httpStatus('/api/up-next')")) === 401);
    const signup = await run(`(async () => { const { flow, options } = await post('/auth/signup/options', { invite: ${JSON.stringify(invite)}, name: 'Okan' }); return post('/auth/signup/verify', { flow, invite: ${JSON.stringify(invite)}, response: attest(await create(options)) }); })()`);
    check('signs up with the invite and a passkey', signup?.ok === true, signup?.error);
    const codes = signup?.recoveryCodes || [];
    check('gets 10 recovery codes once', codes.length === 10);
    check('data loads once signed in', (await run("httpStatus('/api/up-next')")) === 200);
    const again = await run(`post('/auth/signup/options', { invite: ${JSON.stringify(invite)} })`);
    check('the invite only works once', /already been used/.test(again?.error || ''), again?.error);
    const state = await run("fetch('/auth/state').then((r) => r.json())");
    check('knows who is signed in', state?.signedIn && state.account?.name === 'Okan' && state.passkeys === 1, JSON.stringify(state));

    await run("post('/auth/signout')");
    check('signing out ends access', (await run("httpStatus('/api/up-next')")) === 401);
    const signin = await run("(async () => { const { flow, options } = await post('/auth/signin/options'); return post('/auth/signin/verify', { flow, response: assertion(await getCred(options)) }); })()");
    check('signs back in with the passkey', signin?.ok === true && (await run("httpStatus('/api/up-next')")) === 200, signin?.error);

    await run("post('/auth/signout')");
    const rec = await run(`post('/auth/recover', { code: ${JSON.stringify(codes[0] || '')} })`);
    check('a recovery code signs in and asks for a new passkey', rec?.ok && rec.addPasskey && rec.recoveryCodesLeft === 9, rec?.error);
    const reuse = await run(`(async () => { await post('/auth/signout'); return post('/auth/recover', { code: ${JSON.stringify(codes[0] || '')} }); })()`);
    check('a used recovery code is refused', Boolean(reuse?.error));

    await run(`post('/auth/recover', { code: ${JSON.stringify(codes[1] || '')} })`);
    await run("post('/auth/signout-everywhere')");
    check('sign out everywhere ends the session', (await run("httpStatus('/api/up-next')")) === 401);
    // Passkey management (signed in again with a code): rename; the last one needs fresh codes first.
    await run(`post('/auth/recover', { code: ${JSON.stringify(codes[2] || '')} })`);
    const list = await run("fetch('/auth/passkeys').then((r) => r.json())");
    check('lists the passkeys', list?.passkeys?.length === 1, JSON.stringify(list));
    const pkId = list?.passkeys?.[0]?.id;
    await run(`post('/auth/passkeys/rename', { id: ${JSON.stringify(pkId)}, name: 'Laptop' })`);
    check('renames one', (await run("fetch('/auth/passkeys').then((r) => r.json())"))?.passkeys?.[0]?.name === 'Laptop');
    // Codes made at sign-up count as fresh for 15 minutes; age them as if that time had passed.
    execFileSync(process.execPath, ['-e', "require('./server/accounts/store').adb().prepare(\"UPDATE accounts SET codes_at = '2020-01-01T00:00:00Z'\").run()"], { cwd: ROOT, env });
    const lastNo = await run(`post('/auth/passkeys/remove', { id: ${JSON.stringify(pkId)} })`);
    check('won\'t remove the last passkey without fresh codes', /last passkey/.test(lastNo?.error || ''), lastNo?.error);
    const fresh = await run("post('/auth/recovery/regenerate')");
    const lastYes = await run(`post('/auth/passkeys/remove', { id: ${JSON.stringify(pkId)} })`);
    check('removes it after new codes', fresh?.recoveryCodes?.length === 10 && lastYes?.ok === true, lastYes?.error);
    // Export, delete, sign up again, import: everything comes back.
    const sample = { format: 'anime-tracker-account-export', version: 1, tables: {
      anime: { columns: ['mal_id', 'title'], rows: [[101, 'Round Trip One'], [102, 'Round Trip Two']] },
      watchlist: { columns: ['mal_id'], rows: [[101], [102]] },
      episode_sync: { columns: ['mal_id', 'episode_number', 'watched', 'image_blob'], rows: [[101, 1, 1, 'should-not-import'], [101, 2, 0, null]] },
      not_a_table: { columns: ['x'], rows: [[1]] } } };
    const code3 = (await run("post('/auth/recovery/regenerate')"))?.recoveryCodes?.[0];
    const imported = await run(`post('/auth/account/import', ${JSON.stringify(sample)})`);
    check('imports an export', imported?.imported?.watchlist === 2 && imported.imported.episode_sync === 2 && !('not_a_table' in imported.imported), JSON.stringify(imported));
    const exported = await run("fetch('/auth/account/export').then((r) => r.json())");
    check('exports it back', exported?.tables?.watchlist?.rows?.length === 2 && !exported.tables.episode_sync.columns.includes('image_blob'));
    const deleted = await run(`post('/auth/account/delete', { code: ${JSON.stringify(code3 || '')} })`);
    check('deletes the account with a recovery code', deleted?.deleted === true, deleted?.error);
    check('signed out and the data file is gone', !(await run("fetch('/auth/state').then((r) => r.json())"))?.signedIn && !fs.existsSync(path.join(tmp, 'accounts', '1.db')));
    const ghost = await run("(async () => { const { flow, options } = await post('/auth/signin/options'); return post('/auth/signin/verify', { flow, response: assertion(await getCred(options)) }); })()");
    check('its passkey no longer signs in', Boolean(ghost?.error), ghost?.error || 'signed in');
    const again2 = await run(`(async () => { const { flow, options } = await post('/auth/signup/options', { invite: ${JSON.stringify(invite2)}, name: 'Okan again' }); return post('/auth/signup/verify', { flow, invite: ${JSON.stringify(invite2)}, response: attest(await create(options)) }); })()`);
    await run(`(window.__exp = ${JSON.stringify(exported)}, 'set')`);
    const restored = await run("post('/auth/account/import', window.__exp)");
    check('a new account takes the export back in', again2?.ok && restored?.imported?.watchlist === 2 && restored.imported.anime === 2, JSON.stringify(restored));
    // Extension token: reaches only the extension's routes; revoked, its next sync gets 401.
    const conn = await run("post('/auth/device/connect', { name: 'Chrome extension' })");
    const token = conn?.token;
    check('mints an extension token for the signed-in account', /^trk_/.test(token || ''), conn?.error);
    const keys = JSON.parse(execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./server/routes').routeKeys()))"], { cwd: ROOT, env }).toString());
    const allowed = new Set(JSON.parse(execFileSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify([...require('./server/accounts/devices').DEVICE_ROUTES]))"], { cwd: ROOT, env }).toString()));
    const wrong = [];
    for (const k of keys.filter((x) => / \/api\//.test(x))) {
      const [method, p2] = k.split(' ');
      const r = await fetch(`${ORIGIN}${p2}`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Tracker-Client': 'extension', 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      if (allowed.has(k) ? r.status === 403 : r.status !== 403) wrong.push(`${k}=${r.status}`);
    }
    check(`a device token gets 403 on every route outside the extension's ${allowed.size}`, wrong.length === 0, wrong.slice(0, 5).join(' '));
    const devs = await run("fetch('/auth/devices').then((r) => r.json())");
    check('lists the connected browser with its last sync', devs?.devices?.length === 1 && devs.devices[0].lastSyncAt, JSON.stringify(devs?.devices?.[0]));
    await run(`post('/auth/devices/revoke', { id: ${JSON.stringify(devs?.devices?.[0]?.id ?? 0)} })`);
    const after = await fetch(`${ORIGIN}/api/crunchyroll/status`, { headers: { Authorization: `Bearer ${token}` } });
    check('a revoked token\'s next sync gets 401', after.status === 401);
    // Wrong recovery codes run into the limit.
    await run("post('/auth/signout')");
    const statuses = await run("(async () => { const out = []; for (let i = 0; i < 12; i += 1) { const r = await fetch('/auth/recover', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' }, body: JSON.stringify({ code: 'wrong-guess' }) }); out.push(r.status + ':' + (r.headers.get('retry-after') || '')); } return out; })()");
    check('wrong recovery codes are rate limited', statuses?.slice(-1)[0]?.startsWith('429:') && Number(statuses.slice(-1)[0].split(':')[1]) > 0, (statuses || []).join(' '));
    check('the server logged no secrets', !log.includes(codes[0] || 'none') && !/tracker_session=/.test(log) && !log.includes(invite));
    const forged = await run("fetch('/auth/signin/options', { method: 'POST' }).then((r) => r.status)");
    check('auth posts without the client header are refused', forged === 403);
    p.close();
  } catch (err) { check('run', false, err.message); }
  chrome.kill(); server.kill();
  if (!ok) console.log(log.split('\n').slice(-15).join('\n'));
  await new Promise((r) => setTimeout(r, 500)); // Chrome finishes writing its profile
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(ok ? 'accounts: all checks passed' : 'accounts: FAILED');
  process.exit(ok ? 0 : 1);
})();
