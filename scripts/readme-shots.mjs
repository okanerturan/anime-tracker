#!/usr/bin/env node
// README screenshots (docs/screenshots/*.jpg) from the running app on a copy of a local database:
// Up Next, Library, a show's details, Discover, Insights and Sync, at 1280 px wide and 2x.
//   node scripts/readme-shots.mjs [path/to/anime-tracker.db] [malId for the details shot]   (needs Chrome)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8180; const DEBUG = 9381;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-'));
fs.copyFileSync(process.argv[2] || path.join(root, 'data', 'anime-tracker.db'), path.join(tmp, 'a.db'));
const detail = process.argv[3] || '62080';

const app = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, NO_SYNC: '1', PORT: String(PORT), ANIME_DB: path.join(tmp, 'a.db') } });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${path.join(tmp, 'chrome')}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

// [file, hash route, height, script run before the capture]
const shots = [
  ['up-next', '#/up-next', 1500],
  ['library', '#/library', 1100],
  ['detail', `#/library?anime=${detail}`, 1100],
  ['discover', '#/discover', 1300],
  ['insights', '#/insights', 1500],
  ['sync', '#/sync', 1100]
];
try {
  await sleep(2500);
  let target; for (let i = 0; i < 50 && !target; i += 1) { try { target = (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(150); }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m.result); });
  const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, route, h] of shots) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: h, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${route}` });
    await sleep(5000); // posters load lazily through the image cache
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    const file = path.join(out, `${name}.jpg`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    execFileSync('sips', ['-Z', '1600', file], { stdio: 'ignore' }); // 1600 px wide keeps the repo light
    console.log(file);
  }
} finally {
  chrome.kill(); app.kill();
  await sleep(300); fs.rmSync(tmp, { recursive: true, force: true });
}
