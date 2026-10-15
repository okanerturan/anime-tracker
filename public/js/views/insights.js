import { api } from '../api.js';
import { h, section, fill } from '../ui.js';
import { openAnime } from '../drawer.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function bars(values, labels, fmt = (v) => v) {
  const max = Math.max(...values, 1);
  return h('div', { class: 'chart' },
    h('div', { class: 'bars', role: 'img', 'aria-label': labels.map((l, i) => `${l}: ${fmt(values[i])}`).join(', ') },
      values.map((v, i) => h('div', { class: 'bar', title: `${labels[i]}: ${fmt(v)}`, style: { '--h': `${(100 * v) / max}%` } }))),
    h('div', { class: 'bar-labels' }, labels.map((l) => h('span', {}, l))));
}

function hbars(rows, { value = 'value', label = 'name', suffix = '', onOpen = null } = {}) {
  const max = Math.max(...rows.map((r) => r[value]), 1);
  return h('div', { class: 'hbars' }, rows.map((r) => h('div', { class: `hbar ${onOpen && r.malId ? 'is-link' : ''}`, onclick: onOpen && r.malId ? () => onOpen(r) : null, role: onOpen && r.malId ? 'button' : null, tabindex: onOpen && r.malId ? '0' : null, onkeydown: onOpen && r.malId ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r); } } : null },
    h('span', { class: 'name one-line', title: r[label] }, r[label]),
    h('span', { class: 'track' }, h('span', { style: { '--p': String(r[value] / max) } })),
    h('span', { class: 'num' }, `${r[value]}${suffix}`))));
}

/** Year in review: a chip per year; the panel shows that year's totals and its top five shows. */
function yearsSection(years) {
  if (years.length < 2) return null;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const body = h('div', { class: 'panel year-review' });
  const chips = h('div', { class: 'chips segmented', role: 'group', 'aria-label': 'Year' });
  const show = (y) => {
    for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.year === String(y.year)));
    fill(body,
      h('div', { class: 'stat-row' },
        stat(`${y.hours}\u00a0h`, `${y.episodes.toLocaleString()} episodes`),
        stat(String(y.shows), 'shows'),
        y.busiestMonth ? stat(MONTHS[y.busiestMonth.month - 1], `busiest month · ${y.busiestMonth.hours}\u00a0h`) : null),
      y.leanedInto?.length ? h('p', { class: 'muted' }, `Compared with your usual taste, ${y.year} leaned into `, h('b', {}, y.leanedInto.join(' and ')), '.') : null,
      h('h3', {}, `Most watched in ${y.year}`),
      h('ol', { class: 'year-top' }, y.top.map((t) => h('li', {},
        t.malId ? h('a', { class: 'row-link', href: `#/insights?anime=${t.malId}`, onclick: (e) => { e.preventDefault(); openAnime({ malId: t.malId, title: t.title }); } }, t.title) : h('span', {}, t.title),
        h('span', { class: 'muted num' }, `${t.episodes} eps`)))));
  };
  for (const y of years) {
    const c = h('button', { type: 'button', class: 'chip-toggle', 'data-year': String(y.year), 'aria-pressed': 'false' }, String(y.year));
    c.addEventListener('click', () => show(y));
    chips.append(c);
  }
  // Open on last year once it's over: the current year already has its own card at the top.
  show(years.find((y) => y.year < new Date().getFullYear()) || years[0]);
  return section('Your years', 'Each year at a glance: hours, shows and what you watched most', chips, body);
}

const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));

