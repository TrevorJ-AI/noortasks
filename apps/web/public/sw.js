// NoorTasks service worker: app shell cache, Web Push reminders and notification clicks.
// Never caches /api or /files (data lives in IndexedDB).
importScripts("./sw-notify.js");
const CACHE = "noortasks-shell-v2";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./index.html", "./icon.svg", "./manifest.webmanifest", "./sw-notify.js"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/files") || url.pathname.startsWith("/pub")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))),
  );
});

// RMD-034: a reminder pushed by the server. The payload is JSON (type, kind, title, taskId, projectId, fireAt, constant).
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: e.data ? e.data.text() : "NoorTasks" }; }
  const n = self.noorNotify.build(data);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) c.postMessage({ type: "noor-push", data });
      return self.registration.showNotification(n.title, n.options);
    }),
  );
});

// A click opens the task: focus an open NoorTasks window and route it, or open a new one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = self.noorNotify.target(data, self.registration.scope);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => c.url.split("#")[0] === url.split("#")[0]) || list[0];
      if (win) {
        win.postMessage({ type: "noor-open", hash: self.noorNotify.hashFor(data), data });
        return win.focus ? win.focus() : win;
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : null;
    }),
  );
});
