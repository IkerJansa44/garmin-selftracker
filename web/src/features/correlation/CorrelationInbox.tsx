import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { useState } from "react";
import type { CorrelationNotification } from "../../lib/api";

export function CorrelationInbox({
  notifications,
  onOpen,
}: {
  notifications: CorrelationNotification[];
  onOpen: (notification: CorrelationNotification) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!notifications.length) return null;

  return (
    <section
      aria-label="New correlations"
      className="overflow-hidden rounded-panel bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel-surface))]"
    >
      <button
        aria-controls="new-correlations-list"
        aria-expanded={expanded}
        className="focusable flex w-full items-center gap-3 p-4 text-left sm:p-5"
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-panel text-accent">
          <Inbox className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {notifications.length} new correlation{notifications.length === 1 ? "" : "s"}
          </span>
          <span className="block text-xs text-muted">
            {expanded ? "Open a correlation to review it" : "Ready to explore"}
          </span>
        </span>
        <ChevronDown className={`size-5 shrink-0 text-accent transition ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <div id="new-correlations-list" className="space-y-2 px-3 pb-3" hidden={!expanded}>
        <p className="px-2 pb-1 text-xs text-muted">Viewed items leave this queue.</p>
        {notifications.map((notification) => (
          <button
            key={notification.id}
            aria-label={`Review ${notification.predictorLabel} vs ${notification.outcomeLabel}`}
            className="focusable flex w-full items-center gap-3 rounded-2xl bg-panel p-4 text-left"
            type="button"
            onClick={() => {
              setExpanded(false);
              onOpen(notification);
            }}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">
                {notification.predictorLabel} ↔ {notification.outcomeLabel}
              </span>
              <span className="metric-number mt-1 block text-xs text-muted">
                r = {notification.correlation.toFixed(2)} · {notification.sampleCount} days
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-accent" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}
