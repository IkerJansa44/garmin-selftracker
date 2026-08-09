import { type PushSubscriptionPayload } from "./api";

interface NavigatorWithStandalone extends Navigator {
  readonly standalone?: boolean;
}

export function supportsPushNotifications(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function needsIosHomeScreenInstall(): boolean {
  const iosNavigator = navigator as NavigatorWithStandalone;
  if (!("standalone" in iosNavigator)) return false;
  return (
    !iosNavigator.standalone &&
    !(window.matchMedia?.("(display-mode: standalone)").matches ?? false)
  );
}

export function decodeVapidPublicKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function serializePushSubscription(
  subscription: PushSubscription,
): PushSubscriptionPayload {
  const serialized = subscription.toJSON();
  const endpoint = serialized.endpoint;
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  return {
    endpoint,
    expirationTime: serialized.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}
