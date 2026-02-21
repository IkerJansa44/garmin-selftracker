from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    garmin_email: str
    garmin_password: str
    db_path: str
    default_sync_days: int
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_pass: str
    timezone: str | None


class SettingsError(RuntimeError):
    """Raised when required environment configuration is missing."""


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if value:
        return value
    raise SettingsError(f"Missing required environment variable: {name}")


def _optional_env(name: str, *, default: str = "") -> str:
    return os.getenv(name, default).strip()


def load_settings(*, require_garmin_credentials: bool = True) -> Settings:
    garmin_email = _required_env("GARMIN_EMAIL") if require_garmin_credentials else ""
    garmin_password = (
        _required_env("GARMIN_PASSWORD") if require_garmin_credentials else ""
    )
    db_path = os.getenv("SQLITE_DB_PATH", "/data/garmin.db")
    default_sync_days = int(os.getenv("DEFAULT_SYNC_DAYS", "2"))
    smtp_port_raw = _optional_env("SMTP_PORT", default="587")
    try:
        smtp_port = int(smtp_port_raw)
    except ValueError as exc:
        raise SettingsError("SMTP_PORT must be an integer") from exc
    timezone = _optional_env("TZ") or None
    return Settings(
        garmin_email=garmin_email,
        garmin_password=garmin_password,
        db_path=db_path,
        default_sync_days=default_sync_days,
        smtp_host=_optional_env("SMTP_HOST"),
        smtp_port=smtp_port,
        smtp_user=_optional_env("SMTP_USER"),
        smtp_pass=_optional_env("SMTP_PASS"),
        timezone=timezone,
    )
