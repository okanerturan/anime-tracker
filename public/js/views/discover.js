import { api } from '../api.js';
import { h, fill, icon, media, section, carousel, toast, cardLink, FORMAT_LABEL } from '../ui.js';
import { openAnime } from '../drawer.js';
import { bus } from '../bus.js';

function addButton(anime, inLibrary) {
  const btn = h('button', { type: 'button', class: 'btn small primary' }, inLibrary ? 'In library' : 'Add');
  btn.disabled = Boolean(inLibrary);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api.add(anime); btn.textContent = 'In library'; toast(`Added ${anime.titleEnglish || anime.title}`); bus.emit('library-changed'); }
    catch (err) { btn.disabled = false; toast(err.message); }
  });
  return btn;
}

function watchedButton(malId, title, onDone) {
  const btn = h('button', { type: 'button', class: 'btn small', title: 'Seen it already (anywhere): add it to your library as fully watched' }, 'Seen it');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api.watchedElsewhere(malId);
      bus.emit('library-changed');
      onDone?.();
      toast(`Marked ${title} as watched (${r.aired} episodes)`, { label: 'Undo', onClick: async () => {
        // Unmark exactly what this click marked; remove the show only if this click added it.
        try { await api.unmark(malId, r.episodes || [], r.addedToLibrary); bus.emit('library-changed'); bus.emit('recommendations-changed'); toast(r.addedToLibrary ? `Removed ${title} again` : `${title} is back to where it was`); } catch (err) { toast(err.message); }
      } });
    } catch (err) { btn.disabled = false; toast(err.message); }
  });
  return btn;
}

// Filters for the recommendation grid (kept for the session).
const FILTERS = {
  length: { label: 'Length', options: [['any', 'Any'], ['short', '≤ 13 eps'], ['two', '14–26 eps'], ['long', '27+ eps'], ['movie', 'Movies']] },
  where: { label: 'Where', options: [['any', 'Anywhere'], ['cr', 'On Crunchyroll']] },
  era: { label: 'Released', options: [['any', 'Any year'], ['2020', '2020+'], ['2010', '2010s'], ['old', 'Before 2010']] }
};
const filters = { length: 'any', where: 'any', era: 'any' };
try { Object.assign(filters, JSON.parse(localStorage.getItem('discover:filters') || '{}')); } catch {}

function passes(r) {
  const eps = r.episodes || 0;
  const movie = r.format === 'MOVIE';
  if (filters.length === 'movie' && !movie) return false;
  if (filters.length === 'short' && (movie || !eps || eps > 13)) return false;
  if (filters.length === 'two' && (movie || eps < 14 || eps > 26)) return false;
  if (filters.length === 'long' && (movie || eps < 27)) return false;
  if (filters.where === 'cr' && !r.onCrunchyroll) return false;
  if (filters.era === '2020' && !(r.year >= 2020)) return false;
  if (filters.era === '2010' && !(r.year >= 2010 && r.year < 2020)) return false;
  if (filters.era === 'old' && !(r.year && r.year < 2010)) return false;
  return true;
}

function filterBar(onChange) {
  return h('div', { class: 'filter-bar' }, Object.entries(FILTERS).map(([key, f]) => {
    const group = h('div', { class: 'chips', role: 'group', 'aria-label': f.label }, f.options.map(([value, label]) => {
      const b = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(filters[key] === value) }, label);
      b.addEventListener('click', () => {
        filters[key] = value;
        try { localStorage.setItem('discover:filters', JSON.stringify(filters)); } catch {}
        group.querySelectorAll('.chip-toggle').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        onChange();
      });
      return b;
    }));
    return h('div', { class: 'filter-group' }, h('span', { class: 'watch-label' }, f.label), group);
  }));
}

