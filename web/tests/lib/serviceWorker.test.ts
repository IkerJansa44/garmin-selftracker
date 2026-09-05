import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("isolates Joan's cache, API traffic, and notification window", async () => {
  const listeners: Record<string, (event: any) => void> = {};
  const otherWindow = { url: "https://tracker/nil-garmin/", navigate: vi.fn() };
  const caches = {
    keys: async () => ["garmin-selftracker:/nil-garmin/:v2", "garmin-selftracker:/garmin-joan/:v2"],
    delete: vi.fn(),
  };
  const clients = { claim: vi.fn(), matchAll: async () => [otherWindow], openWindow: vi.fn() };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    URL, caches,
    self: {
      registration: { scope: "https://tracker/garmin-joan/" },
      location: { origin: "https://tracker" }, clients,
      addEventListener: (name: string, listener: (event: any) => void) => { listeners[name] = listener; },
    },
  });
  let pending: Promise<unknown>;
  const waitUntil = (promise: Promise<unknown>) => { pending = promise; };
  listeners.activate({ waitUntil });
  await pending!;
  expect(caches.delete.mock.calls).toEqual([["garmin-selftracker:/garmin-joan/:v2"]]);
  const respondWith = vi.fn();
  for (const path of ["/garmin-joan/api/checkins", "/nil-garmin/"]) {
    listeners.fetch({ request: { method: "GET", url: `https://tracker${path}` }, respondWith });
  }
  expect(respondWith).not.toHaveBeenCalled();
  listeners.notificationclick({ notification: { close: vi.fn(), data: { url: "/nil-garmin/" } }, waitUntil });
  await pending!;
  expect(otherWindow.navigate).not.toHaveBeenCalled();
  expect(clients.openWindow).toHaveBeenCalledWith("https://tracker/garmin-joan/");
});
