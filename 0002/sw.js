// Service worker for project 0002 (Phone Sensor Diagnostics).
// Scope: its own directory — it must not touch the landing menu or other apps.
//
// Portability: every path is resolved against self.registration.scope, so the
// SAME file works whether the site is served from "/" (Caddy on the LAN) or
// from a subpath like "/<repo>/" (GitHub Pages). Never hard-code /0002/.
//
// Cache-first for same-origin GETs so the app opens with no network,
// with a background revalidate so updates still land.
// Bump VERSION to force a clean cache on the next visit.

const VERSION = 'sensors-v3';
const CACHE = `pwa-0002-${VERSION}`;

const SCOPE = self.registration.scope;
const P = (p) => new URL(p, SCOPE).href;                      // inside this app
const SHARED = (p) => new URL('../shared/' + p, SCOPE).href;  // project 0000 assets

const ASSETS = [
  P('./'),
  P('index.html'),
  P('app.js'),
  P('viz.js'),
  P('app.css'),
  P('specdb.json'),
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
  if (url.origin !== self.location.origin) return;   // cross-origin: pass through

  // Status-bar reachability probe: never intercept it, so it always goes to
  // the network and its failure genuinely means "server unreachable".
  if (url.searchParams.has('ping')) return;

  // The live device-spec lookup is proxied by Caddy at /specs/* (LAN only).
  // Never cache it: a stale spec page would be worse than a failed lookup.
  // On GitHub Pages there is no such proxy and the app uses its bundled db.
  if (url.pathname.includes('/specs/')) return;

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
        .catch(() => cached);   // offline: fall back to whatever we cached

      return cached || network;
    })
  );
});
