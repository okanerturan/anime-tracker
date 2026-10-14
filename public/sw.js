// Offline shell: static files are served network-first with a cached fallback, so a deploy is
// picked up on the next load and the app still opens on a train. Images are cache-first (their
// URLs are content-addressed and immutable). API calls always go to the network; the pages keep
// their own last-known snapshots in localStorage.
const CACHE = 'anime-tracker-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/manifest.webmanifest', '/favicon.svg',
  '/js/main.js', '/js/api.js', '/js/ui.js', '/js/bus.js', '/js/drawer.js', '/js/anilist-relay.js',
  '/js/views/upnext.js', '/js/views/library.js', '/js/views/discover.js', '/js/views/insights.js', '/js/views/sync.js',
  '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/') || url.pathname === '/login' || url.pathname === '/logout') return;

  if (url.pathname.startsWith('/img/') || url.pathname.startsWith('/api/episode-image')) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // Shell: network first, cache fallback. A redirect to /login (signed out) is passed through untouched.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && res.type === 'basic') caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  }).catch(async () => (await caches.match(e.request)) || (await caches.match('/index.html')) || Response.error()));
});
