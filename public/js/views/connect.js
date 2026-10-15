// Connect page (hosted mode): link this browser's extension to the account. With the extension
// installed, one button hands it a sync token through its bridge script; otherwise a pairing code.
import { h, fill, section, toast } from '../ui.js';
import { authPost } from '../passkey.js';

export async function render(view) {
  const state = await fetch('/auth/state').then((r) => r.json()).catch(() => ({}));
  if (!state.signedIn) { location.href = `/signin.html?next=${encodeURIComponent('#/connect')}`; return; }
  const phone = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const version = document.documentElement.dataset.trackerExtension || null;
  const out = h('div', { role: 'status' });

  const connect = h('button', { type: 'button', class: 'btn primary' }, 'Connect this browser\'s extension');
  connect.addEventListener('click', async () => {
    connect.disabled = true;
    try {
      const { token } = await authPost('/auth/device/connect', { name: navigator.userAgent.includes('Edg/') ? 'Edge extension' : 'Chrome extension' });
      const answer = new Promise((resolve) => {
        const on = (e) => { if (e.source === window && e.data?.source === 'anime-tracker-extension') { window.removeEventListener('message', on); resolve(e.data); } };
        window.addEventListener('message', on);
        setTimeout(() => resolve({ connected: false, error: 'the extension didn\'t answer' }), 4000);
      });
      window.postMessage({ source: 'anime-tracker-connect', token }, location.origin);
      const r = await answer;
      fill(out, r.connected
        ? h('p', { class: 'signin-note' }, 'Connected. The extension is syncing your Crunchyroll history now; it keeps doing so on its own.')
        : h('p', { class: 'signin-note bad' }, `Couldn't hand it over (${r.error}). Use a pairing code instead.`));
    } catch (err) { toast(err.message); }
    connect.disabled = false;
  });

  const codeOut = h('div');
  const pair = h('button', { type: 'button', class: 'btn' }, 'Show a pairing code');
  pair.addEventListener('click', async () => {
    try {
      const r = await authPost('/auth/device/pairing-code');
      fill(codeOut, h('p', {}, 'In the extension: Settings → Pairing code, enter ', h('b', { class: 'num pair-code' }, r.code), `. Valid for ${r.minutes} minutes, once.`));
    } catch (err) { toast(err.message); }
  });

  fill(view, section('Connect Crunchyroll', 'The extension reads your watch history in your browser and syncs it here',
    h('div', { class: 'panel connect-panel' },
      phone ? h('p', {}, `Syncing runs from the extension in Chrome on a computer. Open ${location.host} there and come back to this page.`) : null,
      version ? h('p', { class: 'muted' }, `Extension ${version} is installed in this browser.`) : h('p', { class: 'muted' }, 'The extension isn\'t installed in this browser yet (Chrome or Edge on a computer). Once it is, reload this page.'),
      h('div', { class: 'hero-actions' }, version && !phone ? connect : null, pair),
      out, codeOut)));
}
