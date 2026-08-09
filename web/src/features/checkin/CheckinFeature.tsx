import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DerivedMetricCard } from "../../components/DerivedMetricCard";
import { QuestionAnswerInput } from "../../components/QuestionAnswerInput";
import { CheckinPanel } from "./CheckinPanel";
import { SECTION_ORDER } from "../../lib/constants";
import { resolveCheckinDraftAnswers } from "../../lib/checkinDraft";
import { sleepMetricDateForPredictorDate } from "../../lib/dateAlignment";
import { DERIVED_GAP_METRICS } from "../../lib/derivedMetrics";
import { fetchCheckIns, saveCheckIn, saveCheckInDraft } from "../../lib/api";
import { defaultDraftAnswers, formatReadableDate } from "../../lib/mockData";
import { getVisibleChildren, pruneHiddenChildAnswers } from "../../lib/questions";
import {
  formatMinutesAsHours,
  formatSecondsAsHours,
  parseClockTimeToMinutes,
  timeToSleepGapMinutes,
} from "../../lib/time";
import {
  type CheckInDraft,
  type CheckInEntry,
  type CheckInQuestion,
  type CheckInQuestionChild,
  type DailyRecord,
} from "../../lib/types";

type Answers = Record<string, string | number | boolean>;
type DraftSaveState = "idle" | "saving" | "saved" | "error";

const SLEEP_TIME_QUESTION_ID = "sleep_time";
const DRAFT_SAVE_DELAY_MS = 500;
const TRANSITION_DISTANCE_PX = 24;
const EXIT_DURATION_MS = 100;
const ENTER_DURATION_MS = 160;

function formatIsoDateLocal(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function formatIsoDateWeekday(value: string): string | null {
  return parseIsoDate(value)?.toLocaleDateString(undefined, { weekday: "long" }) ?? null;
}

function formatIsoClockTimeLocal(value: string): string | null {
  const parsed = new Date(value.replace(/([+-]\d{2}:\d{2}|Z)$/, ""));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function visibleQuestionSections(questions: CheckInQuestion[]): Array<{
  name: string;
  questions: CheckInQuestion[];
}> {
  const grouped = new Map<string, CheckInQuestion[]>();
  for (const question of questions) {
    if (!question.defaultIncluded) continue;
    const section = question.section.trim() || "Custom";
    grouped.set(section, [...(grouped.get(section) ?? []), question]);
  }
  const orderedNames = [
    ...SECTION_ORDER.filter((section) => grouped.has(section)),
    ...Array.from(grouped.keys()).filter((section) => !SECTION_ORDER.includes(section)),
  ];
  return orderedNames.map((name) => ({ name, questions: grouped.get(name) ?? [] }));
}

function equalAnswers(left: Answers, right: Answers): boolean {
  const serialize = (answers: Answers) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))),
    );
  return serialize(left) === serialize(right);
}

