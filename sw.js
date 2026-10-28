// Önbellek kullanmaz: eski önbellekleri temizler, böylece güncel dosyalar her zaman yüklenir.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
