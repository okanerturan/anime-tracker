// Shared building blocks for things that appear on several pages. A show shown anywhere opens
// the same way: these components own that, so a list can't forget to make the show clickable.
import { h } from './ui.js';
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
