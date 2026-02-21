from __future__ import annotations

from http import HTTPStatus

import pytest

from src.api import ApiHandler, _as_clock_time, _normalize_questions_payload


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
            "prompt": "Alcohol",
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
