from __future__ import annotations

import base64
from pathlib import Path

import pytest

from src.push_subscriptions import (
    delete_push_subscription,
    load_push_subscriptions,
    parse_push_subscription,
    save_push_subscription,
)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _subscription_payload(*, marker: bytes = b"a") -> dict[str, object]:
    return {
        "endpoint": "https://web.push.apple.com/QP1/example",
        "expirationTime": None,
        "keys": {
            "p256dh": _base64url(b"\x04" + marker * 64),
            "auth": _base64url(marker * 16),
        },
    }


def test_parse_push_subscription_accepts_browser_payload() -> None:
    subscription = parse_push_subscription(_subscription_payload())

    assert subscription.endpoint == "https://web.push.apple.com/QP1/example"
    assert subscription.expiration_time is None
    assert subscription.as_web_push_dict() == _subscription_payload()


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {**_subscription_payload(), "endpoint": "http://push.example.com/value"},
        {**_subscription_payload(), "expirationTime": True},
        {
            **_subscription_payload(),
            "keys": {"p256dh": "invalid", "auth": "invalid"},
        },
    ],
)
def test_parse_push_subscription_rejects_invalid_payloads(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        parse_push_subscription(payload)


def test_push_subscription_persistence_is_idempotent(tmp_path: Path) -> None:
    db_path = str(tmp_path / "garmin.db")
    first_payload = _subscription_payload(marker=b"a")
    updated_payload = _subscription_payload(marker=b"b")

    assert save_push_subscription(db_path, first_payload) is True
    assert save_push_subscription(db_path, updated_payload) is False

    subscriptions = load_push_subscriptions(db_path)
    assert len(subscriptions) == 1
    assert subscriptions[0].as_web_push_dict() == updated_payload

    endpoint_payload = {"endpoint": first_payload["endpoint"]}
    assert delete_push_subscription(db_path, endpoint_payload) is True
    assert delete_push_subscription(db_path, endpoint_payload) is False
    assert load_push_subscriptions(db_path) == []
