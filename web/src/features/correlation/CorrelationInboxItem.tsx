import { ChevronRight, Trash2 } from "lucide-react";
import { useRef, type PointerEvent } from "react";
import type { CorrelationNotification } from "../../lib/api";

const AXIS_LOCK_DISTANCE = 8;
const HORIZONTAL_RATIO = 1.25;
const DISMISS_DISTANCE_RATIO = 0.3;
const FLING_MIN_DISTANCE = 22;
const FLING_MIN_VELOCITY = 0.45;
const SETTLE_DURATION_MS = 200;

export function CorrelationInboxItem({ notification, onOpen, onDismiss }: {
  notification: CorrelationNotification;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gestureRef = useRef<{
    id: number;
    x: number;
    y: number;
    startedAt: number;
    axis: "horizontal" | "vertical" | null;
    offset: number;
  } | null>(null);
  const ignoreClickRef = useRef(false);
  const settlingRef = useRef(false);

  const settle = async (offset: number, dismiss: boolean) => {
    const button = buttonRef.current;
    if (!button || settlingRef.current) return;
    settlingRef.current = true;
    const target = dismiss ? -button.clientWidth : 0;
    let animation: Animation | undefined;
    try {
      if (typeof button.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        animation = button.animate(
          [{ transform: `translate3d(${offset}px, 0, 0)` }, { transform: `translate3d(${target}px, 0, 0)` }],
          { duration: SETTLE_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
        );
        await animation.finished;
      }
      button.style.transform = `translate3d(${target}px, 0, 0)`;
      if (dismiss && button.isConnected) onDismiss();
    } catch {
      button.style.removeProperty("transform");
    } finally {
      animation?.cancel();
      button.style.removeProperty("will-change");
      settlingRef.current = false;
    }
  };

  const startSwipe = (event: PointerEvent<HTMLButtonElement>) => {
    if (settlingRef.current || event.pointerType !== "touch") return;
    if (gestureRef.current) {
      const previous = gestureRef.current;
      gestureRef.current = null;
      void settle(previous.offset, false);
      return;
    }
    ignoreClickRef.current = false;
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startedAt: performance.now(), axis: null, offset: 0 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveSwipe = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis && Math.hypot(dx, dy) >= AXIS_LOCK_DISTANCE) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO ? "horizontal" : "vertical";
    }
    if (gesture.axis !== "horizontal") return;
    ignoreClickRef.current = true;
    gesture.offset = Math.min(0, dx);
    event.currentTarget.style.willChange = "transform";
    event.currentTarget.style.transform = `translate3d(${gesture.offset}px, 0, 0)`;
  };

  const endSwipe = (event: PointerEvent<HTMLButtonElement>, canceled = false) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.axis !== "horizontal") return;
    const distance = Math.max(0, gesture.x - event.clientX);
    const velocity = distance / Math.max(16, performance.now() - gesture.startedAt);
    const dismiss = !canceled && (
      distance >= Math.max(FLING_MIN_DISTANCE, event.currentTarget.clientWidth * DISMISS_DISTANCE_RATIO)
      || (distance >= FLING_MIN_DISTANCE && velocity >= FLING_MIN_VELOCITY)
    );
    void settle(gesture.offset, dismiss);
  };

  return (
    <div className="relative overflow-hidden rounded-2xl bg-error" data-swipe-ignore>
      <span className="absolute inset-0 flex items-center justify-end gap-2 px-4 text-sm text-white" aria-hidden="true">
        <Trash2 className="size-4" /> Dismiss
      </span>
      <button
        ref={buttonRef}
        aria-label={`Review ${notification.predictorLabel} vs ${notification.outcomeLabel}`}
        aria-description="Swipe left or press Delete to remove from new correlations."
        className="focusable relative flex w-full touch-pan-y select-none items-center gap-3 rounded-2xl bg-panel p-4 text-left"
        type="button"
        onPointerDown={startSwipe}
        onPointerMove={moveSwipe}
        onPointerUp={(event) => endSwipe(event)}
        onPointerCancel={(event) => endSwipe(event, true)}
        onKeyDown={(event) => {
          if (event.key !== "Delete") return;
          event.preventDefault();
          onDismiss();
        }}
        onClick={(event) => {
          if (ignoreClickRef.current || settlingRef.current) {
            ignoreClickRef.current = false;
            event.preventDefault();
            return;
          }
          onOpen();
        }}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{notification.predictorLabel} ↔ {notification.outcomeLabel}</span>
          <span className="metric-number mt-1 block text-xs text-muted">
            r = {notification.correlation.toFixed(2)} · {notification.sampleCount} days
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-accent" aria-hidden="true" />
      </button>
    </div>
  );
}
