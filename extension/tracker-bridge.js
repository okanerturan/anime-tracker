// Runs only on the tracker's own pages. Lets the Connect page find this extension and hand it a
// sync token without knowing the extension's id (unpacked installs get a new id each time).
(() => {
  document.documentElement.dataset.trackerExtension = chrome.runtime.getManifest().version;
  window.addEventListener('message', (e) => {
    // Only this page, talking to itself; and only something shaped like a tracker device token.
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'anime-tracker-connect' || typeof d.token !== 'string' || !/^trk_[A-Za-z0-9_-]{20,80}$/.test(d.token)) return;
    chrome.runtime.sendMessage({ type: 'connect-tracker', url: location.origin, token: d.token }, (r) => {
      window.postMessage({ source: 'anime-tracker-extension', connected: Boolean(r?.ok), error: r?.error || null }, location.origin);
    });
  });
})();
