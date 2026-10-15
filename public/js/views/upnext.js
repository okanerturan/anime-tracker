import { api } from '../api.js';
import { h, fill, icon, media, progress, carousel, cardLink, relTime, ago, toast } from '../ui.js';
import { openAnime } from '../drawer.js';
import { bus } from '../bus.js';
import { rememberPlay } from '../playcheck.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "~46 min" / "~2 h 10 min" for n episodes of a given length; null when the length is unknown. */
function timeFor(n, minutes) {
  if (!n || !minutes) return null;
  const total = Math.round(n * minutes);
  return total < 60 ? `~${total} min` : `~${Math.floor(total / 60)} h${total % 60 ? ` ${total % 60} min` : ''}`;
}

// "New since your last visit": a per-browser timestamp, nothing the server needs to know.
// "New since your last visit": opens within 30 minutes of each other count as one visit, so a reload
// keeps today's badges, and the next visit compares against the start of this one.
const VISIT_KEY = 'upnext:visit';
let lastVisit = 0;
try {
  const v = JSON.parse(localStorage.getItem(VISIT_KEY) || 'null') || {};
  const now = Date.now();
  if (!v.start || now - v.start > 30 * 60000) { lastVisit = v.start || 0; localStorage.setItem(VISIT_KEY, JSON.stringify({ start: now, previous: lastVisit })); }
  else lastVisit = v.previous || 0;
} catch {}
const isNewSinceVisit = (iso) => Boolean(iso && lastVisit && new Date(iso).getTime() > lastVisit);

