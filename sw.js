const CACHE_NAME = 'taxi-app-v14';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function(cache) { return cache.addAll(ASSETS); }));
});
self.addEventListener('fetch', function(event) {
  event.respondWith(caches.match(event.request).then(function(cached) { return cached || fetch(event.request); }));
});


