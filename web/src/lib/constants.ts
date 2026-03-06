import { CheckInQuestion, MetricKey } from "./types";

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  unit: string;
  color: string;
  decimals: number;
  baselineHint: string;
}

export const RANGE_PRESETS = [7, 30, 90, 365] as const;

export const METRICS: MetricDefinition[] = [
  {
    key: "recoveryIndex",
    label: "Recovery Index",
    unit: "pts",
    color: "#4f7e65",
    decimals: 0,
    baselineHint: "Tracks recovery pressure from recent load and stress.",
  },
  {
    key: "restingHr",
    label: "Resting HR",
    unit: "bpm",
    color: "#8a5a4e",
    decimals: 0,
    baselineHint: "Elevations can indicate strain, load, or poor sleep.",
  },
  {
    key: "stress",
    label: "Stress",
    unit: "pts",
    color: "#806739",
    decimals: 0,
    baselineHint: "Higher daytime stress can suppress readiness trends.",
  },
  {
    key: "bodyBattery",
    label: "Body Battery",
    unit: "%",
    color: "#51745e",
    decimals: 0,
    baselineHint: "Shows net daily recharge versus drain.",
  },
  {
    key: "trainingReadiness",
    label: "Training Readiness",
    unit: "pts",
    color: "#6f4b83",
    decimals: 0,
    baselineHint: "Summarizes readiness from recovery and load.",
  },
  {
    key: "deepSleepPercentage",
    label: "Deep Sleep",
    unit: "%",
    color: "#2c6e8f",
    decimals: 1,
    baselineHint: "Higher shares can indicate better slow-wave recovery.",
  },
  {
    key: "remSleepPercentage",
    label: "REM Sleep",
    unit: "%",
    color: "#3f8f7b",
    decimals: 1,
    baselineHint: "Tracks the share of sleep spent in REM.",
  },
  {
    key: "remOrDeepSleepPercentage",
    label: "REM + Deep Sleep",
    unit: "%",
    color: "#2f7f68",
    decimals: 1,
    baselineHint: "Combines the restorative share of REM and deep sleep.",
  },
];

export const DEFAULT_SELECTED_METRICS: MetricKey[] = [
  "recoveryIndex",
  "trainingReadiness",
];

const YES_NORMAL_NO_OPTIONS = [
  { id: "yes", label: "yes", score: 2 },
  { id: "normal", label: "normal", score: 1 },
  { id: "no", label: "no", score: 0 },
];

export const DEFAULT_QUESTIONS: CheckInQuestion[] = [
  {
    id: "caffeine_count",
    section: "Nutrition & Substances",
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
        condition: {
          operator: "greater_than",
          value: 0,
        },
      },
    ],
    defaultIncluded: true,
  },
  {
    id: "alcohol_units",
    section: "Nutrition & Substances",
    prompt: "Alcohol",
    inputLabel: "Count",
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
        condition: {
          operator: "greater_than",
          value: 0,
        },
      },
    ],
    defaultIncluded: true,
  },
  {
    id: "late_meal",
    section: "Nutrition & Substances",
    prompt: "Finished eating at",
    inputType: "time",
    analysisMode: "predictor_next_day",
    defaultIncluded: true,
  },
  {
    id: "nutrition_fullness",
    section: "Nutrition & Substances",
    prompt: "Do you feel full?",
    inputType: "multi-choice",
    analysisMode: "predictor_next_day",
    options: [...YES_NORMAL_NO_OPTIONS],
    defaultIncluded: true,
  },
  {
    id: "felt_energized_during_day",
    section: "Stress & Mind",
    prompt: "Felt energized during the day",
    inputType: "multi-choice",
    analysisMode: "target_same_day",
    options: [...YES_NORMAL_NO_OPTIONS],
    defaultIncluded: true,
  },
];

export const SECTION_ORDER = [
  "Nutrition & Substances",
  "Stress & Mind",
  "Sleep Hygiene",
  "Recovery",
];
