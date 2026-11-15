/* Anki Card Studio service worker: lets the installed app open without a connection.
 *  - the Studio page: network first, cached copy when offline
 *  - libraries from cdnjs / jsdelivr (pdf.js, sql.js, KaTeX…): cached, refreshed in the background
 *  - /api/*: never cached (card data always comes from your account)
 */
const CACHE = "acs-v2";
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/manifest.webmanifest", "/icons/icon-192.png"]).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (req.mode === "navigate" && url.pathname === "/") {
      e.respondWith(
        fetch(req)
          .then((r) => {
            // only keep the real page (not a redirect to sign-in)
            if (r.ok && r.type === "basic" && !r.redirected) {
              const copy = r.clone(); // copy now, before the page starts reading the body
              caches.open(CACHE).then((c) => c.put("/", copy));
            }
            return r;
          })
          .catch(() => caches.match("/").then((r) => r || new Response("Offline, and the Studio isn't cached yet.", { status: 503 }))),
      );
      return;
    }
    if (/^\/(icons\/|manifest\.webmanifest)/.test(url.pathname)) {
      e.respondWith(caches.match(req).then((r) => r || fetch(req).then((n) => { const copy = n.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return n; })));
    }
    return;
  }

  if (CDN.test(req.url)) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((n) => { if (n.ok || n.type === "opaque") c.put(req, n.clone()); return n; }).catch(() => hit);
        return hit || net;
      }),
    );
  }
});
