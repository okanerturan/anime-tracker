// Runs in the Crunchyroll page itself: shares the site's public client id with the extension and,
// if the background sync can't use the session, fetches history with the page's own login.
(function () {
  function clientId() {
    const cfg = window.__APP_CONFIG__ && window.__APP_CONFIG__.cxApiParams;
    return cfg && cfg.accountAuthClientId;
  }
  function publish() {
    if (clientId()) window.postMessage({ source: 'anime-tracker-main', type: 'cr-config', clientId: clientId() }, location.origin);
  }
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'anime-tracker-bridge' || e.data.type !== 'fetch-history') return;
    try {
      const data = await crunchyrollSync({ base: location.origin, clientId: clientId(), since: e.data.since, wantSeasons: e.data.wantSeasons || [] });
      window.postMessage({ source: 'anime-tracker-main', type: 'history-data', data }, location.origin);
    } catch (err) {
      window.postMessage({ source: 'anime-tracker-main', type: 'history-error', error: String(err.message || err) }, location.origin);
    }
  });
  publish();
  setTimeout(publish, 3000);
})();
