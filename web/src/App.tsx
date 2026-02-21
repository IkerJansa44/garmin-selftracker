import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import clsx from "clsx";
import {
  AlertCircle,
  CirclePlus,
  CircleHelp,
  GripVertical,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DEFAULT_QUESTIONS,
  METRICS,
  RANGE_PRESETS,
  SECTION_ORDER,
} from "./lib/constants";
import {
  defaultDraftAnswers,
  formatReadableDate,
  formatTime,
  mean,
} from "./lib/mockData";
import { mealToSleepGapMinutes, parseClockTimeToMinutes } from "./lib/time";
import {
  buildCorrelationResult,
  buildOutcomeOptions,
  buildPredictorOptions,
  getOptionLabel,
  type OutcomeKey,
  type PredictorKey,
} from "./lib/correlation";
import {
  getVisibleChildren,
  pruneHiddenChildAnswers,
} from "./lib/questions";
import {
  fetchCheckIns,
  fetchDashboardData,
  fetchQuestionSettings,
  saveCheckIn,
  saveQuestionSettings,
  startDateRangeImport,
  startRefreshImport,
} from "./lib/api";
import { usePersistentState } from "./lib/storage";
import {
  type CheckInQuestion,
  type CheckInQuestionChild,
  type CheckInEntry,
  type CoverageState,
  type ChildConditionOperator,
  type DailyRecord,
  type ImportState,
  type InputType,
  type MetricKey,
  type QuestionOption,
} from "./lib/types";

gsap.registerPlugin(ScrollTrigger);

type ViewKey = "dashboard" | "lab" | "checkin" | "settings";
type MetricDirection = "higher" | "lower";

const IMPORT_STATUS_LABELS: Record<ImportState, string> = {
  ok: "OK",
  running: "Running",
  failed: "Failed",
};

const COVERAGE_META: Record<CoverageState, { label: string; tone: string }> = {
  complete: {
    label: "Complete",
    tone: "text-success bg-[color-mix(in_srgb,var(--success)_12%,white)]",
  },
  partial: {
    label: "Partial",
    tone: "text-warning bg-[color-mix(in_srgb,var(--warning)_14%,white)]",
  },
  missing: {
    label: "Missing",
    tone: "text-error bg-[color-mix(in_srgb,var(--error)_14%,white)]",
  },
};

const DEFAULT_RANGE_PRESET = 7;
const TIME_STEP_MINUTES = 15;
const TIME_SLIDER_MINUTES = { min: 0, max: 23 * 60 + 45 };
const METRIC_DIRECTIONS: Record<MetricKey, MetricDirection> = {
  recoveryIndex: "higher",
  sleepScore: "higher",
  bodyBattery: "higher",
  trainingReadiness: "higher",
  stress: "lower",
  restingHr: "lower",
};

const EMPTY_METRICS: Record<MetricKey, number | null> = {
  recoveryIndex: null,
  sleepScore: null,
  restingHr: null,
  stress: null,
  bodyBattery: null,
  trainingReadiness: null,
};

const EMPTY_COVERAGE: Record<MetricKey, CoverageState> = {
  recoveryIndex: "missing",
  sleepScore: "missing",
  restingHr: "missing",
  stress: "missing",
  bodyBattery: "missing",
  trainingReadiness: "missing",
};

const GARMIN_ONLY_QUESTION_IDS = new Set(["training_intensity", "training_type"]);
const REMOVED_DEFAULT_QUESTION_IDS = new Set([
  "sleep_time",
  "screen_minutes",
  "thermal",
  "mood",
  "notes",
]);
const CAFFEINE_QUESTION_ID = "caffeine_count";
const CAFFEINE_LAST_TIME_CHILD_ID = "caffeine_last_time";
const ALCOHOL_QUESTION_ID = "alcohol_units";
const ALCOHOL_LAST_TIME_CHILD_ID = "alcohol_last_time";
const MEAL_FINISH_QUESTION_ID = "late_meal";
const SLEEP_TIME_QUESTION_ID = "sleep_time";
const FULLNESS_QUESTION_ID = "nutrition_fullness";
const ENERGY_TARGET_QUESTION_ID = "felt_energized_during_day";
const IMPORT_POLL_INTERVAL_MS = 5000;
const DASHBOARD_REFRESH_INTERVAL_MS = 60000;
const MAX_IMPORT_RANGE_DAYS = 365;

function parseImportProgressMessage(message: string): {
  completedDays: number;
  totalDays: number;
  etaLabel: string | null;
} | null {
  const segments = message
    .split("·")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const progressSegment = segments.find((segment) => /\d+\s*\/\s*\d+\s*days/i.test(segment));
  if (!progressSegment) {
    return null;
  }

  const progressMatch = progressSegment.match(/(\d+)\s*\/\s*(\d+)\s*days/i);
  if (!progressMatch) {
    return null;
  }

  const completedDays = Number(progressMatch[1]);
  const totalDays = Number(progressMatch[2]);
  if (!Number.isFinite(completedDays) || !Number.isFinite(totalDays) || totalDays <= 0) {
    return null;
  }

  const lastSegment = segments[segments.length - 1] ?? "";
  const etaLabel = lastSegment === progressSegment ? null : lastSegment;

  return { completedDays, totalDays, etaLabel };
}

function normalizeRangePreset(raw: unknown, fallback: number): number {
  if (typeof raw !== "number") {
    return fallback;
  }
  return RANGE_PRESETS.includes(raw as (typeof RANGE_PRESETS)[number]) ? raw : fallback;
}

function getMetricLabel(metric: MetricKey): string {
  return METRICS.find((definition) => definition.key === metric)?.label ?? metric;
}

function getMetricColor(metric: MetricKey): string {
  return METRICS.find((definition) => definition.key === metric)?.color ?? "#cc5833";
}

function formatMetricValue(metric: MetricKey, value: number | null): string {
  if (value === null) {
    return "--";
  }
  const definition = METRICS.find((entry) => entry.key === metric);
  if (!definition) {
    return String(value);
  }
  return `${value.toFixed(definition.decimals)} ${definition.unit}`;
}

function formatMetricDelta(metric: MetricKey, value: number): string {
  const definition = METRICS.find((entry) => entry.key === metric);
  if (!definition) {
    return Math.abs(value).toFixed(1);
  }
  const amount = Math.abs(value).toFixed(definition.decimals);
  return definition.unit ? `${amount} ${definition.unit}` : amount;
}

function describeTodayVsAverage(
  metric: MetricKey,
  delta: number | null,
  rangePreset: number,
): { text: string; tone: string } {
  if (delta === null || Number.isNaN(delta)) {
    return {
      text: `Not enough data to compare against the ${rangePreset}-day average.`,
      tone: "text-muted",
    };
  }
  if (delta === 0) {
    return { text: `Today is exactly at the ${rangePreset}-day average.`, tone: "text-muted" };
  }

  const aboveOrBelow = delta > 0 ? "above" : "below";
  const higherIsBetter = METRIC_DIRECTIONS[metric] === "higher";
  const better = (delta > 0 && higherIsBetter) || (delta < 0 && !higherIsBetter);

  return {
    text: `Today is ${aboveOrBelow} the ${rangePreset}-day average by ${formatMetricDelta(metric, delta)} (${better ? "better" : "worse"}).`,
    tone: better ? "text-success" : "text-error",
  };
}

function formatMinutesAsClock(minutes: number): string {
  const bounded = Math.min(TIME_SLIDER_MINUTES.max, Math.max(TIME_SLIDER_MINUTES.min, minutes));
  const hours = Math.floor(bounded / 60);
  const remainingMinutes = bounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}

