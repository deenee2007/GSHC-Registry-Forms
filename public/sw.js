/*
 * sw.js — lets the app open and work on drafts when the internet drops.
 *
 * Everything is fetched from the network first, so updates always arrive
 * when online. The last good copy of each page, script and API answer is
 * kept, and used only when the network fails.
 */
const SHELL = 'gshc-shell-v22';
const API = 'gshc-api';

const SHELL_FILES = [
  '/', '/index.html', '/manifest.json', '/css/styles.css',
  '/assets/highcourt.png', '/assets/coat.png', '/icons/icon-192.png',
  '/js/core/api.js', '/js/core/db.js', '/js/core/auth.js', '/js/core/permissions.js',
  '/js/core/ui.js', '/js/core/output.js', '/js/core/workflow.js', '/js/core/recordEngine.js',
  '/js/core/router.js', '/js/modules/dashboard.js', '/js/modules/registry.js',
  '/js/modules/appeals.js', '/js/modules/execution.js', '/js/modules/general.js', '/js/modules/inbox.js',
  '/js/modules/submissions.js', '/js/modules/signature.js', '/js/modules/account.js', '/js/modules/reports.js', '/js/modules/cases.js', '/js/modules/settings.js',
  '/js/main.js', '/guide', '/css/guide.css', '/js/guide.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== API).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const offlineJson = () => new Response(
  JSON.stringify({ offline: true, error: 'You are offline and this information has not been saved on this computer yet.' }),
  { status: 503, headers: { 'Content-Type': 'application/json' } }
);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never keep verification answers, password reset links or backup files
  // (which hold the whole database) on the computer.
  if (url.pathname.startsWith('/api/verify') || url.pathname.startsWith('/api/auth/reset') || url.pathname === '/healthz' ||
      url.pathname.startsWith('/api/admin/backups') || url.pathname === '/api/admin/export') return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(API).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.open(API).then(c => c.match(req)).then(hit => hit || offlineJson()))
    );
    return;
  }

  event.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(async () => {
      const cache = await caches.open(SHELL);
      return (await cache.match(req, { ignoreSearch: true })) ||
             (req.mode === 'navigate' ? cache.match('/index.html') : Response.error());
    })
  );
});
