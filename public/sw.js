// NaNota — service worker: permite instalar como app e abrir as telas com internet fraca.
// Não intercepta /api (dados e login) nem arquivos de outros sites.
const CACHE = 'nanota-shell-v1';
const SHELL = ['/', '/index.html', '/ao-vivo.html', '/separar.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('nanota-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // telas: sempre a versão mais nova da internet; sem conexão, a última guardada
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(url.pathname === '/' ? '/' : url.pathname, c)); return r; })
      .catch(() => caches.match(url.pathname).then(m => m || caches.match('/'))));
    return;
  }
  // ícones e arquivos do site: usa o guardado e atualiza por trás
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(k => k.put(req, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
