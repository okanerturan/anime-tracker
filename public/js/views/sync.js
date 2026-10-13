import { api } from '../api.js';
import { h, section, ago, toast } from '../ui.js';

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const [cr, bg, stats] = await Promise.all([api.crStatus(), api.syncStatus(), api.stats()]);
  const last = cr.lastSync;
  const stale = !last || Date.now() - new Date(last.at).getTime() > 2 * 86400000;

  const review = cr.needsReview.length ? h('table', { class: 'simple' },
    h('tr', {}, h('th', {}, 'Crunchyroll season'), h('th', {}, 'Mapped to'), h('th', {}, 'Fix')),
    cr.needsReview.map((r) => {
      const malInput = h('input', { type: 'number', placeholder: 'MAL id', value: r.malId || '', required: true, min: '1', 'aria-label': 'MAL id' });
      const offInput = h('input', { type: 'number', placeholder: 'offset', value: r.offset || 0, 'aria-label': 'Episode offset', title: 'Crunchyroll episode number minus MAL episode number' });
      const save = h('button', { type: 'button', class: 'btn small primary' }, 'Save');
      save.addEventListener('click', async () => { if (!malInput.reportValidity()) return; save.disabled = true; const res = await api.crRemap(r.seasonId, Number(malInput.value), Number(offInput.value)); toast(`Re-mapped · ${res.marked} episodes marked`); render(view); });
      const ok = h('button', { type: 'button', class: 'btn small' }, 'Looks right');
      ok.addEventListener('click', async () => { await api.crConfirm(r.seasonId); render(view); });
      return h('tr', {},
        h('td', {}, `${r.seriesTitle} · ${r.seasonTitle || ''}`),
        h('td', {}, r.malId ? h('a', { href: `https://myanimelist.net/anime/${r.malId}`, target: '_blank', rel: 'noopener' }, r.mappedTitle || `MAL ${r.malId}`) : h('span', { class: 'muted' }, 'not found')),
        h('td', {}, h('div', { class: 'inline-form' }, malInput, offInput, save, r.malId ? ok : null)));
    })) : h('div', { class: 'muted' }, 'All Crunchyroll seasons are mapped.');

  const fileInput = h('input', { type: 'file', accept: 'application/json' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const rows = JSON.parse(await file.text());
    const res = await api.crIngest(rows);
    toast(`Imported ${res.stored} rows · ${res.marked} newly watched`);
    render(view);
  });
  const runBtn = h('button', { type: 'button', class: 'btn' }, 'Refresh metadata now');
  runBtn.addEventListener('click', async () => { await api.runSync(); toast('Background refresh started'); });

  view.replaceChildren(...[
    section('Crunchyroll sync', last ? `Last sync ${ago(last.at)} via ${last.source}` : 'Never synced',
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, cr.rows.toLocaleString()), h('div', { class: 'l' }, 'history episodes stored')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, cr.latestPlayed ? new Date(cr.latestPlayed).toLocaleDateString() : '—'), h('div', { class: 'l' }, 'latest play')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, last?.summary?.marked ?? '—'), h('div', { class: 'l' }, 'newly watched in last sync')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, cr.needsReview.length), h('div', { class: 'l' }, 'seasons to review'))),
      stale ? h('div', { class: 'panel warn' },
        h('b', {}, 'Automatic sync is not running. '),
        'Install the browser extension below; it syncs every 30 minutes and whenever you open Crunchyroll.') : null),
    section('Set up automatic sync', 'One-time, about a minute',
      h('div', { class: 'panel' }, h('ol', { class: 'steps' },
        h('li', {}, 'Open ', h('span', { class: 'mono' }, 'chrome://extensions'), ' and turn on Developer mode (top right).'),
        h('li', {}, 'Click “Load unpacked” and choose the ', h('span', { class: 'mono' }, 'extension'), ' folder inside this project.'),
        h('li', {}, 'Open crunchyroll.com once while logged in. The extension syncs right away, then every 30 minutes while Chrome is open.'),
        h('li', {}, 'In the extension’s popup, set the Tracker URL to this page’s address (and the passphrase as Tracker key when it’s hosted). The popup shows the last sync and has a “Sync now” button.')),
        h('p', { class: 'muted' }, 'The extension uses your existing Crunchyroll login inside your own browser. It never stores your password or tokens, and only talks to crunchyroll.com and your tracker.'))),
    section('Needs review', 'Seasons the tracker mapped by guessing', h('div', { class: 'panel' }, review)),
    section('Manual import', 'Alternative to the extension: a watch-history JSON export', h('div', { class: 'panel' }, fileInput)),
    section('Background metadata', [
      bg.phase !== 'idle' ? `Refreshing (${bg.phase})` : bg.lastCycle ? `Last refresh ${ago(bg.lastCycle.at)}` : 'No refresh yet',
      `${bg.queueLength} queued`, `Jikan ${bg.jikanAvailable ? 'reachable' : 'down (skipped)'}`].join(' · '),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, stats.library), h('div', { class: 'l' }, 'shows in library')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${stats.episodes.w.toLocaleString()} / ${stats.episodes.n.toLocaleString()}`), h('div', { class: 'l' }, 'episodes watched')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${Math.round((100 * stats.episodes.i) / Math.max(stats.episodes.n, 1))}%`), h('div', { class: 'l' }, 'episode thumbnails stored')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, stats.images.cached.toLocaleString()), h('div', { class: 'l' }, `posters cached locally (${Math.round(stats.images.bytes / 1048576)} MB)`))),
      h('div', {}, runBtn)),
    bg.lastBackup ? section('Backups', `Nightly, last ${ago(bg.lastBackup.at)} · ${bg.lastBackup.kept} kept`,
      h('div', { class: 'panel' },
        h('p', {}, `Every table except episode thumbnails (the sync re-fetches those), gzipped: ${Math.round(bg.lastBackup.bytes / 1024).toLocaleString()} KB, ${bg.lastBackup.rows.toLocaleString()} rows. `,
          'Restore with ', h('span', { class: 'mono' }, 'node scripts/backup.js restore'), '.'),
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn', href: '/api/backup', download: '' }, 'Download latest'),
          h('a', { class: 'btn ghost', href: '/api/backup?fresh=1', download: '' }, 'Back up now and download')))) : null].filter(Boolean));
}
