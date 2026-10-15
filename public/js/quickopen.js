// ⌘K / Ctrl+K quick switcher: type part of a title, arrows to move, Enter to open the show's panel.
import { api } from './api.js';
import { h, fill } from './ui.js';
import { openAnime } from './drawer.js';
import { bus } from './bus.js';

let items = null;
bus.on('library-changed', () => { items = null; });
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Prefix of a word beats anywhere-in-title; shorter titles break ties. */
function rank(list, q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return list.slice(0, 8);
  return list.map((x) => {
    const hay = ` ${norm(`${x.titleEnglish} ${x.title}`)}`;
    if (!words.every((w) => hay.includes(w))) return null;
    const score = words.reduce((n, w) => n + (hay.includes(` ${w}`) ? 2 : 1), 0);
    return { x, score, len: (x.titleEnglish || x.title).length };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.len - b.len).slice(0, 8).map((r) => r.x);
}

export function openQuickSwitcher() {
  let dlg = document.getElementById('quickopen');
  if (!dlg) {
    dlg = h('dialog', { id: 'quickopen', class: 'quickopen', 'aria-label': 'Open a show' });
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  const input = h('input', { type: 'search', class: 'search', placeholder: 'Open a show…', 'aria-label': 'Show title', autocomplete: 'off' });
  const list = h('ul', { class: 'quickopen-list', role: 'listbox' });
  let results = []; let active = 0;
  const searchAniList = () => { dlg.close(); location.hash = `#/discover?q=${encodeURIComponent(input.value.trim())}`; };
  const draw = () => {
    const q = input.value.trim();
    // Nothing in the library: offer AniList search as the (only) result.
    if (items && !results.length && q.length >= 2) {
      const li = h('li', { role: 'option', 'aria-selected': 'true', class: 'is-active quickopen-search' }, h('span', { 'aria-hidden': 'true' }, '⌕'), h('span', { class: 'one-line' }, `Search AniList for “${q}”`), h('span', { class: 'muted' }, 'Enter'));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); searchAniList(); });
      fill(list, li);
      return;
    }
    fill(list, results.length ? results.map((x, i) => {
      const li = h('li', { role: 'option', 'aria-selected': String(i === active), class: i === active ? 'is-active' : '' },
        h('img', { src: x.imageUrl, alt: '' }),
        h('span', { class: 'one-line' }, x.titleEnglish || x.title),
        h('span', { class: 'muted num' }, `${x.watchedCount}/${x.airedEpisodes ?? x.episodesCount ?? '?'}`));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(x); });
      return li;
    }) : h('li', { class: 'muted quickopen-empty' }, input.value ? 'No show in your library matches. Discover can search AniList.' : 'Loading…'));
  };
  const choose = (x) => { dlg.close(); openAnime({ ...x, title: x.titleEnglish || x.title, image: x.imageUrl }); };
  const update = () => { active = 0; results = items ? rank(items, input.value) : []; draw(); };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Enter' && !results.length && input.value.trim().length >= 2) { e.preventDefault(); searchAniList(); }
  });
  fill(dlg, input, list);
  dlg.showModal();
  input.focus();
  draw();
  (items ? Promise.resolve(items) : api.watchlist('activity_desc').then((r) => { items = r; return r; })).then(update).catch(() => {});
}
