// Flip PDF service worker: makes the app work offline and receives PDFs from the phone's Share menu.
// Bump VERSION whenever app files change so installed copies refresh.
const VERSION = 'flippdf-v2';
const SHARED_CACHE = 'flippdf-shared';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'library.js',
  'db.js',
  'zip.js',
  'manifest.webmanifest',
  'vendor/page-flip.browser.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('flippdf-v') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A PDF shared to the installed app arrives as a POST; stash it, then open the app.
async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.get('pdf');
    if (file && typeof file === 'object' && 'size' in file) {
      const cache = await caches.open(SHARED_CACHE);
      await cache.put('shared-pdf', new Response(file, {
        headers: { 'x-name': encodeURIComponent(file.name || 'shared.pdf'), 'content-type': 'application/pdf' },
      }));
    }
  } catch (e) { /* fall through to a plain open */ }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Cache-first for instant/offline loads, refreshed in the background (stale-while-revalidate).
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
