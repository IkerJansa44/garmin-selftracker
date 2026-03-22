from __future__ import annotations

import logging
import re
import sqlite3
import smtplib
import threading
from dataclasses import dataclass
from datetime import date, datetime
from email.message import EmailMessage
from typing import Any, Callable

from src.db import connect_db, get_setting_json, init_db, upsert_setting_json

logger = logging.getLogger(__name__)

CHECKIN_REMINDER_SETTINGS_KEY = "checkin_email_reminder"
CHECKIN_REMINDER_LAST_SENT_KEY = "checkin_email_reminder_last_sent"
DEFAULT_NOTIFY_AFTER = "22:30"
DEFAULT_CHECKIN_REMINDER_SETTINGS = {
    "enabled": True,
    "notifyAfter": DEFAULT_NOTIFY_AFTER,
}
NOTIFY_AFTER_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def normalize_checkin_reminder_settings(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None

    enabled = payload.get("enabled")
    notify_after = payload.get("notifyAfter")
    if not isinstance(enabled, bool):
        return None
    if not isinstance(notify_after, str):
        return None

    stripped_notify_after = notify_after.strip()
    if _parse_notify_after(stripped_notify_after) is None:
        return None

    return {"enabled": enabled, "notifyAfter": stripped_notify_after}


def default_checkin_reminder_settings() -> dict[str, Any]:
    return dict(DEFAULT_CHECKIN_REMINDER_SETTINGS)


def parse_last_sent_date(payload: Any) -> str | None:
    if not isinstance(payload, str):
        return None
    try:
        return date.fromisoformat(payload.strip()).isoformat()
    except ValueError:
        return None


def _parse_notify_after(notify_after: str) -> tuple[int, int] | None:
    match = NOTIFY_AFTER_PATTERN.fullmatch(notify_after)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2))


def _is_after_cutoff(now_local: datetime, notify_after: str) -> bool:
    parsed_notify_after = _parse_notify_after(notify_after)
    if parsed_notify_after is None:
        return False
    cutoff_hour, cutoff_minute = parsed_notify_after
    current_minutes = now_local.hour * 60 + now_local.minute
    cutoff_minutes = cutoff_hour * 60 + cutoff_minute
    return current_minutes >= cutoff_minutes


def _checkin_exists_for_date(connection: sqlite3.Connection, checkin_date: str) -> bool:
    row = connection.execute(
        """
        SELECT 1
        FROM checkin_entries
        WHERE checkin_date = ?
        LIMIT 1
        """,
        (checkin_date,),
    ).fetchone()
    return row is not None


@dataclass(frozen=True)
class ReminderServiceSettings:
    db_path: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_pass: str
    recipient_email: str
    dashboard_url: str


def build_checkin_reminder_email_body(current_hour: str, dashboard_url: str) -> str:
    dashboard_line = f"\n\nDashboard: {dashboard_url}" if dashboard_url else ""
    return (
        "Hola petit,\n"
        f"Ja són les {current_hour} i encara no has introduit les dades del teu dia d'avui. "
        "Fes el favor i que no t'ho hagi de repetir."
        f"{dashboard_line}\n\n"
        "Espavila,\n"
        "Iker"
    )


class CheckinReminderService:
    def __init__(
        self,
        settings: ReminderServiceSettings,
        *,
        poll_interval_seconds: int = 60,
        now_fn: Callable[[], datetime] | None = None,
        send_email_fn: Callable[[str], None] | None = None,
    ) -> None:
        self._settings = settings
        self._poll_interval_seconds = max(1, poll_interval_seconds)
        self._now_fn = now_fn or datetime.now
        self._send_email_fn = send_email_fn
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_lock = threading.Lock()
        self._smtp_missing_warning_emitted = False

    def start(self) -> None:
        with self._thread_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run_loop,
                name="checkin-reminder-worker",
                daemon=True,
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        with self._thread_lock:
            thread = self._thread
            self._thread = None
        if thread is not None and thread.is_alive():
            thread.join(timeout=self._poll_interval_seconds + 1)

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:  # pragma: no cover - runtime guard
                logger.exception("Check-in reminder worker iteration failed")
            self._stop_event.wait(self._poll_interval_seconds)

    def run_once(self) -> None:
        now_local = self._now_fn().astimezone()
        current_date = now_local.date().isoformat()

        connection = connect_db(self._settings.db_path)
        try:
            init_db(connection)
            raw_settings = get_setting_json(connection, CHECKIN_REMINDER_SETTINGS_KEY)
            reminder_settings = normalize_checkin_reminder_settings(raw_settings)
            if reminder_settings is None:
                reminder_settings = default_checkin_reminder_settings()

            if not reminder_settings["enabled"]:
                return
            if not _is_after_cutoff(now_local, str(reminder_settings["notifyAfter"])):
                return
            if _checkin_exists_for_date(connection, current_date):
                return

            raw_last_sent = get_setting_json(connection, CHECKIN_REMINDER_LAST_SENT_KEY)
            last_sent_date = parse_last_sent_date(raw_last_sent)
            if last_sent_date == current_date:
                return
            if not self._can_send_email():
                return

            try:
                self._send_email(now_local.strftime("%H:%M"))
            except Exception:
                logger.exception(
                    "Failed to send check-in reminder email for %s", current_date
                )
                return

            upsert_setting_json(
                connection, CHECKIN_REMINDER_LAST_SENT_KEY, current_date
            )
            connection.commit()
            logger.info("Sent check-in reminder email for %s", current_date)
        finally:
            connection.close()

    def _can_send_email(self) -> bool:
        if self._send_email_fn is not None:
            return True

        missing_fields: list[str] = []
        if not self._settings.smtp_host:
            missing_fields.append("SMTP_HOST")
        if not self._settings.smtp_user:
            missing_fields.append("SMTP_USER")
        if not self._settings.smtp_pass:
            missing_fields.append("SMTP_PASS")
        if not self._settings.recipient_email:
            missing_fields.append("GARMIN_EMAIL")

        if not missing_fields:
            return True

        if not self._smtp_missing_warning_emitted:
            logger.warning(
                "Check-in reminders are enabled but email cannot be sent until required "
                "configuration is provided: %s",
                ", ".join(missing_fields),
            )
            self._smtp_missing_warning_emitted = True
        return False

    def _send_email(self, current_hour: str) -> None:
        if self._send_email_fn is not None:
            self._send_email_fn(current_hour)
            return

        if not self._settings.smtp_host:
            raise RuntimeError("SMTP_HOST is not configured")
        if not self._settings.smtp_user:
            raise RuntimeError("SMTP_USER is not configured")
        if not self._settings.smtp_pass:
            raise RuntimeError("SMTP_PASS is not configured")
        if not self._settings.recipient_email:
            raise RuntimeError("GARMIN_EMAIL recipient is not configured")

        message = EmailMessage()
        message["Subject"] = "Fes el Check-In de Garmin"
        message["From"] = self._settings.smtp_user
        message["To"] = self._settings.recipient_email
        message.set_content(
            build_checkin_reminder_email_body(
                current_hour,
                self._settings.dashboard_url,
            )
        )

        with smtplib.SMTP(
            host=self._settings.smtp_host,
            port=self._settings.smtp_port,
            timeout=30,
        ) as smtp_client:
            smtp_client.starttls()
            smtp_client.login(self._settings.smtp_user, self._settings.smtp_pass)
            smtp_client.send_message(message)
