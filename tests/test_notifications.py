from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from pywebpush import WebPushException

from src.notifications import (
    PushNotification,
    WebPushSettings,
    load_notification_preferences,
    save_notification_preferences,
    send_web_push,
)
from src.push_subscriptions import load_push_subscriptions, save_push_subscription


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _subscription(endpoint: str) -> dict[str, Any]:
    return {
        "endpoint": endpoint,
        "expirationTime": None,
        "keys": {
            "p256dh": _encode(b"\x04" + b"a" * 64),
            "auth": _encode(b"b" * 16),
        },
    }


def test_notification_preferences_default_to_existing_email_behavior(
    tmp_path: Path,
) -> None:
    db_path = str(tmp_path / "garmin.db")

    assert load_notification_preferences(db_path) == {"email": True, "iphone": False}
    assert save_notification_preferences(db_path, {"email": False, "iphone": True}) == {
        "email": False,
        "iphone": True,
    }
    assert load_notification_preferences(db_path) == {"email": False, "iphone": True}


def test_existing_subscription_migrates_to_iphone_enabled(tmp_path: Path) -> None:
    db_path = str(tmp_path / "garmin.db")
    save_push_subscription(
        db_path, _subscription("https://web.push.apple.com/QP1/existing")
    )

    assert load_notification_preferences(db_path) == {"email": True, "iphone": True}


def test_send_web_push_delivers_json_and_removes_expired_subscriptions(
    tmp_path: Path, monkeypatch: Any
) -> None:
    db_path = str(tmp_path / "garmin.db")
    active_endpoint = "https://web.push.apple.com/QP1/active"
    expired_endpoint = "https://web.push.apple.com/QP1/expired"
    save_push_subscription(db_path, _subscription(active_endpoint))
    save_push_subscription(db_path, _subscription(expired_endpoint))
    sent_payloads: list[dict[str, Any]] = []

    def fake_webpush(**kwargs: Any) -> None:
        if kwargs["subscription_info"]["endpoint"] == expired_endpoint:
            raise WebPushException("gone", response=SimpleNamespace(status_code=410))
        sent_payloads.append(json.loads(kwargs["data"]))

    monkeypatch.setattr("src.notifications.webpush", fake_webpush)
    notification = PushNotification(
        title="Reminder",
        body="Complete your check-in",
        url="https://dashboard.test/",
        tag="checkin",
    )

    delivered = send_web_push(
        WebPushSettings(db_path, "private-key", "mailto:user@example.com"),
        notification,
    )

    assert delivered == 1
    assert sent_payloads == [
        {
            "title": "Reminder",
            "body": "Complete your check-in",
            "url": "https://dashboard.test/",
            "tag": "checkin",
        }
    ]
    assert [item.endpoint for item in load_push_subscriptions(db_path)] == [
        active_endpoint
    ]