function recCard(r, onDismiss) {
  // Not interested: a small × in the poster's corner (shown on hover with a mouse, always on touch).
  const dismiss = h('button', { type: 'button', class: 'icon-btn card-tick rec-hide', 'aria-label': `Not interested in ${r.title}`, title: 'Not interested' }, icon('close'));
  dismiss.addEventListener('click', async () => {
    await api.dismiss(r.malId);
    onDismiss();
    toast(`Hidden ${r.title}`, { label: 'Undo', onClick: async () => { await api.dismiss(r.malId, true); bus.emit('recommendations-changed'); } });
  });
  const open = () => openAnime({ malId: r.malId, title: r.title, image: r.image });
  return h('article', { class: 'card rec-card' },
    media({ src: r.image, alt: '', kind: 'poster', badges: [
      dismiss,
      r.crunchyrollUrl ? h('a', { class: 'play-overlay', href: r.crunchyrollUrl, target: '_blank', rel: 'noopener', 'aria-label': `Open ${r.title} on Crunchyroll`, title: 'Open on Crunchyroll' }, icon('play'), h('span', {}, 'Crunchyroll')) : null,
      r.match != null ? h('div', { class: 'badge-end' }, h('span', { class: 'pill accent num' }, `${r.match}% match`)) : null] }),
    cardLink(r.title, open, { href: r.siteUrl || `https://myanimelist.net/anime/${r.malId}` }),
    h('p', { class: 'card-meta' }, [r.year, FORMAT_LABEL[r.format] || r.format, r.episodes ? `${r.episodes} eps` : null,
      r.episodes && r.duration ? (() => { const m = r.episodes * r.duration; return m < 60 ? `~${m} min` : `~${Math.round(m / 60)} h`; })() : null,
      r.averageScore ? `★ ${r.averageScore}` : null].filter(Boolean).join(' · ')),
    h('p', { class: 'card-sub clamp-3' }, r.note ? r.note : r.because.length ? ['Because you watched ', ...(r.becauseShows || r.because.map((t) => ({ title: t }))).flatMap((b, i, arr) => [
      b.malId ? h('a', { class: 'because-link', href: `#/library?anime=${b.malId}`, onclick: (e) => { e.preventDefault(); openAnime({ malId: b.malId, title: b.title }); } }, b.title) : b.title,
      i < arr.length - 1 ? ', ' : ''])] : ''),
    h('div', { class: 'card-actions card-actions--pair' }, addButton({ malId: r.malId, title: r.title, titleEnglish: r.title, totalEpisodes: r.episodes }, r.inLibrary), watchedButton(r.malId, r.title, onDismiss)));
}

function searchPanel(initial = '') {
  const input = h('input', { type: 'search', class: 'search', placeholder: 'Search AniList to add anything…', 'aria-label': 'Search AniList', value: initial });
  const results = h('div', { class: 'cards', style: { '--rows': '4' } });
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.replaceChildren(); return; }
    timer = setTimeout(async () => {
      try {
        const list = await api.search(q);
        results.replaceChildren(...list.map((a) => {
          const title = a.titleEnglish || a.title;
          return h('article', { class: `card ${a.crunchyrollUrl ? 'has-play' : ''}` },
            media({ src: a.image, alt: '', kind: 'poster', badges: [a.crunchyrollUrl
              ? h('a', { class: 'play-overlay', href: a.crunchyrollUrl, target: '_blank', rel: 'noopener', 'aria-label': `Open ${title} on Crunchyroll` }, icon('play'), h('span', {}, 'Crunchyroll'))
              : (a.watchOn?.length ? h('span', { class: 'pill dark badge-bottom', title: `Streaming on ${a.watchOn.join(', ')}` }, a.watchOn[0]) : null)] }),
            cardLink(title, () => openAnime({ ...a, title, image: a.image }), { href: `https://myanimelist.net/anime/${a.malId}` }),
            h('p', { class: 'card-meta' }, [a.releaseDate?.slice(0, 4), FORMAT_LABEL[a.format] || a.format, a.totalEpisodes ? `${a.totalEpisodes} eps` : null].filter(Boolean).join(' · ')),
            // Already yours: one button that opens it. Otherwise Add, plus Seen it once it has aired.
            a.inLibrary
              ? h('div', { class: 'card-actions' }, h('button', { type: 'button', class: 'btn small ghost', style: { flex: '1' }, onclick: () => openAnime({ ...a, title, image: a.image }) }, 'In library · Open'))
              : h('div', { class: `card-actions ${a.status === 'NOT_YET_RELEASED' ? '' : 'card-actions--pair'}` }, addButton(a, false), a.status === 'NOT_YET_RELEASED' ? null : watchedButton(a.malId, title)));
        }));
      } catch (err) { results.replaceChildren(h('div', { class: 'empty' }, err.message)); }
    }, 350);
  });
  if (initial) setTimeout(() => { input.dispatchEvent(new Event('input')); input.scrollIntoView({ block: 'center' }); input.focus(); }, 0);
  return [h('div', { class: 'toolbar' }, input), results];
}

let mounted = null;
bus.on('recommendations-changed', () => { if (mounted?.isConnected) render(mounted); });

/**
 * "Because you watched X" rows: the three shows of yours that inspired the most recommendations,
 * each with up to ten of them. A recommendation appears in one row at most.
 */
function becauseRows(items, onHide) {
  const counts = new Map();
  for (const r of items) for (const b of r.becauseShows || []) if (b.malId) counts.set(b.malId, { title: b.title, n: (counts.get(b.malId)?.n || 0) + 1 });
  const seeds = [...counts.entries()].filter(([, v]) => v.n >= 5).sort((a, b) => b[1].n - a[1].n).slice(0, 3);
  const used = new Set();
  return seeds.map(([malId, seed]) => {
    const picks = items.filter((r) => !used.has(r.malId) && (r.becauseShows || []).some((b) => b.malId === malId)).slice(0, 10);
    picks.forEach((r) => used.add(r.malId));
    if (picks.length < 4) return null;
    const cards = picks.map((r) => { const card = recCard({ ...r, note: null }, () => { card.remove(); onHide(r); }); return card; });
    return carousel(`Because you watched ${seed.title}`, null, cards, '');
  }).filter(Boolean);
}

