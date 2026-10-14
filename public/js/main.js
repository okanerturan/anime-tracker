import { api } from './api.js';
import { runRelay } from './anilist-relay.js';
import { bus } from './bus.js';
import { h } from './ui.js';
import { closeDrawer, openAnime } from './drawer.js';
import * as upnext from './views/upnext.js';
import * as library from './views/library.js';
import * as discover from './views/discover.js';
import * as insights from './views/insights.js';
import * as sync from './views/sync.js';

const VIEWS = { 'up-next': upnext, library, discover, insights, sync };
const view = document.getElementById('view');

async function route() {
  const name = (location.hash.replace(/^#\//, '') || 'up-next').split('?')[0];
  const mod = VIEWS[name] || upnext;
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  closeDrawer();
  try {
    await mod.render(view);
    // Deep link: #/<view>?anime=<malId> opens that show's detail panel.
    const anime = new URLSearchParams(location.hash.split('?')[1] || '').get('anime');
    if (anime) openAnime({ malId: Number(anime) });
  } catch (err) {
    view.replaceChildren(h('div', { class: 'empty' }, `Couldn't load: ${err.message}`));
  }
}

async function updateStatus() {
  try {
    const cr = await api.crStatus();
    const el = document.getElementById('topbar-status');
    const at = cr.lastSync ? new Date(cr.lastSync.at) : null;
    el.textContent = at ? `Crunchyroll synced ${at.toLocaleString()}` : 'Crunchyroll not synced yet';
    const badge = document.getElementById('sync-badge');
    badge.hidden = !cr.needsReview.length;
    badge.textContent = cr.needsReview.length;
  } catch {}
}

// Theme: dark (default) -> light -> system
const THEMES = ['dark', 'light', 'system'];
const THEME_GLYPH = { dark: '☾', light: '☀', system: '◐' };
const themeBtn = document.getElementById('theme-btn');
function paintThemeButton() {
  const t = document.documentElement.dataset.theme || 'dark';
  themeBtn.textContent = THEME_GLYPH[t];
  themeBtn.setAttribute('aria-label', `Theme: ${t}`);
  themeBtn.title = `Theme: ${t} (click to change)`;
}
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || 'dark';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  paintThemeButton();
});
paintThemeButton();

window.addEventListener('hashchange', route);
route();
updateStatus();
setInterval(updateStatus, 60000);

// AniList relay: when the hosted server is blocked by AniList, this browser fills in the queued
// requests (new metadata, air times, season lookups) whenever the app is open.
async function relayTick() {
  const ran = await runRelay();
  if (ran) bus.emit('library-changed');
}
setTimeout(relayTick, 3000);
setInterval(relayTick, 10 * 60 * 1000);
