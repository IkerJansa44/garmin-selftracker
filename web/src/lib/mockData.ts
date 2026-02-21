import { DEFAULT_QUESTIONS } from "./constants";
import {
  CheckInEntry,
  CheckInFactors,
  CoverageState,
  DailyRecord,
  MetricKey,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOTAL_DAYS = 365;

const METRIC_RANGES: Record<MetricKey, { min: number; max: number }> = {
  recoveryIndex: { min: 30, max: 110 },
  sleepScore: { min: 40, max: 100 },
  restingHr: { min: 42, max: 72 },
  stress: { min: 10, max: 85 },
  bodyBattery: { min: 15, max: 100 },
  trainingReadiness: { min: 20, max: 100 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeImportState(dayIndex: number, isGap: boolean): "ok" | "running" | "failed" {
  if (isGap) {
    return "failed";
  }
  if (dayIndex === TOTAL_DAYS - 1) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes >= 355 && minutes <= 390) {
      return "running";
    }
  }
  return "ok";
}

function buildCheckInFactors(dayIndex: number, weekday: number): CheckInFactors {
  const weekend = weekday === 0 || weekday === 6;
  const trainingIntensityBase = weekend ? 4 : weekday === 2 || weekday === 4 ? 7 : 5;
  const trainingIntensity = clamp(
    Math.round(trainingIntensityBase + (noise(dayIndex + 100) - 0.5) * 3),
    0,
    10,
  );
  const alcoholUnits = clamp(
    weekend
      ? Math.round(noise(dayIndex + 222) * 3)
      : Math.round(Math.max(0, noise(dayIndex + 222) * 2 - 0.4)),
    0,
    3,
  );

  const types = ["Easy", "Tempo", "Interval", "Strength", "Rest"];
  const typeIndex = trainingIntensity < 2 ? 4 : Math.min(3, Math.floor(noise(dayIndex + 9) * 4));

  return {
    trainingIntensity,
    trainingType: types[typeIndex],
    caffeineCount: clamp(Math.round(1 + noise(dayIndex + 88) * 4), 0, 8),
    alcoholUnits,
    lateMeal: noise(dayIndex + 201) > 0.73,
    lateScreenMinutes: clamp(Math.round(noise(dayIndex + 166) * 150), 0, 180),
    thermalRecovery: ["None", "Sauna", "Cold", "Both"][Math.floor(noise(dayIndex + 81) * 4)],
    mood: clamp(Math.round(5 + (noise(dayIndex + 300) - 0.35) * 5), 0, 10),
    notes: "",
  };
}

function coverageFor(
  metric: MetricKey,
  isGap: boolean,
  isPartial: boolean,
  dayIndex: number,
): CoverageState {
  if (isGap) {
    return "missing";
  }
  if (!isPartial) {
    return "complete";
  }
  const metricShift =
    metric === "recoveryIndex"
      ? 7
      : metric === "sleepScore"
        ? 11
        : metric === "restingHr"
          ? 17
          : metric === "stress"
            ? 19
            : metric === "bodyBattery"
              ? 23
              : 29;
  return noise(dayIndex + metricShift) > 0.5 ? "complete" : "partial";
}

function metricValue(
  metric: MetricKey,
  dayIndex: number,
  weekday: number,
  current: CheckInFactors,
  previous: CheckInFactors | null,
): number {
  const weekend = weekday === 0 || weekday === 6;
  const prevAlcohol = previous?.alcoholUnits ?? 0;
  const prevIntensity = previous?.trainingIntensity ?? 5;
  const prevLateScreen = previous?.lateScreenMinutes ?? 40;

  let value = 0;

  if (metric === "sleepScore") {
    value =
      79 +
      (weekend ? 4 : 0) -
      prevAlcohol * 4.6 -
      prevLateScreen / 50 +
      current.mood * 0.6 +
      (noise(dayIndex + 1) - 0.5) * 8;
  } else if (metric === "recoveryIndex") {
    value =
      64 -
      prevIntensity * 1.8 -
      prevAlcohol * 1.6 +
      (weekend ? 2.4 : 0) +
      (noise(dayIndex + 2) - 0.5) * 10;
  } else if (metric === "restingHr") {
    value =
      52 +
      prevIntensity * 0.62 +
      prevAlcohol * 0.95 +
      current.caffeineCount * 0.35 +
      (noise(dayIndex + 3) - 0.5) * 4;
  } else if (metric === "stress") {
    value =
      33 +
      current.caffeineCount * 1.4 +
      prevIntensity * 1.1 -
      current.mood * 1.2 +
      (noise(dayIndex + 4) - 0.5) * 9;
  } else if (metric === "bodyBattery") {
    value =
      74 +
      (weekend ? 2.5 : 0) +
      current.mood * 1.1 -
      prevAlcohol * 3.4 -
      prevIntensity * 1.2 +
      (noise(dayIndex + 5) - 0.5) * 10;
  } else {
    value =
      70 +
      current.mood * 1.2 -
      prevAlcohol * 4.2 -
      prevIntensity * 1.4 +
      (noise(dayIndex + 6) - 0.5) * 10;
  }

  const range = METRIC_RANGES[metric];
  return clamp(Math.round(value), range.min, range.max);
}

export function generateMockRecords(totalDays = TOTAL_DAYS): DailyRecord[] {
  const today = new Date();
  const start = new Date(today.getTime() - (totalDays - 1) * DAY_MS);
  const records: DailyRecord[] = [];

  for (let dayIndex = 0; dayIndex < totalDays; dayIndex += 1) {
    const date = new Date(start.getTime() + dayIndex * DAY_MS);
    const weekday = date.getDay();

    const importGap =
      (dayIndex % 97 >= 71 && dayIndex % 97 <= 73) ||
      (dayIndex % 131 >= 44 && dayIndex % 131 <= 45);
    const partial = !importGap && (dayIndex % 53 === 0 || (dayIndex > 0 && records[dayIndex - 1].importGap));

    const currentFactors = buildCheckInFactors(dayIndex, weekday);
    const previousFactors = records[dayIndex - 1]?.checkInFactors ?? null;

    const metrics: DailyRecord["metrics"] = {
      recoveryIndex: null,
      sleepScore: null,
      restingHr: null,
      stress: null,
      bodyBattery: null,
      trainingReadiness: null,
    };

    const coverage: DailyRecord["coverage"] = {
      recoveryIndex: "missing",
      sleepScore: "missing",
      restingHr: "missing",
      stress: "missing",
      bodyBattery: "missing",
      trainingReadiness: "missing",
    };

    (Object.keys(metrics) as MetricKey[]).forEach((metric) => {
      coverage[metric] = coverageFor(metric, importGap, partial, dayIndex);
      if (coverage[metric] === "missing") {
        metrics[metric] = null;
        return;
      }
      metrics[metric] = metricValue(metric, dayIndex, weekday, currentFactors, previousFactors);
      if (coverage[metric] === "partial" && noise(dayIndex * 5 + metric.length) > 0.66) {
        metrics[metric] = null;
      }
    });

    records.push({
      date: formatDateKey(date),
      dayIndex,
      weekday,
      isTrainingDay: currentFactors.trainingIntensity >= 6,
      importGap,
      importState: normalizeImportState(dayIndex, importGap),
      predictors: {
        steps: currentFactors.trainingIntensity * 1200 + Math.round(noise(dayIndex + 71) * 2500),
        calories: 1700 + currentFactors.trainingIntensity * 120,
        stressAvg: metrics.stress,
        bodyBattery: metrics.bodyBattery,
        sleepSeconds: metrics.sleepScore === null ? null : metrics.sleepScore * 300,
        isTrainingDay: currentFactors.trainingIntensity >= 6,
      },
      metrics,
      coverage,
      checkInFactors: currentFactors,
    });
  }

  return records;
}

export function generateHistoryFromRecords(records: DailyRecord[]): CheckInEntry[] {
  return records
    .slice(-42)
    .filter((record, index) => index % 3 !== 0)
    .map((record, index) => {
      const alcoholUnits = record.checkInFactors.alcoholUnits;
      const alcoholLabel = alcoholUnits >= 3 ? "3plus" : String(alcoholUnits);
      const caffeineCount = record.checkInFactors.caffeineCount;
      const mealFinishTime = record.checkInFactors.lateMeal ? "21:15" : "19:30";
      const sleepTime = record.checkInFactors.lateMeal ? "23:30" : "22:45";

      return {
        date: record.date,
        completedAt: `${record.date}T21:${String((index * 7) % 59).padStart(2, "0")}:00Z`,
        answers: {
          caffeine_count: caffeineCount,
          ...(caffeineCount > 0 ? { caffeine_last_time: "15:30" } : {}),
          alcohol_units: alcoholLabel,
          ...(alcoholUnits > 0 ? { alcohol_last_time: "20:45" } : {}),
          late_meal: mealFinishTime,
          sleep_time: sleepTime,
          screen_minutes: record.checkInFactors.lateScreenMinutes,
          thermal: record.checkInFactors.thermalRecovery.toLowerCase(),
          mood: record.checkInFactors.mood,
          notes: record.checkInFactors.notes,
        },
      };
    });
}

export function defaultDraftAnswers(
  questions = DEFAULT_QUESTIONS,
): Record<string, string | number | boolean> {
  return questions.reduce<Record<string, string | number | boolean>>((accumulator, question) => {
    if (question.inputType === "slider") {
      accumulator[question.id] = question.min ?? 0;
      return accumulator;
    }
    if (question.inputType === "boolean") {
      return accumulator;
    }
    accumulator[question.id] = "";
    return accumulator;
  }, {});
}

export function rollingAverage(values: Array<number | null>, period: number): Array<number | null> {
  return values.map((_, index) => {
    const start = Math.max(0, index - period + 1);
    const window = values.slice(start, index + 1).filter((value): value is number => value !== null);
    if (!window.length) {
      return null;
    }
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

export function ema(values: Array<number | null>, period: number): Array<number | null> {
  const alpha = 2 / (period + 1);
  let previous: number | null = null;
  return values.map((value) => {
    if (value === null) {
      return previous;
    }
    if (previous === null) {
      previous = value;
      return value;
    }
    previous = value * alpha + previous * (1 - alpha);
    return previous;
  });
}

export function mean(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) {
    return 0;
  }
  const meanX = mean(xs);
  const meanY = mean(ys);

  let numerator = 0;
  let left = 0;
  let right = 0;

  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] - meanX;
    const y = ys[i] - meanY;
    numerator += x * y;
    left += x ** 2;
    right += y ** 2;
  }

  if (left === 0 || right === 0) {
    return 0;
  }

  return numerator / Math.sqrt(left * right);
}

export function histogram(values: number[], bins = 10): Array<{ bucket: string; count: number }> {
  if (!values.length) {
    return [];
  }
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = maxValue - minValue || 1;
  const step = span / bins;

  return Array.from({ length: bins }, (_, index) => {
    const bucketStart = minValue + step * index;
    const bucketEnd = bucketStart + step;
    const count = values.filter((value) =>
      index === bins - 1
        ? value >= bucketStart && value <= bucketEnd
        : value >= bucketStart && value < bucketEnd,
    ).length;

    return {
      bucket: `${Math.round(bucketStart)}-${Math.round(bucketEnd)}`,
      count,
    };
  });
}

export function shiftSeries(values: Array<number | null>, lagDays: 0 | 1 | 2): Array<number | null> {
  if (lagDays === 0) {
    return values;
  }
  const shifted = [...values];
  for (let i = shifted.length - 1; i >= 0; i -= 1) {
    shifted[i] = i - lagDays >= 0 ? values[i - lagDays] : null;
  }
  return shifted;
}

export function formatReadableDate(dateValue: string): string {
  return new Date(`${dateValue}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatTime(dateValue: string): string {
  return new Date(dateValue).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
