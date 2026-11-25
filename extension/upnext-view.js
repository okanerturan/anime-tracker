// The part of the tracker's Up Next that the popup shows. Shared by the popup and the service worker,
// which keeps a copy after every sync so the popup can draw the list the moment it opens and check
// for changes afterwards.
/* exported UP_NEXT_SHOWN, isNewEpisode, upNextView */
const UP_NEXT_SHOWN = 6;
const UP_NEXT_FIELDS = ['malId', 'title', 'image', 'status', 'watched', 'aired', 'totalEpisodes', 'remaining', 'episodeMinutes',
  'nextEpisode', 'nextEpisodeTitle', 'nextEpisodeUrl', 'nextEpisodeUrlIsExact', 'nextEpisodeSite', 'nextEpisodeImage',
  'nextAiringEpisode', 'nextAiringAt', 'latestAiredAt'];

/** An episode out in the last 7 days that you haven't watched: the icon's badge and the popup's New tag. */
function isNewEpisode(x, now = Date.now()) {
  return Boolean(x.latestAiredAt) && now - new Date(x.latestAiredAt).getTime() < 7 * 86400000;
}

/** { total, fresh, items }: the counts for the popup's header and its first few shows, nothing else. */
function upNextView(data) {
  const all = (data && data.continueWatching) || [];
  return {
    total: all.length,
    fresh: all.filter((x) => isNewEpisode(x)).length,
    items: all.slice(0, UP_NEXT_SHOWN).map((x) => Object.fromEntries(UP_NEXT_FIELDS.filter((k) => x[k] != null).map((k) => [k, x[k]])))
  };
}
