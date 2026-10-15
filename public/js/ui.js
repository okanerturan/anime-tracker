// Tiny DOM helpers. All dynamic text goes through text nodes (no innerHTML with data).
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); else el.style[prop] = val;
      }
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  chev: 'M9 6l6 6-6 6',
  play: 'M8 5.5v13l10.5-6.5z'
};
/** replaceChildren that skips null/false (the DOM would print them as text) and flattens arrays. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/**
 * Image box that holds any upload. `kind` is 'wide' (16:9) or 'poster' (2:3).
 * A portrait image in a wide box (a poster standing in for an episode still) is shown whole,
 * on a tinted surface, instead of being cropped to a strip.
 */
export function media({ src, alt = '', kind = 'wide', fallback = null, badges = [], tint = null } = {}) {
  const box = h('div', { class: `media ${kind === 'poster' ? 'media--poster' : ''}`, style: tint ? { '--tint': tint } : null });
  const useSrc = src || fallback;
  if (useSrc) {
    const img = h('img', { src: useSrc, alt, loading: 'lazy', decoding: 'async' });
    if (kind === 'wide') {
      // A poster in a wide frame is shown whole, over a blurred copy of itself instead of empty bars.
      const portrait = () => {
        if (box.classList.contains('is-portrait')) return;
        box.classList.add('is-portrait');
        box.prepend(h('img', { class: 'media-backdrop', src: img.src, alt: '', 'aria-hidden': 'true', decoding: 'async' }));
      };
      if (!src && fallback) portrait();
      // An "episode still" that is really a poster is shown whole instead of cropped to a strip.
      else img.addEventListener('load', () => { if (img.naturalHeight > img.naturalWidth * 0.9) portrait(); }, { once: true });
    }
    box.append(img);
  }
  box.append(...badges.filter(Boolean));
  return box;
}

export function progress(fraction, { hideWhenEmpty = false } = {}) {
  const p = Math.max(0, Math.min(1, Number(fraction) || 0));
  return h('div', { class: `progress ${hideWhenEmpty && !p ? 'is-empty' : ''}`, role: 'presentation' },
    h('span', { style: { '--p': String(p) } }));
}

let toastTimer = null;
/** A short message; with `action` ({ label, onClick }) it carries one button, e.g. Undo. */
export function toast(text, action = null) {
  // Recreate the element if it was removed with a panel that redrew while hosting it.
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', class: 'toast', popover: 'manual', role: 'status' }); document.body.append(el); }
  // A modal panel makes the rest of the page unclickable, so while one is open the message lives
  // inside it; otherwise an Undo shown over the panel could be seen but not pressed.
  const host = document.querySelector('dialog[open]') || document.body;
  if (el.parentElement !== host) { try { el.hidePopover(); } catch {} host.append(el); }
  if (action) {
    const btn = h('button', { type: 'button', class: 'toast-action' }, action.label);
    btn.addEventListener('click', () => { action.onClick(); el.hidePopover?.(); });
    el.replaceChildren(h('span', {}, text), btn);
    try { el.showPopover(); } catch {}
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { try { el.hidePopover(); } catch {} }, 6000);
    return;
  }
  el.textContent = text;
  try { if (!el.matches(':popover-open')) el.showPopover(); } catch { el.hidden = false; }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { try { el.hidePopover(); } catch { el.hidden = true; } }, 3200);
}

export function section(title, sub, ...content) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, title), sub ? h('span', { class: 'sub' }, sub) : null),
    ...content);
}

/** Carousel on native scroll; the arrow buttons are the only scripted part. */
export function carousel(title, sub, items, emptyText) {
  if (!items.length) return section(title, sub, h('div', { class: 'empty' }, emptyText));
  const track = h('div', { class: 'carousel', tabindex: '0', 'aria-label': title }, items);
  const prev = h('button', { type: 'button', 'aria-label': `Previous ${title}` }, icon('left'));
  const next = h('button', { type: 'button', 'aria-label': `Next ${title}` }, icon('right'));
  const step = (dir) => {
    const card = track.firstElementChild.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    track.scrollBy({ left: dir * (card + gap) * Math.max(1, Math.floor(track.clientWidth / (card + gap))) });
  };
  const sync = () => {
    const max = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 1;
    next.disabled = track.scrollLeft >= max - 1;
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  track.addEventListener('scroll', sync, { passive: true });
  requestAnimationFrame(sync);
  new ResizeObserver(sync).observe(track);
  return h('section', { class: 'section shelf' },
    h('div', { class: 'section-head' }, h('h2', {}, title), sub ? h('span', { class: 'sub' }, sub) : null,
      h('div', { class: 'carousel-nav' }, prev, next)),
    track);
}

export function relTime(ms) {
  if (!ms) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [u, size] of [['year', 31536000000], ['month', 2592000000], ['day', 86400000], ['hour', 3600000], ['minute', 60000]]) {
    if (abs >= size || u === 'minute') return rtf.format(Math.round(diff / size), u);
  }
  return '';
}

export function ago(iso) { return iso ? relTime(new Date(iso).getTime()) : ''; }

export function statusPill(status) {
  if (status === 'RELEASING') return h('span', { class: 'pill airing' }, 'AIRING');
  if (status === 'NOT_YET_RELEASED') return h('span', { class: 'pill upcoming' }, 'UPCOMING');
  return null;
}

export const FORMAT_LABEL = { TV: 'TV', TV_SHORT: 'Short', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', MUSIC: 'Music' };

/**
 * Whole card clickable from one link: the title is a real link whose ::after covers the card.
 * A link (unlike a button) is inline, so the title can clamp and truncate with an ellipsis.
 */
export function cardLink(text, onClick, { lines = 2, href = '#' } = {}) {
  const a = h('a', { class: 'card-link', href }, text);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onClick();
  });
  return h('h3', { class: `card-title ${lines === 1 ? 'one-line' : 'clamp-2'}`, title: text }, a);
}

/** Lowercase, accents and punctuation removed: "Re:ZERO" and "re zero" compare equal. */
export const normTitle = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Every word of the query appears in the show's titles, alternate titles ("JJK") or extra text. */
export function titleMatches(x, query, extra = '') {
  const words = normTitle(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = ` ${normTitle(`${x.titleEnglish || ''} ${x.title || ''} ${(x.synonyms || []).join(' ')} ${extra}`)}`;
  return words.every((w) => hay.includes(w));
}
