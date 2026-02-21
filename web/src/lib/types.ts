export type MetricKey =
  | "recoveryIndex"
  | "sleepScore"
  | "restingHr"
  | "stress"
  | "bodyBattery"
  | "trainingReadiness";

export type CoverageState = "complete" | "partial" | "missing";
export type ImportState = "ok" | "running" | "failed";
export type AnalysisMode = "predictor_next_day" | "target_same_day";
export type ChildConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "at_least"
  | "non_empty";

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
  fellAsleepAtIso?: string | null;
  predictors: {
    steps: number | null;
    calories: number | null;
    stressAvg: number | null;
    bodyBattery: number | null;
    sleepSeconds: number | null;
    isTrainingDay: boolean;
  };
  metrics: Record<MetricKey, number | null>;
  coverage: Record<MetricKey, CoverageState>;
  checkInFactors?: CheckInFactors;
}

export type InputType = "slider" | "multi-choice" | "boolean" | "time" | "text";

export interface QuestionOption {
  id: string;
  label: string;
  score?: number;
}

export interface ChildCondition {
  operator: ChildConditionOperator;
  value?: string | number | boolean;
}

export interface CheckInQuestionChild {
  id: string;
  prompt: string;
  inputType: InputType;
  analysisMode: AnalysisMode;
  min?: number;
  max?: number;
  step?: number;
  options?: QuestionOption[];
  condition: ChildCondition;
}

export interface CheckInQuestion {
  id: string;
  section: string;
  prompt: string;
  inputLabel?: string;
  inputType: InputType;
  analysisMode: AnalysisMode;
  min?: number;
  max?: number;
  step?: number;
  options?: QuestionOption[];
  children?: CheckInQuestionChild[];
  defaultIncluded: boolean;
}

export interface CheckInEntry {
  date: string;
  answers: Record<string, string | number | boolean>;
  completedAt: string;
}

export type AnalysisValueRole = "predictor" | "target";

export interface AnalysisValueRecord {
  analysisDate: string;
  role: AnalysisValueRole;
  featureKey: string;
  valueNum: number | null;
  valueText: string | null;
  valueBool: boolean | null;
  sourceDate: string;
  lagDays: number;
  alignmentRule: string;
}

export interface ExploreSettings {
  smoothing: "none" | "ema7";
  baselineBand: boolean;
  importGaps: boolean;
  scaleMode: "independent" | "normalized";
  lagDays: 0 | 1 | 2;
}

export type DerivedPredictorMode = "threshold" | "quantile";

export interface DerivedPredictorDefinition {
  id: string;
  name: string;
  sourceKey: `garmin:${string}` | `question:${string}`;
  mode: DerivedPredictorMode;
  cutPoints: number[];
  labels: string[];
}

export interface DerivedPredictorPayload {
  definitions: DerivedPredictorDefinition[];
}

export interface CheckinReminderSettings {
  enabled: boolean;
  notifyAfter: string;
}
