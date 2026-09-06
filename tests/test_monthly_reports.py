from __future__ import annotations

import json
import re
import subprocess
from datetime import date, datetime, timezone
from pathlib import Path

import src.monthly_reports as monthly_reports
from src.db import connect_db, init_db, upsert_daily_metrics, upsert_setting_json
from src.monthly_report_codex import generate_editorial_analysis
from src.monthly_report_pdf import render_monthly_report
from src.monthly_reports import (
    build_monthly_snapshot,
    contiguous_ranges,
    MonthlyReportService,
    MonthlyReportServiceSettings,
    normalize_monthly_report_settings,
    parse_report_month,
)


def test_contiguous_ranges_groups_only_adjacent_days() -> None:
    assert contiguous_ranges(
        [date(2026, 8, 1), date(2026, 8, 2), date(2026, 8, 5)]
    ) == [
        (date(2026, 8, 1), date(2026, 8, 2)),
        (date(2026, 8, 5), date(2026, 8, 5)),
    ]


def test_monthly_report_settings_and_month_validation() -> None:
    assert normalize_monthly_report_settings(
        {"enabled": True, "sendDay": 2, "sendAfter": "07:30"}
    ) == {"enabled": True, "sendAfter": "07:30"}
    assert (
        normalize_monthly_report_settings({"enabled": True, "sendAfter": "tomorrow"})
        is None
    )
    assert parse_report_month("2026-08", today=date(2026, 8, 22)) == date(2026, 8, 1)


