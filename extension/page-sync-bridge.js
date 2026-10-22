// Runs on tracker pages. Lets the tracker's own page ask for a sync ("Sync now" in its header).
// The background only answers when this page's origin is the tracker URL set in the extension, so
// another workers.dev site gets nothing; the tracker key never reaches the page.
(() => {
  const FROM_PAGE = 'anime-tracker-page';
  const FROM_EXT = 'anime-tracker-ext';
  const post = (msg) => window.postMessage({ source: FROM_EXT, ...msg }, location.origin);
  chrome.runtime.sendMessage({ type: 'bridge-hello' }, (r) => {
    if (chrome.runtime.lastError || !r?.ok) return;
    const hello = () => post({ type: 'hello', version: chrome.runtime.getManifest().version });
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin || e.data?.source !== FROM_PAGE) return;
      if (e.data.type === 'ping') hello();
      else if (e.data.type === 'sync-now') {
        chrome.runtime.sendMessage({ type: 'page-sync' }, (res) => {
          post({ type: 'sync-done', ...(chrome.runtime.lastError ? { ok: false, error: 'The extension was reloaded; refresh this page.' } : res) });
        });
      }
    });
    hello(); // the page may already be listening; if not, its ping gets the answer
  });
})();
