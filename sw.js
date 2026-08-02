/**
 * sw.js — офлайн-кэш для PWA-обёртки анализатора.
 * Cache-first по URL приложения; версия в CACHE ломает кэш при новом деплое.
 */
const CACHE = 'checkers-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  './js/main.js',
  './js/engine.js',
  './js/board.js',
  './js/history.js',
  './js/pdn.js',
  './js/storage.js',
  './js/themes.js',
  './js/toast.js',
  './js/export.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))   // упадёт, если хоть один путь 404 — держите список в sync
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // кэшируем только своё происхождение; чужое (шрифты) — только сеть
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // докэшируем на лету пропущенное (например, новые PNG-иконки)
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html')); // офлайн-fallback на оболочку
    })
  );
});