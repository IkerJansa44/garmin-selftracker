from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from zipfile import BadZipFile, ZipFile

import fitdecode

from src.db import (
    connect_db,
    create_sync_run,
    finalize_sync_run,
    init_db,
    update_sync_run_progress,
    upsert_daily_metrics,
    upsert_raw_payload,
)

logger = logging.getLogger(__name__)

ARCHIVE_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")
FIT_EPOCH = datetime(1989, 12, 31, tzinfo=timezone.utc)
SLEEP_STAGE_KEYS = {
    "deep": "deep_sleep_seconds",
    "light": "light_sleep_seconds",
    "rem": "rem_sleep_seconds",
}
NON_SLEEP_LEVELS = {"awake", "unmeasurable"}
METRIC_KEYS = (
    "steps",
    "calories",
    "resting_heart_rate",
    "body_battery",
    "stress_avg",
    "sleep_seconds",
    "deep_sleep_seconds",
    "light_sleep_seconds",
    "rem_sleep_seconds",
    "deep_sleep_percentage",
    "rem_sleep_percentage",
    "rem_or_deep_sleep_percentage",
    "average_respiration_value",
    "lowest_respiration_value",
    "fell_asleep_at",
    "woke_up_at",
    "vo2max",
    "zone0_minutes",
    "zone1_minutes",
    "zone2_minutes",
    "zone3_minutes",
    "zone4_minutes",
    "zone5_minutes",
)


@dataclass(frozen=True)
class ManualImportResult:
    run_id: int
    archives_found: int
    archives_imported: int
    days_imported: int
    status: str
    import_dir: str
    error_message: str | None = None


@dataclass
class FitArchiveAccumulator:
    metric_date: date
    files: list[dict[str, Any]]
    steps_by_activity: dict[str, list[int]]
    active_calories_by_activity: dict[str, list[int]]
    resting_metabolic_rates: list[int]
    resting_heart_rates: list[int]
    stress_values: list[int]
    respiration_values: list[float]
    sleep_levels: list[tuple[datetime, str]]


def run_manual_import_dir(*, db_path: str, import_dir: str) -> ManualImportResult:
    archive_dir = Path(import_dir).expanduser()
    archives = sorted(archive_dir.glob("*.zip")) if archive_dir.exists() else []
    connection = connect_db(db_path)
    init_db(connection)

    run_id = create_sync_run(connection, days_requested=len(archives))
    imported = 0
    error_message = None

    try:
        if not archives:
            raise ValueError(f"No Garmin wellness zip files found in {archive_dir}")

        for archive_path in archives:
            metrics, raw_payload = parse_garmin_wellness_zip(archive_path)
            metrics = _merge_existing_metrics(connection, metrics)
            upsert_daily_metrics(connection, metrics)
            upsert_raw_payload(
                connection,
                payload_date=metrics["metric_date"],
                endpoint="manual_wellness_zip",
                payload=raw_payload,
                sync_run_id=run_id,
            )
            imported += 1
            update_sync_run_progress(connection, run_id, days_succeeded=imported)
            connection.commit()
            logger.info("Imported manual Garmin archive %s", archive_path)
    except Exception as exc:
        connection.rollback()
        error_message = str(exc)
        logger.exception("Manual Garmin import failed")
    finally:
        status = (
            "success"
            if imported == len(archives) and error_message is None
            else "failed"
        )
        if imported and imported != len(archives):
            status = "partial"
        finalize_sync_run(
            connection,
            run_id,
            status=status,
            days_succeeded=imported,
            error_message=error_message,
        )
        connection.close()

    return ManualImportResult(
        run_id=run_id,
        archives_found=len(archives),
        archives_imported=imported,
        days_imported=imported,
        status=status,
        import_dir=str(archive_dir),
        error_message=error_message,
    )


