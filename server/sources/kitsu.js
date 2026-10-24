'use strict';
// Kitsu: a gap filler for episode titles, air dates and thumbnails, per MAL entry (the ID map gives the
// Kitsu id). Good for popular older shows, empty for many others. 20 requests a minute; three failures
// in a row pause it for 30 minutes. No key needed.
const { createLimiter } = require('./limiter');

const BASE = 'https://kitsu.app/api/edge';
const PAGE = 20; // Kitsu's largest page

function createKitsu({ fetchImpl = null, now, sleep } = {}) {
  const limiter = createLimiter({ name: 'Kitsu', perMinute: 20, now, sleep });
  const doFetch = fetchImpl || require('../upstream').fetch;

  const get = (url) => limiter.run(async () => {
    const res = await doFetch(url, { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(15e3) });
    if (res.status === 404) throw Object.assign(new Error('Kitsu 404'), { notFailure: true, notFound: true });
    if (!res.ok) throw new Error(`Kitsu HTTP ${res.status}`);
    return res.json();
  });

  /** All episodes of a Kitsu anime: { count, episodes: [{ episodeNumber, title, aired, imageUrl }] }. */
  async function episodes(kitsuId, { maxPages = 15 } = {}) {
    const out = [];
    let url = `${BASE}/anime/${Number(kitsuId)}/episodes?page%5Blimit%5D=${PAGE}&page%5Boffset%5D=0&sort=number`;
    let count = 0;
    for (let page = 0; url && page < maxPages; page += 1) {
      const json = await get(url);
      count = json.meta?.count ?? count;
      for (const d of json.data || []) {
        const a = d.attributes || {};
        if (!Number.isInteger(a.number) || a.number < 1) continue;
        const title = [a.canonicalTitle, a.titles?.en, a.titles?.en_us, a.titles?.en_jp].find((t) => t && !/^Episode \d+$/i.test(t.trim()));
        out.push({
          episodeNumber: a.number,
          title: title ? title.trim() : null,
          aired: /^\d{4}-\d{2}-\d{2}$/.test(a.airdate || '') ? a.airdate : null,
          imageUrl: a.thumbnail?.original || a.thumbnail?.large || null
        });
      }
      url = json.links?.next || null;
    }
    return { count, episodes: out };
  }

  return { isAvailable: limiter.isAvailable, episodes, status: limiter.status };
}

const kitsu = createKitsu();
module.exports = { ...kitsu, createKitsu };
