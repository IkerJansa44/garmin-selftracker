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
  rectSortingStrategy,
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
  buildCorrelationCatalog,
  buildDerivedPredictorSourceOptions,
  buildPredictorDistribution,
  calculateQuantileCutPoints,
  findCorrelationPair,
  buildOutcomeOptions,
  buildPredictorOptions,
  getOptionLabel,
  type BasePredictorKey,
  type CorrelationPairResult,
  type OutcomeKey,
  type PredictorKey,
} from "./lib/correlation";
import { sleepMetricDateForPredictorDate } from "./lib/dateAlignment";
import {
  flattenQuestionFields,
  getVisibleChildren,
  pruneHiddenChildAnswers,
  type QuestionFieldDefinition,
} from "./lib/questions";
import {
  fetchCheckinReminderSettings,
  fetchCheckIns,
  fetchCorrelationValues,
  fetchDashboardData,
  fetchDashboardPlotSettings,
  fetchDerivedPredictors,
  fetchQuestionSettings,
  saveCheckIn,
  saveCheckinReminderSettings,
  saveDashboardPlotSettings,
  saveDerivedPredictors,
  saveQuestionSettings,
  startDateRangeImport,
  startRefreshImport,
  type DashboardPlotPreference as ApiDashboardPlotPreference,
  type PlotDirection,
} from "./lib/api";
import { usePersistentState } from "./lib/storage";
import {
  type CheckInQuestion,
  type CheckInQuestionChild,
  type CheckInEntry,
  type CheckinReminderSettings,
  type AnalysisValueRecord,
  type CoverageState,
  type ChildConditionOperator,
  type DailyRecord,
  type DerivedPredictorDefinition,
  type ImportState,
  type InputType,
  type MetricKey,
  type QuestionOption,
} from "./lib/types";

gsap.registerPlugin(ScrollTrigger);

type ViewKey = "dashboard" | "lab" | "checkin" | "settings";
type MetricDirection = "higher" | "lower";
type GarminPlotKey =
  | "steps"
  | "calories"
  | "stressAvg"
  | "bodyBattery"
  | "sleepSeconds"
  | "sleepConsistency"
  | "isTrainingDay";
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
  key: DashboardPlotVariableKey;
  direction: PlotDirection;
}

interface DashboardPlot {
  key: DashboardPlotVariableKey;
  direction: PlotDirection;
  option: DashboardPlotVariableOption;
  points: Array<{ date: string; value: number | null }>;
  values: number[];
  todayValue: number | null;
  periodAverage: number | null;
  comparison: { text: string; tone: string };
  coverage: CoverageState;
  baselineHint: string;
  domain: [number, number];
  ticks: number[];
}

interface CorrelationTooltipEntry {
  name?: string;
  value?: number | string;
  dataKey?: string | number;
  payload?: {
    date?: string;
    predictorSourceDate?: string;
    outcomeSourceDate?: string;
  };
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
const TIME_STEP_MINUTES = 15;
const TIME_SLIDER_MINUTES = { min: 0, max: 23 * 60 + 45 };
const DEFAULT_DASHBOARD_PLOT_PREFERENCES: DashboardPlotPreference[] = [
  { key: "metric:recoveryIndex", direction: "higher" },
  { key: "metric:sleepScore", direction: "higher" },
  { key: "metric:restingHr", direction: "lower" },
  { key: "metric:stress", direction: "lower" },
  { key: "metric:bodyBattery", direction: "higher" },
  { key: "metric:trainingReadiness", direction: "higher" },
];
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
const DEFAULT_CHECKIN_REMINDER_SETTINGS: CheckinReminderSettings = {
  enabled: true,
  notifyAfter: "22:30",
};
const GARMIN_PLOT_META: Record<GarminPlotKey, Omit<DashboardPlotVariableOption, "key">> = {
  steps: { label: "Steps", color: "#4f7e65", unit: "steps" },
  calories: { label: "Calories", color: "#8a5a4e", unit: "kcal" },
  stressAvg: { label: "Stress Avg", color: "#806739", unit: "pts" },
  bodyBattery: { label: "Body Battery", color: "#51745e", unit: "%" },
  sleepSeconds: { label: "Sleep Duration", color: "#3f6686", unit: "h" },
  sleepConsistency: { label: "Sleep Consistency", color: "#4b7394", unit: "min" },
  isTrainingDay: { label: "Training Day", color: "#6f4b83", unit: "0/1" },
};
const GARMIN_PLOT_DIRECTIONS: Partial<Record<GarminPlotKey, PlotDirection>> = {
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
  if (!Array.isArray(raw)) {
    return fallback;
  }

  const normalized: DashboardPlotPreference[] = [];
  const seenKeys = new Set<DashboardPlotVariableKey>();

  for (const entry of raw) {
    let key: DashboardPlotVariableKey | null = null;
    let direction: PlotDirection | null = null;

    if (typeof entry === "string") {
      key = entry as DashboardPlotVariableKey;
      direction = defaultPlotDirection(key);
    } else if (entry && typeof entry === "object") {
      const objectEntry = entry as ApiDashboardPlotPreference;
      if (typeof objectEntry.key === "string") {
        key = objectEntry.key as DashboardPlotVariableKey;
      }
      if (objectEntry.direction === "higher" || objectEntry.direction === "lower") {
        direction = objectEntry.direction;
      }
    }

    if (!key) {
      continue;
    }
    if (!direction) {
      direction = defaultPlotDirection(key);
    }
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    normalized.push({ key, direction });
  }

  return normalized;
}

function normalizeCheckinReminderSettings(raw: unknown): CheckinReminderSettings {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CHECKIN_REMINDER_SETTINGS;
  }
  const payload = raw as Partial<CheckinReminderSettings>;
  if (typeof payload.enabled !== "boolean") {
    return DEFAULT_CHECKIN_REMINDER_SETTINGS;
  }
  if (
    typeof payload.notifyAfter !== "string"
    || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(payload.notifyAfter)
  ) {
    return DEFAULT_CHECKIN_REMINDER_SETTINGS;
  }
  return {
    enabled: payload.enabled,
    notifyAfter: payload.notifyAfter,
  };
}

function arePlotPreferencesEqual(
  a: DashboardPlotPreference[],
  b: DashboardPlotPreference[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value.key === b[index]?.key && value.direction === b[index]?.direction);
}

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

function computeYAxisStats(values: number[]): { domain: [number, number]; ticks: number[] } {
  if (!values.length) {
    return { domain: [0, 1], ticks: [0, 0, 0] };
  }

  const minimum = Math.round(Math.min(...values));
  const maximum = Math.round(Math.max(...values));
  const average = Math.max(minimum, Math.min(maximum, Math.round(mean(values))));
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

function formatSecondsAsHours(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "--";
  }
  return formatMinutesAsHours(Math.round(seconds / 60));
}

function formatIsoClockTimeLocal(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatIsoDateLocal(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseThresholdCutPointsInput(rawValue: string): number[] {
  const values = rawValue
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
  if (!values.length) {
    return [];
  }
  const sorted = [...values].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] <= sorted[index - 1]) {
      return [];
    }
  }
  return sorted;
}