/** One line under tonight's pick: what arrived since the previous visit. */
function sinceLine(data) {
  if (!lastVisit) return null;
  const eps = data.continueWatching.filter((x) => isNewSinceVisit(x.latestAiredAt));
  const seasons = (data.newSeasons || []).filter((x) => x.startDate && new Date(x.startDate).getTime() > lastVisit);
  if (!eps.length && !seasons.length) return null;
  const days = (Date.now() - lastVisit) / 86400000;
  const when = days < 1 ? 'Since earlier today' : days < 7 ? `Since ${new Date(lastVisit).toLocaleDateString(undefined, { weekday: 'long' })}`
    : `Since ${new Date(lastVisit).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const names = (list) => {
    // Long light-novel titles read better cut at the colon: "Magic Repo Man", not the whole sentence.
    const short = (t) => (t.length > 32 && /[:：]/.test(t) ? t.split(/\s*[:：]\s*/)[0] : t);
    const shown = list.slice(0, 3).map((x) => h('button', { type: 'button', class: 'link-btn', title: x.title, onclick: () => openAnime(x) }, short(x.title)));
    const parts = shown.flatMap((b, i) => (i === 0 ? [b] : [i === shown.length - 1 && list.length <= 3 ? ' and ' : ', ', b]));
    return list.length > 3 ? [...parts, ` and ${list.length - 3} more`] : parts;
  };
  const line = h('p', { class: 'since-line' }, h('b', {}, `${when}: `),
    eps.length ? ['new episodes of ', ...names(eps)] : null,
    eps.length && seasons.length ? '; ' : null,
    seasons.length ? [seasons.length === 1 ? 'a new season: ' : 'new seasons: ', ...names(seasons)] : null);
  if (!/[.!?]$/.test(line.textContent.trim())) line.append('.');
  return line;
}

/** After jumping to Crunchyroll, say what happens next so the user doesn't come back to tick boxes. */
function playToast(ep, item = null) { if (ep && item) rememberPlay(item, ep); toast(ep ? `Opening episode ${ep} on Crunchyroll. It's marked watched after your next sync.` : 'Opening Crunchyroll'); }
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
    if (isNewSinceVisit(item.latestAiredAt)) badge = h('span', { class: 'pill accent badge-start' }, 'NEW EPISODE');
    else if (left != null && left >= 1 && left <= 3) badge = h('span', { class: 'pill state-almost badge-start num' }, left === 1 ? 'FINALE NEXT' : `ALMOST DONE · ${left} LEFT`);
    else if (item.status === 'RELEASING') badge = h('span', { class: 'pill airing badge-start' }, 'AIRING');
    const name = realTitle(item.nextEpisodeTitle);
    line = `Episode ${item.nextEpisode}${name ? ` · ${name}` : ''}`;
    frac = item.aired ? Math.min(item.furthest || item.watched, item.aired) / item.aired : 0;
    const toGo = timeFor(item.remaining, item.episodeMinutes);
    meta.push(`${plural(item.remaining, 'episode')} to go${toGo ? ` · ${toGo}` : ''}`);
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
  // Play opens Crunchyroll: the exact episode when known (resume beats it, since it's the real playhead), else the series page.
  const playUrl = item.resume ? watchUrl(item.resume) : item.nextEpisodeUrl;
  const playExact = Boolean(item.resume) || item.nextEpisodeUrlIsExact;
  const seasonPlay = mode === 'season' && item.crunchyrollUrl
    ? h('a', { class: 'play-overlay', href: item.crunchyrollUrl, target: '_blank', rel: 'noopener', 'aria-label': `Open ${item.title} on Crunchyroll` }, icon('play'), h('span', {}, 'Crunchyroll'))
    : null;
  const play = seasonPlay || (playUrl && (mode === 'continue' || mode === 'airing' || mode === 'hold' || mode === 'stalled')
    ? h('a', { class: 'play-overlay', href: playUrl, target: '_blank', rel: 'noopener', 'aria-label': playExact ? `Play episode ${item.nextEpisode} on Crunchyroll` : `Open ${item.title} on Crunchyroll`, onclick: () => playToast(playExact ? item.nextEpisode : null, item) },
        icon('play'), h('span', {}, playExact ? `Play E${item.nextEpisode}` : `Open on ${item.nextEpisodeSite || 'Crunchyroll'}`))
    : null);
  // Watched it elsewhere, or the sync hasn't caught up: tick the next episode without opening the show.
  const tick = ((mode === 'continue' || mode === 'stalled') && item.nextEpisode) ? h('button', { type: 'button', class: 'icon-btn card-tick', 'aria-label': `Mark episode ${item.nextEpisode} watched`, title: `Mark E${item.nextEpisode} watched. Shift-click (or hold, on touch) marks every aired episode.` }, icon('check')) : null;
  // Touch has no Shift: holding the tick for half a second marks every aired episode.
  // A time, not a flag: Android sends no click after a long press, and a flag left set would swallow the next tap.
  let heldAt = 0; let holdTimer = null;
  if (tick) {
    tick.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !item.aired || item.aired <= item.nextEpisode) return;
      holdTimer = setTimeout(() => { holdTimer = null; heldAt = Date.now(); navigator.vibrate?.(15); tick.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })); }, 500);
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) tick.addEventListener(t, () => { clearTimeout(holdTimer); holdTimer = null; });
    tick.addEventListener('contextmenu', (e) => { if (holdTimer || Date.now() - heldAt < 800) e.preventDefault(); });
  }
  if (tick) tick.addEventListener('click', async (e) => {
    if (!e.shiftKey && Date.now() - heldAt < 800) return;
    tick.disabled = true;
    // Shift: caught up elsewhere, mark everything that has aired.
    const through = e.shiftKey && item.aired ? item.aired : item.nextEpisode;
    try {
      const r = await api.watchedThrough(item.malId, through);
      onChange?.(tick.closest('.card'));
      // Undo reverts exactly the episodes this tick changed (it may have filled gaps before E<n>).
      const undo = { label: 'Undo', onClick: async () => { try { await api.unmark(item.malId, r.episodes || [through]); await api.restoreListStatus(item.malId, r.previousListStatus); bus.emit('library-changed'); redrawIfShown(); } catch (err) { toast(err.message); } } };
      toast(through === item.nextEpisode ? `E${item.nextEpisode} of ${item.title} marked watched` : `${item.title}: marked watched through E${through}`, undo);
    } catch (err) { tick.disabled = false; toast(err.message); }
  });
  // Stalled and held shows get quick actions so the shelf can be cleaned up without opening each one.
  const action = (label, status, cls = 'btn small') => {
    const b = h('button', { type: 'button', class: cls }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const was = mode === 'hold' ? 'on_hold' : null; // what the card's shelf implies today
        await api.setListStatus(item.malId, status);
        onChange?.(b.closest('.card'));
        toast(status === 'dropped' ? `Dropped ${item.title}` : status ? `${item.title} is on hold` : `${item.title} is back in Continue watching`,
          { label: 'Undo', onClick: async () => { try { await api.setListStatus(item.malId, was); bus.emit('library-changed'); redrawIfShown(); } catch (err) { toast(err.message); } } });
      }
      catch (err) { b.disabled = false; toast(err.message); }
    });
    return b;
  };
  // New seasons: add to the library in one tap (the card then shows In library), and open Crunchyroll from the thumbnail.
  let seasonActions = null;
  if (mode === 'season') {
    const add = h('button', { type: 'button', class: `btn small ${item.inLibrary ? '' : 'primary'}`, disabled: Boolean(item.inLibrary) }, item.inLibrary ? 'In library' : 'Add to library');
    add.addEventListener('click', async () => {
      add.disabled = true;
      try { await api.add({ malId: item.malId, title: item.title, totalEpisodes: item.episodes }); add.textContent = 'In library'; item.inLibrary = true; toast(`Added ${item.title}`); bus.emit('library-changed'); }
      catch (err) { add.disabled = false; toast(err.message); }
    });
    seasonActions = h('div', { class: 'card-actions' }, add);
  }
  const actions = mode === 'stalled' ? h('div', { class: 'card-actions card-actions--pair' }, action('Hold', 'on_hold'), action('Drop', 'dropped', 'btn small ghost'))
    : mode === 'hold' ? h('div', { class: 'card-actions card-actions--pair' }, action('Resume', null, 'btn small primary'), action('Drop', 'dropped', 'btn small ghost'))
      : seasonActions;
  // Continue watching: a "⋯" menu (Hold / Drop / Details) to clear a show without opening it.
  let more = null; let menu = null;
  if (mode === 'continue') {
    menu = h('div', { class: 'card-menu', hidden: true, role: 'group', 'aria-label': `${item.title} options` },
      action('Hold', 'on_hold', 'btn small'), action('Drop', 'dropped', 'btn small'), h('button', { type: 'button', class: 'btn small ghost', onclick: () => open() }, 'Details'));
    more = h('button', { type: 'button', class: 'icon-btn card-more', 'aria-label': `More for ${item.title}`, 'aria-expanded': 'false', title: 'Hold, drop or details' }, '⋯');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) {
        const shut = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close, true); menu.removeEventListener('keydown', onKey); };
        const close = (ev) => { if (!menu.contains(ev.target) && ev.target !== more) shut(); };
        // Keyboard: focus lands on the first option; Escape closes and returns focus to "⋯".
        const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); shut(); more.focus(); } };
        menu.addEventListener('keydown', onKey);
        setTimeout(() => document.addEventListener('click', close, true));
        menu.querySelector('button')?.focus();
      }
    });
  }
  return h('article', { class: `card ${play ? 'has-play' : ''}` },
    media({ src: still, fallback: item.image, alt: '', badges: [badge, play, tick, more] }),
    progress(frac, { hideWhenEmpty: mode === 'season' }),
    cardLink(item.title, open, { lines: 1, href: `https://myanimelist.net/anime/${item.malId}` }),
    h('p', { class: 'card-sub one-line', title: line }, line),
    h('p', { class: 'card-meta' }, meta.join(' · ')),
    actions, menu);
}

