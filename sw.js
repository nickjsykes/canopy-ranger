// Offline cache. Serve from cache instantly (no signal in the wood), refresh
// the cache in the background whenever there is signal. Bump VERSION on release.
const VERSION = 'ranger-v4';
const ASSETS = ['./', './index.html', './app.js', './parse.js', './manifest.json', './icon.png'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache (Pages sets max-age=600), so a new VERSION gets new files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
    return cached || fresh;
  }));
});