function buildDensityCurve(values: number[], points = 80): Array<{ x: number; density: number }> {
  if (values.length < 2) {
    return [];
  }
  const sorted = [...values].sort((left, right) => left - right);
  const minValue = sorted[0];
  const maxValue = sorted[sorted.length - 1];
  const span = maxValue - minValue;
  if (span === 0) {
    return [{ x: minValue, density: 1 }];
  }

  const average = mean(sorted);
  const variance = sorted.reduce((sum, value) => sum + (value - average) ** 2, 0) / sorted.length;
  const standardDeviation = Math.sqrt(variance);
  const silvermanBandwidth = standardDeviation > 0
    ? 1.06 * standardDeviation * (sorted.length ** (-1 / 5))
    : span / 10;
  const bandwidth = Math.max(silvermanBandwidth, span / 100, 1e-6);
  const start = minValue - span * 0.05;
  const end = maxValue + span * 0.05;
  const step = (end - start) / (points - 1);
  const normalizer = 1 / (sorted.length * bandwidth * Math.sqrt(2 * Math.PI));

  return Array.from({ length: points }, (_, index) => {
    const x = start + step * index;
    const sum = sorted.reduce((accumulator, value) => {
      const z = (x - value) / bandwidth;
      return accumulator + Math.exp(-0.5 * z * z);
    }, 0);
    return { x, density: normalizer * sum };
  });
}

function chooseIntegerAxisStep(span: number): number {
  const allowedSteps = [1, 5, 10, 50, 100, 1000] as const;
  if (!Number.isFinite(span) || span <= 0) {
    return 1;
  }
  for (const step of allowedSteps) {
    if (span / step <= 10) {
      return step;
    }
  }
  return 1000;
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
  payload,
  plotKey,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  plotKey: DashboardPlotVariableKey;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  const value = payload[0]?.value;
  const formattedValue = plotKey === "garmin:sleepSeconds" && typeof value === "number"
    ? formatHoursAsHoursMinutes(value)
    : value ?? "--";
  return (
    <div className="rounded-2xl bg-panel px-3 py-2 text-xs shadow-soft">
      <span className="metric-number font-mono">{formattedValue}</span>
    </div>
  );
}

