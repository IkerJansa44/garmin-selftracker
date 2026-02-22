from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Callable

from src.db import (
    connect_db,
    get_setting_json,
    init_db,
    upsert_checkin_entry,
    upsert_setting_json,
)
from src.reminders import (
    CHECKIN_REMINDER_LAST_SENT_KEY,
    CHECKIN_REMINDER_SETTINGS_KEY,
    CheckinReminderService,
    ReminderServiceSettings,
)


def _build_service(
    db_path: Path,
    *,
    smtp_host: str = "smtp.gmail.com",
    smtp_user: str = "sender@example.com",
    smtp_pass: str = "smtp-pass",
    recipient_email: str = "recipient@example.com",
    now_fn: Callable[[], datetime],
    send_email_fn: Callable[[str], None] | None,
) -> CheckinReminderService:
    return CheckinReminderService(
        ReminderServiceSettings(
            db_path=str(db_path),
            smtp_host=smtp_host,
            smtp_port=587,
            smtp_user=smtp_user,
            smtp_pass=smtp_pass,
            recipient_email=recipient_email,
        ),
        now_fn=now_fn,
        send_email_fn=send_email_fn,
    )


def test_enabled_after_cutoff_without_checkin_sends_once(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    sent_hours: list[str] = []
    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 22, 45),
        send_email_fn=sent_hours.append,
    )

    service.run_once()

    assert sent_hours == ["22:45"]
    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        last_sent = get_setting_json(connection, CHECKIN_REMINDER_LAST_SENT_KEY)
        assert last_sent == "2026-02-21"
    finally:
        connection.close()


def test_enabled_after_cutoff_with_checkin_does_not_send(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        upsert_checkin_entry(
            connection,
            checkin_date="2026-02-21",
            answers={"energy": 8},
        )
    finally:
        connection.close()

    sent_hours: list[str] = []
    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 22, 45),
        send_email_fn=sent_hours.append,
    )
    service.run_once()

    assert sent_hours == []


def test_enabled_before_cutoff_does_not_send(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    sent_hours: list[str] = []
    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 21, 0),
        send_email_fn=sent_hours.append,
    )
    service.run_once()

    assert sent_hours == []


def test_second_tick_same_day_does_not_duplicate_send(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    current_times = iter([datetime(2026, 2, 21, 22, 31), datetime(2026, 2, 21, 23, 10)])
    sent_hours: list[str] = []
    service = _build_service(
        db_path,
        now_fn=lambda: next(current_times),
        send_email_fn=sent_hours.append,
    )

    service.run_once()
    service.run_once()

    assert sent_hours == ["22:31"]


def test_next_day_after_cutoff_sends_again(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    current_times = iter([datetime(2026, 2, 21, 22, 31), datetime(2026, 2, 22, 22, 32)])
    sent_hours: list[str] = []
    service = _build_service(
        db_path,
        now_fn=lambda: next(current_times),
        send_email_fn=sent_hours.append,
    )

    service.run_once()
    service.run_once()

    assert sent_hours == ["22:31", "22:32"]


def test_send_failure_does_not_write_last_sent(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"

    def fail_send(_hour: str) -> None:
        raise RuntimeError("smtp failure")

    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 22, 31),
        send_email_fn=fail_send,
    )

    service.run_once()

    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        last_sent = get_setting_json(connection, CHECKIN_REMINDER_LAST_SENT_KEY)
        assert last_sent is None
    finally:
        connection.close()


def test_disabled_setting_does_not_send(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        upsert_setting_json(
            connection,
            CHECKIN_REMINDER_SETTINGS_KEY,
            {"enabled": False, "notifyAfter": "22:30"},
        )
        connection.commit()
    finally:
        connection.close()

    sent_hours: list[str] = []
    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 23, 0),
        send_email_fn=sent_hours.append,
    )
    service.run_once()

    assert sent_hours == []


def test_missing_smtp_config_skips_send_without_log_spam(
    tmp_path: Path, caplog
) -> None:
    db_path = tmp_path / "garmin.db"
    service = _build_service(
        db_path,
        smtp_host="",
        smtp_user="",
        smtp_pass="",
        now_fn=lambda: datetime(2026, 2, 21, 23, 0),
        send_email_fn=None,
    )

    with caplog.at_level(logging.WARNING):
        service.run_once()
        service.run_once()

    warning_records = [
        record
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "Check-in reminders are enabled but email cannot be sent" in record.message
    ]
    assert len(warning_records) == 1

    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        last_sent = get_setting_json(connection, CHECKIN_REMINDER_LAST_SENT_KEY)
        assert last_sent is None
    finally:
        connection.close()
