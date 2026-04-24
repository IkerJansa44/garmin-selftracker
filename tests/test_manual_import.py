from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from src.manual_import import (
    FitArchiveAccumulator,
    _archive_metric_date,
    _build_daily_metrics,
)


def test_archive_metric_date_reads_iso_date_from_filename() -> None:
    assert _archive_metric_date(Path("2026-04-21.zip")) == date(2026, 4, 21)


def test_build_daily_metrics_from_fit_records() -> None:
    accumulator = FitArchiveAccumulator(
        metric_date=date(2026, 4, 21),
        files=[],
        steps_by_activity=defaultdict(list),
        active_calories_by_activity=defaultdict(list),
        resting_metabolic_rates=[2246],
        resting_heart_rates=[56, 55],
        stress_values=[10, 20, 30],
        respiration_values=[12.0, 14.0, 16.0],
        sleep_levels=[
            (datetime(2026, 4, 20, 22, 0, tzinfo=timezone.utc), "light"),
            (datetime(2026, 4, 20, 23, 0, tzinfo=timezone.utc), "deep"),
            (datetime(2026, 4, 21, 0, 0, tzinfo=timezone.utc), "rem"),
            (datetime(2026, 4, 21, 1, 0, tzinfo=timezone.utc), "awake"),
        ],
    )
    accumulator.steps_by_activity["walking"] = [500, 700]
    accumulator.steps_by_activity["running"] = [100]
    accumulator.active_calories_by_activity["walking"] = [50, 70]
    accumulator.active_calories_by_activity["running"] = [20]

    metrics = _build_daily_metrics(accumulator)

    assert metrics["metric_date"] == "2026-04-21"
    assert metrics["steps"] == 800
    assert metrics["calories"] == 2336
    assert metrics["resting_heart_rate"] == 55
    assert metrics["stress_avg"] == 20
    assert metrics["average_respiration_value"] == 14
    assert metrics["lowest_respiration_value"] == 12
    assert metrics["sleep_seconds"] == 3 * 3600
    assert metrics["deep_sleep_seconds"] == 3600
    assert metrics["light_sleep_seconds"] == 3600
    assert metrics["rem_sleep_seconds"] == 3600
    assert metrics["deep_sleep_percentage"] == 33.33
