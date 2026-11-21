// Benedita Studio 3D — PWA v1.8
// Conteúdo estático; dados pessoais ficam no IndexedDB do navegador.
const CACHE = 'benedita-central-v18';
const PREFIX = 'benedita-central-';
const PRELOAD = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './mascote-benedita.webp'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRELOAD)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Em linha, busca a versão recente; offline, utiliza a tela salva.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then(cache => cache.put(req, copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match('./index.html')) || Response.error())
    );
    return;
  }
  // Recursos locais conhecidos ficam disponíveis sem internet.
  event.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
