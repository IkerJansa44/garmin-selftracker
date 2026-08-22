from __future__ import annotations

import calendar
import json
import logging
import math
import smtplib
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from statistics import mean
from typing import Any, Callable

from src.db import (
    build_sleep_consistency_by_source_date,
    build_time_to_sleep_gap_by_metric_date,
    connect_db,
    get_setting_json,
    init_db,
    upsert_setting_json,
    utc_now,
)
from src.derived_metrics import TIME_TO_SLEEP_GAP_METRICS
from src.monthly_report_codex import CodexResult, generate_editorial_analysis
from src.sync import run_sync

logger = logging.getLogger(__name__)

MONTHLY_REPORT_SETTINGS_KEY = "monthly_report"
DASHBOARD_PLOTS_SETTINGS_KEY = "dashboard_plots"
QUESTION_SETTINGS_KEY = "checkin_questions"
DEFAULT_MONTHLY_REPORT_SETTINGS = {
    "enabled": False,
    "sendDay": 1,
    "sendAfter": "07:00",
}
SLEEP_KEYS = {
    "metric:restingHr",
    "metric:deepSleepPercentage",
    "metric:remSleepPercentage",
    "metric:remOrDeepSleepPercentage",
    "metric:avgOvernightHrv",
    "metric:sleepScore",
    "garmin:sleepSeconds",
    "garmin:avgHr1hBeforeSleep",
    "garmin:sleepConsistency",
    "garmin:mealToSleepGapMinutes",
    "garmin:caffeineToSleepGapMinutes",
}
DEFAULT_PLOTS = [
    {"key": "metric:recoveryIndex", "direction": "higher"},
    {"key": "metric:restingHr", "direction": "lower"},
    {"key": "metric:stress", "direction": "lower"},
    {"key": "metric:bodyBattery", "direction": "higher"},
    {"key": "metric:trainingReadiness", "direction": "higher"},
    {"key": "garmin:vo2Max", "direction": "higher"},
]


@dataclass(frozen=True)
class MonthlyReportServiceSettings:
    db_path: str
    garmin_email: str
    garmin_password: str
    garmin_tokenstore: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_pass: str
    recipient_email: str
    reports_dir: str
    codex_timeout_seconds: int = 120


@dataclass(frozen=True)
class MetricDefinition:
    label: str
    unit: str
    decimals: int
    higher_is_better: bool
    getter: Callable[[dict[str, Any]], float | None]
    reduce: str = "mean"


