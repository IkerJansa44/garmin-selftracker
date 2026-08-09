import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deletePushSubscription: vi.fn(),
  fetchWebPushPublicKey: vi.fn(),
  savePushSubscription: vi.fn(),
}));

vi.mock("../../src/lib/api", () => api);

import { PushNotificationSettings } from "../../src/features/checkin/PushNotificationSettings";

const descriptors = {
  notification: Object.getOwnPropertyDescriptor(window, "Notification"),
  pushManager: Object.getOwnPropertyDescriptor(window, "PushManager"),
  serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"),
  standalone: Object.getOwnPropertyDescriptor(navigator, "standalone"),
};

function restoreProperty(target: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

describe("PushNotificationSettings", () => {
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
    api.fetchWebPushPublicKey.mockResolvedValue({ publicKey: "AQID" });
    api.savePushSubscription.mockResolvedValue({ subscribed: true, created: true });
    api.deletePushSubscription.mockResolvedValue({ subscribed: false, removed: true });
  });

  afterEach(() => {
    restoreProperty(window, "Notification", descriptors.notification);
    restoreProperty(window, "PushManager", descriptors.pushManager);
    restoreProperty(navigator, "serviceWorker", descriptors.serviceWorker);
    restoreProperty(navigator, "standalone", descriptors.standalone);
  });

  it("enables and stores a browser push subscription", async () => {
    const user = userEvent.setup();
    render(<PushNotificationSettings />);

    await user.click(await screen.findByRole("button", { name: "Enable push notifications" }));

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(api.savePushSubscription).toHaveBeenCalledWith({
      endpoint: browserSubscription.endpoint,
      expirationTime: null,
      keys: { p256dh: "device-public-key", auth: "device-auth-key" },
    });
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
  });

  it("removes and unsubscribes an existing subscription", async () => {
    getSubscription.mockResolvedValue(browserSubscription);
    const user = userEvent.setup();
    render(<PushNotificationSettings />);

    await user.click(await screen.findByRole("button", { name: "Disable push notifications" }));

    expect(api.savePushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: browserSubscription.endpoint }),
      expect.any(AbortSignal),
    );
    expect(api.deletePushSubscription).toHaveBeenCalledWith(browserSubscription.endpoint);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Enable push notifications" }),
      ).toBeInTheDocument(),
    );
  });

  it("directs iPhone Safari users to the Home Screen app", async () => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    render(<PushNotificationSettings />);

    expect(await screen.findByText("Home Screen required")).toBeInTheDocument();
    expect(api.fetchWebPushPublicKey).not.toHaveBeenCalled();
  });
});
