from __future__ import annotations

from datetime import date
from http import HTTPStatus
from pathlib import Path

import pytest

from src.api import (
    ApiHandler,
    ApiSettings,
    ImportJobManager,
    ImportRequest,
    _as_clock_time,
    _normalize_questions_payload,
    _parse_import_request,
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
    assert normalized == payload


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


def test_as_clock_time_supports_iso_and_epoch_ms() -> None:
    assert _as_clock_time("2026-02-21T23:47:00+00:00") == "23:47"
    assert _as_clock_time(1_700_000_000_000) == "22:13"


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
    )
    request = ImportRequest(
        mode="refresh",
        start_date=date(2026, 2, 20),
        end_date=date(2026, 2, 21),
    )

    assert manager.start(settings=settings, request=request) is False
