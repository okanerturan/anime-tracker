import { api } from '../api.js';
import { bus } from '../bus.js';
import { h, section, ago, toast, FORMAT_LABEL, icon } from '../ui.js';

/** AniList's {year, month, day} as YYYY-MM-DD, or null when any part is missing. */
const fuzzyDate = (d) => (d && d.year && d.month && d.day ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);

const ANILIST_STATUS = { COMPLETED: 'completed', CURRENT: 'watching', REPEATING: 'watching', PAUSED: 'onhold', DROPPED: 'dropped', PLANNING: 'plan' };

/** Read a public AniList list straight from AniList in the browser, then use the same import as MAL. */
function aniListImport() {
  const name = h('input', { type: 'text', class: 'search', placeholder: 'AniList username', 'aria-label': 'AniList username', autocomplete: 'off' });
  const go = h('button', { type: 'button', class: 'btn small primary' }, 'Import');
  const status = h('p', { class: 'muted', role: 'status' });
  const run = async () => {
    const user = name.value.trim();
    if (!user) { name.focus(); return; }
    go.disabled = true; status.textContent = 'Reading your AniList list…';
    try {
      const query = `query($u:String){MediaListCollection(userName:$u,type:ANIME){lists{entries{status progress score(format:POINT_10_DECIMAL) updatedAt completedAt{year month day} startedAt{year month day} media{idMal episodes title{romaji english}}}}}}`;
      const res = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables: { u: user } }) });
      const json = await res.json();
      if (json.errors) throw new Error(/not found|Private/i.test(json.errors[0].message) ? 'That user was not found, or their list is private.' : json.errors[0].message);
      const entries = (json.data?.MediaListCollection?.lists || []).flatMap((l) => l.entries).filter((e) => e.media?.idMal).map((e) => ({
        malId: e.media.idMal, title: e.media.title.english || e.media.title.romaji, episodes: e.media.episodes,
        watched: e.status === 'COMPLETED' && e.media.episodes ? e.media.episodes : e.progress, score: e.score || 0, status: ANILIST_STATUS[e.status] || null,
        watchedAt: fuzzyDate(e.completedAt) || (e.updatedAt ? new Date(e.updatedAt * 1000).toISOString().slice(0, 10) : null) || fuzzyDate(e.startedAt)
      }));
      if (!entries.length) { status.textContent = 'That list has no anime with a MyAnimeList id.'; go.disabled = false; return; }
      status.textContent = `Importing ${entries.length} shows…`;
      const r = await api.importMal(entries);
      status.textContent = `Imported ${r.shows} shows: ${r.added} new to the library, ${r.episodesMarked} episodes marked watched, ${r.rated} ratings, ${r.held} on hold, ${r.dropped} dropped${r.skipped ? `, ${r.skipped} planning skipped` : ''}.`;
      bus.emit('library-changed');
    } catch (err) { status.textContent = `Import failed: ${err.message}`; }
    go.disabled = false;
  };
  go.addEventListener('click', run);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  return [h('div', { class: 'inline-form' }, name, go), status];
}

/** Show the first `limit` rows of a list, with a "Show all N" button for the rest. */
function capList(listEl, limit = 8) {
  const rows = [...listEl.children];
  if (rows.length <= limit) return listEl;
  rows.slice(limit).forEach((r) => { r.hidden = true; });
  const more = h('button', { type: 'button', class: 'btn small ghost show-all' }, `Show all ${rows.length}`);
  more.addEventListener('click', () => { rows.forEach((r) => { r.hidden = false; }); more.remove(); });
  return [listEl, more];
}

const MAL_STATUS = { Completed: 'completed', Watching: 'watching', 'On-Hold': 'onhold', Dropped: 'dropped', 'Plan to Watch': 'plan' };

