/* Service Worker：网络优先 + 离线回退
 *
 * 为什么不是"缓存优先"：缓存优先会把旧版 dict.js 永久喂给页面（旧词典只有 1591 词，
 * 查 fun 会退化成 [fun]），而且连 sw.js 自己都换不掉。
 * 现在同源资源一律先走网络，拿不到（断网）才用缓存，既保证更新即时生效，又保持离线可用。
 */
var CACHE = 'transword-v12';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './dict.js',
  './cn-dict.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS);
    }).catch(function () {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨域（翻译接口等）：只走网络，绝不缓存
  if (url.origin !== self.location.origin) {
    e.respondWith(fetch(req));
    return;
  }

  // 同源：网络优先（保证改完刷新就生效），失败再用缓存（保证离线可用）
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      // 离线回退：先按带参数 URL 找，再按去掉 ?v= 的原始路径找（install 预缓存的是后者）
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        return caches.match(url.origin + url.pathname, { ignoreSearch: true });
      }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return undefined;
      });
    })
  );
});
