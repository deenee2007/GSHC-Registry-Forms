// Self-unregistering service worker.
// This app is served by a local Node.js server (always running),
// so no caching is needed. This file exists only to unregister any
// previously installed service worker and clear stale caches.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => {
  caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  self.registration.unregister();
});
