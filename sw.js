/**
 * Service Worker - 基础 PWA 支持
 * 仅用于让 iOS "添加到主屏幕" 以 standalone 模式运行
 * 不做离线缓存，因为这是一个需要实时连接的管理工具
 */

const CACHE_NAME = 'cc-manager-v1';
const PRECACHE = [
  '/',
  '/index.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first 策略：优先网络，失败时回退缓存
  // 这对于实时管理工具是正确的策略
  if (event.request.method !== 'GET') return;

  // 只缓存同源的页面请求
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // API 和 WebSocket 请求不���存
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // 更新缓存
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
