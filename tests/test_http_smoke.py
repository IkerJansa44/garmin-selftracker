from __future__ import annotations

import base64
import json
from io import BytesIO
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from src.api import ApiHandler
from src.push_subscriptions import load_push_subscriptions


def _request_json(
    handler_type: type[ApiHandler],
    path: str,
    method: str = "GET",
    payload: object | None = None,
) -> dict[str, Any]:
    body = json.dumps(payload).encode() if payload is not None else None
    handler = object.__new__(handler_type)
    handler.path = path
    handler.headers = {"Content-Length": str(len(body))} if body is not None else {}
    handler.rfile = BytesIO(body or b"")
    response: list[tuple[HTTPStatus, dict[str, Any]]] = []
    handler._send_json = lambda status, data: response.append((status, data))  # type: ignore[method-assign]

    getattr(handler, f"do_{method}")()

    assert response[0][0] is HTTPStatus.OK
    return response[0][1]


def test_checkin_draft_to_final_save_through_http_and_sqlite(tmp_path: Path) -> None:
    class TestApiHandler(ApiHandler):
        db_path = str(tmp_path / "garmin.db")

        def log_message(self, format: str, *args: object) -> None:
            pass

    checkin = {"date": "2026-08-08", "answers": {"journal": "Recovered"}}

    saved_draft = _request_json(TestApiHandler, "/api/checkin-drafts", "PUT", checkin)
    draft_list = _request_json(
        TestApiHandler,
        "/api/checkins?fromDate=2026-08-08&toDate=2026-08-08",
    )
    saved_entry = _request_json(TestApiHandler, "/api/checkins", "PUT", checkin)
    final_list = _request_json(
        TestApiHandler,
        "/api/checkins?fromDate=2026-08-08&toDate=2026-08-08",
    )

    assert saved_draft["draft"]["answers"] == {"journal": "Recovered"}
    assert len(draft_list["drafts"]) == 1
    assert saved_entry["entry"]["answers"] == {"journal": "Recovered"}
    assert final_list["drafts"] == []
    assert len(final_list["entries"]) == 1


def test_push_subscription_lifecycle_through_http_and_sqlite(tmp_path: Path) -> None:
    class TestApiHandler(ApiHandler):
        db_path = str(tmp_path / "garmin.db")
        settings = SimpleNamespace(web_push_vapid_public_key="vapid-public-key")  # type: ignore[assignment]

        def log_message(self, format: str, *args: object) -> None:
            pass

    def encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()

    subscription = {
        "endpoint": "https://web.push.apple.com/QP1/http-smoke",
        "expirationTime": None,
        "keys": {
            "p256dh": encode(b"\x04" + b"a" * 64),
            "auth": encode(b"b" * 16),
        },
    }

    public_key = _request_json(TestApiHandler, "/api/push/public-key")
    created = _request_json(
        TestApiHandler, "/api/push/subscriptions", "POST", subscription
    )
    updated = _request_json(
        TestApiHandler, "/api/push/subscriptions", "POST", subscription
    )

    assert public_key == {"publicKey": "vapid-public-key"}
    assert created == {"subscribed": True, "created": True}
    assert updated == {"subscribed": True, "created": False}
    assert len(load_push_subscriptions(TestApiHandler.db_path)) == 1

    removed = _request_json(
        TestApiHandler,
        "/api/push/subscriptions",
        "DELETE",
        {"endpoint": subscription["endpoint"]},
    )
    assert removed == {"subscribed": False, "removed": True}
    assert load_push_subscriptions(TestApiHandler.db_path) == []
