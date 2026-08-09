import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deletePushSubscription: vi.fn(),
  fetchNotificationPreferences: vi.fn(),
  fetchWebPushPublicKey: vi.fn(),
  saveNotificationPreferences: vi.fn(),
  savePushSubscription: vi.fn(),
}));

vi.mock("../../src/lib/api", () => api);

import { NotificationSettings } from "../../src/features/checkin/NotificationSettings";

const descriptors = {
  notification: Object.getOwnPropertyDescriptor(window, "Notification"),
  pushManager: Object.getOwnPropertyDescriptor(window, "PushManager"),
  serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"),
  standalone: Object.getOwnPropertyDescriptor(navigator, "standalone"),
};

function restoreProperty(target: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

describe("NotificationSettings", () => {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const browserSubscription = {
    endpoint: "https://web.push.apple.com/example",
    toJSON: () => ({
      endpoint: "https://web.push.apple.com/example",
      expirationTime: null,
      keys: { p256dh: "device-public-key", auth: "device-auth-key" },
    }),
    unsubscribe,
  } as unknown as PushSubscription;
  let getSubscription: ReturnType<typeof vi.fn>;
  let subscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getSubscription = vi.fn().mockResolvedValue(null);
    subscribe = vi.fn().mockResolvedValue(browserSubscription);
    const registration = { pushManager: { getSubscription, subscribe } };
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve(registration) },
    });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default" },
    });
    api.fetchNotificationPreferences.mockResolvedValue({ email: true, iphone: false });
    api.fetchWebPushPublicKey.mockResolvedValue({ publicKey: "AQID" });
    api.saveNotificationPreferences.mockImplementation(async (preferences) => preferences);
    api.savePushSubscription.mockResolvedValue({ subscribed: true, created: true });
    api.deletePushSubscription.mockResolvedValue({ subscribed: false, removed: true });
  });

  afterEach(() => {
    restoreProperty(window, "Notification", descriptors.notification);
    restoreProperty(window, "PushManager", descriptors.pushManager);
    restoreProperty(navigator, "serviceWorker", descriptors.serviceWorker);
    restoreProperty(navigator, "standalone", descriptors.standalone);
  });

  it("requests permission and stores the subscription when iPhone is selected", async () => {
    const user = userEvent.setup();
    render(<NotificationSettings />);

    await user.click(await screen.findByRole("checkbox", { name: /iPhone/i }));

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(api.savePushSubscription).toHaveBeenCalledWith({
      endpoint: browserSubscription.endpoint,
      expirationTime: null,
      keys: { p256dh: "device-public-key", auth: "device-auth-key" },
    });
    expect(api.saveNotificationPreferences).toHaveBeenCalledWith({ email: true, iphone: true });
    expect(await screen.findByText("This iPhone is ready to receive notifications.")).toBeVisible();
  });

  it("unsubscribes this device when iPhone is deselected", async () => {
    api.fetchNotificationPreferences.mockResolvedValue({ email: true, iphone: true });
    getSubscription.mockResolvedValue(browserSubscription);
    const user = userEvent.setup();
    render(<NotificationSettings />);

    await user.click(await screen.findByRole("checkbox", { name: /iPhone/i }));

    expect(api.deletePushSubscription).toHaveBeenCalledWith(browserSubscription.endpoint);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(api.saveNotificationPreferences).toHaveBeenCalledWith({ email: true, iphone: false });
  });

  it("saves email independently", async () => {
    const user = userEvent.setup();
    render(<NotificationSettings />);

    await user.click(await screen.findByRole("checkbox", { name: /Email/i }));

    expect(api.saveNotificationPreferences).toHaveBeenCalledWith({ email: false, iphone: false });
  });

  it("requires the iPhone Home Screen app only for the iPhone channel", async () => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    render(<NotificationSettings />);

    expect(await screen.findByRole("checkbox", { name: /Email/i })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /iPhone/i })).toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByText("Open Selftracker from its Home Screen icon to enable iPhone notifications."),
      ).toBeVisible(),
    );
  });
});