def test_automatic_report_targets_completed_previous_month(
    tmp_path: Path, monkeypatch
) -> None:
    settings = MonthlyReportServiceSettings(
        db_path=str(tmp_path / "report.db"),
        garmin_email="",
        garmin_password="",
        garmin_tokenstore="",
        smtp_host="",
        smtp_port=587,
        smtp_user="",
        smtp_pass="",
        recipient_email="",
        reports_dir=str(tmp_path),
    )
    generated: list[tuple[date, bool]] = []
    service = MonthlyReportService(
        settings,
        now_fn=lambda: datetime(2026, 9, 1, 8, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        monthly_reports,
        "load_monthly_report_settings",
        lambda _db_path: {"enabled": True, "sendAfter": "07:00"},
    )
    monkeypatch.setattr(
        monthly_reports, "_should_attempt_delivery", lambda *_args, **_kwargs: True
    )
    monkeypatch.setattr(
        service,
        "generate",
        lambda month, *, send_email=False: generated.append((month, send_email)),
    )

    service.run_once()

    assert generated == [(date(2026, 8, 1), True)]


def test_snapshot_uses_dashboard_metrics_and_prior_90_days(tmp_path: Path) -> None:
    db_path = str(tmp_path / "report.db")
    connection = connect_db(db_path)
    init_db(connection)
    upsert_setting_json(
        connection,
        "dashboard_plots",
        [
            {"key": "metric:sleepScore", "direction": "higher"},
            {"key": "garmin:steps", "direction": "higher"},
            {"key": "garmin:strengthVolume", "direction": "higher"},
            {"key": "garmin:hrToSpeedRatio", "direction": "lower"},
            {"key": "garmin:futureMetric", "direction": "higher"},
        ],
    )
    upsert_setting_json(
        connection,
        "checkin_questions",
        [
            {
                "id": "caffeine_count",
                "prompt": "Caffeine",
                "inputType": "slider",
            }
        ],
    )
    for metric_date, sleep_score, steps in (
        ("2026-05-31", 70, 8_000),
        ("2026-08-01", 80, 10_000),
        ("2026-08-02", 90, 12_000),
    ):
        upsert_daily_metrics(
            connection,
            {
                "metric_date": metric_date,
                "sleep_score": sleep_score,
                "steps": steps,
            },
        )
    connection.execute(
        "INSERT INTO checkin_entries VALUES (?, ?, ?, ?)",
        (
            "2026-08-01",
            '{"caffeine_count": 2}',
            "2026-08-01T20:00:00",
            "2026-08-01T20:00:00",
        ),
    )
    for activity_id, activity_date, activity_type, average_hr, raw_json in (
        (1, "2026-05-31", "running", 150, {"averageSpeed": 4.0}),
        (2, "2026-08-01", "running", 144, {"averageSpeed": 4.0}),
        (
            3,
            "2026-08-01",
            "strength_training",
            None,
            {"summarizedExerciseSets": [{"volume": 700000, "sets": 5, "reps": 25}]},
        ),
    ):
        connection.execute(
            """
            INSERT INTO activities (
                garmin_activity_id, activity_name, activity_type, start_time_local,
                average_hr, raw_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                activity_id,
                activity_type,
                activity_type,
                f"{activity_date} 08:00:00",
                average_hr,
                json.dumps(raw_json),
                "2026-08-02T08:00:00+00:00",
            ),
        )
    connection.commit()
    connection.close()

    snapshot = build_monthly_snapshot(
        db_path,
        date(2026, 8, 1),
        today=date(2026, 8, 2),
    )

    assert [metric["key"] for metric in snapshot["sections"]["sleep"]] == [
        "metric:sleepScore"
    ]
    assert [metric["key"] for metric in snapshot["sections"]["training"]] == [
        "garmin:steps",
        "garmin:strengthVolume",
        "garmin:hrToSpeedRatio",
        "garmin:futureMetric",
    ]
    assert snapshot["sections"]["sleep"][0]["current"] == 85
    assert snapshot["sections"]["sleep"][0]["baseline"] == 70
    assert snapshot["sections"]["training"][1]["current"] == 350
    assert snapshot["sections"]["training"][2]["current"] == 10
    assert snapshot["sections"]["training"][3]["current"] is None
    assert snapshot["coverage"]["checkinDays"] == 1
    assert snapshot["calendar"] == [
        {"date": "2026-08-01", "status": "training"},
        {"date": "2026-08-02", "status": "rest"},
    ]
    full_month = build_monthly_snapshot(
        db_path, date(2026, 8, 1), today=date(2026, 9, 1)
    )
    assert len(full_month["calendar"]) == 31
    assert full_month["calendar"][2] == {"date": "2026-08-03", "status": "missing"}


def test_codex_analysis_validates_json_and_falls_back(tmp_path: Path) -> None:
    fallback = {
        key: {
            "assessment": "insufficient_data",
            "recap": "Not enough data.",
            "wentWell": [],
            "needsAttention": [],
        }
        for key in ("sleep", "training", "selfReported")
    }

    def valid_runner(args: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        result_path = Path(args[args.index("--output-last-message") + 1])
        result_path.write_text(
            json.dumps(
                {
                    key: {
                        "assessment": "mixed",
                        "recap": "A concise supported recap.",
                        "wentWell": ["One improvement."],
                        "needsAttention": ["One decline."],
                    }
                    for key in ("sleep", "training", "selfReported")
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(args, 0, "", "")

    result = generate_editorial_analysis({}, fallback, runner=valid_runner)
    assert result.source == "codex"
    assert result.analysis["sleep"]["assessment"] == "mixed"

    failed = generate_editorial_analysis(
        {},
        fallback,
        runner=lambda *args, **kwargs: subprocess.CompletedProcess(
            args, 1, "", "failed"
        ),
    )
    assert failed.source == "deterministic"
    assert failed.analysis == fallback


def test_pdf_renderer_adds_pages_instead_of_dropping_metrics(tmp_path: Path) -> None:
    metric = {
        "key": "metric:sleepScore",
        "label": "Sleep score",
        "unit": "pts",
        "decimals": 0,
        "higherIsBetter": True,
        "current": 80.0,
        "baseline": 75.0,
        "delta": 5.0,
        "currentSamples": 20,
        "baselineSamples": 80,
    }
    analysis = {
        key: {
            "assessment": "improved",
            "recap": "The month improved against the preceding baseline.",
            "wentWell": ["The main signal improved."],
            "needsAttention": [],
        }
        for key in ("sleep", "training", "selfReported")
    }
    snapshot = {
        "reportMonth": "2026-08",
        "period": {"start": "2026-08-01", "end": "2026-08-22"},
        "baseline": {"start": "2026-05-03", "end": "2026-07-31", "days": 90},
        "coverage": {
            "importedDays": 22,
            "expectedDays": 22,
            "checkinDays": 20,
            "baselineCheckinDays": 80,
        },
        "sections": {
            "sleep": [metric],
            "training": [
                {**metric, "key": f"metric:training{index}"} for index in range(9)
            ],
            "selfReported": [metric],
        },
        "analysis": analysis,
        "analysisSource": "codex",
    }
    output = tmp_path / "report.pdf"

    render_monthly_report(snapshot, output)

    pdf_bytes = output.read_bytes()
    assert pdf_bytes.startswith(b"%PDF")
    assert len(re.findall(rb"/Type /Page\b", pdf_bytes)) == 5


def test_weekly_metrics_have_one_week_suffix() -> None:
    for key in (
        *(f"garmin:zone{zone}Minutes" for zone in range(6)),
        "garmin:zone2PlusMinutes",
        "garmin:runningKilometers",
        "garmin:isTrainingDay",
        "garmin:strengthVolume",
    ):
        metric = monthly_reports.METRICS[key]
        summary = monthly_reports._summarize_metric(
            key, metric, [], [], current_days=31, direction=None, reduce_method="sum"
        )
        assert summary["unit"] == f"{metric.unit}/wk"
        assert summary["unit"].count("/wk") == 1


def test_pdf_metric_values_and_units_fit_narrow_cards() -> None:
    from unittest.mock import Mock

    from reportlab.pdfbase.pdfmetrics import stringWidth

    from src.monthly_report_pdf import CONTENT_W, TRAIN, _metric_card

    width = (CONTENT_W - 27) / 4
    for unit, value in (
        ("min/wk", 128),
        ("km/wk", 11.5),
        ("kg/wk", 13239),
        ("bpm per km/h", 13.9),
        ("per answered day", 2.5),
        ("steps", 123456789),
    ):
        pdf = Mock()
        _metric_card(
            pdf,
            0,
            0,
            width,
            92,
            {
                "label": "Example metric",
                "current": value,
                "unit": unit,
                "decimals": 1,
                "delta": 0.5,
                "higherIsBetter": True,
                "currentSamples": 31,
                "baselineSamples": 90,
            },
            TRAIN,
        )
        drawn = []
        for call in pdf.method_calls:
            if call[0] == "setFont":
                font, size = call.args
            elif call[0] == "drawString":
                x, _, text = call.args
                assert x + stringWidth(text, font, size) <= width - 12 + 1e-6
                drawn.append(text)
        assert unit in drawn
        assert f"{value:,.1f}" in drawn


def test_highlights_balance_sections_and_exclude_sparse_or_rounded_changes() -> None:
    from src.monthly_report_pdf import _standout_metrics

    metric = dict(
        current=10,
        baseline=5,
        delta=5,
        decimals=0,
        unit="min",
        currentSamples=20,
        baselineSamples=60,
    )
    sparse = dict(metric, delta=1000, currentSamples=2)
    unchanged = dict(metric, delta=0.01)
    snapshot = {
        "sections": {
            "sleep": [sparse, unchanged, metric],
            "training": [dict(metric, delta=1), metric],
            "selfReported": [sparse, unchanged],
        }
    }
    assert _standout_metrics(snapshot) == [("sleep", metric), ("training", metric)]


def test_calendar_renders_six_week_month_and_distinguishes_unknown_days() -> None:
    from unittest.mock import Mock

    from src.monthly_report_pdf import _calendar_card

    pdf = Mock()
    _calendar_card(
        pdf,
        {
            "reportMonth": "2026-08",
            "period": {"end": "2026-08-30"},
            "calendar": [
                {"date": "2026-08-01", "status": "training"},
                {"date": "2026-08-02", "status": "rest"},
            ],
        },
    )
    dates = [
        call.args[2] for call in pdf.drawString.call_args_list if call.args[2].isdigit()
    ]
    assert dates == [str(day) for day in range(1, 32)]
    assert (
        pdf.drawRightString.call_count == 28
    )  # Unknown Aug 3-30; Aug 31 is outside period.
