/* Service worker: offline shell + OTA updates.
   Bump CACHE version when the app shell changes to force an update.
   Song content is fetched network-first so new lyrics appear without a version bump. */
const CACHE = 'lyrics-shell-v3';
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
  const url = new URL(req.url);

  // Songs + index: network-first so content updates OTA, fall back to cache offline.
  if (url.pathname.includes('/songs/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // App shell: cache-first for instant load.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
