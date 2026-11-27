import { loadMe, connectionSections } from './account.js';
import { api } from '../api.js';
import { bus } from '../bus.js';
import { showRow } from '../components.js';
import { h, section, ago, toast, FORMAT_LABEL, icon } from '../ui.js';

/** True when dotted version a is older than b ("1.13.1" < "1.13.2"); a newer install is never told to update. */
const olderThan = (a, b) => {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let k = 0; k < Math.max(x.length, y.length); k += 1) if ((x[k] || 0) !== (y[k] || 0)) return (x[k] || 0) < (y[k] || 0);
  return false;
};

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

/** Phone notifications through Web Push (for the installed app, or any browser without the extension). */
function pushSection() {
  const status = h('p', { class: 'muted', role: 'status' });
  const on = h('button', { type: 'button', class: 'btn small primary' }, 'Turn on notifications on this device');
  const off = h('button', { type: 'button', class: 'btn small ghost', hidden: true }, 'Turn off');
  const test = h('button', { type: 'button', class: 'btn small', hidden: true }, 'Send a test');
  const box = h('div', { class: 'panel' },
    h('p', {}, 'Get a notification when a show you follow has a new episode, or a show you watched starts a new season. Checked every three hours; nothing between 23:00 and 08:00, the morning check sends what aired overnight. Works on a phone once the tracker is on your Home Screen, and in any desktop browser.'),
    // On a computer the extension already notifies; turning this on there too would double every alert.
    matchMedia('(hover: hover) and (pointer: fine)').matches ? h('p', { class: 'muted' }, 'On a computer with the Crunchyroll extension you already get these from the extension, so turn this on for your phone instead to avoid getting each one twice.') : null,
    h('div', { class: 'hero-actions' }, on, test, off), status);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const keyBytes = (k) => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4)), (c) => c.charCodeAt(0));
  const paint = (sub) => { on.hidden = Boolean(sub); off.hidden = test.hidden = !sub; status.textContent = sub ? 'Notifications are on for this device.' : ''; };
  if (!supported) {
    on.hidden = true;
    status.textContent = /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone or iPad, first add the tracker to your Home Screen (Share → Add to Home Screen), then open it from there and turn notifications on.' : 'This browser cannot receive web notifications.';
  } else {
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then(paint).catch(() => {});
    on.addEventListener('click', async () => {
      on.disabled = true;
      try {
        if ((await Notification.requestPermission()) !== 'granted') { status.textContent = 'Notifications are blocked for this site. Allow them in the browser settings, then try again.'; on.disabled = false; return; }
        const reg = await navigator.serviceWorker.ready;
        const { publicKey } = await api.pushKey();
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
        await api.pushSubscribe(sub.toJSON());
        paint(sub);
      } catch (err) { status.textContent = `Could not turn notifications on: ${err.message}`; }
      on.disabled = false;
    });
    off.addEventListener('click', async () => {
      try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await api.pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); } paint(null); status.textContent = 'Notifications are off for this device.'; }
      catch (err) { status.textContent = err.message; }
    });
    test.addEventListener('click', async () => {
      try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); const r = await api.pushTest(sub?.endpoint); status.textContent = r.sent ? 'Test sent. It should arrive in a few seconds.' : 'The push service did not accept the test. Turn notifications off and on again.'; }
      catch (err) { status.textContent = err.message; }
    });
  }
  return h('section', { class: 'section', id: 'notifications' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Notifications'), h('span', { class: 'sub' }, 'New episodes, on your phone or this browser')), box);
}

/** Airing calendar: a secret feed URL any calendar app can subscribe to. */
function calendarSection() {
  const field = h('input', { type: 'text', class: 'search mono', readonly: true, 'aria-label': 'Calendar feed address', value: 'Loading…' });
  const copy = h('button', { type: 'button', class: 'btn small' }, 'Copy');
  const open = h('a', { class: 'btn small primary', href: '#' }, 'Add to calendar app');
  const reset = h('button', { type: 'button', class: 'btn small ghost' }, 'Make a new link');
  const show = (path) => {
    const url = `${location.origin}${path}`;
    field.value = url;
    open.href = url.replace(/^https?:/, 'webcal:');
  };
  api.calendar().then((r) => show(r.path)).catch((err) => { field.value = err.message; });
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(field.value); toast('Calendar link copied'); } catch { field.select(); } });
  reset.addEventListener('click', async () => {
    try { const r = await api.resetCalendar(); show(r.path); toast('New calendar link made. The old one stops working; subscribe again with this one.'); } catch (err) { toast(err.message); }
  });
  return h('section', { class: 'section', id: 'calendar' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Airing calendar'), h('span', { class: 'sub' }, 'Next episodes of the shows you follow, in Google Calendar, Apple Calendar or Outlook')),
    h('div', { class: 'panel' },
      h('p', {}, 'Subscribe to this address in your calendar app. It lists each airing show\'s next episode at its real time, plus the following weeks, and updates itself every few hours. Shows on hold or dropped are left out.'),
      h('div', { class: 'inline-form' }, field, copy),
      h('div', { class: 'hero-actions' }, open, reset),
      h('p', { class: 'muted' }, 'Anyone with this link can see your airing list (titles and times, nothing else). If it leaks, make a new link.')));
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

/** What you did with a season that isn't in your library: "3 episodes watched", or "1 episode opened, none finished". */
function sampledPlays(s) {
  const eps = (n) => `${n} episode${n === 1 ? '' : 's'}`;
  return s.watchedPlays ? `${eps(s.watchedPlays)} watched` : `${eps(s.plays)} opened, none finished`;
}
/** The section's one line: mostly seasons you only tried, sometimes ones you watched that were left out. */
function sampledSummary(list) {
  const watched = list.filter((s) => s.watchedPlays).length;
  const tried = list.length - watched;
  return [
    tried ? `${tried} Crunchyroll season${tried === 1 ? '' : 's'} you opened without finishing an episode` : '',
    watched ? `${watched} you watched that ${watched === 1 ? 'was' : 'were'} left out (recaps, specials, alternate cuts)` : ''
  ].filter(Boolean).join(', and ') + '. Track one to add it to your library.';
}

/** The server's nightly database copies: when the last one ran, its size, how many days are kept. */
function backupSection(b) {
  if (!b || !b.at) return null;
  const size = b.bytes >= 1048576 ? `${(b.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b.bytes / 1024))} KB`;
  // The same limit the server's own watchdog uses: a nightly copy older than 26 hours means one was missed.
  const late = Date.now() - new Date(b.at).getTime() > 26 * 3600e3;
  return section('Backups', `Nightly, last ${ago(b.at)} · ${b.days} day${b.days === 1 ? '' : 's'} kept`,
    late ? h('div', { class: 'panel warn' }, h('b', {}, 'No backup in the last 26 hours. '), 'The nightly copy may have stopped: check the server.') : null,
    h('div', { class: 'panel' },
      h('p', {}, `Each night the server saves a compressed copy of the whole database (${size}) in its backup folder and keeps the last ${b.keep} days. `,
        'Have the server copy that folder somewhere else too, so a lost disk doesn’t take the backups with it.')));
}

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const [cr, bg, stats, odd, me] = await Promise.all([api.crStatus(), api.syncStatus(), api.stats(), api.suspicious().catch(() => []), loadMe()]);
  const last = cr.lastSync;
  const stale = !last || Date.now() - new Date(last.at).getTime() > 2 * 86400000;

  const review = cr.needsReview.length ? h('table', { class: 'simple review-table' },
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
        h('td', { 'data-label': 'Crunchyroll season' }, `${r.seriesTitle} · ${r.seasonTitle || ''}`),
        h('td', { 'data-label': 'Mapped to' }, r.malId ? h('a', { href: `https://myanimelist.net/anime/${r.malId}`, target: '_blank', rel: 'noopener' }, r.mappedTitle || `MAL ${r.malId}`) : h('span', { class: 'muted' }, 'not found')),
        h('td', { 'data-label': 'Fix' }, h('div', { class: 'inline-form' }, search, offInput, r.malId ? ok : null), results));
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

  // ---- The page. What state the sync is in sits on top, always; below it one group at a time
  // (Review, Connection, Alerts, Import, System). All of it stacked made a page several screens long.
  const groups = {
    review: [
    // Nothing to review (the usual case): one quiet line instead of an empty section.
    cr.rows ? (cr.needsReview.length
      ? section('Needs review', 'Seasons the tracker mapped by guessing', h('div', { class: 'panel' }, review))
      : h('p', { class: 'muted all-clear' }, '✓ Every Crunchyroll season you played is matched to a show. Nothing needs review.')) : null,
    odd.length ? section('Odd progress', `${odd.length} show${odd.length === 1 ? '' : 's'} with the finale ticked but most episodes not. Usually a mapping slip or a stray bulk mark.`,
      h('div', { class: 'quiet-list' }, odd.map((x) => {
        const all = h('button', { type: 'button', class: 'btn small' }, 'I watched it all');
        const stray = h('button', { type: 'button', class: 'btn small ghost' }, `Remove stray E${x.aired}`);
        // You really did skip to the end: stop flagging it (and clear the Sync badge).
        const keep = h('button', { type: 'button', class: 'btn small ghost' }, 'Leave as is');
        // Open the show to check its episodes before deciding.
        const row = showRow({ show: { malId: x.malId, title: x.title, image: x.image }, sub: `${x.watched} of ${x.aired} ticked, including the finale`, actions: [all, stray, keep], stack: true });
        // Both fixes hide the row and offer Undo, which reverses exactly what they changed.
        const restore = () => { row.hidden = false; all.disabled = stray.disabled = keep.disabled = false; bus.emit('library-changed'); };
        keep.addEventListener('click', async () => {
          all.disabled = stray.disabled = keep.disabled = true;
          try {
            await api.oddAccept(x.malId); row.hidden = true; bus.emit('library-changed');
            toast(`${x.title} left as it is`, { label: 'Undo', onClick: async () => { try { await api.oddAccept(x.malId, true); restore(); } catch (err) { toast(err.message); } } });
          } catch (err) { all.disabled = stray.disabled = keep.disabled = false; toast(err.message); }
        });
        all.addEventListener('click', async () => {
          all.disabled = stray.disabled = true;
          try {
            const r = await api.watchedThrough(x.malId, x.aired); row.hidden = true; bus.emit('library-changed');
            toast(`${x.title}: all ${x.aired} marked watched`, { label: 'Undo', onClick: async () => { try { await api.unmark(x.malId, r.episodes || []); await api.restoreListStatus(x.malId, r.previousListStatus); restore(); } catch (err) { toast(err.message); } } });
          } catch (err) { all.disabled = stray.disabled = false; toast(err.message); }
        });
        stray.addEventListener('click', async () => {
          all.disabled = stray.disabled = true;
          try {
            await api.toggleWatched(x.malId, x.aired, false); row.hidden = true; bus.emit('library-changed');
            toast(`${x.title}: E${x.aired} unmarked`, { label: 'Undo', onClick: async () => { try { await api.toggleWatched(x.malId, x.aired, true, { keepListStatus: true }); restore(); } catch (err) { toast(err.message); } } });
          } catch (err) { all.disabled = stray.disabled = false; toast(err.message); }
        });
        return row;
      }))) : null,
    cr.sampled?.length ? section('Sampled, not tracked', sampledSummary(cr.sampled),
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
        // Not in the tracker yet: the show opens on Crunchyroll.
        const row = showRow({ href: s.seriesId ? `https://www.crunchyroll.com/series/${s.seriesId}` : null, image: s.thumb, title: s.seriesTitle,
          sub: `${s.seasonTitle && s.seasonTitle !== s.seriesTitle ? `${s.seasonTitle} · ` : ''}${sampledPlays(s)} · ${ago(s.lastPlayed)}`, actions: [btn, hide] });
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = 'Finding…';
          try { const r = await api.crTrack(s.seasonId); toast(r.needsReview ? `Added ${r.title}; check the match above` : `Added ${r.title}`); row.remove(); }
          catch (err) { btn.disabled = false; btn.textContent = 'Track'; toast(err.message); }
        });
        return row;
      })))) : null,
    ],
    connection: [
    // The extension, the passphrase and the Crunchyroll account: where to fix a sync that stopped.
    ...(me ? connectionSections(me) : []),
    h('details', { class: 'collapse section', open: stale ? '' : null },
      h('summary', {}, h('div', { class: 'section-head' },
        h('h2', {}, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸ '), 'Set up automatic sync'),
        h('span', { class: 'sub' }, stale ? 'One-time, about a minute' : 'Done: the extension is syncing. Open this if you set up another computer.'))),
      h('div', { class: 'collapse-body panel' }, h('ol', { class: 'steps' },
        h('li', {}, 'Open ', h('span', { class: 'mono' }, 'chrome://extensions'), ' and turn on Developer mode (top right).'),
        h('li', {}, 'Click “Load unpacked” and choose the ', h('span', { class: 'mono' }, 'extension'), ' folder inside this project.'),
        h('li', {}, 'Open crunchyroll.com once while logged in. The extension syncs right away, then every 30 minutes while Chrome is open and a couple of minutes after you finish an episode.'),
        h('li', {}, me ? 'Back on this page, press “Set up the extension in this browser” above. It gives the extension this address and the passphrase.' : 'In the extension’s popup, set the Tracker URL to this page’s address. The popup shows the last sync and has a “Sync now” button.')),
        h('p', { class: 'muted' }, 'The extension uses your existing Crunchyroll login inside your own browser. It never stores your password or tokens, and only talks to crunchyroll.com and your tracker.'))),
    ],
    alerts: [
    // Settings people look for come before the long, low-priority list of sampled seasons.
    pushSection(),
    calendarSection(),
    ],
    import: [
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
    ],
    system: [
    section('Background metadata', [
      bg.phase !== 'idle' ? `Refreshing (${bg.phase})` : bg.lastCycle ? `Last refresh ${ago(bg.lastCycle.at)}` : 'No refresh yet',
      `${bg.queueLength} queued`,
      ...(bg.episodeSources?.tmdbConfigured ? [`TMDB ${bg.episodeSources.tmdb ? 'reachable' : 'paused'}`] : []),
      ...(bg.episodeSources ? [`Kitsu ${bg.episodeSources.kitsu ? 'reachable' : 'paused'}`] : []),
      `Jikan ${bg.jikanAvailable ? 'reachable' : 'down (skipped)'}`].join(' · '),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, stats.library), h('div', { class: 'l' }, 'shows in library')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${(stats.episodes?.w ?? 0).toLocaleString()} / ${(stats.episodes?.n ?? 0).toLocaleString()}`), h('div', { class: 'l' }, 'episodes watched')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${Math.round((100 * stats.episodes.i) / Math.max(stats.episodes.n, 1))}%`), h('div', { class: 'l' }, 'episode thumbnails stored')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, (stats.images?.cached ?? 0).toLocaleString()), h('div', { class: 'l' }, `posters cached locally (${Math.round((stats.images?.bytes ?? 0) / 1048576)} MB)`))),
      bg.anilist?.blocked ? h('div', { class: 'panel warn' },
        h('b', {}, 'AniList is blocking this server. '),
        `Your browser fetches AniList data instead: the extension does it after each sync, and this page does it while it's open. Waiting: ${bg.anilist.pendingIds} shows, ${bg.anilist.pendingQueries} lookups.`) : null,
      h('div', {}, runBtn)),
    // Episode sources that didn't line up with a show's numbering: left to the others, never guessed.
    bg.episodeSources?.skipped?.length ? h('details', { class: 'collapse section' },
      h('summary', {}, h('div', { class: 'section-head' },
        h('h2', {}, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸ '), 'Episode data left out'),
        h('span', { class: 'sub' }, `${bg.episodeSources.skipped.length} show${bg.episodeSources.skipped.length === 1 ? '' : 's'} still missing episode titles or stills: no source had them, and TMDB or Kitsu number the episodes differently, so they weren't matched by guess`))),
      h('div', { class: 'collapse-body quiet-list' }, bg.episodeSources.skipped.map((x) => {
        const m = x.missing || {};
        const what = [m.titles ? `${m.titles} title${m.titles === 1 ? '' : 's'}` : '', m.stills ? `${m.stills} still${m.stills === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
        const row = showRow({
          show: { malId: x.malId, title: x.title || `MAL ${x.malId}`, image: x.image },
          sub: `${what ? `Missing ${what}. ` : ''}${x.source === 'tmdb' ? 'TMDB' : 'Kitsu'}: ${x.reason}`
        });
        row.title = x.reason;
        return row;
      }))) : null,
      backupSection(bg.lastBackup)
    ]
  };

  const attention = cr.needsReview.length + odd.length;
  const outdated = Boolean(cr.extension?.seen && cr.extension.latest && olderThan(cr.extension.seen, cr.extension.latest));
  const panels = new Map();
  const tabButtons = new Map();
  /** Show one group. The address keeps it (#/sync?tab=…), so a refresh or a shared link lands on the same one. */
  function show(tab, { keep = true } = {}) {
    for (const [k, p] of panels) p.hidden = k !== tab;
    for (const [k, b] of tabButtons) b.setAttribute('aria-pressed', String(k === tab));
    if (keep) history.replaceState(null, '', `#/sync?tab=${tab}`);
  }

  // The strip: each tile is one fact; the ones that have a place to act on them open it.
  const tile = (value, label, { tab = null, tone = '' } = {}) => h(tab ? 'button' : 'div', {
    class: `stat status-tile ${tone}`.trim(), type: tab ? 'button' : null, onclick: tab ? () => show(tab) : null
  }, h('span', { class: 'v' }, value), h('span', { class: 'l' }, label));
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const strip = h('div', { class: 'status-strip' }, [
    tile(last ? ago(last.at) : 'Never', last ? `last sync, via ${last.source}` : 'not synced yet', { tab: 'connection', tone: stale ? 'is-warn' : '' }),
    tile((cr.rows ?? 0).toLocaleString(), `plays stored${cr.latestPlayed ? ` · latest ${day(cr.latestPlayed)}` : ''}${last?.summary?.marked ? ` · ${last.summary.marked} new last sync` : ''}`),
    tile(cr.extension?.seen || '—', !cr.extension?.seen ? 'extension not seen yet' : outdated ? `extension · ${cr.extension.latest} is out` : 'extension, up to date', { tab: 'connection', tone: outdated ? 'is-warn' : '' }),
    tile(String(attention), `to review${cr.sampled?.length ? ` · ${cr.sampled.length} only tried` : ''}`, { tab: 'review', tone: attention ? 'is-accent' : '' }),
    bg.lastBackup?.at ? tile(ago(bg.lastBackup.at), `last backup · ${bg.lastBackup.days} day${bg.lastBackup.days === 1 ? '' : 's'} kept`, { tab: 'system' }) : null
  ].filter(Boolean));
  const notes = [
    outdated ? h('div', { class: 'panel warn sync-note' },
      h('b', {}, `Extension update available: ${cr.extension.latest} (yours is ${cr.extension.seen}). `),
      'Open ', h('span', { class: 'mono' }, 'chrome://extensions'), ' and click the reload icon on Tsuzuku. Syncing keeps working on the old version; new features don’t.') : null,
    stale ? h('div', { class: 'panel warn sync-note' },
      h('b', {}, 'Automatic sync is not running. '),
      me ? 'Under Connection, press “Set up the extension in this browser” (install the extension first if it isn’t). It then syncs every 30 minutes, whenever you open Crunchyroll, and a couple of minutes after you finish an episode.'
        : 'Install the browser extension (Connection has the steps); it syncs every 30 minutes, whenever you open Crunchyroll, and a couple of minutes after you finish an episode.') : null
  ].filter(Boolean);

  // Connection: the extension first, then whose history, then the passphrase and signing out.
  const order = ['Extension', 'Crunchyroll account', 'Passphrase', 'Account'];
  const rank = (el) => { const i = order.indexOf(el?.querySelector?.('h2')?.textContent?.trim()); return i < 0 ? order.length : i; };
  groups.connection = groups.connection.filter(Boolean).sort((a, b) => rank(a) - rank(b));

  const TABS = [['review', 'Review', attention], ['connection', 'Connection', 0], ['alerts', 'Alerts & calendar', 0], ['import', 'Import', 0], ['system', 'System', 0]];
  for (const [key, label, count] of TABS) {
    const parts = groups[key].filter(Boolean);
    // Short sections sit side by side; a table, a list or a folded section takes the full width.
    for (const el of parts) if (el.tagName === 'DETAILS' || el.querySelector?.('table, .quiet-list, .stat-row')) el.classList.add('span-all');
    // Two columns: a section left alone on its row takes the row instead of leaving half of it empty.
    const narrow = parts.filter((el) => !el.classList.contains('span-all'));
    if (narrow.length % 2) narrow.at(-1).classList.add('span-all');
    panels.set(key, h('div', { class: 'sync-panel', id: `sync-${key}`, hidden: true }, parts.length ? parts : h('p', { class: 'muted' }, 'Nothing here yet.')));
    const b = h('button', { type: 'button', class: 'pill chip-toggle', 'aria-pressed': 'false', 'aria-controls': `sync-${key}` }, label, count ? h('span', { class: 'chip-count num' }, String(count)) : null);
    b.addEventListener('click', () => show(key));
    tabButtons.set(key, b);
  }
  const asked = new URLSearchParams(location.hash.split('?')[1] || '');
  const first = groups[asked.get('tab')] ? asked.get('tab') : asked.get('import') ? 'import' : asked.get('calendar') || asked.get('notify') ? 'alerts' : stale ? 'connection' : 'review';
  view.replaceChildren(h('div', { class: 'sync-page' }, strip, ...notes,
    h('div', { class: 'chips segmented sync-tabs', role: 'group', 'aria-label': 'Sync sections' }, [...tabButtons.values()]),
    ...panels.values()));
  show(first, { keep: false });
  if (/[?&]import=1/.test(location.hash)) view.querySelector('#import')?.scrollIntoView({ block: 'start' });
  if (/[?&]calendar=1/.test(location.hash)) view.querySelector('#calendar')?.scrollIntoView({ block: 'start' });
  // Sections above load their data after this, so scroll again once they've settled.
  for (const [flag, id] of [['calendar', '#calendar'], ['notify', '#notifications']]) {
    if (new RegExp(`[?&]${flag}=1`).test(location.hash)) setTimeout(() => view.querySelector(id)?.scrollIntoView({ block: 'start' }), 500);
  }
}
