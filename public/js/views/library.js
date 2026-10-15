import { api } from '../api.js';
import { h, fill, icon, media, progress, cardLink, statusPill, ago, toast, FORMAT_LABEL } from '../ui.js';
import { openAnime } from '../drawer.js';
import { bus } from '../bus.js';

const FILTERS = [
  ['all', 'All'], ['watching', 'Watching'], ['almost', 'Almost done'], ['unfinished', 'Unfinished'], ['completed', 'Completed'],
  ['airing', 'Airing'], ['not-started', 'Not started'], ['upcoming', 'Upcoming'], ['on-hold', 'On hold'], ['dropped', 'Dropped'], ['rated', 'Rated']
];
// What each empty filter means, so an empty grid explains itself.
const EMPTY = {
  all: 'Your library is empty. Sync Crunchyroll or add a show from Discover.',
  watching: 'Nothing in progress right now.',
  almost: 'No show is within three episodes of its finale.',
  unfinished: 'No unfinished shows: everything you started is either done or still active.',
  completed: 'Nothing finished yet.',
  airing: 'None of your shows is airing at the moment.',
  'not-started': 'Everything in your library has at least one episode watched.',
  upcoming: 'No upcoming seasons in your library. New seasons of finished shows appear on Up Next.',
  'on-hold': 'Nothing on hold. “Put on hold” lives in a show’s details and on Up Next cards.',
  dropped: 'Nothing dropped. Shows you quietly stopped watching are under Unfinished; “Drop” hides one from Up Next for good.',
  rated: 'No ratings yet. Open a show from the library and tap a star; ratings steer your recommendations.'
};
const DAY = 86400000;
const state = { filter: 'all', query: '', sort: 'activity_desc', items: null };
// Remember the last filter and sort per browser.
try { const saved = JSON.parse(localStorage.getItem('library:view') || 'null'); if (saved) { state.filter = saved.filter || state.filter; state.sort = saved.sort || state.sort; } } catch {}
const remember = () => { try { localStorage.setItem('library:view', JSON.stringify({ filter: state.filter, sort: state.sort })); } catch {} };
bus.on('library-changed', () => { state.items = null; });

// Last known list per sort, so the page paints before the network answers.
const snapKey = (sort) => `library:snapshot:${sort}`;
function readSnap(sort) { try { const s = JSON.parse(localStorage.getItem(snapKey(sort)) || 'null'); return s && Date.now() - s.at < 86400000 ? s.items : null; } catch { return null; } }
function writeSnap(sort, items) { try { localStorage.setItem(snapKey(sort), JSON.stringify({ at: Date.now(), items })); } catch {} }

