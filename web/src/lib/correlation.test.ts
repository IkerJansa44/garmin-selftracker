import { describe, expect, it } from "vitest";

import {
  buildCorrelationResult,
  buildOutcomeOptions,
  buildPredictorOptions,
} from "./correlation";
import { type CheckInEntry, type CheckInQuestion, type DailyRecord } from "./types";

const QUESTIONS: CheckInQuestion[] = [
  {
    id: "caffeine",
    section: "Nutrition",
    prompt: "Caffeine",
    inputLabel: "Count",
    inputType: "slider",
    analysisMode: "predictor_next_day",
    min: 0,
    max: 8,
    step: 1,
    children: [
      {
        id: "caffeine_last_time",
        prompt: "Last caffeine drink",
        inputType: "time",
        analysisMode: "predictor_next_day",
        condition: { operator: "greater_than", value: 0 },
      },
    ],
    defaultIncluded: true,
  },
  {
    id: "alcohol",
    section: "Nutrition",
    prompt: "Alcohol",
    inputType: "multi-choice",
    analysisMode: "predictor_next_day",
    options: [
      { id: "0", label: "0", score: 0 },
      { id: "1", label: "1", score: 1 },
      { id: "2", label: "2", score: 2 },
      { id: "3plus", label: "3+", score: 3 },
    ],
    children: [
      {
        id: "alcohol_last_time",
        prompt: "Last alcohol drink",
        inputType: "time",
        analysisMode: "predictor_next_day",
        condition: { operator: "greater_than", value: 0 },
      },
    ],
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

const RECORDS: DailyRecord[] = [
  {
    date: "2026-02-01",
    dayIndex: 0,
    weekday: 0,
    isTrainingDay: false,
    importGap: false,
    importState: "ok",
    fellAsleepAt: null,
    predictors: {
      steps: 9000,
      calories: 2200,
      stressAvg: 30,
      bodyBattery: 75,
      sleepSeconds: 27000,
      isTrainingDay: false,
    },
    metrics: {
      recoveryIndex: 70,
      sleepScore: 74,
      restingHr: 52,
      stress: 31,
      bodyBattery: 75,
      trainingReadiness: 71,
    },
    coverage: {
      recoveryIndex: "complete",
      sleepScore: "complete",
      restingHr: "complete",
      stress: "complete",
      bodyBattery: "complete",
      trainingReadiness: "complete",
    },
  },
  {
    date: "2026-02-02",
    dayIndex: 1,
    weekday: 1,
    isTrainingDay: true,
    importGap: false,
    importState: "ok",
    fellAsleepAt: null,
    predictors: {
      steps: 12000,
      calories: 2400,
      stressAvg: 27,
      bodyBattery: 78,
      sleepSeconds: 28200,
      isTrainingDay: true,
    },
    metrics: {
      recoveryIndex: 73,
      sleepScore: 80,
      restingHr: 49,
      stress: 27,
      bodyBattery: 78,
      trainingReadiness: 78,
    },
    coverage: {
      recoveryIndex: "complete",
      sleepScore: "complete",
      restingHr: "complete",
      stress: "complete",
      bodyBattery: "complete",
      trainingReadiness: "complete",
    },
  },
];

const CHECKINS = new Map<string, CheckInEntry>([
  [
    "2026-02-01",
    {
      date: "2026-02-01",
      completedAt: "2026-02-01T21:00:00+00:00",
      answers: {
        caffeine: 3,
        caffeine_last_time: "16:30",
        alcohol: "3plus",
        alcohol_last_time: "20:45",
        energy: 5,
      },
    },
  ],
  [
    "2026-02-02",
    {
      date: "2026-02-02",
      completedAt: "2026-02-02T21:00:00+00:00",
      answers: {
        caffeine: 1,
        caffeine_last_time: "14:15",
        alcohol: "0",
        energy: 8,
      },
    },
  ],
]);

describe("correlation helpers", () => {
  it("builds predictor and outcome options by analysis mode", () => {
    const predictors = buildPredictorOptions(QUESTIONS);
    const outcomes = buildOutcomeOptions(QUESTIONS);

    expect(predictors.some((option) => option.key === "question:caffeine")).toBe(true);
    expect(predictors.some((option) => option.key === "question:caffeine_last_time")).toBe(true);
    expect(predictors.some((option) => option.key === "question:alcohol_last_time")).toBe(true);
    expect(predictors.some((option) => option.key === "question:notes")).toBe(false);
    expect(outcomes.some((option) => option.key === "question:energy")).toBe(true);
    expect(outcomes.some((option) => option.key === "question:notes")).toBe(false);
  });

  it("uses previous-day predictor and same-day outcome alignment", () => {
    const result = buildCorrelationResult({
      records: RECORDS,
      checkinsByDate: CHECKINS,
      questions: QUESTIONS,
      predictor: "question:caffeine",
      outcome: "metric:sleepScore",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.points).toEqual([{ x: 3, y: 80, date: "2026-02-02" }]);
  });

  it("supports target question as same-day outcome", () => {
    const result = buildCorrelationResult({
      records: RECORDS,
      checkinsByDate: CHECKINS,
      questions: QUESTIONS,
      predictor: "garmin:steps",
      outcome: "question:energy",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.points).toEqual([{ x: 9000, y: 8, date: "2026-02-02" }]);
  });

  it("maps multi-choice options using score values", () => {
    const result = buildCorrelationResult({
      records: RECORDS,
      checkinsByDate: CHECKINS,
      questions: QUESTIONS,
      predictor: "question:alcohol",
      outcome: "metric:sleepScore",
      weekdayOnly: false,
      trainingOnly: false,
    });

    expect(result.points).toEqual([{ x: 3, y: 80, date: "2026-02-02" }]);
  });
});
