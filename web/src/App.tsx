import {
  type TouchEvent as ReactTouchEvent,
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
  ChartNoAxesCombined,
  CirclePlus,
  CircleHelp,
  Check,
  ClipboardCheck,
  GripVertical,
  LayoutDashboard,
  LoaderCircle,
  Pencil,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
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
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SleepWindowChart } from "./components/SleepWindowChart";
import { QuestionAnswerInput } from "./components/QuestionAnswerInput";
import { CheckinFeature, useCheckinFeature } from "./features/checkin/CheckinFeature";
import { CheckinReminderSettings } from "./features/checkin/CheckinReminderSettings";
import { NotificationSettings } from "./features/checkin/NotificationSettings";
import { CorrelationFeature } from "./features/correlation/CorrelationFeature";
import { useCorrelationFeature } from "./features/correlation/useCorrelationFeature";
import {
  DEFAULT_QUESTIONS,
  METRICS,
  RANGE_PRESETS,
  SECTION_ORDER,
} from "./lib/constants";
import {
  CAFFEINE_LAST_TIME_QUESTION_ID,
  DERIVED_GAP_METRICS,
  DERIVED_ONLY_QUESTION_IDS,
  MEAL_FINISH_QUESTION_ID,
  type DerivedGapMetricKey,
} from "./lib/derivedMetrics";
import { formatReadableDate, formatTime, mean } from "./lib/mockData";
import { parseClockTimeToMinutes } from "./lib/time";
import { buildImportProgressDisplay } from "./lib/importProgress";
import { getZone2PlusMinutes } from "./lib/heartRateZones";
import {
  aggregateDashboardPlotPoints,
  aggregateDashboardRatioPoints,
  buildSleepWindowChartStats,
  createDashboardPlotId,
  formatRunningPace,
  normalizeDashboardPlotPreferences as normalizeDashboardPlotPreferencesRaw,
  type DashboardRatioPlotPoint,
  type SleepWindowChartPoint,
  type DashboardPlotChartStyle,
} from "./lib/dashboardPlots";
import {
  type OutcomeKey,
  type PredictorKey,
} from "./lib/correlation";
import {
  flattenQuestionFields,
  type QuestionFieldDefinition,
} from "./lib/questions";
import {
  fetchCheckIns,
  fetchCorrelationValues,
  fetchDashboardData,
  fetchDashboardPlotSettings,
  fetchQuestionSettings,
  dismissCorrelationNotifications,
  saveCheckIn,
  saveDashboardPlotSettings,
  saveQuestionSettings,
  startDateRangeImport,
  type PlotAggregation,
  type CorrelationNotification,
  type PlotDirection,
  type PlotReduceMethod,
} from "./lib/api";
import { usePersistentState } from "./lib/storage";
import {
  type CheckInQuestion,
  type CheckInQuestionChild,
  type CheckInEntry,
  type AnalysisValueRecord,
  type ChildCondition,
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
type AnswerValue = string | number | boolean;
type BackfillRangePreset = "none" | "all" | "7" | "14" | "30" | "custom";
type QuestionBackfillRequest = {
  questionId: string;
  fromDate: string;
  toDate: string;
  value: AnswerValue;
};
const DEFAULT_TOP_CORRELATION_OUTCOME: OutcomeKey = "metric:restingHr";
const VIEW_KEYS = new Set<ViewKey>(["dashboard", "lab", "checkin", "settings"]);
const VIEW_BUTTONS: Array<{ key: ViewKey; label: string; icon: LucideIcon }> = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "lab", label: "Correlation", icon: ChartNoAxesCombined },
  { key: "checkin", label: "Check-In", icon: ClipboardCheck },
  { key: "settings", label: "Settings", icon: Settings },
];
const SWIPE_MIN_DISTANCE_PX = 52;
const SWIPE_HORIZONTAL_RATIO = 1.25;
const SWIPE_AXIS_LOCK_DISTANCE_PX = 8;
const SWIPE_MIN_FLING_DISTANCE_PX = 22;
const SWIPE_MIN_FLING_VELOCITY_PX_MS = 0.45;
const VIEW_EXIT_DURATION_MS = 180;
const VIEW_ENTER_DURATION_MS = 380;
type SwipeGesture = {
  axis: "horizontal" | "vertical" | null;
  startedAt: number;
  x: number;
  y: number;
};
type GarminPlotKey =
  | "steps"
  | "calories"
  | "stressAvg"
  | "bodyBattery"
  | "runningKilometers"
  | "hrToSpeedRatio"
  | "strengthVolume"
  | "strengthSets"
  | "strengthReps"
  | "sleepSeconds"
  | "vo2Max"
  | "avgHr1hBeforeSleep"
  | "sleepConsistency"
  | "isTrainingDay"
  | "zone0Minutes"
  | "zone1Minutes"
  | "zone2Minutes"
  | "zone3Minutes"
  | "zone4Minutes"
  | "zone5Minutes"
  | "zone2PlusMinutes"
  | DerivedGapMetricKey;
type DashboardPlotVariableKey =
  | `metric:${MetricKey}`
  | `garmin:${GarminPlotKey}`
  | `question:${string}`;

interface DashboardPlotVariableOption {
  key: DashboardPlotVariableKey;
  label: string;
  color: string;
  unit: string;
}

interface DashboardPlotPreference {
  id: string;
  key: DashboardPlotVariableKey;
  direction: PlotDirection;
  aggregation: PlotAggregation;
  rolling: boolean;
  reduceMethod: PlotReduceMethod;
  chartStyle: DashboardPlotChartStyle;
}

interface DashboardPlot {
  id: string;
  key: DashboardPlotVariableKey;
  direction: PlotDirection;
  aggregation: PlotAggregation;
  rolling: boolean;
  reduceMethod: PlotReduceMethod;
  chartStyle: DashboardPlotChartStyle;
  option: DashboardPlotVariableOption;
  points: Array<{ date: string; value: number | null }>;
  sleepWindowPoints: SleepWindowChartPoint[] | null;
  averageBedtime: number | null;
  averageWakeTime: number | null;
  sleepAxisOffsetMinutes: number;
  values: number[];
  todayValue: number | null;
  periodAverage: number | null;
  comparison: { text: string; tone: string };
  coverage: CoverageState;
  baselineHint: string;
  domain: [number, number];
  ticks: number[];
}

function readUrlParams(): URLSearchParams {
  return typeof window === "undefined"
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
}

function readUrlView(): ViewKey {
  const view = readUrlParams().get("view");
  return VIEW_KEYS.has(view as ViewKey) ? view as ViewKey : "dashboard";
}

function readUrlPredictorKey(): PredictorKey {
  return (readUrlParams().get("predictor") || "garmin:steps") as PredictorKey;
}

function readUrlOutcomeKey(): OutcomeKey {
  return (readUrlParams().get("outcome") || DEFAULT_TOP_CORRELATION_OUTCOME) as OutcomeKey;
}

