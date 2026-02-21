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
} from "./correlation";
import {
  type CheckInEntry,
  type CheckInQuestion,
  type DailyRecord,
  type DerivedPredictorDefinition,
} from "./types";

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
    const sleepScore = 90 - previousCaffeine * 5;
    const energy = Math.max(0, Math.min(10, Math.round((sleepScore - 60) / 4)));
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
        isTrainingDay: index % 2 === 0,
      },
      metrics: {
        recoveryIndex: sleepScore - 3,
        sleepScore,
        restingHr: 48 + previousCaffeine,
        stress: 28 + previousCaffeine,
        bodyBattery: 70 - previousCaffeine,
        trainingReadiness: sleepScore - 4,
      },
      coverage: {
        recoveryIndex: "complete",
        sleepScore: "complete",
        restingHr: "complete",
        stress: "complete",
        bodyBattery: "complete",
        trainingReadiness: "complete",
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

describe("correlation helpers", () => {
  it("builds predictor and outcome options with expanded metric outcomes", () => {
    const predictors = buildPredictorOptions(QUESTIONS);
    const outcomes = buildOutcomeOptions(QUESTIONS);

    expect(predictors.some((option) => option.key === "question:caffeine_count")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:recoveryIndex")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:stress")).toBe(true);
    expect(outcomes.some((option) => option.key === "metric:bodyBattery")).toBe(true);
    expect(outcomes.some((option) => option.key === "question:notes")).toBe(false);
  });

  it("builds derived source options excluding training day binary predictor", () => {
    const options = buildDerivedPredictorSourceOptions(QUESTIONS);

    expect(options.some((option) => option.key === "garmin:steps")).toBe(true);
    expect(options.some((option) => option.key === "garmin:isTrainingDay")).toBe(false);
    expect(options.some((option) => option.key === "question:caffeine_count")).toBe(true);
    expect(options.some((option) => option.key === "question:late_meal")).toBe(true);
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
    const catalog = buildCorrelationCatalog({
      records,
      checkinsByDate,
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });

    const pair = findCorrelationPair(
      catalog,
      "question:caffeine_count",
      "metric:sleepScore",
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
      checkinsByDate,
      questions: QUESTIONS,
      derivedPredictors: derived,
      weekdayOnly: false,
      trainingOnly: false,
    });

    const pair = findCorrelationPair(catalog, "derived:caffeine_binary", "metric:sleepScore");

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
    const values = buildPredictorDistribution({
      records,
      checkinsByDate,
      questions: QUESTIONS,
      predictor: "garmin:sleepSeconds",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(values.length).toBe(29);
    expect(values.every((value) => value > 4 && value < 12)).toBe(true);
  });

  it("classifies low sample pairs as exploratory/insufficient", () => {
    const records = buildRecords(15);
    const checkinsByDate = buildCheckins(15);
    const catalog = buildCorrelationCatalog({
      records,
      checkinsByDate,
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });

    const pair = findCorrelationPair(catalog, "question:caffeine_count", "metric:sleepScore");
    expect(pair).not.toBeNull();
    expect(pair?.classification).toBe("exploratory");

    const tinyCatalog = buildCorrelationCatalog({
      records: buildRecords(10),
      checkinsByDate: buildCheckins(10),
      questions: QUESTIONS,
      derivedPredictors: [],
      weekdayOnly: false,
      trainingOnly: false,
    });
    const tinyPair = findCorrelationPair(tinyCatalog, "question:caffeine_count", "metric:sleepScore");
    expect(tinyPair?.classification).toBe("insufficient");
  });

  it("keeps compatibility wrapper for scatter data", () => {
    const result = buildCorrelationResult({
      records: buildRecords(20),
      checkinsByDate: buildCheckins(20),
      questions: QUESTIONS,
      predictor: "question:caffeine_count",
      outcome: "metric:sleepScore",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.sampleCount).toBeGreaterThan(10);
    expect(result.points.length).toBe(result.sampleCount);
    expect(Number.isFinite(result.regression.slope)).toBe(true);
  });
});
