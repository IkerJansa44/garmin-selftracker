from __future__ import annotations

from datetime import date, datetime, timezone

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
                    "sleepStartTimestampLocal": start_timestamp_local_ms,
                    "sleepEndTimestampLocal": end_timestamp_local_ms,
                }
            },
        },
    )

    metrics = normalize_daily_metrics(payload)

    assert metrics["steps"] == 9300
    assert metrics["sleep_seconds"] == 7 * 3600
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
