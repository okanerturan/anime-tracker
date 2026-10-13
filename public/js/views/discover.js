import { api } from '../api.js';
import { h, media, section, toast, cardLink, FORMAT_LABEL } from '../ui.js';
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
  const btn = h('button', { type: 'button', class: 'btn small', title: 'Watched it on another service: add it as fully watched' }, 'Watched');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api.watchedElsewhere(malId);
      toast(`Marked ${title} as watched (${r.aired} episodes)`);
      bus.emit('library-changed');
      onDone?.();
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
        group.querySelectorAll('.chip-toggle').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        onChange();
      });
      return b;
    }));
    return h('div', { class: 'filter-group' }, h('span', { class: 'watch-label' }, f.label), group);
  }));
}

function recCard(r, onDismiss) {
  const dismiss = h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Not interested in ${r.title}`, title: 'Not interested' }, 'Hide');
  dismiss.addEventListener('click', async () => { await api.dismiss(r.malId); onDismiss(); });
  const open = () => openAnime({ malId: r.malId, title: r.title, image: r.image });
  return h('article', { class: 'card' },
    media({ src: r.image, alt: '', kind: 'poster', badges: [
      r.onCrunchyroll ? h('span', { class: 'pill cr badge-bottom', title: 'Streaming on Crunchyroll' }, 'Crunchyroll') : null,
      h('div', { class: 'badge-end' }, h('span', { class: 'pill accent num' }, `${r.match}% match`))] }),
    cardLink(r.title, open, { href: r.siteUrl || `https://myanimelist.net/anime/${r.malId}` }),
    h('p', { class: 'card-meta' }, [r.year, FORMAT_LABEL[r.format] || r.format, r.episodes ? `${r.episodes} eps` : null, r.averageScore ? `★ ${r.averageScore}` : null].filter(Boolean).join(' · ')),
    h('p', { class: 'card-sub clamp-3' }, r.because.length ? `Because you watched ${r.because.join(', ')}` : ''),
    h('div', { class: 'card-actions' }, addButton({ malId: r.malId, title: r.title, titleEnglish: r.title, totalEpisodes: r.episodes }, r.inLibrary), watchedButton(r.malId, r.title, onDismiss), dismiss));
}

function searchPanel() {
  const input = h('input', { type: 'search', class: 'search', placeholder: 'Search AniList to add anything…', 'aria-label': 'Search AniList' });
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
          return h('article', { class: 'card' },
            media({ src: a.image, alt: '', kind: 'poster' }),
            a.inLibrary ? cardLink(title, () => openAnime({ ...a, title, image: a.image }), { href: `https://myanimelist.net/anime/${a.malId}` }) : h('h3', { class: 'card-title clamp-2' }, title),
            h('p', { class: 'card-meta' }, [a.releaseDate?.slice(0, 4), FORMAT_LABEL[a.format] || a.format, a.totalEpisodes ? `${a.totalEpisodes} eps` : null].filter(Boolean).join(' · ')),
            h('div', { class: 'card-actions' }, addButton(a, a.inLibrary), watchedButton(a.malId, title)));
        }));
      } catch (err) { results.replaceChildren(h('div', { class: 'empty' }, err.message)); }
    }, 350);
  });
  return [h('div', { class: 'toolbar' }, input), results];
}

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const data = await api.recommendations();
  const grid = h('div', { class: 'cards', style: { '--rows': '5' } });
  const count = h('span', { class: 'sub num' });
  let items = data.items;
  const draw = () => {
    const list = items.filter(passes);
    count.textContent = `${Math.min(list.length, 60)} of ${items.length}`;
    grid.replaceChildren(...(list.length
      ? list.slice(0, 60).map((r) => recCard(r, () => { items = items.filter((x) => x.malId !== r.malId); draw(); }))
      : [h('div', { class: 'empty' }, 'Nothing matches these filters.')]));
  };
  draw();
  const refresh = h('button', { type: 'button', class: 'btn push-end' }, 'Recompute');
  refresh.addEventListener('click', async () => { refresh.disabled = true; items = (await api.recommendations(true)).items; draw(); refresh.disabled = false; });
  view.replaceChildren(
    section('Your taste', 'Weighted by how much of each show you watched, how recently, and your star ratings',
      h('div', { class: 'chips' }, data.profile.genres.slice(0, 8).map(([g, w]) => h('span', { class: 'chip num' }, `${g} ${Math.round(w * 100)}%`))),
      h('div', { class: 'chips' }, data.profile.tags.slice(0, 14).map(([t]) => h('span', { class: 'chip' }, t)))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Recommended for you'), count, refresh),
      h('p', { class: 'muted' }, 'Shows you haven’t watched, from AniList community recommendations of shows you liked. Rate shows (open one from your Library) to steer this; dropped and 1–2 star shows count against their recommendations.'),
      filterBar(draw),
      grid),
    section('Find anything', null, ...searchPanel()));
}
