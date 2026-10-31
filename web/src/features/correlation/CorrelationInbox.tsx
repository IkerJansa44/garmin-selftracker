import { ChevronDown, Inbox, X } from "lucide-react";
import { useState } from "react";
import type { CorrelationNotification } from "../../lib/api";
import { CorrelationInboxItem } from "./CorrelationInboxItem";

export function CorrelationInbox({
  notifications,
  onOpen,
  onDismiss,
}: {
  notifications: CorrelationNotification[];
  onOpen: (notification: CorrelationNotification) => void;
  onDismiss: (notifications: CorrelationNotification[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!notifications.length) return null;

  return (
    <section
      aria-label="New correlations"
      className="overflow-hidden rounded-panel bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel-surface))]"
      data-swipe-ignore
    >
      <div className="flex items-center pr-2">
        <button
          aria-controls="new-correlations-list"
          aria-expanded={expanded}
          className="focusable flex min-w-0 flex-1 items-center gap-2 p-3 text-left sm:gap-3 sm:p-5"
          type="button"
          onClick={() => setExpanded((previous) => !previous)}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-2xl bg-panel text-accent sm:size-10">
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
          <ChevronDown className={`size-4 shrink-0 text-accent transition ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        <button
          aria-label="Clear all new correlations"
          className="focusable grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-panel"
          type="button"
          onClick={() => onDismiss(notifications)}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div id="new-correlations-list" className="space-y-2 px-3 pb-3" hidden={!expanded}>
        <p className="px-2 pb-1 text-xs text-muted">Open to review, or swipe left to dismiss.</p>
        {notifications.map((notification) => (
          <CorrelationInboxItem
            key={notification.id}
            notification={notification}
            onOpen={() => {
              setExpanded(false);
              onOpen(notification);
            }}
            onDismiss={() => onDismiss([notification])}
          />
        ))}
      </div>
    </section>
  );
}
