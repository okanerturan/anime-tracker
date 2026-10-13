import { api } from '../api.js';
import { h, media, progress, carousel, cardLink, relTime, ago, toast } from '../ui.js';
import { openAnime } from '../drawer.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const realTitle = (t) => t && !/^Episode \d+$/.test(t) ? t.replace(/^Episode\s+\d+\s*[:\-–]\s*/i, '') : null;

/** One card shape for every shelf: thumbnail, progress, title, detail line, meta line (5 subgrid rows). */
function epCard(item, mode, onChange) {
  const open = () => openAnime(item);

  let line = '';
  const meta = [];
  let frac = 0;
  let badge = null;
  if (mode === 'continue' || mode === 'stalled' || mode === 'hold') {
    // "Almost done" counts against the season's total, not just what has aired so far.
    const left = item.leftInSeason;
    if (left != null && left >= 1 && left <= 3) badge = h('span', { class: 'pill state-almost badge-start num' }, left === 1 ? 'FINALE NEXT' : `ALMOST DONE · ${left} LEFT`);
    else if (item.status === 'RELEASING') badge = h('span', { class: 'pill airing badge-start' }, 'AIRING');
    const name = realTitle(item.nextEpisodeTitle);
    line = `Episode ${item.nextEpisode}${name ? ` · ${name}` : ''}`;
    frac = item.aired ? Math.min(item.furthest || item.watched, item.aired) / item.aired : 0;
    meta.push(`${plural(item.remaining, 'episode')} to go`);
    if (item.resume) meta.push(`resume, ${Math.round((item.resume.durationS - item.resume.playhead) / 60)} min left`);
    else if (item.lastWatchedAt) meta.push(ago(item.lastWatchedAt));
  } else if (mode === 'airing') {
    line = `Episode ${item.nextAiringEpisode} ${relTime(item.nextAiringAt)}`;
    frac = item.aired ? item.watched / item.aired : 0;
    meta.push(`watched ${item.watched} of ${item.aired}`);
    badge = h('span', { class: 'pill airing badge-start' }, 'NEW EPISODE SOON');
  } else if (mode === 'season') {
    line = item.after ? `Sequel to ${item.after}` : '';
    meta.push(...[item.format, item.episodes ? plural(item.episodes, 'episode') : null, item.averageScore ? `★ ${item.averageScore}` : null].filter(Boolean));
    badge = h('span', { class: 'pill accent badge-start' }, item.status === 'RELEASING' ? 'AIRING NOW' : 'NEW SEASON');
  }

  const still = item.nextEpisodeImage || item.resume?.thumb || null;
  // Stalled and held shows get quick actions so the shelf can be cleaned up without opening each one.
  const action = (label, status, cls = 'btn small') => {
    const b = h('button', { type: 'button', class: cls }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api.setListStatus(item.malId, status); toast(status === 'dropped' ? `Dropped ${item.title}` : status ? `${item.title} is on hold` : `${item.title} is back in Continue watching`); onChange?.(b.closest('.card')); }
      catch (err) { b.disabled = false; toast(err.message); }
    });
    return b;
  };
  const actions = mode === 'stalled' ? h('div', { class: 'card-actions card-actions--pair' }, action('Hold', 'on_hold'), action('Drop', 'dropped', 'btn small ghost'))
    : mode === 'hold' ? h('div', { class: 'card-actions card-actions--pair' }, action('Resume', null, 'btn small primary'), action('Drop', 'dropped', 'btn small ghost'))
      : null;
  return h('article', { class: 'card' },
    media({ src: still, fallback: item.image, alt: '', badges: [badge] }),
    progress(frac, { hideWhenEmpty: mode === 'season' }),
    cardLink(item.title, open, { lines: 1, href: `https://myanimelist.net/anime/${item.malId}` }),
    h('p', { class: 'card-sub one-line', title: line }, line),
    h('p', { class: 'card-meta' }, meta.join(' · ')),
    actions);
}

const watchUrl = (p) => `https://www.crunchyroll.com/watch/${encodeURIComponent(p.episodeId)}`;

function pausedCard(p) {
  const name = realTitle(p.episodeTitle) || p.episodeTitle || '';
  return h('article', { class: 'card' },
    media({ src: p.thumb, alt: '' }),
    progress(p.durationS ? p.playhead / p.durationS : 0),
    // Clicking a paused episode resumes it on Crunchyroll.
    cardLink(p.seriesTitle, () => window.open(watchUrl(p), '_blank', 'noopener'), { lines: 1, href: watchUrl(p) }),
    h('p', { class: 'card-sub one-line', title: name }, `E${p.episodeNumber ?? ''} · ${name}`),
    h('p', { class: 'card-meta' }, `${Math.round((p.durationS - p.playhead) / 60)} min left · ${ago(p.datePlayed)}`));
}

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const [data, cr] = await Promise.all([api.upNext(), api.crStatus().catch(() => null)]);
  // A paused Crunchyroll episode that is a show's next episode is shown on that show's card instead.
  const paused = new Map((cr?.inProgress || []).filter((p) => p.malId).map((p) => [`${p.malId}:${p.episodeNumber}`, p]));
  const used = new Set();
  for (const item of data.continueWatching) {
    const p = paused.get(`${item.malId}:${item.nextEpisode}`);
    if (p) { item.resume = p; used.add(p); }
  }
  const inProgress = (cr?.inProgress || []).filter((p) => !used.has(p));

  // Remove the card in place so an open shelf stays open while you triage it; other shelves catch up on the next visit.
  const rerender = (cardEl) => cardEl?.remove();
  const collapsible = (title, sub, items, mode) => h('details', { class: 'collapse section' },
    h('summary', {}, h('div', { class: 'section-head' },
      h('h2', {}, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸ '), title),
      h('span', { class: 'sub' }, sub))),
    h('div', { class: 'collapse-body' },
      h('div', { class: 'cards cards--wide', style: { '--rows': '6' } }, items.slice(0, 60).map((x) => epCard(x, mode, rerender)))));

  view.replaceChildren(...[
    carousel('Continue watching', `${plural(data.continueWatching.length, 'show')} with episodes waiting`,
      data.continueWatching.map((x) => epCard(x, 'continue')), "You're all caught up."),
    inProgress.length ? carousel('Started on Crunchyroll', 'Episodes you paused', inProgress.map(pausedCard), '') : null,
    carousel('New episodes soon', 'Airing shows you keep up with',
      data.airingSoon.map((x) => epCard(x, 'airing')), 'Nothing you follow airs in the next week.'),
    carousel('New seasons available', 'Sequels of shows you finished',
      data.newSeasons.map((x) => epCard(x, 'season')), 'No unwatched sequels.'),
    data.stalled.length ? collapsible('Paused a while ago', `${plural(data.stalled.length, 'show')} you stopped partway. Hold or drop them to clear this list`, data.stalled, 'stalled') : null,
    data.onHold?.length ? collapsible('On hold', `${plural(data.onHold.length, 'show')}${data.dropped ? ` · ${data.dropped} dropped (see Library)` : ''}`, data.onHold, 'hold') : null].filter(Boolean));
}
