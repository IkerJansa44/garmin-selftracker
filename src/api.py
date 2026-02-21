from __future__ import annotations

import argparse
import errno
import json
import logging
import math
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.config import SettingsError, load_settings
from src.db import (
    connect_db,
    get_checkin_entries,
    get_setting_json,
    init_db,
    upsert_checkin_entry,
    upsert_setting_json,
)
from src.sync import run_sync

logger = logging.getLogger(__name__)
QUESTION_SETTINGS_KEY = "checkin_questions"
DASHBOARD_PLOTS_SETTINGS_KEY = "dashboard_plots"
QUESTION_INPUT_TYPES = {"slider", "multi-choice", "boolean", "time", "text"}
QUESTION_ANALYSIS_MODES = {"predictor_next_day", "target_same_day"}
PLOT_DIRECTIONS = {"higher", "lower"}
METRIC_PLOT_DIRECTIONS = {
    "recoveryIndex": "higher",
    "sleepScore": "higher",
    "bodyBattery": "higher",
    "trainingReadiness": "higher",
    "stress": "lower",
    "restingHr": "lower",
}
DEFAULT_DASHBOARD_PLOTS = [
    {"key": "metric:recoveryIndex", "direction": "higher"},
    {"key": "metric:sleepScore", "direction": "higher"},
    {"key": "metric:restingHr", "direction": "lower"},
    {"key": "metric:stress", "direction": "lower"},
    {"key": "metric:bodyBattery", "direction": "higher"},
    {"key": "metric:trainingReadiness", "direction": "higher"},
]
QUESTION_CHILD_CONDITION_OPERATORS = {
    "equals",
    "not_equals",
    "greater_than",
    "at_least",
    "non_empty",
}
QUESTION_CHILD_CONDITIONS_WITH_VALUE = {
    "equals",
    "not_equals",
    "greater_than",
    "at_least",
}
MAX_IMPORT_RANGE_DAYS = 365


@dataclass(frozen=True)
class ApiSettings:
    db_path: str
    host: str
    port: int
    garmin_email: str
    garmin_password: str
    default_sync_days: int


@dataclass(frozen=True)
class ImportRequest:
    mode: str
    start_date: date
    end_date: date


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sleep_score(sleep_seconds: int | None) -> int | None:
    if sleep_seconds is None:
        return None
    hours = sleep_seconds / 3600
    score = 50 + (hours - 4.0) * 10
    return int(round(_clamp(score, 40, 100)))


def _recovery_index(
    resting_hr: int | None, stress_avg: float | None, sleep_score: int | None
) -> int | None:
    if resting_hr is None or stress_avg is None:
        return None
    sleep_term = 0 if sleep_score is None else (sleep_score - 70) * 0.3
    value = 95 - resting_hr - stress_avg * 0.6 + sleep_term
    return int(round(_clamp(value, 20, 120)))


def _training_readiness(
    body_battery: int | None,
    sleep_score: int | None,
    stress_avg: float | None,
) -> int | None:
    weighted_sum = 0.0
    weight_total = 0.0

    if body_battery is not None:
        weighted_sum += body_battery * 0.45
        weight_total += 0.45
    if sleep_score is not None:
        weighted_sum += sleep_score * 0.35
        weight_total += 0.35
    if stress_avg is not None:
        weighted_sum += (100 - stress_avg) * 0.20
        weight_total += 0.20

    if weight_total == 0:
        return None

    value = weighted_sum / weight_total
    return int(round(_clamp(value, 20, 100)))


def _parse_days(query: dict[str, list[str]]) -> int:
    values = query.get("days", ["365"])
    try:
        parsed = int(values[0])
    except (TypeError, ValueError):
        return 365
    return max(7, min(365, parsed))


def _parse_iso_date(raw_value: Any, *, field_name: str) -> date:
    if not isinstance(raw_value, str):
        raise ValueError(f"{field_name} must be an ISO date string")
    try:
        return date.fromisoformat(raw_value)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be YYYY-MM-DD") from exc


def _parse_date_range_query(
    query: dict[str, list[str]],
    *,
    from_field: str = "fromDate",
    to_field: str = "toDate",
    max_range_days: int = MAX_IMPORT_RANGE_DAYS,
) -> tuple[date, date]:
    from_values = query.get(from_field)
    to_values = query.get(to_field)
    start_date = _parse_iso_date(
        from_values[0] if from_values else None, field_name=from_field
    )
    end_date = _parse_iso_date(to_values[0] if to_values else None, field_name=to_field)
    if start_date > end_date:
        raise ValueError(f"{from_field} must be on or before {to_field}")
    span_days = (end_date - start_date).days + 1
    if span_days > max_range_days:
        raise ValueError(f"Date range cannot exceed {max_range_days} days")
    return start_date, end_date