function describeCorrelationDirection(pair: CorrelationPairResult): string {
  if (pair.direction === "similar") {
    return "No clear monotonic direction in this sample.";
  }
  if (pair.testType === "categorical") {
    return `Moving from lower to higher ${pair.predictorLabel} categories is associated with ${pair.direction} ${pair.outcomeLabel}.`;
  }
  return `Higher ${pair.predictorLabel} is associated with ${pair.direction} ${pair.outcomeLabel}.`;
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
  const [draftAnswers, setDraftAnswers] = usePersistentState<Record<string, string | number | boolean>>(
    "ui.checkinDraft",
    defaultDraftAnswers(),
  );
  const [isScrolled, setIsScrolled] = useState(false);
  const [questionLibrary, setQuestionLibrary] = useState<CheckInQuestion[]>(DEFAULT_QUESTIONS);
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [questionLoadState, setQuestionLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [questionSyncError, setQuestionSyncError] = useState<string | null>(null);
  const [isSavingQuestions, setIsSavingQuestions] = useState(false);
  const lastSavedQuestionsRef = useRef<string>("[]");
  const [checkinReminderSettings, setCheckinReminderSettings] = useState<CheckinReminderSettings>(
    DEFAULT_CHECKIN_REMINDER_SETTINGS,
  );
  const [checkinReminderLoadState, setCheckinReminderLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [checkinReminderError, setCheckinReminderError] = useState<string | null>(null);
  const [isSavingCheckinReminder, setIsSavingCheckinReminder] = useState(false);
  const lastSavedCheckinReminderRef = useRef<string>(
    JSON.stringify(DEFAULT_CHECKIN_REMINDER_SETTINGS),
  );
  const [allRecords, setAllRecords] = useState<DailyRecord[]>([]);
  const [analysisValues, setAnalysisValues] = useState<AnalysisValueRecord[]>([]);
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
  const [showNewVariablePanel, setShowNewVariablePanel] = useState(false);
  const [derivedPredictors, setDerivedPredictors] = useState<DerivedPredictorDefinition[]>([]);
  const [derivedLoadState, setDerivedLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [derivedSyncError, setDerivedSyncError] = useState<string | null>(null);
  const [isSavingDerived, setIsSavingDerived] = useState(false);
  const [selectedDerivedSource, setSelectedDerivedSource] = useState<BasePredictorKey>("garmin:steps");
  const [derivedMode, setDerivedMode] = useState<"threshold" | "quantile">("threshold");
  const [derivedThresholdInput, setDerivedThresholdInput] = useState("2");
  const [derivedBins, setDerivedBins] = useState(2);
  const [derivedName, setDerivedName] = useState("");
  const [derivedLabelsInput, setDerivedLabelsInput] = useState("");
  const [editingDerivedId, setEditingDerivedId] = useState<string | null>(null);
  const [derivedFormError, setDerivedFormError] = useState<string | null>(null);
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
    const controller = new AbortController();

    const loadDerivedPredictors = async () => {
      setDerivedLoadState("loading");
      setDerivedSyncError(null);
      try {
        const payload = await fetchDerivedPredictors(controller.signal);
        setDerivedPredictors(payload.definitions);
        setDerivedLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error
          ? error.message
          : "Failed to load derived predictors.";
        setDerivedSyncError(message);
        setDerivedLoadState("error");
      }
    };

    void loadDerivedPredictors();
    return () => controller.abort();
  }, []);

  const persistDerivedPredictors = useCallback(async (definitions: DerivedPredictorDefinition[]) => {
    setIsSavingDerived(true);
    setDerivedSyncError(null);
    try {
      const payload = await saveDerivedPredictors(definitions);
      setDerivedPredictors(payload.definitions);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Failed to save derived predictors.";
      setDerivedSyncError(message);
      throw error;
    } finally {
      setIsSavingDerived(false);
    }
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
    const controller = new AbortController();

    const loadCheckinReminder = async () => {
      setCheckinReminderLoadState("loading");
      setCheckinReminderError(null);
      try {
        const payload = await fetchCheckinReminderSettings(controller.signal);
        const normalized = normalizeCheckinReminderSettings(payload);
        setCheckinReminderSettings(normalized);
        lastSavedCheckinReminderRef.current = JSON.stringify(normalized);
        setCheckinReminderLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load check-in reminder settings from SQLite.";
        setCheckinReminderError(message);
        setCheckinReminderLoadState("error");
      }
    };

    void loadCheckinReminder();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (checkinReminderLoadState !== "ready") {
      return;
    }

    const serializedSettings = JSON.stringify(checkinReminderSettings);
    if (serializedSettings === lastSavedCheckinReminderRef.current) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      const saveReminderSettings = async () => {
        setIsSavingCheckinReminder(true);
        setCheckinReminderError(null);
        try {
          const payload = await saveCheckinReminderSettings(
            checkinReminderSettings,
            controller.signal,
          );
          const normalized = normalizeCheckinReminderSettings(payload);
          setCheckinReminderSettings(normalized);
          lastSavedCheckinReminderRef.current = JSON.stringify(normalized);
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Failed to save check-in reminder settings to SQLite.";
          setCheckinReminderError(message);
        } finally {
          if (!controller.signal.aborted) {
            setIsSavingCheckinReminder(false);
          }
        }
      };

      void saveReminderSettings();
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [checkinReminderLoadState, checkinReminderSettings]);

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

  const predictorOptions = useMemo(
    () => buildPredictorOptions(questionLibrary, derivedPredictors),
    [derivedPredictors, questionLibrary],
  );
  const derivedSourceOptions = useMemo(
    () => buildDerivedPredictorSourceOptions(questionLibrary),
    [questionLibrary],
  );
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

  useEffect(() => {
    if (!derivedSourceOptions.length) {
      return;
    }
    if (derivedSourceOptions.some((option) => option.key === selectedDerivedSource)) {
      return;
    }
    setSelectedDerivedSource(derivedSourceOptions[0].key as BasePredictorKey);
  }, [derivedSourceOptions, selectedDerivedSource]);

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
        sleepConsistency: null,
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
          key: `garmin:${key}`,
          ...value,
        }),
      ),
      ...questionFields
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
    const selected = new Set(dashboardPlotPreferences.map((plot) => plot.key));
    const query = addPlotSearchQuery.trim().toLowerCase();
    return dashboardPlotOptions.filter((option) => {
      if (selected.has(option.key)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return option.label.toLowerCase().includes(query) || option.key.toLowerCase().includes(query);
    });
  }, [addPlotSearchQuery, dashboardPlotOptions, dashboardPlotPreferences]);
  const dashboardPlots = useMemo<DashboardPlot[]>(
    () =>
      dashboardPlotPreferences
        .map((plotPreference) => {
          const option = dashboardPlotOptions.find((candidate) => candidate.key === plotPreference.key);
          if (!option) {
            return null;
          }
          const points = records.map((record) => ({
            date: record.date,
            value: getDashboardPlotValue(plotPreference.key, record, checkinsByDateMap, questionFieldsById),
          }));
          const values = points
            .map((point) => point.value)
            .filter((value): value is number => value !== null);
          const metricSummary = metricSummaryByPlotKey.get(plotPreference.key);
          const todayValue = metricSummary?.todayValue ?? points[points.length - 1]?.value ?? null;
          const periodAverage = metricSummary?.periodAverage ?? (values.length ? mean(values) : null);
          const delta = todayValue === null || periodAverage === null ? null : todayValue - periodAverage;
          const coverage = metricSummary?.coverage ?? deriveCoverageState(points.length, values.length, todayValue);
          const baselineHint = metricSummary?.baselineHint
            ?? `Average based on ${values.length} of ${points.length} samples.`;
          const comparison = describeDashboardVsAverage(plotPreference.direction, option, delta, rangePreset);
          const yAxis = computeYAxisStats(values);
          return {
            key: plotPreference.key,
            direction: plotPreference.direction,
            option,
            points,
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
        .filter((plot): plot is DashboardPlot => plot !== null),
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

  const correlationRecords = allRecords;
  const correlationCatalog = useMemo(
    () =>
      buildCorrelationCatalog({
        records: correlationRecords,
        analysisValues,
        questions: questionLibrary,
        derivedPredictors,
        weekdayOnly: false,
        trainingOnly: false,
      }),
    [
      analysisValues,
      correlationRecords,
      derivedPredictors,
      questionLibrary,
    ],
  );
  const meaningfulCorrelations = useMemo(
    () => correlationCatalog.filter((pair) => pair.classification === "meaningful"),
    [correlationCatalog],
  );
  const exploratoryCorrelations = useMemo(
    () => correlationCatalog.filter((pair) => pair.classification === "exploratory"),
    [correlationCatalog],
  );
  const selectedCorrelationPair = useMemo(
    () => findCorrelationPair(correlationCatalog, predictorKey, outcomeKey),
    [correlationCatalog, outcomeKey, predictorKey],
  );
  const continuousExplorerXDomain = useMemo<[number, number] | undefined>(() => {
    if (!selectedCorrelationPair || selectedCorrelationPair.testType !== "continuous") {
      return undefined;
    }
    if (!selectedCorrelationPair.points.length) {
      return undefined;
    }
    const xs = selectedCorrelationPair.points.map((point) => point.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      return undefined;
    }
    if (minX === maxX) {
      const padding = minX === 0 ? 1 : Math.max(Math.abs(minX) * 0.05, 0.5);
      return [minX - padding, maxX + padding];
    }
    return [minX, maxX];
  }, [selectedCorrelationPair]);
  const trendLineData = useMemo(() => {
    if (
      !selectedCorrelationPair
      || selectedCorrelationPair.testType !== "continuous"
      || !selectedCorrelationPair.regression
      || selectedCorrelationPair.points.length < 2
    ) {
      return [];
    }
    const xs = selectedCorrelationPair.points.map((point) => point.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return [
      {
        x: minX,
        y:
          selectedCorrelationPair.regression.slope * minX
          + selectedCorrelationPair.regression.intercept,
      },
      {
        x: maxX,
        y:
          selectedCorrelationPair.regression.slope * maxX
          + selectedCorrelationPair.regression.intercept,
      },
    ];
  }, [selectedCorrelationPair]);
  const categoricalScatterData = useMemo(() => {
    if (!selectedCorrelationPair || selectedCorrelationPair.testType !== "categorical") {
      return [];
    }
    return selectedCorrelationPair.points.map((point, index) => ({
      ...point,
      xJittered: point.x + ((((index * 37) % 100) / 100) - 0.5) * 0.35,
    }));
  }, [selectedCorrelationPair]);
  const categoricalMeanData = useMemo(() => {
    if (
      !selectedCorrelationPair
      || selectedCorrelationPair.testType !== "categorical"
      || !selectedCorrelationPair.categoryMeans
    ) {
      return [];
    }
    return selectedCorrelationPair.categoryMeans
      .map((groupMean, index) => (
        groupMean === null ? null : { x: index, xJittered: index, y: groupMean }
      ))
      .filter((entry): entry is { x: number; xJittered: number; y: number } => entry !== null);
  }, [selectedCorrelationPair]);
  const renderCorrelationTooltip = useCallback(({ active, payload }: {
    active?: boolean;
    payload?: CorrelationTooltipEntry[];
  }) => {
    if (!active || !payload?.length) {
      return null;
    }
    const point = payload.find((entry) => (
      entry.payload?.predictorSourceDate && entry.payload?.outcomeSourceDate
    ))?.payload ?? payload.find((entry) => entry.payload?.date)?.payload;
    let predictorSourceDate = point?.predictorSourceDate;
    let outcomeSourceDate = point?.outcomeSourceDate;
    let date = point?.date;
    if ((!predictorSourceDate || !outcomeSourceDate || !date) && selectedCorrelationPair) {
      const xEntry = payload.find((entry) => (
        entry.dataKey === "x" || entry.dataKey === "xJittered"
      ));
      const yEntry = payload.find((entry) => entry.dataKey === "y");
      const xValue = Number(xEntry?.value);
      const yValue = Number(yEntry?.value);
      if (Number.isFinite(xValue) && Number.isFinite(yValue)) {
        const matchedPoint = selectedCorrelationPair.points.find((candidate) => (
          Math.abs(candidate.x - xValue) < 1e-6 && Math.abs(candidate.y - yValue) < 1e-6
        ));
        if (matchedPoint) {
          predictorSourceDate = matchedPoint.predictorSourceDate;
          outcomeSourceDate = matchedPoint.outcomeSourceDate;
          date = matchedPoint.date;
        }
      }
    }
    return (
      <div className="rounded-lg border border-black/10 bg-white/95 px-3 py-2 shadow-sm">
        {predictorSourceDate && outcomeSourceDate ? (
          <p className="mb-1 text-xs text-muted">
            Predictor: {formatReadableDate(predictorSourceDate)} | Outcome: {formatReadableDate(outcomeSourceDate)}
          </p>
        ) : date ? (
          <p className="mb-1 text-xs text-muted">{formatReadableDate(date)}</p>
        ) : null}
        <div className="space-y-1">
          {payload.map((entry, index) => {
            const numericValue = typeof entry.value === "number" ? entry.value : Number(entry.value);
            const valueText = Number.isFinite(numericValue)
              ? selectedCorrelationPair?.testType === "continuous"
                && predictorKey === "garmin:sleepSeconds"
                && entry.dataKey === "x"
                ? formatHoursAsHoursMinutes(numericValue)
                : numericValue.toFixed(2)
              : String(entry.value ?? "--");
            return (
              <p key={`${entry.name ?? "value"}:${index}`} className="text-sm text-ink">
                {entry.name}: {valueText}
              </p>
            );
          })}
        </div>
      </div>
    );
  }, [predictorKey, selectedCorrelationPair]);
  const derivedSourceValues = useMemo(
    () =>
      buildPredictorDistribution({
        records: correlationRecords,
        analysisValues,
        questions: questionLibrary,
        predictor: selectedDerivedSource,
        weekdayOnly: false,
        trainingOnly: false,
      }),
    [
      analysisValues,
      correlationRecords,
      questionLibrary,
      selectedDerivedSource,
    ],
  );
  const derivedSourceDensity = useMemo(
    () => buildDensityCurve(derivedSourceValues),
    [derivedSourceValues],
  );
  const previewCutPoints = useMemo(
    () => (
      derivedMode === "threshold"
        ? parseThresholdCutPointsInput(derivedThresholdInput)
        : calculateQuantileCutPoints(derivedSourceValues, derivedBins)
    ),
    [derivedBins, derivedMode, derivedSourceValues, derivedThresholdInput],
  );
  const derivedSourceSummary = useMemo(() => {
    if (!derivedSourceValues.length) {
      return { count: 0, min: null, median: null, max: null };
    }
    const sorted = [...derivedSourceValues].sort((left, right) => left - right);
    const center = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[center - 1] + sorted[center]) / 2
      : sorted[center];
    return {
      count: sorted.length,
      min: sorted[0],
      median,
      max: sorted[sorted.length - 1],
    };
  }, [derivedSourceValues]);
  const inRangePreviewCutPoints = useMemo(() => {
    const { min, max } = derivedSourceSummary;
    if (min === null || max === null) {
      return [];
    }
    return previewCutPoints.filter((value) => value >= min && value <= max);
  }, [derivedSourceSummary.max, derivedSourceSummary.min, previewCutPoints]);
  const outOfRangePreviewCutPoints = useMemo(() => {
    const { min, max } = derivedSourceSummary;
    if (min === null || max === null) {
      return previewCutPoints;
    }
    return previewCutPoints.filter((value) => value < min || value > max);
  }, [derivedSourceSummary.max, derivedSourceSummary.min, previewCutPoints]);
  const densityDomain = useMemo<[number, number] | null>(() => {
    if (!derivedSourceDensity.length) {
      return null;
    }
    const allX = derivedSourceDensity.map((point) => point.x);
    const minX = Math.min(...allX);
    const maxX = Math.max(...allX);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      return null;
    }
    if (minX === maxX) {
      return [minX - 1, maxX + 1];
    }
    const padding = (maxX - minX) * 0.05;
    return [minX - padding, maxX + padding];
  }, [derivedSourceDensity]);
  const densityAxisStep = useMemo(() => {
    if (!densityDomain) {
      return 1;
    }
    const [minX, maxX] = densityDomain;
    return chooseIntegerAxisStep(maxX - minX);
  }, [densityDomain]);
  const densityAxisTicks = useMemo(() => {
    if (!densityDomain) {
      return [];
    }
    const [minX, maxX] = densityDomain;
    const start = Math.floor(minX / densityAxisStep) * densityAxisStep;
    const end = Math.ceil(maxX / densityAxisStep) * densityAxisStep;
    const ticks: number[] = [];
    for (
      let value = start, guard = 0;
      value <= end && guard < 500;
      value += densityAxisStep, guard += 1
    ) {
      ticks.push(Math.round(value));
    }
    return ticks;
  }, [densityAxisStep, densityDomain]);
  const displayedCorrelationCards = meaningfulCorrelations.length
    ? meaningfulCorrelations
    : exploratoryCorrelations;
  const isExploratoryFallback =
    meaningfulCorrelations.length === 0 && exploratoryCorrelations.length > 0;

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
  const selectedPredictorSourceDate = selectedCheckinRecord?.date ?? selectedCheckinDate;
  const selectedSleepMetricDate = sleepMetricDateForPredictorDate(selectedPredictorSourceDate);
  const selectedSleepRecord = useMemo(
    () => allRecords.find((record) => record.date === selectedSleepMetricDate) ?? null,
    [allRecords, selectedSleepMetricDate],
  );
  const selectedFellAsleepTime = useMemo(() => {
    if (selectedSleepRecord?.fellAsleepAtIso) {
      const formatted = formatIsoClockTimeLocal(selectedSleepRecord.fellAsleepAtIso);
      if (formatted) {
        return formatted;
      }
    }
    if (selectedSleepRecord?.fellAsleepAt) {
      return selectedSleepRecord.fellAsleepAt;
    }
    const legacySleepTime = draftAnswers[SLEEP_TIME_QUESTION_ID];
    return typeof legacySleepTime === "string" && legacySleepTime ? legacySleepTime : null;
  }, [draftAnswers, selectedSleepRecord]);
  const selectedSleepDuration = selectedSleepRecord?.predictors.sleepSeconds ?? null;
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
      await loadCorrelationValues();
      setCheckinSaveMessage(`Saved check-in for ${formatReadableDate(payload.entry.date)}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save check-in to SQLite.";
      setCheckinSyncError(message);
    } finally {
      setIsSavingCheckin(false);
    }
  };

  const handleSelectDashboardPlotToAdd = (option: DashboardPlotVariableOption) => {
    setPendingAddPlot(option);
    setShowAddPlotMenu(false);
  };

  const handleAddDashboardPlot = (
    plotKey: DashboardPlotVariableKey,
    direction: PlotDirection,
  ) => {
    setDashboardPlotPreferences((previous) => (
      previous.some((plot) => plot.key === plotKey)
        ? previous
        : [...previous, { key: plotKey, direction }]
    ));
    setPendingAddPlot(null);
  };

  const handleRemoveDashboardPlot = (plotKey: DashboardPlotVariableKey) => {
    setDashboardPlotPreferences((previous) => previous.filter((plot) => plot.key !== plotKey));
  };

  const handleDashboardPlotSortEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    setDashboardPlotPreferences((previous) => {
      const oldIndex = previous.findIndex((plot) => plot.key === active.id);
      const newIndex = previous.findIndex((plot) => plot.key === over.id);
      if (oldIndex === -1 || newIndex === -1) {
        return previous;
      }
      return arrayMove(previous, oldIndex, newIndex);
    });
  };

  const formatDerivedBoundary = (value: number): string => {
    if (!Number.isFinite(value)) {
      return String(value);
    }
    if (Math.abs(value) >= 1000) {
      return value.toFixed(0);
    }
    if (Math.abs(value) >= 100) {
      return value.toFixed(1);
    }
    return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  };

  const buildDefaultDerivedLabels = (cutPoints: number[]): string[] => {
    if (!cutPoints.length) {
      return [];
    }
    const labels: string[] = [];
    labels.push(`< ${formatDerivedBoundary(cutPoints[0])}`);
    for (let index = 1; index < cutPoints.length; index += 1) {
      labels.push(`${formatDerivedBoundary(cutPoints[index - 1])} to < ${formatDerivedBoundary(cutPoints[index])}`);
    }
    labels.push(`>= ${formatDerivedBoundary(cutPoints[cutPoints.length - 1])}`);
    return labels;
  };

  const resetDerivedForm = () => {
    setEditingDerivedId(null);
    setDerivedName("");
    setDerivedThresholdInput("2");
    setDerivedLabelsInput("");
    setDerivedBins(2);
    setDerivedMode("threshold");
    setDerivedFormError(null);
  };

  const handleSaveDerivedDefinition = async () => {
    const trimmedName = derivedName.trim();
    if (!trimmedName) {
      setDerivedFormError("Name is required.");
      return;
    }

    const cutPoints = derivedMode === "threshold"
      ? parseThresholdCutPointsInput(derivedThresholdInput)
      : calculateQuantileCutPoints(derivedSourceValues, derivedBins);
    if (!cutPoints.length) {
      setDerivedFormError("Unable to compute valid cut points for this source.");
      return;
    }

    const rawLabels = derivedLabelsInput
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const labels = rawLabels.length ? rawLabels : buildDefaultDerivedLabels(cutPoints);
    if (labels.length !== cutPoints.length + 1) {
      setDerivedFormError(`Expected ${cutPoints.length + 1} labels for ${cutPoints.length + 1} bins.`);
      return;
    }

    const nextDefinition: DerivedPredictorDefinition = {
      id: editingDerivedId ?? `derived_${Date.now()}`,
      name: trimmedName,
      sourceKey: selectedDerivedSource,
      mode: derivedMode,
      cutPoints,
      labels,
    };
    const nextDefinitions = editingDerivedId
      ? derivedPredictors.map((definition) => (
        definition.id === editingDerivedId ? nextDefinition : definition
      ))
      : [...derivedPredictors, nextDefinition];

    setDerivedFormError(null);
    try {
      await persistDerivedPredictors(nextDefinitions);
      resetDerivedForm();
    } catch {
      // Error is already surfaced through derivedSyncError.
    }
  };

  const handleEditDerivedDefinition = (definition: DerivedPredictorDefinition) => {
    setEditingDerivedId(definition.id);
    setDerivedName(definition.name);
    setSelectedDerivedSource(definition.sourceKey as BasePredictorKey);
    setDerivedMode(definition.mode);
    setDerivedThresholdInput(definition.cutPoints.join(", "));
    setDerivedBins(Math.max(2, Math.min(5, definition.labels.length)));
    setDerivedLabelsInput(definition.labels.join(", "));
    setDerivedFormError(null);
  };

  const handleDeleteDerivedDefinition = async (definitionId: string) => {
    const nextDefinitions = derivedPredictors.filter((definition) => definition.id !== definitionId);
    try {
      await persistDerivedPredictors(nextDefinitions);
      if (editingDerivedId === definitionId) {
        resetDerivedForm();
      }
    } catch {
      // Error is already surfaced through derivedSyncError.
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
              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
                <h1 className="text-4xl font-semibold tracking-tight xl:text-5xl">Dashboard</h1>
                <div className="flex flex-col items-center gap-3 lg:justify-self-center">
                  <div className="flex w-fit gap-2 rounded-capsule bg-subsurface p-1">
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
                  <p className="text-center text-base text-muted lg:text-lg">
                    Today vs rolling {rangePreset}-day average.
                  </p>
                </div>
                <div ref={addPlotMenuRef} className="relative w-fit lg:justify-self-end">
                  <button
                    aria-expanded={showAddPlotMenu}
                    className="focusable min-h-11 rounded-capsule bg-accent px-4 text-sm font-semibold text-white shadow-soft transition"
                    type="button"
                    onClick={() => setShowAddPlotMenu((previous) => !previous)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <CirclePlus className="size-4" />
                      Add plot
                    </span>
                  </button>
                  {showAddPlotMenu && (
                    <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-2xl bg-panel p-2 shadow-soft">
                      <input
                        className="focusable mb-2 min-h-10 w-full rounded-xl bg-subsurface px-3 text-sm"
                        placeholder="Search plots"
                        type="search"
                        value={addPlotSearchQuery}
                        onChange={(event) => setAddPlotSearchQuery(event.target.value)}
                      />
                      {addableDashboardPlotOptions.length ? (
                        <div className="space-y-1">
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
                          {addPlotSearchQuery.trim()
                            ? "No plots match your search."
                            : "All variables are already plotted."}
                        </p>
                      )}
                    </div>
                  )}
                  {pendingAddPlot && (
                    <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-2xl bg-panel p-3 shadow-soft">
                      <p className="text-xs uppercase tracking-[0.14em] text-muted">Plot preference</p>
                      <p className="mt-1 text-sm font-semibold">{pendingAddPlot.label}</p>
                      <p className="mt-1 text-xs text-muted">For comparison, is higher better or lower better?</p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          className="focusable min-h-10 rounded-xl bg-accent px-3 text-xs font-semibold text-white"
                          type="button"
                          onClick={() => handleAddDashboardPlot(pendingAddPlot.key, "higher")}
                        >
                          Higher better
                        </button>
                        <button
                          className="focusable min-h-10 rounded-xl bg-subsurface px-3 text-xs font-semibold text-ink"
                          type="button"
                          onClick={() => handleAddDashboardPlot(pendingAddPlot.key, "lower")}
                        >
                          Lower better
                        </button>
                      </div>
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
              <p className="mt-3 text-sm text-muted">
                Higher is better for Recovery Index, Sleep Score, Body Battery, and Training Readiness.
                Lower is better for Stress and Resting HR.
              </p>
              <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <input
                  className="focusable min-h-11 w-full rounded-2xl bg-panel px-3 text-sm lg:max-w-md"
                  placeholder="Search metrics and plots"
                  type="search"
                  value={plotSearchQuery}
                  onChange={(event) => setPlotSearchQuery(event.target.value)}
                />
                <p
                  className={clsx(
                    "text-xs",
                    plotSettingsError ? "text-error" : "text-muted",
                  )}
                >
                  {plotSettingsLoadState === "loading"
                    ? "Loading plot layout..."
                    : isSavingPlotSettings
                      ? "Saving plot layout..."
                      : plotSettingsError
                        ? `Plot layout sync failed: ${plotSettingsError}`
                        : "Plot layout synced with SQLite."}
                </p>
              </div>

              <DndContext sensors={sensors} onDragEnd={handleDashboardPlotSortEnd}>
                <SortableContext
                  items={filteredDashboardPlots.map((plot) => plot.key)}
                  strategy={rectSortingStrategy}
                >
                  {filteredDashboardPlots.length ? (
                    <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {filteredDashboardPlots.map((plot) => (
                        <SortableDashboardPlotItem
                          key={plot.key}
                          dataStatus={dataStatus}
                          importState={todayRecord.importState}
                          plot={plot}
                          rangePreset={rangePreset}
                          onOpenStatus={() => setActiveView("settings")}
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

        {activeView === "lab" && (
          <section className="gsap-fade space-y-5">
            <article className="panel p-6 sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">Correlation Lab</h2>
                  <p className="mt-1 text-sm text-muted">
                    Univariate associations only. Predictors can correlate with each other, so results are directional signals, not causality.
                  </p>
                </div>
                <button
                  className="focusable min-h-11 rounded-capsule bg-accent px-5 text-sm font-semibold text-white shadow-soft"
                  type="button"
                  onClick={() => setShowNewVariablePanel((previous) => !previous)}
                >
                  + New Variable
                </button>
              </div>
            </article>

            {showNewVariablePanel && (
              <article className="panel p-6 sm:p-8">
              <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Derived Predictors</h3>
                  <p className="text-sm text-muted">
                    Build threshold or quantile bins from continuous predictors. Definitions are persisted in SQLite settings.
                  </p>
                </div>
                {isSavingDerived && (
                  <span className="inline-flex items-center gap-2 text-sm text-muted">
                    <LoaderCircle className="size-4 animate-spin" />
                    Saving...
                  </span>
                )}
              </header>
              {derivedSyncError && (
                <p className="mb-3 rounded-2xl bg-[color-mix(in_srgb,var(--error)_14%,white)] px-3 py-2 text-sm text-error">
                  {derivedSyncError}
                </p>
              )}
              <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
                <div className="space-y-3 rounded-[22px] bg-subsurface p-4">
                  <label className="space-y-2 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Source Predictor</span>
                    <select
                      className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                      value={selectedDerivedSource}
                      onChange={(event) => setSelectedDerivedSource(event.target.value as BasePredictorKey)}
                    >
                      {derivedSourceOptions.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="block text-xs uppercase tracking-[0.16em] text-muted">Mode</span>
                      <select
                        className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                        value={derivedMode}
                        onChange={(event) => setDerivedMode(event.target.value as "threshold" | "quantile")}
                      >
                        <option value="threshold">Threshold</option>
                        <option value="quantile">Quantile</option>
                      </select>
                    </label>
                    {derivedMode === "quantile" ? (
                      <label className="space-y-2 text-sm">
                        <span className="block text-xs uppercase tracking-[0.16em] text-muted">Bins (2-5)</span>
                        <input
                          className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                          max={5}
                          min={2}
                          type="number"
                          value={derivedBins}
                          onChange={(event) => setDerivedBins(Math.max(2, Math.min(5, Number(event.target.value) || 2)))}
                        />
                      </label>
                    ) : (
                      <label className="space-y-2 text-sm">
                        <span className="block text-xs uppercase tracking-[0.16em] text-muted">Cut Points</span>
                        <input
                          className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                          placeholder="e.g. 2, 4"
                          type="text"
                          value={derivedThresholdInput}
                          onChange={(event) => setDerivedThresholdInput(event.target.value)}
                        />
                      </label>
                    )}
                  </div>
                  <label className="space-y-2 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Name</span>
                    <input
                      className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                      placeholder="e.g. Caffeine High/Low"
                      type="text"
                      value={derivedName}
                      onChange={(event) => setDerivedName(event.target.value)}
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Labels (optional)</span>
                    <input
                      className="focusable min-h-11 w-full rounded-2xl bg-panel px-3"
                      placeholder="Comma-separated labels"
                      type="text"
                      value={derivedLabelsInput}
                      onChange={(event) => setDerivedLabelsInput(event.target.value)}
                    />
                  </label>
                  {derivedFormError && (
                    <p className="rounded-2xl bg-[color-mix(in_srgb,var(--error)_14%,white)] px-3 py-2 text-sm text-error">
                      {derivedFormError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="focusable min-h-11 rounded-capsule bg-accent px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={derivedLoadState !== "ready" || !derivedSourceValues.length || isSavingDerived}
                      type="button"
                      onClick={() => void handleSaveDerivedDefinition()}
                    >
                      {editingDerivedId ? "Update definition" : "Create definition"}
                    </button>
                    <button
                      className="focusable min-h-11 rounded-capsule bg-panel px-4 text-sm font-semibold shadow-soft"
                      type="button"
                      onClick={resetDerivedForm}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="space-y-3 rounded-[22px] bg-subsurface p-4">
                  <h4 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">Distribution Preview</h4>
                  <p className="metric-number text-xs text-muted">
                    N={derivedSourceSummary.count}
                    {derivedSourceSummary.min !== null && (
                      <> · min={derivedSourceSummary.min.toFixed(1)} · median={derivedSourceSummary.median?.toFixed(1)} · max={derivedSourceSummary.max?.toFixed(1)}</>
                    )}
                  </p>
                  {derivedSourceDensity.length ? (
                    <div className="h-44 rounded-2xl bg-panel p-2">
                      <ResponsiveContainer>
                        <ComposedChart data={derivedSourceDensity}>
                          <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="3 6" />
                          <XAxis
                            axisLine={false}
                            dataKey="x"
                            domain={
                              densityAxisTicks.length >= 2
                                ? [densityAxisTicks[0], densityAxisTicks[densityAxisTicks.length - 1]]
                                : densityDomain ?? ["auto", "auto"]
                            }
                            interval={0}
                            scale="linear"
                            ticks={densityAxisTicks}
                            tick={{ fontSize: 11 }}
                            tickFormatter={(value: number) => String(Math.round(value))}
                            tickLine={false}
                            type="number"
                          />
                          <YAxis axisLine={false} dataKey="density" hide tickLine={false} type="number" />
                          <Tooltip
                            cursor={{ strokeDasharray: "3 4" }}
                            formatter={(value: number, key) => [
                              key === "density" ? value.toFixed(4) : value.toFixed(2),
                              key,
                            ]}
                            labelFormatter={(label) => `x=${Number(label).toFixed(2)}`}
                          />
                          <Line
                            dataKey="density"
                            dot={false}
                            stroke="#CC5833"
                            strokeWidth={2}
                            type="monotone"
                          />
                          {inRangePreviewCutPoints.map((cutPoint, index) => (
                            <ReferenceLine
                              key={`${cutPoint}-${index}`}
                              ifOverflow="extendDomain"
                              label={{ value: `C${index + 1}`, fill: "#cc5833", fontSize: 10 }}
                              stroke="#CC5833"
                              strokeDasharray="4 4"
                              x={cutPoint}
                            />
                          ))}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">No values available for this source.</p>
                  )}
                  <p className="metric-number text-xs text-muted">
                    Cut points: {previewCutPoints.length ? previewCutPoints.map((value) => value.toFixed(2)).join(", ") : "--"}
                  </p>
                  {outOfRangePreviewCutPoints.length > 0 && (
                    <p className="metric-number text-xs text-warning">
                      Out of range: {outOfRangePreviewCutPoints.map((value) => value.toFixed(2)).join(", ")}
                    </p>
                  )}

                  <div className="pt-2">
                    <h4 className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-muted">Saved Definitions</h4>
                    <div className="space-y-2">
                      {derivedPredictors.length ? derivedPredictors.map((definition) => (
                        <div key={definition.id} className="rounded-2xl bg-panel p-3">
                          <p className="text-sm font-semibold">{definition.name}</p>
                          <p className="mt-1 text-xs text-muted">
                            {getOptionLabel(derivedSourceOptions, definition.sourceKey, definition.sourceKey)}
                            {" · "}
                            {definition.mode}
                            {" · "}
                            {definition.labels.length} bins
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              className="focusable rounded-capsule bg-subsurface px-3 py-1 text-xs font-semibold"
                              type="button"
                              onClick={() => handleEditDerivedDefinition(definition)}
                            >
                              Edit
                            </button>
                            <button
                              className="focusable rounded-capsule bg-[color-mix(in_srgb,var(--error)_14%,white)] px-3 py-1 text-xs font-semibold text-error"
                              type="button"
                              onClick={() => void handleDeleteDerivedDefinition(definition.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )) : (
                        <p className="text-sm text-muted">No derived predictors yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              </article>
            )}

            <article className="panel p-6 sm:p-8">
              <header className="mb-4">
                <h3 className="text-lg font-semibold tracking-tight">Top Correlations</h3>
                <p className="text-sm text-muted">
                  Predictor values are aligned to the previous day. Outcomes are measured on the selected day.
                </p>
              </header>
              {isExploratoryFallback && (
                <p className="mb-3 rounded-2xl bg-[color-mix(in_srgb,var(--warning)_16%,white)] px-4 py-3 text-sm text-warning">
                  No meaningful correlations yet. Showing exploratory correlations from full history.
                </p>
              )}
              {!displayedCorrelationCards.length ? (
                <p className="rounded-2xl bg-subsurface px-4 py-3 text-sm text-muted">
                  Insufficient data for correlation cards. Keep tracking to unlock meaningful and exploratory results.
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {displayedCorrelationCards.map((pair) => (
                    <article key={pair.key} className="rounded-[22px] bg-subsurface p-4">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold tracking-tight">{pair.predictorLabel} vs {pair.outcomeLabel}</h4>
                        <span
                          className={clsx(
                            "rounded-capsule px-3 py-1 text-xs font-semibold",
                            pair.classification === "meaningful"
                              ? "bg-[color-mix(in_srgb,var(--success)_14%,white)] text-success"
                              : "bg-[color-mix(in_srgb,var(--warning)_16%,white)] text-warning",
                          )}
                        >
                          {pair.classification === "meaningful" ? "Meaningful" : "Exploratory"}
                        </span>
                      </div>
                      <p className="text-sm text-muted">{describeCorrelationDirection(pair)}</p>
                      <p className="metric-number mt-2 text-xs text-muted">
                        {pair.testType === "continuous"
                          ? `r=${(pair.correlation ?? 0).toFixed(2)} · slope=${pair.regression?.slope.toFixed(3) ?? "--"} · p=${pair.pValue?.toExponential(2) ?? "--"} · q=${pair.qValue?.toExponential(2) ?? "--"} · N=${pair.sampleCount}`
                          : `eta²=${(pair.etaSquared ?? 0).toFixed(3)} · F=${pair.fStatistic?.toFixed(2) ?? "--"} · p=${pair.pValue?.toExponential(2) ?? "--"} · q=${pair.qValue?.toExponential(2) ?? "--"} · N=${pair.sampleCount}`}
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </article>

            <article className="panel p-6 sm:p-8">
              <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight">Explorer</h3>
                  <p className="text-sm text-muted">Inspect any predictor/outcome pair visually.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Predictor (X)</span>
                    <select
                      className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                      value={predictorKey}
                      onChange={(event) => setPredictorKey(event.target.value as PredictorKey)}
                    >
                      {predictorOptions.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs uppercase tracking-[0.16em] text-muted">Outcome (Y)</span>
                    <select
                      className="focusable min-h-11 rounded-2xl bg-subsurface px-3"
                      value={outcomeKey}
                      onChange={(event) => setOutcomeKey(event.target.value as OutcomeKey)}
                    >
                      {outcomeOptions.map((option) => (
                        <option key={option.key} value={option.key}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </header>
              {selectedCorrelationPair ? (
                <>
                  <p className="metric-number mb-4 text-sm text-muted">
                    {selectedCorrelationPair.testType === "continuous"
                      ? `r=${(selectedCorrelationPair.correlation ?? 0).toFixed(3)} · slope=${selectedCorrelationPair.regression?.slope.toFixed(3) ?? "--"} · p=${selectedCorrelationPair.pValue?.toExponential(2) ?? "--"} · q=${selectedCorrelationPair.qValue?.toExponential(2) ?? "--"} · N=${selectedCorrelationPair.sampleCount}`
                      : `eta²=${(selectedCorrelationPair.etaSquared ?? 0).toFixed(3)} · F=${selectedCorrelationPair.fStatistic?.toFixed(2) ?? "--"} · p=${selectedCorrelationPair.pValue?.toExponential(2) ?? "--"} · q=${selectedCorrelationPair.qValue?.toExponential(2) ?? "--"} · N=${selectedCorrelationPair.sampleCount}`}
                  </p>
                  <div className="h-[420px]">
                    <ResponsiveContainer>
                      <ScatterChart>
                        <CartesianGrid stroke="rgba(18,18,18,0.06)" strokeDasharray="3 6" />
                        <XAxis
                          axisLine={false}
                          dataKey={selectedCorrelationPair.testType === "categorical" ? "xJittered" : "x"}
                          domain={selectedCorrelationPair.testType === "categorical"
                            ? [-0.5, Math.max(0, (selectedCorrelationPair.categoryLabels?.length ?? 1) - 0.5)]
                            : continuousExplorerXDomain}
                          label={{
                            value: getOptionLabel(predictorOptions, predictorKey, predictorKey),
                            position: "insideBottom",
                            offset: -2,
                            style: { fill: "rgba(18,18,18,0.62)", fontSize: 12 },
                          }}
                          name={getOptionLabel(predictorOptions, predictorKey, predictorKey)}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(value: number) => {
                            if (selectedCorrelationPair.testType !== "categorical") {
                              return String(Math.round(value * 10) / 10);
                            }
                            const labels = selectedCorrelationPair.categoryLabels ?? [];
                            const index = Math.round(value);
                            return labels[index] ?? String(index);
                          }}
                          tickLine={false}
                          type="number"
                        />
                        <YAxis
                          axisLine={false}
                          dataKey="y"
                          label={{
                            value: getOptionLabel(outcomeOptions, outcomeKey, outcomeKey),
                            angle: -90,
                            position: "insideLeft",
                            style: { fill: "rgba(18,18,18,0.62)", fontSize: 12, textAnchor: "middle" },
                          }}
                          name={getOptionLabel(outcomeOptions, outcomeKey, outcomeKey)}
                          tick={{ fontSize: 12 }}
                          tickLine={false}
                          type="number"
                        />
                        <Tooltip
                          cursor={{ strokeDasharray: "3 4" }}
                          content={renderCorrelationTooltip}
                        />
                        <Scatter
                          data={selectedCorrelationPair.testType === "categorical"
                            ? categoricalScatterData
                            : selectedCorrelationPair.points}
                          fill={getMetricColor("sleepScore")}
                        />
                        {selectedCorrelationPair.testType === "categorical" && (
                          <Scatter data={categoricalMeanData} fill="#CC5833" name="Group means" />
                        )}
                        {selectedCorrelationPair.testType === "continuous" && (
                          <Scatter
                            data={trendLineData}
                            fill="transparent"
                            legendType="none"
                            line={{ stroke: "#CC5833", strokeWidth: 2 }}
                            name="Trend"
                            shape={() => null}
                          />
                        )}
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <p className="rounded-2xl bg-subsurface px-4 py-3 text-sm text-muted">
                  Select a valid predictor/outcome pair to explore.
                </p>
              )}
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

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Steps (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {selectedSteps === null ? "--" : selectedSteps.toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Source date: {selectedPredictorSourceDate}
                  </p>
                </div>
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Activity (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {selectedActivityLabel}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Source date: {selectedPredictorSourceDate}
                  </p>
                </div>
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Fell asleep at (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {selectedFellAsleepTime ?? "--:--"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Source date: {selectedPredictorSourceDate}
                  </p>
                </div>
                <div className="rounded-[22px] bg-subsurface p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted">Predictor</p>
                  <p className="mt-2 text-sm text-muted">Sleep Duration (Garmin)</p>
                  <p className="metric-number mt-1 text-2xl font-semibold text-ink">
                    {formatSecondsAsHours(selectedSleepDuration)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Source date: {selectedPredictorSourceDate}
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
            <div className="space-y-5">
              <article className="rounded-[24px] bg-subsurface p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">Check-In Reminder</h3>
                    <p
                      className={clsx(
                        "mt-1 text-sm",
                        checkinReminderError ? "text-error" : "text-muted",
                      )}
                    >
                      {checkinReminderLoadState === "loading"
                        ? "Loading from SQLite..."
                        : isSavingCheckinReminder
                          ? "Saving to SQLite..."
                          : checkinReminderError
                            ? `SQLite sync failed: ${checkinReminderError}`
                            : "Synced with SQLite."}
                    </p>
                  </div>
                  <p
                    className={clsx(
                      "rounded-capsule px-3 py-2 text-xs font-semibold",
                      checkinReminderSettings.enabled
                        ? "text-success bg-[color-mix(in_srgb,var(--success)_14%,white)]"
                        : "text-muted bg-panel",
                    )}
                  >
                    {checkinReminderSettings.enabled
                      ? `Active · reminder after ${checkinReminderSettings.notifyAfter}`
                      : "Inactive · reminder disabled"}
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex items-center justify-between rounded-2xl bg-panel p-4 text-sm font-medium">
                    Enable email reminder
                    <input
                      checked={checkinReminderSettings.enabled}
                      type="checkbox"
                      onChange={(event) =>
                        setCheckinReminderSettings((previous) => ({
                          ...previous,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                  </label>
                  <label className="space-y-2 rounded-2xl bg-panel p-4 text-sm">
                    <span className="block text-xs uppercase tracking-[0.14em] text-muted">
                      Notify after
                    </span>
                    <input
                      className="focusable min-h-11 w-full rounded-2xl bg-subsurface px-3 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!checkinReminderSettings.enabled}
                      step={60}
                      type="time"
                      value={checkinReminderSettings.notifyAfter}
                      onChange={(event) =>
                        setCheckinReminderSettings((previous) => ({
                          ...previous,
                          notifyAfter: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
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
            </div>
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

function SortableDashboardPlotItem({
  dataStatus,
  importState,
  plot,
  rangePreset,
  onOpenStatus,
  onRemove,
}: {
  dataStatus: "loading" | "ready" | "error";
  importState: ImportState;
  plot: DashboardPlot;
  rangePreset: number;
  onOpenStatus: () => void;
  onRemove: (plotKey: DashboardPlotVariableKey) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: plot.key });
  const coverageMeta = COVERAGE_META[plot.coverage];
  const isMissing = plot.coverage === "missing";
  const isPartial = plot.coverage === "partial";
  const loadingState = importState === "running" && plot.coverage !== "complete";
  const errorState = (importState === "failed" || dataStatus === "error") && isMissing;

  return (
    <article
      ref={setNodeRef}
      className="rounded-[24px] bg-panel p-5 shadow-soft"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{plot.option.label}</p>
          <p className="metric-number mt-2 text-3xl font-semibold tracking-tight">
            {formatDashboardValue(plot.key, plot.option, plot.todayValue)}
          </p>
          <p className="metric-number mt-1 text-xs text-muted">
            {rangePreset}d average {formatDashboardValue(plot.key, plot.option, plot.periodAverage)}
          </p>
          <p className={clsx("mt-1 text-xs font-medium", plot.comparison.tone)}>{plot.comparison.text}</p>
        </div>
        <div className="flex items-start gap-2">
          <span className={clsx("rounded-capsule px-3 py-1 text-xs font-semibold", coverageMeta.tone)}>
            {coverageMeta.label}
          </span>
          <button
            aria-label={`Remove ${plot.option.label} plot`}
            className="focusable min-h-9 rounded-capsule bg-subsurface px-3 text-muted transition hover:text-ink"
            type="button"
            onClick={() => onRemove(plot.key)}
          >
            <X className="size-4" />
          </button>
          <button
            aria-label={`Reorder ${plot.option.label} plot`}
            className="focusable min-h-9 rounded-capsule bg-subsurface px-3 text-muted transition hover:text-ink"
            type="button"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 h-16">
        <ResponsiveContainer>
          <ComposedChart data={plot.points}>
            <YAxis
              allowDecimals={false}
              axisLine={{ stroke: "rgba(18,18,18,0.28)", strokeWidth: 1 }}
              domain={plot.domain}
              interval={0}
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
              dot={false}
              stroke={plot.option.color}
              strokeWidth={2}
              type="monotone"
            />
            <Tooltip content={<SparklineTooltip plotKey={plot.key} />} />
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
            {dataStatus === "error" ? "Unable to load data API." : "No data yet. Last import failed."}
            <button
              className="focusable rounded-capsule bg-[color-mix(in_srgb,var(--error)_14%,white)] px-2 py-1 text-[11px]"
              type="button"
              onClick={onOpenStatus}
            >
              Open status
            </button>
          </span>
        ) : isPartial ? (
          <span>Partial telemetry. {rangePreset}-day average uses available samples only.</span>
        ) : (
          <span>{plot.baselineHint}</span>
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
