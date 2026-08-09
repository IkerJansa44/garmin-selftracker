from __future__ import annotations

from datetime import date, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any

import pytest

from src.correlation_notifications import (
    CorrelationEmailSettings,
    MeaningfulCorrelation,
    _build_correlation_pairs,
    _build_email_body,
    _build_email_html,
    _load_recent_analysis_values,
    _pearson,
    _pearson_p_value,
    current_meaningful_correlation_keys,
    notify_new_meaningful_correlations,
)
from src.db import connect_db, get_setting_json, init_db
from src.notifications import PushNotification, save_notification_preferences


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


def _analysis_value(
    *, role: str, feature_key: str, analysis_date: str, value: float
) -> dict[str, Any]:
    return {
        "role": role,
        "featureKey": feature_key,
        "analysisDate": analysis_date,
        "valueNum": value,
        "valueText": None,
        "valueBool": None,
    }


def test_current_meaningful_correlation_keys_detects_numeric_pairs(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    _insert_correlated_metrics(db_path)

    keys = current_meaningful_correlation_keys(str(db_path))

    assert "garmin:steps__metric:restingHr" in keys


def test_materialized_values_produce_previous_day_correlation(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    steps = [
        8,
        1,
        14,
        3,
        11,
        5,
        16,
        2,
        13,
        7,
        18,
        4,
        10,
        6,
        15,
        9,
        20,
        12,
        17,
        19,
        22,
        21,
        24,
        23,
        26,
        25,
    ]
    start = date.today() - timedelta(days=len(steps) - 1)
    connection = connect_db(str(db_path))
    init_db(connection)
    for offset, step_value in enumerate(steps):
        resting_hr = None if offset == 0 else steps[offset - 1] * 2 + 40
        connection.execute(
            """
            INSERT INTO daily_metrics (
                metric_date, steps, resting_heart_rate, updated_at
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                (start + timedelta(days=offset)).isoformat(),
                step_value,
                resting_hr,
                "2026-02-21T06:00:00+00:00",
            ),
        )
    connection.commit()
    connection.close()

    values = _load_recent_analysis_values(str(db_path))
    pairs = _build_correlation_pairs(values, {}, {})
    pair = next(item for item in pairs if item.key == "garmin:steps__metric:restingHr")

    assert pair.sample_count == len(steps) - 1
    assert pair.correlation == 1.0


def test_question_analysis_mode_limits_correlation_roles() -> None:
    dates = [f"2026-01-{day:02d}" for day in range(1, 6)]
    values: list[dict[str, Any]] = []
    for index, analysis_date in enumerate(dates, start=1):
        for role in ("predictor", "target"):
            values.extend(
                [
                    _analysis_value(
                        role=role,
                        feature_key="question:caffeine",
                        analysis_date=analysis_date,
                        value=float(index),
                    ),
                    _analysis_value(
                        role=role,
                        feature_key="question:energy",
                        analysis_date=analysis_date,
                        value=float(index * 2),
                    ),
                ]
            )
    questions = {
        "caffeine": {
            "inputType": "slider",
        },
        "energy": {"inputType": "slider", "analysisMode": "target_same_day"},
    }

    pairs = _build_correlation_pairs(values, {}, questions)

    assert {pair.key for pair in pairs} == {"question:caffeine__question:energy"}


def test_pearson_matches_reference_values_and_rejects_constant_series() -> None:
    xs = [43, 21, 25, 42, 57, 59]
    ys = [99, 65, 79, 75, 87, 81]

    assert _pearson(xs, ys) == pytest.approx(0.5298089018901744)
    assert _pearson(xs, [-value for value in xs]) == pytest.approx(-1.0)
    assert _pearson([1, 1, 1], [1, 2, 3]) is None
    assert _pearson_p_value(_pearson(xs, ys), len(xs)) == pytest.approx(
        0.306922352670643
    )


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


def test_notify_new_meaningful_correlations_uses_iphone_preference(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "garmin.db"
    _insert_correlated_metrics(db_path)
    save_notification_preferences(str(db_path), {"email": False, "iphone": True})
    sent_pushes: list[PushNotification] = []

    def send_push(notification: PushNotification) -> int:
        sent_pushes.append(notification)
        return 1

    settings = CorrelationEmailSettings(
        db_path=str(db_path),
        smtp_host="",
        smtp_port=587,
        smtp_user="",
        smtp_pass="",
        recipient_email="",
        dashboard_url="http://dashboard",
        send_push_fn=send_push,
    )

    correlations = notify_new_meaningful_correlations(settings, previous_keys=set())

    assert correlations
    assert len(sent_pushes) == 1
    assert sent_pushes[0].title == "New meaningful Garmin correlation"
    assert "Resting HR" in sent_pushes[0].body
    assert "view=lab" in sent_pushes[0].url


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
