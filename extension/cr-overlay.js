// On crunchyroll.com series and watch pages: a small card with your progress in the tracker.
// Runs in the extension's isolated world and draws inside a shadow root, so Crunchyroll's CSS
// can't touch it and it can't touch Crunchyroll. Dismissing hides it until the next page.
(function () {
  const SERIES_RE = /\/series\/([A-Z0-9]+)/i;
  let lastKey = null; let host = null; let dismissedFor = null;

  function currentSeriesId() {
    const m = location.pathname.match(SERIES_RE);
    if (m) return m[1];
    // Episode pages link back to their series. Only there: on the home page or browse pages the
    // first series link is just whichever carousel show happens to load first.
    if (!/\/watch\//.test(location.pathname)) return null;
    const a = document.querySelector('.show-title-link[href*="/series/"], [data-t="show-title-link"][href*="/series/"]')
      || document.querySelector('.current-media-parent-ref a[href*="/series/"], .erc-current-media-info a[href*="/series/"]')
      || document.querySelector('a[href*="/series/"]');
    return a ? (a.getAttribute('href').match(SERIES_RE) || [])[1] : null;
  }

  function remove() { host?.remove(); host = null; }

  /** The words every title starts with (whole words only; '' when that would be too short to mean anything). */
  function sharedStart(titles) {
    if (titles.length < 2) return '';
    let n = 0;
    while (titles.every((t) => n < t.length && t[n] === titles[0][n])) n += 1;
    const cut = titles.every((t) => t.length === n || /[\s:,–-]/.test(t[n])) ? n : titles[0].lastIndexOf(' ', n);
    return cut >= 8 ? titles[0].slice(0, cut) : '';
  }

  function render(info, seriesId) {
    remove();
    if (!info || !info.shows || !info.shows.length || dismissedFor === seriesId) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'closed' });
    const current = info.shows.find((s) => s.nextEpisode && s.watched < (s.aired || 0)) || info.shows[info.shows.length - 1];
    // Earlier seasons: a small list above; the current one is the card's title, its count inline.
    const count = (s) => (s.aired && s.watched >= s.aired ? `✓${s.rating ? ` · ★${s.rating}` : ''}` : `${s.watched}/${s.aired ?? '?'}`);
    // Seasons share the series name ("Reborn as a Vending Machine, … Season 2"), and a long one cut to
    // fit leaves rows that look identical: drop the shared start, keep what tells them apart.
    const shared = sharedStart(info.shows.map((s) => s.title));
    const short = (s, i) => {
      const rest = s.title.slice(shared.length).replace(/^[\s:,–-]+/, '');
      return rest || (i === 0 ? 'Season 1' : s.title);
    };
    const others = info.shows.slice(-4).filter((s) => s !== current).map((s) =>
      `<li><span class="t" title="${esc(s.title)}">${esc(short(s, info.shows.indexOf(s)))}</span><span class="p">${count(s)}</span></li>`).join('');
    const rows = `${others ? `<ul class="others">${others}</ul>` : ''}${current ? `<p class="title">${esc(current.title)} <span class="count">${count(current)}</span></p>` : ''}`;
    // Finished and not rated yet: rate it right here (ratings steer the tracker's recommendations).
    const finished = current && current.aired && current.watched >= current.aired && current.status === 'FINISHED';
    const rateRow = finished && !current.rating
      ? `<div class="rate"><span>Rate it</span>${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>`
      : '';
    // Started but not finished: hold or drop it from here (or undo a hold/drop).
    const unfinished = current && current.watched > 0 && current.aired && current.watched < current.aired;
    const stateLabel = { on_hold: 'On hold', dropped: 'Dropped' }[current?.listStatus];
    const listRow = unfinished
      ? (stateLabel ? `<div class="list"><span>${stateLabel}</span><button type="button" class="lnk" data-status="">Make active</button></div>`
        : `<div class="list"><span class="q">Not for you?</span><button type="button" class="lnk" data-status="on_hold">Hold</button><button type="button" class="lnk" data-status="dropped">Drop</button></div>`)
      : '';
    const next = current && current.nextEpisode && current.watched < (current.aired || 0) ? `Next: episode ${current.nextEpisode}`
      : info.nextSeason ? `New season out: ${info.nextSeason.title}`
        : (current && current.status === 'RELEASING' ? 'Caught up · airing' : 'All caught up');
    const target = info.nextSeason && !(current && current.nextEpisode) ? info.nextSeason.malId : (current ? current.malId : '');
    root.innerHTML = `<style>
      :host { all: initial; }
      /* Episode pages: after a few seconds the card folds to its icon so it can't cover the player's
         controls; hovering or focusing it opens it again. */
      .card.mini { width: auto; padding: 8px; cursor: pointer; border-radius: 14px; }
      .card.mini > :not(header) { display: none; }
      .card.mini header { margin: 0; }
      .card.mini header > :not(img) { display: none; }
      .card.mini header img { width: 22px; height: 22px; }
      .card { font: 14px/1.4 system-ui, -apple-system, sans-serif; color: #eef0f5; width: 300px; box-sizing: border-box; padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
        background: radial-gradient(120% 70% at 50% 0%, #26304a 0%, #171b25 55%, #14171f 100%);
        border: 1px solid #343a4c; border-radius: 18px; box-shadow: 0 14px 40px rgba(0,0,0,.5); }
      header { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
      header img { width: 24px; height: 24px; border-radius: 6px; }
      header button { margin-left: auto; background: none; border: 0; color: #8a90a1; font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 4px; }
      @media (hover: hover) and (pointer: fine) { header button:hover { color: #eef0f5; } }
      /* Earlier seasons: small and quiet; a long name wraps instead of being cut off. */
      .others { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; font-size: 12.5px; color: #8a90a1; }
      .others li { display: flex; gap: 8px; justify-content: space-between; }
      .t { min-width: 0; overflow-wrap: anywhere; }
      .p { flex: none; font-variant-numeric: tabular-nums; }
      .title { margin: 0; font-size: 16px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere;
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }
      .count { font-weight: 500; color: #7f8fb0; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .bar { height: 5px; border-radius: 3px; background: #2f3442; overflow: hidden; }
      .bar i { display: block; height: 100%; border-radius: 3px; background: #f47521; }
      .next { color: #f6a35b; font-weight: 600; }
      /* The next episode, one click away on the site you're already on. */
      a.next.play { display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; padding: 10px 14px;
        border-radius: 999px; background: #f47521; color: #1a1205; font-weight: 700; font-size: 15px; }
      a.next.play:focus-visible, a.open:focus-visible { outline: 2px solid #f6a35b; outline-offset: 2px; }
      .list { display: flex; align-items: center; gap: 10px; color: #a3a8b8; }
      .lnk { background: none; border: 0; padding: 0; color: #f6a35b; font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
      .lnk:focus-visible { outline: 2px solid #f6a35b; outline-offset: 2px; border-radius: 3px; }
      .rate { display: flex; align-items: center; gap: 2px; color: #a3a8b8; }
      .rate span { margin-right: 6px; }
      .star { background: none; border: 0; padding: 0 1px; font-size: 20px; line-height: 1; color: #4a4f5e; cursor: pointer; }
      @media (hover: hover) and (pointer: fine) {
        .rate:hover .star { color: #f6a35b; }
        .rate .star:hover ~ .star { color: #4a4f5e; }
        a.next.play:hover { filter: brightness(1.07); }
        a.open:hover { background: rgba(246,163,91,.08); }
      }
      .star:focus-visible { outline: 2px solid #f6a35b; outline-offset: 1px; border-radius: 3px; }
      a.open { display: block; text-align: center; text-decoration: none; padding: 9px 14px; border-radius: 999px; font-weight: 600;
        color: #1a1205; background: #f47521; }
      a:active, button:active { transform: scale(0.98); }
      /* With a Play button on the card, "Open in tracker" steps back to an outline. */
      .card:has(a.next.play) a.open { background: none; color: #f6a35b; border: 1px solid #6b4528; }
    </style>
    <div class="card" role="complementary" aria-label="Tsuzuku">
      <header><img src="${chrome.runtime.getURL('icons/icon-32.png')}" alt="">Tsuzuku<button type="button" aria-label="Hide">×</button></header>
      ${rows}
      ${current && current.aired ? `<div class="bar" role="img" aria-label="${current.watched} of ${current.aired} watched"><i style="width:${Math.min(100, Math.round((100 * current.watched) / current.aired))}%"></i></div>` : ''}
      ${current && current.nextEpisodeUrl && current.watched < (current.aired || 0)
        ? `<a class="next play" href="${esc(current.nextEpisodeUrl)}">▶ Play episode ${current.nextEpisode}</a>`
        : `<div class="next">${esc(next)}</div>`}
      ${rateRow}
      ${listRow}
      <a href="${esc(info.trackerUrl)}/#/library?anime=${target}" target="_blank" rel="noopener" class="open">Open in tracker</a>
    </div>`;
    root.querySelector('header button').addEventListener('click', () => { dismissedFor = seriesId; remove(); });
    root.querySelectorAll('.lnk').forEach((b) => b.addEventListener('click', async () => {
      const status = b.dataset.status || null;
      const row = root.querySelector('.list');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'list-status', malId: current.malId, status });
        if (!r || !r.ok) { row.textContent = 'Could not save that'; return; }
        current.listStatus = status;
        row.textContent = status === 'dropped' ? 'Dropped. It leaves Up Next.' : status === 'on_hold' ? 'On hold. It leaves Up Next until you watch it again.' : 'Active again.';
      } catch { row.textContent = 'Could not save that'; }
    }));
    root.querySelectorAll('.star').forEach((b) => b.addEventListener('click', async () => {
      const n = Number(b.dataset.n);
      const row = root.querySelector('.rate');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'rate', malId: current.malId, rating: n });
        row.textContent = r && r.ok ? `Rated ${'★'.repeat(n)} · thanks` : 'Could not save the rating';
        if (r && r.ok) current.rating = n;
      } catch { row.textContent = 'Could not save the rating'; }
    }));
    document.documentElement.appendChild(host);
    if (/\/watch\//.test(location.pathname)) {
      const card = root.querySelector('.card');
      let timer = setTimeout(() => card.classList.add('mini'), 6000);
      const open = () => { clearTimeout(timer); card.classList.remove('mini'); };
      const fold = () => { clearTimeout(timer); timer = setTimeout(() => card.classList.add('mini'), 1500); };
      card.addEventListener('mouseenter', open);
      card.addEventListener('focusin', open);
      card.addEventListener('mouseleave', fold);
      card.addEventListener('focusout', fold);
      card.tabIndex = 0;
    }
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  async function check() {
    const seriesId = currentSeriesId();
    const key = `${location.pathname}|${seriesId}`;
    if (key === lastKey) return;
    lastKey = key;
    if (!seriesId) { remove(); return; }
    try {
      const info = await chrome.runtime.sendMessage({ type: 'series-info', seriesId });
      if (`${location.pathname}|${currentSeriesId()}` === key) render(info, seriesId);
    } catch { /* extension reloaded or tracker unreachable: stay quiet */ }
  }

  // Crunchyroll is a single-page app: watch the URL and the series link appearing after navigation.
  setInterval(check, 1200);
  check();
})();
