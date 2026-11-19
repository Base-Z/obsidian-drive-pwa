// Service worker for project 0001 (PWA Proof of Concept).
// Scope: its own directory — it must not touch the landing menu or other apps.
//
// Portability: every path is resolved against self.registration.scope, so the
// SAME file works whether the site is served from "/" (Caddy on the LAN) or
// from a subpath like "/<repo>/" (GitHub Pages). Never hard-code /0001/.
//
// Strategy: cache-first for same-origin GETs (so the app opens instantly
// with no network), with a background revalidate so updates still land.
// Bump VERSION to force a clean cache on the next visit.

const VERSION = 'poc-v4';
const CACHE = `pwa-poc-${VERSION}`;

const SCOPE = self.registration.scope;
const P = (p) => new URL(p, SCOPE).href;                      // inside this app
const SHARED = (p) => new URL('../shared/' + p, SCOPE).href;  // project 0000 assets

const ASSETS = [
  P('./'),
  P('index.html'),
  P('manifest.webmanifest'),
  P('icons/icon-192.png'),
  P('icons/icon-512.png'),
  P('icons/icon-512-maskable.png'),
  SHARED('app.css'),          // shared framework asset (project 0000)
  SHARED('statusbar.js')      // shared status bar (project 0000)
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through

  // Status-bar reachability probe: never intercept it, so it always goes to
  // the network and its failure genuinely means "server unreachable".
  if (url.searchParams.has('ping')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to whatever we cached

      return cached || network;
    })
  );
});
