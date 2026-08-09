import { describe, expect, it } from "vitest";

import {
  buildCorrelationCatalog,
  buildCorrelationResult,
  buildDerivedPredictorSourceOptions,
  buildOutcomeOptions,
  buildPredictorDistribution,
  buildPredictorOptions,
  calculateQuantileCutPoints,
  findCorrelationPair,
} from "../../src/lib/correlation";
import { pearsonCorrelation } from "../../src/lib/mockData";
import {
  type AnalysisValueRecord,
  type CheckInEntry,
  type CheckInQuestion,
  type DailyRecord,
  type DerivedPredictorDefinition,
} from "../../src/lib/types";

const QUESTIONS: CheckInQuestion[] = [
  {
    id: "caffeine_count",
    section: "Nutrition",
    prompt: "Caffeine",
    inputLabel: "Count",
    inputType: "slider",
    analysisMode: "predictor_next_day",
    min: 0,
    max: 8,
    step: 1,
    defaultIncluded: true,
  },
  {
    id: "late_meal",
    section: "Nutrition",
    prompt: "Finished eating at",
    inputType: "time",
    analysisMode: "predictor_next_day",
    defaultIncluded: true,
  },
  {
    id: "energy",
    section: "Recovery",
    prompt: "Energy",
    inputType: "slider",
    analysisMode: "target_same_day",
    min: 0,
    max: 10,
    step: 1,
    defaultIncluded: true,
  },
  {
    id: "notes",
    section: "Recovery",
    prompt: "Notes",
    inputType: "text",
    analysisMode: "target_same_day",
    defaultIncluded: true,
  },
];

function buildDate(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return date.toISOString().slice(0, 10);
}

function buildRecords(days: number): DailyRecord[] {
  return Array.from({ length: days }, (_, index) => {
    const previousCaffeine = index === 0 ? 2 : (index - 1) % 5;
    const recoveryIndex = 87 - previousCaffeine * 5;
    return {
      date: buildDate(index),
      dayIndex: index,
      weekday: index % 7,
      isTrainingDay: index % 2 === 0,
      importGap: false,
      importState: "ok",
      fellAsleepAt: null,
      predictors: {
        steps: 7000 + index * 100,
        calories: 2100 + (index % 4) * 120,
        stressAvg: 25 + (index % 5),
        bodyBattery: 70 - (index % 3),
        sleepSeconds: 25000 + (index % 4) * 900,
        vo2Max: 50 + (index % 4),
        avgHr1hBeforeSleep: 58 + (index % 5),
        sleepConsistency: 20 + (index % 6) * 3,
        isTrainingDay: index % 2 === 0,
        zone0Minutes: null,
        zone1Minutes: null,
        zone2Minutes: null,
        zone3Minutes: null,
        zone4Minutes: null,
        zone5Minutes: null,
        mealToSleepGapMinutes: null,
        caffeineToSleepGapMinutes: null,
      },
      metrics: {
        recoveryIndex,
        restingHr: 48 + previousCaffeine,
        stress: 28 + previousCaffeine,
        bodyBattery: 70 - previousCaffeine,
        trainingReadiness: recoveryIndex - 4,
        deepSleepPercentage: 18 + (index % 4) * 2,
        remSleepPercentage: 20 + (index % 3) * 2,
        remOrDeepSleepPercentage: 38 + (index % 5) * 2,
        avgOvernightHrv: 45 + (index % 6),
        sleepScore: 75 + (index % 8),
      },
      coverage: {
        recoveryIndex: "complete",
        restingHr: "complete",
        stress: "complete",
        bodyBattery: "complete",
        trainingReadiness: "complete",
        deepSleepPercentage: "complete",
        remSleepPercentage: "complete",
        remOrDeepSleepPercentage: "complete",
        avgOvernightHrv: "complete",
        sleepScore: "complete",
      },
    };
  });
}