const watchUrl = (p) => `https://www.crunchyroll.com/watch/${encodeURIComponent(p.episodeId)}`;

function pausedCard(p, onTracked) {
  const name = realTitle(p.episodeTitle) || p.episodeTitle || '';
  const minsLeft = Math.round((p.durationS - p.playhead) / 60);
  // A sampled show isn't in the library yet (nothing counted as watched). Offer to track it.
  let track = null;
  if (!p.malId && p.seasonId) {
    track = h('button', { type: 'button', class: 'btn small track-btn' }, 'Track this show');
    track.addEventListener('click', async () => {
      track.disabled = true; track.textContent = 'Finding it…';
      try {
        const r = await api.crTrack(p.seasonId);
        toast(r.needsReview ? `Added ${r.title}. Check the match on the Sync page.` : `Added ${r.title} to your library`);
        bus.emit('library-changed');
        onTracked?.();
      } catch (err) { track.disabled = false; track.textContent = 'Track this show'; toast(err.message); }
    });
  }
  // Dismiss a paused episode you won't come back to; Undo in the toast brings it back.
  const dismiss = h('button', { type: 'button', class: 'icon-btn card-tick card-dismiss', 'aria-label': `Hide ${p.seriesTitle} from this shelf`, title: 'Hide from this shelf' }, icon('close'));
  const el = h('article', { class: 'card has-play' },
    media({ src: p.thumb, alt: '', badges: [
      h('a', { class: 'play-overlay', href: watchUrl(p), target: '_blank', rel: 'noopener', 'aria-label': `Resume ${p.seriesTitle} on Crunchyroll` }, icon('play'), h('span', {}, `Resume · ${minsLeft} min`)),
      dismiss] }),
    progress(p.durationS ? p.playhead / p.durationS : 0),
    // Clicking a paused episode resumes it on Crunchyroll.
    cardLink(p.seriesTitle, () => window.open(watchUrl(p), '_blank', 'noopener'), { lines: 1, href: watchUrl(p) }),
    h('p', { class: 'card-sub one-line', title: name }, `E${p.episodeNumber ?? ''} · ${name}`),
    h('p', { class: 'card-meta' }, `${Math.round((p.durationS - p.playhead) / 60)} min left · ${ago(p.datePlayed)}`),
    track ? h('div', { class: 'card-actions' }, track) : null);
  dismiss.addEventListener('click', async () => {
    try {
      await api.crDismissPlay(p.episodeId);
      if (document.contains(el)) el.remove(); else onTracked?.();
      toast(`Hidden ${p.seriesTitle}`, { label: 'Undo', onClick: async () => { await api.crDismissPlay(p.episodeId, true); onTracked?.(); } });
    } catch (err) { toast(err.message); }
  });
  return el;
}

