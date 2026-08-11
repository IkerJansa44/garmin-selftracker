from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from src.garmin_client import (
    ActivityZoneSummary,
    DayPayload,
    GarminConnectAdapter,
    compute_zone_minutes,
    normalize_daily_metrics,
)


def test_login_uses_configured_tokenstore(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[str, str | None]] = []

    class FakeGarmin:
        def __init__(self, email: str, password: str) -> None:
            self.email = email
            self.password = password

        def login(self, tokenstore: str | None = None) -> None:
            calls.append(("login", tokenstore))

    monkeypatch.setattr("src.garmin_client._garmin_class", lambda: FakeGarmin)
    tokenstore = tmp_path / "garmin-tokens"

    adapter = GarminConnectAdapter(
        "user@example.com",
        "secret",
        tokenstore=str(tokenstore),
    )

    adapter.login()

    assert calls == [("login", str(tokenstore))]


def test_login_without_tokenstore_passes_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str | None]] = []

    class FakeGarmin:
        def __init__(self, email: str, password: str) -> None:
            self.email = email
            self.password = password

        def login(self, tokenstore: str | None = None) -> None:
            calls.append(("login", tokenstore))

    monkeypatch.setattr("src.garmin_client._garmin_class", lambda: FakeGarmin)

    adapter = GarminConnectAdapter("user@example.com", "secret")
    adapter.login()

    assert calls == [("login", None)]


def test_compute_zone_minutes_uses_run_zones_and_excludes_overlapping_daily_hr() -> (
    None
):
    start = 1_700_000_000_000
    heart_rates = {
        "heartRateValues": [
            [start - 120_000, 190],
            [start, 190],
            [start + 120_000, 190],
            [start + 240_000, 190],
        ]
    }
    run = {"beginTimestamp": start, "duration": 240}
    run_zones = ActivityZoneSummary(
        lower_bounds=[103, 124, 144, 165, 185],
        seconds_by_zone={1: 0, 2: 0, 3: 0, 4: 0, 5: 388},
    )

    result = compute_zone_minutes(
        heart_rates,
        run_zones.lower_bounds,
        [(run, run_zones)],
    )

    assert result["zone5_minutes"] == 10


def test_fetch_activity_hr_zones_preserves_activity_thresholds_and_seconds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = GarminConnectAdapter("user@example.com", "secret")
    monkeypatch.setattr(
        adapter,
        "_safe_call",
        lambda *_: [
            {"zoneNumber": 5, "secsInZone": 387.9, "zoneLowBoundary": 185},
            {"zoneNumber": 4, "secsInZone": 1116.5, "zoneLowBoundary": 165},
        ],
    )

    summary = adapter.fetch_activity_hr_zones(123)

    assert summary == ActivityZoneSummary(
        lower_bounds=[165, 185],
        seconds_by_zone={4: 1116.5, 5: 387.9},
    )


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
                    "sleepScores": {"overall": {"value": 83}},
                    "sleepStartTimestampLocal": start_timestamp_local_ms,
                    "sleepEndTimestampLocal": end_timestamp_local_ms,
                }
            },
            "activities": [{"activityId": 123, "vO2MaxValue": 54.0}],
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
    assert metrics["sleep_score"] == 83
    assert metrics["vo2max"] == 54.0
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


def test_normalize_daily_metrics_extracts_overnight_hrv() -> None:
    payload = DayPayload(
        payload_date=date(2026, 5, 17),
        endpoints={
            "stats": {},
            "user_summary": {},
            "sleep": {
                "avgOvernightHrv": 49.0,
                "dailySleepDTO": {"sleepTimeSeconds": 24960},
            },
        },
    )

    metrics = normalize_daily_metrics(payload)

    assert metrics["avg_overnight_hrv"] == 49.0
