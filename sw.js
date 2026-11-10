/* 组队码互助池 Service Worker
 * 应用壳缓存：css/js/图标 cache-first，页面 network-first，API 与跨域请求一律直连不缓存
 */
var CACHE = "ddk-shell-v2";
var SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-64.png",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k !== CACHE ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API / CDN 直连

  if (req.mode === "navigate" || url.pathname.endsWith("index.html")) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match("./"); });
      })
    );
    return;
  }

  /* 应用壳资源：stale-while-revalidate —— 先回缓存保证秒开，同时后台拉新版供下次使用 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var fetching = fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || fetching;
    })
  );
});
