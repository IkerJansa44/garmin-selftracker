from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    garmin_email: str
    garmin_password: str
    db_path: str
    default_sync_days: int


class SettingsError(RuntimeError):
    """Raised when required environment configuration is missing."""


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if value:
        return value
    raise SettingsError(f"Missing required environment variable: {name}")


def load_settings(*, require_garmin_credentials: bool = True) -> Settings:
    garmin_email = _required_env("GARMIN_EMAIL") if require_garmin_credentials else ""
    garmin_password = (
        _required_env("GARMIN_PASSWORD") if require_garmin_credentials else ""
    )
    db_path = os.getenv("SQLITE_DB_PATH", "/data/garmin.db")
    default_sync_days = int(os.getenv("DEFAULT_SYNC_DAYS", "2"))
    return Settings(
        garmin_email=garmin_email,
        garmin_password=garmin_password,
        db_path=db_path,
        default_sync_days=default_sync_days,
    )
