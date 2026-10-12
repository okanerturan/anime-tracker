// Isolated-world bridge between the Crunchyroll page and the extension service worker.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'anime-tracker-main') return;
  if (e.data.type === 'cr-config') {
    chrome.runtime.sendMessage({ type: 'cr-config', clientId: e.data.clientId }, (resp) => {
      if (!resp || !resp.shouldSync) return;
      chrome.runtime.sendMessage({ type: 'sync-now' }, (result) => {
        // Background fetch failed (e.g. cookies not available to the worker): fetch from the page instead.
        if (result && !result.ok && !/tracker/.test(result.error || '')) {
          window.postMessage({ source: 'anime-tracker-bridge', type: 'fetch-history', since: resp.since || null, wantSeasons: resp.wantSeasons || [] }, location.origin);
        }
      });
    });
  } else if (e.data.type === 'history-data') {
    chrome.runtime.sendMessage({ type: 'page-data', data: e.data.data });
  }
});
