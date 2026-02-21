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
    unit: "ms",
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
    id: "training_intensity",
    section: "Training",
    prompt: "Training intensity",
    inputType: "slider",
    min: 0,
    max: 10,
    step: 1,
    defaultIncluded: true,
  },
  {
    id: "training_type",
    section: "Training",
    prompt: "Training type",
    inputType: "multi-choice",
    options: [
      { id: "easy", label: "Easy" },
      { id: "tempo", label: "Tempo" },
      { id: "interval", label: "Interval" },
      { id: "strength", label: "Strength" },
      { id: "rest", label: "Rest" },
    ],
    defaultIncluded: true,
  },
  {
    id: "caffeine_count",
    section: "Nutrition & Substances",
    prompt: "Caffeine (count)",
    inputType: "slider",
    min: 0,
    max: 8,
    step: 1,
    defaultIncluded: true,
  },
  {
    id: "alcohol_units",
    section: "Nutrition & Substances",
    prompt: "Alcohol",
    inputType: "multi-choice",
    options: [
      { id: "0", label: "0" },
      { id: "1", label: "1" },
      { id: "2", label: "2" },
      { id: "3plus", label: "3+" },
    ],
    defaultIncluded: true,
  },
  {
    id: "late_meal",
    section: "Sleep Hygiene",
    prompt: "Late meal",
    inputType: "boolean",
    defaultIncluded: true,
  },
  {
    id: "screen_minutes",
    section: "Sleep Hygiene",
    prompt: "Screen time late",
    inputType: "slider",
    min: 0,
    max: 180,
    step: 5,
    defaultIncluded: true,
  },
  {
    id: "thermal",
    section: "Recovery",
    prompt: "Sauna/cold exposure",
    inputType: "multi-choice",
    options: [
      { id: "none", label: "None" },
      { id: "sauna", label: "Sauna" },
      { id: "cold", label: "Cold" },
      { id: "both", label: "Both" },
    ],
    defaultIncluded: true,
  },
  {
    id: "mood",
    section: "Stress & Mind",
    prompt: "Mood",
    inputType: "slider",
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
    defaultIncluded: true,
  },
];

export const SECTION_ORDER = [
  "Training",
  "Nutrition & Substances",
  "Stress & Mind",
  "Sleep Hygiene",
  "Recovery",
];
