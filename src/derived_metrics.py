from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TimeToSleepGapMetric:
    answer_key: str
    dashboard_key: str
    predictor_key: str
    alignment_rule: str


TIME_TO_SLEEP_GAP_METRICS = (
    TimeToSleepGapMetric(
        answer_key="late_meal",
        dashboard_key="mealToSleepGapMinutes",
        predictor_key="garmin:mealToSleepGapMinutes",
        alignment_rule="meal_sleep_gap_previous_day",
    ),
    TimeToSleepGapMetric(
        answer_key="caffeine_last_time",
        dashboard_key="caffeineToSleepGapMinutes",
        predictor_key="garmin:caffeineToSleepGapMinutes",
        alignment_rule="caffeine_sleep_gap_previous_day",
    ),
)

DERIVED_ONLY_QUESTION_KEYS = frozenset(
    metric.answer_key for metric in TIME_TO_SLEEP_GAP_METRICS
)
TIME_TO_SLEEP_GAP_DASHBOARD_KEYS = frozenset(
    metric.dashboard_key for metric in TIME_TO_SLEEP_GAP_METRICS
)
