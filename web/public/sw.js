// This app doesn't use a service worker. If a browser still has one registered
// for this origin (e.g. from another app previously served on the same port),
// this replacement clears its caches, unregisters itself and reloads open tabs.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
