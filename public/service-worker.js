const CACHE_NAME = 'sinav-merkezi-v2';
const urlsToCache = [
  // Sadece statik dosyalar - dinamik sayfalar degil
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap',
  '/css/veli-mobile.css'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Cache acildi');
        return cache.addAll(urlsToCache);
      })
      .catch((err) => {
        console.log('Cache hatasi:', err);
      })
  );
  // Hemen aktif et
  self.skipWaiting();
});

// Fetch event - network first, cache fallback (dinamik sayfalar icin)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Navigate isteklerini (sayfa yuklemeleri) dogrudan network'e yonlendir
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          return caches.match('/offline.html');
        })
    );
    return;
  }

  // Statik dosyalar icin cache-first strateji
  if (urlsToCache.some(cacheUrl => event.request.url.includes(cacheUrl) || url.pathname === cacheUrl)) {
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          if (response) {
            return response;
          }
          return fetch(event.request).then((fetchResponse) => {
            // Basarili response'u cache'e ekle
            if (fetchResponse && fetchResponse.status === 200) {
              const responseClone = fetchResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }
            return fetchResponse;
          });
        })
    );
    return;
  }

  // Diger istekler icin network-first
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Eski cache silindi:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Hemen tum client'lari kontrol et
      return self.clients.claim();
    })
  );
});
