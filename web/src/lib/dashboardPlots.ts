import { type PlotAggregation, type PlotDirection, type PlotReduceMethod } from "./api";
import { parseClockTimeToMinutes } from "./time";

export type DashboardPlotChartStyle = "line" | "sleepWindowBars";

export interface DashboardPlotPreference<TPlotKey extends string = string> {
  id: string;
  key: TPlotKey;
  direction: PlotDirection;
  aggregation: PlotAggregation;
  rolling: boolean;
  reduceMethod: PlotReduceMethod;
  chartStyle: DashboardPlotChartStyle;
}

export interface SleepWindowChartRecord {
  date: string;
  fellAsleepAt?: string | null;
  wokeUpAt?: string | null;
}

export interface SleepWindowChartPoint {
  date: string;
  dayLabel: string;
  sleepWindowBase: number | null;
  sleepWindowDuration: number | null;
  bedtimeValue: number | null;
  wakeValue: number | null;
}

export interface SleepWindowChartStats {
  points: SleepWindowChartPoint[];
  averageBedtime: number | null;
  averageWakeTime: number | null;
  axisOffsetMinutes: number;
  domain: [number, number];
  ticks: number[];
}

const CLOCK_STEP_MINUTES = 15;
const OVERNIGHT_SPLIT_MINUTES = 12 * 60;
const OVERNIGHT_DAY_MINUTES = 24 * 60;
const DEFAULT_SLEEP_WINDOW_DOMAIN: [number, number] = [18 * 60, 32 * 60];

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function unique(values: number[]): number[] {
  return Array.from(new Set(values));
}

function sanitizePlotKeyForId(plotKey: string): string {
  const normalized = plotKey.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "plot";
}

function withUniqueId(candidate: string, usedIds: Set<string>, index: number): string {
  let nextId = candidate;
  if (usedIds.has(nextId)) {
    nextId = `${candidate}_${index + 1}`;
  }
  let suffix = 1;
  while (usedIds.has(nextId)) {
    suffix += 1;
    nextId = `${candidate}_${index + 1}_${suffix}`;
  }
  usedIds.add(nextId);
  return nextId;
}

function fallbackPlotId(plotKey: string, index: number): string {
  return `plot_${index + 1}_${sanitizePlotKeyForId(plotKey)}`;
}

function resolveChartStyle(rawValue: unknown): DashboardPlotChartStyle {
  if (rawValue === "line" || rawValue === "sleepWindowBars") {
    return rawValue;
  }
  return "line";
}