/** Read a MAL export (.xml or .xml.gz) in the browser and send just the fields the tracker needs. */
function malInput() {
  const input = h('input', { type: 'file', accept: '.xml,.gz,application/xml,application/gzip', 'aria-label': 'MyAnimeList export file' });
  const status = h('p', { class: 'muted', role: 'status' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      status.textContent = 'Reading…';
      const text = /\.gz$/i.test(file.name)
        ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : await file.text();
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const pick = (n, tag) => n.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
      const entries = [...doc.getElementsByTagName('anime')].map((n) => ({
        malId: Number(pick(n, 'series_animedb_id')), title: pick(n, 'series_title'), episodes: Number(pick(n, 'series_episodes')) || null,
        watched: Number(pick(n, 'my_watched_episodes')) || 0, score: Number(pick(n, 'my_score')) || 0, status: MAL_STATUS[pick(n, 'my_status')] || null,
        watchedAt: [pick(n, 'my_finish_date'), pick(n, 'my_start_date')].find((d) => d && !/^0000|-00/.test(d)) || null
      })).filter((e) => e.malId);
      if (!entries.length) { status.textContent = 'No anime found in that file. Is it a MyAnimeList anime list export?'; return; }
      status.textContent = `Importing ${entries.length} shows…`;
      const r = await api.importMal(entries);
      status.textContent = `Imported ${r.shows} shows: ${r.added} new to the library, ${r.episodesMarked} episodes marked watched, ${r.rated} ratings, ${r.held} on hold, ${r.dropped} dropped${r.skipped ? `, ${r.skipped} plan-to-watch skipped` : ''}. Details and thumbnails fill in over the next minutes.`;
      bus.emit('library-changed');
    } catch (err) { status.textContent = `Import failed: ${err.message}`; }
  });
  return [input, status];
}

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const [cr, bg, stats, odd] = await Promise.all([api.crStatus(), api.syncStatus(), api.stats(), api.suspicious().catch(() => [])]);
  const last = cr.lastSync;
  const stale = !last || Date.now() - new Date(last.at).getTime() > 2 * 86400000;

  const review = cr.needsReview.length ? h('table', { class: 'simple' },
    h('tr', {}, h('th', {}, 'Crunchyroll season'), h('th', {}, 'Mapped to'), h('th', {}, 'Fix')),
    cr.needsReview.map((r) => {
      // Fix by searching for the right show, not by typing an id.
      const search = h('input', { type: 'search', class: 'search', placeholder: 'Search the right show…', 'aria-label': `Search the right show for ${r.seriesTitle}` });
      const results = h('div', { class: 'review-results' });
      const offInput = h('input', { type: 'number', value: r.offset || 0, 'aria-label': 'Episode offset', title: 'Crunchyroll episode number minus the show’s episode number (0 unless Crunchyroll numbers seasons continuously)', style: { 'inline-size': '5rem' } });
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        const q = search.value.trim();
        if (q.length < 2) { results.replaceChildren(); return; }
        timer = setTimeout(async () => {
          try {
            const list = await api.search(q);
            results.replaceChildren(...list.slice(0, 5).map((a) => {
              const b = h('button', { type: 'button', class: 'review-pick' },
                h('img', { src: a.image, alt: '' }),
                h('span', {}, h('b', {}, a.titleEnglish || a.title), h('span', { class: 'muted' }, ` · ${[a.releaseDate?.slice(0, 4), FORMAT_LABEL[a.format] || a.format, a.totalEpisodes ? `${a.totalEpisodes} eps` : null].filter(Boolean).join(' · ')}`)));
              b.addEventListener('click', async () => {
                b.disabled = true;
                try { const res = await api.crRemap(r.seasonId, a.malId, Number(offInput.value) || 0); toast(`Mapped to ${a.titleEnglish || a.title} · ${res.marked} episodes marked`); render(view); }
                catch (err) { b.disabled = false; toast(err.message); }
              });
              return b;
            }));
          } catch (err) { results.replaceChildren(h('span', { class: 'muted' }, err.message)); }
        }, 350);
      });
      const ok = h('button', { type: 'button', class: 'btn small' }, 'Looks right');
      ok.addEventListener('click', async () => { await api.crConfirm(r.seasonId); render(view); });
      return h('tr', {},
        h('td', {}, `${r.seriesTitle} · ${r.seasonTitle || ''}`),
        h('td', {}, r.malId ? h('a', { href: `https://myanimelist.net/anime/${r.malId}`, target: '_blank', rel: 'noopener' }, r.mappedTitle || `MAL ${r.malId}`) : h('span', { class: 'muted' }, 'not found')),
        h('td', {}, h('div', { class: 'inline-form' }, search, offInput, r.malId ? ok : null), results));
    })) : h('div', { class: 'muted' }, 'All Crunchyroll seasons are mapped.');

  const fileInput = h('input', { type: 'file', accept: 'application/json', 'aria-label': 'Watch history JSON file' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const rows = JSON.parse(await file.text());
    const res = await api.crIngest(rows);
    toast(`Imported ${res.stored} rows · ${res.marked} newly watched`);
    render(view);
  });
  const runBtn = h('button', { type: 'button', class: 'btn' }, 'Refresh metadata now');
  runBtn.addEventListener('click', async () => {
    await api.runSync();
    toast('Background refresh started');
    // If AniList blocks the server, the refresh queues requests for this browser: answer them now.
    setTimeout(() => bus.emit('relay-now'), 4000);
  });

  view.replaceChildren(...[
    section('Crunchyroll sync', last ? `Last sync ${ago(last.at)} via ${last.source}` : 'Never synced',
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, (cr.rows ?? 0).toLocaleString()), h('div', { class: 'l' }, 'history episodes stored')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, cr.latestPlayed ? new Date(cr.latestPlayed).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'), h('div', { class: 'l' }, 'latest play')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, last?.summary?.marked ?? '—'), h('div', { class: 'l' }, 'newly watched in last sync')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, cr.needsReview.length), h('div', { class: 'l' }, 'seasons to review')),
        h('div', { class: 'stat' }, h('div', { class: 'v num' }, cr.extension?.seen || '—'), h('div', { class: 'l' }, cr.extension?.seen ? (cr.extension.seen === cr.extension.latest ? 'extension version (current)' : `extension version (latest ${cr.extension.latest})`) : 'extension not seen yet'))),
      cr.extension?.seen && cr.extension.latest && cr.extension.seen !== cr.extension.latest ? h('div', { class: 'panel warn' },
        h('b', {}, `Extension update available: ${cr.extension.latest} (yours is ${cr.extension.seen}). `),
        'Open ', h('span', { class: 'mono' }, 'chrome://extensions'), ' and click the reload icon on Anime Tracker. Syncing keeps working on the old version; new features don’t.') : null,
      stale ? h('div', { class: 'panel warn' },
        h('b', {}, 'Automatic sync is not running. '),
        'Install the browser extension below; it syncs every 30 minutes, whenever you open Crunchyroll, and a couple of minutes after you finish an episode.') : null),
    h('details', { class: 'collapse section', open: stale ? '' : null },
      h('summary', {}, h('div', { class: 'section-head' },
        h('h2', {}, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸ '), 'Set up automatic sync'),
        h('span', { class: 'sub' }, stale ? 'One-time, about a minute' : 'Done: the extension is syncing. Open this if you set up another computer.'))),
      h('div', { class: 'collapse-body panel' }, h('ol', { class: 'steps' },
        h('li', {}, 'Open ', h('span', { class: 'mono' }, 'chrome://extensions'), ' and turn on Developer mode (top right).'),
        h('li', {}, 'Click “Load unpacked” and choose the ', h('span', { class: 'mono' }, 'extension'), ' folder inside this project.'),
        h('li', {}, 'Open crunchyroll.com once while logged in. The extension syncs right away, then every 30 minutes while Chrome is open and a couple of minutes after you finish an episode.'),
        h('li', {}, 'In the extension’s popup, set the Tracker URL to this page’s address (and the passphrase as Tracker key when it’s hosted). The popup shows the last sync and has a “Sync now” button.')),
        h('p', { class: 'muted' }, 'The extension uses your existing Crunchyroll login inside your own browser. It never stores your password or tokens, and only talks to crunchyroll.com and your tracker.'))),
    cr.rows ? section('Needs review', 'Seasons the tracker mapped by guessing', h('div', { class: 'panel' }, review)) : null,
    odd.length ? section('Odd progress', `${odd.length} show${odd.length === 1 ? '' : 's'} with the finale ticked but most episodes not. Usually a mapping slip or a stray bulk mark.`,
      h('div', { class: 'quiet-list' }, odd.map((x) => {
        const all = h('button', { type: 'button', class: 'btn small' }, 'I watched it all');
        const stray = h('button', { type: 'button', class: 'btn small ghost' }, `Remove stray E${x.aired}`);
        const row = h('div', { class: 'rate-item odd-item' },
          h('img', { src: x.image || '', alt: '', loading: 'lazy' }),
          h('div', { class: 'rate-text' }, h('span', { class: 'week-item-title one-line', title: x.title }, x.title), h('span', { class: 'week-item-sub num' }, `${x.watched} of ${x.aired} ticked, including the finale`)),
          h('div', { class: 'odd-actions' }, all, stray));
        // Both fixes hide the row and offer Undo, which reverses exactly what they changed.
        const restore = () => { row.hidden = false; all.disabled = stray.disabled = false; bus.emit('library-changed'); };
        all.addEventListener('click', async () => {
          all.disabled = stray.disabled = true;
          try {
            const r = await api.watchedThrough(x.malId, x.aired); row.hidden = true; bus.emit('library-changed');
            toast(`${x.title}: all ${x.aired} marked watched`, { label: 'Undo', onClick: async () => { try { await api.unmark(x.malId, r.episodes || []); restore(); } catch (err) { toast(err.message); } } });
          } catch (err) { all.disabled = stray.disabled = false; toast(err.message); }
        });
        stray.addEventListener('click', async () => {
          all.disabled = stray.disabled = true;
          try {
            await api.toggleWatched(x.malId, x.aired, false); row.hidden = true; bus.emit('library-changed');
            toast(`${x.title}: E${x.aired} unmarked`, { label: 'Undo', onClick: async () => { try { await api.toggleWatched(x.malId, x.aired, true); restore(); } catch (err) { toast(err.message); } } });
          } catch (err) { all.disabled = stray.disabled = false; toast(err.message); }
        });
        return row;
      }))) : null,
    cr.sampled?.length ? section('Sampled, not tracked', `${cr.sampled.length} Crunchyroll seasons you tried but never finished an episode of. Track one to add it to your library.`,
      capList(h('div', { class: 'quiet-list' }, cr.sampled.map((s) => {
        const btn = h('button', { type: 'button', class: 'btn small' }, 'Track');
        const hide = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Not interested in ${s.seriesTitle}`, title: 'Not interested: hide from this list' }, icon('close'));
        hide.addEventListener('click', async () => {
          try {
            await api.crHideSampled(s.seasonId);
            row.hidden = true;
            toast(`Hid ${s.seriesTitle}`, { label: 'Undo', onClick: async () => { try { await api.crHideSampled(s.seasonId, true); row.hidden = false; } catch (err) { toast(err.message); } } });
          } catch (err) { toast(err.message); }
        });
        const row = h('div', { class: 'rate-item' },
          h('img', { src: s.thumb || '', alt: '', loading: 'lazy' }),
          h('div', { class: 'rate-text' },
            h('span', { class: 'week-item-title one-line', title: `${s.seriesTitle} · ${s.seasonTitle || ''}` }, s.seriesTitle),
            h('span', { class: 'week-item-sub one-line' }, `${s.seasonTitle && s.seasonTitle !== s.seriesTitle ? `${s.seasonTitle} · ` : ''}${s.plays} play${s.plays === 1 ? '' : 's'} · ${ago(s.lastPlayed)}`)),
          btn, hide);
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = 'Finding…';
          try { const r = await api.crTrack(s.seasonId); toast(r.needsReview ? `Added ${r.title}; check the match above` : `Added ${r.title}`); row.remove(); }
          catch (err) { btn.disabled = false; btn.textContent = 'Track'; toast(err.message); }
        });
        return row;
      })))) : null,
    h('details', { class: 'collapse section', id: 'import', open: (stats.library || 0) < 20 || /[?&]import=1/.test(location.hash) ? '' : null },
      h('summary', {}, h('div', { class: 'section-head' },
        h('h2', {}, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸ '), 'Import from elsewhere'),
        h('span', { class: 'sub' }, 'AniList, MyAnimeList, or a Crunchyroll history file'))),
      h('div', { class: 'collapse-body import-grid' },
        h('div', { class: 'panel' }, h('h3', {}, 'AniList'), h('p', { class: 'muted' }, 'Your public anime list by username: progress, scores, paused and dropped.'), aniListImport()),
        h('div', { class: 'panel' }, h('h3', {}, 'MyAnimeList'),
          h('p', { class: 'muted' }, 'On MyAnimeList, open ', h('a', { href: 'https://myanimelist.net/panel.php?go=export', target: '_blank', rel: 'noopener' }, 'Export'), ' and export your anime list, then choose the .xml.gz file here.'),
          malInput()),
        h('div', { class: 'panel' }, h('h3', {}, 'Crunchyroll history file'), h('p', { class: 'muted' }, 'Alternative to the extension: a watch-history JSON export.'), fileInput),
        h('p', { class: 'muted' }, 'Imports never un-watch anything or overwrite your ratings and list states.'))),
    section('Background metadata', [
      bg.phase !== 'idle' ? `Refreshing (${bg.phase})` : bg.lastCycle ? `Last refresh ${ago(bg.lastCycle.at)}` : 'No refresh yet',
      `${bg.queueLength} queued`, `Jikan ${bg.jikanAvailable ? 'reachable' : 'down (skipped)'}`].join(' · '),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, stats.library), h('div', { class: 'l' }, 'shows in library')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${(stats.episodes?.w ?? 0).toLocaleString()} / ${(stats.episodes?.n ?? 0).toLocaleString()}`), h('div', { class: 'l' }, 'episodes watched')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${Math.round((100 * stats.episodes.i) / Math.max(stats.episodes.n, 1))}%`), h('div', { class: 'l' }, 'episode thumbnails stored')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, (stats.images?.cached ?? 0).toLocaleString()), h('div', { class: 'l' }, `posters cached locally (${Math.round((stats.images?.bytes ?? 0) / 1048576)} MB)`))),
      bg.anilist?.blocked ? h('div', { class: 'panel warn' },
        h('b', {}, 'AniList is blocking this server. '),
        `Your browser fetches AniList data instead: the extension does it after each sync, and this page does it while it's open. Waiting: ${bg.anilist.pendingIds} shows, ${bg.anilist.pendingQueries} lookups.`) : null,
      h('div', {}, runBtn)),
    bg.lastBackup ? section('Backups', `Nightly, last ${ago(bg.lastBackup.at)} · ${bg.lastBackup.kept} kept`,
      h('div', { class: 'panel' },
        h('p', {}, `Every table except episode thumbnails (the sync re-fetches those), gzipped: ${Math.round(bg.lastBackup.bytes / 1024).toLocaleString()} KB, ${bg.lastBackup.rows.toLocaleString()} rows. `,
          'Restore with ', h('span', { class: 'mono' }, 'node scripts/backup.js restore'), '.'),
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn', href: '/api/backup', download: '' }, 'Download latest'),
          h('a', { class: 'btn ghost', href: '/api/backup?fresh=1', download: '' }, 'Back up now and download')))) : null].filter(Boolean));
  if (/[?&]import=1/.test(location.hash)) view.querySelector('#import')?.scrollIntoView({ block: 'start' });
}
