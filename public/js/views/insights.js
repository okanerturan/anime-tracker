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
    for (const p of page.items) {
      const label = dayLabel(p.datePlayed);
      if (label !== lastDay) { list.append(h('h3', { class: 'history-day' }, label)); lastDay = label; }
      const name = p.episodeTitle && !/^Episode \d+$/.test(p.episodeTitle) ? p.episodeTitle : '';
      const row = h(p.malId ? 'button' : 'div', { type: p.malId ? 'button' : null, class: 'history-row', onclick: p.malId ? () => openAnime({ malId: p.malId, title: p.title || p.seriesTitle }) : null },
        h('span', { class: 'history-time num' }, new Date(p.datePlayed).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
        h('span', { class: 'history-what' },
          h('span', { class: 'one-line' }, h('b', {}, p.title || p.seriesTitle), ` · E${p.malEpisode || p.episodeNumber || '?'}`),
          name ? h('span', { class: 'history-sub one-line' }, name) : null),
        h('span', { class: `history-pct num ${p.percent >= 80 ? 'is-done' : ''}` }, p.percent == null ? '' : p.percent >= 80 ? '✓' : `${p.percent}%`));
      list.append(row);
    }
    next = page.next;
    more.hidden = !next;
    more.disabled = false;
  };
  more.addEventListener('click', load);
  load().catch(() => list.append(h('div', { class: 'muted' }, 'Could not load history.')));
  return section('Recently watched', 'Your Crunchyroll history, one row per episode', h('div', { class: 'panel' }, list, more));
}

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const s = await api.study();
  const t = s.totals;
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
        bestYear ? stat(bestYear.year, `biggest year: ${bestYear.hours} h, ${bestYear.shows} shows`) : null,
        s.week ? stat(`${s.week.thisEpisodes} ep${s.week.thisEpisodes === 1 ? '' : 's'}`, `this week · ${s.week.thisHours} h · last week ${s.week.lastEpisodes} (${s.week.lastHours} h)${s.week.thisEpisodes > s.week.lastEpisodes ? ' ↑' : s.week.thisEpisodes < s.week.lastEpisodes ? ' ↓' : ''}`) : null,
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
        s.binges.length ? h('table', { class: 'simple' }, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Show'), h('th', {}, 'Eps')),
          s.binges.map((b) => h('tr', {}, h('td', {}, new Date(b.day).toLocaleDateString()),
            h('td', {}, b.malId ? h('a', { class: 'row-link', href: `#/insights?anime=${b.malId}`, onclick: (e) => { e.preventDefault(); openAnime({ malId: b.malId, title: b.show }); } }, b.show) : b.show),
            h('td', {}, b.episodes)))) : h('div', { class: 'muted' }, 'No 6+ episode days yet.'))),
    historySection());
}
