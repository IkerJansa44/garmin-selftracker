import { mean, pearsonCorrelation } from "./mockData";
import { flattenQuestionFields, type QuestionFieldDefinition } from "./questions";
import {
  type CheckInEntry,
  type CheckInQuestion,
  type DailyRecord,
  type DerivedPredictorDefinition,
  type MetricKey,
} from "./types";

export type BasePredictorKey = `garmin:${GarminPredictorKey}` | `question:${string}`;
export type DerivedPredictorKey = `derived:${string}`;
export type PredictorKey = BasePredictorKey | DerivedPredictorKey;
export type OutcomeKey = `metric:${MetricKey}` | `question:${string}`;

type GarminPredictorKey =
  | "steps"
  | "calories"
  | "stressAvg"
  | "bodyBattery"
  | "sleepSeconds"
  | "isTrainingDay";

export type CorrelationTestType = "continuous" | "categorical";
export type CorrelationClassification = "meaningful" | "exploratory" | "insufficient";

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

export interface CorrelationPairResult {
  key: string;
  predictor: PredictorKey;
  predictorLabel: string;
  outcome: OutcomeKey;
  outcomeLabel: string;
  points: Array<{ x: number; y: number; date: string }>;
  sampleCount: number;
  testType: CorrelationTestType;
  pValue: number | null;
  qValue: number | null;
  strength: number;
  classification: CorrelationClassification;
  direction: "higher" | "lower" | "similar";
  correlation: number | null;
  regression: { slope: number; intercept: number } | null;
  fStatistic: number | null;
  etaSquared: number | null;
  categoryLabels: string[] | null;
  categoryMeans: Array<number | null> | null;
  categoryCounts: number[] | null;
}

const GARMIN_PREDICTOR_LABELS: Record<GarminPredictorKey, string> = {
  steps: "Steps",
  calories: "Calories",
  stressAvg: "Stress Avg",
  bodyBattery: "Body Battery",
  sleepSeconds: "Sleep Duration (h)",
  isTrainingDay: "Training Day (1/0)",
};

const OUTCOME_LABELS: Record<MetricKey, string> = {
  recoveryIndex: "Recovery Index",
  sleepScore: "Sleep Score",
  restingHr: "Resting HR",
  stress: "Stress",
  bodyBattery: "Body Battery",
  trainingReadiness: "Training Readiness",
};

function shiftIsoDate(isoDate: string, offsetDays: number): string {
  const [year, month, day] = isoDate.split("-").map((value) => Number(value));
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1
    - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-(x * x)));
  return sign * y;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  const normalized = value - 1;
  const tail = coefficients.reduce(
    (sum, coefficient, index) => sum + coefficient / (normalized + index + 1),
    0.9999999999998099,
  );
  const t = normalized + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (normalized + 0.5) * Math.log(t) - t + Math.log(tail);
}

function betaContinuedFraction(x: number, alpha: number, beta: number): number {
  const maxIterations = 200;
  const epsilon = 3e-7;
  const tiny = 1e-30;

  let c = 1;
  let d = 1 - ((alpha + beta) * x) / (alpha + 1);
  if (Math.abs(d) < tiny) {
    d = tiny;
  }
  d = 1 / d;
  let result = d;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const m2 = 2 * iteration;
    const aa1 = (iteration * (beta - iteration) * x) / ((alpha + m2 - 1) * (alpha + m2));
    d = 1 + aa1 * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa1 / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    result *= d * c;

    const aa2 = (-(alpha + iteration) * (alpha + beta + iteration) * x)
      / ((alpha + m2) * (alpha + m2 + 1));
    d = 1 + aa2 * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa2 / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    result *= delta;

    if (Math.abs(delta - 1) < epsilon) {
      break;
    }
  }

  return result;
}