// "How much time do you have?": narrows Continue watching to shows you can finish in that time.
const BUDGETS = [['any', 'Any length', Infinity], ['30', '≤ 30 min', 30], ['60', '≤ 1 h', 60], ['120', '≤ 2 h', 120]];
let budget = 'any';
try { budget = localStorage.getItem('upnext:budget') || 'any'; } catch {}

function continueSection(view, items, onBudget = null) {
  const ordered = [...items].sort((a, b) => Number(isNewSinceVisit(b.latestAiredAt)) - Number(isNewSinceVisit(a.latestAiredAt)));
  let current = null;
  const minutesLeft = (x) => (x.episodeMinutes ? x.remaining * x.episodeMinutes : Infinity);
  const draw = () => {
    const limit = BUDGETS.find(([k]) => k === budget)?.[2] ?? Infinity;
    const list = ordered.filter((x) => limit === Infinity || minutesLeft(x) <= limit);
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Time available' }, BUDGETS.map(([k, label]) => {
      const b = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(budget === k) }, label);
      b.addEventListener('click', () => { budget = k; try { localStorage.setItem('upnext:budget', k); } catch {} draw(); });
      return b;
    }));
    const sub = budget === 'any' ? `${plural(items.length, 'show')} with episodes waiting` : `${plural(list.length, 'show')} you can finish in ${BUDGETS.find(([k]) => k === budget)[1].replace('≤ ', '')}`;
    const section = carousel('Continue watching', sub, list.map((x) => epCard(x, 'continue', () => refresh(view))),
      items.length ? 'Nothing fits in that time. Try a longer slot.' : "You're all caught up.");
    section.querySelector('.section-head')?.append(chips);
    // Swap the section in place: a wrapper element would fall outside the page grid's content column.
    if (current) current.replaceWith(section);
    current = section;
    // Tonight's pick follows the chip too: with "≤ 30 min" it comes from shows you can finish in that time.
    // (Deferred: on first draw the page isn't assembled yet, so the swap would miss.)
    queueMicrotask(() => onBudget?.(budget === 'any' ? items : list));
  };
  draw();
  return current;
}

/** The one episode to put on tonight: a paused episode first, else the most recently active show with episodes waiting. */
function tonight(items, inProgress, forced = null) {
  // Priority: an episode you're mid-way through, then a show with a new episode since your last visit, then most recent activity.
  const pick = forced || items.find((x) => x.resume) || items.find((x) => isNewSinceVisit(x.latestAiredAt)) || items[0];
  if (!pick) return null;
  // Can't decide: swap in another show with episodes waiting (never the same one twice in a row).
  const surprise = items.length > 1 ? h('button', { type: 'button', class: 'btn ghost' }, 'Surprise me') : null;
  if (surprise) surprise.addEventListener('click', () => {
    const others = items.filter((x) => x.malId !== pick.malId);
    const next = others[Math.floor(Math.random() * others.length)];
    const fresh = tonight(items, inProgress, next);
    surprise.closest('.tonight').replaceWith(fresh);
    fresh.querySelector('.btn.ghost')?.focus();
  });
  const url = pick.resume ? watchUrl(pick.resume) : pick.nextEpisodeUrl;
  const name = realTitle(pick.nextEpisodeTitle) || (pick.resume ? realTitle(pick.resume.episodeTitle) : null);
  const minsLeft = pick.resume ? Math.round((pick.resume.durationS - pick.resume.playhead) / 60) : null;
  const still = pick.nextEpisodeImage || pick.resume?.thumb || pick.image;
  const open = () => openAnime(pick);
  return h('section', { class: 'tonight' },
    h('a', { class: 'tonight-media', href: url || '#', target: url ? '_blank' : null, rel: 'noopener', 'aria-label': `Play ${pick.title} episode ${pick.nextEpisode}`, onclick: () => { if (url) playToast(pick.nextEpisode, pick); } },
      media({ src: still, fallback: pick.image, alt: '', eager: true }),
      url ? h('span', { class: 'play-overlay is-large' }, icon('play'), h('span', {}, minsLeft ? `Resume · ${minsLeft} min left` : `Play E${pick.nextEpisode}`)) : null,
      pick.resume && pick.resume.durationS ? h('span', { class: 'tonight-progress', style: { '--p': String(pick.resume.playhead / pick.resume.durationS) }, 'aria-hidden': 'true' }) : null),
    h('div', { class: 'tonight-info' },
      h('p', { class: 'eyebrow' }, forced ? 'How about this one' : pick.resume ? 'Pick up where you left off' : isNewSinceVisit(pick.latestAiredAt) ? 'New since you were here' : 'Tonight'),
      h('h2', { class: 'tonight-title' }, h('a', { class: 'tonight-link', href: `https://myanimelist.net/anime/${pick.malId}`, onclick: (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); open(); } }, pick.title)),
      h('p', { class: 'tonight-sub' }, `Episode ${pick.nextEpisode}${name ? ` · ${name}` : ''}`),
      h('p', { class: 'card-meta' }, [`${plural(pick.remaining, 'episode')} to go`, timeFor(pick.remaining, pick.episodeMinutes), pick.leftInSeason === 1 ? 'season finale next' : null, pick.lastWatchedAt ? `last watched ${ago(pick.lastWatchedAt)}` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'hero-actions' },
        url ? h('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener', onclick: () => playToast(pick.nextEpisode, pick) }, icon('play'), ' ', pick.resume ? 'Resume on Crunchyroll' : `Play on ${pick.nextEpisodeSite || 'Crunchyroll'}`) : null,
        h('button', { type: 'button', class: 'btn', onclick: open }, 'Details'),
        surprise)));
}