export function createDashboardPlotId(): string {
  return `plot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeDashboardPlotPreferences<TPlotKey extends string>(
  raw: unknown,
  fallback: DashboardPlotPreference<TPlotKey>[],
  defaultDirection: (plotKey: TPlotKey) => PlotDirection,
): DashboardPlotPreference<TPlotKey>[] {
  if (!Array.isArray(raw)) {
    return fallback;
  }

  const normalized: DashboardPlotPreference<TPlotKey>[] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    let key: TPlotKey | null = null;
    let direction: PlotDirection | null = null;
    let aggregation: PlotAggregation = "daily";
    let rolling = false;
    let reduceMethod: PlotReduceMethod = "mean";
    let chartStyle: DashboardPlotChartStyle = "line";
    let idCandidate: string | null = null;

    if (typeof entry === "string") {
      key = entry as TPlotKey;
      direction = defaultDirection(key);
      idCandidate = fallbackPlotId(key, index);
    } else if (entry && typeof entry === "object") {
      const objectEntry = entry as Partial<DashboardPlotPreference<TPlotKey>>;
      if (typeof objectEntry.key === "string") {
        key = objectEntry.key as TPlotKey;
      }
      if (objectEntry.direction === "higher" || objectEntry.direction === "lower") {
        direction = objectEntry.direction;
      }
      if (
        objectEntry.aggregation === "daily"
        || objectEntry.aggregation === "3days"
        || objectEntry.aggregation === "weekly"
      ) {
        aggregation = objectEntry.aggregation;
      }
      if (typeof objectEntry.rolling === "boolean") {
        rolling = objectEntry.rolling;
      }
      if (objectEntry.reduceMethod === "mean" || objectEntry.reduceMethod === "sum") {
        reduceMethod = objectEntry.reduceMethod;
      }
      chartStyle = resolveChartStyle(objectEntry.chartStyle);
      if (typeof objectEntry.id === "string" && objectEntry.id.trim()) {
        idCandidate = objectEntry.id.trim();
      }
    }

    if (!key) {
      continue;
    }
    if (!direction) {
      direction = defaultDirection(key);
    }
    const id = withUniqueId(idCandidate ?? fallbackPlotId(key, index), usedIds, index);
    normalized.push({ id, key, direction, aggregation, rolling, reduceMethod, chartStyle });
  }

  return normalized;
}

function toOvernightMinutes(clockMinutes: number): number {
  if (clockMinutes < OVERNIGHT_SPLIT_MINUTES) {
    return clockMinutes + OVERNIGHT_DAY_MINUTES;
  }
  return clockMinutes;
}

function roundDownStep(minutes: number): number {
  return Math.floor(minutes / CLOCK_STEP_MINUTES) * CLOCK_STEP_MINUTES;
}

function roundUpStep(minutes: number): number {
  return Math.ceil(minutes / CLOCK_STEP_MINUTES) * CLOCK_STEP_MINUTES;
}

function formatWeekday(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString(undefined, { weekday: "short" });
}

export function formatOvernightClockLabel(minutes: number): string {
  const normalized = ((Math.round(minutes) % OVERNIGHT_DAY_MINUTES) + OVERNIGHT_DAY_MINUTES) % OVERNIGHT_DAY_MINUTES;
  const hours = Math.floor(normalized / 60);
  const remainingMinutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}

export function buildSleepWindowChartStats(
  records: SleepWindowChartRecord[],
): SleepWindowChartStats {
  const points: SleepWindowChartPoint[] = [];
  const bedtimes: number[] = [];
  const wakeTimes: number[] = [];
  const allValues: number[] = [];

  for (const record of records) {
    const fellAsleepMinutes = typeof record.fellAsleepAt === "string"
      ? parseClockTimeToMinutes(record.fellAsleepAt)
      : null;
    const wokeUpMinutes = typeof record.wokeUpAt === "string"
      ? parseClockTimeToMinutes(record.wokeUpAt)
      : null;

    if (fellAsleepMinutes === null || wokeUpMinutes === null) {
      points.push({
        date: record.date,
        dayLabel: formatWeekday(record.date),
        sleepWindowBase: null,
        sleepWindowDuration: null,
        bedtimeValue: null,
        wakeValue: null,
      });
      continue;
    }

    const bedtimeValue = toOvernightMinutes(fellAsleepMinutes);
    let wakeValue = toOvernightMinutes(wokeUpMinutes);
    if (wakeValue <= bedtimeValue) {
      wakeValue += OVERNIGHT_DAY_MINUTES;
    }
    const sleepWindowDuration = wakeValue - bedtimeValue;

    points.push({
      date: record.date,
      dayLabel: formatWeekday(record.date),
      sleepWindowBase: bedtimeValue,
      sleepWindowDuration,
      bedtimeValue,
      wakeValue,
    });
    bedtimes.push(bedtimeValue);
    wakeTimes.push(wakeValue);
    allValues.push(bedtimeValue, wakeValue);
  }

  const averageBedtime = average(bedtimes);
  const averageWakeTime = average(wakeTimes);
  if (!allValues.length) {
    const start = DEFAULT_SLEEP_WINDOW_DOMAIN[0];
    const end = DEFAULT_SLEEP_WINDOW_DOMAIN[1];
    return {
      points,
      averageBedtime,
      averageWakeTime,
      axisOffsetMinutes: start,
      domain: [0, end - start],
      ticks: [0, 4 * 60, 12 * 60],
    };
  }

  const padding = 30;
  const minValue = roundDownStep(Math.min(...allValues) - padding);
  const maxValue = roundUpStep(Math.max(...allValues) + padding);
  const start = Math.max(0, minValue);
  const end = maxValue <= start ? start + CLOCK_STEP_MINUTES : maxValue;
  const middle = roundDownStep(start + (end - start) / 2);
  const ticks = unique([start, middle, end])
    .sort((left, right) => left - right)
    .map((value) => value - start);
  const shiftedAverageBedtime = averageBedtime === null ? null : averageBedtime - start;
  const shiftedAverageWakeTime = averageWakeTime === null ? null : averageWakeTime - start;
  const shiftedPoints = points.map((point) => {
    if (point.sleepWindowBase === null) {
      return point;
    }
    return {
      ...point,
      sleepWindowBase: point.sleepWindowBase - start,
    };
  });

  return {
    points: shiftedPoints,
    averageBedtime: shiftedAverageBedtime,
    averageWakeTime: shiftedAverageWakeTime,
    axisOffsetMinutes: start,
    domain: [0, end - start],
    ticks,
  };
}
