// Service worker — enables "Add to Home Screen" / installable PWA.
// Strategy: network-first for HTML + config (updates always land), cache-first for immutable
// assets (icon, manifest). NEVER caches /api/* (the token-gated private feed) and only ever
// caches a fixed allowlist of public, same-origin, successful GET responses — so private data
// can never leak into the shared on-device cache even if a *.json is served at the top level.
const SHELL = 'sm-remote-shell-v4';
const ASSETS = ['/icon.svg', '/manifest.webmanifest'];
// the ONLY paths the SW will ever store:
const PUBLIC = new Set(['/', '/index.html', '/ops.html', '/entry.html', '/config.json', '/icon.svg', '/manifest.webmanifest']);
const cacheable = (req, res) =>
  res && res.ok && res.type === 'basic' && req.method === 'GET' && PUBLIC.has(new URL(req.url).pathname);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;            // live + private — never cached
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;        // never cache cross-origin

  const isFresh = e.request.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || url.pathname === '/'
    || url.pathname === '/config.json';

  if (isFresh) {
    // network-first: always try the network, fall back to cache offline
    e.respondWith(
      fetch(e.request).then((res) => {
        if (cacheable(e.request, res)) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {}); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // cache-first for static assets — only store successful, same-origin, allowlisted responses
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached || fetch(e.request).then((res) => {
        if (cacheable(e.request, res)) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {}); }
        return res;
      })
    )
  );
});
