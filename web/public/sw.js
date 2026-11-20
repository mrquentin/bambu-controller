// Service worker: push notifications only. There is deliberately no `fetch`
// handler, so every request goes to the network (nothing is cached offline).
//
// Activation also cleans up after workers other apps may have registered on
// the same origin before (e.g. another app previously served on this port):
// this worker replaces them, deletes their caches and reloads open tabs that
// were showing their cached pages.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      for (const key of keys) await caches.delete(key);
      await self.clients.claim();
      if (keys.length) {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.navigate(client.url).catch(() => {});
      }
    })(),
  );
});

/** Only navigate to pages of this app. */
function sameOriginUrl(raw) {
  try {
    const url = new URL(raw || '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : self.location.origin + '/';
  } catch {
    return self.location.origin + '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(String(data.title || 'Bambu Controller'), {
      body: String(data.body || ''),
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: data.tag ? String(data.tag) : undefined,
      renotify: Boolean(data.tag),
      timestamp: typeof data.at === 'number' ? data.at : Date.now(),
      data: { url: sameOriginUrl(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOriginUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (!client) return self.clients.openWindow(url);
      await client.focus();
      // The app routes by hash; it listens for this message (see web/src/lib/push.ts).
      client.postMessage({ type: 'navigate', url });
    })(),
  );
});

// The browser rotated the subscription: register the new one with the server,
// carrying over this device's preferences.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let next = event.newSubscription;
      if (!next) {
        let applicationServerKey = old && old.options.applicationServerKey;
        if (!applicationServerKey) {
          const res = await fetch('/api/push/key', { credentials: 'same-origin' });
          if (!res.ok) return;
          applicationServerKey = (await res.json()).publicKey;
        }
        next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      }
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'service-worker' },
        body: JSON.stringify({ subscription: next.toJSON(), replaces: old ? old.endpoint : undefined }),
      });
    })().catch(() => {}),
  );
});
