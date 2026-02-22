from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from pathlib import Path

import pytest

from src.api import (
    ApiHandler,
    ApiSettings,
    ImportJobManager,
    ImportRequest,
    _as_clock_time,
    _load_derived_predictors_payload,
    _load_checkin_reminder_settings_payload,
    _import_status_message,
    _load_checkins_payload,
    _load_correlation_values_payload,
    _load_dashboard_payload,
    _load_dashboard_plots_payload,
    _normalize_checkin_reminder_settings_payload,
    _normalize_dashboard_plots_payload,
    _normalize_derived_predictors_payload,
    _normalize_questions_payload,
    _parse_import_request,
    _save_derived_predictors_payload,
    _save_checkin_payload,
    _save_checkin_reminder_settings_payload,
    _save_dashboard_plots_payload,
)
from src.db import connect_db, init_db


class _Writer:
    def __init__(self, write_error: OSError | None = None) -> None:
        self._write_error = write_error
        self.payload = b""

    def write(self, data: bytes) -> None:
        if self._write_error is not None:
            raise self._write_error
        self.payload = data


class _HandlerStub:
    def __init__(
        self,
        *,
        write_error: OSError | None = None,
        end_headers_error: OSError | None = None,
    ) -> None:
        self.status: HTTPStatus | None = None
        self.headers: dict[str, str] = {}
        self.end_headers_called = False
        self._end_headers_error = end_headers_error
        self.wfile = _Writer(write_error)

    def send_response(self, status: HTTPStatus) -> None:
        self.status = status

    def send_header(self, key: str, value: str) -> None:
        self.headers[key] = value

    def end_headers(self) -> None:
        if self._end_headers_error is not None:
            raise self._end_headers_error
        self.end_headers_called = True


def test_send_json_writes_headers_and_body() -> None:
    handler = _HandlerStub()
    ApiHandler._send_json(handler, HTTPStatus.OK, {"ok": True})  # type: ignore[arg-type]

    assert handler.status == HTTPStatus.OK
    assert handler.headers["Content-Type"] == "application/json"
    assert handler.headers["Content-Length"] == str(len(handler.wfile.payload))
    assert handler.end_headers_called is True
    assert handler.wfile.payload == b'{"ok": true}'


def test_send_json_ignores_broken_pipe_on_write() -> None:
    handler = _HandlerStub(write_error=BrokenPipeError())

    ApiHandler._send_json(handler, HTTPStatus.OK, {"ok": True})  # type: ignore[arg-type]


def test_send_json_ignores_connection_reset_on_headers() -> None:
    handler = _HandlerStub(end_headers_error=ConnectionResetError())

    ApiHandler._send_json(handler, HTTPStatus.OK, {"ok": True})  # type: ignore[arg-type]


def test_send_json_reraises_unexpected_os_error() -> None:
    handler = _HandlerStub(write_error=OSError(5, "I/O error"))

    with pytest.raises(OSError, match="I/O error"):
        ApiHandler._send_json(handler, HTTPStatus.OK, {"ok": True})  # type: ignore[arg-type]


def test_normalize_questions_payload_accepts_valid_payload() -> None:
    payload = [
        {
            "id": "mood",
            "section": "Stress & Mind",
            "prompt": "Mood",
            "inputType": "slider",
            "min": 0,
            "max": 10,
            "step": 1,
            "defaultIncluded": True,
        },
        {
            "id": "alcohol_units",
            "section": "Nutrition",
            "prompt": "Alcohol (count)",
            "inputType": "multi-choice",
            "options": [
                {"id": "0", "label": "0"},
                {"id": "1", "label": "1"},
            ],
            "defaultIncluded": False,
        },
    ]

    normalized = _normalize_questions_payload(payload)
    assert normalized is not None
    assert normalized[0]["analysisMode"] == "predictor_next_day"
    assert normalized[1]["analysisMode"] == "predictor_next_day"
    assert normalized[1]["options"] == payload[1]["options"]


