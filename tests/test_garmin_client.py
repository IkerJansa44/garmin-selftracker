from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from src.garmin_client import DayPayload, normalize_daily_metrics


def test_normalize_daily_metrics_extracts_fell_asleep_timestamp() -> None:
    start_timestamp_local_ms = 1_700_000_000_000
    end_timestamp_local_ms = 1_700_025_200_000
    payload = DayPayload(
        payload_date=date(2026, 2, 21),
        endpoints={
            "stats": {"totalSteps": 9300},
            "user_summary": {},
            "sleep": {
                "dailySleepDTO": {
                    "sleepTimeSeconds": 7 * 3600,
                    "deepSleepSeconds": 2 * 3600,
                    "lightSleepSeconds": 4 * 3600,
                    "remSleepSeconds": 1 * 3600,
                    "averageRespirationValue": 12.0,
                    "lowestRespirationValue": 9.0,
                    "sleepStartTimestampLocal": start_timestamp_local_ms,
                    "sleepEndTimestampLocal": end_timestamp_local_ms,
                }
            },
        },
    )

    metrics = normalize_daily_metrics(payload)

    assert metrics["steps"] == 9300
    assert metrics["sleep_seconds"] == 7 * 3600
    assert metrics["deep_sleep_seconds"] == 2 * 3600
    assert metrics["light_sleep_seconds"] == 4 * 3600
    assert metrics["rem_sleep_seconds"] == 1 * 3600
    assert metrics["deep_sleep_percentage"] == pytest.approx(28.57)
    assert metrics["rem_sleep_percentage"] == pytest.approx(14.29)
    assert metrics["rem_or_deep_sleep_percentage"] == pytest.approx(42.86)
    assert metrics["average_respiration_value"] == 12.0
    assert metrics["lowest_respiration_value"] == 9.0
    assert (
        metrics["fell_asleep_at"]
        == datetime.fromtimestamp(
            start_timestamp_local_ms / 1000,
            tz=timezone.utc,
        ).isoformat()
    )
    assert (
        metrics["woke_up_at"]
        == datetime.fromtimestamp(
            end_timestamp_local_ms / 1000,
            tz=timezone.utc,
        ).isoformat()
    )


def test_normalize_daily_metrics_handles_missing_fell_asleep_timestamp() -> None:
    payload = DayPayload(
        payload_date=date(2026, 2, 21),
        endpoints={
            "stats": {"totalSteps": 9300},
            "sleep": {"dailySleepDTO": {"sleepTimeSeconds": 6 * 3600}},
        },
    )

    metrics = normalize_daily_metrics(payload)

    assert metrics["fell_asleep_at"] is None
    assert metrics["woke_up_at"] is None
    assert metrics["deep_sleep_seconds"] is None
    assert metrics["light_sleep_seconds"] is None
    assert metrics["rem_sleep_seconds"] is None
    assert metrics["deep_sleep_percentage"] is None
    assert metrics["rem_sleep_percentage"] is None
    assert metrics["rem_or_deep_sleep_percentage"] is None
    assert metrics["average_respiration_value"] is None
    assert metrics["lowest_respiration_value"] is None
