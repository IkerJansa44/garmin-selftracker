from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import asdict, dataclass
from typing import Any

from pywebpush import WebPushException, webpush

from src.db import connect_db, get_setting_json, init_db, upsert_setting_json
from src.push_subscriptions import delete_push_subscription, load_push_subscriptions

logger = logging.getLogger(__name__)

NOTIFICATION_PREFERENCES_KEY = "notification_preferences"
DEFAULT_NOTIFICATION_PREFERENCES = {"email": True, "iphone": False}
EXPIRED_SUBSCRIPTION_STATUS_CODES = {404, 410}


def normalize_notification_preferences(payload: Any) -> dict[str, bool] | None:
    if not isinstance(payload, dict):
        return None
    email = payload.get("email")
    iphone = payload.get("iphone")
    if not isinstance(email, bool) or not isinstance(iphone, bool):
        return None
    return {"email": email, "iphone": iphone}


def load_notification_preferences(
    db_path: str, connection: sqlite3.Connection | None = None
) -> dict[str, bool]:
    owns_connection = connection is None
    active_connection = connection or connect_db(db_path)
    try:
        init_db(active_connection)
        stored = normalize_notification_preferences(
            get_setting_json(active_connection, NOTIFICATION_PREFERENCES_KEY)
        )
        if stored is not None:
            return stored
        has_subscription = (
            active_connection.execute(
                "SELECT 1 FROM push_subscriptions LIMIT 1"
            ).fetchone()
            is not None
        )
        return {**DEFAULT_NOTIFICATION_PREFERENCES, "iphone": has_subscription}
    finally:
        if owns_connection:
            active_connection.close()


def save_notification_preferences(db_path: str, payload: Any) -> dict[str, bool]:
    preferences = normalize_notification_preferences(payload)
    if preferences is None:
        raise ValueError("Notification preferences require email and iphone booleans")
    connection = connect_db(db_path)
    try:
        init_db(connection)
        upsert_setting_json(connection, NOTIFICATION_PREFERENCES_KEY, preferences)
        connection.commit()
        return preferences
    finally:
        connection.close()


@dataclass(frozen=True)
class WebPushSettings:
    db_path: str
    vapid_private_key: str
    vapid_subject: str


@dataclass(frozen=True)
class PushNotification:
    title: str
    body: str
    url: str
    tag: str


def send_web_push(settings: WebPushSettings, notification: PushNotification) -> int:
    if not settings.vapid_private_key or not settings.vapid_subject:
        raise RuntimeError(
            "iPhone notifications require WEB_PUSH_VAPID_PRIVATE_KEY and "
            "WEB_PUSH_VAPID_SUBJECT"
        )

    delivered = 0
    expired_endpoints: list[str] = []
    payload = json.dumps(asdict(notification), separators=(",", ":"))
    for subscription in load_push_subscriptions(settings.db_path):
        try:
            webpush(
                subscription_info=subscription.as_web_push_dict(),
                data=payload,
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
                ttl=24 * 60 * 60,
                timeout=30,
            )
            delivered += 1
        except WebPushException as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code in EXPIRED_SUBSCRIPTION_STATUS_CODES:
                expired_endpoints.append(subscription.endpoint)
                continue
            logger.exception("Failed to send Web Push notification")

    for endpoint in expired_endpoints:
        delete_push_subscription(settings.db_path, {"endpoint": endpoint})
    return delivered
