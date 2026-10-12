import { api } from '../api.js';
import { h, section } from '../ui.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function bars(values, labels, fmt = (v) => v) {
  const max = Math.max(...values, 1);
  return h('div', { class: 'chart' },
    h('div', { class: 'bars', role: 'img', 'aria-label': labels.map((l, i) => `${l}: ${fmt(values[i])}`).join(', ') },
      values.map((v, i) => h('div', { class: 'bar', title: `${labels[i]}: ${fmt(v)}`, style: { '--h': `${(100 * v) / max}%` } }))),
    h('div', { class: 'bar-labels' }, labels.map((l) => h('span', {}, l))));
}

function hbars(rows, { value = 'value', label = 'name', suffix = '' } = {}) {
  const max = Math.max(...rows.map((r) => r[value]), 1);
  return h('div', { class: 'hbars' }, rows.map((r) => h('div', { class: 'hbar' },
    h('span', { class: 'name one-line', title: r[label] }, r[label]),
    h('span', { class: 'track' }, h('span', { style: { '--p': String(r[value] / max) } })),
    h('span', { class: 'num' }, `${r[value]}${suffix}`))));
}

const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));

export async function render(view) {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  const s = await api.study();
  const t = s.totals;
  const peakHour = s.byHour.indexOf(Math.max(...s.byHour));
  const peakDay = s.byWeekday.indexOf(Math.max(...s.byWeekday));
  const finishRate = t.showsStarted ? Math.round((100 * t.showsFinished) / t.showsStarted) : 0;
  const bestYear = [...s.byYear].sort((a, b) => b.hours - a.hours)[0];
  view.replaceChildren(
    section('Your viewing study', `From ${t.episodes.toLocaleString()} Crunchyroll episodes since ${t.firstPlay ? new Date(t.firstPlay).getFullYear() : '—'}`,
      h('div', { class: 'stat-row' },
        stat(t.hours.toLocaleString(), `hours watched (${t.days} days)`),
        stat(t.episodes.toLocaleString(), 'episodes finished'),
        stat(t.showsStarted, 'shows started'),
        stat(`${finishRate}%`, `finished (${t.showsFinished}); ${t.showsDropped} sampled & dropped`),
        stat(`${String(peakHour).padStart(2, '0')}:00`, `peak hour · ${WEEKDAYS[peakDay]} is your top day`),
        bestYear ? stat(bestYear.year, `biggest year: ${bestYear.hours} h, ${bestYear.shows} shows`) : null)),
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
      h('div', { class: 'panel' }, h('h3', {}, 'Most watched'), hbars(s.topShows.map((x) => ({ name: x.title, value: x.episodes })), { suffix: ' eps' })),
      h('div', { class: 'panel' }, h('h3', {}, 'Biggest binges'),
        s.binges.length ? h('table', { class: 'simple' }, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Show'), h('th', {}, 'Eps')),
          s.binges.map((b) => h('tr', {}, h('td', {}, new Date(b.day).toLocaleDateString()), h('td', {}, b.show), h('td', {}, b.episodes)))) : h('div', { class: 'muted' }, 'No 6+ episode days yet.'))));
}