/** Airing shows you follow, laid out by weekday for the coming week. */
function weekStrip(airing) {
  const days = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    const items = airing.filter((x) => { const t = new Date(x.nextAiringAt); return t >= d && t < new Date(d.getTime() + 86400000); });
    days.push({ date: d, items });
  }
  const placed = days.reduce((n, d) => n + d.items.length, 0);
  if (!placed) return null;
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'This week'), h('span', { class: 'sub' }, `${plural(placed, 'new episode')} for shows you follow`),
      h('a', { class: 'sub push-end', href: '#/sync?calendar=1' }, 'Put this in your calendar →')),
    h('div', { class: 'week' }, days.map(({ date, items }, i) => h('div', { class: `week-day ${items.length ? 'has-items' : ''} ${i === 0 ? 'is-today' : ''}` },
      h('div', { class: 'week-head' },
        h('span', { class: 'week-name' }, i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : date.toLocaleDateString(undefined, { weekday: 'short' })),
        h('span', { class: 'week-date num' }, date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))),
      items.length ? items.map((x) => {
        const out = x.nextAiringAt <= Date.now();
        // Out now: the row opens the show on Crunchyroll (the exact episode isn't known until the next refresh).
        return h(out && x.nextEpisodeUrl ? 'a' : 'button', out && x.nextEpisodeUrl
          ? { class: 'week-item is-out', href: x.nextEpisodeUrl, target: '_blank', rel: 'noopener', title: `Open ${x.title} on ${x.nextEpisodeSite || 'Crunchyroll'}` }
          : { type: 'button', class: 'week-item', onclick: () => openAnime(x), title: x.title },
        h('img', { src: x.image, alt: '', loading: 'lazy' }),
        h('span', { class: 'week-item-text' },
          h('span', { class: 'week-item-title one-line' }, x.title),
          out
            ? h('span', { class: 'week-item-sub num is-out' }, `▶ E${x.nextAiringEpisode} · out now`)
            : h('span', { class: 'week-item-sub num' }, `E${x.nextAiringEpisode}${x.totalEpisodes && x.nextAiringEpisode === x.totalEpisodes ? ' · finale' : ''} · ${new Date(x.nextAiringAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`)));
      })
        : h('span', { class: 'week-empty' }, '—')))));
}

/** Airing shows you're current on whose next episode is more than a week out: a quiet list, not cards. */
function caughtUpRow(items) {
  if (!items.length) return null;
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Caught up'), h('span', { class: 'sub' }, `${plural(items.length, 'airing show')} with nothing new yet`)),
    capped(h('div', { class: 'quiet-list' }, items.map((x) => h('button', { type: 'button', class: 'week-item', onclick: () => openAnime(x), title: x.title },
      h('img', { src: x.image, alt: '', loading: 'lazy' }),
      h('span', { class: 'week-item-text' },
        h('span', { class: 'week-item-title one-line' }, x.title),
        h('span', { class: 'week-item-sub num' }, x.nextAiringAt ? `E${x.nextAiringEpisode} ${relTime(x.nextAiringAt)}` : 'next episode not scheduled')))))));
}

/** "You just finished X": five stars right there, because ratings are what make Discover good. */
const SKIP_KEY = 'upnext:rateSkipped';
const readSkipped = () => { try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) || '[]')); } catch { return new Set(); } };
const skipRating = (malId) => { try { const s = readSkipped(); s.add(malId); localStorage.setItem(SKIP_KEY, JSON.stringify([...s].slice(-200))); } catch {} };