export function useCheckinFeature({
  records,
  questions,
  onSaved,
}: {
  records: DailyRecord[];
  questions: CheckInQuestion[];
  onSaved: () => Promise<void>;
}) {
  const today = formatIsoDateLocal(new Date());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isTransitioningRef = useRef(false);
  const [selectedDate, setSelectedDate] = useState(today);
  const [entriesByDate, setEntriesByDate] = useState<Record<string, CheckInEntry>>({});
  const [draftsByDate, setDraftsByDate] = useState<Record<string, CheckInDraft>>({});
  const [answers, setAnswers] = useState<Answers>(() => defaultDraftAnswers(questions));
  const answersRef = useRef(answers);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [draftSaveDate, setDraftSaveDate] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const hydrationRef = useRef<{ date: string | null; loadVersion: number }>({
    date: null,
    loadVersion: -1,
  });
  const draftSaveTimeoutRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<{ date: string; answers: Answers } | null>(null);
  const draftSavePromisesRef = useRef(new Set<Promise<void>>());
  const firstAvailableDate = records[0]?.date;
  const lastAvailableDate = records.at(-1)?.date;

  const persistPendingDraft = useCallback(() => {
    const pending = pendingDraftRef.current;
    if (!pending) return;
    pendingDraftRef.current = null;
    draftSaveTimeoutRef.current = null;
    let failed = false;
    const promise = saveCheckInDraft(pending.date, pending.answers)
      .then(({ draft }) => {
        setDraftsByDate((previous) => ({ ...previous, [draft.date]: draft }));
      })
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        draftSavePromisesRef.current.delete(promise);
        if (draftSavePromisesRef.current.size || pendingDraftRef.current) return;
        setDraftSaveState(failed ? "error" : "saved");
      });
    draftSavePromisesRef.current.add(promise);
  }, []);

  const scheduleDraftSave = useCallback(
    (date: string, nextAnswers: Answers) => {
      if (pendingDraftRef.current?.date !== date) {
        if (draftSaveTimeoutRef.current !== null) {
          window.clearTimeout(draftSaveTimeoutRef.current);
        }
        persistPendingDraft();
      } else if (draftSaveTimeoutRef.current !== null) {
        window.clearTimeout(draftSaveTimeoutRef.current);
      }
      pendingDraftRef.current = { date, answers: nextAnswers };
      setDraftSaveDate(date);
      setDraftSaveState("saving");
      draftSaveTimeoutRef.current = window.setTimeout(
        persistPendingDraft,
        DRAFT_SAVE_DELAY_MS,
      );
    },
    [persistPendingDraft],
  );

  useEffect(() => {
    if (!firstAvailableDate) {
      setEntriesByDate({});
      setDraftsByDate({});
      return;
    }
    const lastDate = [lastAvailableDate, today].filter(Boolean).sort().at(-1);
    if (!lastDate) return;
    const controller = new AbortController();
    const load = async () => {
      setIsLoading(true);
      setSyncError(null);
      try {
        const payload = await fetchCheckIns(firstAvailableDate, lastDate, controller.signal);
        setEntriesByDate(Object.fromEntries(payload.entries.map((entry) => [entry.date, entry])));
        setDraftsByDate(Object.fromEntries(payload.drafts.map((draft) => [draft.date, draft])));
        setLoadVersion((previous) => previous + 1);
      } catch (error) {
        if (!controller.signal.aborted) {
          setSyncError(error instanceof Error ? error.message : "Failed to load check-ins.");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [firstAvailableDate, lastAvailableDate, today]);

  useEffect(() => {
    if (
      hydrationRef.current.date === selectedDate &&
      hydrationRef.current.loadVersion === loadVersion
    ) {
      return;
    }
    hydrationRef.current = { date: selectedDate, loadVersion };
    setDraftSaveState("idle");
    setDraftSaveDate(null);
    const nextAnswers = resolveCheckinDraftAnswers(
      selectedDate,
      questions,
      entriesByDate,
      draftsByDate,
    );
    answersRef.current = nextAnswers;
    setAnswers(nextAnswers);
  }, [draftsByDate, entriesByDate, loadVersion, questions, selectedDate]);

  useEffect(() => {
    const nextAnswers = pruneHiddenChildAnswers(questions, answersRef.current);
    answersRef.current = nextAnswers;
    setAnswers(nextAnswers);
  }, [questions]);

  const updateAnswer = useCallback(
    (fieldId: string, value: string | number | boolean) => {
      const nextAnswers = pruneHiddenChildAnswers(questions, {
        ...answersRef.current,
        [fieldId]: value,
      });
      answersRef.current = nextAnswers;
      setAnswers(nextAnswers);
      scheduleDraftSave(selectedDate, nextAnswers);
    },
    [questions, scheduleDraftSave, selectedDate],
  );

  const clearAnswer = useCallback(
    (fieldId: string) => {
      const nextAnswers = { ...answersRef.current };
      delete nextAnswers[fieldId];
      const prunedAnswers = pruneHiddenChildAnswers(questions, nextAnswers);
      answersRef.current = prunedAnswers;
      setAnswers(prunedAnswers);
      scheduleDraftSave(selectedDate, prunedAnswers);
    },
    [questions, scheduleDraftSave, selectedDate],
  );

  const save = async () => {
    if (draftSaveTimeoutRef.current !== null) {
      window.clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }
    pendingDraftRef.current = null;
    setIsSaving(true);
    setSaveMessage(null);
    setSyncError(null);
    try {
      await Promise.all(draftSavePromisesRef.current);
      const payload = await saveCheckIn(selectedDate, answersRef.current);
      setEntriesByDate((previous) => ({ ...previous, [payload.entry.date]: payload.entry }));
      setDraftsByDate((previous) => {
        const next = { ...previous };
        delete next[payload.entry.date];
        return next;
      });
      setDraftSaveState("idle");
      setDraftSaveDate(null);
      await onSaved();
      setSaveMessage(`Saved check-in for ${formatReadableDate(payload.entry.date)}.`);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Failed to save check-in.");
    } finally {
      setIsSaving(false);
    }
  };

  const stepDate = (delta: number): boolean => {
    const parsed = parseIsoDate(selectedDate);
    if (!parsed) return false;
    parsed.setDate(parsed.getDate() + delta);
    const nextDate = formatIsoDateLocal(parsed);
    if (nextDate > today) return false;
    setSelectedDate(nextDate);
    return true;
  };

  const animateDateStep = async (delta: number) => {
    if (isTransitioningRef.current) return;
    const panel = panelRef.current;
    if (
      !panel ||
      typeof panel.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      stepDate(delta);
      return;
    }
    isTransitioningRef.current = true;
    const exitOffset = -delta * TRANSITION_DISTANCE_PX;
    const enterOffset = delta * TRANSITION_DISTANCE_PX;
    let exitAnimation: Animation | null = null;
    let enterAnimation: Animation | null = null;
    let dateChanged = false;
    try {
      exitAnimation = panel.animate(
        [
          { transform: "translateX(0)", opacity: 1 },
          { transform: `translateX(${exitOffset}px)`, opacity: 0.72 },
        ],
        { duration: EXIT_DURATION_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
      );
      await exitAnimation.finished;
      dateChanged = stepDate(delta);
      if (!dateChanged) return;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      enterAnimation = panel.animate(
        [
          { transform: `translateX(${enterOffset}px)`, opacity: 0.72 },
          { transform: "translateX(0)", opacity: 1 },
        ],
        { duration: ENTER_DURATION_MS, easing: "cubic-bezier(0, 0, 0.2, 1)" },
      );
      exitAnimation.cancel();
      await enterAnimation.finished;
    } catch {
      if (!dateChanged) stepDate(delta);
    } finally {
      exitAnimation?.cancel();
      enterAnimation?.cancel();
      isTransitioningRef.current = false;
    }
  };

  const selectedRecord = useMemo(
    () => records.find((record) => record.date === selectedDate) ?? null,
    [records, selectedDate],
  );
  const selectedEntry = entriesByDate[selectedDate];
  const selectedDraft = draftsByDate[selectedDate];
  const savedAnswers = selectedEntry
    ? { ...defaultDraftAnswers(questions), ...selectedEntry.answers }
    : null;
  const isDirty = savedAnswers ? !equalAnswers(answers, savedAnswers) : false;
  const predictorSourceDate = selectedRecord?.date ?? selectedDate;
  const sleepDate = sleepMetricDateForPredictorDate(predictorSourceDate);
  const sleepRecord = records.find((record) => record.date === sleepDate) ?? null;
  const legacySleepTime =
    typeof answers[SLEEP_TIME_QUESTION_ID] === "string"
      ? String(answers[SLEEP_TIME_QUESTION_ID])
      : null;
  const fellAsleepTime =
    (sleepRecord?.fellAsleepAtIso
      ? formatIsoClockTimeLocal(sleepRecord.fellAsleepAtIso)
      : null) ??
    sleepRecord?.fellAsleepAt ??
    legacySleepTime;
  const wokeUpTime =
    (sleepRecord?.wokeUpAtIso
      ? formatIsoClockTimeLocal(sleepRecord.wokeUpAtIso)
      : null) ??
    sleepRecord?.wokeUpAt ??
    null;
  const activityLabel = !selectedRecord
    ? "--"
    : selectedRecord.importGap
      ? "Unknown"
      : selectedRecord.predictors.isTrainingDay
        ? "Activity detected"
        : "No activity logged";
  const derivedMetrics = DERIVED_GAP_METRICS.map((metric) => {
    const answer = answers[metric.questionId];
    const hasAnswer = typeof answer === "string" && parseClockTimeToMinutes(answer) !== null;
    const value = typeof answer === "string" && fellAsleepTime
      ? timeToSleepGapMinutes(answer, fellAsleepTime)
      : null;
    return {
      key: metric.key,
      label: metric.detailLabel,
      value: value === null ? "Unknown" : formatMinutesAsHours(value),
      helperText: !hasAnswer
        ? metric.missingAnswerHint
        : fellAsleepTime
          ? metric.computedHint
          : "Updates after Garmin records sleep start time for this date.",
    };
  });

  return {
    activityLabel,
    animateDateStep,
    answers,
    clearAnswer,
    derivedMetrics,
    draftSaveState: draftSaveDate === selectedDate ? draftSaveState : "idle",
    entriesByDate,
    fellAsleepTime,
    isDirty,
    isLoading,
    isSaving,
    panelRef,
    predictorSourceDate,
    questions: visibleQuestionSections(questions),
    save,
    saveMessage,
    selectedDate,
    selectedDraft,
    selectedEntry,
    selectedRecord,
    setEntriesByDate,
    setSelectedDate,
    sleepDuration: sleepRecord?.predictors.sleepSeconds ?? null,
    syncError,
    today,
    updateAnswer,
    weekday: formatIsoDateWeekday(selectedDate),
    wokeUpTime,
  };
}

export type CheckinController = ReturnType<typeof useCheckinFeature>;

export function CheckinFeature({ controller }: { controller: CheckinController }) {
  const renderInput = (question: CheckInQuestion | CheckInQuestionChild) => (
    <QuestionAnswerInput
      panelClassName="bg-subsurface"
      question={question}
      value={controller.answers[question.id]}
      onChange={(value) => controller.updateAnswer(question.id, value)}
      onClear={() => controller.clearAnswer(question.id)}
    />
  );

  return (
    <section className="gsap-fade">
      <CheckinPanel
        panelRef={controller.panelRef}
        isSaved={Boolean(controller.selectedEntry)}
        isDirty={controller.isDirty}
        onNext={
          controller.selectedDate < controller.today
            ? () => void controller.animateDateStep(1)
            : undefined
        }
        onPrevious={() => void controller.animateDateStep(-1)}
      >
        <div className="mb-6 flex items-end gap-8">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Daily Check-In</h2>
            <p className="mt-1 text-sm text-muted">Date-linked entries saved in SQLite.</p>
          </div>
          <div className="space-y-1 text-sm">
            <span className="block text-xs uppercase tracking-[0.14em] text-muted">Entry date</span>
            <div className="flex items-center gap-1">
              <button
                aria-label="Previous day"
                className="focusable flex min-h-11 w-9 items-center justify-center rounded-2xl bg-subsurface transition hover:bg-surface-hover"
                type="button"
                onClick={() => void controller.animateDateStep(-1)}
              >
                ‹
              </button>
              <input
                className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                max={controller.today}
                type="date"
                value={controller.selectedDate}
                onChange={(event) => controller.setSelectedDate(event.target.value)}
              />
              <button
                aria-label="Next day"
                className="focusable flex min-h-11 w-9 items-center justify-center rounded-2xl bg-subsurface transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                disabled={controller.selectedDate >= controller.today}
                type="button"
                onClick={() => void controller.animateDateStep(1)}
              >
                ›
              </button>
            </div>
          </div>
        </div>

        <div className="mb-4 rounded-2xl bg-subsurface px-4 py-3 text-sm">
          {controller.weekday && (
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
              {controller.weekday}
            </p>
          )}
          {(controller.isLoading ||
            controller.syncError ||
            controller.draftSaveState !== "idle" ||
            controller.selectedDraft ||
            (controller.selectedEntry && controller.isDirty)) && (
            <p className={clsx("text-muted", controller.weekday && "mt-1")}>
              {controller.isLoading
                ? "Loading check-ins..."
                : controller.syncError
                  ? `SQLite sync failed: ${controller.syncError}`
                  : controller.draftSaveState === "saving"
                    ? "Saving draft to SQLite..."
                    : controller.draftSaveState === "error"
                      ? "Draft could not be saved to SQLite."
                      : controller.selectedDraft || controller.draftSaveState === "saved"
                        ? "Draft saved to SQLite · not yet checked in."
                        : "Unsaved modifications."}
            </p>
          )}
          {controller.saveMessage && <p className="mt-1 text-success">{controller.saveMessage}</p>}
        </div>

        <div className="space-y-5">
          {controller.questions.map((section) => (
            <div key={section.name} className="rounded-[22px] bg-subsurface p-4">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                {section.name}
              </h3>
              <div className="grid items-start gap-4 md:grid-cols-2">
                {section.questions.map((question) => (
                  <div key={question.id} className="rounded-2xl bg-panel p-4 shadow-soft">
                    <p className="mb-1 text-sm font-medium">{question.prompt}</p>
                    {renderInput(question)}
                    {getVisibleChildren(question, controller.answers).map((child) => (
                      <div
                        key={child.id}
                        className="mt-4 border-t border-[rgba(18,18,18,0.08)] pt-4"
                      >
                        <p className="mb-3 text-sm font-medium">{child.prompt}</p>
                        {renderInput(child)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            className="focusable min-h-11 rounded-capsule bg-accent px-6 text-sm font-semibold text-white shadow-soft disabled:cursor-not-allowed disabled:opacity-65"
            disabled={controller.isSaving}
            type="button"
            onClick={() => void controller.save()}
          >
            {controller.isSaving ? "Saving..." : "Save Check-In"}
          </button>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Steps (Garmin)"
            value={controller.selectedRecord?.predictors.steps?.toLocaleString() ?? "--"}
            sourceDate={controller.predictorSourceDate}
          />
          <MetricCard
            label="Activity (Garmin)"
            value={controller.activityLabel}
            sourceDate={controller.predictorSourceDate}
          />
          <MetricCard
            label="Fell asleep at (Garmin)"
            value={controller.fellAsleepTime ?? "--:--"}
            sourceDate={controller.predictorSourceDate}
          />
          <MetricCard
            label="Woke up at (Garmin)"
            value={controller.wokeUpTime ?? "--:--"}
            sourceDate={controller.predictorSourceDate}
          />
          <MetricCard
            label="Sleep Duration (Garmin)"
            value={formatSecondsAsHours(controller.sleepDuration)}
            sourceDate={controller.predictorSourceDate}
          />
        </div>

        {controller.derivedMetrics.map((metric) => (
          <DerivedMetricCard
            key={metric.key}
            label={metric.label}
            value={metric.value}
            helperText={metric.helperText}
          />
        ))}
      </CheckinPanel>
    </section>
  );
}

function MetricCard({ label, value, sourceDate }: { label: string; value: string; sourceDate: string }) {
  return (
    <div className="rounded-[22px] bg-subsurface p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
      <p className="mt-2 text-sm text-muted">{label}</p>
      <p className="metric-number mt-1 text-2xl font-semibold text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">Source date: {sourceDate}</p>
    </div>
  );
}
