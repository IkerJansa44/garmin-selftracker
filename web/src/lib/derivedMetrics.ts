export const MEAL_FINISH_QUESTION_ID = "late_meal";
export const CAFFEINE_LAST_TIME_QUESTION_ID = "caffeine_last_time";

export type DerivedGapMetricKey =
  | "mealToSleepGapMinutes"
  | "caffeineToSleepGapMinutes";

export interface DerivedGapMetricDefinition {
  key: DerivedGapMetricKey;
  questionId: string;
  plotLabel: string;
  predictorLabel: string;
  tooltipLabel: string;
  detailLabel: string;
  missingAnswerHint: string;
  computedHint: string;
  color: string;
}

export const DERIVED_GAP_METRICS: DerivedGapMetricDefinition[] = [
  {
    key: "mealToSleepGapMinutes",
    questionId: MEAL_FINISH_QUESTION_ID,
    plotLabel: "Time Before Sleep (Eating)",
    predictorLabel: "Time Between Eating & Sleep (min)",
    tooltipLabel: "Time Between Eating & Sleep",
    detailLabel: "Time Between Eating And Sleep",
    missingAnswerHint: "Add 'Finished eating at' to calculate this metric.",
    computedHint: "Computed from check-in meal time and Garmin sleep start.",
    color: "#7b6d8d",
  },
  {
    key: "caffeineToSleepGapMinutes",
    questionId: CAFFEINE_LAST_TIME_QUESTION_ID,
    plotLabel: "Time Before Sleep (Caffeine)",
    predictorLabel: "Time Between Caffeine & Sleep (min)",
    tooltipLabel: "Time Between Caffeine & Sleep",
    detailLabel: "Time Between Caffeine And Sleep",
    missingAnswerHint: "Add 'Last caffeine drink' to calculate this metric.",
    computedHint: "Computed from check-in caffeine time and Garmin sleep start.",
    color: "#8b5c6f",
  },
];

export const DERIVED_ONLY_QUESTION_IDS = new Set(
  DERIVED_GAP_METRICS.map((metric) => metric.questionId),
);

export const DERIVED_GAP_METRIC_KEYS = new Set(
  DERIVED_GAP_METRICS.map((metric) => metric.key),
);