function replaceAppUrl(activeView: ViewKey, predictorKey: PredictorKey, outcomeKey: OutcomeKey): void {
  if (typeof window === "undefined") {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (activeView === "dashboard") {
    params.delete("view");
  } else {
    params.set("view", activeView);
  }
  if (activeView === "lab") {
    params.set("predictor", predictorKey);
    params.set("outcome", outcomeKey);
  } else {
    params.delete("predictor");
    params.delete("outcome");
  }
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

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
const DEFAULT_DASHBOARD_PLOT_PREFERENCES: DashboardPlotPreference[] = [
  {
    id: "plot_1_metric_recoveryIndex",
    key: "metric:recoveryIndex",
    direction: "higher",
    aggregation: "daily",
    rolling: false,
    reduceMethod: "mean",
    chartStyle: "line",
  },
  {
    id: "plot_2_metric_restingHr",
    key: "metric:restingHr",
    direction: "lower",
    aggregation: "daily",
    rolling: false,
    reduceMethod: "mean",
    chartStyle: "line",
  },
  {
    id: "plot_3_metric_stress",
    key: "metric:stress",
    direction: "lower",
    aggregation: "daily",
    rolling: false,
    reduceMethod: "mean",
    chartStyle: "line",
  },
  {
    id: "plot_4_metric_bodyBattery",
    key: "metric:bodyBattery",
    direction: "higher",
    aggregation: "daily",
    rolling: false,
    reduceMethod: "mean",
    chartStyle: "line",
  },
  {
    id: "plot_5_metric_trainingReadiness",
    key: "metric:trainingReadiness",
    direction: "higher",
    aggregation: "daily",
    rolling: false,
    reduceMethod: "mean",
    chartStyle: "line",
  },
  {
    id: "plot_6_garmin_vo2Max",
    key: "garmin:vo2Max",
    direction: "higher",
    aggregation: "daily",
    rolling: false,
    reduceMethod: "mean",
    chartStyle: "line",
  },
];
const METRIC_DIRECTIONS: Record<MetricKey, MetricDirection> = {
  recoveryIndex: "higher",
  bodyBattery: "higher",
  trainingReadiness: "higher",
  deepSleepPercentage: "higher",
  remSleepPercentage: "higher",
  remOrDeepSleepPercentage: "higher",
  avgOvernightHrv: "higher",
  sleepScore: "higher",
  stress: "lower",
  restingHr: "lower",
};

const EMPTY_METRICS: Record<MetricKey, number | null> = {
  recoveryIndex: null,
  restingHr: null,
  stress: null,
  bodyBattery: null,
  trainingReadiness: null,
  deepSleepPercentage: null,
  remSleepPercentage: null,
  remOrDeepSleepPercentage: null,
  avgOvernightHrv: null,
  sleepScore: null,
};

const EMPTY_COVERAGE: Record<MetricKey, CoverageState> = {
  recoveryIndex: "missing",
  restingHr: "missing",
  stress: "missing",
  bodyBattery: "missing",
  trainingReadiness: "missing",
  deepSleepPercentage: "missing",
  remSleepPercentage: "missing",
  remOrDeepSleepPercentage: "missing",
  avgOvernightHrv: "missing",
  sleepScore: "missing",
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
const ALCOHOL_QUESTION_ID = "alcohol_units";
const ALCOHOL_LAST_TIME_CHILD_ID = "alcohol_last_time";
const FULLNESS_QUESTION_ID = "nutrition_fullness";
const ENERGY_TARGET_QUESTION_ID = "felt_energized_during_day";
const IMPORT_POLL_INTERVAL_MS = 5000;
const DASHBOARD_REFRESH_INTERVAL_MS = 60000;
const MAX_IMPORT_RANGE_DAYS = 365;
const EMPTY_DERIVED_GAP_PREDICTORS = Object.fromEntries(
  DERIVED_GAP_METRICS.map((metric) => [metric.key, null]),
) as Record<DerivedGapMetricKey, number | null>;
const DERIVED_GAP_PLOT_META = Object.fromEntries(
  DERIVED_GAP_METRICS.map((metric) => [
    metric.key,
    { label: metric.plotLabel, color: metric.color, unit: "min" },
  ]),
) as Record<DerivedGapMetricKey, Omit<DashboardPlotVariableOption, "key">>;

const GARMIN_PLOT_META: Record<GarminPlotKey, Omit<DashboardPlotVariableOption, "key">> = {
  steps: { label: "Steps", color: "#4f7e65", unit: "steps" },
  calories: { label: "Calories", color: "#8a5a4e", unit: "kcal" },
  stressAvg: { label: "Stress Avg", color: "#806739", unit: "pts" },
  bodyBattery: { label: "Body Battery", color: "#51745e", unit: "%" },
  runningKilometers: { label: "Running Distance", color: "#b45f3c", unit: "km" },
  hrToSpeedRatio: { label: "HR-to-Speed Ratio", color: "#9a4f5f", unit: "bpm per km/h" },
  strengthVolume: { label: "Strength Volume", color: "#a63228", unit: "kg" },
  strengthSets: { label: "Strength Sets", color: "#c0693a", unit: "sets" },
  strengthReps: { label: "Strength Reps", color: "#8d6a2d", unit: "reps" },
  sleepSeconds: { label: "Sleep Duration", color: "#3f6686", unit: "h" },
  vo2Max: { label: "VO2 Max", color: "#586f9e", unit: "ml/kg/min" },
  avgHr1hBeforeSleep: { label: "Avg HR 1h Before Sleep", color: "#9a4f5f", unit: "bpm" },
  sleepConsistency: { label: "Sleep Timing Variability", color: "#4b7394", unit: "min" },
  isTrainingDay: { label: "Training Day", color: "#6f4b83", unit: "0/1" },
  zone0Minutes: { label: "Zone 0 Time", color: "#7a9e9f", unit: "min" },
  zone1Minutes: { label: "Zone 1 Time", color: "#5b8db8", unit: "min" },
  zone2Minutes: { label: "Zone 2 Time", color: "#4a7c59", unit: "min" },
  zone3Minutes: { label: "Zone 3 Time", color: "#d4a843", unit: "min" },
  zone4Minutes: { label: "Zone 4 Time", color: "#c0693a", unit: "min" },
  zone5Minutes: { label: "Zone 5 Time", color: "#a63228", unit: "min" },
  zone2PlusMinutes: { label: "Zone 2+ Time", color: "#8d6a2d", unit: "min" },
  ...DERIVED_GAP_PLOT_META,
};
const GARMIN_PLOT_DIRECTIONS: Partial<Record<GarminPlotKey, PlotDirection>> = {
  avgHr1hBeforeSleep: "lower",
  hrToSpeedRatio: "lower",
  sleepConsistency: "lower",
};

function defaultPlotDirection(plotKey: DashboardPlotVariableKey): PlotDirection {
  if (plotKey.startsWith("metric:")) {
    const metricKey = plotKey.slice(7) as MetricKey;
    return METRIC_DIRECTIONS[metricKey] ?? "higher";
  }
  if (plotKey.startsWith("garmin:")) {
    const garminKey = plotKey.slice(7) as GarminPlotKey;
    return GARMIN_PLOT_DIRECTIONS[garminKey] ?? "higher";
  }
  return "higher";
}

function normalizeDashboardPlotPreferences(
  raw: unknown,
  fallback: DashboardPlotPreference[],
): DashboardPlotPreference[] {
  return normalizeDashboardPlotPreferencesRaw(
    raw,
    fallback,
    defaultPlotDirection,
  ).map((plot) => ({
    ...plot,
    key: plot.key as DashboardPlotVariableKey,
  }));
}

function arePlotPreferencesEqual(
  a: DashboardPlotPreference[],
  b: DashboardPlotPreference[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) =>
    value.id === b[index]?.id
    && value.key === b[index]?.key
    && value.direction === b[index]?.direction
    && value.aggregation === b[index]?.aggregation
    && value.rolling === b[index]?.rolling
    && value.reduceMethod === b[index]?.reduceMethod
    && value.chartStyle === b[index]?.chartStyle
  );
}

function normalizeRangePreset(raw: unknown, fallback: number): number {
  if (typeof raw !== "number") {
    return fallback;
  }
  return RANGE_PRESETS.includes(raw as (typeof RANGE_PRESETS)[number]) ? raw : fallback;
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

function getMetricKeyFromPlotKey(plotKey: DashboardPlotVariableKey): MetricKey | null {
  if (!plotKey.startsWith("metric:")) {
    return null;
  }
  return plotKey.slice(7) as MetricKey;
}

function formatDashboardValue(
  plotKey: DashboardPlotVariableKey,
  option: DashboardPlotVariableOption,
  value: number | null,
): string {
  const metricKey = getMetricKeyFromPlotKey(plotKey);
  if (metricKey) {
    return formatMetricValue(metricKey, value);
  }
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return formatPlotValue(option, value);
}

function formatDashboardDelta(
  plotKey: DashboardPlotVariableKey,
  option: DashboardPlotVariableOption,
  value: number,
): string {
  const metricKey = getMetricKeyFromPlotKey(plotKey);
  if (metricKey) {
    return formatMetricDelta(metricKey, value);
  }
  if (plotKey === "garmin:sleepSeconds") {
    return formatHoursAsHoursMinutes(Math.abs(value));
  }
  const amount = Math.abs(value).toFixed(1);
  return option.unit ? `${amount} ${option.unit}` : amount;
}

function describeDashboardVsAverage(
  direction: PlotDirection,
  option: DashboardPlotVariableOption,
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
  const better = (delta > 0 && direction === "higher") || (delta < 0 && direction === "lower");
  return {
    text: `Today is ${aboveOrBelow} the ${rangePreset}-day average by ${formatDashboardDelta(option.key, option, delta)} (${better ? "better" : "worse"}).`,
    tone: better ? "text-success" : "text-error",
  };
}

function deriveCoverageState(
  sampleCount: number,
  valueCount: number,
  todayValue: number | null,
): CoverageState {
  if (todayValue === null || valueCount === 0) {
    return "missing";
  }
  if (valueCount >= sampleCount) {
    return "complete";
  }
  return "partial";
}

function computeYAxisStats(
  values: number[],
  decimalPlaces = 0,
): { domain: [number, number]; ticks: number[] } {
  if (!values.length) {
    return { domain: [0, 1], ticks: [0, 0, 0] };
  }

  const roundValue = (value: number) => (
    decimalPlaces > 0 ? Number(value.toFixed(decimalPlaces)) : Math.round(value)
  );
  const minimum = roundValue(Math.min(...values));
  const maximum = roundValue(Math.max(...values));
  const average = Math.max(minimum, Math.min(maximum, roundValue(mean(values))));
  const domain: [number, number] = minimum === maximum ? [minimum - 1, maximum + 1] : [minimum, maximum];
  const uniqueTicks = Array.from(new Set([minimum, average, maximum]));
  let ticks: number[];
  if (uniqueTicks.length === 1) {
    ticks = [uniqueTicks[0] - 1, uniqueTicks[0], uniqueTicks[0] + 1];
  } else if (uniqueTicks.length === 2) {
    const low = uniqueTicks[0];
    const high = uniqueTicks[1];
    ticks = [low, (low + high) / 2, high];
  } else {
    ticks = [minimum, average, maximum];
  }
  return {
    domain,
    ticks,
  };
}

function parseQuestionPlotValue(
  question: QuestionFieldDefinition,
  value: unknown,
): number | null {
  if (value === null || value === undefined || question.inputType === "text") {
    return null;
  }
  if (question.inputType === "boolean") {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  if (question.inputType === "time") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    return typeof value === "string" ? parseClockTimeToMinutes(value) : null;
  }
  if (question.inputType === "multi-choice") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    const option = question.options?.find((candidate) => candidate.id === normalized);
    if (option && typeof option.score === "number" && Number.isFinite(option.score)) {
      return option.score;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getDashboardPlotValue(
  variable: DashboardPlotVariableKey,
  record: DailyRecord,
  checkinsByDate: Map<string, CheckInEntry>,
  questionsById: Map<string, QuestionFieldDefinition>,
): number | null {
  if (variable.startsWith("metric:")) {
    const metric = variable.slice(7) as MetricKey;
    return record.metrics[metric];
  }
  if (variable.startsWith("garmin:")) {
    const key = variable.slice(7) as GarminPlotKey;
    if (key === "isTrainingDay") {
      return record.predictors.isTrainingDay ? 1 : 0;
    }
    if (key === "zone2PlusMinutes") {
      return getZone2PlusMinutes(record.predictors);
    }
    const value = record.predictors[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    if (key === "sleepSeconds") {
      return value / 3600;
    }
    return value;
  }
  const questionId = variable.slice(9);
  const question = questionsById.get(questionId);
  if (!question) {
    return null;
  }
  const entry = checkinsByDate.get(record.date);
  return parseQuestionPlotValue(question, entry?.answers[questionId]);
}

function formatPlotValue(option: DashboardPlotVariableOption, value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (option.key === "garmin:sleepSeconds") {
    return formatHoursAsHoursMinutes(value);
  }
  if (!option.unit) {
    return value.toFixed(1);
  }
  return `${value.toFixed(1)} ${option.unit}`;
}

function formatIsoDateLocal(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addIsoDateDays(value: string, days: number): string | null {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return null;
  }
  parsed.setDate(parsed.getDate() + days);
  return formatIsoDateLocal(parsed);
}

function buildIsoDateRange(fromDate: string, toDate: string): string[] {
  const days = rangeDaysInclusive(fromDate, toDate);
  if (!days || days < 1) {
    return [];
  }
  return Array.from({ length: days }, (_, index) => addIsoDateDays(fromDate, index)).filter(
    (date): date is string => Boolean(date),
  );
}

function defaultAnswerForQuestion(question: Pick<CheckInQuestion, "inputType" | "min" | "options">): AnswerValue {
  if (question.inputType === "slider") {
    return question.min ?? 0;
  }
  if (question.inputType === "boolean") {
    return false;
  }
  if (question.inputType === "multi-choice") {
    return question.options?.[0]?.id ?? "";
  }
  return "";
}

function isValidQuestionAnswer(
  question: Pick<CheckInQuestion, "inputType" | "options">,
  value: AnswerValue,
): boolean {
  if (question.inputType === "boolean") {
    return typeof value === "boolean";
  }
  if (question.inputType === "slider") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (question.inputType === "multi-choice") {
    return typeof value === "string" && (question.options ?? []).some((option) => option.id === value);
  }
  if (question.inputType === "time") {
    return typeof value === "string" && parseClockTimeToMinutes(value) !== null;
  }
  return typeof value === "string" && value.trim().length > 0;
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

function formatShortNumericDate(value: string): string {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    return value;
  }
  const day = String(parsed.getDate()).padStart(2, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${parsed.getFullYear()}`;
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
        if (!nextQuestion.children?.length) {
          nextQuestion.children = [
            {
              id: CAFFEINE_LAST_TIME_QUESTION_ID,
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

      delete nextQuestion.inputLabel;
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

function formatHoursAsHoursMinutes(hours: number): string {
  if (!Number.isFinite(hours)) {
    return "--";
  }
  const totalMinutes = Math.round(hours * 60);
  const sign = totalMinutes < 0 ? "-" : "";
  const absoluteMinutes = Math.abs(totalMinutes);
  const wholeHours = Math.floor(absoluteMinutes / 60);
  const remainingMinutes = absoluteMinutes % 60;
  return `${sign}${wholeHours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}

function SparklineTooltip({
  active,
  option,
  payload,
  plotKey,
}: {
  active?: boolean;
  option: DashboardPlotVariableOption;
  payload?: Array<{ value?: number; payload?: DashboardRatioPlotPoint }>;
  plotKey: DashboardPlotVariableKey;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  const value = payload[0]?.value;
  const point = payload[0]?.payload;
  const date = point?.date;
  const formattedValue = typeof value === "number" ? formatDashboardValue(plotKey, option, value) : "--";
  const numerator = point?.numerator;
  const denominator = point?.denominator;
  const distance = point?.distance;
  const showRatioComponents = plotKey === "garmin:hrToSpeedRatio"
    && typeof numerator === "number"
    && typeof denominator === "number";
  return (
    <div className="whitespace-nowrap rounded-2xl bg-panel px-3 py-2 text-xs shadow-soft">
      {date && <p className="mb-1 text-muted">{formatReadableDate(date)}</p>}
      <p className="metric-number font-mono">{formattedValue}</p>
      {showRatioComponents && (
        <div className="mt-1 space-y-0.5 text-muted">
          <p>Average HR: {numerator.toFixed(1)} bpm</p>
          <p>Average speed: {denominator.toFixed(1)} km/h</p>
          <p>Average pace: {formatRunningPace(denominator)}</p>
          {typeof distance === "number" && <p>Average distance: {distance.toFixed(1)} km</p>}
        </div>
      )}
    </div>
  );
}

function formatCorrelationStat(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "--";
}

function isSwipeNavigationTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest(
      "a, button, input, select, textarea, [data-swipe-ignore], .recharts-wrapper",
    ) === null;
}

function adjacentView(view: ViewKey, direction: -1 | 1): ViewKey {
  const currentIndex = VIEW_BUTTONS.findIndex((button) => button.key === view);
  const nextIndex = Math.min(VIEW_BUTTONS.length - 1, Math.max(0, currentIndex + direction));
  return VIEW_BUTTONS[nextIndex].key;
}

function App() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const swipeStartRef = useRef<SwipeGesture | null>(null);
  const swipeOffsetRef = useRef(0);
  const isViewTransitioningRef = useRef(false);

  const [activeView, setActiveView] = useState<ViewKey>(readUrlView);
  const [rangePreset, setRangePreset] = usePersistentState<number>(
    "ui.rangePreset",
    DEFAULT_RANGE_PRESET,
    normalizeRangePreset,
  );
  const [dashboardPlotPreferences, setDashboardPlotPreferences] = useState<DashboardPlotPreference[]>(
    DEFAULT_DASHBOARD_PLOT_PREFERENCES,
  );
  const [plotSettingsLoadState, setPlotSettingsLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [plotSettingsError, setPlotSettingsError] = useState<string | null>(null);
  const [isSavingPlotSettings, setIsSavingPlotSettings] = useState(false);
  const lastSavedPlotSettingsRef = useRef<string>(
    JSON.stringify(DEFAULT_DASHBOARD_PLOT_PREFERENCES),
  );
  const [showAddPlotMenu, setShowAddPlotMenu] = useState(false);
  const addPlotMenuRef = useRef<HTMLDivElement | null>(null);
  const [plotSearchQuery, setPlotSearchQuery] = useState("");
  const [addPlotSearchQuery, setAddPlotSearchQuery] = useState("");
  const [pendingAddPlot, setPendingAddPlot] = useState<DashboardPlotVariableOption | null>(null);
  const [pendingAddPlotStep, setPendingAddPlotStep] = useState<"direction" | "chartStyle" | "aggregation" | "rolling" | "reduceMethod">("direction");
  const [pendingAddPlotDirection, setPendingAddPlotDirection] = useState<PlotDirection>("higher");
  const [pendingAddPlotChartStyle, setPendingAddPlotChartStyle] = useState<DashboardPlotChartStyle>("line");
  const [pendingAddPlotAggregation, setPendingAddPlotAggregation] = useState<PlotAggregation>("daily");
  const [pendingAddPlotRolling, setPendingAddPlotRolling] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [questionLibrary, setQuestionLibrary] = useState<CheckInQuestion[]>(DEFAULT_QUESTIONS);
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [customSectionOptions, setCustomSectionOptions] = useState<string[]>([]);
  const [questionLoadState, setQuestionLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [questionSyncError, setQuestionSyncError] = useState<string | null>(null);
  const [isSavingQuestions, setIsSavingQuestions] = useState(false);
  const lastSavedQuestionsRef = useRef<string>("[]");
  const selectedQuestionEditorRef = useRef<HTMLDivElement | null>(null);
  const pendingQuestionScrollIdRef = useRef<string | null>(null);
  const [allRecords, setAllRecords] = useState<DailyRecord[]>([]);
  const [hrZoneBounds, setHrZoneBounds] = useState<number[] | null>(null);
  const [analysisValues, setAnalysisValues] = useState<AnalysisValueRecord[]>([]);
  const [questionBackfillMessage, setQuestionBackfillMessage] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{
    state: ImportState;
    lastImportAt: string | null;
    message: string;
    errorDetail: string | null;
  }>({
    state: "running",
    lastImportAt: null,
    message: "Daily import scheduled · 06:00 local",
    errorDetail: null,
  });
  const [dataStatus, setDataStatus] = useState<"loading" | "ready" | "error">("loading");
  const [dataError, setDataError] = useState<string | null>(null);
  const [correlationNotifications, setCorrelationNotifications] = useState<CorrelationNotification[]>([]);
  const [predictorKey, setPredictorKey] = useState<PredictorKey>(readUrlPredictorKey);
  const [outcomeKey, setOutcomeKey] = useState<OutcomeKey>(readUrlOutcomeKey);
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
    start.setDate(end.getDate() - 1);
    return formatIsoDateLocal(start);
  });
  const [importToDate, setImportToDate] = useState(() => formatIsoDateLocal(new Date()));
  const sensors = useSensors(useSensor(PointerSensor));

  useEffect(() => {
    replaceAppUrl(activeView, predictorKey, outcomeKey);
  }, [activeView, outcomeKey, predictorKey]);

  useEffect(() => {
    const handlePopState = () => {
      setActiveView(readUrlView());
      setPredictorKey(readUrlPredictorKey());
      setOutcomeKey(readUrlOutcomeKey());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const resetDraggedView = useCallback(async () => {
    const main = mainRef.current;
    const offset = swipeOffsetRef.current;
    swipeOffsetRef.current = 0;
    if (!main) return;

    if (offset && typeof main.animate === "function") {
      try {
        await main.animate(
          [
            { transform: `translate3d(${offset}px, 0, 0)`, opacity: 0.96 },
            { transform: "translate3d(0, 0, 0)", opacity: 1 },
          ],
          {
            duration: 420,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          },
        ).finished;
      } catch {
        // An interrupted rebound only needs its inline drag state cleared.
      }
    }
    main.style.removeProperty("transform");
    main.style.removeProperty("opacity");
    main.style.removeProperty("will-change");
  }, []);

  const animateViewStep = useCallback(async (direction: -1 | 1) => {
    if (isViewTransitioningRef.current) return;
    const nextView = adjacentView(activeView, direction);
    if (nextView === activeView) {
      await resetDraggedView();
      return;
    }
    const main = mainRef.current;
    const startOffset = swipeOffsetRef.current;
    swipeOffsetRef.current = 0;
    if (
      !main
      || typeof main.animate !== "function"
      || (typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      if (main) {
        main.style.removeProperty("transform");
        main.style.removeProperty("opacity");
        main.style.removeProperty("will-change");
      }
      setActiveView(nextView);
      return;
    }

    isViewTransitioningRef.current = true;
    const transitionDistance = Math.min(96, Math.max(56, window.innerWidth * 0.18));
    const exitOffset = -direction * transitionDistance;
    const enterOffset = direction * transitionDistance;
    let exitAnimation: Animation | null = null;
    let enterAnimation: Animation | null = null;
    let viewChanged = false;
    try {
      exitAnimation = main.animate(
        [
          { transform: `translate3d(${startOffset}px, 0, 0)`, opacity: startOffset ? 0.96 : 1 },
          { transform: `translate3d(${exitOffset}px, 0, 0)`, opacity: 0.76 },
        ],
        {
          duration: VIEW_EXIT_DURATION_MS,
          easing: "cubic-bezier(0.32, 0, 0.67, 0)",
          fill: "forwards",
        },
      );
      await exitAnimation.finished;
      setActiveView(nextView);
      viewChanged = true;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      enterAnimation = main.animate(
        [
          { transform: `translate3d(${enterOffset}px, 0, 0)`, opacity: 0.76 },
          { transform: "translate3d(0, 0, 0)", opacity: 1 },
        ],
        {
          duration: VIEW_ENTER_DURATION_MS,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        },
      );
      exitAnimation.cancel();
      await enterAnimation.finished;
    } catch {
      if (!viewChanged) setActiveView(nextView);
    } finally {
      exitAnimation?.cancel();
      enterAnimation?.cancel();
      main.style.removeProperty("transform");
      main.style.removeProperty("opacity");
      main.style.removeProperty("will-change");
      isViewTransitioningRef.current = false;
    }
  }, [activeView, resetDraggedView]);

  const handleViewTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (event.touches.length !== 1 || !isSwipeNavigationTarget(event.target)) {
      swipeStartRef.current = null;
      return;
    }
    const touch = event.touches[0];
    swipeOffsetRef.current = 0;
    swipeStartRef.current = {
      axis: null,
      startedAt: performance.now(),
      x: touch.clientX,
      y: touch.clientY,
    };
  }, []);

  const handleViewTouchMove = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = swipeStartRef.current;
    const touch = event.touches[0];
    const main = mainRef.current;
    if (!gesture || !touch || !main) return;

    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;
    if (!gesture.axis && Math.hypot(deltaX, deltaY) >= SWIPE_AXIS_LOCK_DISTANCE_PX) {
      gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) * SWIPE_HORIZONTAL_RATIO
        ? "horizontal"
        : "vertical";
    }
    if (gesture.axis !== "horizontal") return;

    const currentIndex = VIEW_BUTTONS.findIndex((button) => button.key === activeView);
    const isPullingPastEdge = (currentIndex === 0 && deltaX > 0)
      || (currentIndex === VIEW_BUTTONS.length - 1 && deltaX < 0);
    const viewportWidth = Math.max(320, window.innerWidth);
    const offset = isPullingPastEdge
      ? Math.sign(deltaX) * Math.min(72, Math.abs(deltaX) * 0.24)
      : Math.sign(deltaX) * Math.min(viewportWidth * 0.32, Math.abs(deltaX));
    swipeOffsetRef.current = offset;
    main.style.willChange = "transform, opacity";
    main.style.transform = `translate3d(${offset}px, 0, 0)`;
    main.style.opacity = String(1 - Math.min(0.08, Math.abs(offset) / viewportWidth * 0.18));
  }, [activeView]);

  const handleViewTouchEnd = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = swipeStartRef.current;
    swipeStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!gesture || !touch) return;

    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;
    const isHorizontal = gesture.axis === "horizontal"
      || (gesture.axis === null && Math.abs(deltaX) > Math.abs(deltaY) * SWIPE_HORIZONTAL_RATIO);
    const velocity = Math.abs(deltaX) / Math.max(16, performance.now() - gesture.startedAt);
    if (
      !isHorizontal
      || (Math.abs(deltaX) < SWIPE_MIN_DISTANCE_PX
        && (Math.abs(deltaX) < SWIPE_MIN_FLING_DISTANCE_PX
          || velocity < SWIPE_MIN_FLING_VELOCITY_PX_MS))
    ) {
      void resetDraggedView();
      return;
    }
    void animateViewStep(deltaX < 0 ? 1 : -1);
  }, [animateViewStep, resetDraggedView]);

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
        setCorrelationNotifications(payload.notifications?.correlations ?? []);
        setHrZoneBounds(payload.hrZoneBounds ?? null);
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

  const loadCorrelationValues = useCallback(
    async (signal?: AbortSignal) => {
      if (!allRecords.length) {
        setAnalysisValues([]);
        return;
      }
      const firstDate = allRecords[0]?.date;
      const lastDate = allRecords[allRecords.length - 1]?.date;
      if (!firstDate || !lastDate) {
        return;
      }
      try {
        const payload = await fetchCorrelationValues(firstDate, lastDate, signal);
        setAnalysisValues(payload.values);
      } catch {
        if (signal?.aborted) {
          return;
        }
        setAnalysisValues([]);
      }
    },
    [allRecords],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadCorrelationValues(controller.signal);
    return () => controller.abort();
  }, [loadCorrelationValues]);

  const checkin = useCheckinFeature({
    records: allRecords,
    questions: questionLibrary,
    onSaved: () => loadCorrelationValues(),
  });
  const checkinEntriesByDate = checkin.entriesByDate;
  const setCheckinEntriesByDate = checkin.setEntriesByDate;

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
        setSelectedQuestionId("");
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
    if (pendingQuestionScrollIdRef.current !== selectedQuestionId) {
      return;
    }
    selectedQuestionEditorRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
    pendingQuestionScrollIdRef.current = null;
  }, [questionLibrary, selectedQuestionId]);

  useEffect(() => {
    const controller = new AbortController();

    const loadDashboardPlots = async () => {
      setPlotSettingsLoadState("loading");
      setPlotSettingsError(null);
      try {
        const payload = await fetchDashboardPlotSettings(controller.signal);
        const normalized = normalizeDashboardPlotPreferences(
          payload.plots,
          DEFAULT_DASHBOARD_PLOT_PREFERENCES,
        );
        setDashboardPlotPreferences(normalized);
        lastSavedPlotSettingsRef.current = JSON.stringify(normalized);
        setPlotSettingsLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load dashboard plot settings from SQLite.";
        setPlotSettingsError(message);
        setPlotSettingsLoadState("error");
      }
    };

    void loadDashboardPlots();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (plotSettingsLoadState !== "ready") {
      return;
    }

    const serializedPlots = JSON.stringify(dashboardPlotPreferences);
    if (serializedPlots === lastSavedPlotSettingsRef.current) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      const saveDashboardPlots = async () => {
        setIsSavingPlotSettings(true);
        setPlotSettingsError(null);
        try {
          const payload = await saveDashboardPlotSettings(
            dashboardPlotPreferences,
            controller.signal,
          );
          const normalized = normalizeDashboardPlotPreferences(payload.plots, []);
          lastSavedPlotSettingsRef.current = JSON.stringify(normalized);
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Failed to save dashboard plot settings to SQLite.";
          setPlotSettingsError(message);
        } finally {
          if (!controller.signal.aborted) {
            setIsSavingPlotSettings(false);
          }
        }
      };

      void saveDashboardPlots();
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [dashboardPlotPreferences, plotSettingsLoadState]);

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

  useEffect(() => {
    if (!showAddPlotMenu && !pendingAddPlot) {
      return;
    }
    const handleWindowMouseDown = (event: MouseEvent) => {
      if (!addPlotMenuRef.current?.contains(event.target as Node)) {
        setShowAddPlotMenu(false);
        setPendingAddPlot(null);
      }
    };
    window.addEventListener("mousedown", handleWindowMouseDown);
    return () => window.removeEventListener("mousedown", handleWindowMouseDown);
  }, [pendingAddPlot, showAddPlotMenu]);

  useEffect(() => {
    if (activeView !== "dashboard" && showAddPlotMenu) {
      setShowAddPlotMenu(false);
    }
  }, [activeView, showAddPlotMenu]);

  useEffect(() => {
    if (!showAddPlotMenu) {
      setAddPlotSearchQuery("");
    }
  }, [showAddPlotMenu]);

  useEffect(() => {
    if (activeView !== "dashboard" && pendingAddPlot) {
      setPendingAddPlot(null);
    }
  }, [activeView, pendingAddPlot]);

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
        vo2Max: null,
        avgHr1hBeforeSleep: null,
        sleepConsistency: null,
        isTrainingDay: false,
        zone0Minutes: null,
        zone1Minutes: null,
        zone2Minutes: null,
        zone3Minutes: null,
        zone4Minutes: null,
        zone5Minutes: null,
        ...EMPTY_DERIVED_GAP_PREDICTORS,
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
  const metricSummaryByPlotKey = useMemo(
    () =>
      new Map(
        metricSummaries.map((summary) => [
          `metric:${summary.key}` as DashboardPlotVariableKey,
          summary,
        ]),
      ),
    [metricSummaries],
  );

  const checkinsByDateMap = useMemo(
    () => new Map(Object.values(checkinEntriesByDate).map((entry) => [entry.date, entry])),
    [checkinEntriesByDate],
  );
  const questionFields = useMemo(() => flattenQuestionFields(questionLibrary), [questionLibrary]);
  const questionFieldsById = useMemo(
    () => new Map(questionFields.map((field) => [field.id, field])),
    [questionFields],
  );
  const dashboardPlotOptions = useMemo<DashboardPlotVariableOption[]>(
    () => [
      ...METRICS.map((metric) => ({
        key: `metric:${metric.key}` as DashboardPlotVariableKey,
        label: metric.label,
        color: metric.color,
        unit: metric.unit,
      })),
      ...(Object.entries(GARMIN_PLOT_META) as Array<[GarminPlotKey, Omit<DashboardPlotVariableOption, "key">]>).map(
        ([key, value]) => ({
          key: `garmin:${key}` as DashboardPlotVariableKey,
          ...value,
        }),
      ),
      ...questionFields
        .filter((field) => !DERIVED_ONLY_QUESTION_IDS.has(field.id))
        .filter((field) => field.inputType !== "text")
        .map((field) => ({
          key: `question:${field.id}` as DashboardPlotVariableKey,
          label: `${field.prompt} (check-in)`,
          color: "#cc5833",
          unit: "",
        })),
    ],
    [questionFields],
  );
  useEffect(() => {
    if (!dashboardPlotOptions.length) {
      return;
    }
    const availableKeys = new Set(dashboardPlotOptions.map((option) => option.key));
    setDashboardPlotPreferences((previous) => {
      const filtered = previous.filter((plot) => availableKeys.has(plot.key));
      return arePlotPreferencesEqual(previous, filtered) ? previous : filtered;
    });
  }, [dashboardPlotOptions]);

  const addableDashboardPlotOptions = useMemo(() => {
    const query = addPlotSearchQuery.trim().toLowerCase();
    return dashboardPlotOptions.filter((option) => {
      if (!query) {
        return true;
      }
      return option.label.toLowerCase().includes(query) || option.key.toLowerCase().includes(query);
    });
  }, [addPlotSearchQuery, dashboardPlotOptions]);
  const dashboardPlots = useMemo<DashboardPlot[]>(
    () => {
      return dashboardPlotPreferences
        .map((plotPreference) => {
          const option = dashboardPlotOptions.find((candidate) => candidate.key === plotPreference.key);
          if (!option) {
            return null;
          }
          const rawPoints: DashboardRatioPlotPoint[] = records.map((record) => ({
            date: record.date,
            value: getDashboardPlotValue(plotPreference.key, record, checkinsByDateMap, questionFieldsById),
            numerator: plotPreference.key === "garmin:hrToSpeedRatio"
              ? record.predictors.runningAverageHr ?? null
              : null,
            denominator: plotPreference.key === "garmin:hrToSpeedRatio"
              ? record.predictors.runningAverageSpeedKmh ?? null
              : null,
            distance: plotPreference.key === "garmin:hrToSpeedRatio"
              ? record.predictors.runningAverageDistanceKm ?? null
              : null,
          }));
          const points = plotPreference.key === "garmin:hrToSpeedRatio"
            ? aggregateDashboardRatioPoints(
              rawPoints,
              plotPreference.aggregation,
              plotPreference.rolling,
            )
            : aggregateDashboardPlotPoints(
              rawPoints,
              plotPreference.aggregation,
              plotPreference.rolling,
              plotPreference.reduceMethod,
            );
          const values = points
            .map((point) => point.value)
            .filter((value): value is number => value !== null);
          const metricSummary = metricSummaryByPlotKey.get(plotPreference.key);
          const todayValue = metricSummary?.todayValue ?? points[points.length - 1]?.value ?? null;
          const periodAverage = metricSummary?.periodAverage ?? (values.length ? mean(values) : null);
          const delta = todayValue === null || periodAverage === null ? null : todayValue - periodAverage;
          const coverage = metricSummary?.coverage ?? deriveCoverageState(rawPoints.length, values.length, todayValue);
          const baselineHint = metricSummary?.baselineHint
            ?? `Average based on ${values.length} of ${points.length} samples.`;
          const comparison = describeDashboardVsAverage(plotPreference.direction, option, delta, rangePreset);
          const sleepWindowStats = plotPreference.key === "garmin:sleepConsistency"
            && plotPreference.chartStyle === "sleepWindowBars"
            ? buildSleepWindowChartStats(records.map((record) => ({
              date: record.date,
              fellAsleepAt: record.fellAsleepAt,
              wokeUpAt: record.wokeUpAt,
              sleepConsistency: record.predictors.sleepConsistency,
            })))
            : null;
          const yAxis = sleepWindowStats ? {
            domain: sleepWindowStats.domain,
            ticks: sleepWindowStats.ticks,
          } : computeYAxisStats(values, plotPreference.key === "garmin:runningKilometers" ? 1 : 0);
          return {
            id: plotPreference.id,
            key: plotPreference.key,
            direction: plotPreference.direction,
            chartStyle: plotPreference.chartStyle,
            aggregation: plotPreference.aggregation,
            rolling: plotPreference.rolling,
            reduceMethod: plotPreference.reduceMethod,
            option,
            points,
            sleepWindowPoints: sleepWindowStats?.points ?? null,
            averageBedtime: sleepWindowStats?.averageBedtime ?? null,
            averageWakeTime: sleepWindowStats?.averageWakeTime ?? null,
            sleepAxisOffsetMinutes: sleepWindowStats?.axisOffsetMinutes ?? 0,
            values,
            todayValue,
            periodAverage,
            comparison,
            coverage,
            baselineHint,
            domain: yAxis.domain,
            ticks: yAxis.ticks,
          };
        })
        .filter((plot): plot is DashboardPlot => plot !== null);
    },
    [
      checkinsByDateMap,
      dashboardPlotPreferences,
      dashboardPlotOptions,
      metricSummaryByPlotKey,
      questionFieldsById,
      rangePreset,
      records,
    ],
  );
  const filteredDashboardPlots = useMemo(() => {
    const query = plotSearchQuery.trim().toLowerCase();
    if (!query) {
      return dashboardPlots;
    }
    return dashboardPlots.filter((plot) =>
      plot.option.label.toLowerCase().includes(query) || plot.key.toLowerCase().includes(query));
  }, [dashboardPlots, plotSearchQuery]);

  const editableSectionOptions = useMemo(
    () => {
      const sections = buildSectionList(questionLibrary);
      for (const section of customSectionOptions) {
        if (!sections.includes(section)) {
          sections.push(section);
        }
      }
      return sections;
    },
    [customSectionOptions, questionLibrary],
  );
  const sectionUsageCounts = useMemo(
    () =>
      questionLibrary.reduce<Record<string, number>>((counts, question) => {
        const section = normalizeSectionName(question.section);
        counts[section] = (counts[section] ?? 0) + 1;
        return counts;
      }, {}),
    [questionLibrary],
  );
  const serializedQuestionLibrary = useMemo(
    () => JSON.stringify(questionLibrary),
    [questionLibrary],
  );
  const savedQuestionIds = useMemo(() => {
    try {
      const savedQuestions = JSON.parse(lastSavedQuestionsRef.current) as CheckInQuestion[];
      return new Set(savedQuestions.map((question) => question.id));
    } catch {
      return new Set<string>();
    }
  }, [questionLibrary]);
  const isQuestionDirty =
    questionLoadState === "ready" && serializedQuestionLibrary !== lastSavedQuestionsRef.current;
  const todayDateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const lastImportLabel = importSummary.lastImportAt
    ? `${formatReadableDate(importSummary.lastImportAt.slice(0, 10))} ${formatTime(importSummary.lastImportAt)}`
    : "No completed import yet";
  const maxImportDate = formatIsoDateLocal(new Date());
  const firstTrackedDate = allRecords[0]?.date ?? null;
  const yesterdayDate = addIsoDateDays(maxImportDate, -1);
  const maxBackfillDate = [allRecords.at(-1)?.date, yesterdayDate]
    .filter((date): date is string => Boolean(date))
    .sort()[0] ?? null;
  const runningImportDisplay = useMemo(
    () => buildImportProgressDisplay(importSummary, activeImportRange),
    [activeImportRange, importSummary],
  );

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

  const handleOpenImport = () => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 1);
    setImportFromDate(formatIsoDateLocal(start));
    setImportToDate(formatIsoDateLocal(end));
    setImportFeedback(null);
    setShowImportModal(true);
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

  const handleSelectDashboardPlotToAdd = (option: DashboardPlotVariableOption) => {
    setPendingAddPlot(option);
    setPendingAddPlotStep("direction");
    setPendingAddPlotDirection(defaultPlotDirection(option.key));
    setPendingAddPlotChartStyle("line");
    setPendingAddPlotAggregation("daily");
    setPendingAddPlotRolling(false);
    setShowAddPlotMenu(false);
  };

  const handleAddDashboardPlot = (
    plotKey: DashboardPlotVariableKey,
    direction: PlotDirection,
    chartStyle: DashboardPlotChartStyle,
    aggregation: PlotAggregation,
    rolling: boolean,
    reduceMethod: PlotReduceMethod,
  ) => {
    setDashboardPlotPreferences((previous) => [
      ...previous,
      {
        id: createDashboardPlotId(),
        key: plotKey,
        direction,
        chartStyle,
        aggregation,
        rolling,
        reduceMethod: plotKey === "garmin:hrToSpeedRatio" ? "mean" : reduceMethod,
      },
    ]);
    setPendingAddPlot(null);
  };

  const handleRemoveDashboardPlot = (plotId: string) => {
    setDashboardPlotPreferences((previous) => previous.filter((plot) => plot.id !== plotId));
  };

  const handleUpdateDashboardPlot = (
    plotId: string,
    updates: Pick<
      DashboardPlotPreference,
      "direction" | "chartStyle" | "aggregation" | "rolling" | "reduceMethod"
    >,
  ) => {
    setDashboardPlotPreferences((previous) => previous.map((plot) => (
      plot.id === plotId ? { ...plot, ...updates } : plot
    )));
  };

  const handleDashboardPlotSortEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    setDashboardPlotPreferences((previous) => {
      const oldIndex = previous.findIndex((plot) => plot.id === active.id);
      const newIndex = previous.findIndex((plot) => plot.id === over.id);
      if (oldIndex === -1 || newIndex === -1) {
        return previous;
      }
      return arrayMove(previous, oldIndex, newIndex);
    });
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
    pendingQuestionScrollIdRef.current = id;
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
    setCustomSectionOptions((previous) =>
      previous.map((section) => (section === sourceSection ? targetSection : section)),
    );
    setQuestionLibrary((previous) =>
      previous.map((question) =>
        normalizeSectionName(question.section) === sourceSection
          ? { ...question, section: targetSection }
          : question,
      ),
    );
  };

  const addQuestionSection = (section: string) => {
    const nextSection = normalizeSectionName(section);
    setCustomSectionOptions((previous) =>
      previous.includes(nextSection) || editableSectionOptions.includes(nextSection)
        ? previous
        : [...previous, nextSection],
    );
  };

  const removeQuestionSectionOption = (section: string) => {
    const nextSection = normalizeSectionName(section);
    if ((sectionUsageCounts[nextSection] ?? 0) > 0) {
      return;
    }
    setCustomSectionOptions((previous) => previous.filter((candidate) => candidate !== nextSection));
  };

  const removeQuestion = (questionId: string) => {
    setQuestionLibrary((previous) => {
      const next = previous.filter((question) => question.id !== questionId);
      if (selectedQuestionId === questionId) {
        setSelectedQuestionId("");
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

  const applyQuestionBackfill = async (request: QuestionBackfillRequest): Promise<number> => {
    const dates = buildIsoDateRange(request.fromDate, request.toDate);
    const existingEntries = await fetchCheckIns(request.fromDate, request.toDate);
    const existingEntriesByDate = Object.fromEntries(
      existingEntries.entries.map((entry) => [entry.date, entry]),
    );
    let savedCount = 0;
    const nextEntriesByDate = { ...checkinEntriesByDate };

    for (const date of dates) {
      const existingAnswers = existingEntriesByDate[date]?.answers ?? {};
      const payload = await saveCheckIn(date, {
        ...existingAnswers,
        [request.questionId]: request.value,
      });
      nextEntriesByDate[payload.entry.date] = payload.entry;
      savedCount += 1;
    }

    setCheckinEntriesByDate(nextEntriesByDate);
    return savedCount;
  };

  const handleSaveQuestions = async (backfillRequest?: QuestionBackfillRequest | null) => {
    if (!isQuestionDirty || isSavingQuestions) {
      return;
    }
    setIsSavingQuestions(true);
    setQuestionSyncError(null);
    setQuestionBackfillMessage(null);
    try {
      const payload = await saveQuestionSettings(questionLibrary);
      const nextQuestions = migrateQuestionLibrary(payload.questions);
      setQuestionLibrary(nextQuestions);
      lastSavedQuestionsRef.current = JSON.stringify(nextQuestions);
      if (backfillRequest) {
        const savedCount = await applyQuestionBackfill(backfillRequest);
        await loadCorrelationValues();
        setQuestionBackfillMessage(`Backfilled ${savedCount} previous days.`);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save question settings to SQLite.";
      setQuestionSyncError(message);
    } finally {
      setIsSavingQuestions(false);
    }
  };

  const dismissCorrelationNotificationIds = useCallback(async (ids: string[]) => {
    setCorrelationNotifications((current) =>
      current.filter((notification) => !ids.includes(notification.id)),
    );
    try {
      const payload = await dismissCorrelationNotifications(ids);
      setCorrelationNotifications(payload.correlations);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to dismiss notification.";
      setImportFeedback(message);
      await loadDashboardData({ setLoading: false });
    }
  }, [loadDashboardData]);

  const openCorrelationNotification = useCallback((notification: CorrelationNotification) => {
    setPredictorKey(notification.predictor as PredictorKey);
    setOutcomeKey(notification.outcome as OutcomeKey);
    setActiveView("lab");
    void dismissCorrelationNotificationIds([notification.id]);
  }, [dismissCorrelationNotificationIds]);

  const correlationController = useCorrelationFeature({
    records: allRecords,
    analysisValues,
    questions: questionLibrary,
    questionLoadState,
    predictorKey,
    outcomeKey,
    setPredictorKey,
    setOutcomeKey,
  });
  return (
    <div
      ref={appRef}
      className="min-h-screen overflow-x-clip px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-4 text-ink sm:px-6 sm:pb-10 sm:pt-32 lg:px-9"
    >
      {correlationNotifications.length > 0 && (
        <div className="fixed right-3 top-4 z-[65] flex w-[min(50vw,420px)] flex-col gap-2 sm:right-4 sm:top-24 sm:gap-3">
          {correlationNotifications.map((notification) => (
            <div
              key={notification.id}
              className="rounded-[18px] border border-[rgba(18,18,18,0.08)] bg-panel p-3 shadow-soft sm:rounded-[22px] sm:p-4"
              role="status"
            >
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold tracking-tight">New meaningful correlation</p>
                  <p className="mt-1 text-sm text-muted">
                    {notification.predictorLabel} vs {notification.outcomeLabel}
                  </p>
                  <p className="metric-number mt-2 text-xs text-muted">
                    r={formatCorrelationStat(notification.correlation)} · q={notification.qValue.toExponential(2)} · N={notification.sampleCount}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="focusable rounded-capsule bg-accent px-3 py-1.5 text-xs font-semibold text-white"
                      onClick={() => openCorrelationNotification(notification)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="focusable rounded-capsule bg-subsurface px-3 py-1.5 text-xs font-semibold text-muted"
                      onClick={() => void dismissCorrelationNotificationIds([notification.id])}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="focusable rounded-full p-1 text-muted transition hover:bg-subsurface"
                  aria-label="Dismiss correlation notification"
                  onClick={() => void dismissCorrelationNotificationIds([notification.id])}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <header
        className={clsx(
          "z-50 mb-6 rounded-[32px] bg-[rgba(255,255,255,0.78)] p-3 shadow-soft transition sm:fixed sm:inset-x-3 sm:top-4 sm:mb-0 lg:inset-x-7",
          isScrolled && "sm:backdrop-blur-md",
        )}
      >
        <div className="flex flex-col gap-2 sm:overflow-visible">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="panel gsap-fade flex min-h-16 min-w-0 flex-col gap-4 px-4 py-3 sm:flex-none sm:flex-row sm:flex-wrap sm:items-center sm:gap-3 sm:px-3 sm:py-2">
              <div className="shrink-0">
                <p className="text-xs text-muted sm:text-sm">Garmin Selftracker</p>
                <p className="text-base font-semibold tracking-tight sm:text-lg">{todayDateLabel}</p>
              </div>
              <div
                aria-hidden="true"
                className="hidden h-10 w-px shrink-0 bg-[rgba(18,18,18,0.14)] sm:block"
              />
              <div className="max-w-none whitespace-normal sm:max-w-[320px] sm:shrink-0">
                <p className="text-xs uppercase tracking-[0.14em] text-muted">Import</p>
                {runningImportDisplay ? (
                  <>
                    <p className="text-sm font-semibold leading-snug">{runningImportDisplay.title}</p>
                    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-capsule bg-subsurface">
                      <div
                        className="h-full rounded-capsule bg-[color-mix(in_srgb,var(--warning)_76%,white)] transition-[width] duration-500"
                        style={{ width: `${runningImportDisplay.percent}%` }}
                      />
                    </div>
                  </>
                ) : null}
                <p
                  className={clsx(
                    "metric-number text-xs text-muted",
                    importSummary.state === "failed" && "mt-1",
                  )}
                >
                  Last import {lastImportLabel}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                <div className="group relative">
                  <div
                    className={clsx(
                      "rounded-capsule px-3 py-2 text-xs font-semibold sm:px-2.5 sm:py-1.5",
                      importSummary.state === "ok" && "bg-[color-mix(in_srgb,var(--success)_14%,white)] text-success",
                      importSummary.state === "running" && "bg-[color-mix(in_srgb,var(--warning)_16%,white)] text-warning",
                      importSummary.state === "failed"
                        && "bg-[color-mix(in_srgb,var(--error)_16%,white)] text-error",
                    )}
                    tabIndex={importSummary.state === "failed" && importSummary.errorDetail ? 0 : -1}
                  >
                    {IMPORT_STATUS_LABELS[importSummary.state]}
                  </div>
                  {importSummary.state === "failed" && importSummary.errorDetail ? (
                    <div className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-72 whitespace-normal break-words rounded-2xl bg-panel p-3 text-left text-xs leading-relaxed text-muted opacity-0 shadow-soft transition duration-150 group-hover:opacity-100 group-focus-within:opacity-100 sm:block">
                      {importSummary.errorDetail}
                    </div>
                  ) : null}
                </div>
                <button
                  className="focusable min-h-10 rounded-capsule bg-panel px-3 text-xs font-semibold shadow-soft transition disabled:cursor-not-allowed disabled:opacity-60 sm:px-3"
                  disabled={isImportSubmitting}
                  type="button"
                  onClick={handleOpenImport}
                >
                  Import
                </button>
              </div>
              {importFeedback && <p className="text-sm font-medium text-error">{importFeedback}</p>}
            </div>
            <div
              aria-hidden="true"
              className="hidden h-10 w-px shrink-0 bg-[rgba(18,18,18,0.14)] sm:block"
            />

            <nav
              aria-label="Primary navigation"
              className="fixed inset-x-1/2 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[60] flex w-max -translate-x-1/2 items-center rounded-[26px] border border-white/70 bg-[rgba(248,247,243,0.72)] p-1.5 shadow-[0_16px_44px_rgba(18,18,18,0.18),inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-2xl sm:static sm:z-auto sm:min-h-16 sm:w-auto sm:translate-x-0 sm:shrink-0 sm:rounded-panel sm:border-0 sm:bg-panel sm:px-3 sm:py-2 sm:shadow-panel sm:backdrop-blur-none"
            >
              <div className="flex items-center gap-1.5 sm:flex-wrap sm:gap-2">
                {VIEW_BUTTONS.map((button) => (
                  <button
                    key={button.key}
                    aria-current={activeView === button.key ? "page" : undefined}
                    aria-label={button.label}
                    className={clsx(
                      "focusable grid size-12 place-items-center rounded-[19px] text-muted transition-[color,background-color,transform,box-shadow] duration-300 active:scale-90 sm:flex sm:min-h-10 sm:w-auto sm:gap-2 sm:rounded-capsule sm:px-3 sm:text-xs sm:font-semibold sm:shadow-soft",
                      activeView === button.key
                        ? "bg-accent text-white shadow-[0_7px_18px_color-mix(in_srgb,var(--accent)_34%,transparent)]"
                        : "hover:bg-white/55 hover:text-ink sm:bg-panel sm:text-ink",
                    )}
                    type="button"
                    onClick={() => setActiveView(button.key)}
                    title={button.label}
                  >
                    <button.icon className="size-[21px] sm:size-4" strokeWidth={2.1} aria-hidden="true" />
                    <span className="hidden sm:inline">{button.label}</span>
                  </button>
                ))}
              </div>
            </nav>
          </div>
        </div>
      </header>

      <main
        ref={mainRef}
        className="mx-auto flex w-full max-w-[1400px] touch-pan-y flex-col gap-8"
        onTouchCancel={() => {
          swipeStartRef.current = null;
          void resetDraggedView();
        }}
        onTouchEnd={handleViewTouchEnd}
        onTouchMove={handleViewTouchMove}
        onTouchStart={handleViewTouchStart}
      >
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
          <section ref={heroRef} className="panel gsap-fade overflow-hidden p-4 sm:p-10">
            <div className="min-h-[42vh] rounded-[30px] bg-[radial-gradient(circle_at_0%_5%,#ffffff_0%,#f8f6f1_40%,#efede6_100%)] p-3 shadow-inset sm:p-8">
              <p className="text-sm text-muted">{rangePreset}-Day Dashboard</p>
              <div className="mt-4 grid w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl xl:text-5xl">Dashboard</h1>
                <div className="flex w-full flex-col items-start gap-3 lg:w-auto lg:items-center lg:justify-self-center">
                  <div
                    className="scrollbar-hide flex w-full touch-pan-x flex-nowrap gap-2 overflow-x-auto rounded-[24px] bg-subsurface p-1 sm:w-fit sm:rounded-capsule"
                    data-swipe-ignore
                  >
                    {RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        className={clsx(
                          "focusable min-h-10 min-w-0 shrink-0 rounded-capsule px-3 text-xs font-semibold transition sm:min-h-11 sm:px-4 sm:text-sm",
                          rangePreset === preset ? "bg-accent text-white" : "text-muted hover:text-ink",
                        )}
                        type="button"
                        onClick={() => setRangePreset(preset)}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                  <p className="text-left text-base text-muted lg:text-center lg:text-lg">
                    Today vs rolling {rangePreset}-day average.
                  </p>
                </div>
                <div ref={addPlotMenuRef} className="relative w-full lg:w-fit lg:justify-self-end">
                  <button
                    aria-expanded={showAddPlotMenu}
                    className="focusable min-h-11 w-full rounded-capsule bg-accent px-4 text-sm font-semibold text-white shadow-soft transition lg:w-auto"
                    type="button"
                    onClick={() => setShowAddPlotMenu((previous) => !previous)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <CirclePlus className="size-4" />
                      Add plot
                    </span>
                  </button>
                  {showAddPlotMenu && (
                    <div className="absolute inset-x-0 top-full z-20 mt-2 rounded-2xl bg-panel p-2 shadow-soft sm:left-auto sm:right-0 sm:w-72">
                      <input
                        className="focusable mb-2 min-h-10 w-full rounded-xl bg-subsurface px-3 text-sm"
                        placeholder="Search plots"
                        type="search"
                        value={addPlotSearchQuery}
                        onChange={(event) => setAddPlotSearchQuery(event.target.value)}
                      />
                      {addableDashboardPlotOptions.length ? (
                        <div className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto overscroll-contain pr-1">
                          {addableDashboardPlotOptions.map((option) => (
                            <button
                              key={option.key}
                              className="focusable w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-subsurface"
                              type="button"
                              onClick={() => handleSelectDashboardPlotToAdd(option)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="px-2 py-2 text-sm text-muted">
                          No plots match your search.
                        </p>
                      )}
                    </div>
                  )}
                  {pendingAddPlot && (
                    <div className="absolute inset-x-0 top-full z-20 mt-2 rounded-2xl bg-panel p-3 shadow-soft sm:left-auto sm:right-0 sm:w-72">
                      <p className="text-xs uppercase tracking-[0.14em] text-muted">Plot preference</p>
                      <p className="mt-1 text-sm font-semibold">{pendingAddPlot.label}</p>
                      {pendingAddPlotStep === "direction" && (
                        <>
                          <p className="mt-1 text-xs text-muted">For comparison, is higher better or lower better?</p>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              className="focusable min-h-10 rounded-xl bg-accent px-3 text-xs font-semibold text-white"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotDirection("higher");
                                setPendingAddPlotStep(
                                  pendingAddPlot.key === "garmin:sleepConsistency"
                                    ? "chartStyle"
                                    : "aggregation",
                                );
                              }}
                            >
                              Higher better
                            </button>
                            <button
                              className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotDirection("lower");
                                setPendingAddPlotStep(
                                  pendingAddPlot.key === "garmin:sleepConsistency"
                                    ? "chartStyle"
                                    : "aggregation",
                                );
                              }}
                            >
                              Lower better
                            </button>
                          </div>
                        </>
                      )}
                      {pendingAddPlotStep === "chartStyle" && (
                        <>
                          <p className="mt-1 text-xs text-muted">Choose the Sleep Timing Variability chart style.</p>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              className="focusable min-h-10 rounded-xl bg-accent px-3 text-xs font-semibold text-white"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotChartStyle("line");
                                setPendingAddPlotStep("aggregation");
                              }}
                            >
                              Line
                            </button>
                            <button
                              className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                              type="button"
                              onClick={() => handleAddDashboardPlot(
                                pendingAddPlot.key,
                                pendingAddPlotDirection,
                                "sleepWindowBars",
                                "daily",
                                false,
                                "mean",
                              )}
                            >
                              Bed/Wake bars
                            </button>
                          </div>
                        </>
                      )}
                      {pendingAddPlotStep === "aggregation" && (
                        <>
                          <p className="mt-1 text-xs text-muted">How should data be aggregated?</p>
                          <div className="mt-3 grid grid-cols-3 gap-2">
                            <button
                              className="focusable min-h-10 rounded-xl bg-accent px-3 text-xs font-semibold text-white"
                              type="button"
                              onClick={() => handleAddDashboardPlot(
                                pendingAddPlot.key,
                                pendingAddPlotDirection,
                                pendingAddPlotChartStyle,
                                "daily",
                                false,
                                "mean",
                              )}
                            >
                              Daily
                            </button>
                            <button
                              className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotAggregation("3days");
                                setPendingAddPlotStep("rolling");
                              }}
                            >
                              3-Days
                            </button>
                            <button
                              className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotAggregation("weekly");
                                setPendingAddPlotStep("rolling");
                              }}
                            >
                              Weekly
                            </button>
                          </div>
                        </>
                      )}
                      {pendingAddPlotStep === "rolling" && (
                        <>
                          <p className="mt-1 text-xs text-muted">Use a rolling average or fixed periods?</p>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button
                              className="focusable min-h-10 rounded-xl bg-accent px-3 text-xs font-semibold text-white"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotRolling(true);
                                setPendingAddPlotStep("reduceMethod");
                              }}
                            >
                              Rolling
                            </button>
                            <button
                              className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                              type="button"
                              onClick={() => {
                                setPendingAddPlotRolling(false);
                                setPendingAddPlotStep("reduceMethod");
                              }}
                            >
                              Fixed periods
                            </button>
                          </div>
                        </>
                      )}
                      {pendingAddPlotStep === "reduceMethod" && (
                        <>
                          <p className="mt-1 text-xs text-muted">
                            {pendingAddPlot.key === "garmin:hrToSpeedRatio"
                              ? "The ratio uses average HR divided by average speed."
                              : "Should values be averaged or summed?"}
                          </p>
                          <div className={clsx(
                            "mt-3 grid gap-2",
                            pendingAddPlot.key === "garmin:hrToSpeedRatio" ? "grid-cols-1" : "grid-cols-2",
                          )}>
                            <button
                              className="focusable min-h-10 rounded-xl bg-accent px-3 text-xs font-semibold text-white"
                              type="button"
                              onClick={() => handleAddDashboardPlot(
                                pendingAddPlot.key,
                                pendingAddPlotDirection,
                                pendingAddPlotChartStyle,
                                pendingAddPlotAggregation,
                                pendingAddPlotRolling,
                                "mean",
                              )}
                            >
                              {pendingAddPlot.key === "garmin:hrToSpeedRatio" ? "Use averaged components" : "Average"}
                            </button>
                            {pendingAddPlot.key !== "garmin:hrToSpeedRatio" && (
                              <button
                                className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                                type="button"
                                onClick={() => handleAddDashboardPlot(
                                  pendingAddPlot.key,
                                  pendingAddPlotDirection,
                                  pendingAddPlotChartStyle,
                                  pendingAddPlotAggregation,
                                  pendingAddPlotRolling,
                                  "sum",
                                )}
                              >
                                Sum
                              </button>
                            )}
                          </div>
                        </>
                      )}
                      <button
                        className="focusable mt-2 min-h-10 w-full rounded-xl bg-panel px-3 text-xs text-muted"
                        type="button"
                        onClick={() => setPendingAddPlot(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <input
                  className="focusable min-h-11 w-full rounded-2xl border border-[rgba(18,18,18,0.4)] bg-panel px-3 text-sm lg:max-w-md"
                  placeholder="Search metrics and plots"
                  type="search"
                  value={plotSearchQuery}
                  onChange={(event) => setPlotSearchQuery(event.target.value)}
                />
                {(plotSettingsLoadState === "loading" || isSavingPlotSettings || plotSettingsError) && (
                  <p className={clsx("text-xs", plotSettingsError ? "text-error" : "text-muted")}>
                    {plotSettingsLoadState === "loading"
                      ? "Loading plot layout..."
                      : isSavingPlotSettings
                        ? "Saving plot layout..."
                        : `Plot layout sync failed: ${plotSettingsError}`}
                  </p>
                )}
              </div>

              <DndContext sensors={sensors} onDragEnd={handleDashboardPlotSortEnd}>
                <SortableContext
                  items={filteredDashboardPlots.map((plot) => plot.id)}
                  strategy={rectSortingStrategy}
                >
                  {filteredDashboardPlots.length ? (
                    <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-8 sm:gap-4 xl:grid-cols-3">
                      {filteredDashboardPlots.map((plot) => (
                        <SortableDashboardPlotItem
                          key={plot.id}
                          dataStatus={dataStatus}
                          importState={todayRecord.importState}
                          plot={plot}
                          rangePreset={rangePreset}
                          onOpenStatus={() => setActiveView("settings")}
                          onUpdate={handleUpdateDashboardPlot}
                          onRemove={handleRemoveDashboardPlot}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="mt-6 rounded-2xl bg-panel px-4 py-3 text-sm text-muted">
                      No plots match your search.
                    </p>
                  )}
                </SortableContext>
              </DndContext>

            </div>
          </section>
        )}

        {activeView === "lab" && <CorrelationFeature controller={correlationController} />}
        {activeView === "checkin" && <CheckinFeature controller={checkin} />}
        {activeView === "settings" && (
          <section className="panel gsap-fade p-6 sm:p-8">
            <div className="space-y-5">
              <NotificationSettings />
              <CheckinReminderSettings />

              <article className="rounded-[24px] bg-subsurface p-5">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold">Heart Rate Zone Bounds</h3>
                  <p className="mt-1 text-sm text-muted">
                    {hrZoneBounds
                      ? "Detected from Garmin activities during sync."
                      : "No zone bounds detected yet. Run a sync with at least one activity."}
                  </p>
                </div>
                {hrZoneBounds && (
                  <div className="flex flex-wrap gap-2">
                    {hrZoneBounds.map((bound, index) => (
                      <div key={index} className="rounded-2xl bg-panel px-4 py-3 text-sm">
                        <span className="block text-xs uppercase tracking-[0.14em] text-muted">
                          Zone {index + 1} starts
                        </span>
                        <span className="font-semibold">{bound} bpm</span>
                      </div>
                    ))}
                  </div>
                )}
              </article>

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
                            : isQuestionDirty
                              ? "Unsaved changes. Click save to update SQLite."
                            : "Synced with SQLite."}
                    </p>
                    {questionBackfillMessage && (
                      <p className="mt-1 text-sm text-success">{questionBackfillMessage}</p>
                    )}
                  </div>
                  <button
                    className="focusable min-h-11 rounded-capsule bg-accent px-4 text-sm font-semibold text-white shadow-soft transition"
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
                              <div ref={selectedQuestionEditorRef}>
                                <QuestionEditor
                                  availableSections={editableSectionOptions}
                                  firstTrackedDate={firstTrackedDate}
                                  isSaveDisabled={
                                    !isQuestionDirty
                                    || isSavingQuestions
                                    || questionLoadState !== "ready"
                                  }
                                  isSaving={isSavingQuestions}
                                  isNewQuestion={!savedQuestionIds.has(question.id)}
                                  maxBackfillDate={maxBackfillDate}
                                  sectionUsageCounts={sectionUsageCounts}
                                  onAddSection={addQuestionSection}
                                  onRemoveSection={removeQuestionSectionOption}
                                  onRenameSection={renameQuestionSection}
                                  onSave={(backfillRequest) =>
                                    void handleSaveQuestions(backfillRequest)
                                  }
                                  question={question}
                                  onDelete={() => removeQuestion(question.id)}
                                  onPatch={(patch) => updateQuestion(question.id, patch)}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              </article>
            </div>
          </section>
        )}
      </main>

      {showImportModal && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-[rgba(18,18,18,0.2)] p-4 backdrop-blur-xs">
          <div className="panel w-full max-w-lg p-6">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Import Garmin Data</h2>
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

function SortableDashboardPlotItem({
  dataStatus,
  importState,
  plot,
  rangePreset,
  onOpenStatus,
  onUpdate,
  onRemove,
}: {
  dataStatus: "loading" | "ready" | "error";
  importState: ImportState;
  plot: DashboardPlot;
  rangePreset: number;
  onOpenStatus: () => void;
  onUpdate: (
    plotId: string,
    updates: Pick<
      DashboardPlotPreference,
      "direction" | "chartStyle" | "aggregation" | "rolling" | "reduceMethod"
    >,
  ) => void;
  onRemove: (plotId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: plot.id });
  const [isEditing, setIsEditing] = useState(false);
  const [draftDirection, setDraftDirection] = useState<PlotDirection>(plot.direction);
  const [draftChartStyle, setDraftChartStyle] = useState<DashboardPlotChartStyle>(plot.chartStyle);
  const [draftAggregation, setDraftAggregation] = useState<PlotAggregation>(plot.aggregation);
  const [draftRolling, setDraftRolling] = useState(plot.rolling);
  const [draftReduceMethod, setDraftReduceMethod] = useState<PlotReduceMethod>(plot.reduceMethod);
  const coverageMeta = COVERAGE_META[plot.coverage];
  const isMissing = plot.coverage === "missing";
  const isPartial = plot.coverage === "partial";
  const loadingState = importState === "running" && plot.coverage !== "complete";
  const errorState = (importState === "failed" || dataStatus === "error") && isMissing;
  const showSleepWindowBars = plot.chartStyle === "sleepWindowBars" && plot.sleepWindowPoints !== null;
  const supportsSleepWindowBars = plot.key === "garmin:sleepConsistency";

  const openEditor = () => {
    setDraftDirection(plot.direction);
    setDraftChartStyle(plot.chartStyle);
    setDraftAggregation(plot.aggregation);
    setDraftRolling(plot.rolling);
    setDraftReduceMethod(plot.reduceMethod);
    setIsEditing(true);
  };
  const saveEditor = () => {
    const isSleepWindowBars = draftChartStyle === "sleepWindowBars";
    const isDaily = draftAggregation === "daily";
    const isRatio = plot.key === "garmin:hrToSpeedRatio";
    onUpdate(plot.id, {
      direction: draftDirection,
      chartStyle: draftChartStyle,
      aggregation: isSleepWindowBars ? "daily" : draftAggregation,
      rolling: isSleepWindowBars || isDaily ? false : draftRolling,
      reduceMethod: isSleepWindowBars || isDaily || isRatio ? "mean" : draftReduceMethod,
    });
    setIsEditing(false);
  };
  const choiceClass = (active: boolean) => clsx(
    "focusable min-h-9 rounded-xl px-3 text-xs font-semibold transition",
    active ? "bg-accent text-white" : "bg-subsurface text-ink hover:text-accent",
  );

  const aggregationLabel =
    showSleepWindowBars
      ? "Bed/Wake bars"
      : plot.aggregation === "3days"
      ? plot.rolling
        ? `3-day rolling ${plot.reduceMethod === "sum" ? "sum" : "avg"}`
        : `3-day periods ${plot.reduceMethod === "sum" ? "sum" : "avg"}`
      : plot.aggregation === "weekly"
        ? plot.rolling
          ? `Weekly rolling ${plot.reduceMethod === "sum" ? "sum" : "avg"}`
          : `Weekly periods ${plot.reduceMethod === "sum" ? "sum" : "avg"}`
        : null;

  return (
    <article
      ref={setNodeRef}
      className={clsx(
        "mx-auto w-full rounded-[20px] bg-panel p-3 shadow-soft sm:rounded-[24px] sm:p-5",
        isEditing && "col-span-2 sm:col-span-1",
      )}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted sm:text-sm">{plot.option.label}</p>
          {aggregationLabel && (
            <p className="mt-0.5 text-[10px] text-muted sm:text-xs">{aggregationLabel}</p>
          )}
          <p className="metric-number mt-1.5 text-xl font-semibold tracking-tight sm:mt-2 sm:text-3xl">
            {plot.key === "garmin:hrToSpeedRatio" && plot.todayValue !== null
              ? plot.todayValue.toFixed(1)
              : formatDashboardValue(plot.key, plot.option, plot.todayValue)}
          </p>
          {plot.key === "garmin:hrToSpeedRatio" && plot.todayValue !== null && (
            <p className="metric-number text-[10px] text-muted sm:text-xs">bpm per km/h</p>
          )}
          <p className="metric-number mt-1 text-[10px] text-muted sm:text-xs">
            {rangePreset}d average {formatDashboardValue(plot.key, plot.option, plot.periodAverage)}
          </p>
          <p className={clsx("mt-1 hidden text-xs font-medium sm:block", plot.comparison.tone)}>{plot.comparison.text}</p>
        </div>
        <div className="flex flex-wrap items-start gap-1 sm:justify-end sm:gap-2">
          <span className={clsx("rounded-capsule px-2 py-1 text-[10px] font-semibold sm:px-3 sm:text-xs", coverageMeta.tone)}>
            {coverageMeta.label}
          </span>
          <button
            aria-label={`Edit ${plot.option.label} plot`}
            className="focusable min-h-8 rounded-capsule bg-subsurface px-2 text-muted transition hover:text-ink sm:min-h-9 sm:px-3"
            type="button"
            onClick={openEditor}
          >
            <Pencil className="size-3.5 sm:size-4" />
          </button>
          <button
            aria-label={`Remove ${plot.option.label} plot`}
            className="focusable min-h-8 rounded-capsule bg-subsurface px-2 text-muted transition hover:text-ink sm:min-h-9 sm:px-3"
            type="button"
            onClick={() => onRemove(plot.id)}
          >
            <X className="size-3.5 sm:size-4" />
          </button>
          <button
            aria-label={`Reorder ${plot.option.label} plot`}
            className="focusable min-h-8 rounded-capsule bg-subsurface px-2 text-muted transition hover:text-ink sm:min-h-9 sm:px-3"
            type="button"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5 sm:size-4" />
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="mt-4 rounded-2xl bg-subsurface p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Edit plot</p>
            <div className="flex gap-2">
              <button
                aria-label={`Save ${plot.option.label} plot settings`}
                className="focusable min-h-9 rounded-capsule bg-accent px-3 text-white"
                type="button"
                onClick={saveEditor}
              >
                <Check className="size-4" />
              </button>
              <button
                aria-label={`Cancel editing ${plot.option.label} plot`}
                className="focusable min-h-9 rounded-capsule bg-panel px-3 text-muted transition hover:text-ink"
                type="button"
                onClick={() => setIsEditing(false)}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3">
            <div>
              <p className="mb-2 text-xs text-muted">Comparison</p>
              <div className="grid grid-cols-2 gap-2">
                <button className={choiceClass(draftDirection === "higher")} type="button" onClick={() => setDraftDirection("higher")}>
                  Higher better
                </button>
                <button className={choiceClass(draftDirection === "lower")} type="button" onClick={() => setDraftDirection("lower")}>
                  Lower better
                </button>
              </div>
            </div>

            {supportsSleepWindowBars && (
              <div>
                <p className="mb-2 text-xs text-muted">Chart</p>
                <div className="grid grid-cols-2 gap-2">
                  <button className={choiceClass(draftChartStyle === "line")} type="button" onClick={() => setDraftChartStyle("line")}>
                    Line
                  </button>
                  <button className={choiceClass(draftChartStyle === "sleepWindowBars")} type="button" onClick={() => setDraftChartStyle("sleepWindowBars")}>
                    Bed/Wake bars
                  </button>
                </div>
              </div>
            )}

            {draftChartStyle !== "sleepWindowBars" && (
              <>
                <div>
                  <p className="mb-2 text-xs text-muted">Aggregation</p>
                  <div className="grid grid-cols-3 gap-2">
                    <button className={choiceClass(draftAggregation === "daily")} type="button" onClick={() => setDraftAggregation("daily")}>
                      Daily
                    </button>
                    <button className={choiceClass(draftAggregation === "3days")} type="button" onClick={() => setDraftAggregation("3days")}>
                      3-Days
                    </button>
                    <button className={choiceClass(draftAggregation === "weekly")} type="button" onClick={() => setDraftAggregation("weekly")}>
                      Weekly
                    </button>
                  </div>
                </div>

                {draftAggregation !== "daily" && (
                  <>
                    <div>
                      <p className="mb-2 text-xs text-muted">Period</p>
                      <div className="grid grid-cols-2 gap-2">
                        <button className={choiceClass(draftRolling)} type="button" onClick={() => setDraftRolling(true)}>
                          Rolling
                        </button>
                        <button className={choiceClass(!draftRolling)} type="button" onClick={() => setDraftRolling(false)}>
                          Fixed periods
                        </button>
                      </div>
                    </div>

                    {plot.key === "garmin:hrToSpeedRatio" ? (
                      <p className="text-xs text-muted">Average HR ÷ average speed</p>
                    ) : (
                      <div>
                        <p className="mb-2 text-xs text-muted">Reduce</p>
                        <div className="grid grid-cols-2 gap-2">
                          <button className={choiceClass(draftReduceMethod === "mean")} type="button" onClick={() => setDraftReduceMethod("mean")}>
                            Average
                          </button>
                          <button className={choiceClass(draftReduceMethod === "sum")} type="button" onClick={() => setDraftReduceMethod("sum")}>
                            Sum
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 h-20 sm:mt-4 lg:h-16">
        {showSleepWindowBars ? (
          <SleepWindowChart
            averageBedtime={plot.averageBedtime}
            averageWakeTime={plot.averageWakeTime}
            axisOffsetMinutes={plot.sleepAxisOffsetMinutes}
            barColor={plot.option.color}
            chartId={plot.id}
            domain={plot.domain}
            points={plot.sleepWindowPoints ?? []}
          />
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={plot.points}>
              <YAxis
                allowDecimals={plot.key === "garmin:runningKilometers"}
                axisLine={{ stroke: "rgba(18,18,18,0.28)", strokeWidth: 1 }}
                domain={plot.domain}
                interval={0}
                tickFormatter={(value) => (
                  plot.key === "garmin:runningKilometers" && typeof value === "number"
                    ? value.toFixed(1)
                    : String(value)
                )}
                tickLine={false}
                tick={{ fontSize: 10 }}
                ticks={plot.ticks}
                width={34}
              />
              {plot.periodAverage !== null && (
                <ReferenceLine
                  ifOverflow="extendDomain"
                  stroke="rgba(18,18,18,0.45)"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  y={plot.periodAverage}
                />
              )}
              <Line
                dataKey="value"
                dot={{ fill: plot.option.color, r: 2.5, strokeWidth: 0 }}
                activeDot={{ fill: plot.option.color, r: 4, strokeWidth: 0 }}
                stroke={plot.option.color}
                strokeWidth={2}
                type="monotone"
              />
              <Tooltip content={<SparklineTooltip option={plot.option} plotKey={plot.key} />} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-2 min-h-0 text-[10px] text-muted sm:mt-3 sm:min-h-8 sm:text-xs">
        {loadingState ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-warning">
            <LoaderCircle className="size-3 animate-spin" />
            <span className="hidden sm:inline">
              Import in progress. This tile will update when sync completes.
            </span>
          </span>
        ) : errorState ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-error">
            <AlertCircle className="size-3" />
            <span className="hidden sm:inline">
              {dataStatus === "error" ? "Unable to load data API." : "No data yet. Last import failed."}
            </span>
            <button
              className="focusable hidden rounded-capsule bg-[color-mix(in_srgb,var(--error)_14%,white)] px-2 py-1 text-[11px] sm:inline"
              type="button"
              onClick={onOpenStatus}
            >
              Open status
            </button>
          </span>
        ) : isPartial ? (
          <span className="hidden sm:inline">
            Partial telemetry. {rangePreset}-day average uses available samples only.
          </span>
        ) : (
          <span className="hidden sm:inline">{plot.baselineHint}</span>
        )}
      </div>
    </article>
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
  firstTrackedDate,
  isSaveDisabled,
  isSaving,
  isNewQuestion,
  maxBackfillDate,
  sectionUsageCounts,
  onAddSection,
  onRemoveSection,
  onRenameSection,
  onSave,
  question,
  onPatch,
  onDelete,
}: {
  availableSections: string[];
  firstTrackedDate: string | null;
  isSaveDisabled: boolean;
  isSaving: boolean;
  isNewQuestion: boolean;
  maxBackfillDate: string | null;
  sectionUsageCounts: Record<string, number>;
  onAddSection: (section: string) => void;
  onRemoveSection: (section: string) => void;
  onRenameSection: (source: string, target: string) => void;
  onSave: (backfillRequest?: QuestionBackfillRequest | null) => void;
  question: CheckInQuestion;
  onPatch: (patch: Partial<CheckInQuestion>) => void;
  onDelete: () => void;
}) {
  const children = question.children ?? [];
  const canAddChild = children.length < 3;
  const [showAnalysisHelp, setShowAnalysisHelp] = useState(false);
  const [showBackfillHelp, setShowBackfillHelp] = useState(false);
  const [activeConditionHelpChildId, setActiveConditionHelpChildId] = useState<string | null>(null);
  const [isSectionEditorOpen, setIsSectionEditorOpen] = useState(false);
  const [sectionEditorMode, setSectionEditorMode] = useState<"add" | "rename">("add");
  const [sectionEditorValue, setSectionEditorValue] = useState("");
  const [isBackfillActive, setIsBackfillActive] = useState(false);
  const [backfillAnswer, setBackfillAnswer] = useState<AnswerValue>(() =>
    defaultAnswerForQuestion(question),
  );
  const [backfillRange, setBackfillRange] = useState<BackfillRangePreset>("all");
  const [customBackfillFromDate, setCustomBackfillFromDate] = useState(firstTrackedDate ?? "");
  const [customBackfillToDate, setCustomBackfillToDate] = useState(maxBackfillDate ?? "");
  const inputTagClass = "text-[10px] uppercase tracking-[0.12em] text-muted";
  const normalizedSection = normalizeSectionName(question.section);
  const sectionOptions = availableSections.includes(normalizedSection)
    ? availableSections
    : [...availableSections, normalizedSection];
  const hasBackfillWindow =
    Boolean(firstTrackedDate && maxBackfillDate && firstTrackedDate <= maxBackfillDate);

  useEffect(() => {
    setBackfillAnswer(defaultAnswerForQuestion(question));
    setIsBackfillActive(false);
    setShowBackfillHelp(false);
  }, [question.id, question.inputType]);

  useEffect(() => {
    if (firstTrackedDate) {
      setCustomBackfillFromDate(firstTrackedDate);
    }
  }, [firstTrackedDate]);

  useEffect(() => {
    if (maxBackfillDate) {
      setCustomBackfillToDate(maxBackfillDate);
    }
  }, [maxBackfillDate]);

  const resolveBackfillDates = (): Pick<QuestionBackfillRequest, "fromDate" | "toDate"> | null => {
    if (!hasBackfillWindow || !firstTrackedDate || !maxBackfillDate || backfillRange === "none") {
      return null;
    }
    if (backfillRange === "all") {
      return { fromDate: firstTrackedDate, toDate: maxBackfillDate };
    }
    if (backfillRange === "custom") {
      if (!parseIsoDate(customBackfillFromDate) || !parseIsoDate(customBackfillToDate)) {
        return null;
      }
      if (customBackfillFromDate < firstTrackedDate || customBackfillToDate > maxBackfillDate) {
        return null;
      }
      return customBackfillFromDate <= customBackfillToDate
        ? { fromDate: customBackfillFromDate, toDate: customBackfillToDate }
        : null;
    }

    const start = addIsoDateDays(maxBackfillDate, -(Number(backfillRange) - 1));
    if (!start) {
      return null;
    }
    return { fromDate: start < firstTrackedDate ? firstTrackedDate : start, toDate: maxBackfillDate };
  };

  const resolvedBackfillDates = resolveBackfillDates();
  const backfillDays = resolvedBackfillDates
    ? rangeDaysInclusive(resolvedBackfillDates.fromDate, resolvedBackfillDates.toDate)
    : null;
  const isBackfillEnabled =
    isNewQuestion && isBackfillActive && hasBackfillWindow && backfillRange !== "none";
  const isBackfillInvalid =
    isBackfillEnabled && (!resolvedBackfillDates || !isValidQuestionAnswer(question, backfillAnswer));
  const buildBackfillRequest = (): QuestionBackfillRequest | null => {
    if (!isBackfillEnabled || !resolvedBackfillDates || isBackfillInvalid) {
      return null;
    }
    return {
      questionId: question.id,
      value: backfillAnswer,
      ...resolvedBackfillDates,
    };
  };

  const closeSectionEditor = () => {
    setIsSectionEditorOpen(false);
    setSectionEditorValue("");
  };

  const openAddSectionEditor = () => {
    setIsSectionEditorOpen(true);
    setSectionEditorMode("add");
    setSectionEditorValue("");
  };

  const openRenameSectionEditor = () => {
    setIsSectionEditorOpen(true);
    setSectionEditorMode("rename");
    setSectionEditorValue(normalizedSection);
  };

  const submitSectionEditor = () => {
    const nextSection = normalizeSectionName(sectionEditorValue);
    if (sectionEditorMode === "add") {
      onAddSection(nextSection);
      onPatch({ section: nextSection });
    }
    if (sectionEditorMode === "rename") {
      onRenameSection(normalizedSection, nextSection);
    }
    closeSectionEditor();
  };

  const removeCurrentSection = () => {
    if ((sectionUsageCounts[normalizedSection] ?? 0) > 0) {
      return;
    }
    onRemoveSection(normalizedSection);
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

  const buildDefaultChildCondition = (): ChildCondition => {
    if (question.inputType === "slider") {
      return { operator: "greater_than", value: question.min ?? 0 };
    }
    if (question.inputType === "boolean") {
      return { operator: "equals", value: true };
    }
    if (question.inputType === "multi-choice") {
      return { operator: "equals", value: question.options?.[0]?.id ?? "" };
    }
    return { operator: "non_empty" };
  };

  const addChild = () => {
    if (!canAddChild) {
      return;
    }
    const nextChild: CheckInQuestionChild = {
      id: `${question.id}_child_${Date.now()}`,
      prompt: "Follow-up question",
      inputType: "text",
      analysisMode: question.analysisMode,
      condition: buildDefaultChildCondition(),
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
            <div key={`${field.id}_${index}`} className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
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
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="relative space-y-1">
            <p className={inputTagClass}>Section</p>
            <div className="flex w-full gap-2 sm:w-72">
              <select
                className="focusable min-h-11 min-w-0 flex-1 rounded-2xl bg-panel px-3"
                value={normalizedSection}
                onChange={(event) => onPatch({ section: event.target.value })}
              >
                {sectionOptions.map((section) => (
                  <option key={section} value={section}>
                    {section}
                  </option>
                ))}
              </select>
              <button
                aria-label="Edit section options"
                className="focusable grid min-h-11 w-11 place-items-center rounded-2xl bg-panel text-muted transition hover:text-ink"
                type="button"
                onClick={() => {
                  if (isSectionEditorOpen) {
                    closeSectionEditor();
                    return;
                  }
                  openAddSectionEditor();
                }}
              >
                <Pencil className="size-4" />
              </button>
            </div>
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
        {isSectionEditorOpen && (
          <div className="rounded-2xl bg-panel p-3">
            <div className="mb-3 flex flex-wrap gap-2">
              <button
                className={clsx(
                  "focusable min-h-10 rounded-capsule px-3 text-xs",
                  sectionEditorMode === "add" ? "bg-accent text-white" : "bg-subsurface",
                )}
                type="button"
                onClick={openAddSectionEditor}
              >
                Add
              </button>
              <button
                className={clsx(
                  "focusable min-h-10 rounded-capsule px-3 text-xs",
                  sectionEditorMode === "rename" ? "bg-accent text-white" : "bg-subsurface",
                )}
                type="button"
                onClick={openRenameSectionEditor}
              >
                Rename current
              </button>
              <button
                className="focusable min-h-10 rounded-capsule bg-[color-mix(in_srgb,var(--error)_16%,white)] px-3 text-xs text-error disabled:cursor-not-allowed disabled:opacity-50"
                disabled={(sectionUsageCounts[normalizedSection] ?? 0) > 0}
                type="button"
                onClick={removeCurrentSection}
              >
                Delete current
              </button>
            </div>
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
            {(sectionUsageCounts[normalizedSection] ?? 0) > 0 && (
              <p className="mt-2 text-xs text-muted">
                Delete is available only for empty sections.
              </p>
            )}
          </div>
        )}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Analysis mode</p>
            <div
              className="relative"
            >
              <button
                aria-label="Analysis mode help"
                className="focusable rounded-capsule bg-panel p-1 text-muted transition hover:text-ink"
                type="button"
                onClick={() => setShowAnalysisHelp((previous) => !previous)}
              >
                <CircleHelp className="size-4" />
              </button>
            </div>
          </div>
          {showAnalysisHelp && (
            <div className="w-full max-w-sm rounded-2xl bg-panel p-3 text-xs text-muted shadow-soft">
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

        {isNewQuestion && (
          <div className="rounded-2xl bg-panel p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <label className="flex min-w-0 items-center gap-3 text-sm font-semibold">
                <input
                  className="size-4 accent-accent"
                  type="checkbox"
                  checked={isBackfillActive}
                  onChange={(event) => setIsBackfillActive(event.target.checked)}
                />
                <span>Answer previous days</span>
              </label>
              <button
                aria-label="Answer previous days help"
                className="focusable rounded-capsule bg-subsurface p-1 text-muted transition hover:text-ink"
                type="button"
                onClick={() => setShowBackfillHelp((previous) => !previous)}
              >
                <CircleHelp className="size-4" />
              </button>
            </div>
            {showBackfillHelp && (
              <div className="mb-3 w-full max-w-sm rounded-2xl bg-subsurface p-3 text-xs text-muted shadow-soft">
                Applies one answer to past days when saving this new question. Useful when
                starting a new habit and you already know the answer was "No" before today.
              </div>
            )}
            {isBackfillActive && !hasBackfillWindow ? (
              <p className="rounded-2xl bg-subsurface px-3 py-2 text-xs text-muted">
                Previous-day answers are available after at least one earlier tracked day exists.
              </p>
            ) : isBackfillActive ? (
              <div className="max-w-2xl space-y-3">
                <div className="grid gap-2 sm:grid-cols-[220px_minmax(0,320px)]">
                  <div className="space-y-1">
                    <p className={inputTagClass}>Range</p>
                    <select
                      className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3"
                      value={backfillRange}
                      onChange={(event) => setBackfillRange(event.target.value as BackfillRangePreset)}
                    >
                      <option value="all">
                        From the start ({formatShortNumericDate(firstTrackedDate ?? "")})
                      </option>
                      <option value="30">Last 30 days</option>
                      <option value="14">Last 14 days</option>
                      <option value="7">Last 7 days</option>
                      <option value="custom">Custom range</option>
                      <option value="none">Do not backfill</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <p className={inputTagClass}>Answer</p>
                    {backfillRange === "none" ? (
                      <p className="flex min-h-11 items-center rounded-2xl bg-subsurface px-3 text-xs text-muted">
                        No previous days will be changed.
                      </p>
                    ) : (
                      <QuestionAnswerInput
                        panelClassName="bg-subsurface"
                        question={question}
                        value={backfillAnswer}
                        onChange={setBackfillAnswer}
                      />
                    )}
                  </div>
                </div>
                {backfillRange === "custom" && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <p className={inputTagClass}>From</p>
                      <input
                        className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3"
                        max={customBackfillToDate || maxBackfillDate || undefined}
                        min={firstTrackedDate ?? undefined}
                        type="date"
                        value={customBackfillFromDate}
                        onChange={(event) => setCustomBackfillFromDate(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <p className={inputTagClass}>To</p>
                      <input
                        className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3"
                        max={maxBackfillDate ?? undefined}
                        min={customBackfillFromDate || firstTrackedDate || undefined}
                        type="date"
                        value={customBackfillToDate}
                        onChange={(event) => setCustomBackfillToDate(event.target.value)}
                      />
                    </div>
                  </div>
                )}
                {backfillRange !== "none" && (
                  <p className={clsx("text-xs", isBackfillInvalid ? "text-error" : "text-muted")}>
                    {isBackfillInvalid
                      ? "Choose a valid range and answer before saving."
                      : `Will apply to ${backfillDays} previous day${backfillDays === 1 ? "" : "s"}.`}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        )}

        <div className="rounded-2xl bg-panel p-3">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Follow-up questions</p>
            <button
              className="focusable min-h-11 rounded-capsule bg-subsurface px-4 text-xs disabled:cursor-not-allowed disabled:opacity-55"
              disabled={!canAddChild}
              type="button"
              onClick={addChild}
            >
              Add follow-up
            </button>
          </div>
          <p className="mb-3 text-xs text-muted">
            Show up to 3 follow-up questions when this question is answered a certain way.
          </p>
          <div className="space-y-3">
            {children.map((child) => {
              const operatorMeta = CONDITION_OPERATOR_META.find(
                (entry) => entry.value === child.condition.operator,
              );
              const conditionNeedsValue = operatorMeta?.requiresValue ?? false;
              const isEqualityCondition =
                child.condition.operator === "equals" || child.condition.operator === "not_equals";
              return (
                <div key={child.id} className="rounded-2xl bg-subsurface p-3">
                  <div className="mb-2 flex justify-end">
                    <button
                      className="focusable min-h-11 rounded-capsule bg-[color-mix(in_srgb,var(--error)_16%,white)] px-3 text-xs text-error"
                      type="button"
                      onClick={() => removeChild(child.id)}
                    >
                      Remove follow-up
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <p className={inputTagClass}>Follow-up prompt</p>
                      <input
                        className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                        placeholder="Follow-up prompt"
                        value={child.prompt}
                        onChange={(event) => patchChild(child.id, { prompt: event.target.value })}
                      />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <p className={inputTagClass}>Follow-up input type</p>
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
                        <p className={inputTagClass}>Follow-up analysis mode</p>
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
                        <div className="flex items-center gap-2">
                          <p className={inputTagClass}>Condition operator</p>
                          <div
                            className="relative"
                          >
                            <button
                              aria-label="Condition operator help"
                              className="focusable rounded-capsule bg-panel p-1 text-muted transition hover:text-ink"
                              type="button"
                              onClick={() =>
                                setActiveConditionHelpChildId((previous) =>
                                  previous === child.id ? null : child.id,
                                )
                              }
                            >
                              <CircleHelp className="size-4" />
                            </button>
                          </div>
                        </div>
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
                        {activeConditionHelpChildId === child.id && (
                          <div className="w-full max-w-sm rounded-2xl bg-panel p-3 text-xs text-muted shadow-soft">
                            <p>
                              Controls when this follow-up question appears, based on the parent
                              answer.
                            </p>
                            <p className="mt-2">
                              <strong>equals:</strong> show when the answer exactly matches the
                              value.
                            </p>
                            <p className="mt-1">
                              <strong>not equals:</strong> show when the answer is anything except
                              the value.
                            </p>
                            <p className="mt-1">
                              <strong>greater than:</strong> show when the numeric answer is above
                              the value.
                            </p>
                            <p className="mt-1">
                              <strong>at least:</strong> show when the numeric answer is equal to
                              or above the value.
                            </p>
                            <p className="mt-1">
                              <strong>non-empty:</strong> show after any answer is entered.
                            </p>
                          </div>
                        )}
                      </div>
                      <div className="space-y-1">
                        <p className={inputTagClass}>Condition value</p>
                        {conditionNeedsValue && question.inputType === "multi-choice" && isEqualityCondition ? (
                          <select
                            className="focusable min-h-11 rounded-2xl bg-panel px-3"
                            value={String(child.condition.value ?? "")}
                            onChange={(event) =>
                              patchChild(child.id, {
                                condition: {
                                  ...child.condition,
                                  value: event.target.value,
                                },
                              })
                            }
                          >
                            {(question.options ?? []).map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : conditionNeedsValue && question.inputType === "boolean" && isEqualityCondition ? (
                          <select
                            className="focusable min-h-11 rounded-2xl bg-panel px-3"
                            value={String(child.condition.value ?? true)}
                            onChange={(event) =>
                              patchChild(child.id, {
                                condition: {
                                  ...child.condition,
                                  value: event.target.value === "true",
                                },
                              })
                            }
                          >
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                          </select>
                        ) : conditionNeedsValue ? (
                          <input
                            className="focusable min-h-11 rounded-2xl bg-panel px-3"
                            placeholder="Condition value"
                            type={
                              child.condition.operator === "greater_than"
                              || child.condition.operator === "at_least"
                                ? "number"
                                : "text"
                            }
                            value={String(child.condition.value ?? "")}
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
                No follow-up questions configured.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold shadow-soft transition disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSaveDisabled || isBackfillInvalid}
          type="button"
          onClick={() => onSave(buildBackfillRequest())}
        >
          {isSaving ? "Saving..." : "Save"}
        </button>
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
