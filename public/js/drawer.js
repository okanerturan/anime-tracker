// Anime detail drawer: a modal <dialog> with a fixed top bar and a scrolling body.
import { api } from './api.js';
import { h, icon, media, toast, statusPill, relTime, FORMAT_LABEL } from './ui.js';
import { bus } from './bus.js';

const dialog = () => document.getElementById('drawer');

dialog().addEventListener('click', (e) => {
  // A click on the backdrop lands on the dialog element itself.
  if (e.target === dialog()) dialog().close();
});

export function closeDrawer() {
  if (dialog().open) dialog().close();
}

const cleanEpisodeTitle = (title) => String(title || '').replace(/^Episode\s+\d+\s*[:\-–]\s*/i, '') || title;

export async function openAnime(partial) {
  let item = partial;
  if (!item.synopsis || !item.genres || item.inLibrary === undefined) {
    try {
      const full = await api.anime(item.malId);
      item = {
        ...full, ...partial,
        title: partial.title || full.titleEnglish || full.title,
        image: partial.image || full.imageUrl,
        synopsis: full.synopsis, genres: full.genres, status: full.status, format: full.format,
        averageScore: full.averageScore, nextAiringAt: full.nextAiringAt, nextAiringEpisode: full.nextAiringEpisode,
        inLibrary: full.inLibrary, totalEpisodes: full.totalEpisodes
      };
    } catch {}
  }

  const epContainer = h('div', { class: 'ep-grid' }, h('div', { class: 'skeleton' }));
  const summary = h('span', { class: 'sub num' });
  const synopsis = item.synopsis ? h('p', { class: 'synopsis', 'data-expanded': 'false' }, item.synopsis) : null;
  const more = synopsis ? h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false' }, 'Show more') : null;
  if (more) {
    more.addEventListener('click', () => {
      const open = synopsis.dataset.expanded !== 'true';
      synopsis.dataset.expanded = String(open);
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Show less' : 'Show more';
    });
  }
  const airsAt = item.nextAiringAt ? item.nextAiringAt * (item.nextAiringAt < 1e12 ? 1000 : 1) : null;

  const refreshBtn = h('button', { type: 'button', class: 'btn' }, 'Refresh episodes');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try { await api.syncAnime(item.malId); await load(); toast('Episodes refreshed'); } catch (err) { toast(err.message); }
    refreshBtn.disabled = false;
  });
  const removeBtn = h('button', { type: 'button', class: 'btn ghost' }, 'Remove');
  removeBtn.addEventListener('click', async () => {
    if (!window.confirm(`Remove "${item.title}" from your library?`)) return;
    await api.remove(item.malId);
    toast('Removed');
    bus.emit('library-changed');
    closeDrawer();
  });

  // External links + franchise (prequels, sequels, side stories), filled in once details load.
  const linksRow = h('div', { class: 'hero-actions' },
    h('a', { class: 'btn', href: `https://myanimelist.net/anime/${item.malId}`, target: '_blank', rel: 'noopener' }, 'MyAnimeList'));
  const relatedSection = h('section', { class: 'section', hidden: true });
  const watchRow = h('div', { class: 'hero-actions watch-row' });
  api.details(item.malId).then((d) => {
    const ext = (label, href, extra = {}) => h('a', { class: 'btn', href, target: '_blank', rel: 'noopener', ...extra }, label);
    const services = d.watchOn.filter((l) => !/crunchyroll/i.test(l.site));
    const hasCrunchyroll = !d.links.crunchyrollIsSearch || d.watchOn.some((l) => /crunchyroll/i.test(l.site));
    const crUrl = !d.links.crunchyrollIsSearch ? d.links.crunchyroll : (d.watchOn.find((l) => /crunchyroll/i.test(l.site))?.url || d.links.crunchyroll);
    watchRow.replaceChildren(
      h('span', { class: 'watch-label' }, 'Where to watch'),
      ext(hasCrunchyroll ? 'Crunchyroll' : 'Search Crunchyroll', crUrl, { class: `btn small ${hasCrunchyroll ? 'primary' : ''}` }),
      ...services.map((l) => ext(l.site, l.url, { class: 'btn small' })));
    linksRow.replaceChildren(
      ext('MyAnimeList', d.links.myAnimeList, { class: 'btn small ghost' }),
      d.links.aniList ? ext('AniList', d.links.aniList, { class: 'btn small ghost' }) : null);
    if (!d.relations.length) return;
    relatedSection.hidden = false;
    relatedSection.replaceChildren(
      h('div', { class: 'section-head' }, h('h2', {}, 'Seasons and related'), h('span', { class: 'sub' }, `${d.relations.length} in this franchise`)),
      h('div', { class: 'related' }, d.relations.map(relatedCard)));
  }).catch(() => {});

  function relatedCard(r) {
    const label = { PREQUEL: 'Previous season', SEQUEL: 'Next season', PARENT: 'Main story', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative', SUMMARY: 'Recap' }[r.relationType] || r.relationType;
    const done = r.episodes && r.watched >= r.episodes;
    const progressText = r.watched ? (done ? '✓ Watched' : `${r.watched}/${r.episodes ?? '?'} watched`) : (r.inLibrary ? 'Not started' : 'Not in library');
    const open = () => openAnime({ malId: r.malId, title: r.title, image: r.image });
    return h('article', { class: `card related-card ${done ? 'is-completed' : ''}` },
      media({ src: r.image, alt: '', kind: 'poster' }),
      h('div', { class: 'related-info' },
        h('span', { class: 'pill' }, label),
        h('h3', { class: 'card-title clamp-2', title: r.title },
          h('a', { class: 'card-link', href: `https://myanimelist.net/anime/${r.malId}`, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); open(); } }, r.title)),
        h('p', { class: 'card-meta' }, [r.startDate?.slice(0, 4), FORMAT_LABEL[r.format] || r.format, r.episodes ? `${r.episodes} eps` : null].filter(Boolean).join(' · ')),
        h('p', { class: `card-sub ${done ? 'done-text' : ''}` }, progressText)));
  }

  function notInLibraryActions() {
    const add = h('button', { type: 'button', class: 'btn primary' }, 'Add to library');
    add.addEventListener('click', async () => {
      add.disabled = true;
      try { await api.add({ malId: item.malId, title: item.title, totalEpisodes: item.totalEpisodes }); bus.emit('library-changed'); toast(`Added ${item.title}`); openAnime({ malId: item.malId, title: item.title, image: item.image }); }
      catch (err) { add.disabled = false; toast(err.message); }
    });
    const watched = h('button', { type: 'button', class: 'btn', title: 'Watched it on another service' }, 'I watched this');
    watched.addEventListener('click', async () => {
      watched.disabled = true;
      try { const r = await api.watchedElsewhere(item.malId); bus.emit('library-changed'); toast(`Marked ${item.title} as watched (${r.aired} episodes)`); openAnime({ malId: item.malId, title: item.title, image: item.image }); }
      catch (err) { watched.disabled = false; toast(err.message); }
    });
    return [add, watched];
  }

  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close' }, icon('close'));
  closeBtn.addEventListener('click', closeDrawer);

  dialog().replaceChildren(
    h('div', { class: 'drawer-top' },
      h('span', { class: 'title one-line', id: 'drawer-title' }, item.title),
      closeBtn),
    h('div', { class: 'drawer-scroll' },
      h('div', { class: 'hero' },
        media({ src: item.image, alt: item.title, kind: 'poster' }),
        h('div', { class: 'hero-info' },
          h('h2', {}, item.title),
          h('div', { class: 'chips' },
            statusPill(item.status),
            item.format ? h('span', { class: 'chip' }, FORMAT_LABEL[item.format] || item.format) : null,
            item.averageScore ? h('span', { class: 'chip num' }, `★ ${item.averageScore}`) : null,
            ...(item.genres || []).slice(0, 6).map((g) => h('span', { class: 'chip' }, g))),
          airsAt ? h('p', { class: 'muted' }, `Episode ${item.nextAiringEpisode} airs ${relTime(airsAt)}`) : null,
          synopsis, more,
          watchRow,
          h('div', { class: 'hero-actions' }, ...(item.inLibrary === false ? notInLibraryActions() : [refreshBtn, removeBtn])),
          linksRow)),
      relatedSection,
      item.inLibrary === false ? null : h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Episodes'), summary),
        epContainer)));

  if (!dialog().open) dialog().showModal();
  closeBtn.focus();
  // Show "Show more" only when the synopsis is actually clamped.
  if (synopsis) requestAnimationFrame(() => { if (synopsis.scrollHeight <= synopsis.clientHeight + 2) more.hidden = true; });

  function updateSummary() {
    const all = epContainer.querySelectorAll('.ep-tile').length;
    const watched = epContainer.querySelectorAll('.ep-tile[data-watched="true"]').length;
    summary.textContent = `${watched} of ${all} watched`;
  }

  async function load() {
    const data = await api.episodes(item.malId);
    const eps = data.seasons.flatMap((s) => s.episodes);
    epContainer.replaceChildren(...(eps.length ? eps.map(tile) : [h('div', { class: 'empty' }, 'No episodes yet. Try “Refresh episodes”.')]));
    updateSummary();
  }

  function tile(ep) {
    const name = cleanEpisodeTitle(ep.title);
    const check = h('button', {
      type: 'button', class: 'check', 'aria-pressed': String(ep.watched),
      'aria-label': `Episode ${ep.episodeNumber} watched`,
      title: 'Toggle watched. Shift-click marks every episode up to this one.'
    }, icon('check'));
    const el = h('article', { class: 'card ep-tile', 'data-watched': String(ep.watched) },
      media({ src: ep.image, alt: '', badges: [h('span', { class: 'pill dark badge-bottom num' }, `E${ep.episodeNumber}`)] }),
      h('div', { class: 'ep-row' },
        h('span', { class: 'name clamp-2', title: name }, name),
        ep.crunchyrollUrl ? h('a', { class: 'icon-btn play', href: ep.crunchyrollUrl, target: '_blank', rel: 'noopener', 'aria-label': `Watch episode ${ep.episodeNumber} on Crunchyroll`, title: 'Watch on Crunchyroll' }, icon('play')) : null,
        check));
    check.addEventListener('click', async (e) => {
      try {
        if (e.shiftKey && !ep.watched) {
          await api.watchedThrough(item.malId, ep.episodeNumber);
          await load();
        } else {
          const r = await api.toggleWatched(item.malId, ep.episodeNumber, !ep.watched);
          ep.watched = r.watched;
          el.dataset.watched = String(ep.watched);
          check.setAttribute('aria-pressed', String(ep.watched));
          updateSummary();
        }
        bus.emit('library-changed');
      } catch (err) { toast(err.message); }
    });
    return el;
  }

  if (item.inLibrary !== false) load().catch((err) => { epContainer.replaceChildren(h('div', { class: 'empty' }, err.message)); });
}

