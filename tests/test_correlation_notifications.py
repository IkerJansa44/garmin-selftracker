from __future__ import annotations

from datetime import date, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from src.correlation_notifications import (
    CorrelationEmailSettings,
    MeaningfulCorrelation,
    _build_email_body,
    _build_email_html,
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
    text_body = message.get_body(("plain",)).get_content()
    html_body = message.get_body(("html",)).get_content()
    assert message["Subject"] == "New meaningful Garmin correlation"
    assert "When Steps is higher, Resting HR tends to be higher too." in text_body
    assert (
        "View scatterplot: "
        "http://dashboard?view=lab&predictor=garmin%3Asteps&outcome=metric%3ArestingHr"
    ) in text_body
    assert 'href="http://dashboard?view=lab&amp;predictor=garmin%3Asteps' in html_body
    assert "View scatterplot" in html_body
    assert "http://dashboard" in text_body

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


def test_build_email_body_describes_negative_correlations_with_scatterplot_link() -> (
    None
):
    body = _build_email_body(
        [
            MeaningfulCorrelation(
                key="question:caffeine__metric:sleepScore",
                predictor="question:caffeine",
                outcome="metric:sleepScore",
                predictor_label="Caffeine",
                outcome_label="Sleep Score",
                sample_count=42,
                correlation=-0.41,
                p_value=0.001,
                q_value=0.004,
            )
        ],
        "http://dashboard.local/app?range=365",
    )

    assert (
        "When Caffeine is higher, Sleep Score tends to be lower. "
        "(r=-0.41, q=0.004, N=42)"
    ) in body
    assert (
        "View scatterplot: "
        "http://dashboard.local/app?range=365&view=lab&"
        "predictor=question%3Acaffeine&outcome=metric%3AsleepScore"
    ) in body


def test_build_email_body_uses_yes_for_binary_predictors() -> None:
    body = _build_email_body(
        [
            MeaningfulCorrelation(
                key="question:read_night__metric:avgHr1hBeforeSleep",
                predictor="question:read_night",
                outcome="metric:avgHr1hBeforeSleep",
                predictor_label="Read at night?",
                outcome_label="Avg HR 1h Before Sleep",
                sample_count=57,
                correlation=-0.39,
                p_value=0.01,
                q_value=0.046,
                predictor_kind="binary",
                predictor_positive_label="Yes",
            )
        ],
        "http://dashboard.local",
    )

    assert (
        "When Read at night? is Yes, Avg HR 1h Before Sleep tends to be lower." in body
    )


def test_build_email_body_uses_later_earlier_for_time_predictors() -> None:
    body = _build_email_body(
        [
            MeaningfulCorrelation(
                key="question:sleep_time__metric:sleepScore",
                predictor="question:sleep_time",
                outcome="metric:sleepScore",
                predictor_label="Sleep time",
                outcome_label="Sleep Score",
                sample_count=35,
                correlation=-0.5,
                p_value=0.001,
                q_value=0.01,
                predictor_kind="time",
            )
        ],
        "",
    )

    assert "When Sleep time is later, Sleep Score tends to be lower." in body


def test_build_email_html_uses_named_links() -> None:
    html = _build_email_html(
        [
            MeaningfulCorrelation(
                key="question:caffeine__metric:sleepScore",
                predictor="question:caffeine",
                outcome="metric:sleepScore",
                predictor_label="Caffeine",
                outcome_label="Sleep Score",
                sample_count=42,
                correlation=-0.41,
                p_value=0.001,
                q_value=0.004,
            )
        ],
        "http://dashboard.local/app?range=365",
    )

    assert ">View scatterplot</a>" in html
    assert ">Open dashboard</a>" in html
    assert "View scatterplot: http://" not in html