function buildCheckins(days: number): Map<string, CheckInEntry> {
  const entries = new Map<string, CheckInEntry>();
  for (let index = 0; index < days; index += 1) {
    entries.set(buildDate(index), {
      date: buildDate(index),
      completedAt: `${buildDate(index)}T21:00:00+00:00`,
      answers: {
        caffeine_count: index % 5,
        late_meal: `2${index % 4}:15`,
        energy: Math.max(0, Math.min(10, 10 - (index % 5))),
      },
    });
  }
  return entries;
}

function buildAnalysisValues(
  records: DailyRecord[],
  checkinsByDate: Map<string, CheckInEntry>,
): AnalysisValueRecord[] {
  const values: AnalysisValueRecord[] = [];

  const addValue = (
    analysisDate: string,
    role: "predictor" | "target",
    featureKey: string,
    rawValue: unknown,
    sourceDate: string,
    lagDays: number,
  ) => {
    if (typeof rawValue === "boolean") {
      values.push({
        analysisDate,
        role,
        featureKey,
        valueNum: null,
        valueText: null,
        valueBool: rawValue,
        sourceDate,
        lagDays,
        alignmentRule: "test_fixture",
      });
      return;
    }
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) {
        return;
      }
      values.push({
        analysisDate,
        role,
        featureKey,
        valueNum: rawValue,
        valueText: null,
        valueBool: null,
        sourceDate,
        lagDays,
        alignmentRule: "test_fixture",
      });
      return;
    }
    if (typeof rawValue === "string" && rawValue.trim()) {
      values.push({
        analysisDate,
        role,
        featureKey,
        valueNum: null,
        valueText: rawValue,
        valueBool: null,
        sourceDate,
        lagDays,
        alignmentRule: "test_fixture",
      });
    }
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = index > 0 ? records[index - 1] : null;

    for (const [metricKey, metricValue] of Object.entries(record.metrics)) {
      addValue(
        record.date,
        "target",
        `metric:${metricKey}`,
        metricValue,
        record.date,
        0,
      );
    }

    const targetEntry = checkinsByDate.get(record.date);
    for (const [questionId, answerValue] of Object.entries(targetEntry?.answers ?? {})) {
      addValue(
        record.date,
        "target",
        `question:${questionId}`,
        answerValue,
        record.date,
        0,
      );
    }

    if (!previous) {
      continue;
    }

    for (const [predictorKey, predictorValue] of Object.entries(previous.predictors)) {
      addValue(
        record.date,
        "predictor",
        `garmin:${predictorKey}`,
        predictorValue,
        previous.date,
        -1,
      );
    }

    const predictorEntry = checkinsByDate.get(previous.date);
    for (const [questionId, answerValue] of Object.entries(
      predictorEntry?.answers ?? {},
    )) {
      addValue(
        record.date,
        "predictor",
        `question:${questionId}`,
        answerValue,
        previous.date,
        -1,
      );
    }
  }

  return values;
}