function matches(x) {
  const st = progressState(x).key;
  const wanted = {
    watching: ['watching', 'almost', 'caught-up'], almost: ['almost'], unfinished: ['unfinished'], completed: ['completed'],
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
  const left = aired ? Math.max(0, aired - (x.progress ?? x.watchedCount)) : x.unwatchedCount;
  if (x.listStatus === 'dropped') return { key: 'dropped', label: 'Dropped', left };
  if (x.listStatus === 'on_hold') return { key: 'on-hold', label: 'On hold', left };
  if (x.status === 'NOT_YET_RELEASED') return { key: 'upcoming', label: 'Upcoming', left };
  if (!(x.progress ?? x.watchedCount)) return { key: 'not-started', label: aired ? `${aired} eps` : 'Not started', left };
  if (!left) {
    if (x.status !== 'RELEASING') return { key: 'completed', label: '✓ Completed', left };
    const at = x.nextAiringAt ? x.nextAiringAt * (x.nextAiringAt < 1e12 ? 1000 : 1) : null;
    const days = at ? Math.max(0, Math.round((at - Date.now()) / 86400000)) : null;
    return { key: 'caught-up', label: days === null ? 'Caught up' : days === 0 ? 'New today' : days === 1 ? 'New tomorrow' : `Next in ${days} days`, left };
  }
  // Unfinished = started, episodes waiting, and no activity for months (same rule as Up Next's "Paused a while ago").
  const ageDays = x.lastWatchedAt ? (Date.now() - new Date(x.lastWatchedAt).getTime()) / DAY : 9999;
  const progress = aired ? (x.progress ?? x.watchedCount) / aired : 0;
  if (ageDays > 120 && !(progress >= 0.5 && ageDays <= 365)) return { key: 'unfinished', label: `${left} left · ${ago(x.lastWatchedAt)}`, left };
  // Almost done = close to the end of the season, judged by its announced length, not by aired episodes.
  const seasonLeft = x.totalEpisodes ? Math.max(0, x.totalEpisodes - (x.progress ?? x.watchedCount)) : null;
  if (seasonLeft != null && seasonLeft <= 3 && left <= 3) return { key: 'almost', label: `Almost done · ${seasonLeft} left`, left };
  return { key: 'watching', label: `${left} new`, left };
}

function card(x) {
  const aired = x.airedEpisodes ?? x.episodesCount;
  const title = x.titleEnglish || x.title;
  const st = progressState(x);
  const badge = h('span', { class: `pill state-${st.key} num` }, st.label);
  // In-progress shows get a Play pill straight to the next episode, like Up Next.
  const play = x.nextEpisodeUrl && ['watching', 'almost', 'unfinished'].includes(st.key)
    ? h('a', { class: 'play-overlay', href: x.nextEpisodeUrl, target: '_blank', rel: 'noopener', 'aria-label': x.nextEpisodeUrlIsExact ? `Play episode ${x.nextEpisode} of ${title} on Crunchyroll` : `Open ${title} on ${x.nextEpisodeSite}` }, icon('play'), h('span', {}, x.nextEpisodeUrlIsExact ? `E${x.nextEpisode}` : x.nextEpisodeSite === 'Crunchyroll' ? 'Open' : x.nextEpisodeSite))
    : null;
  // Same tick as Up Next: mark the next episode watched from the card.
  const tick = x.nextEpisode && ['watching', 'almost', 'unfinished', 'caught-up'].includes(st.key) && st.left > 0
    ? h('button', { type: 'button', class: 'icon-btn card-tick card-tick--bottom', 'aria-label': `Mark episode ${x.nextEpisode} of ${title} watched`, title: `Mark E${x.nextEpisode} watched` }, icon('check'))
    : null;
  if (tick) tick.addEventListener('click', async () => {
    tick.disabled = true;
    try {
      await api.watchedThrough(x.malId, x.nextEpisode); bus.emit('library-changed'); render(document.getElementById('view'));
      toast(`E${x.nextEpisode} of ${title} marked watched`, { label: 'Undo', onClick: async () => { try { await api.toggleWatched(x.malId, x.nextEpisode, false); bus.emit('library-changed'); render(document.getElementById('view')); } catch (err) { toast(err.message); } } });
    }
    catch (err) { tick.disabled = false; toast(err.message); }
  });
  return h('article', { class: `card is-${st.key} ${play ? 'has-play' : ''}` },
    media({ src: x.imageUrl, alt: '', kind: 'poster', badges: [h('div', { class: 'badge-end' }, badge), play, tick] }),
    progress(aired ? Math.min((x.progress ?? x.watchedCount), aired) / aired : 0),
    cardLink(title, () => openAnime({ ...x, title, image: x.imageUrl }), { href: `https://myanimelist.net/anime/${x.malId}` }),
    h('div', { class: 'card-meta' },
      statusPill(x.status),
      h('span', {}, [x.releaseDate?.slice(0, 4), FORMAT_LABEL[x.format] || x.format].filter(Boolean).join(' · ')),
      x.rating ? h('span', { class: 'num rating', title: `Your rating: ${x.rating}/5` }, `★${x.rating}`) : null,
      h('span', { class: 'num push-end' }, `${(x.progress ?? x.watchedCount)}/${aired ?? '?'}`)),
    state.filter === 'unfinished' ? triage(x, title) : null);
}

/** Hold / Drop straight from an Unfinished card, with Undo in the toast. */
function triage(x, title) {
  const act = (label, status, cls) => {
    const b = h('button', { type: 'button', class: cls }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api.setListStatus(x.malId, status);
        x.listStatus = status;
        bus.emit('library-changed');
        render(document.getElementById('view'));
        toast(status === 'dropped' ? `Dropped ${title}` : `${title} is on hold`, { label: 'Undo', onClick: async () => {
          try { await api.setListStatus(x.malId, null); x.listStatus = null; bus.emit('library-changed'); render(document.getElementById('view')); } catch (err) { toast(err.message); }
        } });
      } catch (err) { b.disabled = false; toast(err.message); }
    });
    return b;
  };
  return h('div', { class: 'card-actions card-actions--pair' }, act('Hold', 'on_hold', 'btn small'), act('Drop', 'dropped', 'btn small ghost'));
}

