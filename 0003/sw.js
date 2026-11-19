/* ============================================================
   sw.js — project 0003 (Obsidian Drive PWA)
   Scope: its own directory (Caddy: /0003/ · GitHub Pages: /<repo>/0003/).

   Portability: every path is resolved against self.registration.scope, so
   the SAME file works at any mount depth. Never hard-code /0003/.

   Precaches the app shell, shared assets, KaTeX and fonts so the app
   launches and renders notes offline. Bump VERSION on changes.
   ============================================================ */
const VERSION = 'v2';
const CACHE = 'odp3-' + VERSION;

const SCOPE = self.registration.scope;
const P = (p) => new URL(p, SCOPE).href;                      // inside this app
const SHARED = (p) => new URL('../shared/' + p, SCOPE).href;  // project 0000 assets

const PRECACHE = [
  P('./'),
  P('index.html'),
  P('app.css'),
  P('manifest.webmanifest'),
  P('js/config.js'),
  P('js/store.js'),
  P('js/lock.js'),
  P('js/markdown.js'),
  P('js/vault.js'),
  P('js/demo.js'),
  P('js/auth.js'),
  P('js/drive.js'),
  P('js/app.js'),
  P('vendor/katex/katex.min.js'),
  P('vendor/katex/katex.min.css'),
  SHARED('app.css'),
  SHARED('statusbar.js'),
  P('icons/icon-192.png'),
  P('icons/icon-512.png'),
  P('icons/icon-512-maskable.png'),
  P('vendor/katex/fonts/KaTeX_AMS-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2'),
  P('vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2'),
  P('vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Main-Bold.woff2'),
  P('vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2'),
  P('vendor/katex/fonts/KaTeX_Main-Italic.woff2'),
  P('vendor/katex/fonts/KaTeX_Main-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2'),
  P('vendor/katex/fonts/KaTeX_Math-Italic.woff2'),
  P('vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2'),
  P('vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2'),
  P('vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Script-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Size1-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Size2-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Size3-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Size4-Regular.woff2'),
  P('vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2')
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('odp3-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept the status bar's reachability probe.
  if (url.searchParams.has('ping')) return;

  if (e.request.method !== 'GET') return;

  // Only own same-origin requests under this app's scope (plus the shared
  // assets one level up); let the Google Drive API pass straight through.
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(SCOPE).pathname;                // e.g. /0003/
  const sharedPath = new URL('../shared/', SCOPE).pathname; // e.g. /shared/
  if (!url.pathname.startsWith(scopePath) && !url.pathname.startsWith(sharedPath)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request, { ignoreSearch: false });
    if (cached) return cached;

    try {
      const net = await fetch(e.request);
      if (net && net.ok) cache.put(e.request, net.clone());
      return net;
    } catch (err) {
      // Offline navigation → app shell.
      if (e.request.mode === 'navigate') {
        const shell = await cache.match(P('index.html')) || await cache.match(P('./'));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