function buildModerateAnovaRecords(days: number): DailyRecord[] {
  return Array.from({ length: days }, (_, index) => {
    const priorGroup = index === 0 ? 0 : (index - 1) % 3;
    const noise = (index % 5) - 2;
    const recoveryIndex = 50 + noise + priorGroup * 0.8;
    return {
      date: buildDate(index),
      dayIndex: index,
      weekday: index % 7,
      isTrainingDay: index % 2 === 0,
      importGap: false,
      importState: "ok",
      fellAsleepAt: null,
      predictors: {
        steps: 7000 + index * 100,
        calories: 2100 + (index % 4) * 120,
        stressAvg: 25 + (index % 5),
        bodyBattery: 70 - (index % 3),
        sleepSeconds: 25000 + (index % 4) * 900,
        vo2Max: 50 + (index % 4),
        avgHr1hBeforeSleep: 58 + (index % 5),
        sleepConsistency: 20 + (index % 6) * 3,
        isTrainingDay: index % 2 === 0,
        zone0Minutes: null,
        zone1Minutes: null,
        zone2Minutes: null,
        zone3Minutes: null,
        zone4Minutes: null,
        zone5Minutes: null,
        mealToSleepGapMinutes: null,
        caffeineToSleepGapMinutes: null,
      },
      metrics: {
        recoveryIndex,
        restingHr: 48 + priorGroup,
        stress: 28 + priorGroup,
        bodyBattery: 70 - priorGroup,
        trainingReadiness: recoveryIndex - 4,
        deepSleepPercentage: 18 + (index % 4) * 2,
        remSleepPercentage: 20 + (index % 3) * 2,
        remOrDeepSleepPercentage: 38 + (index % 5) * 2,
        avgOvernightHrv: 45 + (index % 6),
        sleepScore: 75 + (index % 8),
      },
      coverage: {
        recoveryIndex: "complete",
        restingHr: "complete",
        stress: "complete",
        bodyBattery: "complete",
        trainingReadiness: "complete",
        deepSleepPercentage: "complete",
        remSleepPercentage: "complete",
        remOrDeepSleepPercentage: "complete",
        avgOvernightHrv: "complete",
        sleepScore: "complete",
      },
    };
  });
}

function buildThreeBinCheckins(days: number): Map<string, CheckInEntry> {
  const entries = new Map<string, CheckInEntry>();
  const caffeinePattern = [0, 1, 3];
  for (let index = 0; index < days; index += 1) {
    entries.set(buildDate(index), {
      date: buildDate(index),
      completedAt: `${buildDate(index)}T21:00:00+00:00`,
      answers: {
        caffeine_count: caffeinePattern[index % caffeinePattern.length],
        late_meal: "21:15",
        energy: 5,
      },
    });
  }
  return entries;
}

