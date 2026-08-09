import { afterEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "../../src/pwa";

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
    return;
  }
  delete (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
});

describe("registerServiceWorker", () => {
  it("returns null when service workers are unavailable", async () => {
    delete (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }).serviceWorker;

    await expect(registerServiceWorker()).resolves.toBeNull();
  });

  it("registers the root service worker", async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });

    await expect(registerServiceWorker()).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });
});
