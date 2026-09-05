const BASE_URL = new URL(self.registration.scope);
const CACHE_PREFIX = `garmin-selftracker:${BASE_URL.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
].map((path) => new URL(path.slice(1), BASE_URL).href);

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
              (name) => (name.startsWith(CACHE_PREFIX) ||
                (BASE_URL.pathname === "/" && name.startsWith("garmin-selftracker-"))) &&
              name !== CACHE_NAME,
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
    !url.pathname.startsWith(BASE_URL.pathname) ||
    url.pathname.startsWith(`${BASE_URL.pathname}api/`)
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
      icon: new URL("icons/icon-192.png", BASE_URL).href,
      badge: new URL("icons/icon-192.png", BASE_URL).href,
      tag: payload.tag ?? "selftracker-notification",
      data: { url: payload.url ?? BASE_URL.href },
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
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      const shell = await cache.match(BASE_URL.href);
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
  const target = new URL(rawUrl || BASE_URL.href, BASE_URL);
  const safeUrl = target.origin === BASE_URL.origin && target.pathname.startsWith(BASE_URL.pathname)
    ? target.href : BASE_URL.href;
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windowClients) {
    const clientUrl = new URL(client.url);
    if (clientUrl.origin !== BASE_URL.origin || !clientUrl.pathname.startsWith(BASE_URL.pathname)) continue;
    await client.navigate(safeUrl);
    return client.focus();
  }
  return self.clients.openWindow(safeUrl);
}