/** This season's airing anime that fit your taste, as a carousel at the top of Discover. */
async function seasonalSection() {
  let d;
  try { d = await api.seasonal(); } catch { return null; }
  if (!d.items.length) return null;
  const name = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' }[d.season] || d.season;
  const cards = d.items.map((x) => { const card = recCard({ ...x, year: d.year, because: [], becauseShows: [], note: x.continuesYours ? 'Continues a show you watched' : x.triedEpisode ? `You tried episode ${x.triedEpisode} on Crunchyroll` : null }, () => card.remove()); return card; });
  return carousel(`${d.personal ? 'Airing' : 'Popular'} this season · ${name} ${d.year}`,
    d.personal ? 'New shows scored against what you actually finish' : 'Add what looks good. Once you have watched a few shows, these get scored for your taste.', cards, '');
}

export async function render(view) {
  mounted = view;
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const seasonalPromise = seasonalSection();
  const data = await api.recommendations();
  const grid = h('div', { class: 'cards', style: { '--rows': '5' } });
  const count = h('span', { class: 'sub num' });
  let items = data.items;
  // The "Because you watched" rows are rebuilt with the grid, so a hide or a recompute updates them too.
  const rowsSlot = h('div', { class: 'view-slot' });
  // 60 at a time; "Show more" adds the next 60 (the count says how many match the filters).
  let limit = 60;
  const more = h('button', { type: 'button', class: 'btn small ghost show-all', hidden: true });
  more.addEventListener('click', () => { limit += 60; draw(); });
  const draw = () => {
    fill(rowsSlot, ...becauseRows(items, (r) => { items = items.filter((x) => x.malId !== r.malId); draw(); }));
    const list = items.filter(passes);
    count.textContent = list.length > limit ? `${limit} of ${list.length}` : `${list.length}`;
    grid.replaceChildren(...(list.length
      ? list.slice(0, limit).map((r) => recCard(r, () => { items = items.filter((x) => x.malId !== r.malId); draw(); }))
      : [h('div', { class: 'empty' }, 'Nothing matches these filters.')]));
    more.hidden = list.length <= limit;
    more.textContent = `Show ${Math.min(60, list.length - limit)} more`;
  };
  draw();
  const refresh = h('button', { type: 'button', class: 'btn push-end' }, 'Recompute');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true; refresh.textContent = 'Recomputing…';
    try { items = (await api.recommendations(true)).items; draw(); toast(`Recomputed: ${items.length} recommendations`); }
    catch (err) { toast(err.message); }
    refresh.disabled = false; refresh.textContent = 'Recompute';
  });
  // This season's row fills in when it arrives (its first fetch of the day can take a few seconds).
  const seasonalSlot = h('div', { class: 'view-slot' });
  seasonalPromise.then((el) => { if (el) seasonalSlot.replaceChildren(el); });
  // A new library has no taste profile and no recommendations yet: say how to get them.
  if (!data.profile.genres.length) {
    view.replaceChildren(seasonalSlot,
      section('Recommended for you', null, h('div', { class: 'panel' },
        h('p', {}, 'Recommendations appear once your library has a few shows you watched.'),
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn primary', href: '#/sync' }, 'Sync Crunchyroll or import a list')))),
      section('Find anything', null, ...searchPanel(new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '')));
    return;
  }
  view.replaceChildren(...[
    seasonalSlot,
    rowsSlot,
    section('Your taste', 'Weighted by how much of each show you watched, how recently, and your star ratings',
      h('div', { class: 'taste' },
        h('div', { class: 'taste-group' },
          h('span', { class: 'watch-label' }, 'Genres'),
          h('div', { class: 'chips' }, data.profile.genres.slice(0, 8).map(([g, w]) => {
            const pct = Math.round(w * 100);
            return h('span', { class: 'chip taste-chip num', style: { '--w': `${pct}%` }, title: `${g}: ${pct}% of what you watch` }, h('span', {}, g), h('span', { class: 'chip-count' }, `${pct}%`));
          }))),
        h('div', { class: 'taste-group' },
          h('span', { class: 'watch-label' }, 'Themes'),
          h('div', { class: 'chips' }, data.profile.tags.slice(0, 14).map(([t]) => h('span', { class: 'chip ghost' }, t)))))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Recommended for you'), count, refresh),
      h('p', { class: 'muted' }, 'Shows you haven’t watched, from AniList community recommendations of shows you liked. Rate shows (open one from your Library) to steer this; dropped and 1–2 star shows count against their recommendations.'),
      filterBar(draw),
      grid,
      more),
    section('Find anything', null, ...searchPanel(new URLSearchParams(location.hash.split('?')[1] || '').get('q') || ''))].filter(Boolean));
}
