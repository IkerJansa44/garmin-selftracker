from __future__ import annotations

import logging
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Callable

import pytest

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
    CHECKIN_REMINDER_THREAD_KEY,
    MAX_MESSAGES_PER_THREAD,
    CheckinReminderService,
    ReminderServiceSettings,
    build_checkin_reminder_email_body,
)

TEST_DASHBOARD_URL = "http://dashboard.test"


def _record_smtp_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> list[EmailMessage]:
    sent_messages: list[EmailMessage] = []

    class FakeSmtp:
        def __init__(self, **_: object) -> None:
            pass

        def __enter__(self) -> "FakeSmtp":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def starttls(self) -> None:
            pass

        def login(self, _: str, __: str) -> None:
            pass

        def send_message(self, message: EmailMessage) -> None:
            sent_messages.append(message)

    monkeypatch.setattr("src.reminders.smtplib.SMTP", FakeSmtp)
    return sent_messages


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
            dashboard_url=TEST_DASHBOARD_URL,
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


def test_custom_email_body_is_sent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        upsert_setting_json(
            connection,
            CHECKIN_REMINDER_SETTINGS_KEY,
            {
                "enabled": True,
                "notifyAfter": "22:30",
                "emailBody": "Custom reminder body",
            },
        )
        connection.commit()
    finally:
        connection.close()

    sent_messages = _record_smtp_messages(monkeypatch)
    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 22, 45),
        send_email_fn=None,
    )

    service.run_once()

    assert len(sent_messages) == 1
    assert sent_messages[0].get_content() == "Custom reminder body\n"


def test_reminder_emails_persist_and_reuse_thread_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "garmin.db"
    sent_messages = _record_smtp_messages(monkeypatch)
    current_times = iter([datetime(2026, 2, 21, 22, 45), datetime(2026, 2, 22, 22, 45)])
    service = _build_service(
        db_path,
        now_fn=lambda: next(current_times),
        send_email_fn=None,
    )

    service.run_once()
    service.run_once()

    root_message_id = sent_messages[0]["Message-ID"]
    assert root_message_id
    assert sent_messages[0]["In-Reply-To"] is None
    assert sent_messages[0]["References"] is None
    assert sent_messages[1]["Message-ID"] != root_message_id
    assert sent_messages[1]["In-Reply-To"] == root_message_id
    assert sent_messages[1]["References"] == root_message_id

    connection = connect_db(str(db_path))
    try:
        thread_state = get_setting_json(connection, CHECKIN_REMINDER_THREAD_KEY)
        assert thread_state == {
            "rootMessageId": root_message_id,
            "messageCount": 2,
        }
    finally:
        connection.close()


def test_reminder_email_starts_new_thread_after_gmail_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "garmin.db"
    connection = connect_db(str(db_path))
    try:
        init_db(connection)
        upsert_setting_json(
            connection,
            CHECKIN_REMINDER_THREAD_KEY,
            {
                "rootMessageId": "<previous-root@example.com>",
                "messageCount": MAX_MESSAGES_PER_THREAD,
            },
        )
        connection.commit()
    finally:
        connection.close()

    sent_messages = _record_smtp_messages(monkeypatch)
    service = _build_service(
        db_path,
        now_fn=lambda: datetime(2026, 2, 21, 22, 45),
        send_email_fn=None,
    )

    service.run_once()

    new_root_message_id = sent_messages[0]["Message-ID"]
    assert new_root_message_id != "<previous-root@example.com>"
    assert sent_messages[0]["In-Reply-To"] is None
    assert sent_messages[0]["References"] is None

    connection = connect_db(str(db_path))
    try:
        thread_state = get_setting_json(connection, CHECKIN_REMINDER_THREAD_KEY)
        assert thread_state == {
            "rootMessageId": new_root_message_id,
            "messageCount": 1,
        }
    finally:
        connection.close()


def test_build_checkin_reminder_email_body_includes_dashboard_url() -> None:
    body = build_checkin_reminder_email_body(
        "22:45",
        TEST_DASHBOARD_URL,
    )

    assert "22:45" in body
    assert TEST_DASHBOARD_URL in body
