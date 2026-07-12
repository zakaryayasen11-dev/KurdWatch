// KURD WATCH service worker — makes the app installable and gives a basic offline fallback.
// Deliberately does NOT cache Supabase API calls, HLS video segments, or third-party CDN
// scripts — only the app shell (this file's own origin, static assets). Live TV, chat, and
// data always go straight to the network so nothing ever goes stale or breaks playback.

const CACHE_NAME = 'kurdwatch-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => {})) // best-effort; don't block install if one asset 404s
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle same-origin GET requests for the app shell. Everything else (Supabase,
  // Tenor/GIPHY, HLS.js CDN, video segments, WebSocket/Realtime) passes straight through.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to cache
      // Stale-while-revalidate: serve cache immediately if we have it, refresh in background.
      return cached || network;
    })
  );
});
