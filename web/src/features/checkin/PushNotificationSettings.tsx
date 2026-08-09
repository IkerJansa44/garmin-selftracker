import clsx from "clsx";
import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";

import {
  deletePushSubscription,
  fetchWebPushPublicKey,
  savePushSubscription,
} from "../../lib/api";
import {
  decodeVapidPublicKey,
  needsIosHomeScreenInstall,
  serializePushSubscription,
  supportsPushNotifications,
} from "../../lib/pushNotifications";

type PushState =
  | "loading"
  | "unsupported"
  | "needs-install"
  | "blocked"
  | "disabled"
  | "enabled"
  | "error";

export function PushNotificationSettings() {
  const [state, setState] = useState<PushState>("loading");
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    if (needsIosHomeScreenInstall()) {
      setState("needs-install");
      return;
    }
    if (!supportsPushNotifications()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    const load = async () => {
      try {
        const [readyRegistration, keyPayload] = await Promise.all([
          navigator.serviceWorker.ready,
          fetchWebPushPublicKey(controller.signal),
        ]);
        const existingSubscription = await readyRegistration.pushManager.getSubscription();
        if (cancelled) return;
        setRegistration(readyRegistration);
        setPublicKey(keyPayload.publicKey);
        if (existingSubscription) {
          await savePushSubscription(
            serializePushSubscription(existingSubscription),
            controller.signal,
          );
        }
        if (cancelled) return;
        setSubscription(existingSubscription);
        setState(existingSubscription ? "enabled" : "disabled");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(messageFromError(loadError, "Failed to load notification settings."));
        setState("error");
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const enable = async () => {
    if (!registration || !publicKey) return;
    setIsUpdating(true);
    setError(null);
    let nextSubscription: PushSubscription | null = null;
    try {
      nextSubscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidPublicKey(publicKey),
        }));
      await savePushSubscription(serializePushSubscription(nextSubscription));
      setSubscription(nextSubscription);
      setState("enabled");
    } catch (enableError) {
      if (Notification.permission === "denied") {
        setState("blocked");
      } else {
        setError(messageFromError(enableError, "Failed to enable push notifications."));
        setState("error");
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const disable = async () => {
    if (!subscription) return;
    setIsUpdating(true);
    setError(null);
    try {
      await deletePushSubscription(subscription.endpoint);
      await subscription.unsubscribe();
      setSubscription(null);
      setState("disabled");
    } catch (disableError) {
      setError(messageFromError(disableError, "Failed to disable push notifications."));
      setState("error");
    } finally {
      setIsUpdating(false);
    }
  };

  const status = pushStatus(state, error);
  const enabled = subscription !== null;

  return (
    <article className="rounded-[24px] bg-subsurface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            {enabled ? (
              <Bell className="size-5 text-success" aria-hidden="true" />
            ) : (
              <BellOff className="size-5 text-muted" aria-hidden="true" />
            )}
            <h3 className="text-lg font-semibold">Push Notifications</h3>
          </div>
          <p
            className={clsx(
              "mt-2 text-sm leading-6",
              state === "error" || state === "blocked" ? "text-error" : "text-muted",
            )}
          >
            {status.message}
          </p>
        </div>
        <span
          className={clsx(
            "rounded-capsule px-3 py-2 text-xs font-semibold",
            enabled
              ? "text-success bg-[color-mix(in_srgb,var(--success)_14%,white)]"
              : "bg-panel text-muted",
          )}
        >
          {status.label}
        </span>
      </div>

      {(state === "enabled" || state === "disabled" || state === "error") && registration && (
        <button
          className={clsx(
            "focusable mt-5 min-h-11 rounded-capsule px-5 text-sm font-semibold shadow-soft transition disabled:cursor-wait disabled:opacity-60",
            enabled ? "bg-panel text-ink" : "bg-accent text-white",
          )}
          disabled={isUpdating}
          type="button"
          onClick={() => void (enabled ? disable() : enable())}
        >
          {isUpdating
            ? enabled
              ? "Disabling..."
              : "Enabling..."
            : enabled
              ? "Disable push notifications"
              : "Enable push notifications"}
        </button>
      )}
    </article>
  );
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function pushStatus(state: PushState, error: string | null) {
  switch (state) {
    case "loading":
      return { label: "Checking", message: "Checking this device’s notification status..." };
    case "unsupported":
      return {
        label: "Unavailable",
        message: "Push notifications are not supported by this browser or device.",
      };
    case "needs-install":
      return {
        label: "Home Screen required",
        message:
          "On iPhone, open Selftracker from its Home Screen icon before enabling notifications.",
      };
    case "blocked":
      return {
        label: "Blocked",
        message:
          "Notifications are blocked. Open iPhone Settings → Notifications → Selftracker to allow them.",
      };
    case "enabled":
      return {
        label: "Enabled",
        message: "This device is subscribed and can receive Selftracker notifications.",
      };
    case "error":
      return { label: "Needs attention", message: error ?? "Notification setup failed." };
    default:
      return {
        label: "Disabled",
        message: "Enable notifications to receive reminders when Selftracker is closed.",
      };
  }
}
