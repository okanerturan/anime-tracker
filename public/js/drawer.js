// Anime detail drawer: a modal <dialog> with a fixed top bar and a scrolling body.
import { api } from './api.js';
import { h, fill, icon, media, toast, statusPill, relTime, FORMAT_LABEL } from './ui.js';
import { runRelay } from './anilist-relay.js';
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
        inLibrary: full.inLibrary, totalEpisodes: full.totalEpisodes, listStatus: full.listStatus, rating: full.rating,
        releaseDate: full.releaseDate
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
  // Not out yet: no "I watched this", and the episode list explains why it's empty.
  const unreleased = item.status === 'NOT_YET_RELEASED';
  const premiereText = () => {
    const d = item.releaseDate && new Date(item.releaseDate);
    return d && !Number.isNaN(d.getTime()) && d > new Date()
      ? `Hasn’t aired yet: premieres ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`
      : 'Hasn’t aired yet: no premiere date announced';
  };
  const airsAt = item.nextAiringAt ? item.nextAiringAt * (item.nextAiringAt < 1e12 ? 1000 : 1) : null;

  const refreshBtn = h('button', { type: 'button', class: 'btn' }, 'Refresh episodes');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const before = epContainer.querySelectorAll('.ep-tile').length;
      await api.syncAnime(item.malId); await load();
      const after = epContainer.querySelectorAll('.ep-tile').length;
      toast(unreleased ? 'Nothing to fetch: it hasn’t aired yet' : after > before ? `Found ${after - before} new episode${after - before === 1 ? '' : 's'}` : `Up to date: ${after} episode${after === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message); }
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
  // "Play next" sits above everything once the episode list tells us which episode and where.
  const playRow = h('div', { class: 'hero-actions play-row' });
  let details = null;
  api.details(item.malId).then((d) => {
    details = d;
    offerSequel();
    // Shows known only as someone's sequel or recommendation lack full metadata; fetch it (through the
    // browser relay when AniList blocks the server) and reopen once it has arrived.
    if (d.partial && !partial._refetched) {
      api.anime(item.malId, true).catch(() => {})
        .then(() => runRelay())
        .then(() => { if (dialog().open && document.getElementById('drawer-title')?.textContent === item.title) openAnime({ ...partial, _refetched: true }); });
    }
    const ext = (label, href, extra = {}) => h('a', { class: 'btn', href, target: '_blank', rel: 'noopener', ...extra }, label);
    const services = d.watchOn.filter((l) => !/crunchyroll/i.test(l.site));
    const hasCrunchyroll = !d.links.crunchyrollIsSearch || d.watchOn.some((l) => /crunchyroll/i.test(l.site));
    const crUrl = !d.links.crunchyrollIsSearch ? d.links.crunchyroll : (d.watchOn.find((l) => /crunchyroll/i.test(l.site))?.url || d.links.crunchyroll);
    fill(watchRow,
      h('span', { class: 'watch-label' }, 'Where to watch'),
      d.links.notOnCrunchyroll ? h('span', { class: 'chip', title: 'Crunchyroll’s search found no match in your region' }, 'Not on Crunchyroll') : null,
      ext(hasCrunchyroll ? 'Crunchyroll' : 'Search Crunchyroll', crUrl, {
        class: `btn small ${hasCrunchyroll ? 'primary' : ''}`,
        title: d.links.notOnCrunchyroll ? 'Crunchyroll search found no match for this show' : d.links.crunchyrollSource === 'franchise' ? 'Series page shared with its other seasons' : null }),
      ...services.map((l) => ext(l.site, l.url, { class: 'btn small' })));
    fill(linksRow,
      ext('MyAnimeList', d.links.myAnimeList, { class: 'btn small ghost' }),
      d.links.aniList ? ext('AniList', d.links.aniList, { class: 'btn small ghost' }) : null);
    if (!d.relations.length) return;
    relatedSection.hidden = false;
    fill(relatedSection,
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
    if (unreleased) return [add, h('span', { class: 'muted' }, premiereText())];
    const watched = h('button', { type: 'button', class: 'btn', title: 'Watched it on another service' }, 'I watched this');
    watched.addEventListener('click', async () => {
      watched.disabled = true;
      try { const r = await api.watchedElsewhere(item.malId); bus.emit('library-changed'); toast(`Marked ${item.title} as watched (${r.aired} episodes)`); openAnime({ malId: item.malId, title: item.title, image: item.image }); }
      catch (err) { watched.disabled = false; toast(err.message); }
    });
    return [add, watched];
  }

  // Your rating (1-5, click the same star again to clear) and list state (active, on hold, dropped).
  function listControls() {
    const stars = h('div', { class: 'stars', role: 'group', 'aria-label': 'Your rating' });
    const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
      const b = h('button', { type: 'button', class: 'star', 'aria-pressed': String((item.rating || 0) >= n), 'aria-label': `${n} star${n > 1 ? 's' : ''}`, title: n === item.rating ? 'Clear rating' : `Rate ${n}/5` }, '★');
      b.addEventListener('click', async () => {
        const next = item.rating === n ? null : n;
        try { await api.setRating(item.malId, next); item.rating = next; drawStars(); bus.emit('library-changed'); toast(next ? `Rated ${next}/5` : 'Rating cleared'); }
        catch (err) { toast(err.message); }
      });
      return b;
    }));
    drawStars();
    const statusBox = h('div', { class: 'hero-actions' });
    const LABEL = { on_hold: 'On hold', dropped: 'Dropped' };
    const drawStatus = () => {
      const set = async (status) => {
        try { await api.setListStatus(item.malId, status); item.listStatus = status; drawStatus(); bus.emit('library-changed'); toast(status ? `${LABEL[status]}: ${item.title}` : `${item.title} is active again`); }
        catch (err) { toast(err.message); }
      };
      const btn = (label, status, cls = 'btn small') => { const b = h('button', { type: 'button', class: cls }, label); b.addEventListener('click', () => set(status)); return b; };
      statusBox.replaceChildren(...[
        item.listStatus ? h('span', { class: `pill state-${item.listStatus.replace('_', '-')}` }, LABEL[item.listStatus]) : null,
        item.listStatus ? btn('Make active', null, 'btn small primary') : null,
        item.listStatus !== 'on_hold' ? btn('Put on hold', 'on_hold') : null,
        item.listStatus !== 'dropped' ? btn('Drop', 'dropped', 'btn small ghost') : null].filter(Boolean));
    };
    drawStatus();
    return h('div', { class: 'list-controls' }, h('span', { class: 'watch-label' }, 'Your rating'), stars, statusBox);
  }

  // "Mark all watched" for shows finished elsewhere; hidden once everything is ticked.
  const markAllBtn = h('button', { type: 'button', class: 'btn small ghost push-end', hidden: true }, 'Mark all watched');
  markAllBtn.addEventListener('click', async () => {
    const last = Math.max(0, ...[...epContainer.querySelectorAll('.ep-tile')].map((t) => Number(t.dataset.episode) || 0));
    if (!last) return;
    markAllBtn.disabled = true;
    try { await api.watchedThrough(item.malId, last); await load(); bus.emit('library-changed'); toast(`All ${last} episodes marked watched`); }
    catch (err) { toast(err.message); }
    markAllBtn.disabled = false;
  });

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
          playRow,
          watchRow,
          item.inLibrary === false ? null : listControls(),
          h('div', { class: 'hero-actions' }, ...(item.inLibrary === false ? notInLibraryActions() : [refreshBtn, removeBtn])),
          linksRow)),
      relatedSection,
      item.inLibrary === false ? null : h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Episodes'), summary, h('span', { class: 'sub' }, 'Shift-click a check to mark everything up to it'), markAllBtn),
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

  let allWatched = false;
  let episodesLoaded = false;

  /** Finished the season: the next thing to do is start the sequel, so say so where Play was. */
  function offerSequel() {
    if (!episodesLoaded || !allWatched || !details) return;
    const sequel = details.continueWith;
    if (!sequel || playRow.querySelector('.sequel-btn')) return;
    const started = sequel.watched > 0;
    const btn = h('button', { type: 'button', class: 'btn primary sequel-btn' }, started ? `Continue ${sequel.title}` : `Start ${sequel.title}`);
    btn.addEventListener('click', () => openAnime({ malId: sequel.malId, title: sequel.title, image: sequel.image }));
    playRow.append(btn);
  }

  async function load() {
    const data = await api.episodes(item.malId);
    const eps = data.seasons.flatMap((s) => s.episodes);
    const furthest = eps.reduce((m, e) => (e.watched && e.episodeNumber > m ? e.episodeNumber : m), 0);
    const next = eps.find((e) => e.episodeNumber === furthest + 1) || eps.find((e) => !e.watched);
    allWatched = eps.length > 0 && eps.every((e) => e.watched);
    episodesLoaded = true;
    markAllBtn.hidden = allWatched || eps.length === 0;

    // Long shows: watched episodes before the next one fold away behind a count, so the panel opens on what's next.
    // A finished show keeps only its last eight tiles out.
    const cut = next ? next.episodeNumber : (eps.length > 24 ? eps[eps.length - 8].episodeNumber : 0);
    const foldCount = eps.filter((e) => e.watched && e.episodeNumber < cut).length;
    const folded = foldCount > 8;
    const tiles = eps.map((e) => { const t = tile(e); if (folded && e.watched && e.episodeNumber < cut) t.hidden = true; return t; });
    const unfold = folded ? h('button', { type: 'button', class: 'btn ghost unfold' }, next ? `Show ${foldCount} watched episodes` : `Show all ${eps.length} episodes`) : null;
    if (unfold) unfold.addEventListener('click', () => { tiles.forEach((t) => { t.hidden = false; }); unfold.remove(); });
    fill(epContainer, unfold, ...(eps.length ? tiles
      : [h('div', { class: 'empty' }, unreleased ? `${premiereText()}. Episodes appear here once they air.` : 'No episodes yet. Try “Refresh episodes”.')]));
    updateSummary();
    const nextName = next && !/^Episode \d+$/.test(next.title || '') ? cleanEpisodeTitle(next.title) : '';
    fill(playRow, next && next.crunchyrollUrl
      ? h('a', { class: 'btn primary', href: next.crunchyrollUrl, target: '_blank', rel: 'noopener' }, icon('play'), ' ', `Play E${next.episodeNumber}${nextName ? ` · ${nextName}` : ''}`)
      : null);
    offerSequel();
  }

  function tile(ep) {
    const name = cleanEpisodeTitle(ep.title);
    const check = h('button', {
      type: 'button', class: 'check', 'aria-pressed': String(ep.watched),
      'aria-label': `Episode ${ep.episodeNumber} watched`,
      title: 'Toggle watched. Shift-click marks every episode up to this one.'
    }, icon('check'));
    const el = h('article', { class: 'card ep-tile', 'data-watched': String(ep.watched), 'data-episode': String(ep.episodeNumber) },
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

