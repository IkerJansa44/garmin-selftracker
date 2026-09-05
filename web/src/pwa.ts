import { appPath } from "./lib/appPath";

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }

  return navigator.serviceWorker.register(appPath("sw.js"), { scope: import.meta.env.BASE_URL });
}
