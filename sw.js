const CACHE_NAME = "homemaster-pwa-v1.4.5";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.png",
  "./icons/Icon-192.png",
  "./icons/Icon-512.png",
  "./icons/Icon-maskable-192.png",
  "./icons/Icon-maskable-512.png"
];

function isFreshCriticalAsset(req, url) {
  if (req.mode === "navigate") return true;
  const p = url.pathname;
  return (
    p.endsWith("/") ||
    p.endsWith(".html") ||
    p.endsWith(".js") ||
    p.endsWith("manifest.json")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          CORE_ASSETS.map((asset) =>
            fetch(asset, { cache: "no-cache" })
              .then((res) => (res && res.ok ? cache.put(asset, res) : null))
              .catch(() => null)
          )
        )
      )
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const networkPromise = isFreshCriticalAsset(req, url)
    ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
    : fetch(req);

  // Network-first strategy so deployed fixes reach family members immediately,
  // while providing full offline fallback and qualifying the PWA for install prompts.
  event.respondWith(
    networkPromise
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          return caches.match("./index.html");
        }
        return Response.error();
      })
  );
});
