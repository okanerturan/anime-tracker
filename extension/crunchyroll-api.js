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
          episodeId: e.id, episodeNumber: e.episode_number, title: e.title,
          airDate: e.premium_available_date || e.episode_air_date || null, thumb: pickThumb(e.images)
        }))
      });
    } catch (err) { /* skip this season */ }
  }
  return seasons;
}

/** One sync pass: history since `since`, plus episode lists for the seasons the tracker asked for. */
async function crunchyrollSync({ base = 'https://www.crunchyroll.com', clientId, since = null, full = false, wantSeasons = [] }) {
  const token = await crunchyrollToken(base, clientId);
  const rows = await fetchHistory(base, token, { since: full ? null : since, maxPages: full ? 100 : 20 });
  const seasons = await fetchSeasons(base, token, wantSeasons);
  return { rows, seasons };
}
