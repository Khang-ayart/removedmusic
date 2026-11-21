// Service worker cho bản thử nghiệm.
// 1) Thêm header COOP/COEP để bật cross-origin isolation (WASM đa luồng / SharedArrayBuffer)
//    ngay cả trên GitHub Pages, nơi không đặt được header.
// 2) Cache vỏ ứng dụng + thư viện CDN để mở lại khi offline.
// 3) KHÔNG BAO GIỜ đụng tới cache model ("mrr-models-*"). Khi nâng VERSION, chỉ xoá các cache
//    có tiền tố "lab-app-" cũ.
const VERSION = 'v1';
const APP_CACHE = `lab-app-${VERSION}`;
const APP_PREFIX = 'lab-app-';
const SHELL = [
  './', './index.html', './lab.css', './lab.js', './worker.js', './config.js', './lib.js',
  './modelstore.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
];
const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'esm.sh'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(APP_CACHE);
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith(APP_PREFIX) && n !== APP_CACHE) // chỉ cache app cũ
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function withCOI(r) {
  if (!r || r.status === 0 || r.type === 'opaque' || r.type === 'opaqueredirect') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

async function shell(req) {
  const c = await caches.open(APP_CACHE);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return withCOI(r);
  } catch (err) {
    const m = await c.match(req, { ignoreSearch: true });
    if (m) return withCOI(m);
    throw err;
  }
}

async function runtime(req) {
  const c = await caches.open(APP_CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.type === 'cors') c.put(req, r.clone());
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(shell(req));
  else if (RUNTIME_HOSTS.includes(url.hostname)) e.respondWith(runtime(req));
  // Mọi thứ khác (đặc biệt là Hugging Face) đi thẳng ra mạng; model do modelstore.js quản lý.
});
