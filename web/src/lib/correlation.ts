import { mean, pearsonCorrelation } from "./mockData";
import { flattenQuestionFields, type QuestionFieldDefinition } from "./questions";
import {
  type CheckInEntry,
  type DailyRecord,
  type CheckInQuestion,
} from "./types";

export type PredictorKey = `garmin:${GarminPredictorKey}` | `question:${string}`;
export type OutcomeKey = `metric:${OutcomeMetricKey}` | `question:${string}`;

export type OutcomeMetricKey = "sleepScore" | "restingHr" | "trainingReadiness";
type GarminPredictorKey =
  | "steps"
  | "calories"
  | "stressAvg"
  | "bodyBattery"
  | "sleepSeconds"
  | "isTrainingDay";

export interface CorrelationOption {
  key: string;
  label: string;
}

export interface CorrelationResult {
  points: Array<{ x: number; y: number; date: string }>;
  correlation: number;
  sampleCount: number;
  regression: { slope: number; intercept: number };
}

const GARMIN_PREDICTOR_LABELS: Record<GarminPredictorKey, string> = {
  steps: "Steps",
  calories: "Calories",
  stressAvg: "Stress Avg",
  bodyBattery: "Body Battery",
  sleepSeconds: "Sleep Seconds",
  isTrainingDay: "Training Day (1/0)",
};

const OUTCOME_LABELS: Record<OutcomeMetricKey, string> = {
  sleepScore: "Sleep Score",
  restingHr: "Resting HR",
  trainingReadiness: "Training Readiness",
};

function shiftIsoDate(isoDate: string, offsetDays: number): string {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function calculateRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  if (xs.length < 2) {
    return { slope: 0, intercept: 0 };
  }
  const avgX = mean(xs);
  const avgY = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - avgX) * (ys[index] - avgY);
    denominator += (xs[index] - avgX) ** 2;
  }
  if (denominator === 0) {
    return { slope: 0, intercept: avgY };
  }
  const slope = numerator / denominator;
  return {
    slope,
    intercept: avgY - slope * avgX,
  };
}

function parseQuestionValue(question: QuestionFieldDefinition, value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (question.inputType === "text") {
    return null;
  }
  if (question.inputType === "boolean") {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    return null;
  }
  if (question.inputType === "time") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string") {
      return null;
    }
    if (!/^\d{2}:\d{2}$/.test(value)) {
      return null;
    }
    const [hours, minutes] = value.split(":").map((raw) => Number(raw));
    if (
      !Number.isFinite(hours)
      || !Number.isFinite(minutes)
      || hours < 0
      || hours > 23
      || minutes < 0
      || minutes > 59
    ) {
      return null;
    }
    return hours * 60 + minutes;
  }
  if (question.inputType === "multi-choice") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
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
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function parsePredictorValue(
  predictor: PredictorKey,
  recordsByDate: Map<string, DailyRecord>,
  checkinsByDate: Map<string, CheckInEntry>,
  questionsById: Map<string, QuestionFieldDefinition>,
  outcomeDate: string,
): number | null {
  const predictorDate = shiftIsoDate(outcomeDate, -1);
  const predictorRecord = recordsByDate.get(predictorDate);
  if (predictor.startsWith("garmin:")) {
    if (!predictorRecord) {
      return null;
    }
    const key = predictor.slice(7) as GarminPredictorKey;
    if (key === "isTrainingDay") {
      return predictorRecord.predictors.isTrainingDay ? 1 : 0;
    }
    const value = predictorRecord.predictors[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  const questionId = predictor.slice(9);
  const question = questionsById.get(questionId);
  if (!question || question.analysisMode !== "predictor_next_day") {
    return null;
  }
  const entry = checkinsByDate.get(predictorDate);
  return parseQuestionValue(question, entry?.answers[questionId]);
}

function parseOutcomeValue(
  outcome: OutcomeKey,
  record: DailyRecord,
  checkinsByDate: Map<string, CheckInEntry>,
  questionsById: Map<string, QuestionFieldDefinition>,
): number | null {
  if (outcome.startsWith("metric:")) {
    const metric = outcome.slice(7) as OutcomeMetricKey;
    return record.metrics[metric];
  }
  const questionId = outcome.slice(9);
  const question = questionsById.get(questionId);
  if (!question || question.analysisMode !== "target_same_day") {
    return null;
  }
  const entry = checkinsByDate.get(record.date);
  return parseQuestionValue(question, entry?.answers[questionId]);
}

export function buildPredictorOptions(questions: CheckInQuestion[]): CorrelationOption[] {
  const fields = flattenQuestionFields(questions);
  const garminOptions = (Object.keys(GARMIN_PREDICTOR_LABELS) as GarminPredictorKey[]).map(
    (key) => ({
      key: `garmin:${key}`,
      label: GARMIN_PREDICTOR_LABELS[key],
    }),
  );
  const questionOptions = fields
    .filter((question) => question.analysisMode === "predictor_next_day")
    .filter((question) => question.inputType !== "text")
    .map((question) => ({
      key: `question:${question.id}`,
      label: `${question.prompt} (prev day)`,
    }));
  return [...garminOptions, ...questionOptions];
}

export function buildOutcomeOptions(questions: CheckInQuestion[]): CorrelationOption[] {
  const fields = flattenQuestionFields(questions);
  const metricOptions = (Object.keys(OUTCOME_LABELS) as OutcomeMetricKey[]).map((key) => ({
    key: `metric:${key}`,
    label: OUTCOME_LABELS[key],
  }));
  const questionOptions = fields
    .filter((question) => question.analysisMode === "target_same_day")
    .filter((question) => question.inputType !== "text")
    .map((question) => ({
      key: `question:${question.id}`,
      label: `${question.prompt} (same day)`,
    }));
  return [...metricOptions, ...questionOptions];
}

export function getOptionLabel(
  options: CorrelationOption[],
  key: string,
  fallback: string,
): string {
  return options.find((option) => option.key === key)?.label ?? fallback;
}

export function buildCorrelationResult({
  records,
  checkinsByDate,
  questions,
  predictor,
  outcome,
  weekdayOnly,
  trainingOnly,
}: {
  records: DailyRecord[];
  checkinsByDate: Map<string, CheckInEntry>;
  questions: CheckInQuestion[];
  predictor: PredictorKey;
  outcome: OutcomeKey;
  weekdayOnly: boolean;
  trainingOnly: boolean;
}): CorrelationResult {
  const recordsByDate = new Map(records.map((record) => [record.date, record]));
  const questionFields = flattenQuestionFields(questions);
  const questionsById = new Map(questionFields.map((question) => [question.id, question]));
  const points: Array<{ x: number; y: number; date: string }> = [];

  for (const record of records) {
    if (weekdayOnly && (record.weekday === 0 || record.weekday === 6)) {
      continue;
    }
    if (trainingOnly && !record.isTrainingDay) {
      continue;
    }
    const x = parsePredictorValue(
      predictor,
      recordsByDate,
      checkinsByDate,
      questionsById,
      record.date,
    );
    const y = parseOutcomeValue(outcome, record, checkinsByDate, questionsById);
    if (x === null || y === null) {
      continue;
    }
    points.push({ x, y, date: record.date });
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    points,
    correlation: pearsonCorrelation(xs, ys),
    sampleCount: points.length,
    regression: calculateRegression(xs, ys),
  };
}
