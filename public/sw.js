/* Capture-only cache. Never intercept/cache authenticated app pages, API data, or providers. */
const CACHE_PREFIX = "aro-offline-capture-";
const CACHE_NAME = `${CACHE_PREFIX}v4`;
const ASSETS = [
  "/icons/offline-capture.html",
  "/icons/offline-capture.js",
  "/icons/offline-capture-queue.js",
  "/icons/offline-capture-display.js",
  "/icons/offline-capture.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      for (const path of ASSETS) {
        const response = await fetch(path, { credentials: "omit", redirect: "error", cache: "no-store" });
        if (!response.ok || response.redirected) throw new Error("Offline asset installation failed");
        await cache.put(path, response);
      }
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith(CACHE_PREFIX) || name.startsWith("irang-offline-capture-")) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.search
    || !ASSETS.includes(url.pathname)) return;
  // No runtime cache writes. A miss fetches only the same public allowlisted asset.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(url.pathname)
      ?? fetch(url.pathname, { credentials: "omit", redirect: "error", cache: "no-store" });
  })());
});
