// Shared building blocks for things that appear on several pages. A show shown anywhere opens
// the same way: these components own that, so a list can't forget to make the show clickable.
import { h, icon, media, progress, cardLink } from './ui.js';
import { openAnime } from './drawer.js';

/**
 * A compact show row: poster and title on the left (one target that opens the show), actions on
 * the right, or underneath with `stack` when there are several.
 *   show      { malId, title, image } opens the show panel; or
 *   href      a URL (e.g. a Crunchyroll page) for shows that aren't in the tracker
 *   sub       the grey second line (text or a node)
 *   actions   buttons/nodes; never put inside the open target (a button can't hold buttons)
 */
export function showRow({ show = null, href = null, image = '', title = '', sub = '', actions = [], stack = false, label = null } = {}) {
  const name = title || show?.title || '';
  const inner = [
    h('img', { src: image || show?.image || '', alt: '', loading: 'lazy' }),
    h('span', { class: 'show-row-text' },
      h('span', { class: 'show-row-title one-line', title: name }, name),
      sub ? h('span', { class: 'show-row-sub one-line' }, sub) : null)
  ];
  const open = href
    ? h('a', { class: 'show-row-open', href, target: '_blank', rel: 'noopener', 'aria-label': label || `Open ${name} on Crunchyroll` }, ...inner)
    : show
      ? h('button', { type: 'button', class: 'show-row-open', 'aria-label': label || `Open ${name}`, onclick: () => openAnime(show) }, ...inner)
      : h('div', { class: 'show-row-open is-static' }, ...inner);
  const acts = actions.filter(Boolean);
  return h('div', { class: `show-row ${stack ? 'show-row--stack' : ''}` },
    open,
    acts.length ? h('div', { class: 'show-row-actions' }, ...acts) : null);
}

/** The Crunchyroll (or other site) play button that sits on a poster or still. */
export function playPill(url, text, { label = null, onClick = null, cls = '' } = {}) {
  return h('a', { class: `play-overlay ${cls}`, href: url, target: '_blank', rel: 'noopener', 'aria-label': label || text, onclick: onClick }, icon('play'), h('span', {}, text));
}

/**
 * A poster (or episode still) card. The title opens the show, and its link stretches over the
 * whole card, so the card is one target; badges and buttons sit above that layer.
 *   show      { malId, title, image } opened in the show panel; or `open` for something else
 *   link      the title's real href (new tab with ⌘/Ctrl); defaults to the show on MyAnimeList
 *   badges    nodes on the image (play pill, corner badges, ticks); a play pill marks the card has-play
 *   progress  0..1 for a bar under the image (omit for none), progressOpts passed through
 *   pill      a small label above the title (related cards)
 *   sub, meta grey lines; meta is an array (joined with ·) or a node; metaFirst puts meta above sub
 *   actions   a row of buttons at the bottom (array, or a node such as a .card-actions div)
 *   wrap      put the text parts in a div with this class (side-by-side layouts)
 */
export function showCard({ show = null, open = null, link = null, image = '', fallback = null, kind = 'poster', eager = false, badges = [],
  progress: frac = null, progressOpts = {}, title = '', lines = 2, pill = null, sub = null, subClass = '', meta = null, metaFirst = false, actions = null, extra = [], cls = '', wrap = null, attrs = {} } = {}) {
  const name = title || show?.title || '';
  const go = open || (show ? () => openAnime(show) : null);
  const href = link || (show?.malId ? `https://myanimelist.net/anime/${show.malId}` : '#');
  const titleEl = go ? cardLink(name, go, { lines, href }) : h('h3', { class: `card-title ${lines === 1 ? 'one-line' : 'clamp-2'}`, title: name }, name);
  const metaEl = meta == null ? null : meta instanceof Node ? meta : h('p', { class: 'card-meta' }, meta.filter(Boolean).join(' · '));
  // An empty sub ('') still renders: some card grids line their rows up across cards.
  const subEl = sub == null ? null : h('p', { class: `card-sub ${subClass}`.trim(), title: typeof sub === 'string' ? sub : null }, sub);
  const actionsEl = actions == null ? null : actions instanceof Node ? actions : h('div', { class: 'card-actions' }, ...actions.filter(Boolean));
  const kids = badges.filter(Boolean);
  const hasPlay = kids.some((b) => b.classList?.contains('play-overlay') && b.tagName === 'A');
  const text = [pill, titleEl, ...(metaFirst ? [metaEl, subEl] : [subEl, metaEl]), actionsEl].filter(Boolean);
  return h('article', { class: `card ${hasPlay ? 'has-play' : ''} ${cls}`.replace(/\s+/g, ' ').trim(), ...attrs },
    media({ src: image || show?.image || '', fallback, alt: '', kind, eager, badges: kids }),
    frac == null ? null : progress(frac, progressOpts),
    ...(wrap ? [h('div', { class: wrap }, ...text)] : text),
    ...extra.filter(Boolean));
}
