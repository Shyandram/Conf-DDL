// Keeps the heavy, never-changing files on the device after the first download:
// city photos (Unsplash CDN), the generated city scenes (their URLs carry a content hash), the web fonts and GSAP.
// The site's own pages, scripts and data are left to the network so updates show up right away.
const CACHE = "confddl-media-v1";
const MAX_ENTRIES = 120;
const CACHEABLE = /^https:\/\/(images\.unsplash\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  const scene = url.origin === self.location.origin && url.pathname.includes("/assets/scenes/") && url.searchParams.has("v");
  if (request.method !== "GET" || !(CACHEABLE.test(request.url) || scene)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request.url);
    if (hit) return hit;
    // fetch in CORS mode (all these hosts allow it) so the cached copy is a normal, readable response
    const res = await fetch(request.url, { mode: "cors", credentials: "omit" });
    if (res.ok) {
      await cache.put(request.url, res.clone());
      trim(cache);
    }
    return res;
  })().catch(() => fetch(request)));
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}
