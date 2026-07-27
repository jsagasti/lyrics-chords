/* Service worker: OTA-friendly.
   Strategy: network-first for everything, with a cache fallback for offline.
   - Online (the normal kiosk state): every reload fetches the latest app + songs,
     so pushes to the repo show up immediately. No version bump needed.
   - Offline: falls back to the last-cached copy so the tablet still works. */
const CACHE = 'lyrics-v8';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // 'no-cache' forces the browser HTTP cache to revalidate with the server
  // (conditional request), so GitHub Pages' 10-min cache never serves a stale
  // shell. Fresh copy goes into our cache for offline fallback.
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
