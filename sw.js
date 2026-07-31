// sw.js — Service worker de RodeoFlow
// Objetivo simple: que la app (el "shell": index.html, manifest, íconos)
// cargue aunque no haya internet. Los datos reales (animales, potreros, etc.)
// ya los maneja la app con IndexedDB, esto NO se mete con eso.

const CACHE_NAME = 'rodeoflow-shell-v1';
const ARCHIVOS_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ARCHIVOS_SHELL))
      .catch((err) => console.warn('[sw] No se pudo cachear todo el shell:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((nombre) => nombre !== CACHE_NAME)
          .map((nombre) => caches.delete(nombre))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo nos metemos con pedidos GET a nuestro propio dominio (el "shell").
  // Todo lo demás (Firebase, APIs de precios, CDNs externos) pasa directo a
  // la red, sin que el service worker interfiera.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Si trajo algo de la red, lo guardamos actualizado en caché para la próxima.
        const copia = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        return res;
      })
      .catch(() =>
        // Sin internet: servimos lo que tengamos guardado.
        caches.match(req).then((cacheado) => cacheado || caches.match('./index.html'))
      )
  );
});