function formatMinutesAsHours(minutes: number | null): string {
  if (minutes === null) {
    return "--";
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatIsoDateLocal(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map((entry) => Number(entry));
  const parsed = new Date(year, month - 1, day);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function rangeDaysInclusive(fromDate: string, toDate: string): number | null {
  const fromParsed = parseIsoDate(fromDate);
  const toParsed = parseIsoDate(toDate);
  if (!fromParsed || !toParsed) {
    return null;
  }
  return Math.floor((toParsed.getTime() - fromParsed.getTime()) / 86_400_000) + 1;
}

function inferAlcoholScore(option: QuestionOption): number | null {
  const normalized = option.id.trim().toLowerCase();
  if (normalized === "0") {
    return 0;
  }
  if (normalized === "1") {
    return 1;
  }
  if (normalized === "2") {
    return 2;
  }
  if (normalized === "3plus" || normalized === "3+") {
    return 3;
  }
  const labelNumber = Number(option.label);
  if (Number.isFinite(labelNumber)) {
    return labelNumber;
  }
  return null;
}

function cloneQuestion(question: CheckInQuestion): CheckInQuestion {
  return {
    ...question,
    options: question.options?.map((option) => ({ ...option })),
    children: question.children?.map((child) => ({
      ...child,
      options: child.options?.map((option) => ({ ...option })),
      condition: { ...child.condition },
    })),
  };
}

function migrateQuestionLibrary(questions: CheckInQuestion[]): CheckInQuestion[] {
  const nextQuestions = questions
    .filter((question) => !GARMIN_ONLY_QUESTION_IDS.has(question.id))
    .filter((question) => !REMOVED_DEFAULT_QUESTION_IDS.has(question.id))
    .map((question) => {
      const nextQuestion: CheckInQuestion = {
        ...question,
        analysisMode: question.analysisMode ?? "predictor_next_day",
      };

      if (nextQuestion.id === MEAL_FINISH_QUESTION_ID) {
        nextQuestion.section = "Nutrition & Substances";
        nextQuestion.prompt = "Finished eating at";
        nextQuestion.inputType = "time";
      }

      if (nextQuestion.id === CAFFEINE_QUESTION_ID) {
        nextQuestion.prompt =
          nextQuestion.prompt === "Caffeine (count)" ? "Caffeine" : nextQuestion.prompt;
        nextQuestion.inputLabel = nextQuestion.inputLabel ?? "Count";
        if (!nextQuestion.children?.length) {
          nextQuestion.children = [
            {
              id: CAFFEINE_LAST_TIME_CHILD_ID,
              prompt: "Last caffeine drink",
              inputType: "time",
              analysisMode: nextQuestion.analysisMode,
              condition: {
                operator: "greater_than",
                value: 0,
              },
            },
          ];
        }
      }

      if (nextQuestion.id === ALCOHOL_QUESTION_ID) {
        nextQuestion.prompt =
          nextQuestion.prompt === "Alcohol (count)" ? "Alcohol" : nextQuestion.prompt;
        nextQuestion.inputLabel = nextQuestion.inputLabel ?? "Count";
        const migratedOptions = (nextQuestion.options ?? []).map((option) => {
          if (typeof option.score === "number") {
            return option;
          }
          const inferredScore = inferAlcoholScore(option);
          return inferredScore === null ? option : { ...option, score: inferredScore };
        });
        nextQuestion.options = migratedOptions.length ? migratedOptions : [
          { id: "0", label: "0", score: 0 },
          { id: "1", label: "1", score: 1 },
          { id: "2", label: "2", score: 2 },
          { id: "3plus", label: "3+", score: 3 },
        ];
        if (!nextQuestion.children?.length) {
          nextQuestion.children = [
            {
              id: ALCOHOL_LAST_TIME_CHILD_ID,
              prompt: "Last alcohol drink",
              inputType: "time",
              analysisMode: nextQuestion.analysisMode,
              condition: {
                operator: "greater_than",
                value: 0,
              },
            },
          ];
        }
      }

      if (nextQuestion.id === FULLNESS_QUESTION_ID) {
        nextQuestion.section = "Nutrition & Substances";
        nextQuestion.prompt = "Do you feel full?";
        nextQuestion.inputType = "multi-choice";
        nextQuestion.analysisMode = "predictor_next_day";
        nextQuestion.options = [
          { id: "yes", label: "yes", score: 2 },
          { id: "normal", label: "normal", score: 1 },
          { id: "no", label: "no", score: 0 },
        ];
      }

      if (nextQuestion.id === ENERGY_TARGET_QUESTION_ID) {
        nextQuestion.section = "Stress & Mind";
        nextQuestion.prompt = "Felt energized during the day";
        nextQuestion.inputType = "multi-choice";
        nextQuestion.analysisMode = "target_same_day";
        nextQuestion.options = [
          { id: "yes", label: "yes", score: 2 },
          { id: "normal", label: "normal", score: 1 },
          { id: "no", label: "no", score: 0 },
        ];
      }

      return nextQuestion;
    });

  const seenQuestionIds = new Set(nextQuestions.map((question) => question.id));
  for (const defaultQuestion of DEFAULT_QUESTIONS) {
    if (seenQuestionIds.has(defaultQuestion.id)) {
      continue;
    }
    nextQuestions.push(cloneQuestion(defaultQuestion));
  }

  return nextQuestions;
}

function normalizeSectionName(section: string): string {
  const trimmed = section.trim();
  return trimmed || "General";
}

function sectionedQuestions(questions: CheckInQuestion[]): Record<string, CheckInQuestion[]> {
  return questions.reduce<Record<string, CheckInQuestion[]>>((accumulator, question) => {
    const section = normalizeSectionName(question.section);
    if (!accumulator[section]) {
      accumulator[section] = [];
    }
    accumulator[section].push(question);
    return accumulator;
  }, {});
}

function buildSectionList(questions: CheckInQuestion[]): string[] {
  const sectionsByQuestionOrder: string[] = [];
  const seen = new Set<string>();

  for (const question of questions) {
    const normalized = normalizeSectionName(question.section);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    sectionsByQuestionOrder.push(normalized);
  }

  const pinned = SECTION_ORDER.filter((section) => seen.has(section));
  const custom = sectionsByQuestionOrder.filter((section) => !SECTION_ORDER.includes(section));
  return [...pinned, ...custom];
}

function computeMetricSummary(records: DailyRecord[], metric: MetricKey, rangePreset: number): {
  todayValue: number | null;
  coverage: CoverageState;
  periodAverage: number | null;
  delta: number | null;
  sparklineData: Array<{ i: number; value: number | null }>;
} {
  if (!records.length) {
    return {
      todayValue: null,
      coverage: "missing",
      periodAverage: null,
      delta: null,
      sparklineData: Array.from({ length: rangePreset }, (_, index) => ({
        i: index,
        value: null,
      })),
    };
  }

  const today = records[records.length - 1];
  const todayValue = today.metrics[metric];
  const coverage = today.coverage[metric];

  const periodNumbers = records.map((record) => record.metrics[metric]).filter((value): value is number => value !== null);
  const periodAverage = periodNumbers.length ? mean(periodNumbers) : null;

  return {
    todayValue,
    coverage,
    periodAverage,
    delta: todayValue === null || periodAverage === null ? null : todayValue - periodAverage,
    sparklineData: records.map((record, index) => ({
      i: index,
      value: record.metrics[metric],
    })),
  };
}

function SparklineTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number }> }) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="rounded-2xl bg-panel px-3 py-2 text-xs shadow-soft">
      <span className="metric-number font-mono">{payload[0]?.value ?? "--"}</span>
    </div>
  );
}