def _parse_import_request(
    payload: Any,
    *,
    default_sync_days: int,
    today: date | None = None,
) -> ImportRequest:
    if not isinstance(payload, dict):
        raise ValueError("Import payload must be a JSON object")
    mode = payload.get("mode")
    if mode not in {"refresh", "range"}:
        raise ValueError("mode must be either 'refresh' or 'range'")

    current_day = today or date.today()
    if mode == "refresh":
        days = max(1, int(default_sync_days))
        end_date = current_day
        start_date = end_date - timedelta(days=days - 1)
        return ImportRequest(mode=mode, start_date=start_date, end_date=end_date)

    start_date = _parse_iso_date(payload.get("fromDate"), field_name="fromDate")
    end_date = _parse_iso_date(payload.get("toDate"), field_name="toDate")
    if start_date > end_date:
        raise ValueError("fromDate must be on or before toDate")
    if end_date > current_day:
        raise ValueError("toDate cannot be in the future")
    span_days = (end_date - start_date).days + 1
    if span_days > MAX_IMPORT_RANGE_DAYS:
        raise ValueError(f"Date range cannot exceed {MAX_IMPORT_RANGE_DAYS} days")
    return ImportRequest(mode=mode, start_date=start_date, end_date=end_date)


def _latest_sync_run_status(db_path: str) -> str | None:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        row = connection.execute(
            """
            SELECT status
            FROM sync_runs
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        return None
    return str(row["status"])


class ImportJobManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running = False

    def start(self, *, settings: ApiSettings, request: ImportRequest) -> bool:
        with self._lock:
            if self._running:
                return False
            if _latest_sync_run_status(settings.db_path) == "running":
                return False
            self._running = True

        thread = threading.Thread(
            target=self._run_job,
            args=(settings, request),
            daemon=True,
        )
        try:
            thread.start()
        except Exception:
            with self._lock:
                self._running = False
            raise
        return True

    def _run_job(self, settings: ApiSettings, request: ImportRequest) -> None:
        try:
            result = run_sync(
                db_path=settings.db_path,
                garmin_email=settings.garmin_email,
                garmin_password=settings.garmin_password,
                start_date=request.start_date,
                end_date=request.end_date,
            )
            logger.info(
                "Import completed mode=%s status=%s (%s/%s days)",
                request.mode,
                result.status,
                result.days_succeeded,
                result.days_requested,
            )
        except Exception:
            logger.exception(
                "Import failed mode=%s from=%s to=%s",
                request.mode,
                request.start_date.isoformat(),
                request.end_date.isoformat(),
            )
        finally:
            with self._lock:
                self._running = False


def _coverage(row_exists: bool, value: Any) -> str:
    if not row_exists:
        return "missing"
    return "complete" if value is not None else "partial"


def _as_clock_time(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds = seconds / 1000
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%H:%M")
        except (OSError, OverflowError, ValueError):
            return None
    if not isinstance(value, str):
        return None

    stripped = value.strip()
    if not stripped:
        return None
    if stripped.isdigit():
        return _as_clock_time(int(stripped))
    if (
        len(stripped) >= 5
        and stripped[2] == ":"
        and stripped[:2].isdigit()
        and stripped[3:5].isdigit()
    ):
        return stripped[:5]

    try:
        normalized = stripped.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).strftime("%H:%M")
    except ValueError:
        return None


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    try:
        return datetime.fromisoformat(stripped.replace("Z", "+00:00"))
    except ValueError:
        return None


def _format_eta_seconds(seconds: float) -> str:
    rounded_seconds = int(round(seconds))
    if rounded_seconds < 60:
        return "<1 min left"

    total_minutes = max(1, rounded_seconds // 60)
    if total_minutes < 60:
        return f"~{total_minutes} min left"

    hours, minutes = divmod(total_minutes, 60)
    if minutes == 0:
        return f"~{hours}h left"
    return f"~{hours}h {minutes}m left"


def _import_status_message(
    *,
    state: str,
    started_at: Any,
    days_requested: Any,
    days_succeeded: Any,
    now_utc: datetime | None = None,
) -> str:
    default_message = "Daily import scheduled · 06:00 local"
    if state != "running":
        return default_message

    requested_days = _as_int(days_requested) or 0
    if requested_days <= 0:
        return "Import in progress"

    succeeded_days = _as_int(days_succeeded) or 0
    completed_days = min(max(succeeded_days, 0), requested_days)
    remaining_days = max(0, requested_days - completed_days)
    progress_message = f"Import in progress · {completed_days}/{requested_days} days"

    if remaining_days == 0:
        return f"{progress_message} · Finalizing"
    if completed_days == 0:
        return progress_message

    started_at_datetime = _parse_iso_datetime(started_at)
    if started_at_datetime is None:
        return progress_message
    if started_at_datetime.tzinfo is None:
        started_at_datetime = started_at_datetime.replace(tzinfo=timezone.utc)

    current_time = now_utc or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)

    elapsed_seconds = (
        current_time.astimezone(timezone.utc)
        - started_at_datetime.astimezone(timezone.utc)
    ).total_seconds()
    if elapsed_seconds <= 0:
        return progress_message

    eta_seconds = (elapsed_seconds / completed_days) * remaining_days
    return f"{progress_message} · {_format_eta_seconds(eta_seconds)}"


def _metric_payload(row: Any | None) -> tuple[dict[str, int | None], dict[str, str]]:
    if row is None:
        metrics = {
            "recoveryIndex": None,
            "sleepScore": None,
            "restingHr": None,
            "stress": None,
            "bodyBattery": None,
            "trainingReadiness": None,
        }
        coverage = {key: "missing" for key in metrics}
        return metrics, coverage

    resting_hr = _as_int(row["resting_heart_rate"])
    body_battery = _as_int(row["body_battery"])
    stress_avg = _as_float(row["stress_avg"])
    stress_value = _as_int(stress_avg)
    sleep_seconds = _as_int(row["sleep_seconds"])

    sleep_score = _sleep_score(sleep_seconds)
    recovery_index_value = _recovery_index(resting_hr, stress_avg, sleep_score)
    readiness = _training_readiness(body_battery, sleep_score, stress_avg)

    metrics = {
        "recoveryIndex": recovery_index_value,
        "sleepScore": sleep_score,
        "restingHr": resting_hr,
        "stress": stress_value,
        "bodyBattery": body_battery,
        "trainingReadiness": readiness,
    }
    coverage = {key: _coverage(True, value) for key, value in metrics.items()}
    return metrics, coverage


def _normalize_question_option(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    option_id = raw.get("id")
    label = raw.get("label")
    if not isinstance(option_id, str) or not option_id.strip():
        return None
    if not isinstance(label, str) or not label.strip():
        return None
    normalized: dict[str, Any] = {"id": option_id.strip(), "label": label.strip()}
    if "score" in raw:
        score = raw.get("score")
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            return None
        if not math.isfinite(float(score)):
            return None
        normalized["score"] = score
    return normalized


def _normalize_child_condition(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    operator = raw.get("operator")
    if (
        not isinstance(operator, str)
        or operator not in QUESTION_CHILD_CONDITION_OPERATORS
    ):
        return None

    normalized: dict[str, Any] = {"operator": operator}
    value = raw.get("value")

    if operator in QUESTION_CHILD_CONDITIONS_WITH_VALUE:
        if value is None:
            return None
        if operator in {"greater_than", "at_least"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            if not math.isfinite(float(value)):
                return None
        elif not isinstance(value, (str, int, float, bool)):
            return None
        normalized["value"] = value
        return normalized

    if value is not None:
        if not isinstance(value, (str, int, float, bool)):
            return None
        normalized["value"] = value
    return normalized


def _normalize_question_child(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    child_id = raw.get("id")
    prompt = raw.get("prompt")
    input_type = raw.get("inputType")
    analysis_mode = raw.get("analysisMode", "predictor_next_day")

    if not isinstance(child_id, str) or not child_id.strip():
        return None
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    if not isinstance(input_type, str) or input_type not in QUESTION_INPUT_TYPES:
        return None
    if (
        not isinstance(analysis_mode, str)
        or analysis_mode not in QUESTION_ANALYSIS_MODES
    ):
        return None

    condition = _normalize_child_condition(raw.get("condition"))
    if condition is None:
        return None

    normalized: dict[str, Any] = {
        "id": child_id.strip(),
        "prompt": prompt.strip(),
        "inputType": input_type,
        "analysisMode": analysis_mode,
        "condition": condition,
    }

    if input_type == "slider":
        for key in ("min", "max", "step"):
            value = raw.get(key)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            normalized[key] = value

    if input_type == "multi-choice":
        options_raw = raw.get("options", [])
        if not isinstance(options_raw, list):
            return None
        options = []
        for option_raw in options_raw:
            option = _normalize_question_option(option_raw)
            if option is None:
                return None
            options.append(option)
        normalized["options"] = options

    return normalized


def _normalize_question(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    question_id = raw.get("id")
    section = raw.get("section")
    prompt = raw.get("prompt")
    input_type = raw.get("inputType")
    default_included = raw.get("defaultIncluded")
    analysis_mode = raw.get("analysisMode", "predictor_next_day")
    input_label = raw.get("inputLabel")

    if not isinstance(question_id, str) or not question_id.strip():
        return None
    if not isinstance(section, str) or not section.strip():
        return None
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    if not isinstance(input_type, str) or input_type not in QUESTION_INPUT_TYPES:
        return None
    if not isinstance(default_included, bool):
        return None
    if (
        not isinstance(analysis_mode, str)
        or analysis_mode not in QUESTION_ANALYSIS_MODES
    ):
        return None

    normalized: dict[str, Any] = {
        "id": question_id.strip(),
        "section": section.strip(),
        "prompt": prompt.strip(),
        "inputType": input_type,
        "defaultIncluded": default_included,
        "analysisMode": analysis_mode,
    }

    if input_label is not None:
        if not isinstance(input_label, str) or not input_label.strip():
            return None
        normalized["inputLabel"] = input_label.strip()

    if input_type == "slider":
        for key in ("min", "max", "step"):
            value = raw.get(key)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            normalized[key] = value

    if input_type == "multi-choice":
        options_raw = raw.get("options", [])
        if not isinstance(options_raw, list):
            return None
        options = []
        for option_raw in options_raw:
            option = _normalize_question_option(option_raw)
            if option is None:
                return None
            options.append(option)
        normalized["options"] = options

    children_raw = raw.get("children")
    if children_raw is not None:
        if not isinstance(children_raw, list):
            return None
        if len(children_raw) > 3:
            return None
        children = []
        seen_child_ids: set[str] = set()
        for raw_child in children_raw:
            child = _normalize_question_child(raw_child)
            if child is None:
                return None
            child_id = str(child["id"])
            if child_id in seen_child_ids:
                return None
            seen_child_ids.add(child_id)
            children.append(child)
        normalized["children"] = children

    return normalized


def _normalize_questions_payload(payload: Any) -> list[dict[str, Any]] | None:
    if not isinstance(payload, list):
        return None
    normalized = []
    seen_ids: set[str] = set()
    for raw_question in payload:
        question = _normalize_question(raw_question)
        if question is None:
            return None
        question_id = str(question["id"])
        if question_id in seen_ids:
            return None
        seen_ids.add(question_id)
        for child in question.get("children", []):
            child_id = str(child["id"])
            if child_id in seen_ids:
                return None
            seen_ids.add(child_id)
        normalized.append(question)
    return normalized


def _default_plot_direction(plot_key: str) -> str:
    if plot_key.startswith("metric:"):
        metric_key = plot_key[7:]
        direction = METRIC_PLOT_DIRECTIONS.get(metric_key)
        if direction in PLOT_DIRECTIONS:
            return direction
    return "higher"


def _normalize_dashboard_plots_payload(payload: Any) -> list[dict[str, str]] | None:
    if not isinstance(payload, list):
        return None

    normalized: list[dict[str, str]] = []
    seen_keys: set[str] = set()
    for raw_plot in payload:
        plot_key: str
        direction: str

        if isinstance(raw_plot, str):
            stripped = raw_plot.strip()
            if not stripped:
                return None
            plot_key = stripped
            direction = _default_plot_direction(plot_key)
        elif isinstance(raw_plot, dict):
            key_value = raw_plot.get("key")
            if not isinstance(key_value, str) or not key_value.strip():
                return None
            plot_key = key_value.strip()
            direction_value = raw_plot.get("direction")
            if direction_value is None:
                direction = _default_plot_direction(plot_key)
            elif (
                isinstance(direction_value, str)
                and direction_value in PLOT_DIRECTIONS
            ):
                direction = direction_value
            else:
                return None
        else:
            return None

        if plot_key in seen_keys:
            continue
        seen_keys.add(plot_key)
        normalized.append({"key": plot_key, "direction": direction})

    return normalized


def _load_questions_payload(db_path: str) -> list[dict[str, Any]]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        raw_payload = get_setting_json(connection, QUESTION_SETTINGS_KEY)
    finally:
        connection.close()
    if raw_payload is None:
        return []
    normalized = _normalize_questions_payload(raw_payload)
    return normalized if normalized is not None else []


def _save_questions_payload(db_path: str, payload: Any) -> list[dict[str, Any]]:
    normalized = _normalize_questions_payload(payload)
    if normalized is None:
        raise ValueError("Invalid question payload")
    connection = connect_db(db_path)
    try:
        init_db(connection)
        upsert_setting_json(connection, QUESTION_SETTINGS_KEY, normalized)
    finally:
        connection.close()
    return normalized


def _load_dashboard_plots_payload(db_path: str) -> list[dict[str, str]]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        raw_payload = get_setting_json(connection, DASHBOARD_PLOTS_SETTINGS_KEY)
    finally:
        connection.close()
    if raw_payload is None:
        return [dict(plot) for plot in DEFAULT_DASHBOARD_PLOTS]
    normalized = _normalize_dashboard_plots_payload(raw_payload)
    return normalized if normalized is not None else []


def _save_dashboard_plots_payload(db_path: str, payload: Any) -> list[dict[str, str]]:
    normalized = _normalize_dashboard_plots_payload(payload)
    if normalized is None:
        raise ValueError("Invalid dashboard plots payload")
    connection = connect_db(db_path)
    try:
        init_db(connection)
        upsert_setting_json(connection, DASHBOARD_PLOTS_SETTINGS_KEY, normalized)
    finally:
        connection.close()
    return normalized


def _normalize_answers_payload(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    normalized: dict[str, Any] = {}
    for key, value in payload.items():
        if not isinstance(key, str) or not key.strip():
            return None
        if isinstance(value, str):
            normalized[key.strip()] = value
            continue
        if isinstance(value, bool):
            normalized[key.strip()] = value
            continue
        if isinstance(value, (int, float)):
            normalized[key.strip()] = value
            continue
        return None
    return normalized


def _load_checkins_payload(
    db_path: str, from_date: date, to_date: date
) -> list[dict[str, Any]]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        return get_checkin_entries(
            connection,
            from_date=from_date.isoformat(),
            to_date=to_date.isoformat(),
        )
    finally:
        connection.close()


def _save_checkin_payload(db_path: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Check-in payload must be a JSON object")
    checkin_date = _parse_iso_date(payload.get("date"), field_name="date")
    answers_payload = _normalize_answers_payload(payload.get("answers"))
    if answers_payload is None:
        raise ValueError("answers must be an object of scalar values")
    connection = connect_db(db_path)
    try:
        init_db(connection)
        return upsert_checkin_entry(
            connection,
            checkin_date=checkin_date.isoformat(),
            answers=answers_payload,
        )
    finally:
        connection.close()


def _load_dashboard_payload(db_path: str, days: int) -> dict[str, Any]:
    end_date = date.today()
    start_date = end_date - timedelta(days=days - 1)

    connection = connect_db(db_path)
    init_db(connection)

    metric_rows = connection.execute(
        """
        SELECT
            metric_date,
            steps,
            calories,
            resting_heart_rate,
            body_battery,
            stress_avg,
            sleep_seconds,
            fell_asleep_at
        FROM daily_metrics
        WHERE metric_date BETWEEN ? AND ?
        ORDER BY metric_date
        """,
        (start_date.isoformat(), end_date.isoformat()),
    ).fetchall()
    rows_by_date = {row["metric_date"]: row for row in metric_rows}

    activity_rows = connection.execute(
        """
        SELECT substr(start_time_local, 1, 10) AS activity_date, COUNT(*) AS activity_count
        FROM activities
        WHERE start_time_local IS NOT NULL
          AND substr(start_time_local, 1, 10) BETWEEN ? AND ?
        GROUP BY activity_date
        """,
        (start_date.isoformat(), end_date.isoformat()),
    ).fetchall()
    training_days = {
        row["activity_date"]
        for row in activity_rows
        if row["activity_date"]
        and row["activity_count"]
        and int(row["activity_count"]) > 0
    }

    latest_run = connection.execute(
        """
        SELECT status, started_at, ended_at, days_requested, days_succeeded
        FROM sync_runs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()

    connection.close()

    if latest_run is None:
        summary_state = "ok" if metric_rows else "failed"
        last_import_at = None
        import_status_message = "Daily import scheduled · 06:00 local"
    else:
        raw_status = str(latest_run["status"])
        summary_state = "ok"
        if raw_status == "running":
            summary_state = "running"
        elif raw_status == "failed":
            summary_state = "failed"
        last_import_at = latest_run["ended_at"] or latest_run["started_at"]
        import_status_message = _import_status_message(
            state=summary_state,
            started_at=latest_run["started_at"],
            days_requested=latest_run["days_requested"],
            days_succeeded=latest_run["days_succeeded"],
        )

    records: list[dict[str, Any]] = []
    for offset in range(days):
        current = start_date + timedelta(days=offset)
        date_key = current.isoformat()
        row = rows_by_date.get(date_key)
        metrics, coverage = _metric_payload(row)

        import_state = "ok"
        if row is None:
            import_state = "failed"
        if date_key == end_date.isoformat() and summary_state == "running":
            import_state = "running"
        elif (
            date_key == end_date.isoformat()
            and summary_state == "failed"
            and row is None
        ):
            import_state = "failed"

        records.append(
            {
                "date": date_key,
                "dayIndex": offset,
                "weekday": (current.weekday() + 1) % 7,
                "isTrainingDay": date_key in training_days,
                "importGap": row is None,
                "importState": import_state,
                "fellAsleepAt": _as_clock_time(row["fell_asleep_at"]) if row else None,
                "predictors": {
                    "steps": _as_int(row["steps"]) if row else None,
                    "calories": _as_int(row["calories"]) if row else None,
                    "stressAvg": _as_float(row["stress_avg"]) if row else None,
                    "bodyBattery": _as_int(row["body_battery"]) if row else None,
                    "sleepSeconds": _as_int(row["sleep_seconds"]) if row else None,
                    "isTrainingDay": date_key in training_days,
                },
                "metrics": metrics,
                "coverage": coverage,
            }
        )

    return {
        "records": records,
        "importStatus": {
            "state": summary_state,
            "lastImportAt": last_import_at,
            "message": import_status_message,
        },
        "meta": {
            "source": "sqlite",
            "days": days,
            "availableDays": len(metric_rows),
        },
    }


class ApiHandler(BaseHTTPRequestHandler):
    db_path: str = "/data/garmin.db"
    settings: ApiSettings | None = None
    import_job_manager = ImportJobManager()

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler signature
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if parsed.path == "/api/dashboard":
            query = parse_qs(parsed.query)
            days = _parse_days(query)
            try:
                payload = _load_dashboard_payload(self.db_path, days)
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to build dashboard payload")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "Failed to load dashboard data", "details": str(exc)},
                )
                return

            self._send_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/questions":
            try:
                payload = _load_questions_payload(self.db_path)
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to load question settings")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Failed to load question settings",
                        "details": str(exc),
                    },
                )
                return
            self._send_json(HTTPStatus.OK, {"questions": payload})
            return

        if parsed.path == "/api/checkins":
            query = parse_qs(parsed.query)
            try:
                from_date, to_date = _parse_date_range_query(
                    query,
                    max_range_days=MAX_IMPORT_RANGE_DAYS + 1,
                )
                entries = _load_checkins_payload(self.db_path, from_date, to_date)
            except ValueError as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Invalid check-in range", "details": str(exc)},
                )
                return
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to load check-ins")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "Failed to load check-ins", "details": str(exc)},
                )
                return
            self._send_json(HTTPStatus.OK, {"entries": entries})
            return

        if parsed.path == "/api/dashboard-plots":
            try:
                plots = _load_dashboard_plots_payload(self.db_path)
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to load dashboard plot settings")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Failed to load dashboard plot settings",
                        "details": str(exc),
                    },
                )
                return
            self._send_json(HTTPStatus.OK, {"plots": plots})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler signature
        parsed = urlparse(self.path)
        if parsed.path != "/api/import":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        if self.settings is None:
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "API settings are not initialized"},
            )
            return

        raw_payload = self._read_json_body()
        if raw_payload is None:
            return

        try:
            request = _parse_import_request(
                raw_payload,
                default_sync_days=self.settings.default_sync_days,
            )
        except ValueError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "Invalid import payload", "details": str(exc)},
            )
            return

        try:
            started = self.import_job_manager.start(
                settings=self.settings,
                request=request,
            )
        except Exception as exc:  # pragma: no cover - runtime guard
            logger.exception("Failed to start import job")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Failed to start import job", "details": str(exc)},
            )
            return

        if not started:
            self._send_json(
                HTTPStatus.CONFLICT,
                {"error": "Import already running"},
            )
            return

        logger.info(
            "Accepted import request mode=%s from=%s to=%s",
            request.mode,
            request.start_date.isoformat(),
            request.end_date.isoformat(),
        )
        self._send_json(
            HTTPStatus.ACCEPTED,
            {
                "status": "accepted",
                "mode": request.mode,
                "fromDate": request.start_date.isoformat(),
                "toDate": request.end_date.isoformat(),
                "days": (request.end_date - request.start_date).days + 1,
            },
        )

    def do_PUT(self) -> None:  # noqa: N802 - stdlib handler signature
        parsed = urlparse(self.path)

        raw_payload = self._read_json_body()
        if raw_payload is None:
            return

        if parsed.path == "/api/questions":
            questions_payload = (
                raw_payload.get("questions")
                if isinstance(raw_payload, dict)
                else raw_payload
            )
            try:
                normalized = _save_questions_payload(self.db_path, questions_payload)
            except ValueError as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Invalid question settings payload", "details": str(exc)},
                )
                return
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to save question settings")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "Failed to save question settings", "details": str(exc)},
                )
                return
            self._send_json(HTTPStatus.OK, {"questions": normalized})
            return

        if parsed.path == "/api/checkins":
            try:
                entry = _save_checkin_payload(self.db_path, raw_payload)
            except ValueError as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Invalid check-in payload", "details": str(exc)},
                )
                return
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to save check-in")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "Failed to save check-in", "details": str(exc)},
                )
                return
            self._send_json(HTTPStatus.OK, {"entry": entry})
            return

        if parsed.path == "/api/dashboard-plots":
            plots_payload = (
                raw_payload.get("plots")
                if isinstance(raw_payload, dict)
                else raw_payload
            )
            try:
                normalized = _save_dashboard_plots_payload(self.db_path, plots_payload)
            except ValueError as exc:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "Invalid dashboard plot settings payload", "details": str(exc)},
                )
                return
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to save dashboard plot settings")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "Failed to save dashboard plot settings", "details": str(exc)},
                )
                return
            self._send_json(HTTPStatus.OK, {"plots": normalized})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        logger.info("API %s - %s", self.address_string(), format % args)

    def _read_json_body(self) -> Any | None:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing request body"})
            return None
        try:
            length = int(length_header)
        except ValueError:
            self._send_json(
                HTTPStatus.BAD_REQUEST, {"error": "Invalid Content-Length header"}
            )
            return None
        if length <= 0:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Empty request body"})
            return None

        raw_bytes = self.rfile.read(length)
        try:
            return json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "Request body must be valid JSON"},
            )
            return None

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        try:
            self.end_headers()
            self.wfile.write(data)
        except OSError as exc:
            if isinstance(
                exc, (BrokenPipeError, ConnectionResetError)
            ) or exc.errno in {
                errno.EPIPE,
                errno.ECONNRESET,
            }:
                logger.info("Client disconnected before response completed")
                return
            raise


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SQLite API server for dashboard data")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8000, type=int)
    parser.add_argument("--db-path", default=None)
    return parser.parse_args()


def _build_settings() -> ApiSettings:
    args = _parse_args()
    env_settings = load_settings(require_garmin_credentials=True)
    db_path = args.db_path or env_settings.db_path
    return ApiSettings(
        db_path=db_path,
        host=args.host,
        port=args.port,
        garmin_email=env_settings.garmin_email,
        garmin_password=env_settings.garmin_password,
        default_sync_days=env_settings.default_sync_days,
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    try:
        settings = _build_settings()
    except SettingsError as exc:
        logger.error(str(exc))
        return 1

    handler = ApiHandler
    handler.db_path = settings.db_path
    handler.settings = settings

    with ThreadingHTTPServer((settings.host, settings.port), handler) as server:
        logger.info(
            "Dashboard API listening on %s:%s (db=%s)",
            settings.host,
            settings.port,
            settings.db_path,
        )
        server.serve_forever()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
