/**
 * sw.js — service worker: «сначала сеть, офлайн — из кеша» (network-first).
 *
 * Стратегия: на каждый GET-запрос сначала идём в сеть с cache:'no-store'
 * (обходя HTTP-кеш браузера), и только при провале сети отдаём из кеша.
 * Это значит, что обновления кода применяются при обычной перезагрузке —
 * ручной очистки кеша не требуется.
 *
 * При bump версии CACHE (checkers-v2, v3, …) старые кэши удаляются в activate.
 * Список ASSETS пре-кэшируется при установке, чтобы критичные файлы были
 * доступны сразу, даже если сеть появится позже.
 */
const CACHE = 'checkers-v5';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './js/main.js',
  './js/engine.js',
  './js/board.js',
  './js/history.js',
  './js/pdn.js',
  './js/storage.js',
  './js/themes.js',
  './js/toast.js',
  './js/export.js',
  './js/settings.js',
  './js/library.js',
  './js/openings.js',
  './data/games.json',
  './data/openings.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Кэшируем файлы по одному — не падаем целиком, если PNG/JSON отсутствует.
      const results = await Promise.allSettled(ASSETS.map((url) => cache.add(url)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) console.warn('SW: некоторые файлы не закэшированы:', failed.length);
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Чужое происхождение (шрифты Google и пр.) — только сеть, без кеша.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      // Всегда идём в сеть, обходя HTTP-кеш браузера.
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        // Сохраняем успешный ответ в кеш — пригодится при следующем офлайне.
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return fresh;
    } catch (err) {
      // Сеть недоступна — отдаём из кеша, если есть.
      const cached = await caches.match(req);
      if (cached) return cached;
      // Для навигационных запросов — отдаём оболочку приложения.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      // Для остальных ресурсов — пустой ответ 503.
      return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    }
  })());
});