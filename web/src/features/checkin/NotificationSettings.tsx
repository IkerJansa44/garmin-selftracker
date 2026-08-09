import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

import {
  deletePushSubscription,
  fetchNotificationPreferences,
  fetchWebPushPublicKey,
  saveNotificationPreferences,
  savePushSubscription,
} from "../../lib/api";
import {
  decodeVapidPublicKey,
  needsIosHomeScreenInstall,
  serializePushSubscription,
  supportsPushNotifications,
} from "../../lib/pushNotifications";
import type { NotificationPreferences } from "../../lib/types";

type PushSetup = {
  registration: ServiceWorkerRegistration;
  subscription: PushSubscription | null;
  publicKey: string;
};

export function NotificationSettings() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [pushSetup, setPushSetup] = useState<PushSetup | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState("Loading notification preferences...");

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const loadedPreferences = await fetchNotificationPreferences(controller.signal);
        setPreferences(loadedPreferences);

        if (needsIosHomeScreenInstall()) {
          setMessage("Open Selftracker from its Home Screen icon to enable iPhone notifications.");
          return;
        }
        if (!supportsPushNotifications()) {
          setMessage("iPhone notifications are unavailable on this device.");
          return;
        }
        if (Notification.permission === "denied") {
          setMessage("iPhone notifications are blocked in iPhone Settings.");
          return;
        }

        const [registration, keyPayload] = await Promise.all([
          navigator.serviceWorker.ready,
          fetchWebPushPublicKey(controller.signal),
        ]);
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await savePushSubscription(serializePushSubscription(subscription), controller.signal);
        }
        setPushSetup({ registration, subscription, publicKey: keyPayload.publicKey });
        setMessage(
          subscription
            ? "This iPhone is ready to receive notifications."
            : "Select iPhone to allow notifications on this device.",
        );
      } catch (error) {
        if (!controller.signal.aborted) setMessage(errorMessage(error));
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  const updateEmail = async (email: boolean) => {
    if (!preferences) return;
    await persistPreferences({ ...preferences, email });
  };

  const updateIphone = async (iphone: boolean) => {
    if (!preferences) return;
    if (!pushSetup) {
      if (!iphone) await persistPreferences({ ...preferences, iphone: false });
      return;
    }
    setIsUpdating(true);
    try {
      let subscription = pushSetup.subscription;
      if (iphone) {
        subscription ??= await pushSetup.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidPublicKey(pushSetup.publicKey),
        });
        await savePushSubscription(serializePushSubscription(subscription));
      } else if (subscription) {
        await deletePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
        subscription = null;
      }
      const saved = await saveNotificationPreferences({ ...preferences, iphone });
      setPreferences(saved);
      setPushSetup({ ...pushSetup, subscription });
      setMessage(
        iphone
          ? "This iPhone is ready to receive notifications."
          : "iPhone notifications are turned off.",
      );
    } catch (error) {
      setMessage(
        Notification.permission === "denied"
          ? "Notifications are blocked. Open iPhone Settings → Notifications → Selftracker."
          : errorMessage(error),
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const persistPreferences = async (next: NotificationPreferences) => {
    setIsUpdating(true);
    try {
      setPreferences(await saveNotificationPreferences(next));
      setMessage("Notification preferences saved.");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <article className="rounded-[24px] bg-subsurface p-5">
      <div className="flex items-center gap-2">
        <Bell className="size-5 text-accent" aria-hidden="true" />
        <h3 className="text-lg font-semibold">Notifications</h3>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        Choose where check-in reminders and meaningful correlation alerts are delivered.
      </p>

      <fieldset className="mt-5 space-y-3" disabled={!preferences || isUpdating}>
        <NotificationChoice
          checked={preferences?.email ?? false}
          description="Send notifications to the configured email address."
          label="Email"
          onChange={updateEmail}
        />
        <NotificationChoice
          checked={preferences?.iphone ?? false}
          description="Show notifications through the Selftracker Home Screen app."
          disabled={!pushSetup && !(preferences?.iphone ?? false)}
          label="iPhone"
          onChange={updateIphone}
        />
      </fieldset>
      <p className="mt-4 text-sm text-muted" role="status">
        {message}
      </p>
    </article>
  );
}

function NotificationChoice({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => Promise<void>;
}) {
  return (
    <label className="flex min-h-14 items-center justify-between gap-4 rounded-2xl bg-panel px-4 py-3">
      <span>
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted">{description}</span>
      </span>
      <input
        checked={checked}
        className="size-5 accent-accent"
        disabled={disabled}
        type="checkbox"
        onChange={(event) => void onChange(event.target.checked)}
      />
    </label>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to update notification preferences.";
}
