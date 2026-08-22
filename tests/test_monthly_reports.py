from __future__ import annotations

import json
import subprocess
from datetime import date
from pathlib import Path

from src.db import connect_db, init_db, upsert_daily_metrics, upsert_setting_json
from src.monthly_report_codex import generate_editorial_analysis
from src.monthly_report_pdf import render_monthly_report
from src.monthly_reports import (
    build_monthly_snapshot,
    contiguous_ranges,
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
    ) == {"enabled": True, "sendDay": 2, "sendAfter": "07:30"}
    assert (
        normalize_monthly_report_settings(
            {"enabled": True, "sendDay": 29, "sendAfter": "07:30"}
        )
        is None
    )
    assert parse_report_month("2026-08", today=date(2026, 8, 22)) == date(2026, 8, 1)


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
        "garmin:steps"
    ]
    assert snapshot["sections"]["sleep"][0]["current"] == 85
    assert snapshot["sections"]["sleep"][0]["baseline"] == 70
    assert snapshot["coverage"]["checkinDays"] == 1


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


def test_pdf_renderer_creates_four_page_document(tmp_path: Path) -> None:
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
        "sections": {"sleep": [metric], "training": [metric], "selfReported": [metric]},
        "analysis": analysis,
        "analysisSource": "codex",
    }
    output = tmp_path / "report.pdf"

    render_monthly_report(snapshot, output)

    assert output.read_bytes().startswith(b"%PDF")
