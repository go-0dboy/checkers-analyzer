/**
 * sw.js — service worker: «сначала сеть, офлайн — из кеша» (network-first).
 * Обновления кода применяются при обычной перезагрузке; bump CACHE чистит старое.
 * Большие .bin-базы в пре-кеш НЕ входят (читаются по сети/офлайн-кешу по мере надобности).
 */
const CACHE = 'checkers-v8';
const ASSETS = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-maskable.svg',
  './js/main.js', './js/engine.js', './js/board.js', './js/history.js', './js/pdn.js',
  './js/storage.js', './js/themes.js', './js/toast.js', './js/export.js', './js/settings.js',
  './js/library.js', './js/openings.js', './js/gamesdb.js', './js/idb.js',
  './js/ai.js', './js/ai-worker.js', './js/tb.js', './js/tb-worker.js', './js/train-worker.js',
  './data/games.json', './data/openings.json', './data/checkers-weights.json',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      const results = await Promise.allSettled(ASSETS.map((url) => cache.add(url)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) console.warn('SW: некоторые файлы не закэшированы:', failed.length);
      return self.skipWaiting();
    })
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
  })());
});