export async function render(view) {
  // Deep link: #/library?filter=unfinished&sort=left_asc
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('filter') && FILTERS.some(([k]) => k === params.get('filter'))) state.filter = params.get('filter');
  if (params.get('sort')) { if (state.sort !== params.get('sort')) state.items = null; state.sort = params.get('sort'); }
  if (!state.items) {
    const serverSort = ['left_asc', 'rating_desc'].includes(state.sort) ? 'activity_desc' : state.sort;
    const snap = readSnap(serverSort);
    if (snap) {
      // Paint the snapshot now; swap in the fresh list when it arrives.
      state.items = snap;
      api.watchlist(serverSort).then((fresh) => { writeSnap(serverSort, fresh); state.items = fresh; if (location.hash.startsWith('#/library')) render(view); }).catch(() => {});
    } else {
      view.replaceChildren(h('div', { class: 'skeleton' }));
      state.items = await api.watchlist(serverSort);
      writeSnap(serverSort, state.items);
    }
  }
  const grid = h('div', { class: 'cards', style: { '--rows': state.filter === 'unfinished' ? '5' : '4' } });
  const count = h('span', { class: 'sub num' });
  // How many shows each filter would show, so a filter never looks broken when it's simply empty.
  const countFor = (key) => { const was = state.filter; const q = state.query; state.filter = key; state.query = ''; const n = state.items.filter(matches).length; state.filter = was; state.query = q; return n; };
  const draw = () => {
    grid.style.setProperty('--rows', state.filter === 'unfinished' ? '5' : '4');
    let list = state.items.filter(matches);
    if (state.sort === 'rating_desc') {
      // Your stars first, highest up; unrated shows after, by recent activity.
      list = [...list].sort((a, b) => ((b.rating || 0) - (a.rating || 0)) || String(b.lastWatchedAt || '').localeCompare(String(a.lastWatchedAt || '')));
    }
    if (state.sort === 'left_asc') {
      // Closest to the finish line first; ties broken by most recent activity. Finished shows go last.
      list = list.map((x) => ({ x, st: progressState(x) }))
        .sort((a, b) => ((a.st.left || Infinity) - (b.st.left || Infinity)) || String(b.x.lastWatchedAt || '').localeCompare(String(a.x.lastWatchedAt || '')))
        .map((e) => e.x);
    }
    // For in-progress views, how long it would take to finish everything shown.
    let tail = '';
    if (['watching', 'almost', 'unfinished'].includes(state.filter)) {
      const minutes = list.reduce((n, x) => n + (progressState(x).left || 0) * (x.episodeMinutes || 24), 0);
      const hrs = Math.round(minutes / 60);
      tail = minutes ? ` · ~${hrs >= 1 ? `${hrs} h` : `${Math.round(minutes)} min`} to finish them all` : '';
    }
    count.textContent = `${list.length} of ${state.items.length}${tail}`;
    fill(grid, list.length ? list.map(card)
      : h('div', { class: 'empty' }, h('b', {}, 'Nothing here'), h('span', {}, state.query ? `No show matches “${state.query}”.` : EMPTY[state.filter] || 'Nothing matches.')));
  };
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Filter by title or genre…', value: state.query, 'aria-label': 'Filter library' });
  search.addEventListener('input', () => { state.query = search.value.trim(); draw(); });
  const chips = h('div', { class: 'chips segmented', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([key, label]) => {
    const n = countFor(key);
    const b = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(state.filter === key), disabled: n === 0 && key !== state.filter },
      h('span', {}, label), key === 'all' ? null : h('span', { class: 'chip-count num' }, String(n)));
    b.addEventListener('click', () => {
      state.filter = key;
      remember();
      paintBulk();
      chips.querySelectorAll('.chip-toggle').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      draw();
    });
    return b;
  }));
  const sort = h('select', { 'aria-label': 'Sort' }, [['activity_desc', 'Recently watched'], ['left_asc', 'Fewest episodes left'], ['rating_desc', 'Your rating'], ['release_desc', 'Newest release'], ['release_asc', 'Oldest release'], ['added_desc', 'Recently added'], ['title_asc', 'Title A–Z']]
    .map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));
  sort.addEventListener('change', async () => {
    state.sort = sort.value;
    remember();
    // "Fewest left" is ordered here from the activity list; every other sort comes from the server.
    const serverSort = ['left_asc', 'rating_desc'].includes(state.sort) ? 'activity_desc' : state.sort;
    state.items = await api.watchlist(serverSort);
    draw();
  });
  // Unfinished view: one button to shelve everything untouched for a year.
  const bulk = h('button', { type: 'button', class: 'btn small ghost', hidden: true });
  const staleIds = () => state.items.filter((x) => progressState(x).key === 'unfinished' && (!x.lastWatchedAt || Date.now() - new Date(x.lastWatchedAt).getTime() > 365 * DAY)).map((x) => x.malId);
  const paintBulk = () => { const n = state.filter === 'unfinished' ? staleIds().length : 0; bulk.hidden = !n; bulk.textContent = `Put the ${n} untouched for a year on hold`; };
  bulk.addEventListener('click', async () => {
    const ids = staleIds();
    if (!ids.length) return;
    bulk.disabled = true;
    try {
      await api.setListStatusBatch(ids, 'on_hold');
      for (const x of state.items) if (ids.includes(x.malId)) x.listStatus = 'on_hold';
      // Redraw whatever Library is on screen now (the first paint may have been replaced by fresher data).
      const redraw = () => { writeSnap(['left_asc', 'rating_desc'].includes(state.sort) ? 'activity_desc' : state.sort, state.items); render(document.getElementById('view')); };
      redraw();
      toast(`${ids.length} shows put on hold`, { label: 'Undo', onClick: async () => {
        try { await api.setListStatusBatch(ids, null); for (const x of state.items) if (ids.includes(x.malId)) x.listStatus = null; redraw(); } catch (err) { toast(err.message); }
      } });
    } catch (err) { toast(err.message); }
    bulk.disabled = false;
  });
  view.replaceChildren(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Library'), count, h('div', { class: 'push-end' }, sort)),
    h('div', { class: 'toolbar' }, search, chips),
    bulk,
    grid));
  draw();
  paintBulk();
}
