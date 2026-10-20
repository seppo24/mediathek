// Offline-Cache für die App selbst. Daten liegen in IndexedDB + Dropbox, nicht hier.
const CACHE = 'mediathek-v20';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  const cdn = /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!sameOrigin && !cdn) return; // APIs (Dropbox, KI, Buchdaten) nie cachen
  if (sameOrigin && (e.request.mode === 'navigate' || url.pathname.endsWith('.html'))) {
    // App-Seite: erst Netz (für Updates), sonst Cache
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); }
    return r;
  })));
});

// ---------- Briefkasten im Hintergrund prüfen (Periodic Background Sync, nur installierte App) ----------
const kv = (mode, fn) => new Promise(res => {
  const r = indexedDB.open('mediathek', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { try { const t = r.result.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => res(null); } catch { res(null); } };
  r.onerror = () => res(null);
});
async function checkMailbox() {
  const m = await kv('readonly', s => s.get('mbox')); if (!m || !m.key || !m.rt) return;
  const tr = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: m.rt, client_id: m.key }) });
  if (!tr.ok) return; const tok = (await tr.json()).access_token;
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/anfragen' }) });
  if (!r.ok) return;
  const names = ((await r.json()).entries || []).filter(e => e['.tag'] === 'file').map(e => e.name);
  const seen = (await kv('readonly', s => s.get('mboxSeen'))) || [];
  const fresh = names.filter(n => !seen.includes(n));
  if (fresh.length) {
    await self.registration.showNotification('📬 Neue Ausleih-Anfrage', { body: fresh.length === 1 ? 'Eine neue Anfrage wartet in der Mediathek.' : fresh.length + ' neue Anfragen warten in der Mediathek.', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'mediathek-anfrage', data: { url: './?aktion=anfragen' } });
    await kv('readwrite', s => s.put([...seen, ...fresh].slice(-300), 'mboxSeen'));
  }
  try { if (self.navigator.setAppBadge && names.length) await self.navigator.setAppBadge(names.length); } catch { }
}
self.addEventListener('periodicsync', e => { if (e.tag === 'mailbox') e.waitUntil(checkMailbox().catch(() => { })); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => 'focus' in x);
    if (c) return c.navigate(url).then(w => (w || c).focus()).catch(() => c.focus());
    return self.clients.openWindow(url);
  }));
});
