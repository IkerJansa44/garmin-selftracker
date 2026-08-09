const CACHE_NAME = "garmin-selftracker-v2";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(
              (name) => name.startsWith("garmin-selftracker-") && name !== CACHE_NAME,
            )
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  event.respondWith(networkFirst(event.request));
});

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event.data);
  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Garmin Selftracker", {
      body: payload.body ?? "Open Selftracker to see the latest update.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.tag ?? "selftracker-notification",
      data: { url: payload.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.url));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      const shell = await caches.match("/");
      if (shell) {
        return shell;
      }
    }
    throw error;
  }
}

function readPushPayload(data) {
  if (!data) return {};
  try {
    const payload = data.json();
    return payload && typeof payload === "object" ? payload : { body: String(payload) };
  } catch {
    return { body: data.text() };
  }
}

async function openNotificationTarget(rawUrl) {
  const target = new URL(rawUrl || "/", self.location.origin);
  const safeUrl = target.origin === self.location.origin ? target.href : self.location.origin;
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windowClients) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.navigate(safeUrl);
    return client.focus();
  }
  return self.clients.openWindow(safeUrl);
}
