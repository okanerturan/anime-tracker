#!/usr/bin/env node
// Chrome Web Store images, rendered from the real extension code: two 1280×800 screenshots (the popup,
// the Crunchyroll card) and the 440×280 promo tile, into releases/store/. The popup runs against a copy
// of a local database through a throwaway tracker; nothing is sent anywhere.
//   node scripts/store-assets.mjs [path/to/anime-tracker.db]   (default: data/anime-tracker.db; needs Chrome)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const out = path.join(root, 'releases', 'store');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TRACKER = 8170; const HARNESS = 8171; const DEBUG = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'store-assets-'));
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(process.argv[2] || path.join(root, 'data', 'anime-tracker.db'), path.join(tmp, 'a.db'));

const tracker = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, NO_SYNC: '1', PORT: String(TRACKER), ANIME_DB: path.join(tmp, 'a.db'), DATA_DIR: tmp } });

// The card's sample: a show with an earlier season, the way it looks on a series page.
const cardInfo = { trackerUrl: `http://127.0.0.1:${HARNESS}`, shows: [
  { malId: 0, title: 'Frieren: Beyond Journey’s End', watched: 28, aired: 28, rating: 5, status: 'FINISHED' },
  { malId: 1, title: 'Frieren: Beyond Journey’s End Season 2', watched: 4, aired: 10, nextEpisode: 5, nextEpisodeUrl: 'https://www.crunchyroll.com/watch/X', status: 'RELEASING' }] };
const popupState = { trackerUrl: `http://127.0.0.1:${HARNESS}`, trackerKey: '', lastSync: new Date(Date.now() - 4 * 60000).toISOString(), lastResult: { fetched: 40, marked: 0 }, lastError: null, notifyNew: true, overlay: true };

const glow = 'background: radial-gradient(70% 90% at 75% 40%, #2a2f6b 0%, #161830 45%, #0f1016 100%);';
const logo = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 200 200" aria-hidden="true"><rect width="200" height="200" rx="46" fill="#1d2056"/><g transform="translate(0 -6)"><path d="M38 82 C72 50 150 46 163 94 C172 132 134 162 86 152" fill="none" stroke="#8f93ff" stroke-width="26" stroke-linecap="round"/><circle cx="86" cy="152" r="17" fill="#ffcd3c"/></g></svg>`;
const page = (w, h, body) => `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:system-ui,-apple-system,sans-serif;color:#eef0f5;${glow}}
.brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:28px;letter-spacing:-.01em}
h1{font-size:54px;line-height:1.05;letter-spacing:-.025em;margin:0}p{font-size:22px;line-height:1.45;color:#b7bbc9;margin:0}iframe{border:0;display:block}</style>${body}`;
const shot = (title, text, frame) => page(1280, 800, `<div style="display:grid;grid-template-columns:520px 1fr;gap:56px;align-items:center;height:100%;padding:0 72px">
  <div style="display:flex;flex-direction:column;gap:26px"><div class="brand">${logo(48)}Tsuzuku</div><h1>${title}</h1><p>${text}</p></div>
  <div style="display:grid;place-items:center">${frame}</div></div>`);
const pages = {
  '/shot-popup.html': shot('Up next, one click from Crunchyroll', 'Every show you’re watching with its next episode, what’s left, and when the next one airs. Play opens it on Crunchyroll.',
    '<iframe src="/popup.html" width="500" height="640" style="border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55);background:#13151b"></iframe>'),
  '/shot-card.html': shot('Your progress on every show page', 'Open a series on Crunchyroll and see how far you are, play the next episode, or rate, hold or drop it.',
    '<div style="width:520px;height:640px;border-radius:22px;background:linear-gradient(160deg,#2b2e3e,#17181f);box-shadow:0 30px 80px rgba(0,0,0,.55);position:relative;overflow:hidden"><iframe src="/series/GDEMO" width="340" height="420" style="position:absolute;right:-20px;bottom:-20px;transform:scale(1.45);transform-origin:right bottom;background:transparent" allowtransparency="true"></iframe></div>'),
  '/promo.html': page(440, 280, `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:0 34px"><div class="brand" style="font-size:34px">${logo(58)}Tsuzuku</div><p style="font-size:19px;color:#d4d6e2">Your Crunchyroll history,<br>turned into a watch list.</p></div>`)
};

const harness = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (/^\/(api|img)\//.test(u.pathname)) {
    try {
      const r = await fetch(`http://127.0.0.1:${TRACKER}${req.url}`);
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502); return res.end(); }
  }
  if (pages[u.pathname]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(pages[u.pathname]); }
  if (u.pathname === '/popup.html') {
    const html = fs.readFileSync(path.join(ext, 'popup.html'), 'utf8')
      .replace('<script src="popup.js"></script>', `<script>window.chrome={runtime:{sendMessage:(m,cb)=>cb&&cb(${JSON.stringify(popupState)})}};</script><script src="popup.js"></script>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  if (u.pathname.startsWith('/series/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><script>window.chrome={runtime:{getURL:(p)=>'/'+p,sendMessage:async()=>(${JSON.stringify(cardInfo)})}};</script><script src="/cr-overlay.js"></script></body>`);
  }
  const f = path.join(ext, path.normalize(u.pathname).replace(/^\/+/, ''));
  if (f.startsWith(ext) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : f.endsWith('.png') ? 'image/png' : 'text/plain' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end();
}).listen(HARNESS);

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(tmp, 'chrome')}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  await sleep(2500);
  let target; for (let i = 0; i < 50 && !target; i += 1) { try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(150); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m.result); });
  const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  // Rendered at 2x, then scaled to the exact size the store asks for (sharper than rendering at 1x).
  for (const [name, w, h] of [['shot-popup', 1280, 800], ['shot-card', 1280, 800], ['promo', 440, 280]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${HARNESS}/${name}.html` });
    await sleep(4000);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, `${name}-${w}x${h}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    execFileSync('sips', ['-z', String(h), String(w), file], { stdio: 'ignore' });
    console.log(file);
  }
} finally {
  chrome.kill(); tracker.kill(); harness.close();
  await sleep(300); fs.rmSync(tmp, { recursive: true, force: true });
}