def parse_garmin_wellness_zip(
    archive_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    metric_date = _archive_metric_date(archive_path)
    accumulator = FitArchiveAccumulator(
        metric_date=metric_date,
        files=[],
        steps_by_activity=defaultdict(list),
        active_calories_by_activity=defaultdict(list),
        resting_metabolic_rates=[],
        resting_heart_rates=[],
        stress_values=[],
        respiration_values=[],
        sleep_levels=[],
    )

    try:
        with ZipFile(archive_path) as archive:
            fit_files = [
                name
                for name in archive.namelist()
                if not name.endswith("/") and name.lower().endswith(".fit")
            ]
            if not fit_files:
                raise ValueError("Archive does not contain Garmin .fit files")
            for fit_name in fit_files:
                _read_fit_file(fit_name, archive.read(fit_name), accumulator)
    except BadZipFile as exc:
        raise ValueError(f"{archive_path} is not a valid zip archive") from exc

    metrics = _build_daily_metrics(accumulator)
    raw_payload = {
        "archive": archive_path.name,
        "metric_date": metric_date.isoformat(),
        "files": accumulator.files,
    }
    return metrics, raw_payload


def _read_fit_file(
    fit_name: str,
    content: bytes,
    accumulator: FitArchiveAccumulator,
) -> None:
    message_counts: dict[str, int] = defaultdict(int)
    with fitdecode.FitReader(BytesIO(content)) as fit_file:
        for frame in fit_file:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            message_counts[frame.name] += 1
            fields = {field.name: field.value for field in frame.fields}
            _collect_fields(frame.name, fields, accumulator)

    accumulator.files.append(
        {
            "name": fit_name,
            "messages": dict(sorted(message_counts.items())),
        }
    )


def _collect_fields(
    message_name: str,
    fields: dict[str, Any],
    accumulator: FitArchiveAccumulator,
) -> None:
    if message_name == "monitoring_info":
        rmr = _as_int(fields.get("resting_metabolic_rate"))
        if rmr is not None:
            accumulator.resting_metabolic_rates.append(rmr)
        return

    if message_name == "monitoring_hr_data":
        resting_hr = _as_int(fields.get("resting_heart_rate"))
        if resting_hr is not None:
            accumulator.resting_heart_rates.append(resting_hr)
        return

    if message_name == "stress_level":
        stress = _as_int(fields.get("stress_level_value"))
        if stress is not None and 0 <= stress <= 100:
            accumulator.stress_values.append(stress)
        return

    if message_name == "respiration_rate":
        respiration = _as_float(fields.get("respiration_rate"))
        if respiration is not None and respiration > 0:
            accumulator.respiration_values.append(respiration)
        return

    if message_name == "sleep_level":
        timestamp = _as_datetime(fields.get("timestamp"))
        level = fields.get("sleep_level")
        if timestamp is not None and isinstance(level, str):
            accumulator.sleep_levels.append((timestamp, level))
        return

    if message_name != "monitoring":
        return

    activity_type = str(fields.get("activity_type") or "unknown")
    steps = _as_int(fields.get("steps"))
    if steps is not None:
        accumulator.steps_by_activity[activity_type].append(steps)

    active_calories = _as_int(fields.get("active_calories"))
    if active_calories is not None:
        accumulator.active_calories_by_activity[activity_type].append(active_calories)


def _build_daily_metrics(accumulator: FitArchiveAccumulator) -> dict[str, Any]:
    sleep_metrics = _sleep_metrics(accumulator.sleep_levels)
    active_calories = sum(
        max(values) for values in accumulator.active_calories_by_activity.values()
    )
    resting_metabolic_rate = _max_or_none(accumulator.resting_metabolic_rates)

    metrics = {
        "metric_date": accumulator.metric_date.isoformat(),
        "steps": _sum_activity_maxima(accumulator.steps_by_activity),
        "calories": (
            resting_metabolic_rate + active_calories
            if resting_metabolic_rate is not None
            else None
        ),
        "resting_heart_rate": _last_or_none(accumulator.resting_heart_rates),
        "body_battery": None,
        "stress_avg": _average(accumulator.stress_values),
        "average_respiration_value": _average(accumulator.respiration_values),
        "lowest_respiration_value": _min_or_none(accumulator.respiration_values),
        "vo2max": None,
    }
    metrics.update(sleep_metrics)
    return metrics


def _sleep_metrics(sleep_levels: list[tuple[datetime, str]]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "sleep_seconds": None,
        "deep_sleep_seconds": None,
        "light_sleep_seconds": None,
        "rem_sleep_seconds": None,
        "deep_sleep_percentage": None,
        "rem_sleep_percentage": None,
        "rem_or_deep_sleep_percentage": None,
        "fell_asleep_at": None,
        "woke_up_at": None,
    }
    if not sleep_levels:
        return result

    levels = sorted(set(sleep_levels), key=lambda item: item[0])
    stage_seconds = {key: 0 for key in SLEEP_STAGE_KEYS}
    sleep_start: datetime | None = None
    sleep_end: datetime | None = None

    for index, (timestamp, level) in enumerate(levels):
        end = (
            levels[index + 1][0]
            if index + 1 < len(levels)
            else timestamp + timedelta(minutes=1)
        )
        duration = max(0, int((end - timestamp).total_seconds()))
        normalized_level = level.lower()
        if normalized_level in NON_SLEEP_LEVELS:
            continue
        if normalized_level in stage_seconds:
            stage_seconds[normalized_level] += duration
        sleep_start = sleep_start or timestamp
        sleep_end = end

    sleep_seconds = sum(stage_seconds.values())
    if sleep_seconds <= 0:
        return result

    deep_seconds = stage_seconds["deep"]
    light_seconds = stage_seconds["light"]
    rem_seconds = stage_seconds["rem"]
    result.update(
        {
            "sleep_seconds": sleep_seconds,
            "deep_sleep_seconds": deep_seconds,
            "light_sleep_seconds": light_seconds,
            "rem_sleep_seconds": rem_seconds,
            "deep_sleep_percentage": _percentage(deep_seconds, sleep_seconds),
            "rem_sleep_percentage": _percentage(rem_seconds, sleep_seconds),
            "rem_or_deep_sleep_percentage": _percentage(
                rem_seconds + deep_seconds,
                sleep_seconds,
            ),
            "fell_asleep_at": _datetime_iso(sleep_start),
            "woke_up_at": _datetime_iso(sleep_end),
        }
    )
    return result


def _merge_existing_metrics(
    connection: Any,
    metrics: dict[str, Any],
) -> dict[str, Any]:
    row = connection.execute(
        "SELECT * FROM daily_metrics WHERE metric_date = ?",
        (metrics["metric_date"],),
    ).fetchone()
    if row is None:
        return metrics

    merged = dict(metrics)
    for key in METRIC_KEYS:
        if merged.get(key) is None and key in row.keys():
            merged[key] = row[key]
    return merged


def _archive_metric_date(archive_path: Path) -> date:
    match = ARCHIVE_DATE_PATTERN.search(archive_path.stem)
    if match is None:
        raise ValueError("Garmin wellness zip filename must include YYYY-MM-DD")
    return date.fromisoformat(match.group(0))


def _sum_activity_maxima(values_by_activity: dict[str, list[int]]) -> int | None:
    if not values_by_activity:
        return None
    return sum(max(values) for values in values_by_activity.values() if values)


def _average(values: list[int] | list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _percentage(value: int, total: int) -> float | None:
    return round(value * 100 / total, 2) if total > 0 else None


def _last_or_none(values: list[int]) -> int | None:
    return values[-1] if values else None


def _max_or_none(values: list[int]) -> int | None:
    return max(values) if values else None


def _min_or_none(values: list[float]) -> float | None:
    return min(values) if values else None


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


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return FIT_EPOCH + timedelta(seconds=float(value))
        except (OverflowError, ValueError):
            return None
    return None


def _datetime_iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None