function App() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);

  const [activeView, setActiveView] = useState<ViewKey>("dashboard");
  const [rangePreset, setRangePreset] = usePersistentState<number>(
    "ui.rangePreset",
    DEFAULT_RANGE_PRESET,
    normalizeRangePreset,
  );
  const [draftAnswers, setDraftAnswers] = usePersistentState<Record<string, string | number | boolean>>(
    "ui.checkinDraft",
    defaultDraftAnswers(),
  );
  const [isScrolled, setIsScrolled] = useState(false);
  const [questionLibrary, setQuestionLibrary] = useState<CheckInQuestion[]>(DEFAULT_QUESTIONS);
  const [selectedQuestionId, setSelectedQuestionId] = useState(DEFAULT_QUESTIONS[0]?.id ?? "");
  const [questionLoadState, setQuestionLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [questionSyncError, setQuestionSyncError] = useState<string | null>(null);
  const [isSavingQuestions, setIsSavingQuestions] = useState(false);
  const lastSavedQuestionsRef = useRef<string>("[]");
  const [allRecords, setAllRecords] = useState<DailyRecord[]>([]);
  const [checkinEntriesByDate, setCheckinEntriesByDate] = useState<Record<string, CheckInEntry>>({});
  const [checkinSyncError, setCheckinSyncError] = useState<string | null>(null);
  const [isSavingCheckin, setIsSavingCheckin] = useState(false);
  const [isLoadingCheckins, setIsLoadingCheckins] = useState(false);
  const [selectedCheckinDate, setSelectedCheckinDate] = useState(() => formatIsoDateLocal(new Date()));
  const [checkinSaveMessage, setCheckinSaveMessage] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{
    state: ImportState;
    lastImportAt: string | null;
    message: string;
  }>({
    state: "running",
    lastImportAt: null,
    message: "Daily import scheduled · 06:00 local",
  });
  const [dataStatus, setDataStatus] = useState<"loading" | "ready" | "error">("loading");
  const [dataError, setDataError] = useState<string | null>(null);
  const [predictorKey, setPredictorKey] = useState<PredictorKey>("garmin:steps");
  const [outcomeKey, setOutcomeKey] = useState<OutcomeKey>("metric:sleepScore");
  const [weekdayOnly, setWeekdayOnly] = useState(false);
  const [trainingOnly, setTrainingOnly] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [isImportSubmitting, setIsImportSubmitting] = useState(false);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const [activeImportRange, setActiveImportRange] = useState<{
    fromDate: string;
    toDate: string;
  } | null>(null);
  const [importFromDate, setImportFromDate] = useState(() => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    return formatIsoDateLocal(start);
  });
  const [importToDate, setImportToDate] = useState(() => formatIsoDateLocal(new Date()));

  const sensors = useSensors(useSensor(PointerSensor));

  const loadDashboardData = useCallback(
    async ({
      signal,
      setLoading = true,
    }: {
      signal?: AbortSignal;
      setLoading?: boolean;
    } = {}) => {
      if (setLoading) {
        setDataStatus("loading");
      }
      setDataError(null);
      try {
        const payload = await fetchDashboardData(365, signal);
        setAllRecords(payload.records);
        setImportSummary(payload.importStatus);
        setDataStatus("ready");
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load Garmin data from SQLite API.";
        setDataError(message);
        setDataStatus("error");
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboardData({ signal: controller.signal });
    return () => controller.abort();
  }, [loadDashboardData]);

  useEffect(() => {
    const controller = new AbortController();
    const intervalMs = importSummary.state === "running"
      ? IMPORT_POLL_INTERVAL_MS
      : DASHBOARD_REFRESH_INTERVAL_MS;
    const intervalId = window.setInterval(() => {
      void loadDashboardData({ signal: controller.signal, setLoading: false });
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
      controller.abort();
    };
  }, [importSummary.state, loadDashboardData]);

  useEffect(() => {
    if (importSummary.state === "running") {
      return;
    }
    setActiveImportRange(null);
  }, [importSummary.state]);

  useEffect(() => {
    if (!allRecords.length) {
      setCheckinEntriesByDate({});
      return;
    }
    const controller = new AbortController();
    const loadCheckins = async () => {
      const firstDate = allRecords[0]?.date;
      const lastDate = allRecords[allRecords.length - 1]?.date;
      if (!firstDate || !lastDate) {
        return;
      }
      const parsedFirstDate = parseIsoDate(firstDate);
      if (!parsedFirstDate) {
        return;
      }
      setIsLoadingCheckins(true);
      setCheckinSyncError(null);
      try {
        const fromDate = formatIsoDateLocal(
          new Date(parsedFirstDate.getTime() - 86_400_000),
        );
        const payload = await fetchCheckIns(fromDate, lastDate, controller.signal);
        setCheckinEntriesByDate(
          Object.fromEntries(payload.entries.map((entry) => [entry.date, entry])),
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load check-ins from SQLite.";
        setCheckinSyncError(message);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingCheckins(false);
        }
      }
    };
    void loadCheckins();
    return () => controller.abort();
  }, [allRecords]);

  useEffect(() => {
    const controller = new AbortController();

    const loadQuestions = async () => {
      setQuestionLoadState("loading");
      setQuestionSyncError(null);
      try {
        const payload = await fetchQuestionSettings(controller.signal);
        const sourceQuestions = payload.questions.length
          ? payload.questions
          : DEFAULT_QUESTIONS;
        const nextQuestions = migrateQuestionLibrary(sourceQuestions);
        const serializedSource = JSON.stringify(sourceQuestions);
        const serializedNext = JSON.stringify(nextQuestions);
        setQuestionLibrary(nextQuestions);
        setSelectedQuestionId(nextQuestions[0]?.id ?? "");
        lastSavedQuestionsRef.current =
          serializedSource === serializedNext ? serializedNext : serializedSource;
        setQuestionLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load question settings from SQLite.";
        setQuestionSyncError(message);
        setQuestionLoadState("error");
      }
    };

    void loadQuestions();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (questionLoadState !== "ready") {
      return;
    }

    const serializedQuestions = JSON.stringify(questionLibrary);
    if (serializedQuestions === lastSavedQuestionsRef.current) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      const syncQuestions = async () => {
        setIsSavingQuestions(true);
        setQuestionSyncError(null);
        try {
          const payload = await saveQuestionSettings(
            questionLibrary,
            controller.signal,
          );
          lastSavedQuestionsRef.current = JSON.stringify(payload.questions);
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Failed to save question settings to SQLite.";
          setQuestionSyncError(message);
        } finally {
          if (!controller.signal.aborted) {
            setIsSavingQuestions(false);
          }
        }
      };

      void syncQuestions();
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [questionLibrary, questionLoadState]);

  useEffect(() => {
    const defaults = defaultDraftAnswers(questionLibrary);
    const entry = checkinEntriesByDate[selectedCheckinDate];
    setDraftAnswers(entry ? { ...defaults, ...entry.answers } : defaults);
  }, [checkinEntriesByDate, questionLibrary, selectedCheckinDate, setDraftAnswers]);

  useEffect(() => {
    setDraftAnswers((previous) => pruneHiddenChildAnswers(questionLibrary, previous));
  }, [draftAnswers, questionLibrary, setDraftAnswers]);

  useEffect(() => {
    const context = gsap.context(() => {
      gsap.from(".gsap-fade", {
        y: 20,
        opacity: 0,
        duration: 0.45,
        ease: "power2.out",
        stagger: 0.05,
      });

      if (heroRef.current) {
        gsap.to(heroRef.current, {
          yPercent: -10,
          ease: "none",
          scrollTrigger: {
            trigger: heroRef.current,
            start: "top top",
            end: "bottom top",
            scrub: true,
          },
        });
      }
    }, appRef);

    return () => context.revert();
  }, [activeView]);

  useEffect(() => {
    const onScroll = () => {
      setIsScrolled(window.scrollY > 6);
    };

    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const predictorOptions = useMemo(() => buildPredictorOptions(questionLibrary), [questionLibrary]);
  const outcomeOptions = useMemo(() => buildOutcomeOptions(questionLibrary), [questionLibrary]);

  useEffect(() => {
    if (!predictorOptions.length || predictorOptions.some((option) => option.key === predictorKey)) {
      return;
    }
    setPredictorKey(predictorOptions[0].key as PredictorKey);
  }, [predictorKey, predictorOptions]);

  useEffect(() => {
    if (!outcomeOptions.length || outcomeOptions.some((option) => option.key === outcomeKey)) {
      return;
    }
    setOutcomeKey(outcomeOptions[0].key as OutcomeKey);
  }, [outcomeKey, outcomeOptions]);

  const fallbackTodayRecord = useMemo<DailyRecord>(
    () => ({
      date: new Date().toISOString().slice(0, 10),
      dayIndex: 0,
      weekday: new Date().getDay(),
      isTrainingDay: false,
      importGap: true,
      importState: importSummary.state,
      fellAsleepAt: null,
      predictors: {
        steps: null,
        calories: null,
        stressAvg: null,
        bodyBattery: null,
        sleepSeconds: null,
        isTrainingDay: false,
      },
      metrics: EMPTY_METRICS,
      coverage: EMPTY_COVERAGE,
    }),
    [importSummary.state],
  );
  const records = useMemo(() => allRecords.slice(-rangePreset), [allRecords, rangePreset]);
  const todayRecord = records[records.length - 1] ?? fallbackTodayRecord;

  const metricSummaries = useMemo(
    () =>
      METRICS.map((metric) => ({
        ...metric,
        ...computeMetricSummary(records, metric.key, rangePreset),
      })),
    [records, rangePreset],
  );

  const checkinsByDateMap = useMemo(
    () => new Map(Object.values(checkinEntriesByDate).map((entry) => [entry.date, entry])),
    [checkinEntriesByDate],
  );

  const correlationData = useMemo(() => {
    return buildCorrelationResult({
      records,
      checkinsByDate: checkinsByDateMap,
      questions: questionLibrary,
      predictor: predictorKey,
      outcome: outcomeKey,
      weekdayOnly,
      trainingOnly,
    });
  }, [
    checkinsByDateMap,
    outcomeKey,
    predictorKey,
    questionLibrary,
    records,
    trainingOnly,
    weekdayOnly,
  ]);

  const trendLineData = useMemo(() => {
    if (correlationData.points.length < 2) {
      return [];
    }
    const xs = correlationData.points.map((point) => point.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return [
      {
        x: minX,
        y: correlationData.regression.slope * minX + correlationData.regression.intercept,
      },
      {
        x: maxX,
        y: correlationData.regression.slope * maxX + correlationData.regression.intercept,
      },
    ];
  }, [correlationData]);

  const includedQuestions = useMemo(
    () => questionLibrary.filter((question) => question.defaultIncluded),
    [questionLibrary],
  );

  const groupedQuestions = useMemo(() => sectionedQuestions(includedQuestions), [includedQuestions]);
  const visibleSectionOrder = useMemo(
    () => buildSectionList(includedQuestions),
    [includedQuestions],
  );
  const editableSectionOptions = useMemo(
    () => buildSectionList(questionLibrary),
    [questionLibrary],
  );
  const selectedCheckinRecord = useMemo(
    () => allRecords.find((record) => record.date === selectedCheckinDate) ?? null,
    [allRecords, selectedCheckinDate],
  );
  const selectedCheckinEntry = checkinEntriesByDate[selectedCheckinDate];
  const isSelectedDateSaved = Boolean(selectedCheckinEntry);
  const selectedFellAsleepTime = useMemo(() => {
    if (selectedCheckinRecord?.fellAsleepAt) {
      return selectedCheckinRecord.fellAsleepAt;
    }
    const legacySleepTime = draftAnswers[SLEEP_TIME_QUESTION_ID];
    return typeof legacySleepTime === "string" && legacySleepTime ? legacySleepTime : null;
  }, [draftAnswers, selectedCheckinRecord]);
  const selectedSteps = selectedCheckinRecord?.predictors.steps ?? null;
  const selectedActivityLabel = useMemo(() => {
    if (!selectedCheckinRecord) {
      return "--";
    }
    if (selectedCheckinRecord.importGap) {
      return "Unknown";
    }
    return selectedCheckinRecord.predictors.isTrainingDay
      ? "Activity detected"
      : "No activity logged";
  }, [selectedCheckinRecord]);
  const hasMealTimeAnswer = useMemo(() => {
    const mealTime = draftAnswers[MEAL_FINISH_QUESTION_ID];
    return typeof mealTime === "string" && parseClockTimeToMinutes(mealTime) !== null;
  }, [draftAnswers]);

  const mealSleepGapValue = useMemo(() => {
    const mealTime = draftAnswers[MEAL_FINISH_QUESTION_ID];
    const sleepTime = selectedFellAsleepTime;
    if (typeof mealTime !== "string" || typeof sleepTime !== "string") {
      return null;
    }
    return mealToSleepGapMinutes(mealTime, sleepTime);
  }, [draftAnswers, selectedFellAsleepTime]);

  const todayDateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const lastImportLabel = importSummary.lastImportAt
    ? `${formatReadableDate(importSummary.lastImportAt.slice(0, 10))} ${formatTime(importSummary.lastImportAt)}`
    : "No completed import yet";
  const maxImportDate = formatIsoDateLocal(new Date());
  const runningImportProgress = useMemo(
    () =>
      importSummary.state === "running"
        ? parseImportProgressMessage(importSummary.message)
        : null,
    [importSummary.message, importSummary.state],
  );
  const runningImportProgressPercent = runningImportProgress
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round((runningImportProgress.completedDays / runningImportProgress.totalDays) * 100),
        ),
      )
    : 0;
  const runningImportEtaLabel = runningImportProgress?.etaLabel ?? "calculating...";
  const runningImportRange = activeImportRange;

  const validateImportRange = (fromDate: string, toDate: string): string | null => {
    const fromParsed = parseIsoDate(fromDate);
    const toParsed = parseIsoDate(toDate);
    if (!fromParsed || !toParsed) {
      return "Dates must use YYYY-MM-DD format.";
    }
    if (fromParsed.getTime() > toParsed.getTime()) {
      return "From date must be on or before to date.";
    }
    const todayParsed = parseIsoDate(maxImportDate);
    if (!todayParsed) {
      return "Unable to validate current date.";
    }
    if (toParsed.getTime() > todayParsed.getTime()) {
      return "To date cannot be in the future.";
    }
    const days = rangeDaysInclusive(fromDate, toDate);
    if (!days) {
      return "Date range is invalid.";
    }
    if (days > MAX_IMPORT_RANGE_DAYS) {
      return `Date range cannot exceed ${MAX_IMPORT_RANGE_DAYS} days.`;
    }
    return null;
  };

  const handleRefreshImport = async () => {
    setIsImportSubmitting(true);
    setImportFeedback(null);
    try {
      const response = await startRefreshImport();
      setActiveImportRange({
        fromDate: response.fromDate,
        toDate: response.toDate,
      });
      await loadDashboardData({ setLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to trigger refresh import.";
      setImportFeedback(message);
    } finally {
      setIsImportSubmitting(false);
    }
  };

  const handleDateImport = async () => {
    const validationError = validateImportRange(importFromDate, importToDate);
    if (validationError) {
      setImportFeedback(validationError);
      return;
    }
    setIsImportSubmitting(true);
    setImportFeedback(null);
    try {
      const response = await startDateRangeImport(importFromDate, importToDate);
      setActiveImportRange({
        fromDate: response.fromDate,
        toDate: response.toDate,
      });
      setShowImportModal(false);
      await loadDashboardData({ setLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to trigger date range import.";
      setImportFeedback(message);
    } finally {
      setIsImportSubmitting(false);
    }
  };

  const handleQuickSave = async () => {
    setIsSavingCheckin(true);
    setCheckinSaveMessage(null);
    setCheckinSyncError(null);
    try {
      const payload = await saveCheckIn(selectedCheckinDate, draftAnswers);
      setCheckinEntriesByDate((previous) => ({
        ...previous,
        [payload.entry.date]: payload.entry,
      }));
      setCheckinSaveMessage(`Saved check-in for ${formatReadableDate(payload.entry.date)}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save check-in to SQLite.";
      setCheckinSyncError(message);
    } finally {
      setIsSavingCheckin(false);
    }
  };

  const handleAddQuestion = () => {
    const id = `question_${Date.now()}`;
    const question: CheckInQuestion = {
      id,
      section: "Recovery",
      prompt: "New question",
      inputType: "text",
      analysisMode: "predictor_next_day",
      defaultIncluded: true,
    };
    setQuestionLibrary((previous) => [...previous, question]);
    setSelectedQuestionId(id);
  };

  const updateQuestion = (questionId: string, patch: Partial<CheckInQuestion>) => {
    setQuestionLibrary((previous) =>
      previous.map((question) => (question.id === questionId ? { ...question, ...patch } : question)),
    );
  };

  const renameQuestionSection = (source: string, target: string) => {
    const sourceSection = normalizeSectionName(source);
    const targetSection = normalizeSectionName(target);
    if (sourceSection === targetSection) {
      return;
    }
    setQuestionLibrary((previous) =>
      previous.map((question) =>
        normalizeSectionName(question.section) === sourceSection
          ? { ...question, section: targetSection }
          : question,
      ),
    );
  };

  const removeQuestion = (questionId: string) => {
    setQuestionLibrary((previous) => {
      const next = previous.filter((question) => question.id !== questionId);
      if (selectedQuestionId === questionId) {
        setSelectedQuestionId(next[0]?.id ?? "");
      }
      return next;
    });
  };

  const handleQuestionSortEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    setQuestionLibrary((previous) => {
      const oldIndex = previous.findIndex((question) => question.id === active.id);
      const newIndex = previous.findIndex((question) => question.id === over.id);
      return arrayMove(previous, oldIndex, newIndex);
    });
  };

  const topViewButtons: Array<{ key: ViewKey; label: string }> = [
    { key: "dashboard", label: "Dashboard" },
    { key: "lab", label: "Correlation" },
    { key: "checkin", label: "Check-In" },
    { key: "settings", label: "Settings" },
  ];

  const updateDraftAnswer = useCallback(
    (fieldId: string, nextValue: string | number | boolean) => {
      setDraftAnswers((previous) =>
        pruneHiddenChildAnswers(questionLibrary, { ...previous, [fieldId]: nextValue }),
      );
    },
    [questionLibrary, setDraftAnswers],
  );

  const renderQuestionInput = (question: CheckInQuestion | CheckInQuestionChild) => {
    const value = draftAnswers[question.id];

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
            onChange={(event) => updateDraftAnswer(question.id, Number(event.target.value))}
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
                  selected ? "bg-accent text-white" : "bg-subsurface text-ink",
                )}
                type="button"
                onClick={() => updateDraftAnswer(question.id, option.id)}
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
                value === candidate ? "bg-accent text-white" : "bg-subsurface text-ink",
              )}
              type="button"
              onClick={() => {
                if (value === candidate) {
                  setDraftAnswers((previous) => {
                    const nextAnswers = { ...previous };
                    delete nextAnswers[question.id];
                    return pruneHiddenChildAnswers(questionLibrary, nextAnswers);
                  });
                  return;
                }
                updateDraftAnswer(question.id, candidate);
              }}
            >
              {candidate ? "Yes" : "No"}
            </button>
          ))}
        </div>
      );
    }

    if (question.inputType === "time") {
      const parsedMinutes =
        typeof value === "string" ? parseClockTimeToMinutes(value) : null;
      const sliderMinutes = parsedMinutes ?? TIME_SLIDER_MINUTES.min;
      const clockValue = parsedMinutes === null ? "--:--" : formatMinutesAsClock(parsedMinutes);
      return (
        <div className="space-y-2">
          <input
            className="focusable h-11 w-full cursor-pointer accent-accent"
            min={TIME_SLIDER_MINUTES.min}
            max={TIME_SLIDER_MINUTES.max}
            step={TIME_STEP_MINUTES}
            type="range"
            value={sliderMinutes}
            onChange={(event) => {
              const minutes = Number(event.target.value);
              updateDraftAnswer(question.id, formatMinutesAsClock(minutes));
            }}
          />
          <div className="metric-number text-sm text-muted">{clockValue}</div>
        </div>
      );
    }

    return (
      <textarea
        className="focusable min-h-24 w-full rounded-2xl bg-subsurface p-3"
        placeholder="Optional note"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => updateDraftAnswer(question.id, event.target.value)}
      />
    );
  };

  return (
    <div ref={appRef} className="min-h-screen px-4 pb-10 pt-32 text-ink sm:px-6 lg:px-9">
      <header
        className={clsx(
          "fixed inset-x-3 top-4 z-50 rounded-[32px] bg-[rgba(255,255,255,0.78)] p-3 shadow-soft transition lg:inset-x-7",
          isScrolled && "backdrop-blur-md",
        )}
      >
        <div className="overflow-x-auto">
          <div className="flex min-w-max items-center gap-3 whitespace-nowrap">
            <div className="panel gsap-fade flex min-h-16 shrink-0 items-center gap-5 px-4 py-2 whitespace-nowrap">
              <div className="shrink-0">
                <p className="text-sm text-muted">Garmin Selftracker</p>
                <p className="text-lg font-semibold tracking-tight">{todayDateLabel}</p>
              </div>
              <div
                aria-hidden="true"
                className="h-10 w-px shrink-0 bg-[rgba(18,18,18,0.14)]"
              />
              <div className="max-w-[360px] shrink-0 whitespace-normal">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Import</p>
                {importSummary.state === "running" && runningImportProgress && runningImportRange ? (
                  <>
                    <p className="text-sm font-semibold leading-snug">
                      Importing from {runningImportRange.fromDate} to {runningImportRange.toDate} ETA{" "}
                      {runningImportEtaLabel}
                    </p>
                    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-capsule bg-subsurface">
                      <div
                        className="h-full rounded-capsule bg-[color-mix(in_srgb,var(--warning)_76%,white)] transition-[width] duration-500"
                        style={{ width: `${runningImportProgressPercent}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm font-semibold">{importSummary.message}</p>
                )}
                <p className="metric-number text-xs text-muted">
                  Last import {lastImportLabel}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div
                  className={clsx(
                    "rounded-capsule px-3 py-2 text-sm font-semibold",
                    importSummary.state === "ok" && "bg-[color-mix(in_srgb,var(--success)_14%,white)] text-success",
                    importSummary.state === "running" && "bg-[color-mix(in_srgb,var(--warning)_16%,white)] text-warning",
                    importSummary.state === "failed" && "bg-[color-mix(in_srgb,var(--error)_16%,white)] text-error",
                  )}
                >
                  {IMPORT_STATUS_LABELS[importSummary.state]}
                </div>
                <button
                  className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold shadow-soft transition disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isImportSubmitting}
                  type="button"
                  onClick={() => void handleRefreshImport()}
                >
                  {isImportSubmitting ? (
                    <span className="inline-flex items-center gap-2">
                      <LoaderCircle className="size-4 animate-spin" />
                      Importing
                    </span>
                  ) : (
                    "Refresh import"
                  )}
                </button>
                <button
                  className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold shadow-soft transition disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isImportSubmitting}
                  type="button"
                  onClick={() => setShowImportModal(true)}
                >
                  Import dates
                </button>
              </div>
              {importFeedback && <p className="text-sm font-medium text-error">{importFeedback}</p>}
            </div>
            <div
              aria-hidden="true"
              className="h-10 w-px shrink-0 bg-[rgba(18,18,18,0.14)]"
            />

            <div className="panel gsap-fade flex min-h-16 shrink-0 items-center px-4 py-2 whitespace-nowrap">
              <div className="flex flex-nowrap items-center gap-2">
                {topViewButtons.map((button) => (
                  <button
                    key={button.key}
                    className={clsx(
                      "focusable min-h-11 rounded-capsule px-4 text-sm font-semibold shadow-soft transition",
                      activeView === button.key ? "bg-accent text-white" : "bg-panel text-ink",
                    )}
                    type="button"
                    onClick={() => setActiveView(button.key)}
                  >
                    {button.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-8">
        {dataStatus !== "ready" && (
          <div
            className={clsx(
              "gsap-fade rounded-[22px] px-4 py-3 text-sm shadow-soft",
              dataStatus === "error"
                ? "bg-[color-mix(in_srgb,var(--error)_16%,white)] text-error"
                : "bg-[color-mix(in_srgb,var(--warning)_14%,white)] text-warning",
            )}
          >
            {dataStatus === "loading"
              ? "Loading Garmin data from SQLite..."
              : `Unable to load Garmin data from API. ${dataError ?? ""}`}
          </div>
        )}

        {activeView === "dashboard" && (
          <section ref={heroRef} className="panel gsap-fade overflow-hidden p-7 sm:p-10">
            <div className="min-h-[42vh] rounded-[30px] bg-[radial-gradient(circle_at_0%_5%,#ffffff_0%,#f8f6f1_40%,#efede6_100%)] p-8 shadow-inset">
              <p className="text-sm text-muted">{rangePreset}-Day Dashboard</p>
              <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                <h1 className="text-4xl font-semibold tracking-tight xl:text-5xl">Dashboard</h1>
                <div className="flex justify-self-center gap-2 rounded-capsule bg-subsurface p-1">
                  {RANGE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      className={clsx(
                        "focusable min-h-11 rounded-capsule px-4 text-sm font-semibold transition",
                        rangePreset === preset ? "bg-accent text-white" : "text-muted hover:text-ink",
                      )}
                      type="button"
                      onClick={() => setRangePreset(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <p className="justify-self-end text-right text-base text-muted lg:text-lg">
                  Today vs rolling {rangePreset}-day average.
                </p>
              </div>
              <p className="mt-3 text-sm text-muted">
                Higher is better for Recovery Index, Sleep Score, Body Battery, and Training Readiness.
                Lower is better for Stress and Resting HR.
              </p>

              <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {metricSummaries.map((summary) => {
                  const coverageMeta = COVERAGE_META[summary.coverage];
                  const isMissing = summary.coverage === "missing";
                  const isPartial = summary.coverage === "partial";
                  const loadingState = todayRecord.importState === "running" && summary.coverage !== "complete";
                  const errorState =
                    (todayRecord.importState === "failed" || dataStatus === "error") && isMissing;
                  const comparison = describeTodayVsAverage(summary.key, summary.delta, rangePreset);

                  return (
                    <article key={summary.key} className="rounded-[24px] bg-panel p-5 shadow-soft">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm text-muted">{summary.label}</p>
                          <p className="metric-number mt-2 text-3xl font-semibold tracking-tight">
                            {formatMetricValue(summary.key, summary.todayValue)}
                          </p>
                          <p className="metric-number mt-1 text-xs text-muted">
                            {rangePreset}d average {formatMetricValue(summary.key, summary.periodAverage)}
                          </p>
                          <p className={clsx("mt-1 text-xs font-medium", comparison.tone)}>{comparison.text}</p>
                        </div>
                        <span className={clsx("rounded-capsule px-3 py-1 text-xs font-semibold", coverageMeta.tone)}>
                          {coverageMeta.label}
                        </span>
                      </div>

                      <div className="mt-4 h-16">
                        <ResponsiveContainer>
                          <ComposedChart data={summary.sparklineData}>
                            {summary.periodAverage !== null && (
                              <ReferenceLine
                                ifOverflow="extendDomain"
                                stroke="rgba(18,18,18,0.45)"
                                strokeDasharray="4 4"
                                strokeWidth={1}
                                y={summary.periodAverage}
                              />
                            )}
                            <Line
                              dataKey="value"
                              dot={false}
                              stroke={summary.color}
                              strokeWidth={2}
                              type="monotone"
                            />
                            <Tooltip content={<SparklineTooltip />} />
                          </ComposedChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="mt-3 min-h-8 text-xs text-muted">
                        {loadingState ? (
                          <span className="inline-flex items-center gap-2 text-warning">
                            <LoaderCircle className="size-3 animate-spin" /> Import in progress. This tile will
                            update when sync completes.
                          </span>
                        ) : errorState ? (
                          <span className="inline-flex items-center gap-2 text-error">
                            <AlertCircle className="size-3" />
                            {dataStatus === "error"
                              ? "Unable to load data API."
                              : "No data yet. Last import failed."}
                            <button
                              className="focusable rounded-capsule bg-[color-mix(in_srgb,var(--error)_14%,white)] px-2 py-1 text-[11px]"
                              type="button"
                              onClick={() => setActiveView("settings")}
                            >
                              Open status
                            </button>
                          </span>
                        ) : isPartial ? (
                          <span>Partial telemetry. {rangePreset}-day average uses available samples only.</span>
                        ) : (
                          <span>{summary.baselineHint}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {activeView === "lab" && (
          <section className="panel gsap-fade grid gap-5 p-6 sm:grid-cols-[340px_1fr] sm:p-8">
            <aside className="space-y-4 rounded-[24px] bg-subsurface p-4">
              <h2 className="text-xl font-semibold tracking-tight">Correlation Lab</h2>
              <p className="text-sm text-muted">
                Predictors are aligned to the previous day. Outcomes use the selected day.
              </p>
              <label className="space-y-2 text-sm">
                <span className="block text-xs uppercase tracking-[0.16em] text-muted">Predictor (X)</span>
                <select
                  className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                  value={predictorKey}
                  onChange={(event) => setPredictorKey(event.target.value as PredictorKey)}
                >
                  {predictorOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm">
                <span className="block text-xs uppercase tracking-[0.16em] text-muted">Outcome (Y)</span>
                <select
                  className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                  value={outcomeKey}
                  onChange={(event) => setOutcomeKey(event.target.value as OutcomeKey)}
                >
                  {outcomeOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <p className="rounded-2xl bg-panel p-3 text-xs text-muted">
                Questions marked as target variables are outcomes only and stay on the same day.
              </p>
              <label className="flex items-center justify-between rounded-2xl bg-panel p-3 text-sm">
                Weekdays only
                <input
                  checked={weekdayOnly}
                  type="checkbox"
                  onChange={(event) => setWeekdayOnly(event.target.checked)}
                />
              </label>
              <label className="flex items-center justify-between rounded-2xl bg-panel p-3 text-sm">
                Training days only
                <input
                  checked={trainingOnly}
                  type="checkbox"
                  onChange={(event) => setTrainingOnly(event.target.checked)}
                />
              </label>
            </aside>

            <article className="rounded-[24px] bg-panel p-5 shadow-soft">
              <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">
                    {getOptionLabel(predictorOptions, predictorKey, predictorKey)} vs {getOptionLabel(outcomeOptions, outcomeKey, outcomeKey)}
                  </h3>
                  <p className="metric-number text-sm text-muted">
                    r = {correlationData.correlation.toFixed(2)} · N={correlationData.sampleCount}
                  </p>
                </div>
                {correlationData.sampleCount < 20 && (
                  <p className="rounded-capsule bg-[color-mix(in_srgb,var(--warning)_16%,white)] px-3 py-2 text-sm text-warning">
                    Low sample size (N={correlationData.sampleCount}). Interpret cautiously.
                  </p>
                )}
              </header>

              <div className="h-[420px]">
                <ResponsiveContainer>
                  <ScatterChart>
                    <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="3 6" />
                    <XAxis
                      dataKey="x"
                      name={getOptionLabel(predictorOptions, predictorKey, predictorKey)}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      dataKey="y"
                      name={getOptionLabel(outcomeOptions, outcomeKey, outcomeKey)}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      cursor={{ strokeDasharray: "3 4" }}
                      formatter={(value: number, key) => [`${value.toFixed(1)}`, key]}
                      labelFormatter={(label, payload) => {
                        const date = payload?.[0]?.payload?.date;
                        return date ? formatReadableDate(date) : String(label);
                      }}
                    />
                    <Scatter data={correlationData.points} fill={getMetricColor("sleepScore")} />
                    <Scatter
                      data={trendLineData}
                      fill="transparent"
                      line={{ stroke: "#CC5833", strokeWidth: 2 }}
                      shape={() => null}
                      legendType="none"
                      name="Trend"
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>
        )}

        {activeView === "checkin" && (
          <section className="gsap-fade">
            <article
              className={clsx(
                "panel p-6 transition-colors duration-300 sm:p-8",
                isSelectedDateSaved && "border border-[#d7e6dc]",
              )}
              style={
                isSelectedDateSaved
                  ? { backgroundColor: "#edf5ef" }
                  : undefined
              }
            >
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">Daily Check-In</h2>
                  <p className="mt-1 text-sm text-muted">Date-linked entries saved in SQLite.</p>
                </div>
                <label className="space-y-1 text-sm">
                  <span className="block text-xs uppercase tracking-[0.14em] text-muted">Entry date</span>
                  <input
                    className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                    max={maxImportDate}
                    type="date"
                    value={selectedCheckinDate}
                    onChange={(event) => setSelectedCheckinDate(event.target.value)}
                  />
                </label>
              </div>
              <div className="mb-4 rounded-2xl bg-subsurface px-4 py-3 text-sm">
                <p className="text-muted">
                  {isLoadingCheckins
                    ? "Loading check-ins..."
                    : checkinSyncError
                      ? `SQLite sync failed: ${checkinSyncError}`
                      : selectedCheckinEntry
                        ? "Loaded existing entry for this date."
                        : "No saved entry for this date yet."}
                </p>
                {checkinSaveMessage && <p className="mt-1 text-success">{checkinSaveMessage}</p>}
              </div>

              <div className="space-y-5">
                {visibleSectionOrder.map((section) => {
                  const questions = groupedQuestions[section];
                  if (!questions?.length) {
                    return null;
                  }
                  return (
                    <div key={section} className="rounded-[22px] bg-subsurface p-4">
                      <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.16em] text-muted">{section}</h3>
                      <div className="grid items-start gap-4 md:grid-cols-2">
                        {questions.map((question) => (
                          <div key={question.id} className="rounded-2xl bg-panel p-4 shadow-soft">
                            <p className="mb-1 text-sm font-medium">{question.prompt}</p>
                            {question.inputLabel && (
                              <p className="mb-3 text-xs uppercase tracking-[0.16em] text-muted">
                                {question.inputLabel}
                              </p>
                            )}
                            {renderQuestionInput(question)}
                            {getVisibleChildren(question, draftAnswers).map((child) => (
                              <div key={child.id} className="mt-4 border-t border-[rgba(18,18,18,0.08)] pt-4">
                                <p className="mb-3 text-sm font-medium">{child.prompt}</p>
                                {renderQuestionInput(child)}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Steps (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {selectedSteps === null ? "--" : selectedSteps.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Activity (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {selectedActivityLabel}
                  </p>
                </div>
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Fell asleep at (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {selectedFellAsleepTime ?? "--:--"}
                  </p>
                </div>
              </div>

              <div className="mt-5 rounded-[22px] bg-subsurface p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-muted">Derived Metric</p>
                <p className="mt-2 text-sm text-muted">Time Between Eating And Sleep</p>
                <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                  {mealSleepGapValue === null ? "Unknown" : formatMinutesAsHours(mealSleepGapValue)}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {!hasMealTimeAnswer
                    ? "Add 'Finished eating at' to calculate this metric."
                    : selectedFellAsleepTime
                    ? "Computed from check-in meal time and Garmin sleep start."
                    : "Updates after Garmin records sleep start time for this date."}
                </p>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  className="focusable min-h-11 rounded-capsule bg-accent px-6 text-sm font-semibold text-white shadow-soft disabled:cursor-not-allowed disabled:opacity-65"
                  disabled={isSavingCheckin}
                  type="button"
                  onClick={() => void handleQuickSave()}
                >
                  {isSavingCheckin ? "Saving..." : "Save Check-In"}
                </button>
              </div>
            </article>
          </section>
        )}

        {activeView === "settings" && (
          <section className="panel gsap-fade p-6 sm:p-8">
            <article className="rounded-[24px] bg-subsurface p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">Asked Questions</h3>
                  <p
                    className={clsx(
                      "mt-1 text-sm",
                      questionSyncError ? "text-error" : "text-muted",
                    )}
                  >
                    {questionLoadState === "loading"
                      ? "Loading from SQLite..."
                      : isSavingQuestions
                        ? "Saving to SQLite..."
                        : questionSyncError
                          ? `SQLite sync failed: ${questionSyncError}`
                          : "Synced with SQLite."}
                  </p>
                </div>
                <button
                  className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm shadow-soft"
                  type="button"
                  onClick={handleAddQuestion}
                >
                  <span className="inline-flex items-center gap-2">
                    <CirclePlus className="size-4" /> Add
                  </span>
                </button>
              </div>

              <DndContext sensors={sensors} onDragEnd={handleQuestionSortEnd}>
                <SortableContext
                  items={questionLibrary.map((question) => question.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {questionLibrary.map((question) => {
                      const isSelected = question.id === selectedQuestionId;
                      return (
                        <div key={question.id}>
                          <SortableQuestionItem
                            isSelected={isSelected}
                            question={question}
                            onSelect={() =>
                              setSelectedQuestionId((previous) =>
                                previous === question.id ? "" : question.id,
                              )
                            }
                          />
                          {isSelected && (
                            <QuestionEditor
                              availableSections={editableSectionOptions}
                              onRenameSection={renameQuestionSection}
                              question={question}
                              onDelete={() => removeQuestion(question.id)}
                              onPatch={(patch) => updateQuestion(question.id, patch)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </article>
          </section>
        )}
      </main>

      {showImportModal && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(18,18,18,0.2)] p-4 backdrop-blur-xs">
          <div className="panel w-full max-w-lg p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Import Date Range</h2>
              <button
                className="focusable min-h-11 rounded-capsule bg-subsurface px-3"
                disabled={isImportSubmitting}
                type="button"
                onClick={() => setShowImportModal(false)}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="font-medium text-muted">From date</span>
                <input
                  className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3"
                  max={maxImportDate}
                  type="date"
                  value={importFromDate}
                  onChange={(event) => setImportFromDate(event.target.value)}
                />
              </label>
              <label className="space-y-2 text-sm">
                <span className="font-medium text-muted">To date</span>
                <input
                  className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3"
                  max={maxImportDate}
                  type="date"
                  value={importToDate}
                  onChange={(event) => setImportToDate(event.target.value)}
                />
              </label>
            </div>
            <p className="mt-3 text-sm text-muted">
              Maximum range: {MAX_IMPORT_RANGE_DAYS} days.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isImportSubmitting}
                type="button"
                onClick={() => setShowImportModal(false)}
              >
                Cancel
              </button>
              <button
                className="focusable min-h-11 rounded-capsule bg-accent px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isImportSubmitting}
                type="button"
                onClick={() => void handleDateImport()}
              >
                {isImportSubmitting ? "Starting..." : "Start import"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function SortableQuestionItem({
  question,
  isSelected,
  onSelect,
}: {
  question: CheckInQuestion;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: question.id });

  return (
    <button
      ref={setNodeRef}
      className={clsx(
        "focusable flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left shadow-soft transition",
        isSelected ? "bg-accent text-white" : "bg-subsurface text-ink",
      )}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      type="button"
      onClick={onSelect}
    >
      <span>
        <span className="block text-sm font-semibold">{question.prompt}</span>
        <span className="block text-xs opacity-70">{question.inputType}</span>
      </span>
      <span className="inline-flex items-center gap-2" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </span>
    </button>
  );
}

const CONDITION_OPERATOR_META: Array<{
  value: ChildConditionOperator;
  label: string;
  requiresValue: boolean;
}> = [
  { value: "equals", label: "equals", requiresValue: true },
  { value: "not_equals", label: "not equals", requiresValue: true },
  { value: "greater_than", label: "greater than", requiresValue: true },
  { value: "at_least", label: "at least", requiresValue: true },
  { value: "non_empty", label: "non-empty", requiresValue: false },
];

function QuestionEditor({
  availableSections,
  onRenameSection,
  question,
  onPatch,
  onDelete,
}: {
  availableSections: string[];
  onRenameSection: (source: string, target: string) => void;
  question: CheckInQuestion;
  onPatch: (patch: Partial<CheckInQuestion>) => void;
  onDelete: () => void;
}) {
  const children = question.children ?? [];
  const canAddChild = children.length < 3;
  const [showAnalysisHelp, setShowAnalysisHelp] = useState(false);
  const [sectionEditorMode, setSectionEditorMode] = useState<"idle" | "add" | "rename">("idle");
  const [sectionEditorValue, setSectionEditorValue] = useState("");
  const inputTagClass = "text-[10px] uppercase tracking-[0.12em] text-muted";
  const normalizedSection = normalizeSectionName(question.section);
  const sectionOptions = availableSections.includes(normalizedSection)
    ? availableSections
    : [...availableSections, normalizedSection];

  const closeSectionEditor = () => {
    setSectionEditorMode("idle");
    setSectionEditorValue("");
  };

  const openAddSectionEditor = () => {
    setSectionEditorMode("add");
    setSectionEditorValue("");
  };

  const openRenameSectionEditor = () => {
    setSectionEditorMode("rename");
    setSectionEditorValue(normalizedSection);
  };

  const submitSectionEditor = () => {
    const nextSection = normalizeSectionName(sectionEditorValue);
    if (sectionEditorMode === "add") {
      onPatch({ section: nextSection });
    }
    if (sectionEditorMode === "rename") {
      onRenameSection(normalizedSection, nextSection);
    }
    closeSectionEditor();
  };

  const patchInputType = (
    nextType: InputType,
    current: Pick<CheckInQuestion, "min" | "max" | "step" | "options" | "id">,
  ) => {
    if (nextType === "slider") {
      return {
        inputType: nextType,
        min: current.min ?? 0,
        max: current.max ?? 10,
        step: current.step ?? 1,
        options: undefined,
      };
    }
    if (nextType === "multi-choice") {
      return {
        inputType: nextType,
        min: undefined,
        max: undefined,
        step: undefined,
        options: current.options?.length
          ? current.options
          : [{ id: `${current.id}_option_1`, label: "Option 1" }],
      };
    }
    return {
      inputType: nextType,
      min: undefined,
      max: undefined,
      step: undefined,
      options: undefined,
    };
  };

  const patchChild = (childId: string, patch: Partial<CheckInQuestionChild>) => {
    onPatch({
      children: children.map((child) =>
        child.id === childId ? { ...child, ...patch } : child,
      ),
    });
  };

  const removeChild = (childId: string) => {
    onPatch({
      children: children.filter((child) => child.id !== childId),
    });
  };

  const addChild = () => {
    if (!canAddChild) {
      return;
    }
    const nextChild: CheckInQuestionChild = {
      id: `${question.id}_child_${Date.now()}`,
      prompt: "Conditional follow-up",
      inputType: "text",
      analysisMode: question.analysisMode,
      condition: {
        operator: "non_empty",
      },
    };
    onPatch({ children: [...children, nextChild] });
  };

  const updateConditionOperator = (
    child: CheckInQuestionChild,
    operator: ChildConditionOperator,
  ) => {
    const operatorMeta = CONDITION_OPERATOR_META.find((entry) => entry.value === operator);
    const nextCondition = { ...child.condition, operator };
    if (!operatorMeta?.requiresValue) {
      delete nextCondition.value;
    } else if (nextCondition.value === undefined) {
      nextCondition.value =
        operator === "greater_than" || operator === "at_least" ? 0 : "";
    }
    patchChild(child.id, { condition: nextCondition });
  };

  const renderFieldMeta = ({
    field,
    onFieldPatch,
  }: {
    field: Pick<CheckInQuestionChild, "id" | "inputType" | "min" | "max" | "step" | "options">;
    onFieldPatch: (
      patch: Partial<Pick<CheckInQuestionChild, "min" | "max" | "step" | "options">>,
    ) => void;
  }) => {
    if (field.inputType === "slider") {
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <p className={inputTagClass}>Minimum</p>
            <input
              className="focusable min-h-11 rounded-2xl bg-panel px-3"
              placeholder="Min"
              type="number"
              value={field.min ?? 0}
              onChange={(event) => onFieldPatch({ min: Number(event.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <p className={inputTagClass}>Maximum</p>
            <input
              className="focusable min-h-11 rounded-2xl bg-panel px-3"
              placeholder="Max"
              type="number"
              value={field.max ?? 10}
              onChange={(event) => onFieldPatch({ max: Number(event.target.value) })}
            />
          </div>
          <div className="space-y-1">
            <p className={inputTagClass}>Step</p>
            <input
              className="focusable min-h-11 rounded-2xl bg-panel px-3"
              placeholder="Step"
              type="number"
              value={field.step ?? 1}
              onChange={(event) => onFieldPatch({ step: Number(event.target.value) })}
            />
          </div>
        </div>
      );
    }

    if (field.inputType === "multi-choice") {
      const options = field.options ?? [];
      return (
        <div className="space-y-2">
          {options.map((option, index) => (
            <div key={`${field.id}_${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
              <div className="space-y-1">
                <p className={inputTagClass}>Option label</p>
                <input
                  className="focusable min-h-11 rounded-2xl bg-panel px-3"
                  placeholder="Label"
                  value={option.label}
                  onChange={(event) =>
                    onFieldPatch({
                      options: options.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, label: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <p className={inputTagClass}>Option value id</p>
                <input
                  className="focusable min-h-11 rounded-2xl bg-panel px-3"
                  placeholder="Value id"
                  value={option.id}
                  onChange={(event) =>
                    onFieldPatch({
                      options: options.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, id: event.target.value }
                          : candidate,
                      ),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <p className={inputTagClass}>Option score</p>
                <input
                  className="focusable min-h-11 rounded-2xl bg-panel px-3"
                  placeholder="Score"
                  type="number"
                  value={option.score ?? ""}
                  onChange={(event) => {
                    const rawValue = event.target.value;
                    onFieldPatch({
                      options: options.map((candidate, candidateIndex) => {
                        if (candidateIndex !== index) {
                          return candidate;
                        }
                        if (rawValue === "") {
                          return { ...candidate, score: undefined };
                        }
                        const score = Number(rawValue);
                        return Number.isFinite(score) ? { ...candidate, score } : candidate;
                      }),
                    });
                  }}
                />
              </div>
              <button
                className="focusable min-h-11 rounded-capsule bg-[color-mix(in_srgb,var(--error)_16%,white)] px-3 text-xs text-error"
                type="button"
                onClick={() =>
                  onFieldPatch({
                    options: options.filter((_, candidateIndex) => candidateIndex !== index),
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-xs"
            type="button"
            onClick={() =>
              onFieldPatch({
                options: [
                  ...options,
                  {
                    id: `${field.id}_option_${options.length + 1}`,
                    label: `Option ${options.length + 1}`,
                  },
                ],
              })
            }
          >
            Add option
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="mt-2 rounded-2xl bg-subsurface p-3">
      <p className="mb-2 text-sm font-semibold">Edit Question</p>
      <div className="space-y-3">
        <div className="space-y-1">
          <p className={inputTagClass}>Question prompt</p>
          <input
            className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
            value={question.prompt}
            onChange={(event) => onPatch({ prompt: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <p className={inputTagClass}>Input helper label (optional)</p>
          <input
            className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
            placeholder="Input label (optional, e.g. Count)"
            value={question.inputLabel ?? ""}
            onChange={(event) =>
              onPatch({ inputLabel: event.target.value.trim() ? event.target.value : undefined })
            }
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <p className={inputTagClass}>Section</p>
            <select
              className="focusable min-h-11 w-full rounded-2xl bg-panel px-3 sm:w-56"
              value={normalizedSection}
              onChange={(event) => onPatch({ section: event.target.value })}
            >
              {sectionOptions.map((section) => (
                <option key={section} value={section}>
                  {section}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <p className={inputTagClass}>Input type</p>
            <select
              className="focusable min-h-11 rounded-2xl bg-panel px-3"
              value={question.inputType}
              onChange={(event) =>
                onPatch(
                  patchInputType(
                    event.target.value as InputType,
                    question,
                  ) as Partial<CheckInQuestion>,
                )
              }
            >
              <option value="slider">slider</option>
              <option value="multi-choice">multi-choice</option>
              <option value="boolean">boolean</option>
              <option value="time">time</option>
              <option value="text">text</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="focusable min-h-11 w-full rounded-capsule bg-panel px-3 text-xs sm:w-56"
            type="button"
            onClick={openAddSectionEditor}
          >
            Add section option
          </button>
          <button
            className="focusable min-h-11 w-full rounded-capsule bg-panel px-3 text-xs sm:w-56"
            type="button"
            onClick={openRenameSectionEditor}
          >
            Rename section option
          </button>
        </div>
        {sectionEditorMode !== "idle" && (
          <div className="rounded-2xl bg-panel p-3">
            <p className={inputTagClass}>
              {sectionEditorMode === "add" ? "New section option" : "Rename section option"}
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                className="focusable min-h-11 flex-1 rounded-2xl bg-subsurface px-3"
                placeholder="Section name"
                value={sectionEditorValue}
                onChange={(event) => setSectionEditorValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submitSectionEditor();
                  }
                  if (event.key === "Escape") {
                    closeSectionEditor();
                  }
                }}
              />
              <button
                className="focusable min-h-11 rounded-capsule bg-accent px-4 text-sm font-semibold text-white"
                type="button"
                onClick={submitSectionEditor}
              >
                Save
              </button>
              <button
                className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-sm"
                type="button"
                onClick={closeSectionEditor}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Analysis mode</p>
            <div
              className="relative"
              onMouseEnter={() => setShowAnalysisHelp(true)}
              onMouseLeave={() => setShowAnalysisHelp(false)}
            >
              <button
                aria-label="Analysis mode help"
                className="focusable rounded-capsule bg-panel p-1 text-muted transition hover:text-ink"
                type="button"
                onBlur={() => setShowAnalysisHelp(false)}
                onClick={() => setShowAnalysisHelp((previous) => !previous)}
                onFocus={() => setShowAnalysisHelp(true)}
              >
                <CircleHelp className="size-4" />
              </button>
              {showAnalysisHelp && (
                <div className="pointer-events-none absolute left-0 top-8 z-20 w-72 rounded-2xl bg-panel p-3 text-xs text-muted shadow-soft">
                  <p>
                    <strong>Predictor to next day:</strong> behavior on day D aligned to outcomes
                    on day D+1.
                  </p>
                  <p className="mt-2">
                    <strong>Target to same day:</strong> outcome or subjective state recorded for
                    day D itself.
                  </p>
                </div>
              )}
            </div>
          </div>
          <select
            className="focusable min-h-11 rounded-2xl bg-panel px-3"
            value={question.analysisMode}
            onChange={(event) =>
              onPatch({
                analysisMode: event.target.value as CheckInQuestion["analysisMode"],
              })
            }
          >
            <option value="predictor_next_day">Predictor to next day</option>
            <option value="target_same_day">Target to same day</option>
          </select>
        </div>
        {renderFieldMeta({
          field: question,
          onFieldPatch: (patch) => onPatch(patch as Partial<CheckInQuestion>),
        })}

        <div className="rounded-2xl bg-panel p-3">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Conditional fields</p>
            <button
              className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-xs disabled:cursor-not-allowed disabled:opacity-55"
              disabled={!canAddChild}
              type="button"
              onClick={addChild}
            >
              Add child
            </button>
          </div>
          <p className="mb-3 text-xs text-muted">
            Show up to 3 child fields. Conditions evaluate only against the parent answer.
          </p>
          <div className="space-y-3">
            {children.map((child) => {
              const operatorMeta = CONDITION_OPERATOR_META.find(
                (entry) => entry.value === child.condition.operator,
              );
              const conditionNeedsValue = operatorMeta?.requiresValue ?? false;
              return (
                <div key={child.id} className="rounded-2xl bg-subsurface p-3">
                  <div className="mb-2 flex justify-end">
                    <button
                      className="focusable min-h-11 rounded-capsule bg-[color-mix(in_srgb,var(--error)_16%,white)] px-3 text-xs text-error"
                      type="button"
                      onClick={() => removeChild(child.id)}
                    >
                      Remove child
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <p className={inputTagClass}>Child prompt</p>
                      <input
                        className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                        placeholder="Child prompt"
                        value={child.prompt}
                        onChange={(event) => patchChild(child.id, { prompt: event.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <p className={inputTagClass}>Child id</p>
                      <input
                        className="focusable min-h-11 w-full rounded-2xl bg-panel px-3 font-mono text-xs"
                        placeholder="Child id"
                        value={child.id}
                        onChange={(event) => patchChild(child.id, { id: event.target.value })}
                      />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <p className={inputTagClass}>Child input type</p>
                        <select
                          className="focusable min-h-11 rounded-2xl bg-panel px-3"
                          value={child.inputType}
                          onChange={(event) =>
                            patchChild(
                              child.id,
                              patchInputType(
                                event.target.value as InputType,
                                child,
                              ) as Partial<CheckInQuestionChild>,
                            )
                          }
                        >
                          <option value="slider">slider</option>
                          <option value="multi-choice">multi-choice</option>
                          <option value="boolean">boolean</option>
                          <option value="time">time</option>
                          <option value="text">text</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <p className={inputTagClass}>Child analysis mode</p>
                        <select
                          className="focusable min-h-11 rounded-2xl bg-panel px-3"
                          value={child.analysisMode}
                          onChange={(event) =>
                            patchChild(child.id, {
                              analysisMode: event.target.value as CheckInQuestion["analysisMode"],
                            })
                          }
                        >
                          <option value="predictor_next_day">Predictor to next day</option>
                          <option value="target_same_day">Target to same day</option>
                        </select>
                      </div>
                    </div>
                    {renderFieldMeta({
                      field: child,
                      onFieldPatch: (patch) => patchChild(child.id, patch),
                    })}
                    <div className="grid gap-2 sm:grid-cols-[220px_1fr]">
                      <div className="space-y-1">
                        <p className={inputTagClass}>Condition operator</p>
                        <select
                          className="focusable min-h-11 rounded-2xl bg-panel px-3"
                          value={child.condition.operator}
                          onChange={(event) =>
                            updateConditionOperator(
                              child,
                              event.target.value as ChildConditionOperator,
                            )
                          }
                        >
                          {CONDITION_OPERATOR_META.map((operator) => (
                            <option key={operator.value} value={operator.value}>
                              {operator.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <p className={inputTagClass}>Condition value</p>
                        {conditionNeedsValue ? (
                          <input
                            className="focusable min-h-11 rounded-2xl bg-panel px-3"
                            placeholder="Condition value"
                            type={
                              child.condition.operator === "greater_than"
                              || child.condition.operator === "at_least"
                                ? "number"
                                : "text"
                            }
                            value={child.condition.value ?? ""}
                            onChange={(event) => {
                              const nextValue =
                                child.condition.operator === "greater_than"
                                || child.condition.operator === "at_least"
                                  ? Number(event.target.value)
                                  : event.target.value;
                              patchChild(child.id, {
                                condition: {
                                  ...child.condition,
                                  value: nextValue,
                                },
                              });
                            }}
                          />
                        ) : (
                          <p className="flex min-h-11 items-center rounded-2xl bg-panel px-3 text-xs text-muted">
                            No condition value required.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {!children.length && (
              <p className="rounded-2xl bg-subsurface px-3 py-2 text-xs text-muted">
                No child fields configured.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          className="focusable min-h-11 rounded-capsule bg-[color-mix(in_srgb,var(--error)_16%,white)] px-4 text-sm text-error"
          type="button"
          onClick={onDelete}
        >
          Delete question
        </button>
      </div>
    </div>
  );
}

export default App;
