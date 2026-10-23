// Shared Crunchyroll client. Runs in the extension service worker, or in the page as a fallback.
// It uses the browser's existing Crunchyroll login (the etp_rt cookie) to get a short-lived access
// token; the token stays in memory and is only ever sent to Crunchyroll.
/* exported crunchyrollSync */
async function crunchyrollToken(base, clientId) {
  if (!clientId) throw new Error('no Crunchyroll client id yet: open crunchyroll.com once');
  const body = new URLSearchParams({ grant_type: 'etp_rt_cookie', device_type: 'Anime Tracker Sync', device_id: crypto.randomUUID() });
  const res = await fetch(`${base}/auth/v1/token`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${clientId}:`)}` },
    body
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const token = await res.json();
  if (!token.access_token || !token.account_id) throw new Error('not logged in to Crunchyroll');
  return token;
}

function pickThumb(images) {
  const thumbs = (images && images.thumbnail && images.thumbnail[0]) || [];
  return (thumbs.find((t) => t.width >= 600) || thumbs[thumbs.length - 1] || {}).source || null;
}

async function fetchHistory(base, token, { since, maxPages, pageSize = 100 }) {
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const sinceMs = since ? new Date(since).getTime() - 2 * 86400000 : 0; // 2-day overlap catches updated playheads
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetch(`${base}/content/v2/${token.account_id}/watch-history?page=${page}&page_size=${pageSize}&locale=en-US`, { headers });
    if (!res.ok) throw new Error(`history ${res.status}`);
    const data = (await res.json()).data || [];
    for (const x of data) {
      const m = x.panel && x.panel.episode_metadata;
      if (!m) continue;
      rows.push({
        episodeId: x.id, seriesId: m.series_id, seriesTitle: m.series_title, seasonId: m.season_id, seasonTitle: m.season_title,
        seasonNumber: m.season_number, episodeNumber: m.episode_number, episodeTitle: x.panel.title,
        durationS: Math.round((m.duration_ms || 0) / 1000), playhead: x.playhead || 0, fullyWatched: Boolean(x.fully_watched),
        datePlayed: x.date_played, thumb: pickThumb(x.panel.images)
      });
    }
    const oldest = data.length ? new Date(data[data.length - 1].date_played).getTime() : 0;
    if (data.length < pageSize || (sinceMs && oldest < sinceMs)) break;
  }
  return rows;
}

/**
 * Every audio version of an episode has its own id. Asked without a preferred audio language, this
 * API answers with the English version's ids, whatever your profile says (crunchyroll.com itself
 * always sends one). Take the version from the season you actually watched, else the original audio.
 * audioMatched tells the tracker the id is a deliberate choice.
 */
function pickVersion(e, seasonId) {
  const versions = e.versions || e.episode_metadata?.versions || [];
  const v = versions.find((x) => x.season_guid === seasonId) || versions.find((x) => x.original);
  return v ? { episodeId: v.guid, audioMatched: true } : { episodeId: e.id, audioMatched: false };
}

async function fetchSeasons(base, token, seasonIds) {
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const seasons = [];
  for (const seasonId of (seasonIds || []).slice(0, 30)) {
    try {
      const res = await fetch(`${base}/content/v2/cms/seasons/${encodeURIComponent(seasonId)}/episodes?locale=en-US`, { headers });
      if (!res.ok) continue;
      const data = (await res.json()).data || [];
      seasons.push({
        seasonId,
        episodes: data.map((e) => ({
          ...pickVersion(e, seasonId), episodeNumber: e.episode_number, title: e.title,
          airDate: e.premium_available_date || e.episode_air_date || null, thumb: pickThumb(e.images)
        }))
      });
    } catch (err) { /* skip this season */ }
  }
  return seasons;
}

/**
 * Library shows not played yet: fetch their series' season lists (the original-audio version of each
 * season), let the tracker pick each show's season (`choose`), then fetch those seasons' episodes.
 */
async function fetchSeriesSeasons(base, token, wants, choose) {
  if (!wants || !wants.length || !choose) return [];
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const items = [];
  for (const w of wants.slice(0, 10)) {
    try {
      const res = await fetch(`${base}/content/v2/cms/series/${encodeURIComponent(w.seriesId)}/seasons?locale=en-US`, { headers });
      if (!res.ok) continue;
      const data = (await res.json()).data || [];
      items.push({ malId: w.malId, seasons: data.map((s) => {
        const v = (s.versions || []).find((x) => x.original);
        return { id: (v && v.guid) || s.id, title: s.title, seasonNumber: s.season_number };
      }) });
    } catch (err) { /* skip this one */ }
  }
  if (!items.length) return [];
  let ids = [];
  try { ids = (await choose(items)) || []; } catch (err) { return []; }
  return fetchSeasons(base, token, ids);
}

/** Crunchyroll's own search for shows the tracker has no series link for: [{ malId, candidates }]. */
async function searchSeries(base, token, wants) {
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const results = [];
  for (const w of (wants || []).slice(0, 25)) {
    try {
      const res = await fetch(`${base}/content/v2/discover/search?q=${encodeURIComponent(w.query)}&n=6&type=series&locale=en-US`, { headers });
      if (!res.ok) continue;
      const items = ((await res.json()).data || [])[0]?.items || [];
      results.push({ malId: w.malId, candidates: items.map((i) => ({ id: i.id, title: i.title, slug: i.slug_title })) });
    } catch (err) { /* skip this one */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return results;
}

/** One sync pass: history since `since`, episode lists and series lookups the tracker asked for. */
async function crunchyrollSync({ base = 'https://www.crunchyroll.com', clientId, since = null, full = false, wantSeasons = [], wantSeries = [], wantSeriesSeasons = [], chooseSeasons = null }) {
  const token = await crunchyrollToken(base, clientId);
  const rows = await fetchHistory(base, token, { since: full ? null : since, maxPages: full ? 100 : 20 });
  const seasons = [...await fetchSeasons(base, token, wantSeasons), ...await fetchSeriesSeasons(base, token, wantSeriesSeasons, chooseSeasons)];
  const series = await searchSeries(base, token, wantSeries);
  return { rows, seasons, series };
}
