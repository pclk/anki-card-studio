/* Anki Card Studio service worker: lets the installed app open without a connection.
 *  - the Studio page: network first, cached copy when offline
 *  - libraries from cdnjs / jsdelivr (pdf.js, sql.js, KaTeX…): cached, refreshed in the background
 *  - images of your projects (/api/project/…/media/…): network first, the copy from the last time it was shown when
 *    offline, so cards keep their pictures. The Studio deletes this cache when you sign out.
 *  - the rest of /api/*: never cached (card data comes from your account; the Studio keeps its own offline copy)
 */
const CACHE = "acs-v2";
const MEDIA = "acs-media";
const MEDIA_PATH = /^\/api\/project\/[^/]+\/media\/[^/]+$/;
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/manifest.webmanifest", "/icons/icon-192.png"]).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("acs-") && k !== CACHE && k !== MEDIA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Keep writes alive after the response is delivered; quota failures must not break requests.
  const keep = (work) => e.waitUntil(work.catch(() => {}));

  if (url.origin === location.origin) {
    if (MEDIA_PATH.test(url.pathname) && !url.search) {
      e.respondWith(
        fetch(req)
          .then((r) => {
            // a whole image (not a redirect to sign-in, not the index of a file sent in pieces)
            if (r.ok && r.status === 200 && r.type === "basic" && !r.redirected && r.headers.get("X-ACS-Chunked") !== "1") {
              const copy = r.clone(); keep(caches.open(MEDIA).then((c) => c.put(req, copy)));
            }
            return r;
          })
          .catch(() => caches.open(MEDIA).then((c) => c.match(req)).then((r) => r || Response.error())),
      );
      return;
    }
    if (url.pathname.startsWith("/api/")) return;
    if (req.mode === "navigate" && url.pathname === "/") {
      e.respondWith(
        fetch(req)
          .then((r) => {
            // only keep the real page (not a redirect to sign-in)
            if (r.ok && r.type === "basic" && !r.redirected) {
              const copy = r.clone(); // copy now, before the page starts reading the body
              keep(caches.open(CACHE).then((c) => c.put("/", copy)));
            }
            return r;
          })
          .catch(() => caches.match("/").then((r) => r || new Response("Offline, and the Studio isn't cached yet.", { status: 503 }))),
      );
      return;
    }
    if (/^\/(icons\/|manifest\.webmanifest)/.test(url.pathname)) {
      e.respondWith(caches.match(req).then((r) => r || fetch(req).then((n) => { const copy = n.clone(); keep(caches.open(CACHE).then((c) => c.put(req, copy))); return n; })));
    }
    return;
  }

  if (CDN.test(req.url)) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((n) => { if (n.ok || n.type === "opaque") keep(c.put(req, n.clone())); return n; }).catch(() => hit);
        keep(net);
        return hit || net;
      }),
    );
  }
});
