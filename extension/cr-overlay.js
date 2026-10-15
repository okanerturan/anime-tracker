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

  function render(info, seriesId) {
    remove();
    if (!info || !info.shows || !info.shows.length || dismissedFor === seriesId) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'closed' });
    const current = info.shows.find((s) => s.nextEpisode && s.watched < (s.aired || 0)) || info.shows[info.shows.length - 1];
    const rows = info.shows.slice(-4).map((s) => {
      const done = s.aired && s.watched >= s.aired;
      return `<li class="${s === current ? 'cur' : ''}"><span class="t">${esc(s.title)}</span><span class="p">${done ? '✓' : `${s.watched}/${s.aired ?? '?'}`}${s.rating ? ` · ★${s.rating}` : ''}</span></li>`;
    }).join('');
    // Finished and not rated yet: rate it right here (ratings steer the tracker's recommendations).
    const finished = current && current.aired && current.watched >= current.aired && current.status === 'FINISHED';
    const rateRow = finished && !current.rating
      ? `<div class="rate"><span>Rate it</span>${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>`
      : '';
    const next = current && current.nextEpisode && current.watched < (current.aired || 0) ? `Next: episode ${current.nextEpisode}`
      : info.nextSeason ? `New season out: ${info.nextSeason.title}`
        : (current && current.status === 'RELEASING' ? 'Caught up · airing' : 'All caught up');
    const target = info.nextSeason && !(current && current.nextEpisode) ? info.nextSeason.malId : (current ? current.malId : '');
    root.innerHTML = `<style>
      :host { all: initial; }
      .card { font: 13px/1.35 system-ui, sans-serif; color: #e8e9ee; background: rgba(20,22,28,.94); border: 1px solid #2f3442; border-radius: 12px;
        padding: 10px 12px; width: 260px; box-shadow: 0 8px 24px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
      header { display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 6px; }
      header img { width: 16px; height: 16px; border-radius: 4px; }
      header button { margin-left: auto; background: none; border: 0; color: #a7abb9; font-size: 16px; cursor: pointer; line-height: 1; }
      ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
      li { display: flex; gap: 8px; justify-content: space-between; color: #a7abb9; }
      li.cur { color: #fff; }
      .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .p { flex: none; font-variant-numeric: tabular-nums; }
      .next { margin-top: 6px; color: #f6a35b; font-weight: 600; }
      .rate { display: flex; align-items: center; gap: 2px; margin-top: 6px; color: #a7abb9; }
      .rate span { margin-right: 4px; }
      .star { background: none; border: 0; padding: 0 1px; font-size: 18px; line-height: 1; color: #4a4f5e; cursor: pointer; }
      @media (hover: hover) and (pointer: fine) {
        .rate:hover .star { color: #f6a35b; }
        .rate .star:hover ~ .star { color: #4a4f5e; }
      }
      .star:focus-visible { outline: 2px solid #f6a35b; outline-offset: 1px; border-radius: 3px; }
      a { display: inline-block; margin-top: 8px; color: #1b1206; background: #f47521; border-radius: 6px; padding: 5px 9px; font-weight: 700; text-decoration: none; }
    </style>
    <div class="card" role="complementary" aria-label="Anime Tracker">
      <header><img src="${chrome.runtime.getURL('icons/icon-32.png')}" alt="">Anime Tracker<button type="button" aria-label="Hide">×</button></header>
      <ul>${rows}</ul>
      <div class="next">${esc(next)}</div>
      ${rateRow}
      <a href="${esc(info.trackerUrl)}/#/library?anime=${target}" target="_blank" rel="noopener">Open in tracker</a>
    </div>`;
    root.querySelector('header button').addEventListener('click', () => { dismissedFor = seriesId; remove(); });
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
