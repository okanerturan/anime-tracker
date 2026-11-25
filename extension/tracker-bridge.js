// Runs only on the tracker's own pages. Lets the Connect page (or the Account page) find this extension
// and hand it a sync token or the passphrase without knowing the extension's id (unpacked installs get a new id each time).
(() => {
  document.documentElement.dataset.trackerExtension = chrome.runtime.getManifest().version;
  window.addEventListener('message', (e) => {
    // Only this page, talking to itself; and only something shaped like a tracker device token.
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    // A device token (accounts mode), or the passphrase from the single-user tracker's Account page.
    if (!d || d.source !== 'anime-tracker-connect' || typeof d.token !== 'string' || !d.token || d.token.length > 200) return;
    chrome.runtime.sendMessage({ type: 'connect-tracker', url: location.origin, token: d.token }, (r) => {
      window.postMessage({ source: 'anime-tracker-extension', connected: Boolean(r?.ok), error: r?.error || null }, location.origin);
    });
  });
})();
