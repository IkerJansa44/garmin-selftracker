import clsx from "clsx";
import { ChevronDown, ChevronUp } from "lucide-react";

import {
  formatMinutesAsClock,
  parseClockTimeToMinutes,
  stepClockMinutes,
  TIME_SLIDER_MINUTES,
  TIME_STEP_MINUTES,
} from "../lib/time";
import { type CheckInQuestion, type CheckInQuestionChild } from "../lib/types";

export type AnswerValue = string | number | boolean;

export function QuestionAnswerInput({
  panelClassName,
  question,
  value,
  onChange,
  onClear,
}: {
  panelClassName: string;
  question: CheckInQuestion | CheckInQuestionChild;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
  onClear?: () => void;
}) {
  if (question.inputType === "slider") {
    return (
      <div className="space-y-2">
        <input
          className="focusable h-11 w-full cursor-pointer accent-accent"
          min={question.min ?? 0}
          max={question.max ?? 10}
          step={question.step ?? 1}
          type="range"
          value={typeof value === "number" ? value : question.min ?? 0}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <div className="metric-number text-sm text-muted">{String(value ?? question.min ?? 0)}</div>
      </div>
    );
  }

  if (question.inputType === "multi-choice") {
    return (
      <div className="flex flex-wrap gap-2">
        {(question.options ?? []).map((option) => {
          const selected = value === option.id;
          return (
            <button
              key={option.id}
              className={clsx(
                "focusable min-h-11 rounded-capsule px-4 py-2 text-sm shadow-soft transition",
                selected ? "bg-accent text-white" : `${panelClassName} text-ink`,
              )}
              type="button"
              onClick={() => onChange(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (question.inputType === "boolean") {
    return (
      <div className="flex gap-3">
        {[true, false].map((candidate) => (
          <button
            key={String(candidate)}
            className={clsx(
              "focusable min-h-11 rounded-capsule px-5 py-2 text-sm shadow-soft transition",
              value === candidate ? "bg-accent text-white" : `${panelClassName} text-ink`,
            )}
            type="button"
            onClick={() => {
              if (value === candidate && onClear) {
                onClear();
                return;
              }
              onChange(candidate);
            }}
          >
            {candidate ? "Yes" : "No"}
          </button>
        ))}
      </div>
    );
  }

  if (question.inputType === "time") {
    const parsedMinutes = typeof value === "string" ? parseClockTimeToMinutes(value) : null;
    const sliderMinutes = parsedMinutes ?? TIME_SLIDER_MINUTES.min;
    const clockValue = parsedMinutes === null ? "--:--" : formatMinutesAsClock(parsedMinutes);
    const stepTime = (direction: -1 | 1) => {
      onChange(formatMinutesAsClock(stepClockMinutes(parsedMinutes, direction)));
    };
    return (
      <div className="space-y-2">
        <input
          className="focusable h-11 w-full cursor-pointer accent-accent"
          min={TIME_SLIDER_MINUTES.min}
          max={TIME_SLIDER_MINUTES.max}
          step={TIME_STEP_MINUTES}
          type="range"
          value={sliderMinutes}
          onChange={(event) => onChange(formatMinutesAsClock(Number(event.target.value)))}
        />
        <div className="flex items-center justify-between gap-3">
          <div className="metric-number text-sm text-muted">{clockValue}</div>
          <div className="flex gap-2">
            <button
              aria-label={`Move ${question.prompt} down ${TIME_STEP_MINUTES} minutes`}
              className={clsx(
                "focusable flex size-9 items-center justify-center rounded-2xl text-muted transition hover:bg-surface-hover hover:text-ink",
                panelClassName,
              )}
              type="button"
              onClick={() => stepTime(-1)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
            <button
              aria-label={`Move ${question.prompt} up ${TIME_STEP_MINUTES} minutes`}
              className={clsx(
                "focusable flex size-9 items-center justify-center rounded-2xl text-muted transition hover:bg-surface-hover hover:text-ink",
                panelClassName,
              )}
              type="button"
              onClick={() => stepTime(1)}
            >
              <ChevronUp className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <textarea
      className={clsx("focusable min-h-24 w-full rounded-2xl p-3", panelClassName)}
      placeholder="Optional note"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
