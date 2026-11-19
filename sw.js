// ------------------------------------------------------------------
// Kill-switch service worker (project 0000).
//
// Why this exists: the original PoC registered a service worker at
// scope "/" which cached its app shell at "/". After the restructure,
// "/" is the landing menu, so that stale cached shell would keep being
// served and the menu would never appear.
//
// This worker replaces the old one, deletes every cache, then
// unregisters itself. The menu page registers no worker, so once this
// has run the origin is service-worker-free.
//
// It is safe to delete this file later; the browser only needs it once.
// ------------------------------------------------------------------

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));

    await self.registration.unregister();

    // Reload any open pages so they pick up the fresh, uncached menu.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.navigate(client.url);
    }
  })());
});
