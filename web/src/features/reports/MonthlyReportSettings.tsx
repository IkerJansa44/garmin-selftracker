import { appPath } from "../../lib/appPath";
import clsx from "clsx";
import { Download, FileText, LoaderCircle, Mail } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchMonthlyReportSettings,
  fetchMonthlyReportStatus,
  generateMonthlyReport,
  saveMonthlyReportSettings,
} from "../../lib/api";
import { type MonthlyReportSettings as Settings, type MonthlyReportStatus } from "../../lib/types";

const DEFAULT_SETTINGS: Settings = { enabled: false, sendAfter: "07:00" };
const SAVE_DELAY_MS = 350;

export function MonthlyReportSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<MonthlyReportStatus | null>(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [message, setMessage] = useState("Loading monthly reports...");
  const [isReady, setIsReady] = useState(false);
  const lastSavedRef = useRef(JSON.stringify(DEFAULT_SETTINGS));

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchMonthlyReportStatus(signal);
    setStatus(next);
    if (next.job.running) {
      setMessage(`Generating ${next.job.runningMonth}... Missing Garmin days are imported first.`);
    } else if (next.job.lastError) {
      setMessage(next.job.lastError);
    } else if (next.report?.warnings.length) {
      setMessage(`PDF ready with a warning: ${next.report.warnings[0]}`);
    } else {
      setMessage("Ready. Reports use dashboard metrics and the prior 90-day baseline.");
    }
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [nextSettings] = await Promise.all([
          fetchMonthlyReportSettings(controller.signal),
          loadStatus(controller.signal),
        ]);
        setSettings(nextSettings);
        lastSavedRef.current = JSON.stringify(nextSettings);
        setIsReady(true);
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Failed to load monthly reports.");
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [loadStatus]);

  useEffect(() => {
    if (!isReady || JSON.stringify(settings) === lastSavedRef.current) return;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      try {
        const saved = await saveMonthlyReportSettings(settings, controller.signal);
        lastSavedRef.current = JSON.stringify(saved);
        setMessage("Monthly report schedule saved.");
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Failed to save the schedule.");
        }
      }
    }, SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [isReady, settings]);

  useEffect(() => {
    if (!status?.job.running) return;
    const intervalId = window.setInterval(() => void loadStatus(), 2500);
    return () => window.clearInterval(intervalId);
  }, [loadStatus, status?.job.running]);

  const generate = async (sendEmail: boolean) => {
    setMessage(sendEmail ? "Starting report generation and email delivery..." : "Starting report preview...");
    try {
      await generateMonthlyReport(month, sendEmail);
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start report generation.");
    }
  };

  const isRunning = Boolean(status?.job.running);
  const codexReady = Boolean(status?.codex.authenticated);

  return (
    <article className="rounded-[24px] bg-subsurface p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Monthly PDF Report</h3>
          <p className={clsx("mt-1 text-sm", status?.job.lastError ? "text-error" : "text-muted")}>
            {message}
          </p>
        </div>
        <span className={clsx(
          "rounded-capsule px-3 py-2 text-xs font-semibold",
          codexReady ? "text-success bg-[color-mix(in_srgb,var(--success)_14%,white)]" : "text-warning bg-[color-mix(in_srgb,var(--warning)_14%,white)]",
        )}>
          {codexReady ? "Codex connected" : "Codex fallback active"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex items-center justify-between rounded-2xl bg-panel p-4 text-sm font-medium">
          Email automatically
          <input checked={settings.enabled} type="checkbox" onChange={(event) => setSettings((previous) => ({ ...previous, enabled: event.target.checked }))} />
        </label>
        <label className="rounded-2xl bg-panel p-4 text-sm">
          <span className="mb-2 block text-xs uppercase tracking-[0.14em] text-muted">First day, after</span>
          <input className="focusable h-11 w-full rounded-2xl bg-subsurface px-3" disabled={!settings.enabled} type="time" value={settings.sendAfter} onChange={(event) => setSettings((previous) => ({ ...previous, sendAfter: event.target.value }))} />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted">
        Covers the complete previous calendar month. If the app is offline on the first day, it sends the report when it next runs.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-2xl bg-panel p-4">
        <label className="min-w-44 flex-1 text-sm">
          <span className="mb-2 block text-xs uppercase tracking-[0.14em] text-muted">Report month</span>
          <input className="focusable h-11 w-full rounded-2xl bg-subsurface px-3" max={new Date().toISOString().slice(0, 7)} type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
        <button className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-sm font-semibold" disabled={isRunning} type="button" onClick={() => void generate(false)}>
          <span className="inline-flex items-center gap-2">{isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <FileText className="size-4" />} Generate PDF</span>
        </button>
        <button className="focusable min-h-11 rounded-capsule bg-accent px-4 text-sm font-semibold text-white" disabled={isRunning} type="button" onClick={() => void generate(true)}>
          <span className="inline-flex items-center gap-2"><Mail className="size-4" /> Generate & email</span>
        </button>
      </div>

      {status?.report && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-panel p-4 text-sm">
          <div>
            <p className="font-semibold">Latest: {status.report.month}</p>
            <p className="text-muted">{status.report.analysisSource === "codex" ? "Written with Codex" : "Deterministic fallback"}{status.report.emailedAt ? " · emailed" : " · PDF ready"}</p>
          </div>
          <a className="focusable inline-flex min-h-11 items-center gap-2 rounded-capsule bg-subsurface px-4 font-semibold" href={appPath(status.report.downloadUrl)} target="_blank" rel="noreferrer">
            <Download className="size-4" /> Open PDF
          </a>
        </div>
      )}

      {!codexReady && (
        <p className="mt-3 text-xs text-muted">
          The report remains fully usable with deterministic copy. To enable Codex in Docker, run <code>docker compose run --rm api codex login --device-auth</code> once.
        </p>
      )}
    </article>
  );
}
