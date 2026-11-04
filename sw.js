// Keeps the heavy, never-changing files on the device after the first download:
// city photos (Unsplash CDN), the generated city scenes (their URLs carry a content hash), and the vendored web
// fonts and GSAP (assets/vendor/<name>-<version>/, so a new version is a new URL).
// The site's own page, scripts, styles and data go network first (so updates show up right away), with the last copy
// kept for when there is no connection: the home screen app then still opens, with the dates it last saw.
const CACHE = "confddl-media-v2";
const SHELL = "confddl-shell-v1";
const SHELL_MAX = 40;
const SHELL_WAIT = 4000; // a slow network falls back to the saved copy after this long
const MAX_ENTRIES = 120;
const CACHEABLE = /^https:\/\/(images\.unsplash\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\//;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  const own = url.origin === self.location.origin;
  const scene = own && ((url.pathname.includes("/assets/scenes/") && url.searchParams.has("v")) || url.pathname.includes("/assets/vendor/"));
  if (request.method !== "GET") return;
  if (own && !scene && (request.mode === "navigate" || /\.(js|css|json|webmanifest|png|svg|ics)$/.test(url.pathname))) {
    event.respondWith(shell(request, request.mode === "navigate"));
    return;
  }
  if (!(CACHEABLE.test(request.url) || scene)) return;
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

async function trim(cache, max = MAX_ENTRIES) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// network first; the page itself is saved under the site root, so any #c=… or ?hour=… link opens offline too
async function shell(request, page) {
  const cache = await caches.open(SHELL);
  const key = page ? new URL("./", self.registration.scope).href : request.url;
  const net = fetch(request).then(res => {
    if (res.ok && res.type === "basic") cache.put(key, res.clone()).then(() => trim(cache, SHELL_MAX));
    return res;
  });
  const saved = () => cache.match(key, { ignoreSearch: page });
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(no, SHELL_WAIT))]);
  } catch {
    return (await saved()) || net;
  }
}
