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
    key: "sleepScore",
    label: "Sleep Score",
    unit: "pts",
    color: "#3f6686",
    decimals: 0,
    baselineHint: "Signals how well overnight recovery conditions held.",
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
];

export const DEFAULT_SELECTED_METRICS: MetricKey[] = [
  "sleepScore",
  "recoveryIndex",
  "trainingReadiness",
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
    id: "mood",
    section: "Stress & Mind",
    prompt: "Mood",
    inputType: "slider",
    analysisMode: "target_same_day",
    min: 0,
    max: 10,
    step: 1,
    defaultIncluded: true,
  },
  {
    id: "notes",
    section: "Stress & Mind",
    prompt: "Notes",
    inputType: "text",
    analysisMode: "target_same_day",
    defaultIncluded: true,
  },
];

export const SECTION_ORDER = [
  "Nutrition & Substances",
  "Stress & Mind",
  "Sleep Hygiene",
  "Recovery",
];
