const CACHE_NAME = 'chef-ai-v1';
const STATIC_ASSETS = [
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/js/chat.js',
  '/static/js/filters.js',
  '/static/js/recipe_tools.js',
  '/static/js/live.js',
  '/static/js/training.js',
  '/static/js/planner.js',
  '/static/js/profile.js',
  '/static/js/history.js',
  '/static/js/favorites.js'
];

// ─── Install: cache static assets ───
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches ───
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch: cache-first for static, network-first for API ───
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls or auth
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return;

  // Cache-first for static assets
  if (url.pathname.startsWith('/static/')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return resp;
      }))
    );
    return;
  }

  // Network-first for HTML
  e.respondWith(fetch(e.request).catch(() => caches.match('/')));
});

// ─── Push notifications (timer done) ───
self.addEventListener('message', e => {
  if (e.data?.type === 'TIMER_DONE') {
    self.registration.showNotification('⏱ Chef AI — Timer gotowy!', {
      body: e.data.label || 'Czas minął!',
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'timer',
      renotify: true,
      requireInteraction: true
    });
  }
});

// ─── Notification click ───
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow('/');
  }));
});
