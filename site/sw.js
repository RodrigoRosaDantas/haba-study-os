const SHELL_CACHE = "haba-study-os-shell-v8";
const CONTENT_CACHE = "haba-study-os-content-v2";
const SHELL_FILES = [
  "./", "./index.html", "./styles.css?v=7", "./manifest.webmanifest", "./icons/favicon.svg",
  "./icons/icon-192.png", "./icons/icon-512.png", "./src/app.js?v=8", "./src/backup.js",
  "./src/content.js", "./src/core.js", "./src/preferences.js", "./src/storage.js", "./src/ui.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_FILES.map(async file => {
      const response = await fetch(file, { cache: "reload" });
      if (response.ok) await cache.put(file, response);
    }));
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => (key.startsWith("haba-study-os-shell-") && key !== SHELL_CACHE)
      || (key.startsWith("haba-study-os-content-") && key !== CONTENT_CACHE)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirstContent(request) {
  const cache = await caches.open(CONTENT_CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) {
      const candidate = await response.clone().json();
      if (candidate?.schemaVersion === 2 && candidate.meta?.contentVersion && Array.isArray(candidate.studyDays) && candidate.studyDays.length === 75) {
        await cache.put(request, response.clone());
        return response;
      }
    }
    const lastGood = await cache.match(request);
    return lastGood || response;
  } catch {
    return await cache.match(request) || new Response(JSON.stringify({ error: "offline-content-unavailable" }), {
      status: 503, headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/data/content.json")) {
    event.respondWith(networkFirstContent(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) (await caches.open(SHELL_CACHE)).put("./index.html", response.clone());
        return response;
      } catch {
        return await caches.match("./index.html") || new Response("HABA Study OS indisponível offline.", { status: 503 });
      }
    })());
    return;
  }
  event.respondWith(cacheFirst(request));
});