function regularizedIncompleteBeta(x: number, alpha: number, beta: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }

  const logBeta = logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
  const front = Math.exp(
    alpha * Math.log(x) + beta * Math.log(1 - x) - logBeta,
  ) / alpha;

  if (x < (alpha + 1) / (alpha + beta + 2)) {
    return front * betaContinuedFraction(x, alpha, beta);
  }

  return 1 - (
    (Math.exp(alpha * Math.log(x) + beta * Math.log(1 - x) - logBeta) / beta)
    * betaContinuedFraction(1 - x, beta, alpha)
  );
}

function fDistributionCdf(value: number, d1: number, d2: number): number {
  if (value <= 0 || d1 <= 0 || d2 <= 0) {
    return 0;
  }
  const transformed = (d1 * value) / (d1 * value + d2);
  return regularizedIncompleteBeta(transformed, d1 / 2, d2 / 2);
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

function pearsonPValue(correlation: number, sampleCount: number): number | null {
  if (sampleCount < 4) {
    return null;
  }
  const bounded = clamp(correlation, -0.999999, 0.999999);
  const fisherZ = 0.5 * Math.log((1 + bounded) / (1 - bounded));
  const zScore = fisherZ * Math.sqrt(sampleCount - 3);
  const oneTail = 1 - normalCdf(Math.abs(zScore));
  return clamp(oneTail * 2, 0, 1);
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

function parseBasePredictorValue(
  predictor: BasePredictorKey,
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
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    if (key === "sleepSeconds") {
      return value / 3600;
    }
    return value;
  }

  const questionId = predictor.slice(9);
  const question = questionsById.get(questionId);
  if (!question || question.analysisMode !== "predictor_next_day") {
    return null;
  }
  const entry = checkinsByDate.get(predictorDate);
  return parseQuestionValue(question, entry?.answers[questionId]);
}

function derivedBinIndex(value: number, cutPoints: number[]): number {
  let index = 0;
  while (index < cutPoints.length && value >= cutPoints[index]) {
    index += 1;
  }
  return index;
}

function parsePredictorValue(
  predictor: PredictorKey,
  recordsByDate: Map<string, DailyRecord>,
  checkinsByDate: Map<string, CheckInEntry>,
  questionsById: Map<string, QuestionFieldDefinition>,
  derivedById: Map<string, DerivedPredictorDefinition>,
  outcomeDate: string,
): number | null {
  if (predictor.startsWith("derived:")) {
    const derivedId = predictor.slice(8);
    const definition = derivedById.get(derivedId);
    if (!definition) {
      return null;
    }
    const sourceValue = parseBasePredictorValue(
      definition.sourceKey as BasePredictorKey,
      recordsByDate,
      checkinsByDate,
      questionsById,
      outcomeDate,
    );
    if (sourceValue === null) {
      return null;
    }
    return derivedBinIndex(sourceValue, definition.cutPoints);
  }

  return parseBasePredictorValue(
    predictor,
    recordsByDate,
    checkinsByDate,
    questionsById,
    outcomeDate,
  );
}

function parseOutcomeValue(
  outcome: OutcomeKey,
  record: DailyRecord,
  checkinsByDate: Map<string, CheckInEntry>,
  questionsById: Map<string, QuestionFieldDefinition>,
): number | null {
  if (outcome.startsWith("metric:")) {
    const metric = outcome.slice(7) as MetricKey;
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

function buildContinuousPair(
  points: Array<{ x: number; y: number; date: string }>,
): Pick<
  CorrelationPairResult,
  "testType" | "pValue" | "strength" | "direction" | "correlation" | "regression" | "fStatistic" | "etaSquared" | "categoryLabels" | "categoryMeans" | "categoryCounts"
> {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const correlation = pearsonCorrelation(xs, ys);
  const regression = calculateRegression(xs, ys);
  const pValue = pearsonPValue(correlation, points.length);

  let direction: "higher" | "lower" | "similar" = "similar";
  if (regression.slope > 0) {
    direction = "higher";
  } else if (regression.slope < 0) {
    direction = "lower";
  }

  return {
    testType: "continuous",
    pValue,
    strength: Math.abs(correlation),
    direction,
    correlation,
    regression,
    fStatistic: null,
    etaSquared: null,
    categoryLabels: null,
    categoryMeans: null,
    categoryCounts: null,
  };
}

function buildCategoricalPair(
  points: Array<{ x: number; y: number; date: string }>,
  labels: string[],
): Pick<
  CorrelationPairResult,
  "testType" | "pValue" | "strength" | "direction" | "correlation" | "regression" | "fStatistic" | "etaSquared" | "categoryLabels" | "categoryMeans" | "categoryCounts"
> {
  const categoryCount = labels.length;
  const groups: number[][] = Array.from({ length: categoryCount }, () => []);
  for (const point of points) {
    const categoryIndex = Math.max(0, Math.min(categoryCount - 1, Math.round(point.x)));
    groups[categoryIndex].push(point.y);
  }

  const totalValues = groups.flat();
  if (!totalValues.length) {
    return {
      testType: "categorical",
      pValue: null,
      strength: 0,
      direction: "similar",
      correlation: null,
      regression: null,
      fStatistic: 0,
      etaSquared: 0,
      categoryLabels: labels,
      categoryMeans: groups.map(() => null),
      categoryCounts: groups.map(() => 0),
    };
  }

  const totalMean = mean(totalValues);
  const categoryMeans = groups.map((group) => (group.length ? mean(group) : null));
  const categoryCounts = groups.map((group) => group.length);
  const nonEmptyGroups = groups.filter((group) => group.length > 0);

  let ssBetween = 0;
  let ssWithin = 0;
  for (const group of groups) {
    if (!group.length) {
      continue;
    }
    const groupMean = mean(group);
    ssBetween += group.length * (groupMean - totalMean) ** 2;
    ssWithin += group.reduce((sum, value) => sum + (value - groupMean) ** 2, 0);
  }

  const df1 = nonEmptyGroups.length - 1;
  const df2 = totalValues.length - nonEmptyGroups.length;

  let fStatistic = 0;
  let pValue: number | null = null;

  if (df1 > 0 && df2 > 0) {
    if (ssWithin === 0) {
      if (ssBetween > 0) {
        fStatistic = Number.POSITIVE_INFINITY;
        pValue = 0;
      } else {
        fStatistic = 0;
        pValue = 1;
      }
    } else {
      fStatistic = (ssBetween / df1) / (ssWithin / df2);
      const cdf = fDistributionCdf(fStatistic, df1, df2);
      pValue = clamp(1 - cdf, 0, 1);
    }
  }

  const etaSquared = (ssBetween + ssWithin) > 0 ? ssBetween / (ssBetween + ssWithin) : 0;
  const firstMean = categoryMeans.find((groupMean) => groupMean !== null);
  const lastMean = [...categoryMeans].reverse().find((groupMean) => groupMean !== null);

  let direction: "higher" | "lower" | "similar" = "similar";
  if (firstMean !== undefined && lastMean !== undefined && firstMean !== null && lastMean !== null) {
    if (lastMean > firstMean) {
      direction = "higher";
    } else if (lastMean < firstMean) {
      direction = "lower";
    }
  }

  return {
    testType: "categorical",
    pValue,
    strength: Math.sqrt(Math.max(etaSquared, 0)),
    direction,
    correlation: null,
    regression: null,
    fStatistic,
    etaSquared,
    categoryLabels: labels,
    categoryMeans,
    categoryCounts,
  };
}

function applyBenjaminiHochberg(pairs: CorrelationPairResult[]): void {
  const indices = pairs
    .map((pair, index) => ({ index, pValue: pair.pValue }))
    .filter(
      (
        entry,
      ): entry is { index: number; pValue: number } => (
        entry.pValue !== null && Number.isFinite(entry.pValue)
      ),
    )
    .sort((left, right) => left.pValue - right.pValue);

  if (!indices.length) {
    for (const pair of pairs) {
      pair.qValue = null;
    }
    return;
  }

  const count = indices.length;
  const adjusted = new Array<number>(count).fill(1);
  for (let position = count - 1; position >= 0; position -= 1) {
    const rank = position + 1;
    const raw = (indices[position].pValue * count) / rank;
    const bounded = clamp(raw, 0, 1);
    adjusted[position] = position === count - 1 ? bounded : Math.min(bounded, adjusted[position + 1]);
  }

  for (let position = 0; position < count; position += 1) {
    pairs[indices[position].index].qValue = adjusted[position];
  }
  for (const pair of pairs) {
    if (pair.pValue === null) {
      pair.qValue = null;
    }
  }
}

function classifyPair(pair: CorrelationPairResult): CorrelationClassification {
  if (pair.sampleCount < 12) {
    return "insufficient";
  }
  if (
    pair.sampleCount >= 20
    && pair.strength >= 0.2
    && pair.qValue !== null
    && pair.qValue < 0.05
  ) {
    return "meaningful";
  }
  return "exploratory";
}

function buildPairKey(predictor: PredictorKey, outcome: OutcomeKey): string {
  return `${predictor}__${outcome}`;
}

export function buildDerivedPredictorSourceOptions(questions: CheckInQuestion[]): CorrelationOption[] {
  const fields = flattenQuestionFields(questions);
  const garminOptions = (Object.keys(GARMIN_PREDICTOR_LABELS) as GarminPredictorKey[])
    .filter((key) => key !== "isTrainingDay")
    .map((key) => ({
      key: `garmin:${key}`,
      label: GARMIN_PREDICTOR_LABELS[key],
    }));
  const questionOptions = fields
    .filter((question) => question.analysisMode === "predictor_next_day")
    .filter((question) => question.inputType === "slider" || question.inputType === "time")
    .map((question) => ({
      key: `question:${question.id}`,
      label: `${question.prompt} (prev day)`,
    }));
  return [...garminOptions, ...questionOptions];
}

export function buildPredictorOptions(
  questions: CheckInQuestion[],
  derivedPredictors: DerivedPredictorDefinition[] = [],
): CorrelationOption[] {
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
  const derivedOptions = derivedPredictors.map((definition) => ({
    key: `derived:${definition.id}`,
    label: `${definition.name} (derived)`,
  }));
  return [...garminOptions, ...questionOptions, ...derivedOptions];
}

export function buildOutcomeOptions(questions: CheckInQuestion[]): CorrelationOption[] {
  const fields = flattenQuestionFields(questions);
  const metricOptions = (Object.keys(OUTCOME_LABELS) as MetricKey[]).map((key) => ({
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

export function calculateQuantileCutPoints(values: number[], bins: number): number[] {
  if (bins < 2 || bins > 5 || values.length < bins) {
    return [];
  }
  const sorted = [...values].sort((left, right) => left - right);
  const cutPoints: number[] = [];
  for (let index = 1; index < bins; index += 1) {
    const rawRank = (index / bins) * (sorted.length - 1);
    const lower = Math.floor(rawRank);
    const upper = Math.ceil(rawRank);
    const weight = rawRank - lower;
    const interpolated = sorted[lower] * (1 - weight) + sorted[upper] * weight;
    cutPoints.push(interpolated);
  }

  const uniqueCutPoints = cutPoints.filter((cutPoint, index) => (
    index === 0 || cutPoint > cutPoints[index - 1]
  ));
  return uniqueCutPoints.length === bins - 1 ? uniqueCutPoints : [];
}

export function buildPredictorDistribution({
  records,
  checkinsByDate,
  questions,
  predictor,
  weekdayOnly,
  trainingOnly,
}: {
  records: DailyRecord[];
  checkinsByDate: Map<string, CheckInEntry>;
  questions: CheckInQuestion[];
  predictor: BasePredictorKey;
  weekdayOnly: boolean;
  trainingOnly: boolean;
}): number[] {
  const recordsByDate = new Map(records.map((record) => [record.date, record]));
  const questionFields = flattenQuestionFields(questions);
  const questionsById = new Map(questionFields.map((question) => [question.id, question]));
  const values: number[] = [];

  for (const record of records) {
    if (weekdayOnly && (record.weekday === 0 || record.weekday === 6)) {
      continue;
    }
    if (trainingOnly && !record.isTrainingDay) {
      continue;
    }
    const value = parseBasePredictorValue(
      predictor,
      recordsByDate,
      checkinsByDate,
      questionsById,
      record.date,
    );
    if (value === null) {
      continue;
    }
    values.push(value);
  }

  return values;
}

export function buildCorrelationCatalog({
  records,
  checkinsByDate,
  questions,
  derivedPredictors,
  weekdayOnly,
  trainingOnly,
}: {
  records: DailyRecord[];
  checkinsByDate: Map<string, CheckInEntry>;
  questions: CheckInQuestion[];
  derivedPredictors: DerivedPredictorDefinition[];
  weekdayOnly: boolean;
  trainingOnly: boolean;
}): CorrelationPairResult[] {
  const recordsByDate = new Map(records.map((record) => [record.date, record]));
  const questionFields = flattenQuestionFields(questions);
  const questionsById = new Map(questionFields.map((question) => [question.id, question]));
  const derivedById = new Map(derivedPredictors.map((definition) => [definition.id, definition]));

  const predictorOptions = buildPredictorOptions(questions, derivedPredictors);
  const outcomeOptions = buildOutcomeOptions(questions);

  const pairs: CorrelationPairResult[] = [];

  for (const predictorOption of predictorOptions) {
    const predictor = predictorOption.key as PredictorKey;
    for (const outcomeOption of outcomeOptions) {
      const outcome = outcomeOption.key as OutcomeKey;
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
          derivedById,
          record.date,
        );
        const y = parseOutcomeValue(outcome, record, checkinsByDate, questionsById);
        if (x === null || y === null) {
          continue;
        }
        points.push({ x, y, date: record.date });
      }

      const isDerived = predictor.startsWith("derived:");
      const definition = isDerived ? derivedById.get(predictor.slice(8)) : null;
      const testResult = isDerived && definition
        ? buildCategoricalPair(points, definition.labels)
        : buildContinuousPair(points);

      pairs.push({
        key: buildPairKey(predictor, outcome),
        predictor,
        predictorLabel: predictorOption.label,
        outcome,
        outcomeLabel: outcomeOption.label,
        points,
        sampleCount: points.length,
        qValue: null,
        classification: "insufficient",
        ...testResult,
      });
    }
  }

  applyBenjaminiHochberg(pairs);
  for (const pair of pairs) {
    pair.classification = classifyPair(pair);
  }

  pairs.sort((left, right) => {
    if (right.strength !== left.strength) {
      return right.strength - left.strength;
    }
    if (right.sampleCount !== left.sampleCount) {
      return right.sampleCount - left.sampleCount;
    }
    const predictorSort = left.predictorLabel.localeCompare(right.predictorLabel);
    if (predictorSort !== 0) {
      return predictorSort;
    }
    return left.outcomeLabel.localeCompare(right.outcomeLabel);
  });

  return pairs;
}

export function findCorrelationPair(
  pairs: CorrelationPairResult[],
  predictor: PredictorKey,
  outcome: OutcomeKey,
): CorrelationPairResult | null {
  const key = buildPairKey(predictor, outcome);
  return pairs.find((pair) => pair.key === key) ?? null;
}

export function buildCorrelationResult({
  records,
  checkinsByDate,
  questions,
  predictor,
  outcome,
  derivedPredictors = [],
  weekdayOnly,
  trainingOnly,
}: {
  records: DailyRecord[];
  checkinsByDate: Map<string, CheckInEntry>;
  questions: CheckInQuestion[];
  predictor: PredictorKey;
  outcome: OutcomeKey;
  derivedPredictors?: DerivedPredictorDefinition[];
  weekdayOnly: boolean;
  trainingOnly: boolean;
}): CorrelationResult {
  const recordsByDate = new Map(records.map((record) => [record.date, record]));
  const questionFields = flattenQuestionFields(questions);
  const questionsById = new Map(questionFields.map((question) => [question.id, question]));
  const derivedById = new Map(derivedPredictors.map((definition) => [definition.id, definition]));
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
      derivedById,
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
