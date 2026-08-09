import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import {
  fetchCheckinReminderSettings,
  saveCheckinReminderSettings,
} from "../../lib/api";
import { type CheckinReminderSettings } from "../../lib/types";

const DEFAULT_SETTINGS: CheckinReminderSettings = {
  enabled: true,
  notifyAfter: "22:30",
};
const SAVE_DELAY_MS = 350;

function normalizeSettings(raw: unknown): CheckinReminderSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const settings = raw as Partial<CheckinReminderSettings>;
  if (
    typeof settings.enabled !== "boolean" ||
    typeof settings.notifyAfter !== "string" ||
    !/^([01]\d|2[0-3]):([0-5]\d)$/.test(settings.notifyAfter)
  ) {
    return DEFAULT_SETTINGS;
  }
  return {
    enabled: settings.enabled,
    notifyAfter: settings.notifyAfter,
  };
}

export function CheckinReminderSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const lastSavedRef = useRef(JSON.stringify(DEFAULT_SETTINGS));

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoadState("loading");
      setError(null);
      try {
        const next = normalizeSettings(await fetchCheckinReminderSettings(controller.signal));
        setSettings(next);
        lastSavedRef.current = JSON.stringify(next);
        setLoadState("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load check-in reminder settings from SQLite.",
        );
        setLoadState("error");
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (loadState !== "ready") return;
    const serialized = JSON.stringify(settings);
    if (serialized === lastSavedRef.current) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setIsSaving(true);
      setError(null);
      try {
        const next = normalizeSettings(
          await saveCheckinReminderSettings(settings, controller.signal),
        );
        setSettings(next);
        lastSavedRef.current = JSON.stringify(next);
      } catch (saveError) {
        if (controller.signal.aborted) return;
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Failed to save check-in reminder settings to SQLite.",
        );
      } finally {
        if (!controller.signal.aborted) setIsSaving(false);
      }
    }, SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [loadState, settings]);

  const status = loadState === "loading"
    ? "Loading from SQLite..."
    : isSaving
      ? "Saving to SQLite..."
      : error
        ? `SQLite sync failed: ${error}`
        : "Synced with SQLite.";

  return (
    <article className="rounded-[24px] bg-subsurface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Check-In Reminder</h3>
          <p className={clsx("mt-1 text-sm", error ? "text-error" : "text-muted")}>
            {status}
          </p>
        </div>
        <p
          className={clsx(
            "rounded-capsule px-3 py-2 text-xs font-semibold",
            settings.enabled
              ? "text-success bg-[color-mix(in_srgb,var(--success)_14%,white)]"
              : "text-muted bg-panel",
          )}
        >
          {settings.enabled
            ? `Active · reminder after ${settings.notifyAfter}`
            : "Inactive · reminder disabled"}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex items-center justify-between rounded-2xl bg-panel p-4 text-sm font-medium">
          Enable Check-In reminder
          <input
            checked={settings.enabled}
            type="checkbox"
            onChange={(event) =>
              setSettings((previous) => ({ ...previous, enabled: event.target.checked }))
            }
          />
        </label>
        <label className="min-w-0 space-y-2 overflow-hidden rounded-2xl bg-panel p-4 text-sm">
          <span className="block text-xs uppercase tracking-[0.14em] text-muted">
            Notify after
          </span>
          <input
            className="checkin-time-input focusable block h-11 w-full min-w-0 max-w-full appearance-none rounded-2xl bg-subsurface px-3 text-center disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!settings.enabled}
            step={60}
            type="time"
            value={settings.notifyAfter}
            onChange={(event) => {
              const notifyAfter = event.target.value;
              setSettings((previous) => ({
                ...previous,
                notifyAfter,
              }));
            }}
          />
        </label>
      </div>
    </article>
  );
}
