export type MetricKey =
  | "recoveryIndex"
  | "sleepScore"
  | "restingHr"
  | "stress"
  | "bodyBattery"
  | "trainingReadiness";

export type CoverageState = "complete" | "partial" | "missing";
export type ImportState = "ok" | "running" | "failed";

export interface CheckInFactors {
  trainingIntensity: number;
  trainingType: string;
  caffeineCount: number;
  alcoholUnits: number;
  lateMeal: boolean;
  lateScreenMinutes: number;
  thermalRecovery: string;
  mood: number;
  notes: string;
}

export interface DailyRecord {
  date: string;
  dayIndex: number;
  weekday: number;
  isTrainingDay: boolean;
  importGap: boolean;
  importState: ImportState;
  fellAsleepAt?: string | null;
  metrics: Record<MetricKey, number | null>;
  coverage: Record<MetricKey, CoverageState>;
  checkInFactors?: CheckInFactors;
}

export type InputType = "slider" | "multi-choice" | "boolean" | "time" | "text";

export interface QuestionOption {
  id: string;
  label: string;
}

export interface CheckInQuestion {
  id: string;
  section: string;
  prompt: string;
  inputType: InputType;
  min?: number;
  max?: number;
  step?: number;
  options?: QuestionOption[];
  defaultIncluded: boolean;
}

export interface CheckInEntry {
  id: string;
  date: string;
  answers: Record<string, string | number | boolean>;
  completedAt: string;
}

export interface ExploreSettings {
  smoothing: "none" | "ema7";
  baselineBand: boolean;
  importGaps: boolean;
  scaleMode: "independent" | "normalized";
  lagDays: 0 | 1 | 2;
}