/** "Recently watched": plays grouped by local day, with a Show more button that pages back in time. */
function historySection() {
  const list = h('div', { class: 'history' });
  const more = h('button', { type: 'button', class: 'btn small ghost', hidden: true }, 'Show more');
  let next = null; let lastDay = null;
  const dayLabel = (d) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  };
  const load = async () => {
    more.disabled = true;
    const page = await api.history(next);
    // A binge reads as one row: consecutive finished episodes of the same show on the same day
    // (newest first, so E24, E23, … E16) merge into "E16–E24 · 9 episodes".
    const done = (p) => p.percent == null || p.percent >= 80;
    const ep = (p) => p.malEpisode || p.episodeNumber;
    const runs = [];
    for (const p of page.items) {
      const last = runs[runs.length - 1];
      const prev = last && last[last.length - 1];
      if (prev && done(p) && done(prev) && (p.title || p.seriesTitle) === (prev.title || prev.seriesTitle)
        && dayLabel(p.datePlayed) === dayLabel(prev.datePlayed) && ep(p) && ep(prev) && ep(p) === ep(prev) - 1) last.push(p);
      else runs.push([p]);
    }
    for (const run of runs) {
      const p = run[0];
      const label = dayLabel(p.datePlayed);
      if (label !== lastDay) { list.append(h('h3', { class: 'history-day' }, label)); lastDay = label; }
      if (run.length > 1) {
        const first = ep(run[run.length - 1]);
        list.append(h(p.malId ? 'button' : 'div', { type: p.malId ? 'button' : null, class: 'history-row', onclick: p.malId ? () => openAnime({ malId: p.malId, title: p.title || p.seriesTitle }) : null },
          h('span', { class: 'history-time num' }, new Date(p.datePlayed).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
          h('span', { class: 'history-what' },
            h('span', { class: 'history-title' }, h('b', { class: 'one-line' }, p.title || p.seriesTitle), h('span', { class: 'history-ep num' }, `E${first}–E${ep(p)}`)),
            h('span', { class: 'history-sub one-line' }, `${run.length} episodes`)),
          h('span', { class: 'history-pct num is-done' }, '✓')));
        continue;
      }
      const name = p.episodeTitle && !/^Episode \d+$/.test(p.episodeTitle) ? p.episodeTitle : '';
      const row = h(p.malId ? 'button' : 'div', { type: p.malId ? 'button' : null, class: `history-row ${p.percent != null && p.percent < 80 ? 'is-partial' : ''}`, onclick: p.malId ? () => openAnime({ malId: p.malId, title: p.title || p.seriesTitle }) : null },
        h('span', { class: 'history-time num' }, new Date(p.datePlayed).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
        h('span', { class: 'history-what' },
          h('span', { class: 'history-title' }, h('b', { class: 'one-line' }, p.title || p.seriesTitle), h('span', { class: 'history-ep num' }, `E${p.malEpisode || p.episodeNumber || '?'}`)),
          name ? h('span', { class: 'history-sub one-line' }, name) : null),
        h('span', { class: `history-pct num ${p.percent >= 80 ? 'is-done' : ''}`, 'aria-label': p.percent == null ? null : p.percent >= 80 ? 'finished' : `${p.percent}% watched`, title: p.percent != null && p.percent < 80 ? `${p.percent}% watched` : null }, p.percent == null ? '' : p.percent >= 80 ? '✓' : `${p.percent}%`));
      list.append(row);
    }
    next = page.next;
    more.hidden = !next;
    more.disabled = false;
    syncDays();
  };
  // "Finished only" hides episodes you only sampled; a day whose rows are all hidden hides its heading too.
  let finishedOnly = false;
  try { finishedOnly = localStorage.getItem('history:finishedOnly') === '1'; } catch {}
  const toggle = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(finishedOnly) }, 'Finished only');
  const syncDays = () => {
    list.classList.toggle('finished-only', finishedOnly);
    for (const head of list.querySelectorAll('.history-day')) {
      let el = head.nextElementSibling; let any = false;
      while (el && !el.classList.contains('history-day')) { if (!(finishedOnly && el.classList.contains('is-partial'))) any = true; el = el.nextElementSibling; }
      head.hidden = !any;
    }
  };
  toggle.addEventListener('click', () => {
    finishedOnly = !finishedOnly; toggle.setAttribute('aria-pressed', String(finishedOnly));
    try { localStorage.setItem('history:finishedOnly', finishedOnly ? '1' : '0'); } catch {}
    syncDays();
  });
  more.addEventListener('click', load);
  load().catch(() => list.append(h('div', { class: 'muted' }, 'Could not load history.')));
  const csv = h('a', { class: 'btn small', href: '/api/history.csv', download: '' }, 'Export as CSV');
  return section('Recently watched', 'Your Crunchyroll history by day; a run of episodes is one row', h('div', { class: 'panel' }, h('div', { class: 'hero-actions' }, csv, toggle), list, more));
}

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const s = await api.study();
  const t = s.totals;
  if (!t.episodes && !(s.byYear || []).length) {
    fill(view, section('Insights', null, h('div', { class: 'empty' },
      h('p', {}, 'Your viewing study appears after your first Crunchyroll sync: hours watched, streaks, when you watch, what you finish.'),
      h('a', { class: 'btn primary', href: '#/sync' }, 'Set up sync'))));
    return;
  }
  const peakHour = s.byHour.indexOf(Math.max(...s.byHour));
  const peakDay = s.byWeekday.indexOf(Math.max(...s.byWeekday));
  const finishRate = t.showsStarted ? Math.round((100 * t.showsFinished) / t.showsStarted) : 0;
  const bestYear = [...s.byYear].sort((a, b) => b.hours - a.hours)[0];
  const thisYear = s.byYear.find((y) => y.year === new Date().getFullYear());
  fill(view,
    thisYear ? h('section', { class: 'tonight year-so-far' },
      h('div', { class: 'tonight-info' },
        h('p', { class: 'eyebrow' }, `${thisYear.year} so far`),
        h('h2', { class: 'tonight-title' }, `${thisYear.episodes.toLocaleString()} episodes, ${thisYear.hours.toLocaleString()} hours, ${thisYear.shows} shows`),
        h('p', { class: 'tonight-sub' }, bestYear && bestYear.year !== thisYear.year
          ? `${bestYear.year} is still your biggest year at ${bestYear.hours.toLocaleString()} hours. ${Math.max(0, bestYear.hours - thisYear.hours).toLocaleString()} to go.`
          : 'Your biggest year yet.'))) : null,
    section('Your viewing study', `From ${t.episodes.toLocaleString()} Crunchyroll episodes since ${t.firstPlay ? new Date(t.firstPlay).getFullYear() : '—'}`,
      h('div', { class: 'stat-row' },
        stat(t.hours.toLocaleString(), `hours watched (${t.days} days)`),
        stat(t.episodes.toLocaleString(), 'episodes finished'),
        stat(t.showsStarted, 'shows started'),
        stat(`${finishRate}%`, `finished (${t.showsFinished}); ${t.showsDropped} sampled & dropped`),
        stat(`${String(peakHour).padStart(2, '0')}:00`, `peak hour · ${WEEKDAYS[peakDay]} is your top day`),
        bestYear ? stat(bestYear.year, `biggest year: ${bestYear.hours}\u00a0h, ${bestYear.shows} shows`) : null,
        s.week ? stat(`${s.week.thisEpisodes} ep${s.week.thisEpisodes === 1 ? '' : 's'}`, `this week · ${s.week.thisHours}\u00a0h · last week ${s.week.lastEpisodes} (${s.week.lastHours}\u00a0h)${s.week.thisEpisodes > s.week.lastEpisodes ? ' ↑' : s.week.thisEpisodes < s.week.lastEpisodes ? ' ↓' : ''}`) : null,
        s.streaks ? stat(`${s.streaks.current} day${s.streaks.current === 1 ? '' : 's'}`, `current streak · longest ${s.streaks.longest}${s.streaks.longestEnd ? ` (ending ${new Date(s.streaks.longestEnd).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })})` : ''} · ${s.streaks.activeDays} watch days`) : null)),
    h('div', { class: 'panels' },
      h('div', { class: 'panel' }, h('h3', {}, 'Hours per month'), bars(s.byMonth.map((m) => m.hours), s.byMonth.map((m) => (m.month.endsWith('-01') ? `’${m.month.slice(2, 4)}` : m.month.slice(5))), (v) => `${v} h`)),
      h('div', { class: 'panel' }, h('h3', {}, 'Episodes per year'), bars(s.byYear.map((y) => y.episodes), s.byYear.map((y) => String(y.year))))),
    h('div', { class: 'panels' },
      h('div', { class: 'panel' }, h('h3', {}, `When you watch (hour of day, ${s.timezone})`), s.bulkMarked ? h('div', { class: 'faint' }, `${s.bulkMarked} bulk "mark as watched" entries excluded`) : null, bars(s.byHour, s.byHour.map((_, i) => (i % 3 === 0 ? String(i) : '')))),
      h('div', { class: 'panel' }, h('h3', {}, 'Day of week'), bars(s.byWeekday, WEEKDAYS))),
    h('div', { class: 'panels' },
      h('div', { class: 'panel' }, h('h3', {}, 'Favourite genres'), hbars(s.taste.genres, { value: 'weight', suffix: '%' })),
      h('div', { class: 'panel' }, h('h3', {}, 'Recurring themes'), hbars(s.taste.tags, { value: 'weight', suffix: '%' }))),
    h('div', { class: 'panels' },
      s.finishRateByGenre?.length ? h('div', { class: 'panel' }, h('h3', {}, 'What you finish'),
        h('p', { class: 'muted' }, 'Share of started shows you watched to the end, by genre (5+ shows)'),
        hbars(s.finishRateByGenre.map((g) => ({ name: `${g.name} (${g.finished}/${g.started})`, value: g.rate })), { suffix: '%' })) : null,
      h('div', { class: 'panel' }, h('h3', {}, 'Most watched'), hbars(s.topShows.map((x) => ({ name: x.title, value: x.episodes, malId: x.malId })), { suffix: ' eps', onOpen: (r) => openAnime({ malId: r.malId, title: r.name }) })),
      h('div', { class: 'panel' }, h('h3', {}, 'Biggest binges'),
        s.binges.length ? h('table', { class: 'simple' }, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Show'), h('th', { class: 'num-col' }, 'Eps')),
          s.binges.map((b) => h('tr', {}, h('td', { class: 'date-col' }, new Date(b.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })),
            h('td', {}, b.malId ? h('a', { class: 'row-link', href: `#/insights?anime=${b.malId}`, onclick: (e) => { e.preventDefault(); openAnime({ malId: b.malId, title: b.show }); } }, b.show) : b.show),
            h('td', { class: 'num-col' }, b.episodes)))) : h('div', { class: 'muted' }, 'No 6+ episode days yet.'))),
    yearsSection(s.years || []),
    historySection());
}
