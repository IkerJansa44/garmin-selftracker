from __future__ import annotations

from datetime import date, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from src.correlation_notifications import (
    CorrelationEmailSettings,
    current_meaningful_correlation_keys,
    notify_new_meaningful_correlations,
)
from src.db import connect_db, get_setting_json, init_db


class FakeSmtp:
    sent_messages: list[EmailMessage] = []

    def __init__(self, *, host: str, port: int, timeout: int) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def __enter__(self) -> FakeSmtp:
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def starttls(self) -> None:
        return None

    def login(self, user: str, password: str) -> None:
        return None

    def send_message(self, message: EmailMessage) -> None:
        self.sent_messages.append(message)


def _insert_correlated_metrics(db_path: Path, *, days: int = 26) -> None:
    start = date.today() - timedelta(days=days - 1)
    connection = connect_db(str(db_path))
    init_db(connection)
    for offset in range(days):
        value = offset + 1
        connection.execute(
            """
            INSERT INTO daily_metrics (
                metric_date,
                steps,
                resting_heart_rate,
                updated_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                (start + timedelta(days=offset)).isoformat(),
                value * 1000,
                value,
                "2026-02-21T06:00:00+00:00",
            ),
        )
    connection.commit()
    connection.close()


def test_current_meaningful_correlation_keys_detects_numeric_pairs(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    _insert_correlated_metrics(db_path)

    keys = current_meaningful_correlation_keys(str(db_path))

    assert "garmin:steps__metric:restingHr" in keys


def test_notify_new_meaningful_correlations_sends_only_new_keys(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    db_path = tmp_path / "garmin.db"
    _insert_correlated_metrics(db_path)
    FakeSmtp.sent_messages = []
    monkeypatch.setattr("src.correlation_notifications.smtplib.SMTP", FakeSmtp)

    settings = CorrelationEmailSettings(
        db_path=str(db_path),
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_user="sender@example.com",
        smtp_pass="smtp-pass",
        recipient_email="recipient@example.com",
        dashboard_url="http://dashboard",
    )
    new_correlations = notify_new_meaningful_correlations(
        settings,
        previous_keys=set(),
    )

    assert "garmin:steps__metric:restingHr" in {
        correlation.key for correlation in new_correlations
    }
    assert len(FakeSmtp.sent_messages) == 1
    message = FakeSmtp.sent_messages[0]
    assert message["Subject"] == "New meaningful Garmin correlation"
    assert "Steps -> Resting HR" in message.get_content()
    assert "http://dashboard" in message.get_content()

    connection = connect_db(str(db_path))
    try:
        notified = get_setting_json(connection, "notified_meaningful_correlations")
    finally:
        connection.close()
    assert "garmin:steps__metric:restingHr" in notified


def test_notify_new_meaningful_correlations_baselines_first_scan(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    db_path = tmp_path / "garmin.db"
    _insert_correlated_metrics(db_path)
    FakeSmtp.sent_messages = []
    monkeypatch.setattr("src.correlation_notifications.smtplib.SMTP", FakeSmtp)

    settings = CorrelationEmailSettings(
        db_path=str(db_path),
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_user="sender@example.com",
        smtp_pass="smtp-pass",
        recipient_email="recipient@example.com",
        dashboard_url="http://dashboard",
    )

    assert notify_new_meaningful_correlations(settings) == []
    assert FakeSmtp.sent_messages == []

    connection = connect_db(str(db_path))
    try:
        notified = get_setting_json(connection, "notified_meaningful_correlations")
    finally:
        connection.close()
    assert "garmin:steps__metric:restingHr" in notified
