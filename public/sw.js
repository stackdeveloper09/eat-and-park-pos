const CACHE_NAME = "eat-and-park-shell-v1";
const APP_PAGES = ["/", "/staff", "/delivery"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    for (const path of APP_PAGES) {
      const response = await fetch(path, { cache: "reload" });
      if (!response.ok) throw new Error(`Failed to cache app page ${path}: ${response.status}`);
      await cache.put(path, response.clone());

      const html = await response.text();
      const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
        .map((match) => match[1]);
      for (const assetPath of assetPaths) {
        const assetResponse = await fetch(assetPath, { cache: "reload" });
        if (!assetResponse.ok) throw new Error(`Failed to cache app asset ${assetPath}: ${assetResponse.status}`);
        await cache.put(assetPath, assetResponse);
      }
    }

    const staticAssets = [
      "/manifest.json",
      "/staff-manifest.json",
      "/delivery-manifest.json",
      "/icons/customer-180.png",
      "/icons/customer-192.png",
      "/icons/customer-512.png",
      "/icons/staff-180.png",
      "/icons/staff-192.png",
      "/icons/staff-512.png",
      "/icons/delivery-180.png",
      "/icons/delivery-192.png",
      "/icons/delivery-512.png",
    ];
    await cache.addAll(staticAssets);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith("eat-and-park-shell-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(url.pathname, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(url.pathname);
        return cached || caches.match("/");
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname.endsWith("manifest.json")) {
    event.respondWith((async () => {
      const cached = await caches.match(url.pathname, { ignoreSearch: true, ignoreVary: true });
      if (cached) return cached;
      return fetch(request);
    })());
  }
});