def test_normalize_questions_payload_rejects_duplicate_ids() -> None:
    payload = [
        {
            "id": "same",
            "section": "A",
            "prompt": "P1",
            "inputType": "text",
            "defaultIncluded": True,
        },
        {
            "id": "same",
            "section": "B",
            "prompt": "P2",
            "inputType": "text",
            "defaultIncluded": True,
        },
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_rejects_invalid_analysis_mode() -> None:
    payload = [
        {
            "id": "energy",
            "section": "Recovery",
            "prompt": "How was your energy?",
            "inputType": "slider",
            "defaultIncluded": True,
            "analysisMode": "invalid-mode",
        }
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_accepts_children_and_scores() -> None:
    payload = [
        {
            "id": "alcohol_units",
            "section": "Nutrition",
            "prompt": "Alcohol",
            "inputLabel": "Count",
            "inputType": "multi-choice",
            "analysisMode": "predictor_next_day",
            "options": [
                {"id": "0", "label": "0", "score": 0},
                {"id": "3plus", "label": "3+", "score": 3},
            ],
            "children": [
                {
                    "id": "alcohol_last_time",
                    "prompt": "Last alcohol drink",
                    "inputType": "time",
                    "analysisMode": "predictor_next_day",
                    "condition": {"operator": "greater_than", "value": 0},
                }
            ],
            "defaultIncluded": True,
        }
    ]

    normalized = _normalize_questions_payload(payload)
    assert normalized is not None
    child = normalized[0]["children"][0]
    assert child["condition"] == {"operator": "greater_than", "value": 0}
    assert normalized[0]["options"][1]["score"] == 3


def test_normalize_questions_payload_rejects_invalid_child_operator() -> None:
    payload = [
        {
            "id": "caffeine_count",
            "section": "Nutrition",
            "prompt": "Caffeine",
            "inputType": "slider",
            "min": 0,
            "max": 8,
            "step": 1,
            "children": [
                {
                    "id": "caffeine_last_time",
                    "prompt": "Last caffeine drink",
                    "inputType": "time",
                    "analysisMode": "predictor_next_day",
                    "condition": {"operator": "bad_operator"},
                }
            ],
            "defaultIncluded": True,
        }
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_rejects_more_than_three_children() -> None:
    payload = [
        {
            "id": "energy",
            "section": "Recovery",
            "prompt": "Energy",
            "inputType": "slider",
            "min": 0,
            "max": 10,
            "step": 1,
            "children": [
                {
                    "id": "energy_child_1",
                    "prompt": "1",
                    "inputType": "boolean",
                    "analysisMode": "target_same_day",
                    "condition": {"operator": "non_empty"},
                },
                {
                    "id": "energy_child_2",
                    "prompt": "2",
                    "inputType": "boolean",
                    "analysisMode": "target_same_day",
                    "condition": {"operator": "non_empty"},
                },
                {
                    "id": "energy_child_3",
                    "prompt": "3",
                    "inputType": "boolean",
                    "analysisMode": "target_same_day",
                    "condition": {"operator": "non_empty"},
                },
                {
                    "id": "energy_child_4",
                    "prompt": "4",
                    "inputType": "boolean",
                    "analysisMode": "target_same_day",
                    "condition": {"operator": "non_empty"},
                },
            ],
            "defaultIncluded": True,
        }
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_rejects_duplicate_child_ids() -> None:
    payload = [
        {
            "id": "alcohol_units",
            "section": "Nutrition",
            "prompt": "Alcohol",
            "inputType": "multi-choice",
            "options": [{"id": "0", "label": "0"}],
            "children": [
                {
                    "id": "duplicate_child",
                    "prompt": "A",
                    "inputType": "time",
                    "analysisMode": "predictor_next_day",
                    "condition": {"operator": "greater_than", "value": 0},
                },
                {
                    "id": "duplicate_child",
                    "prompt": "B",
                    "inputType": "time",
                    "analysisMode": "predictor_next_day",
                    "condition": {"operator": "greater_than", "value": 0},
                },
            ],
            "defaultIncluded": True,
        }
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_rejects_invalid_option_score() -> None:
    payload = [
        {
            "id": "alcohol_units",
            "section": "Nutrition",
            "prompt": "Alcohol",
            "inputType": "multi-choice",
            "options": [{"id": "3plus", "label": "3+", "score": "bad"}],
            "defaultIncluded": True,
        }
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_rejects_parent_child_id_collision() -> None:
    payload = [
        {
            "id": "caffeine_count",
            "section": "Nutrition",
            "prompt": "Caffeine",
            "inputType": "slider",
            "min": 0,
            "max": 8,
            "step": 1,
            "children": [
                {
                    "id": "mood",
                    "prompt": "Last caffeine drink",
                    "inputType": "time",
                    "analysisMode": "predictor_next_day",
                    "condition": {"operator": "greater_than", "value": 0},
                }
            ],
            "defaultIncluded": True,
        },
        {
            "id": "mood",
            "section": "Recovery",
            "prompt": "Mood",
            "inputType": "slider",
            "min": 0,
            "max": 10,
            "step": 1,
            "defaultIncluded": True,
        },
    ]

    assert _normalize_questions_payload(payload) is None


def test_normalize_questions_payload_keeps_backward_compatibility() -> None:
    payload = [
        {
            "id": "mood",
            "section": "Stress & Mind",
            "prompt": "Mood",
            "inputType": "slider",
            "min": 0,
            "max": 10,
            "step": 1,
            "defaultIncluded": True,
        }
    ]

    normalized = _normalize_questions_payload(payload)
    assert normalized is not None
    assert normalized[0]["id"] == "mood"
    assert normalized[0]["analysisMode"] == "predictor_next_day"
    assert "children" not in normalized[0]


def test_normalize_dashboard_plots_payload_accepts_key_direction_entries() -> None:
    payload = [
        {"key": "metric:sleepScore", "direction": "higher"},
        {"key": "metric:stress", "direction": "lower"},
    ]

    normalized = _normalize_dashboard_plots_payload(payload)
    assert normalized == payload


def test_normalize_dashboard_plots_payload_supports_legacy_key_list() -> None:
    payload = ["metric:stress", "garmin:sleepConsistency", "question:mood"]

    normalized = _normalize_dashboard_plots_payload(payload)
    assert normalized == [
        {"key": "metric:stress", "direction": "lower"},
        {"key": "garmin:sleepConsistency", "direction": "lower"},
        {"key": "question:mood", "direction": "higher"},
    ]


def test_normalize_dashboard_plots_payload_rejects_invalid_direction() -> None:
    payload = [{"key": "metric:sleepScore", "direction": "sideways"}]

    assert _normalize_dashboard_plots_payload(payload) is None


def test_normalize_checkin_reminder_settings_payload_accepts_valid_payload() -> None:
    payload = {"enabled": True, "notifyAfter": "22:30"}

    normalized = _normalize_checkin_reminder_settings_payload(payload)
    assert normalized == payload


@pytest.mark.parametrize(
    "payload",
    [
        {"notifyAfter": "22:30"},
        {"enabled": True},
        {"enabled": "yes", "notifyAfter": "22:30"},
        {"enabled": True, "notifyAfter": "24:00"},
        {"enabled": True, "notifyAfter": "22:75"},
        {"enabled": True, "notifyAfter": "bad"},
    ],
)
def test_normalize_checkin_reminder_settings_payload_rejects_invalid_payload(
    payload: object,
) -> None:
    assert _normalize_checkin_reminder_settings_payload(payload) is None


def test_checkin_reminder_settings_load_defaults_when_missing(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"

    loaded = _load_checkin_reminder_settings_payload(str(db_path))
    assert loaded == {"enabled": True, "notifyAfter": "22:30"}


def test_checkin_reminder_settings_save_and_load_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    payload = {"enabled": False, "notifyAfter": "21:15"}

    saved = _save_checkin_reminder_settings_payload(str(db_path), payload)
    assert saved == payload

    loaded = _load_checkin_reminder_settings_payload(str(db_path))
    assert loaded == payload


def test_dashboard_plot_settings_save_and_load_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    payload = [
        {"key": "metric:recoveryIndex", "direction": "higher"},
        {"key": "question:felt_energized_during_day", "direction": "lower"},
    ]

    saved = _save_dashboard_plots_payload(str(db_path), payload)
    assert saved == payload

    loaded = _load_dashboard_plots_payload(str(db_path))
    assert loaded == payload


def test_dashboard_plot_settings_load_defaults_when_missing(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"

    loaded = _load_dashboard_plots_payload(str(db_path))
    assert loaded
    assert loaded[0]["key"] == "metric:recoveryIndex"


def test_normalize_derived_predictors_payload_accepts_valid_payload() -> None:
    payload = [
        {
            "id": "caffeine_binary",
            "name": "Caffeine >= 2",
            "sourceKey": "question:caffeine_count",
            "mode": "threshold",
            "cutPoints": [2],
            "labels": ["<2", ">=2"],
        },
        {
            "id": "steps_quartiles",
            "name": "Steps Quartiles",
            "sourceKey": "garmin:steps",
            "mode": "quantile",
            "cutPoints": [7000, 10000, 13000],
            "labels": ["Q1", "Q2", "Q3", "Q4"],
        },
        {
            "id": "sleep_consistency_bins",
            "name": "Sleep Consistency",
            "sourceKey": "garmin:sleepConsistency",
            "mode": "threshold",
            "cutPoints": [30],
            "labels": ["consistent", "variable"],
        },
        {
            "id": "meal_sleep_gap_bins",
            "name": "Meal Sleep Gap",
            "sourceKey": "garmin:mealToSleepGapMinutes",
            "mode": "threshold",
            "cutPoints": [120],
            "labels": ["tight", "wide"],
        },
    ]

    normalized = _normalize_derived_predictors_payload(payload)
    assert normalized is not None
    assert normalized[0]["sourceKey"] == "question:caffeine_count"
    assert normalized[1]["mode"] == "quantile"
    assert normalized[2]["sourceKey"] == "garmin:sleepConsistency"
    assert normalized[3]["sourceKey"] == "garmin:mealToSleepGapMinutes"


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (
            [
                {
                    "id": "bad_source",
                    "name": "Bad Source",
                    "sourceKey": "garmin:isTrainingDay",
                    "mode": "threshold",
                    "cutPoints": [1],
                    "labels": ["A", "B"],
                }
            ],
            "source",
        ),
        (
            [
                {
                    "id": "bad_bins",
                    "name": "Bad Bins",
                    "sourceKey": "garmin:steps",
                    "mode": "threshold",
                    "cutPoints": [10, 5],
                    "labels": ["A", "B", "C"],
                }
            ],
            "order",
        ),
        (
            [
                {
                    "id": "bad_labels",
                    "name": "Bad Labels",
                    "sourceKey": "garmin:steps",
                    "mode": "threshold",
                    "cutPoints": [10, 20],
                    "labels": ["A", "B"],
                }
            ],
            "count",
        ),
        (
            [
                {
                    "id": "too_many",
                    "name": "Too Many",
                    "sourceKey": "garmin:steps",
                    "mode": "quantile",
                    "cutPoints": [1, 2, 3, 4, 5],
                    "labels": ["A", "B", "C", "D", "E", "F"],
                }
            ],
            "size",
        ),
    ],
)
def test_normalize_derived_predictors_payload_rejects_invalid_payload(
    payload: list[dict[str, object]],
    reason: str,
) -> None:
    _ = reason
    assert _normalize_derived_predictors_payload(payload) is None


def test_derived_predictors_save_and_load_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    payload = [
        {
            "id": "sleep_binary",
            "name": "Sleep >= 7h",
            "sourceKey": "garmin:sleepSeconds",
            "mode": "threshold",
            "cutPoints": [25200],
            "labels": ["<7h", ">=7h"],
        }
    ]

    saved = _save_derived_predictors_payload(str(db_path), payload)
    assert len(saved) == 1
    assert saved[0]["labels"] == ["<7h", ">=7h"]

    loaded = _load_derived_predictors_payload(str(db_path))
    assert loaded == saved


def test_as_clock_time_supports_iso_and_epoch_ms() -> None:
    assert _as_clock_time("2026-02-21T23:47:00+00:00") == "23:47"
    assert _as_clock_time(1_700_000_000_000) == "22:13"


def test_import_status_message_shows_progress_with_eta() -> None:
    message = _import_status_message(
        state="running",
        started_at="2026-02-21T06:00:00+00:00",
        days_requested=4,
        days_succeeded=2,
        now_utc=datetime(2026, 2, 21, 6, 20, tzinfo=timezone.utc),
    )
    assert message == "Import in progress · 2/4 days · ~20 min left"


def test_import_status_message_handles_no_completed_days() -> None:
    message = _import_status_message(
        state="running",
        started_at="2026-02-21T06:00:00+00:00",
        days_requested=3,
        days_succeeded=0,
    )
    assert message == "Import in progress · 0/3 days"


def test_import_status_message_returns_default_when_not_running() -> None:
    message = _import_status_message(
        state="ok",
        started_at="2026-02-21T06:00:00+00:00",
        days_requested=3,
        days_succeeded=3,
    )
    assert message == "Daily import scheduled · 06:00 local"


def test_parse_import_request_refresh_uses_default_days() -> None:
    request = _parse_import_request(
        {"mode": "refresh"},
        default_sync_days=3,
        today=date(2026, 2, 21),
    )

    assert request == ImportRequest(
        mode="refresh",
        start_date=date(2026, 2, 19),
        end_date=date(2026, 2, 21),
    )


def test_parse_import_request_range_accepts_valid_payload() -> None:
    request = _parse_import_request(
        {"mode": "range", "fromDate": "2026-02-01", "toDate": "2026-02-15"},
        default_sync_days=2,
        today=date(2026, 2, 21),
    )

    assert request == ImportRequest(
        mode="range",
        start_date=date(2026, 2, 1),
        end_date=date(2026, 2, 15),
    )


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"mode": "unknown"}, "mode must be either"),
        (
            {"mode": "range", "fromDate": "2026-02-11", "toDate": "2026-02-10"},
            "on or before",
        ),
        ({"mode": "range", "fromDate": "bad", "toDate": "2026-02-10"}, "YYYY-MM-DD"),
        (
            {"mode": "range", "fromDate": "2025-01-01", "toDate": "2026-02-21"},
            "cannot exceed 365 days",
        ),
        (
            {"mode": "range", "fromDate": "2026-02-19", "toDate": "2026-02-22"},
            "cannot be in the future",
        ),
    ],
)
def test_parse_import_request_rejects_invalid_payload(
    payload: dict[str, str],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        _parse_import_request(
            payload,
            default_sync_days=2,
            today=date(2026, 2, 21),
        )


def test_checkins_save_and_load_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    payload = {
        "date": "2026-02-20",
        "answers": {"energy": 8, "late_meal": "21:15", "alcohol": 0},
    }

    saved = _save_checkin_payload(str(db_path), payload)
    assert saved["date"] == "2026-02-20"
    assert saved["answers"]["energy"] == 8

    loaded = _load_checkins_payload(
        str(db_path),
        from_date=date(2026, 2, 20),
        to_date=date(2026, 2, 20),
    )
    assert len(loaded) == 1
    assert loaded[0]["date"] == "2026-02-20"
    assert loaded[0]["answers"]["late_meal"] == "21:15"


def test_load_correlation_values_payload_uses_materialized_analysis_values(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    init_db(connection)
    connection.execute(
        """
        INSERT INTO daily_metrics (
            metric_date,
            steps,
            calories,
            resting_heart_rate,
            body_battery,
            stress_avg,
            sleep_seconds,
            fell_asleep_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "2026-02-20",
            6000,
            2100,
            50,
            70,
            30,
            25200,
            "2026-02-19T22:40:00+00:00",
            "2026-02-21T06:00:00+00:00",
        ),
    )
    connection.execute(
        """
        INSERT INTO daily_metrics (
            metric_date,
            steps,
            calories,
            resting_heart_rate,
            body_battery,
            stress_avg,
            sleep_seconds,
            fell_asleep_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "2026-02-21",
            6500,
            2200,
            49,
            72,
            25,
            28800,
            "2026-02-20T22:45:00+00:00",
            "2026-02-22T06:00:00+00:00",
        ),
    )
    connection.execute(
        """
        INSERT INTO checkin_entries (checkin_date, answers_json, completed_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (
            "2026-02-20",
            '{"caffeine_count": 2, "late_meal": "21:15", "felt_energized_during_day": "normal"}',
            "2026-02-20T21:00:00+00:00",
            "2026-02-20T21:00:00+00:00",
        ),
    )
    connection.commit()
    connection.close()

    values = _load_correlation_values_payload(
        str(db_path),
        from_date=date(2026, 2, 21),
        to_date=date(2026, 2, 21),
    )
    values_by_key = {(value["role"], value["featureKey"]): value for value in values}

    predictor_steps = values_by_key[("predictor", "garmin:steps")]
    assert predictor_steps["valueNum"] == 6000
    assert predictor_steps["sourceDate"] == "2026-02-20"
    assert predictor_steps["lagDays"] == -1

    predictor_sleep = values_by_key[("predictor", "garmin:sleepSeconds")]
    assert predictor_sleep["valueNum"] == 28800
    assert predictor_sleep["sourceDate"] == "2026-02-20"
    assert predictor_sleep["alignmentRule"] == "garmin_sleep_previous_night"

    predictor_question = values_by_key[("predictor", "question:caffeine_count")]
    assert predictor_question["valueNum"] == 2
    assert predictor_question["alignmentRule"] == "checkin_previous_day"

    predictor_meal_sleep = values_by_key[("predictor", "garmin:mealToSleepGapMinutes")]
    assert predictor_meal_sleep["valueNum"] == 90
    assert predictor_meal_sleep["alignmentRule"] == "meal_sleep_gap_previous_day"

    target_sleep_score = values_by_key[("target", "metric:sleepScore")]
    assert target_sleep_score["valueNum"] == 90
    assert target_sleep_score["sourceDate"] == "2026-02-21"


def test_load_dashboard_payload_includes_fell_asleep_iso_field(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    metric_date = date.today().isoformat()
    fell_asleep_at = "2026-02-20T22:44:00+00:00"

    connection = connect_db(str(db_path))
    init_db(connection)
    connection.execute(
        """
        INSERT INTO daily_metrics (metric_date, sleep_seconds, fell_asleep_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (metric_date, 29220, fell_asleep_at, "2026-02-21T06:00:00+00:00"),
    )
    connection.commit()
    connection.close()

    payload = _load_dashboard_payload(str(db_path), 7)
    record = next(
        (entry for entry in payload["records"] if entry["date"] == metric_date),
        None,
    )

    assert record is not None
    assert record["fellAsleepAtIso"] == fell_asleep_at
    assert record["fellAsleepAt"] == "22:44"
    assert "sleepConsistency" in record["predictors"]


def test_load_correlation_values_payload_includes_sleep_consistency_predictor(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    init_db(connection)
    start_date = date(2026, 2, 1)
    for offset in range(10):
        metric_date = start_date + timedelta(days=offset)
        source_date = metric_date - timedelta(days=1)
        fell_asleep_at = (
            f"{source_date.isoformat()}T23:55:00+00:00"
            if offset % 2 == 0
            else f"{source_date.isoformat()}T00:05:00+00:00"
        )
        woke_up_at = (
            f"{metric_date.isoformat()}T07:00:00+00:00"
            if offset % 2 == 0
            else f"{metric_date.isoformat()}T07:10:00+00:00"
        )
        connection.execute(
            """
            INSERT INTO daily_metrics (
                metric_date,
                sleep_seconds,
                fell_asleep_at,
                woke_up_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                metric_date.isoformat(),
                25200,
                fell_asleep_at,
                woke_up_at,
                "2026-02-22T06:00:00+00:00",
            ),
        )
    connection.commit()
    connection.close()

    values = _load_correlation_values_payload(
        str(db_path),
        from_date=date(2026, 2, 10),
        to_date=date(2026, 2, 10),
    )
    values_by_key = {(value["role"], value["featureKey"]): value for value in values}
    predictor = values_by_key[("predictor", "garmin:sleepConsistency")]

    assert predictor["lagDays"] == -1
    assert predictor["sourceDate"] == "2026-02-09"
    assert predictor["alignmentRule"] == "garmin_previous_day"
    assert predictor["valueNum"] is not None
    assert predictor["valueNum"] < 10


def test_load_correlation_values_payload_omits_sleep_consistency_when_window_incomplete(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    init_db(connection)
    start_date = date(2026, 2, 1)
    for offset in range(10):
        metric_date = start_date + timedelta(days=offset)
        source_date = metric_date - timedelta(days=1)
        woke_up_at: str | None = f"{metric_date.isoformat()}T07:00:00+00:00"
        if metric_date == date(2026, 2, 6):
            woke_up_at = None
        connection.execute(
            """
            INSERT INTO daily_metrics (
                metric_date,
                sleep_seconds,
                fell_asleep_at,
                woke_up_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                metric_date.isoformat(),
                25200,
                f"{source_date.isoformat()}T23:55:00+00:00",
                woke_up_at,
                "2026-02-22T06:00:00+00:00",
            ),
        )
    connection.commit()
    connection.close()

    values = _load_correlation_values_payload(
        str(db_path),
        from_date=date(2026, 2, 10),
        to_date=date(2026, 2, 10),
    )
    keys = {(value["role"], value["featureKey"]) for value in values}

    assert ("predictor", "garmin:sleepConsistency") not in keys


def test_load_dashboard_payload_includes_sleep_consistency_with_lookback(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    today = date.today()

    connection = connect_db(str(db_path))
    init_db(connection)
    for offset in range(6, -1, -1):
        metric_date = today - timedelta(days=offset)
        source_date = metric_date - timedelta(days=1)
        fell_asleep_at = (
            f"{source_date.isoformat()}T23:55:00+00:00"
            if offset % 2 == 0
            else f"{source_date.isoformat()}T00:05:00+00:00"
        )
        woke_up_at = (
            f"{metric_date.isoformat()}T07:00:00+00:00"
            if offset % 2 == 0
            else f"{metric_date.isoformat()}T07:10:00+00:00"
        )
        connection.execute(
            """
            INSERT INTO daily_metrics (
                metric_date,
                sleep_seconds,
                fell_asleep_at,
                woke_up_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                metric_date.isoformat(),
                25200,
                fell_asleep_at,
                woke_up_at,
                "2026-02-22T06:00:00+00:00",
            ),
        )
    connection.commit()
    connection.close()

    payload = _load_dashboard_payload(str(db_path), 1)
    record = payload["records"][0]

    assert record["date"] == today.isoformat()
    assert record["predictors"]["sleepConsistency"] is not None
    assert record["predictors"]["sleepConsistency"] < 10


def test_import_job_manager_rejects_when_sync_run_already_running(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    init_db(connection)
    connection.execute(
        """
        INSERT INTO sync_runs (started_at, status, days_requested, days_succeeded)
        VALUES ('2026-02-21T06:00:00+00:00', 'running', 2, 0)
        """
    )
    connection.commit()
    connection.close()

    manager = ImportJobManager()
    settings = ApiSettings(
        db_path=str(db_path),
        host="127.0.0.1",
        port=8000,
        garmin_email="user@example.com",
        garmin_password="secret",
        default_sync_days=2,
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_user="smtp-user",
        smtp_pass="smtp-pass",
        timezone="Europe/Madrid",
    )
    request = ImportRequest(
        mode="refresh",
        start_date=date(2026, 2, 20),
        end_date=date(2026, 2, 21),
    )

    assert manager.start(settings=settings, request=request) is False