describe("correlation helpers", () => {
  it("matches Pearson reference values and rejects undefined correlations", () => {
    const xs = [43, 21, 25, 42, 57, 59];
    const ys = [99, 65, 79, 75, 87, 81];

    expect(pearsonCorrelation(xs, ys)).toBeCloseTo(0.5298089018901744, 12);
    expect(pearsonCorrelation(xs, xs.map((value) => -value))).toBeCloseTo(-1, 12);
    expect(pearsonCorrelation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearsonCorrelation([1], [1])).toBeNull();
    expect(pearsonCorrelation([1, 2], [1])).toBeNull();
  });

  it("matches reference Pearson significance and FDR values", () => {
    const records = buildRecords(7);
    const xs = [43, 21, 25, 42, 57, 59];
    const ys = [99, 65, 79, 75, 87, 81];
    const analysisValues = xs.flatMap((x, index): AnalysisValueRecord[] => [
      {
        analysisDate: records[index + 1].date,
        role: "predictor",
        featureKey: "garmin:steps",
        valueNum: x,
        valueText: null,
        valueBool: null,
        sourceDate: records[index].date,
        lagDays: -1,
        alignmentRule: "garmin_previous_day",
      },
      {
        analysisDate: records[index + 1].date,
        role: "target",
        featureKey: "metric:recoveryIndex",
        valueNum: ys[index],
        valueText: null,
        valueBool: null,
        sourceDate: records[index + 1].date,
        lagDays: 0,
        alignmentRule: "metric_same_day",
      },
    ]);
    const catalog = buildCorrelationCatalog({
      records,
      analysisValues,
      questions: [],
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });
    const pair = findCorrelationPair(catalog, "garmin:steps", "metric:recoveryIndex");

    expect(pair?.correlation).toBeCloseTo(0.5298089018901744, 12);
    expect(pair?.pValue).toBeCloseTo(0.306922352670643, 6);
    expect(pair?.qValue).toBeCloseTo(0.306922352670643, 6);
  });

  it("classifies a constant predictor as insufficient", () => {
    const records = buildRecords(20);
    const analysisValues = buildAnalysisValues(records, buildCheckins(20)).map(
      (value) => value.featureKey === "garmin:steps"
        ? { ...value, valueNum: 1000 }
        : value,
    );
    const catalog = buildCorrelationCatalog({
      records,
      analysisValues,
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });
    const pair = findCorrelationPair(catalog, "garmin:steps", "metric:recoveryIndex");

    expect(pair?.correlation).toBeNull();
    expect(pair?.pValue).toBeNull();
    expect(pair?.qValue).toBeNull();
    expect(pair?.classification).toBe("insufficient");
  });

  it("builds predictor and outcome options with expanded metric outcomes", () => {
    const predictors = buildPredictorOptions(QUESTIONS);
    const outcomes = buildOutcomeOptions(QUESTIONS);

    expect(predictors.some((option) => option.key === "question:caffeine_count")).toBe(true);
    expect(predictors.some((option) => option.key === "garmin:mealToSleepGapMinutes")).toBe(true);
    expect(predictors.some((option) => option.key === "garmin:caffeineToSleepGapMinutes")).toBe(true);
    expect(predictors.some((option) => option.key === "garmin:deepSleepPercentage")).toBe(false);
    expect(predictors.some((option) => option.key === "garmin:remSleepPercentage")).toBe(false);
    expect(predictors.some((option) => option.key === "garmin:remOrDeepSleepPercentage")).toBe(false);
    expect(predictors.some((option) => option.key === "garmin:sleepConsistency")).toBe(true);
    expect(predictors.some((option) => option.key === "question:late_meal")).toBe(false);
    expect(predictors.some((option) => option.key === "question:caffeine_last_time")).toBe(false);
    expect(outcomes.some((option) => option.key === "metric:recoveryIndex")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:stress")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:bodyBattery")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:deepSleepPercentage")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:remSleepPercentage")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:remOrDeepSleepPercentage")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:avgHr1hBeforeSleep")).toBe(true);
    expect(outcomes.some((option) => option.key === "question:notes")).toBe(false);
  });

  it("builds derived source options excluding training day binary predictor", () => {
    const options = buildDerivedPredictorSourceOptions(QUESTIONS);

    expect(options.some((option) => option.key === "garmin:steps")).toBe(true);
    expect(options.some((option) => option.key === "garmin:mealToSleepGapMinutes")).toBe(true);
    expect(options.some((option) => option.key === "garmin:caffeineToSleepGapMinutes")).toBe(true);
    expect(options.some((option) => option.key === "garmin:deepSleepPercentage")).toBe(false);
    expect(options.some((option) => option.key === "garmin:remSleepPercentage")).toBe(false);
    expect(options.some((option) => option.key === "garmin:remOrDeepSleepPercentage")).toBe(false);
    expect(options.some((option) => option.key === "garmin:sleepConsistency")).toBe(true);
    expect(options.some((option) => option.key === "garmin:isTrainingDay")).toBe(false);
    expect(options.some((option) => option.key === "question:caffeine_count")).toBe(true);
    expect(options.some((option) => option.key === "question:late_meal")).toBe(false);
    expect(options.some((option) => option.key === "question:caffeine_last_time")).toBe(false);
  });

  it("computes quantile cut points for 2..5 bins", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(calculateQuantileCutPoints(values, 2)).toHaveLength(1);
    expect(calculateQuantileCutPoints(values, 4)).toHaveLength(3);
    expect(calculateQuantileCutPoints([1, 1, 1, 1], 4)).toEqual([]);
  });

  it("builds meaningful continuous correlations and assigns FDR-adjusted q values", () => {
    const records = buildRecords(60);
    const checkinsByDate = buildCheckins(60);
    const analysisValues = buildAnalysisValues(records, checkinsByDate);
    const catalog = buildCorrelationCatalog({
      records,
      analysisValues,
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });

    const pair = findCorrelationPair(
      catalog,
      "question:caffeine_count",
      "metric:recoveryIndex",
    );

    expect(pair).not.toBeNull();
    expect(pair?.testType).toBe("continuous");
    expect(pair?.sampleCount).toBeGreaterThanOrEqual(50);
    expect(pair?.correlation).toBeLessThan(-0.7);
    expect(pair?.qValue).not.toBeNull();
    expect(pair?.classification).toBe("meaningful");
  });

  it("supports derived categorical predictors with ANOVA stats", () => {
    const records = buildRecords(60);
    const checkinsByDate = buildCheckins(60);
    const analysisValues = buildAnalysisValues(records, checkinsByDate);
    const derived: DerivedPredictorDefinition[] = [
      {
        id: "caffeine_binary",
        name: "Caffeine >=2",
        sourceKey: "question:caffeine_count",
        mode: "threshold",
        cutPoints: [2],
        labels: ["<2", ">=2"],
      },
    ];

    const catalog = buildCorrelationCatalog({
      records,
      analysisValues,
      questions: QUESTIONS,
      derivedPredictors: derived,
      weekdayOnly: false,
      trainingOnly: false,
    });

    const pair = findCorrelationPair(catalog, "derived:caffeine_binary", "metric:recoveryIndex");

    expect(pair).not.toBeNull();
    expect(pair?.testType).toBe("categorical");
    expect(pair?.etaSquared).not.toBeNull();
    expect((pair?.etaSquared ?? 0) > 0).toBe(true);
    expect(pair?.fStatistic).not.toBeNull();
    expect(pair?.categoryLabels).toEqual(["<2", ">=2"]);
  });

  it("converts Garmin sleep duration predictor values from seconds to hours", () => {
    const records = buildRecords(30);
    const checkinsByDate = buildCheckins(30);
    const analysisValues = buildAnalysisValues(records, checkinsByDate);
    const values = buildPredictorDistribution({
      records,
      analysisValues,
      questions: QUESTIONS,
      predictor: "garmin:sleepSeconds",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(values.length).toBe(29);
    expect(values.every((value) => value > 4 && value < 12)).toBe(true);
  });

  it("enforces D-1 predictors mapped to D targets", () => {
    const records: DailyRecord[] = [
      {
        date: "2026-02-20",
        dayIndex: 0,
        weekday: 5,
        isTrainingDay: false,
        importGap: false,
        importState: "ok",
        fellAsleepAt: null,
        predictors: {
          steps: 1111,
          calories: 2000,
          stressAvg: 20,
          bodyBattery: 70,
          sleepSeconds: 28000,
          vo2Max: 51,
          avgHr1hBeforeSleep: 59,
          sleepConsistency: 20,
          isTrainingDay: false,
          zone0Minutes: null,
          zone1Minutes: null,
          zone2Minutes: null,
          zone3Minutes: null,
          zone4Minutes: null,
          zone5Minutes: null,
          mealToSleepGapMinutes: null,
          caffeineToSleepGapMinutes: null,
        },
        metrics: {
          recoveryIndex: 60,
          restingHr: 50,
          stress: 20,
          bodyBattery: 70,
          trainingReadiness: 62,
          deepSleepPercentage: 20,
          remSleepPercentage: 22,
          remOrDeepSleepPercentage: 42,
          avgOvernightHrv: 46,
          sleepScore: 78,
        },
        coverage: {
          recoveryIndex: "complete",
          restingHr: "complete",
          stress: "complete",
          bodyBattery: "complete",
          trainingReadiness: "complete",
          deepSleepPercentage: "complete",
          remSleepPercentage: "complete",
          remOrDeepSleepPercentage: "complete",
          avgOvernightHrv: "complete",
          sleepScore: "complete",
        },
      },
      {
        date: "2026-02-21",
        dayIndex: 1,
        weekday: 6,
        isTrainingDay: false,
        importGap: false,
        importState: "ok",
        fellAsleepAt: null,
        predictors: {
          steps: 2222,
          calories: 2100,
          stressAvg: 25,
          bodyBattery: 68,
          sleepSeconds: 27000,
          vo2Max: 52,
          avgHr1hBeforeSleep: 60,
          sleepConsistency: 22,
          isTrainingDay: false,
          zone0Minutes: null,
          zone1Minutes: null,
          zone2Minutes: null,
          zone3Minutes: null,
          zone4Minutes: null,
          zone5Minutes: null,
          mealToSleepGapMinutes: null,
          caffeineToSleepGapMinutes: null,
        },
        metrics: {
          recoveryIndex: 70,
          restingHr: 49,
          stress: 22,
          bodyBattery: 69,
          trainingReadiness: 70,
          deepSleepPercentage: 21,
          remSleepPercentage: 23,
          remOrDeepSleepPercentage: 44,
          avgOvernightHrv: 47,
          sleepScore: 80,
        },
        coverage: {
          recoveryIndex: "complete",
          restingHr: "complete",
          stress: "complete",
          bodyBattery: "complete",
          trainingReadiness: "complete",
          deepSleepPercentage: "complete",
          remSleepPercentage: "complete",
          remOrDeepSleepPercentage: "complete",
          avgOvernightHrv: "complete",
          sleepScore: "complete",
        },
      },
      {
        date: "2026-02-22",
        dayIndex: 2,
        weekday: 0,
        isTrainingDay: false,
        importGap: false,
        importState: "ok",
        fellAsleepAt: null,
        predictors: {
          steps: 3333,
          calories: 2200,
          stressAvg: 30,
          bodyBattery: 67,
          sleepSeconds: 26000,
          vo2Max: 53,
          avgHr1hBeforeSleep: 61,
          sleepConsistency: 24,
          isTrainingDay: false,
          zone0Minutes: null,
          zone1Minutes: null,
          zone2Minutes: null,
          zone3Minutes: null,
          zone4Minutes: null,
          zone5Minutes: null,
          mealToSleepGapMinutes: null,
          caffeineToSleepGapMinutes: null,
        },
        metrics: {
          recoveryIndex: 80,
          restingHr: 48,
          stress: 24,
          bodyBattery: 68,
          trainingReadiness: 78,
          deepSleepPercentage: 19,
          remSleepPercentage: 24,
          remOrDeepSleepPercentage: 43,
          avgOvernightHrv: 48,
          sleepScore: 81,
        },
        coverage: {
          recoveryIndex: "complete",
          restingHr: "complete",
          stress: "complete",
          bodyBattery: "complete",
          trainingReadiness: "complete",
          deepSleepPercentage: "complete",
          remSleepPercentage: "complete",
          remOrDeepSleepPercentage: "complete",
          avgOvernightHrv: "complete",
          sleepScore: "complete",
        },
      },
    ];

    const result = buildCorrelationResult({
      records,
      analysisValues: buildAnalysisValues(records, new Map<string, CheckInEntry>()),
      questions: QUESTIONS,
      predictor: "garmin:steps",
      outcome: "metric:recoveryIndex",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.points).toEqual([
      {
        x: 1111,
        y: 70,
        date: "2026-02-21",
        predictorSourceDate: "2026-02-20",
        outcomeSourceDate: "2026-02-21",
      },
      {
        x: 2222,
        y: 80,
        date: "2026-02-22",
        predictorSourceDate: "2026-02-21",
        outcomeSourceDate: "2026-02-22",
      },
    ]);
  });

  it("computes correlation from non-monotonic D-1 predictors", () => {
    const records = buildRecords(8);
    const steps = [8, 1, 7, 2, 6, 3, 5, 4];
    records.forEach((record, index) => {
      record.predictors.steps = steps[index];
      record.metrics.recoveryIndex = index === 0 ? 0 : steps[index - 1] * 3 + 10;
    });

    const result = buildCorrelationResult({
      records,
      analysisValues: buildAnalysisValues(records, new Map()),
      questions: QUESTIONS,
      predictor: "garmin:steps",
      outcome: "metric:recoveryIndex",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.sampleCount).toBe(steps.length - 1);
    expect(result.correlation).toBeCloseTo(1, 12);
    expect(result.points.map((point) => point.x)).toEqual(steps.slice(0, -1));
    expect(result.points.map((point) => point.y)).toEqual(
      steps.slice(0, -1).map((value) => value * 3 + 10),
    );
  });

  it("pairs previous-day question predictors with same-day question targets", () => {
    const records = buildRecords(4);
    const checkins = buildCheckins(4);
    [9, 4, 7, 2].forEach((energy, index) => {
      const entry = checkins.get(buildDate(index));
      if (entry) {
        entry.answers.caffeine_count = [3, 1, 4, 2][index];
        entry.answers.energy = energy;
      }
    });

    const result = buildCorrelationResult({
      records,
      analysisValues: buildAnalysisValues(records, checkins),
      questions: QUESTIONS,
      predictor: "question:caffeine_count",
      outcome: "question:energy",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.points).toEqual([
      {
        x: 3,
        y: 4,
        date: "2026-01-02",
        predictorSourceDate: "2026-01-01",
        outcomeSourceDate: "2026-01-02",
      },
      {
        x: 1,
        y: 7,
        date: "2026-01-03",
        predictorSourceDate: "2026-01-02",
        outcomeSourceDate: "2026-01-03",
      },
      {
        x: 4,
        y: 2,
        date: "2026-01-04",
        predictorSourceDate: "2026-01-03",
        outcomeSourceDate: "2026-01-04",
      },
    ]);
  });

  it("uses pairwise-complete rows and applies outcome-day filters", () => {
    const records = buildRecords(10);
    const missingDate = buildDate(4);
    const analysisValues = buildAnalysisValues(records, buildCheckins(10)).filter(
      (value) => !(
        value.analysisDate === missingDate
        && value.role === "target"
        && value.featureKey === "metric:recoveryIndex"
      ),
    );
    const buildFilteredResult = (weekdayOnly: boolean, trainingOnly: boolean) => (
      buildCorrelationResult({
        records,
        analysisValues,
        questions: QUESTIONS,
        predictor: "garmin:steps",
        outcome: "metric:recoveryIndex",
        weekdayOnly,
        trainingOnly,
      })
    );

    const unfiltered = buildFilteredResult(false, false);
    expect(unfiltered.sampleCount).toBe(8);
    expect(unfiltered.points.some((point) => point.date === missingDate)).toBe(false);

    const weekdays = buildFilteredResult(true, false);
    expect(weekdays.points.every((point) => {
      const record = records.find((candidate) => candidate.date === point.date);
      return record !== undefined && record.weekday !== 0 && record.weekday !== 6;
    })).toBe(true);

    const trainingDays = buildFilteredResult(false, true);
    expect(trainingDays.points.every((point) => {
      const record = records.find((candidate) => candidate.date === point.date);
      return record?.isTrainingDay === true;
    })).toBe(true);
  });

  it("aligns day-D predictors with day-D pre-sleep HR outcomes", () => {
    const records = buildRecords(4);
    const analysisValues: AnalysisValueRecord[] = [
      {
        analysisDate: "2026-01-02",
        role: "predictor",
        featureKey: "question:caffeine_count",
        valueNum: 1,
        valueText: null,
        valueBool: null,
        sourceDate: "2026-01-01",
        lagDays: -1,
        alignmentRule: "checkin_previous_day",
      },
      {
        analysisDate: "2026-01-02",
        role: "target",
        featureKey: "metric:avgHr1hBeforeSleep",
        valueNum: 61,
        valueText: null,
        valueBool: null,
        sourceDate: "2026-01-01",
        lagDays: -1,
        alignmentRule: "garmin_presleep_hr_same_predictor_day",
      },
      {
        analysisDate: "2026-01-03",
        role: "predictor",
        featureKey: "question:caffeine_count",
        valueNum: 3,
        valueText: null,
        valueBool: null,
        sourceDate: "2026-01-02",
        lagDays: -1,
        alignmentRule: "checkin_previous_day",
      },
      {
        analysisDate: "2026-01-03",
        role: "target",
        featureKey: "metric:avgHr1hBeforeSleep",
        valueNum: 67,
        valueText: null,
        valueBool: null,
        sourceDate: "2026-01-02",
        lagDays: -1,
        alignmentRule: "garmin_presleep_hr_same_predictor_day",
      },
    ];

    const result = buildCorrelationResult({
      records,
      analysisValues,
      questions: QUESTIONS,
      predictor: "question:caffeine_count",
      outcome: "metric:avgHr1hBeforeSleep",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.points).toEqual([
      {
        x: 1,
        y: 61,
        date: "2026-01-02",
        predictorSourceDate: "2026-01-01",
        outcomeSourceDate: "2026-01-01",
      },
      {
        x: 3,
        y: 67,
        date: "2026-01-03",
        predictorSourceDate: "2026-01-02",
        outcomeSourceDate: "2026-01-02",
      },
    ]);
  });

  it("keeps ANOVA p-values accurate in the F-CDF complement branch", () => {
    const records = buildModerateAnovaRecords(61);
    const checkinsByDate = buildThreeBinCheckins(61);
    const analysisValues = buildAnalysisValues(records, checkinsByDate);
    const derived: DerivedPredictorDefinition[] = [
      {
        id: "caffeine_three_bins",
        name: "Caffeine three bins",
        sourceKey: "question:caffeine_count",
        mode: "threshold",
        cutPoints: [1, 2],
        labels: ["<1", "1", ">=2"],
      },
    ];

    const catalog = buildCorrelationCatalog({
      records,
      analysisValues,
      questions: QUESTIONS,
      derivedPredictors: derived,
      weekdayOnly: false,
      trainingOnly: false,
    });
    const pair = findCorrelationPair(catalog, "derived:caffeine_three_bins", "metric:recoveryIndex");

    expect(pair).not.toBeNull();
    expect(pair?.testType).toBe("categorical");
    expect(pair?.categoryCounts).toEqual([20, 20, 20]);

    const fStatistic = pair?.fStatistic ?? 0;
    const df2 = (pair?.sampleCount ?? 0) - 3;
    const complementThreshold = (2 * df2) / (df2 + 2);
    expect(fStatistic).toBeGreaterThan(complementThreshold);

    const expectedTail = (df2 / (df2 + 2 * fStatistic)) ** (df2 / 2);
    expect(pair?.pValue).not.toBeNull();
    expect(pair?.pValue).toBeGreaterThan(0);
    expect(pair?.pValue).toBeCloseTo(expectedTail, 6);
  });

  it("classifies low sample pairs as exploratory", () => {
    const records = buildRecords(15);
    const checkinsByDate = buildCheckins(15);
    const analysisValues = buildAnalysisValues(records, checkinsByDate);
    const catalog = buildCorrelationCatalog({
      records,
      analysisValues,
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });

    const pair = findCorrelationPair(catalog, "question:caffeine_count", "metric:recoveryIndex");
    expect(pair).not.toBeNull();
    expect(pair?.classification).toBe("exploratory");

    const tinyCatalog = buildCorrelationCatalog({
      records: buildRecords(10),
      analysisValues: buildAnalysisValues(buildRecords(10), buildCheckins(10)),
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });
    const tinyPair = findCorrelationPair(tinyCatalog, "question:caffeine_count", "metric:recoveryIndex");
    expect(tinyPair?.classification).toBe("exploratory");
  });

  it("keeps compatibility wrapper for scatter data", () => {
    const result = buildCorrelationResult({
      records: buildRecords(20),
      analysisValues: buildAnalysisValues(buildRecords(20), buildCheckins(20)),
      questions: QUESTIONS,
      predictor: "question:caffeine_count",
      outcome: "metric:recoveryIndex",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.sampleCount).toBeGreaterThan(10);
    expect(result.points.length).toBe(result.sampleCount);
    expect(Number.isFinite(result.regression.slope)).toBe(true);
  });
});
