from __future__ import annotations

import base64
import binascii
import math
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from src.db import connect_db, init_db, utc_now

BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_ENDPOINT_LENGTH = 4096
MAX_KEY_LENGTH = 256
MAX_EXPIRATION_TIME = 2**53 - 1
P256DH_LENGTH = 65
AUTH_LENGTH = 16


@dataclass(frozen=True)
class PushSubscription:
    endpoint: str
    p256dh: str
    auth: str
    expiration_time: int | None

    def as_web_push_dict(self) -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "expirationTime": self.expiration_time,
            "keys": {"p256dh": self.p256dh, "auth": self.auth},
        }


def parse_push_subscription(payload: Any) -> PushSubscription:
    if not isinstance(payload, dict):
        raise ValueError("Subscription must be an object")

    keys = payload.get("keys")
    if not isinstance(keys, dict):
        raise ValueError("Subscription keys must be an object")

    endpoint = _parse_endpoint(payload.get("endpoint"))
    p256dh = _parse_key(keys.get("p256dh"), "p256dh", P256DH_LENGTH)
    auth = _parse_key(keys.get("auth"), "auth", AUTH_LENGTH)
    if _decode_base64url(p256dh)[0] != 4:
        raise ValueError("Subscription p256dh key must be an uncompressed P-256 key")

    expiration_time = payload.get("expirationTime")
    if expiration_time is not None:
        if (
            isinstance(expiration_time, bool)
            or not isinstance(expiration_time, (int, float))
            or not math.isfinite(expiration_time)
            or expiration_time < 0
            or expiration_time > MAX_EXPIRATION_TIME
        ):
            raise ValueError(
                "Subscription expirationTime must be a safe non-negative timestamp or null"
            )
        expiration_time = int(expiration_time)

    return PushSubscription(endpoint, p256dh, auth, expiration_time)


def parse_subscription_endpoint(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise ValueError("Subscription removal payload must be an object")
    return _parse_endpoint(payload.get("endpoint"))


def save_push_subscription(db_path: str, payload: Any) -> bool:
    subscription = parse_push_subscription(payload)
    connection = connect_db(db_path)
    try:
        init_db(connection)
        created = (
            connection.execute(
                "SELECT 1 FROM push_subscriptions WHERE endpoint = ?",
                (subscription.endpoint,),
            ).fetchone()
            is None
        )
        now = utc_now()
        connection.execute(
            """
            INSERT INTO push_subscriptions
                (endpoint, p256dh, auth, expiration_time, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                expiration_time = excluded.expiration_time,
                updated_at = excluded.updated_at
            """,
            (
                subscription.endpoint,
                subscription.p256dh,
                subscription.auth,
                subscription.expiration_time,
                now,
                now,
            ),
        )
        connection.commit()
        return created
    finally:
        connection.close()


def delete_push_subscription(db_path: str, payload: Any) -> bool:
    endpoint = parse_subscription_endpoint(payload)
    connection = connect_db(db_path)
    try:
        init_db(connection)
        cursor = connection.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,)
        )
        connection.commit()
        return cursor.rowcount > 0
    finally:
        connection.close()


def load_push_subscriptions(db_path: str) -> list[PushSubscription]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        rows = connection.execute(
            """
            SELECT endpoint, p256dh, auth, expiration_time
            FROM push_subscriptions
            ORDER BY created_at
            """
        ).fetchall()
        return [
            PushSubscription(
                endpoint=str(row["endpoint"]),
                p256dh=str(row["p256dh"]),
                auth=str(row["auth"]),
                expiration_time=(
                    int(row["expiration_time"])
                    if row["expiration_time"] is not None
                    else None
                ),
            )
            for row in rows
        ]
    finally:
        connection.close()


def _parse_endpoint(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Subscription endpoint must be a string")
    endpoint = value.strip()
    if (
        not endpoint
        or len(endpoint) > MAX_ENDPOINT_LENGTH
        or any(character.isspace() for character in endpoint)
    ):
        raise ValueError("Subscription endpoint has an invalid length")
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username is not None:
        raise ValueError("Subscription endpoint must be an HTTPS URL")
    return endpoint


def _parse_key(value: Any, name: str, expected_length: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > MAX_KEY_LENGTH
        or BASE64URL_PATTERN.fullmatch(value) is None
    ):
        raise ValueError(f"Subscription {name} key must be base64url encoded")
    if len(_decode_base64url(value)) != expected_length:
        raise ValueError(f"Subscription {name} key has an invalid length")
    return value


def _decode_base64url(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    try:
        return base64.b64decode(padded, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Subscription key must be valid base64url") from exc
