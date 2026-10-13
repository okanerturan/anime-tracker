import { api } from '../api.js';
import { h, media, progress, cardLink, statusPill, FORMAT_LABEL } from '../ui.js';
import { openAnime } from '../drawer.js';
import { bus } from '../bus.js';

const FILTERS = [
  ['all', 'All'], ['watching', 'Watching'], ['almost', 'Almost done'], ['airing', 'Airing'], ['completed', 'Completed'],
  ['not-started', 'Not started'], ['upcoming', 'Upcoming'], ['on-hold', 'On hold'], ['dropped', 'Dropped'], ['rated', 'Rated']
];
const state = { filter: 'all', query: '', sort: 'activity_desc', items: null };
bus.on('library-changed', () => { state.items = null; });

function matches(x) {
  const st = progressState(x).key;
  const wanted = {
    watching: ['watching', 'almost'], almost: ['almost'], completed: ['completed'],
    'not-started': ['not-started'], upcoming: ['upcoming'], 'on-hold': ['on-hold'], dropped: ['dropped']
  }[state.filter];
  if (state.filter === 'rated' && !x.rating) return false;
  if (state.filter === 'airing' && x.status !== 'RELEASING') return false;
  if (wanted && !wanted.includes(st)) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    if (!`${x.title} ${x.titleEnglish} ${(x.genres || []).join(' ')}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** One visual state per show: completed, caught up (airing), almost done, watching, not started, upcoming. */
function progressState(x) {
  const aired = x.airedEpisodes ?? x.episodesCount;
  const left = aired ? Math.max(0, aired - x.watchedCount) : x.unwatchedCount;
  if (x.listStatus === 'dropped') return { key: 'dropped', label: 'Dropped', left };
  if (x.listStatus === 'on_hold') return { key: 'on-hold', label: 'On hold', left };
  if (x.status === 'NOT_YET_RELEASED') return { key: 'upcoming', label: 'Upcoming', left };
  if (!x.watchedCount) return { key: 'not-started', label: aired ? `${aired} eps` : 'Not started', left };
  if (!left) return x.status === 'RELEASING' ? { key: 'caught-up', label: 'Caught up', left } : { key: 'completed', label: '✓ Completed', left };
  // Almost done = close to the end of the season, judged by its announced length, not by aired episodes.
  const seasonLeft = x.totalEpisodes ? Math.max(0, x.totalEpisodes - x.watchedCount) : null;
  if (seasonLeft != null && seasonLeft <= 3 && left <= 3) return { key: 'almost', label: `Almost done · ${seasonLeft} left`, left };
  return { key: 'watching', label: `${left} new`, left };
}

function card(x) {
  const aired = x.airedEpisodes ?? x.episodesCount;
  const title = x.titleEnglish || x.title;
  const st = progressState(x);
  const badge = h('span', { class: `pill state-${st.key} num` }, st.label);
  return h('article', { class: `card is-${st.key}` },
    media({ src: x.imageUrl, alt: '', kind: 'poster', badges: [h('div', { class: 'badge-end' }, badge)] }),
    progress(aired ? Math.min(x.watchedCount, aired) / aired : 0),
    cardLink(title, () => openAnime({ ...x, title, image: x.imageUrl }), { href: `https://myanimelist.net/anime/${x.malId}` }),
    h('div', { class: 'card-meta' },
      statusPill(x.status),
      h('span', {}, [x.releaseDate?.slice(0, 4), FORMAT_LABEL[x.format] || x.format].filter(Boolean).join(' · ')),
      x.rating ? h('span', { class: 'num rating', title: `Your rating: ${x.rating}/5` }, `★${x.rating}`) : null,
      h('span', { class: 'num push-end' }, `${x.watchedCount}/${aired ?? '?'}`)));
}

export async function render(view) {
  if (!state.items) {
    view.replaceChildren(h('div', { class: 'skeleton' }));
    state.items = await api.watchlist(state.sort);
  }
  const grid = h('div', { class: 'cards', style: { '--rows': '4' } });
  const count = h('span', { class: 'sub num' });
  const draw = () => {
    const list = state.items.filter(matches);
    count.textContent = `${list.length} of ${state.items.length}`;
    grid.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty' }, 'Nothing matches.')]));
  };
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Filter by title or genre…', value: state.query, 'aria-label': 'Filter library' });
  search.addEventListener('input', () => { state.query = search.value.trim(); draw(); });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([key, label]) => {
    const b = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(state.filter === key) }, label);
    b.addEventListener('click', () => {
      state.filter = key;
      chips.querySelectorAll('.chip-toggle').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      draw();
    });
    return b;
  }));
  const sort = h('select', { 'aria-label': 'Sort' }, [['activity_desc', 'Recently watched'], ['release_desc', 'Newest release'], ['release_asc', 'Oldest release'], ['added_desc', 'Recently added'], ['title_asc', 'Title A–Z']]
    .map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));
  sort.addEventListener('change', async () => { state.sort = sort.value; state.items = await api.watchlist(state.sort); draw(); });
  view.replaceChildren(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Library'), count, h('div', { class: 'push-end' }, sort)),
    h('div', { class: 'toolbar' }, search, chips),
    grid));
  draw();
}
