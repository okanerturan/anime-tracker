'use strict';
// The sign-in page in a real browser: invite link → passkey → recovery codes → app; then sign out,
// open a deep link, sign in, and land back on it. Screenshots go to SHOTS_DIR when set.
//   node scripts/signin-ui-e2e.js   (needs Google Chrome)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-ui-'));
const PORT = 8319;
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || null;
const env = { ...process.env, AUTH_MODE: 'accounts', DATA_DIR: tmp, RP_ID: 'localhost', APP_ORIGIN: ORIGIN, NO_SYNC: '1', PORT: String(PORT), HOST: 'localhost', SIGNUP: 'invite' };
const invite = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./server/accounts/invites').create())"], { cwd: ROOT, env }).toString();

function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const waits = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } };
  return { ready: new Promise((r) => { ws.onopen = r; }), send: (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 40 && !/running/.test(log); i += 1) await wait(250);
  const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--remote-debugging-port=9336', '--no-first-run', '--window-size=1200,900',
      // Lets the test load the real extension from this repo over the DevTools protocol (Chrome
      // ignores --load-extension); then the Connect page's handoff is tested end to end.
      '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: 'ignore' });
  let ok = true;
  const check = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); if (!cond) ok = false; };
  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i += 1) { await wait(250); try { page = (await (await fetch('http://127.0.0.1:9336/json/list')).json()).find((t) => t.type === 'page'); } catch {} }
    const browser = cdp((await (await fetch('http://127.0.0.1:9336/json/version')).json()).webSocketDebuggerUrl); await browser.ready;
    const loaded = await browser.send('Extensions.loadUnpacked', { path: path.join(ROOT, 'extension') });
    if (loaded.error) console.log(`note: extension not loaded (${loaded.error.message})`);
    const p = cdp(page.webSocketDebuggerUrl); await p.ready;
    await p.send('WebAuthn.enable');
    await p.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    const go = async (url) => { await p.send('Page.navigate', { url }); await wait(1500); };
    const run = async (expr) => (await p.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    const shot = async (name) => { if (!SHOTS) return; const r = await p.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64')); };

    await go(`${ORIGIN}/signin.html?invite=${encodeURIComponent(invite)}`);
    check('invite page explains passkeys', /You.re invited/.test(await run('document.body.innerText')) && /passkey/i.test(await run('document.body.innerText')));
    await shot('1-invite');
    await run("document.querySelector('input').value = 'Okan'; document.querySelector('form').requestSubmit(); 'ok'");
    await wait(2000);
    const codes = await run("[...document.querySelectorAll('.codes li')].map((li) => li.textContent)");
    check('shows 10 recovery codes', codes?.length === 10, JSON.stringify(codes?.slice(0, 2)));
    check('Continue waits for "I saved these"', await run("document.querySelector('.btn.primary').disabled"));
    await shot('2-codes');
    await run("document.getElementById('saved').click(); document.querySelector('.btn.primary').click(); 'ok'");
    await wait(2500);
    check('lands in the app, signed in', (await run('location.hash')) === '#/up-next' && (await run("fetch('/api/up-next').then((r) => r.status)")) === 200);
    await shot('3-app');

    // Connect: the extension's bridge script takes the token; the extension then syncs with it.
    await go(`${ORIGIN}/#/connect`); await wait(1000);
    check('the Connect page sees the installed extension', /is installed in this browser/.test(await run('document.body.innerText')), (await run('document.body.innerText')).slice(0, 200));
    await run("[...document.querySelectorAll('button')].find((b) => /Connect this browser/.test(b.textContent))?.click(); 'ok'");
    await wait(3000);
    check('hands the token to the extension', /Connected\. The extension is syncing/.test(await run('document.body.innerText')), (await run('document.body.innerText')).slice(-200));
    await wait(2500);
    const devs = await run("fetch('/auth/devices').then((r) => r.json())");
    check('the extension syncs with it on its own', devs?.devices?.length === 1 && Boolean(devs.devices[0].lastSyncAt), JSON.stringify(devs?.devices));
    await shot('5b-connect');
    // Account page: header button, rename a passkey, new recovery codes, export.
    check('the header shows an account button', (await run("document.querySelector('.account-btn')?.textContent")) === 'O');
    await go(`${ORIGIN}/#/account`); await wait(1000);
    check('account page lists the passkey and the connected browser', (await run("document.querySelectorAll('.account-row input').length")) === 1 && /Chrome extension/.test(await run('document.body.innerText')));
    await run("const i = document.querySelector('.account-row input'); i.value = 'Work laptop'; i.dispatchEvent(new Event('change')); 'ok'");
    await wait(600);
    check('renames it', (await run("fetch('/auth/passkeys').then((r) => r.json()).then((j) => j.passkeys[0].name)")) === 'Work laptop');
    await run("[...document.querySelectorAll('button')].find((b) => /new recovery codes/.test(b.textContent)).click(); 'ok'");
    await wait(800);
    const newCodes = await run("[...document.querySelectorAll('.account-codes li')].map((li) => li.textContent)");
    check('makes new recovery codes on the page', newCodes?.length === 10);
    if (newCodes?.length) codes.splice(0, codes.length, ...newCodes); // the sign-up set no longer works
    await shot('6-account');
    check('export downloads the account as JSON', (await run("fetch('/auth/account/export').then((r) => r.json()).then((j) => j.format)")) === 'anime-tracker-account-export');
    await run("fetch('/auth/signout', { method: 'POST', headers: { 'X-Tracker-Client': 'app' } }).then((r) => r.status)");
    await go(`${ORIGIN}/privacy.html`);
    check('privacy page is readable signed out', /What is kept/.test(await run('document.body.innerText')));
    await shot('7-privacy');
    await go(`${ORIGIN}/signin.html`);
    await run("[...document.querySelectorAll('button')].find((b) => /Sign in with a passkey/.test(b.textContent)).click(); 'ok'");
    await wait(2000);
    await run("fetch('/auth/signout', { method: 'POST', headers: { 'X-Tracker-Client': 'app' } }).then((r) => r.status)");
    await go(`${ORIGIN}/#/library?anime=37430`);
    await wait(1500);
    check('a signed-out deep link goes to sign-in', (await run('location.pathname')) === '/signin.html' && /next=/.test(await run('location.search')), await run('location.href'));
    await shot('4-signin');
    await run("[...document.querySelectorAll('button')].find((b) => /Sign in with a passkey/.test(b.textContent)).click(); 'ok'");
    await wait(2500);
    check('signing in returns to the deep link', (await run('location.hash')) === '#/library?anime=37430', await run('location.href'));

    await run("fetch('/auth/signout', { method: 'POST', headers: { 'X-Tracker-Client': 'app' } }).then((r) => r.status)");
    await go(`${ORIGIN}/signin.html`);
    await run("[...document.querySelectorAll('button')].find((b) => /recovery code/.test(b.textContent)).click(); 'ok'");
    await wait(300);
    await run(`document.querySelector('input').value = ${JSON.stringify(codes?.[0] || '')}; document.querySelector('form').requestSubmit(); 'ok'`);
    await wait(1500);
    check('a recovery code signs in and offers to add a passkey', /You.re in/.test(await run('document.body.innerText')) && /9 recovery codes left/.test(await run('document.body.innerText')), await run('document.body.innerText.slice(0, 160)'));
    await shot('5-recovered');
    p.close();
  } catch (err) { check('run', false, err.message); }
  chrome.kill(); server.kill();
  if (!ok) console.log(log.split('\n').slice(-12).join('\n'));
  await wait(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(ok ? 'sign-in page: all checks passed' : 'sign-in page: FAILED');
  process.exit(ok ? 0 : 1);
})();