def _number(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _recovery(row: dict[str, Any]) -> float | None:
    resting_hr = _number(row, "resting_heart_rate")
    stress = _number(row, "stress_avg")
    if resting_hr is None or stress is None:
        return None
    sleep = _number(row, "sleep_seconds")
    sleep_term = (
        0.0
        if sleep is None
        else (min(100, max(40, 50 + (sleep / 3600 - 4) * 10)) - 70) * 0.3
    )
    return min(120, max(20, 95 - resting_hr - stress * 0.6 + sleep_term))


def _readiness(row: dict[str, Any]) -> float | None:
    values: list[tuple[float, float]] = []
    battery = _number(row, "body_battery")
    sleep = _number(row, "sleep_seconds")
    stress = _number(row, "stress_avg")
    if battery is not None:
        values.append((battery, 0.45))
    if sleep is not None:
        values.append((min(100, max(40, 50 + (sleep / 3600 - 4) * 10)), 0.35))
    if stress is not None:
        values.append((100 - stress, 0.2))
    return (
        sum(value * weight for value, weight in values)
        / sum(weight for _, weight in values)
        if values
        else None
    )


def _zones(row: dict[str, Any]) -> float | None:
    values = [_number(row, f"zone{zone}_minutes") for zone in range(2, 6)]
    return (
        sum(value or 0 for value in values)
        if any(value is not None for value in values)
        else None
    )


METRICS: dict[str, MetricDefinition] = {
    "metric:recoveryIndex": MetricDefinition(
        "Recovery index", "pts", 0, True, _recovery
    ),
    "metric:restingHr": MetricDefinition(
        "Resting HR", "bpm", 0, False, lambda row: _number(row, "resting_heart_rate")
    ),
    "metric:stress": MetricDefinition(
        "Stress", "pts", 0, False, lambda row: _number(row, "stress_avg")
    ),
    "metric:bodyBattery": MetricDefinition(
        "Body battery", "%", 0, True, lambda row: _number(row, "body_battery")
    ),
    "metric:trainingReadiness": MetricDefinition(
        "Training readiness", "pts", 0, True, _readiness
    ),
    "metric:deepSleepPercentage": MetricDefinition(
        "Deep sleep", "%", 1, True, lambda row: _number(row, "deep_sleep_percentage")
    ),
    "metric:remSleepPercentage": MetricDefinition(
        "REM sleep", "%", 1, True, lambda row: _number(row, "rem_sleep_percentage")
    ),
    "metric:remOrDeepSleepPercentage": MetricDefinition(
        "REM + deep sleep",
        "%",
        1,
        True,
        lambda row: _number(row, "rem_or_deep_sleep_percentage"),
    ),
    "metric:avgOvernightHrv": MetricDefinition(
        "Overnight HRV", "ms", 0, True, lambda row: _number(row, "avg_overnight_hrv")
    ),
    "metric:sleepScore": MetricDefinition(
        "Sleep score", "pts", 0, True, lambda row: _number(row, "sleep_score")
    ),
    "garmin:steps": MetricDefinition(
        "Daily steps", "steps", 0, True, lambda row: _number(row, "steps")
    ),
    "garmin:calories": MetricDefinition(
        "Calories", "kcal", 0, True, lambda row: _number(row, "calories")
    ),
    "garmin:sleepSeconds": MetricDefinition(
        "Sleep duration",
        "h",
        1,
        True,
        lambda row: (
            (_number(row, "sleep_seconds") or 0) / 3600
            if _number(row, "sleep_seconds") is not None
            else None
        ),
    ),
    "garmin:vo2Max": MetricDefinition(
        "VO2 max", "ml/kg/min", 1, True, lambda row: _number(row, "vo2max")
    ),
    "garmin:avgHr1hBeforeSleep": MetricDefinition(
        "HR before sleep",
        "bpm",
        0,
        False,
        lambda row: _number(row, "avg_hr_1h_before_sleep"),
    ),
    "garmin:sleepConsistency": MetricDefinition(
        "Sleep timing variability",
        "min",
        0,
        False,
        lambda row: _number(row, "sleep_consistency"),
    ),
    "garmin:mealToSleepGapMinutes": MetricDefinition(
        "Meal to sleep",
        "min",
        0,
        True,
        lambda row: _number(row, "mealToSleepGapMinutes"),
    ),
    "garmin:caffeineToSleepGapMinutes": MetricDefinition(
        "Caffeine to sleep",
        "min",
        0,
        True,
        lambda row: _number(row, "caffeineToSleepGapMinutes"),
    ),
    "garmin:zone0Minutes": MetricDefinition(
        "Zone 0", "min/wk", 0, True, lambda row: _number(row, "zone0_minutes"), "weekly"
    ),
    "garmin:zone1Minutes": MetricDefinition(
        "Zone 1", "min/wk", 0, True, lambda row: _number(row, "zone1_minutes"), "weekly"
    ),
    "garmin:zone2Minutes": MetricDefinition(
        "Zone 2", "min/wk", 0, True, lambda row: _number(row, "zone2_minutes"), "weekly"
    ),
    "garmin:zone3Minutes": MetricDefinition(
        "Zone 3", "min/wk", 0, True, lambda row: _number(row, "zone3_minutes"), "weekly"
    ),
    "garmin:zone4Minutes": MetricDefinition(
        "Zone 4", "min/wk", 0, True, lambda row: _number(row, "zone4_minutes"), "weekly"
    ),
    "garmin:zone5Minutes": MetricDefinition(
        "Zone 5", "min/wk", 0, True, lambda row: _number(row, "zone5_minutes"), "weekly"
    ),
    "garmin:zone2PlusMinutes": MetricDefinition(
        "Zone 2+", "min/wk", 0, True, _zones, "weekly"
    ),
    "garmin:runningKilometers": MetricDefinition(
        "Running", "km/wk", 1, True, lambda row: _number(row, "running_km"), "weekly"
    ),
    "garmin:isTrainingDay": MetricDefinition(
        "Training days",
        "days/wk",
        1,
        True,
        lambda row: _number(row, "is_training_day"),
        "weekly",
    ),
}


def normalize_monthly_report_settings(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict) or not isinstance(payload.get("enabled"), bool):
        return None
    send_day = payload.get("sendDay")
    send_after = payload.get("sendAfter")
    if (
        not isinstance(send_day, int)
        or isinstance(send_day, bool)
        or not 1 <= send_day <= 28
    ):
        return None
    if not isinstance(send_after, str):
        return None
    try:
        datetime.strptime(send_after, "%H:%M")
    except ValueError:
        return None
    return {"enabled": payload["enabled"], "sendDay": send_day, "sendAfter": send_after}


def load_monthly_report_settings(db_path: str) -> dict[str, Any]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        normalized = normalize_monthly_report_settings(
            get_setting_json(connection, MONTHLY_REPORT_SETTINGS_KEY)
        )
        return normalized or dict(DEFAULT_MONTHLY_REPORT_SETTINGS)
    finally:
        connection.close()


def save_monthly_report_settings(db_path: str, payload: Any) -> dict[str, Any]:
    normalized = normalize_monthly_report_settings(payload)
    if normalized is None:
        raise ValueError("Invalid monthly report settings payload")
    connection = connect_db(db_path)
    try:
        init_db(connection)
        upsert_setting_json(connection, MONTHLY_REPORT_SETTINGS_KEY, normalized)
        connection.commit()
        return normalized
    finally:
        connection.close()


def parse_report_month(raw: Any, *, today: date | None = None) -> date:
    current = today or date.today()
    if raw is None:
        return current.replace(day=1)
    if not isinstance(raw, str):
        raise ValueError("month must be YYYY-MM")
    try:
        month = date.fromisoformat(f"{raw}-01")
    except ValueError as exc:
        raise ValueError("month must be YYYY-MM") from exc
    if month > current.replace(day=1):
        raise ValueError("month cannot be in the future")
    return month


def month_period(month: date, *, today: date | None = None) -> tuple[date, date]:
    current = today or date.today()
    last_day = date(
        month.year, month.month, calendar.monthrange(month.year, month.month)[1]
    )
    return month, min(last_day, current)


def _date_range(start: date, end: date) -> list[date]:
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def missing_report_dates(db_path: str, start: date, end: date) -> list[date]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        present = {
            date.fromisoformat(str(row["metric_date"]))
            for row in connection.execute(
                "SELECT metric_date FROM daily_metrics WHERE metric_date BETWEEN ? AND ?",
                (start.isoformat(), end.isoformat()),
            )
        }
    finally:
        connection.close()
    return [day for day in _date_range(start, end) if day not in present]


def contiguous_ranges(days: list[date]) -> list[tuple[date, date]]:
    if not days:
        return []
    ranges: list[tuple[date, date]] = []
    start = previous = days[0]
    for current in days[1:]:
        if current != previous + timedelta(days=1):
            ranges.append((start, previous))
            start = current
        previous = current
    return [*ranges, (start, previous)]


def import_missing_report_dates(
    settings: MonthlyReportServiceSettings, start: date, end: date
) -> list[str]:
    warnings: list[str] = []
    for range_start, range_end in contiguous_ranges(
        missing_report_dates(settings.db_path, start, end)
    ):
        try:
            result = run_sync(
                db_path=settings.db_path,
                garmin_email=settings.garmin_email,
                garmin_password=settings.garmin_password,
                garmin_tokenstore=settings.garmin_tokenstore,
                start_date=range_start,
                end_date=range_end,
            )
            if result.status == "failed":
                warnings.append(f"Import failed for {range_start} to {range_end}")
        except Exception as exc:  # pragma: no cover - external service guard
            logger.exception("Monthly report catch-up import failed")
            warnings.append(f"Import failed for {range_start} to {range_end}: {exc}")
    return warnings


def build_monthly_snapshot(
    db_path: str, month: date, *, today: date | None = None
) -> dict[str, Any]:
    report_start, report_end = month_period(month, today=today)
    baseline_end = report_start - timedelta(days=1)
    baseline_start = baseline_end - timedelta(days=89)
    connection = connect_db(db_path)
    try:
        init_db(connection)
        all_rows = _load_metric_rows(
            connection, baseline_start - timedelta(days=7), report_end
        )
        sleep_consistency = build_sleep_consistency_by_source_date(all_rows)
        gaps = {
            metric.dashboard_key: build_time_to_sleep_gap_by_metric_date(
                connection,
                all_rows,
                (baseline_start - timedelta(days=7)).isoformat(),
                report_end.isoformat(),
                metric,
            )
            for metric in TIME_TO_SLEEP_GAP_METRICS
        }
        for row in all_rows:
            metric_date = str(row["metric_date"])
            row["sleep_consistency"] = sleep_consistency.get(metric_date)
            for dashboard_key, values in gaps.items():
                row[dashboard_key] = values.get(metric_date)
        rows = [
            row for row in all_rows if row["metric_date"] >= baseline_start.isoformat()
        ]
        plot_settings = get_setting_json(connection, DASHBOARD_PLOTS_SETTINGS_KEY)
        plots = plot_settings if isinstance(plot_settings, list) else DEFAULT_PLOTS
        current_rows = [
            row
            for row in rows
            if report_start.isoformat() <= row["metric_date"] <= report_end.isoformat()
        ]
        baseline_rows = [
            row
            for row in rows
            if baseline_start.isoformat()
            <= row["metric_date"]
            <= baseline_end.isoformat()
        ]
        sleep, training = [], []
        for plot in plots:
            key = plot.get("key") if isinstance(plot, dict) else plot
            if (
                not isinstance(key, str)
                or key.startswith("question:")
                or key not in METRICS
            ):
                continue
            metric = _summarize_metric(
                key,
                METRICS[key],
                current_rows,
                baseline_rows,
                current_days=(report_end - report_start).days + 1,
            )
            (sleep if key in SLEEP_KEYS else training).append(metric)
        self_reported, current_checkins, baseline_checkins = _self_reported(
            connection, report_start, report_end, baseline_start, baseline_end
        )
    finally:
        connection.close()
    expected_days = (report_end - report_start).days + 1
    imported_days = len({row["metric_date"] for row in current_rows})
    snapshot = {
        "reportMonth": month.strftime("%Y-%m"),
        "period": {"start": report_start.isoformat(), "end": report_end.isoformat()},
        "baseline": {
            "start": baseline_start.isoformat(),
            "end": baseline_end.isoformat(),
            "days": 90,
        },
        "coverage": {
            "importedDays": imported_days,
            "expectedDays": expected_days,
            "checkinDays": current_checkins,
            "baselineCheckinDays": baseline_checkins,
        },
        "sections": {
            "sleep": sleep,
            "training": training,
            "selfReported": self_reported,
        },
    }
    snapshot["fallbackAnalysis"] = deterministic_analysis(snapshot)
    return snapshot


def _load_metric_rows(connection: Any, start: date, end: date) -> list[dict[str, Any]]:
    rows = [
        dict(row)
        for row in connection.execute(
            """
        SELECT d.*, COALESCE(r.running_meters, 0) / 1000.0 AS running_km,
               CASE WHEN a.activity_count > 0 THEN 1 ELSE 0 END AS is_training_day
        FROM daily_metrics d
        LEFT JOIN (
            SELECT substr(start_time_local, 1, 10) activity_date,
                   SUM(COALESCE(distance_meters, 0)) running_meters
            FROM activities
            WHERE lower(COALESCE(activity_type, activity_name, '')) LIKE '%running%'
            GROUP BY 1
        ) r ON r.activity_date = d.metric_date
        LEFT JOIN (
            SELECT substr(start_time_local, 1, 10) activity_date, COUNT(*) activity_count
            FROM activities GROUP BY 1
        ) a ON a.activity_date = d.metric_date
        WHERE d.metric_date BETWEEN ? AND ? ORDER BY d.metric_date
        """,
            (start.isoformat(), end.isoformat()),
        )
    ]
    return rows


def _aggregate(
    rows: list[dict[str, Any]], metric: MetricDefinition, *, calendar_days: int
) -> tuple[float | None, int]:
    values = [value for row in rows if (value := metric.getter(row)) is not None]
    if not values:
        return None, 0
    if metric.reduce == "weekly":
        return sum(values) / max(1, calendar_days) * 7, len(values)
    return mean(values), len(values)


def _summarize_metric(
    key: str,
    metric: MetricDefinition,
    current: list[dict[str, Any]],
    baseline: list[dict[str, Any]],
    *,
    current_days: int,
) -> dict[str, Any]:
    current_value, current_count = _aggregate(
        current, metric, calendar_days=current_days
    )
    baseline_value, baseline_count = _aggregate(baseline, metric, calendar_days=90)
    delta = (
        current_value - baseline_value
        if current_value is not None and baseline_value is not None
        else None
    )
    return {
        "key": key,
        "label": metric.label,
        "unit": metric.unit,
        "decimals": metric.decimals,
        "higherIsBetter": metric.higher_is_better,
        "current": current_value,
        "baseline": baseline_value,
        "delta": delta,
        "currentSamples": current_count,
        "baselineSamples": baseline_count,
    }


def _self_reported(
    connection: Any,
    report_start: date,
    report_end: date,
    baseline_start: date,
    baseline_end: date,
) -> tuple[list[dict[str, Any]], int, int]:
    raw_questions = get_setting_json(connection, QUESTION_SETTINGS_KEY)
    questions = raw_questions if isinstance(raw_questions, list) else []
    entries = [
        (
            date.fromisoformat(str(row["checkin_date"])),
            json.loads(str(row["answers_json"])),
        )
        for row in connection.execute(
            "SELECT checkin_date, answers_json FROM checkin_entries WHERE checkin_date BETWEEN ? AND ? ORDER BY checkin_date",
            (baseline_start.isoformat(), report_end.isoformat()),
        )
    ]
    current = [answers for day, answers in entries if report_start <= day <= report_end]
    baseline = [
        answers for day, answers in entries if baseline_start <= day <= baseline_end
    ]
    ranked = sorted(
        (
            question
            for question in questions
            if isinstance(question, dict)
            and question.get("inputType") in {"slider", "multi-choice", "boolean"}
        ),
        key=lambda question: (
            0
            if question.get("id") == "caffeine_count"
            else 1
            if "read" in str(question.get("prompt", "")).lower()
            else 2,
            -sum(question.get("id") in answers for answers in current),
        ),
    )
    summaries = []
    for question in ranked:
        current_value, current_count = _question_average(question, current)
        baseline_value, baseline_count = _question_average(question, baseline)
        if current_count == 0 and baseline_count == 0:
            continue
        summaries.append(
            {
                "key": f"question:{question.get('id')}",
                "label": str(question.get("prompt", "Question")),
                "unit": "%"
                if question.get("inputType") == "boolean"
                else "per answered day"
                if question.get("id") == "caffeine_count"
                else "avg score",
                "decimals": 1,
                "higherIsBetter": None,
                "current": current_value,
                "baseline": baseline_value,
                "delta": current_value - baseline_value
                if current_value is not None and baseline_value is not None
                else None,
                "currentSamples": current_count,
                "baselineSamples": baseline_count,
            }
        )
        if len(summaries) == 6:
            break
    return summaries, len(current), len(baseline)


def _question_average(
    question: dict[str, Any], entries: list[dict[str, Any]]
) -> tuple[float | None, int]:
    question_id = question.get("id")
    values = [entry[question_id] for entry in entries if question_id in entry]
    if not values:
        return None, 0
    if question.get("inputType") == "boolean":
        return mean(100.0 if bool(value) else 0.0 for value in values), len(values)
    numeric = [
        float(value)
        for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]
    if question.get("inputType") == "multi-choice":
        scores = {
            str(option.get("id")): option.get("score")
            for option in question.get("options", [])
            if isinstance(option, dict)
        }
        numeric = [
            float(scores[str(value)])
            for value in values
            if isinstance(scores.get(str(value)), (int, float))
        ]
    return (mean(numeric), len(numeric)) if numeric else (None, len(values))


def deterministic_analysis(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        "sleep": _fallback_section("Sleep", snapshot["sections"]["sleep"]),
        "training": _fallback_section("Training", snapshot["sections"]["training"]),
        "selfReported": _fallback_section(
            "Self-reported metrics", snapshot["sections"]["selfReported"]
        ),
    }


def _fallback_section(name: str, metrics: list[dict[str, Any]]) -> dict[str, Any]:
    comparable = [
        metric
        for metric in metrics
        if metric["delta"] is not None and metric["higherIsBetter"] is not None
    ]
    positive = [
        metric
        for metric in comparable
        if (metric["delta"] >= 0) == metric["higherIsBetter"]
    ]
    negative = [metric for metric in comparable if metric not in positive]
    if not comparable:
        return {
            "assessment": "insufficient_data",
            "recap": f"There is not enough {name.lower()} data for a reliable comparison with the prior 90 days.",
            "wentWell": [],
            "needsAttention": ["Add more complete days before drawing conclusions."],
        }
    assessment = (
        "improved"
        if positive and not negative
        else "worse"
        if negative and not positive
        else "mixed"
    )
    recap = f"{name} was {assessment} compared with the prior 90 days. {len(positive)} tracked metric{'s' if len(positive) != 1 else ''} moved in a favorable direction and {len(negative)} moved the other way."
    return {
        "assessment": assessment,
        "recap": recap,
        "wentWell": [_metric_delta_text(metric) for metric in positive[:2]],
        "needsAttention": [_metric_delta_text(metric) for metric in negative[:2]],
    }


def _metric_delta_text(metric: dict[str, Any]) -> str:
    decimals = int(metric["decimals"])
    direction = "higher" if metric["delta"] > 0 else "lower"
    magnitude = abs(metric["delta"])
    return (
        f"{metric['label']} was {magnitude:,.{decimals}f} {metric['unit']} "
        f"{direction} than the 90-day average."
    )


class MonthlyReportService:
    def __init__(
        self,
        settings: MonthlyReportServiceSettings,
        *,
        poll_interval_seconds: int = 300,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.settings = settings
        self._poll_interval_seconds = max(1, poll_interval_seconds)
        self._now_fn = now_fn or datetime.now
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run_loop, name="monthly-report-worker", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        self._thread = None
        if thread and thread.is_alive():
            thread.join(timeout=self._poll_interval_seconds + 1)

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:  # pragma: no cover - runtime guard
                logger.exception("Monthly report worker iteration failed")
            self._stop_event.wait(self._poll_interval_seconds)

    def run_once(self) -> None:
        now = self._now_fn().astimezone()
        report_settings = load_monthly_report_settings(self.settings.db_path)
        if (
            not report_settings["enabled"]
            or now.day < report_settings["sendDay"]
            or now.strftime("%H:%M") < report_settings["sendAfter"]
        ):
            return
        first_this_month = now.date().replace(day=1)
        previous_month = (first_this_month - timedelta(days=1)).replace(day=1)
        if not _should_attempt_delivery(
            self.settings.db_path, previous_month, today=now.date()
        ):
            return
        self.generate(previous_month, send_email=True)

    def generate(
        self, month: date, *, send_email: bool = False, today: date | None = None
    ) -> dict[str, Any]:
        report_start, report_end = month_period(month, today=today)
        warnings = import_missing_report_dates(self.settings, report_start, report_end)
        snapshot = build_monthly_snapshot(self.settings.db_path, month, today=today)
        codex_result: CodexResult = generate_editorial_analysis(
            {
                key: value
                for key, value in snapshot.items()
                if key != "fallbackAnalysis"
            },
            snapshot["fallbackAnalysis"],
            timeout_seconds=self.settings.codex_timeout_seconds,
        )
        snapshot["analysis"] = codex_result.analysis
        snapshot["analysisSource"] = codex_result.source
        if codex_result.warning:
            warnings.append(f"Codex unavailable: {codex_result.warning}")
        from src.monthly_report_pdf import render_monthly_report

        output_path = (
            Path(self.settings.reports_dir)
            / f"selftracker-{month.strftime('%Y-%m')}.pdf"
        )
        render_monthly_report(snapshot, output_path)
        emailed_at = None
        if send_email:
            try:
                self._send_email(snapshot, output_path)
                emailed_at = utc_now()
            except Exception as exc:  # pragma: no cover - external service guard
                logger.exception("Monthly report email delivery failed")
                warnings.append(f"Email delivery failed: {exc}")
        _save_report_record(
            self.settings.db_path, snapshot, output_path, emailed_at, warnings
        )
        return report_status(self.settings.db_path, month=month)

    def _send_email(self, snapshot: dict[str, Any], pdf_path: Path) -> None:
        missing = [
            name
            for name, value in (
                ("SMTP_HOST", self.settings.smtp_host),
                ("SMTP_USER", self.settings.smtp_user),
                ("SMTP_PASS", self.settings.smtp_pass),
                ("recipient", self.settings.recipient_email),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(f"Email is not configured: {', '.join(missing)}")
        label = datetime.strptime(snapshot["reportMonth"], "%Y-%m").strftime("%B %Y")
        message = EmailMessage()
        message["Subject"] = f"Selftracker monthly report · {label}"
        message["From"] = self.settings.smtp_user
        message["To"] = self.settings.recipient_email
        message.set_content(
            f"Your {label} Selftracker report is attached.\n\nThe report compares the month with the preceding 90 days."
        )
        message.add_attachment(
            pdf_path.read_bytes(),
            maintype="application",
            subtype="pdf",
            filename=pdf_path.name,
        )
        with smtplib.SMTP(
            self.settings.smtp_host, self.settings.smtp_port, timeout=30
        ) as smtp:
            smtp.starttls()
            smtp.login(self.settings.smtp_user, self.settings.smtp_pass)
            smtp.send_message(message)


def _should_attempt_delivery(db_path: str, month: date, *, today: date) -> bool:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        row = connection.execute(
            "SELECT emailed_at, generated_at FROM monthly_reports WHERE report_month = ?",
            (month.strftime("%Y-%m"),),
        ).fetchone()
        if row is None:
            return True
        if row["emailed_at"] is not None:
            return False
        try:
            attempted_at = datetime.fromisoformat(str(row["generated_at"]))
        except ValueError:
            return True
        return attempted_at.astimezone().date() < today
    finally:
        connection.close()


def _save_report_record(
    db_path: str,
    snapshot: dict[str, Any],
    output_path: Path,
    emailed_at: str | None,
    warnings: list[str],
) -> None:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        connection.execute(
            """
            INSERT INTO monthly_reports (report_month, period_start, period_end, status, analysis_source, snapshot_json, pdf_path, generated_at, emailed_at, warnings_json)
            VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(report_month) DO UPDATE SET period_start=excluded.period_start, period_end=excluded.period_end,
                status=excluded.status, analysis_source=excluded.analysis_source, snapshot_json=excluded.snapshot_json,
                pdf_path=excluded.pdf_path, generated_at=excluded.generated_at,
                emailed_at=COALESCE(excluded.emailed_at, monthly_reports.emailed_at), warnings_json=excluded.warnings_json
            """,
            (
                snapshot["reportMonth"],
                snapshot["period"]["start"],
                snapshot["period"]["end"],
                snapshot["analysisSource"],
                json.dumps(snapshot),
                str(output_path),
                utc_now(),
                emailed_at,
                json.dumps(warnings),
            ),
        )
        connection.commit()
    finally:
        connection.close()


def report_status(db_path: str, *, month: date | None = None) -> dict[str, Any]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        if month:
            row = connection.execute(
                "SELECT * FROM monthly_reports WHERE report_month = ?",
                (month.strftime("%Y-%m"),),
            ).fetchone()
        else:
            row = connection.execute(
                "SELECT * FROM monthly_reports ORDER BY report_month DESC LIMIT 1"
            ).fetchone()
        if row is None:
            return {"report": None}
        return {
            "report": {
                "month": row["report_month"],
                "status": row["status"],
                "analysisSource": row["analysis_source"],
                "generatedAt": row["generated_at"],
                "emailedAt": row["emailed_at"],
                "warnings": json.loads(row["warnings_json"]),
                "downloadUrl": f"/api/monthly-reports/{row['report_month']}/pdf",
            }
        }
    finally:
        connection.close()
