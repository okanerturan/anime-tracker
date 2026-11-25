// Isolated-world bridge between the Crunchyroll page and the extension service worker.
(() => {
  // After the extension is reloaded or updated, this copy of the script is cut off from it and every
  // chrome.runtime call throws ("Extension context invalidated"). There is nothing to do then (the
  // next load of a Crunchyroll tab gets the new copy), so it is not left to surface as an error.
  function send(msg, then) {
    try {
      chrome.runtime.sendMessage(msg, (answer) => { if (!chrome.runtime.lastError && then) then(answer); });
    } catch { /* cut off from the extension */ }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'anime-tracker-main') return;
    if (e.data.type === 'cr-config') {
      send({ type: 'cr-config', clientId: e.data.clientId }, (resp) => {
        if (!resp || !resp.shouldSync) return;
        send({ type: 'sync-now' }, (result) => {
          // Background fetch failed (e.g. cookies not available to the worker): fetch from the page instead.
          // The failed sync's answer carries what to fetch (it got that from the tracker before failing).
          if (result && !result.ok && !/tracker/.test(result.error || '')) {
            window.postMessage({ source: 'anime-tracker-bridge', type: 'fetch-history', since: result.since || null, wantSeasons: result.wantSeasons || [], wantSeries: result.wantSeries || [] }, location.origin);
          }
        });
      });
    } else if (e.data.type === 'history-data') {
      send({ type: 'page-data', data: e.data.data });
    }
  });
})();
