'use strict';
// End-to-end passkey check with a real browser: headless Chrome + its virtual authenticator.
//   node scripts/passkey-e2e.js            (needs Google Chrome installed)
// Registers a passkey for a new account, signs in with it, and confirms a sign-in answer is
// refused when the server expects a different origin. Uses a throwaway data directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-e2e-'));
const PORT = 8317;
process.env.AUTH_MODE = 'accounts';
process.env.DATA_DIR = tmp;
process.env.RP_ID = 'localhost';
process.env.APP_ORIGIN = `http://localhost:${PORT}`;
const store = require('../server/accounts/store');
const passkeys = require('../server/accounts/passkeys');

const accountId = store.adb().prepare("INSERT INTO accounts (display_name) VALUES ('e2e')").run().lastInsertRowid;

// Minimal page: converts WebAuthn JSON options to browser objects and back (base64url).
const PAGE = `<!doctype html><meta charset="utf-8"><script>
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function post(p, body) { const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }
window.register = async () => {
  const { flow, options: o } = await post('/reg/options', {});
  const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: unb64(o.challenge), user: { ...o.user, id: unb64(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: unb64(c.id) })) } });
  const r = cred.response;
  return post('/reg/verify', { flow, response: { id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: {}, response: { clientDataJSON: b64(r.clientDataJSON), attestationObject: b64(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } } });
};
window.signIn = async (path = '/auth/verify') => {
  const { flow, options: o } = await post('/auth/options', {});
  const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: unb64(o.challenge), allowCredentials: [] } });
  const r = cred.response;
  return post(path, { flow, response: { id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: {}, response: { clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : undefined } } });
};
</script>`;

const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    const b = await body(req);
    if (req.url === '/reg/options') return send(200, await passkeys.registrationOptions(accountId, 'e2e'));
    if (req.url === '/reg/verify') return send(200, { id: await passkeys.finishRegistration(b.flow, b.response, 'Headless Chrome') });
    if (req.url === '/auth/options') return send(200, await passkeys.authenticationOptions());
    if (req.url === '/auth/verify') return send(200, { accountId: await passkeys.finishAuthentication(b.flow, b.response) });
    if (req.url === '/auth/verify-wrong-origin') {
      process.env.APP_ORIGIN = 'https://evil.example';
      try { return send(200, { accountId: await passkeys.finishAuthentication(b.flow, b.response) }); }
      finally { process.env.APP_ORIGIN = `http://localhost:${PORT}`; }
    }
    send(404, { error: 'not found' });
  } catch (err) { send(err.status || 500, { error: err.message }); }
});

function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const waits = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
  return { ready: new Promise((r) => { ws.onopen = r; }), send: (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}

(async () => {
  await new Promise((r) => server.listen(PORT, 'localhost', r));
  const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=9334', '--no-first-run', `http://localhost:${PORT}/`], { stdio: 'ignore' });
  let ok = true;
  const check = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); if (!cond) ok = false; };
  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try { page = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${PORT}`)); } catch {}
    }
    if (!page) throw new Error('Chrome did not open the page');
    const p = cdp(page.webSocketDebuggerUrl); await p.ready;
    await p.send('WebAuthn.enable');
    await p.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    const run = async (expr) => { const r = await p.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description || 'error' } : r.result?.result?.value; };
    const reg = await run('register().then((r) => r, (e) => ({ error: e.message }))');
    check('registers a passkey', reg && reg.id && !reg.error, reg?.error);
    const stored = store.adb().prepare('SELECT name, account_id FROM passkeys').get();
    check('stores it for the account', stored?.account_id === Number(accountId) && stored?.name === 'Headless Chrome');
    const signed = await run('signIn().then((r) => r, (e) => ({ error: e.message }))');
    check('signs in with it', signed?.accountId === Number(accountId), signed?.error);
    const wrong = await run("signIn('/auth/verify-wrong-origin').then((r) => r, (e) => ({ error: e.message }))");
    check('refuses an answer when the server expects another origin', Boolean(wrong?.error), wrong?.error || 'accepted');
    p.close();
  } catch (err) { check('run', false, err.message); }
  chrome.kill(); server.close(); store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? 'passkeys: all checks passed' : 'passkeys: FAILED');
  process.exit(ok ? 0 : 1);
})();
