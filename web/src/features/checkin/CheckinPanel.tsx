import { type PointerEvent, type PropsWithChildren, type Ref, useRef } from "react";
import clsx from "clsx";

const SAVED_BACKGROUND_COLOR = "#edf5ef";
const SWIPE_THRESHOLD_PX = 60;
const HORIZONTAL_DOMINANCE_RATIO = 1.25;
const INTERACTIVE_SELECTOR = "a, button, input, select, textarea, [role='button'], [data-no-swipe]";

export function resolveSwipeDirection(deltaX: number, deltaY: number): "previous" | "next" | null {
  const horizontalDistance = Math.abs(deltaX);
  if (
    horizontalDistance < SWIPE_THRESHOLD_PX ||
    horizontalDistance <= Math.abs(deltaY) * HORIZONTAL_DOMINANCE_RATIO
  ) {
    return null;
  }
  return deltaX < 0 ? "next" : "previous";
}

export function CheckinPanel({
  children,
  isDirty,
  isSaved,
  onNext,
  onPrevious,
  panelRef,
}: PropsWithChildren<{
  isDirty: boolean;
  isSaved: boolean;
  onNext?: () => void;
  onPrevious?: () => void;
  panelRef?: Ref<HTMLDivElement>;
}>) {
  const showSavedState = isSaved && !isDirty;
  const pointerStartRef = useRef<{ id: number; x: number; y: number } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (
      event.pointerType !== "touch" ||
      (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR))
    ) {
      return;
    }
    pointerStartRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || start.id !== event.pointerId) return;
    const direction = resolveSwipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction === "previous") onPrevious?.();
    if (direction === "next") onNext?.();
  };

  return (
    <article
      aria-label="Daily Check-In"
      className={clsx(
        "panel touch-pan-y overflow-x-clip p-6 transition-colors duration-300 sm:p-8",
        showSavedState && "border border-[#d7e6dc]",
      )}
      style={showSavedState ? { backgroundColor: SAVED_BACKGROUND_COLOR } : undefined}
      data-swipe-ignore
      onPointerCancel={() => {
        pointerStartRef.current = null;
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <div ref={panelRef}>{children}</div>
    </article>
  );
}