function rateStrip(allItems, onRated) {
  const skipped = readSkipped();
  const items = allItems.filter((x) => !skipped.has(x.malId));
  if (!items.length) return null;
  const row = (x) => {
    const el = h('div', { class: 'rate-item' });
    const stars = h('div', { class: 'stars', role: 'group', 'aria-label': `Rate ${x.title}` }, [1, 2, 3, 4, 5].map((n) => {
      const b = h('button', { type: 'button', class: 'star', 'aria-label': `${n} star${n > 1 ? 's' : ''}` }, '★');
      b.addEventListener('click', async () => {
        stars.querySelectorAll('.star').forEach((s, i) => s.setAttribute('aria-pressed', String(i < n)));
        try { await api.setRating(x.malId, n); toast(`${x.title}: ${n}/5`); el.classList.add('is-done'); setTimeout(() => { el.remove(); onRated?.(); }, 900); }
        catch (err) { toast(err.message); }
      });
      return b;
    }));
    const skip = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Skip rating ${x.title}`, title: 'Skip' }, icon('close'));
    skip.addEventListener('click', () => { skipRating(x.malId); el.remove(); onRated?.(); });
    fill(el,
      h('img', { src: x.image, alt: '', loading: 'lazy' }),
      h('div', { class: 'rate-text' },
        h('span', { class: 'week-item-title one-line', title: x.title }, x.title),
        h('span', { class: 'week-item-sub' }, `Finished ${ago(x.finishedAt)} · ${plural(x.episodes, 'episode')}`)),
      stars, skip);
    return el;
  };
  return h('section', { class: 'section rate-strip' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Just finished'), h('span', { class: 'sub' }, 'A rating steers your recommendations')),
    h('div', { class: 'quiet-list' }, items.map(row)));
}

// The home page paints from the last known state right away, then redraws with fresh data.
const SNAPSHOT_KEY = 'upnext:snapshot';
function readSnapshot() {
  try { const s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null'); return s && Date.now() - s.at < 86400000 ? s : null; } catch { return null; }
}
function writeSnapshot(data, cr) { try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), data, cr })); } catch {} }

/** A quiet list that shows `limit` rows and a "Show all N" button for the rest. */
function capped(listEl, limit = 8) {
  const rows = [...listEl.children];
  if (rows.length <= limit) return listEl;
  rows.slice(limit).forEach((r) => { r.hidden = true; });
  const more = h('button', { type: 'button', class: 'btn small ghost show-all' }, `Show all ${rows.length}`);
  more.addEventListener('click', () => { rows.forEach((r) => { r.hidden = false; }); more.remove(); });
  return [listEl, more];
}

/** Announced sequels of shows you finished: premiere date when known, "date not announced" otherwise. */
function comingSoonRow(items) {
  if (!items.length) return null;
  const when = (d) => {
    if (!d) return 'date not announced';
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return d;
    const days = Math.round((date.getTime() - Date.now()) / 86400000);
    const label = date.toLocaleDateString(undefined, /-01$/.test(d) && days > 60 ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
    return days <= 0 ? `premiered ${label}` : days <= 30 ? `in ${days} day${days === 1 ? '' : 's'} · ${label}` : label;
  };
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Coming soon'), h('span', { class: 'sub' }, `${plural(items.length, 'announced sequel')} to shows you finished`)),
    capped(h('div', { class: 'quiet-list' }, items.map((x) => h('button', { type: 'button', class: 'week-item', onclick: () => openAnime(x), title: x.title },
      h('img', { src: x.image, alt: '', loading: 'lazy' }),
      h('span', { class: 'week-item-text' },
        h('span', { class: 'week-item-title one-line' }, x.title),
        h('span', { class: 'week-item-sub one-line' }, `${when(x.startDate)}${x.after ? ` · after ${x.after}` : ''}`)))))));
}

// The container this page last rendered into; Undo handlers redraw it only while it's on screen.
let mounted = null;
const redrawIfShown = () => { if (mounted?.isConnected) refresh(mounted); };

/** On a phone with the tracker installed and notifications never asked for: a one-line offer (until "Not now"). */
function notifyNudge() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('push:nudge') === 'no'; } catch {}
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (dismissed || !installed || !('PushManager' in window) || !('Notification' in window) || Notification.permission !== 'default') return null;
  const line = h('p', { class: 'since-line notify-nudge' },
    h('span', {}, 'Get a notification when a new episode is out? '),
    h('a', { href: '#/sync?notify=1' }, 'Turn on notifications'),
    ' · ');
  const no = h('button', { type: 'button', class: 'link-btn' }, 'Not now');
  no.addEventListener('click', () => { try { localStorage.setItem('push:nudge', 'no'); } catch {} line.remove(); });
  line.append(no);
  return line;
}

export async function render(view) {
  mounted = view;
  const snap = readSnapshot();
  if (snap) draw(view, snap.data, snap.cr); else view.replaceChildren(h('div', { class: 'skeleton' }));
  await refresh(view);
}

/** Fresh data only (after a tick, a hold or a drop), so a stale snapshot never flashes back. */
async function refresh(view) {
  const [data, cr] = await Promise.all([api.upNext(), api.crStatus().catch(() => null)]);
  writeSnapshot(data, cr);
  draw(view, data, cr, { fresh: true });
}

function draw(view, data, cr, { fresh = false } = {}) {
  // A paused Crunchyroll episode that is a show's next episode is shown on that show's card instead.
  const paused = new Map((cr?.inProgress || []).filter((p) => p.malId).map((p) => [`${p.malId}:${p.episodeNumber}`, p]));
  const used = new Set();
  for (const item of data.continueWatching) {
    const p = paused.get(`${item.malId}:${item.nextEpisode}`);
    if (p) { item.resume = p; used.add(p); }
  }
  // One paused card per show: the list is newest first, so the first one is the latest episode.
  // Shows whose paused episode already sits on their Continue card count as having a card.
  const pausedShows = new Set([...used].map((p) => p.malId || `t:${p.seriesTitle}`));
  const inProgress = (cr?.inProgress || []).filter((p) => {
    if (used.has(p)) return false;
    const key = p.malId || `t:${p.seriesTitle}`;
    if (pausedShows.has(key)) return false;
    pausedShows.add(key);
    return true;
  });

  // Remove the card in place so an open shelf stays open while you triage it; other shelves catch up on the next visit.
  // If the card was from a first paint that fresher data has since replaced, it's no longer on
  // screen: redraw the live view instead so the change shows.
  const rerender = (cardEl) => { if (cardEl && document.contains(cardEl)) cardEl.remove(); else refresh(view); };
  // After the shelves are drawn, remember this visit so the next one can flag what aired in between.
  const collapsible = (title, sub, items, mode, link = null) => h('details', { class: 'collapse section' },
    h('summary', {}, h('div', { class: 'section-head' },
      h('h2', {}, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸ '), title),
      h('span', { class: 'sub' }, sub),
      link ? h('a', { class: 'sub push-end', href: link.href, onclick: (e) => e.stopPropagation() }, link.label) : null)),
    h('div', { class: 'collapse-body' }, ...(() => {
      // First 24 cards; the rest are built only when asked for, so a long list never goes missing.
      const grid = h('div', { class: 'cards cards--wide', style: { '--rows': '6' } }, items.slice(0, 24).map((x) => epCard(x, mode, rerender)));
      if (items.length <= 24) return [grid];
      const more = h('button', { type: 'button', class: 'btn small ghost show-all' }, `Show all ${items.length}`);
      more.addEventListener('click', () => { grid.append(...items.slice(24).map((x) => epCard(x, mode, rerender))); more.remove(); });
      return [grid, more];
    })()));

  const airingWeek = [...data.airingSoon, ...(data.caughtUpAiring || [])].filter((x) => x.nextAiringAt && x.nextAiringAt - Date.now() < 7 * 86400000);
  const caughtUp = [...(data.airingSoon || []), ...(data.caughtUpAiring || [])].filter((x) => !x.nextAiringAt || x.nextAiringAt - Date.now() >= 7 * 86400000);
  const nothingYet = !data.continueWatching.length && !inProgress.length && !data.airingSoon.length && !data.newSeasons.length && !data.stalled.length && !(data.onHold || []).length && !(data.recentlyFinished || []).length;
  if (nothingYet) {
    fill(view, h('section', { class: 'tonight get-started' },
      h('div', { class: 'tonight-info' },
        h('p', { class: 'eyebrow' }, cr?.lastSync ? 'Nothing to watch yet' : 'Welcome'),
        h('h2', { class: 'tonight-title' }, cr?.lastSync ? 'Your history is in. Start something.' : 'Your Crunchyroll history, turned into a watch list.'),
        h('p', { class: 'tonight-sub' }, cr?.lastSync
          ? 'Everything you watched is marked. Pick a recommendation on Discover, or add any show, and it shows up here with a Play button.'
          : 'Install the browser extension and open crunchyroll.com once. Everything you have ever watched there arrives in about a minute, and this page fills itself in. Already track anime on AniList or MyAnimeList? Import that list in a few seconds.'),
        h('div', { class: 'hero-actions' },
          cr?.lastSync ? h('a', { class: 'btn primary', href: '#/discover' }, 'Open Discover') : h('a', { class: 'btn primary', href: '#/sync' }, 'Set up sync'),
          cr?.lastSync ? null : h('a', { class: 'btn', href: '#/sync?import=1' }, 'Import a list'),
          h('a', { class: 'btn', href: '#/library' }, 'Library')))));
    return;
  }
  const rateSection = rateStrip(data.recentlyFinished || [], () => { if (!rateSection.querySelector('.rate-item')) rateSection.remove(); });
  // Your original ask: shows you left one or two episodes before the end. They get their own shelf
  // instead of hiding in the collapsed "paused a while ago" list.
  const leftOf = (x) => (x.leftInSeason != null ? x.leftInSeason : x.remaining);
  // A show with a paused episode is already under "Started on Crunchyroll" with its resume button.
  data.stalled = data.stalled.filter((x) => !pausedShows.has(x.malId));
  const finishable = data.stalled.filter((x) => leftOf(x) >= 1 && leftOf(x) <= 2).sort((a, b) => leftOf(a) - leftOf(b) || a.lastAgeDays - b.lastAgeDays);
  const finishIds = new Set(finishable.map((x) => x.malId));
  const stalledRest = data.stalled.filter((x) => !finishIds.has(x.malId));
  let tonightEl = tonight(data.continueWatching, inProgress) || h('div', { hidden: true });
  tonightEl.dataset.pool = 'all';
  // Home-screen shortcut "Play tonight's pick" (#/up-next?play=1): go straight to the episode, once.
  // Only on fresh data: the saved first paint may be a day old (an episode you've since watched).
  if (fresh && /[?&]play=1/.test(location.hash)) {
    history.replaceState(null, '', '#/up-next');
    const go = tonightEl.querySelector('a.btn.primary[href^="http"]');
    if (go) { location.assign(go.href); return; }
  }
  fill(view,
    tonightEl,
    notifyNudge(),
    sinceLine(data),
    finishable.length ? carousel('Finish what you started', `${plural(finishable.length, 'show')} one or two episodes from the end`,
      finishable.map((x) => epCard(x, 'stalled', rerender)), '') : null,
    continueSection(view, data.continueWatching, (pool) => {
      if (pool === data.continueWatching && tonightEl.dataset.pool === 'all') return;
      const fresh = tonight(pool, inProgress) || h('div', { hidden: true });
      fresh.dataset.pool = pool === data.continueWatching ? 'all' : 'budget';
      tonightEl.replaceWith(fresh); tonightEl = fresh;
    }),
    rateSection,
    inProgress.length ? carousel('Started on Crunchyroll', 'Episodes you paused', inProgress.map((p) => pausedCard(p, () => refresh(view))), '') : null,
    weekStrip(airingWeek),
    caughtUpRow(caughtUp),
    comingSoonRow(data.comingSoon || []),
    carousel('New seasons available', 'Sequels of shows you finished',
      data.newSeasons.map((x) => epCard(x, 'season')), 'No unwatched sequels.'),
    stalledRest.length ? collapsible('Paused a while ago', `${plural(stalledRest.length, 'show')} you stopped partway. Hold or drop them to clear this list`, stalledRest, 'stalled', { href: '#/library?filter=unfinished&review=1', label: 'Review them in the Library (hold or drop) →' }) : null,
    data.onHold?.length ? collapsible('On hold', `${plural(data.onHold.length, 'show')}${data.dropped ? ` · ${data.dropped} dropped (see Library)` : ''}`, data.onHold, 'hold') : null);
  addFoldButtons(view);
}

// Sections you can fold away (remembered per browser). Tonight's pick and Continue watching stay.
const FOLD_KEY = 'upnext:folded';
const FOLDABLE = ['Finish what you started', 'Just finished', 'Started on Crunchyroll', 'This week', 'Caught up', 'Coming soon', 'New seasons available'];
function addFoldButtons(view) {
  let folded = [];
  try { folded = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch {}
  for (const sec of view.querySelectorAll(':scope > .section, :scope > section.section')) {
    const head = sec.querySelector(':scope > .section-head');
    const name = head?.querySelector('h2')?.textContent?.trim();
    const key = name && FOLDABLE.find((f) => name.startsWith(f));
    if (!key || head.querySelector('.fold-btn')) continue;
    const isFolded = () => folded.includes(key);
    const btn = h('button', { type: 'button', class: 'fold-btn', 'aria-expanded': String(!folded.includes(key)) });
    const paint = () => { const f = folded.includes(key); sec.classList.toggle('is-folded', f); btn.textContent = f ? 'Show' : 'Hide'; btn.setAttribute('aria-expanded', String(!f)); btn.title = f ? `Show ${name}` : `Hide ${name}`; };
    btn.addEventListener('click', () => {
      folded = isFolded() ? folded.filter((k) => k !== key) : [...folded, key];
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(folded)); } catch {}
      paint();
    });
    head.append(btn);
    paint();
  }
}
