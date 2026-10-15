import { api, clearCache } from './api.js';
import { runRelay } from './anilist-relay.js';
import { openQuickSwitcher } from './quickopen.js';
import { checkPlay } from './playcheck.js';
import { bus } from './bus.js';
import { h, fill, relTime, icon } from './ui.js';
import { closeDrawer, openAnime } from './drawer.js';
import * as upnext from './views/upnext.js';
import * as library from './views/library.js';
import * as discover from './views/discover.js';
import * as insights from './views/insights.js';
import * as sync from './views/sync.js';

const VIEWS = { 'up-next': upnext, library, discover, insights, sync };
const VIEW_NAMES = { 'up-next': 'Up Next', library: 'Library', discover: 'Discover', insights: 'Insights', sync: 'Sync' };
const view = document.getElementById('view');

async function route({ refresh = false } = {}) {
  const name = (location.hash.replace(/^#\//, '') || 'up-next').split('?')[0];
  const mod = VIEWS[name] || upnext;
  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  closeDrawer();
  // Each navigation renders into its own container. A page whose data arrives after you've moved
  // on draws into a container that is no longer on screen, never over the page you're looking at.
  const slot = h('div', { class: 'view-slot' });
  // The page's name for screen readers (a visually hidden h1) and for the browser tab and history.
  const pageName = VIEW_NAMES[name] || 'Up Next';
  document.title = `${pageName} · Anime Tracker`;
  view.replaceChildren(h('h1', { class: 'sr-only' }, pageName), slot);
  try {
    await mod.render(slot);
    // Deep link: #/<view>?anime=<malId> opens that show's detail panel.
    // (Not on a background refresh: a panel you closed shouldn't reopen.)
    const anime = new URLSearchParams(location.hash.split('?')[1] || '').get('anime');
    if (anime && !refresh) openAnime({ malId: Number(anime) });
  } catch (err) {
    if (slot.isConnected) slot.replaceChildren(h('div', { class: 'empty' }, `Couldn't load: ${err.message}`));
  }
}

async function updateStatus() {
  try {
    const cr = await api.crStatus();
    const el = document.getElementById('topbar-status');
    const at = cr.lastSync ? new Date(cr.lastSync.at) : null;
    const fresh = at && Date.now() - at.getTime() < 2 * 3600000;
    el.title = at ? `Last Crunchyroll sync: ${at.toLocaleString()}` : '';
    fill(el, h('span', { class: `sync-dot ${fresh ? 'is-fresh' : at ? 'is-stale' : ''}`, 'aria-hidden': 'true' }),
      at ? `Synced ${relTime(at.getTime())}` : 'Not synced yet');
    // The Sync tab's badge counts everything there that needs a decision: guessed mappings and odd progress.
    const odd = await api.suspicious().catch(() => []);
    const attention = cr.needsReview.length + odd.length;
    const badge = document.getElementById('sync-badge');
    badge.hidden = !attention;
    badge.textContent = attention;
    badge.title = `${cr.needsReview.length} to review · ${odd.length} with odd progress`;
  } catch {}
}

// "/" jumps to the page's search or filter box, like on GitHub; "?" opens the shortcut sheet.
document.addEventListener('keydown', (e) => {
  // ⌘K / Ctrl+K: quick switcher, from anywhere (even inside a text box).
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!document.getElementById('quickopen')?.open) openQuickSwitcher(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return;
  if (e.key === '?') { e.preventDefault(); const help = document.getElementById('help'); if (!help.open) help.showModal(); return; }
  // 1-5 switch tabs (when no dialog is open).
  const tab = { 1: 'up-next', 2: 'library', 3: 'discover', 4: 'insights', 5: 'sync' }[e.key];
  if (tab && !document.querySelector('dialog[open]')) { e.preventDefault(); location.hash = `#/${tab}`; return; }
  if (e.key !== '/' || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  const box = document.querySelector('#view input[type="search"]');
  if (box) { box.focus(); box.select(); return; }
  // No search box on this page: go to the Library and focus its filter once it has rendered.
  location.hash = '#/library';
  const tryFocus = (n) => { const b = document.querySelector('#view input[type="search"]'); if (b) { b.focus(); } else if (n) setTimeout(() => tryFocus(n - 1), 120); };
  setTimeout(() => tryFocus(20), 120);
});
document.getElementById('help').addEventListener('click', (e) => { if (e.target.id === 'help') e.target.close(); });

// Theme: dark (default) -> light -> system
const THEMES = ['dark', 'light', 'system'];
const THEME_GLYPH = { dark: '☾', light: '☀', system: '◐' };
// The ⌘K switcher, for fingers too: a search button in the header (phones have no ⌘).
const findBtn = document.getElementById('find-btn');
findBtn?.append(icon('search'));
findBtn?.addEventListener('click', () => openQuickSwitcher());
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
// Coming back to a tab left open for a while: redraw the page with fresh data (episodes may have
// aired since). Pages paint from their snapshot first, so this doesn't flash. A panel or dialog
// you're in stays as it is.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  checkPlay();
  if (hiddenAt && Date.now() - hiddenAt > 10 * 60000 && !document.querySelector('dialog[open]')) {
    clearCache();
    bus.emit('library-changed'); // the Library refetches its list instead of repainting the old one
    route({ refresh: true });
    updateStatus();
  }
  hiddenAt = 0;
});
route();
updateStatus();
setInterval(updateStatus, 60000);
checkPlay();

// AniList relay: when the hosted server is blocked by AniList, this browser fills in the queued
// requests (new metadata, air times, season lookups) whenever the app is open.
// A tick answers the queued batch; while batches keep coming (a big backfill), it goes again soon.
let relayTimer = null;
async function relayTick() {
  clearTimeout(relayTimer);
  const ran = await runRelay();
  if (ran) bus.emit('library-changed');
  relayTimer = setTimeout(relayTick, ran ? 5000 : 10 * 60 * 1000);
}
relayTimer = setTimeout(relayTick, 3000);
bus.on('relay-now', relayTick);
// Anything that changes the library (including relayed AniList data) makes cached views stale.
bus.on('library-changed', clearCache);
// The Sync badge counts things to fix: recount right after one is fixed, not a minute later.
bus.on('library-changed', () => setTimeout(updateStatus, 300));
bus.on('recommendations-changed', clearCache);

// Offline shell (see sw.js). Registered after load so it never competes with the first paint.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
// Offline banner: the pages paint from snapshots; say why nothing refreshes.
function paintOnline() { document.documentElement.classList.toggle('is-offline', !navigator.onLine); }
window.addEventListener('online', paintOnline);
window.addEventListener('offline', paintOnline);
paintOnline();
