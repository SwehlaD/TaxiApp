const CACHE_NAME = 'taxi-app-v21';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function(cache) { return cache.addAll(ASSETS); }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener('activate', function(event) {
  event.waitUntil(caches.keys().then(function(names) {
    return Promise.all(names.filter(function(name) { return name !== CACHE_NAME; }).map(function(name) { return caches.delete(name); }));
  }).then(function() { return self.clients.claim(); }));
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(function(response) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, copy); });
    return response;
  }).catch(function() {
    return caches.match(event.request).then(function(cached) { return cached || caches.match('./index.html'); });
  }));
});
