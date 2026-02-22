from __future__ import annotations

import json
import math
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"
REQUIRED_DAILY_METRICS_COLUMNS = {
    "fell_asleep_at": "TEXT",
    "woke_up_at": "TEXT",
    "zone0_minutes": "INTEGER",
    "zone1_minutes": "INTEGER",
    "zone2_minutes": "INTEGER",
    "zone3_minutes": "INTEGER",
    "zone4_minutes": "INTEGER",
    "zone5_minutes": "INTEGER",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect_db(db_path: str) -> sqlite3.Connection:
    db_file = Path(db_path)
    db_file.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_file)
    connection.row_factory = sqlite3.Row
    return connection


def init_db(connection: sqlite3.Connection) -> None:
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    connection.executescript(schema_sql)
    _ensure_daily_metrics_columns(connection)
    connection.commit()


def _ensure_daily_metrics_columns(connection: sqlite3.Connection) -> None:
    existing_columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(daily_metrics)").fetchall()
    }
    for column_name, column_type in REQUIRED_DAILY_METRICS_COLUMNS.items():
        if column_name in existing_columns:
            continue
        connection.execute(
            f"ALTER TABLE daily_metrics ADD COLUMN {column_name} {column_type}"
        )


def create_sync_run(connection: sqlite3.Connection, days_requested: int) -> int:
    cursor = connection.execute(
        """
        INSERT INTO sync_runs (started_at, status, days_requested, days_succeeded)
        VALUES (?, 'running', ?, 0)
        """,
        (utc_now(), days_requested),
    )
    connection.commit()
    return int(cursor.lastrowid)


def finalize_sync_run(
    connection: sqlite3.Connection,
    run_id: int,
    *,
    status: str,
    days_succeeded: int,
    error_message: str | None = None,
) -> None:
    connection.execute(
        """
        UPDATE sync_runs
        SET ended_at = ?, status = ?, days_succeeded = ?, error_message = ?
        WHERE id = ?
        """,
        (utc_now(), status, days_succeeded, error_message, run_id),
    )
    connection.commit()


def update_sync_run_progress(
    connection: sqlite3.Connection,
    run_id: int,
    *,
    days_succeeded: int,
) -> None:
    connection.execute(
        """
        UPDATE sync_runs
        SET days_succeeded = ?
        WHERE id = ?
        """,
        (days_succeeded, run_id),
    )


def upsert_raw_payload(
    connection: sqlite3.Connection,
    *,
    payload_date: str,
    endpoint: str,
    payload: Any,
    sync_run_id: int,
) -> None:
    connection.execute(
        """
        INSERT INTO raw_garmin_payloads
        (payload_date, endpoint, fetched_at, sync_run_id, data_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(payload_date, endpoint) DO UPDATE SET
            fetched_at = excluded.fetched_at,
            sync_run_id = excluded.sync_run_id,
            data_json = excluded.data_json
        """,
        (payload_date, endpoint, utc_now(), sync_run_id, json.dumps(payload)),
    )


def upsert_daily_metrics(
    connection: sqlite3.Connection,
    metrics: dict[str, Any],
) -> None:
    connection.execute(
        """
        INSERT INTO daily_metrics
        (
            metric_date,
            steps,
            calories,
            resting_heart_rate,
            body_battery,
            stress_avg,
            sleep_seconds,
            fell_asleep_at,
            woke_up_at,
            vo2max,
            zone0_minutes,
            zone1_minutes,
            zone2_minutes,
            zone3_minutes,
            zone4_minutes,
            zone5_minutes,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric_date) DO UPDATE SET
            steps = excluded.steps,
            calories = excluded.calories,
            resting_heart_rate = excluded.resting_heart_rate,
            body_battery = excluded.body_battery,
            stress_avg = excluded.stress_avg,
            sleep_seconds = excluded.sleep_seconds,
            fell_asleep_at = excluded.fell_asleep_at,
            woke_up_at = excluded.woke_up_at,
            vo2max = excluded.vo2max,
            zone0_minutes = excluded.zone0_minutes,
            zone1_minutes = excluded.zone1_minutes,
            zone2_minutes = excluded.zone2_minutes,
            zone3_minutes = excluded.zone3_minutes,
            zone4_minutes = excluded.zone4_minutes,
            zone5_minutes = excluded.zone5_minutes,
            updated_at = excluded.updated_at
        """,
        (
            metrics["metric_date"],
            metrics.get("steps"),
            metrics.get("calories"),
            metrics.get("resting_heart_rate"),
            metrics.get("body_battery"),
            metrics.get("stress_avg"),
            metrics.get("sleep_seconds"),
            metrics.get("fell_asleep_at"),
            metrics.get("woke_up_at"),
            metrics.get("vo2max"),
            metrics.get("zone0_minutes"),
            metrics.get("zone1_minutes"),
            metrics.get("zone2_minutes"),
            metrics.get("zone3_minutes"),
            metrics.get("zone4_minutes"),
            metrics.get("zone5_minutes"),
            utc_now(),
        ),
    )


def upsert_activity(connection: sqlite3.Connection, activity: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO activities
        (
            garmin_activity_id,
            activity_name,
            activity_type,
            start_time_local,
            duration_seconds,
            distance_meters,
            average_hr,
            max_hr,
            calories,
            raw_json,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(garmin_activity_id) DO UPDATE SET
            activity_name = excluded.activity_name,
            activity_type = excluded.activity_type,
            start_time_local = excluded.start_time_local,
            duration_seconds = excluded.duration_seconds,
            distance_meters = excluded.distance_meters,
            average_hr = excluded.average_hr,
            max_hr = excluded.max_hr,
            calories = excluded.calories,
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
        """,
        (
            activity["garmin_activity_id"],
            activity.get("activity_name"),
            activity.get("activity_type"),
            activity.get("start_time_local"),
            activity.get("duration_seconds"),
            activity.get("distance_meters"),
            activity.get("average_hr"),
            activity.get("max_hr"),
            activity.get("calories"),
            json.dumps(activity.get("raw_json", {})),
            utc_now(),
        ),
    )


def get_setting_json(connection: sqlite3.Connection, key: str) -> Any | None:
    row = connection.execute(
        "SELECT value_json FROM app_settings WHERE key = ?",
        (key,),
    ).fetchone()
    if row is None:
        return None
    return json.loads(str(row["value_json"]))


def upsert_setting_json(connection: sqlite3.Connection, key: str, value: Any) -> None:
    connection.execute(
        """
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        """,
        (key, json.dumps(value), utc_now()),
    )


def get_hr_zone_bounds(connection: sqlite3.Connection) -> list[int] | None:
    value = get_setting_json(connection, "hr_zone_bounds")
    if isinstance(value, list) and value:
        return [int(v) for v in value]
    return None


def upsert_hr_zone_bounds(connection: sqlite3.Connection, bounds: list[int]) -> None:
    upsert_setting_json(connection, "hr_zone_bounds", bounds)


def upsert_checkin_entry(
    connection: sqlite3.Connection,
    *,
    checkin_date: str,
    answers: dict[str, Any],
    completed_at: str | None = None,
) -> dict[str, Any]:
    completed_timestamp = completed_at or utc_now()
    updated_at = utc_now()
    connection.execute(
        """
        INSERT INTO checkin_entries (checkin_date, answers_json, completed_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(checkin_date) DO UPDATE SET
            answers_json = excluded.answers_json,
            completed_at = excluded.completed_at,
            updated_at = excluded.updated_at
        """,
        (
            checkin_date,
            json.dumps(answers),
            completed_timestamp,
            updated_at,
        ),
    )
    connection.commit()
    return {
        "date": checkin_date,
        "answers": answers,
        "completedAt": completed_timestamp,
    }


def get_checkin_entries(
    connection: sqlite3.Connection,
    *,
    from_date: str,
    to_date: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT checkin_date, answers_json, completed_at
        FROM checkin_entries
        WHERE checkin_date BETWEEN ? AND ?
        ORDER BY checkin_date
        """,
        (from_date, to_date),
    ).fetchall()
    entries: list[dict[str, Any]] = []
    for row in rows:
        entries.append(
            {
                "date": str(row["checkin_date"]),
                "answers": json.loads(str(row["answers_json"])),
                "completedAt": str(row["completed_at"]),
            }
        )
    return entries


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
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _recovery_index(
    resting_hr: int | None, stress_avg: float | None, sleep_seconds: int | None
) -> int | None:
    if resting_hr is None or stress_avg is None:
        return None
    if sleep_seconds is None:
        sleep_term = 0
    else:
        sleep_score = _clamp(50 + (sleep_seconds / 3600 - 4.0) * 10, 40, 100)
        sleep_term = (sleep_score - 70) * 0.3
    value = 95 - resting_hr - stress_avg * 0.6 + sleep_term
    return int(round(_clamp(value, 20, 120)))


def _training_readiness(
    body_battery: int | None,
    sleep_seconds: int | None,
    stress_avg: float | None,
) -> int | None:
    weighted_sum = 0.0
    weight_total = 0.0
    if body_battery is not None:
        weighted_sum += body_battery * 0.45
        weight_total += 0.45
    if sleep_seconds is not None:
        sleep_score = _clamp(50 + (sleep_seconds / 3600 - 4.0) * 10, 40, 100)
        weighted_sum += sleep_score * 0.35
        weight_total += 0.35
    if stress_avg is not None:
        weighted_sum += (100 - stress_avg) * 0.2
        weight_total += 0.2
    if weight_total == 0:
        return None
    return int(round(_clamp(weighted_sum / weight_total, 20, 100)))


def _metric_features_from_daily_metrics_row(
    row: sqlite3.Row,
) -> dict[str, int | None]:
    resting_hr = _as_int(row["resting_heart_rate"])
    body_battery = _as_int(row["body_battery"])
    stress_avg = _as_float(row["stress_avg"])
    sleep_seconds = _as_int(row["sleep_seconds"])
    return {
        "metric:recoveryIndex": _recovery_index(resting_hr, stress_avg, sleep_seconds),
        "metric:restingHr": resting_hr,
        "metric:stress": _as_int(stress_avg),
        "metric:bodyBattery": body_battery,
        "metric:trainingReadiness": _training_readiness(
            body_battery, sleep_seconds, stress_avg
        ),
    }


def _shift_iso_date(value: str, offset_days: int) -> str | None:
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return (parsed + timedelta(days=offset_days)).isoformat()


def _clock_minutes(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds = seconds / 1000
        try:
            parsed = datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
        return parsed.hour * 60 + parsed.minute
    if not isinstance(value, str):
        return None

    stripped = value.strip()
    if not stripped:
        return None
    if stripped.isdigit():
        return _clock_minutes(int(stripped))
    if (
        len(stripped) >= 5
        and stripped[2] == ":"
        and stripped[:2].isdigit()
        and stripped[3:5].isdigit()
    ):
        hours = int(stripped[:2])
        minutes = int(stripped[3:5])
        if hours > 23 or minutes > 59:
            return None
        return hours * 60 + minutes
    try:
        parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.hour * 60 + parsed.minute


def _circular_mean_minutes(values: list[int]) -> float | None:
    if not values:
        return None
    minute_to_radian = (2 * math.pi) / (24 * 60)
    sin_sum = 0.0
    cos_sum = 0.0
    for value in values:
        angle = value * minute_to_radian
        sin_sum += math.sin(angle)
        cos_sum += math.cos(angle)
    if math.hypot(sin_sum, cos_sum) / len(values) < 1e-9:
        return None
    angle = math.atan2(sin_sum, cos_sum)
    if angle < 0:
        angle += 2 * math.pi
    return angle * (24 * 60) / (2 * math.pi)


def _circular_signed_delta_minutes(value: int, mean_minutes: float) -> float:
    return ((value - mean_minutes + 720) % 1440) - 720


def _circular_stddev_minutes(values: list[int]) -> float | None:
    if not values:
        return None
    mean_minutes = _circular_mean_minutes(values)
    if mean_minutes is None:
        return None
    variance = sum(
        _circular_signed_delta_minutes(value, mean_minutes) ** 2 for value in values
    ) / len(values)
    return math.sqrt(variance)


def _meal_to_sleep_gap_minutes(meal_minutes: int, sleep_minutes: int) -> int:
    if sleep_minutes >= meal_minutes:
        return sleep_minutes - meal_minutes
    return 24 * 60 - meal_minutes + sleep_minutes


def build_sleep_consistency_by_source_date(
    daily_metric_rows: list[sqlite3.Row],
) -> dict[str, float]:
    minutes_by_source_date: dict[str, tuple[int, int]] = {}
    for row in daily_metric_rows:
        metric_date = row["metric_date"]
        if metric_date is None:
            continue
        source_date = _shift_iso_date(str(metric_date), -1)
        if source_date is None:
            continue
        fell_asleep_minutes = _clock_minutes(row["fell_asleep_at"])
        woke_up_minutes = _clock_minutes(row["woke_up_at"])
        if fell_asleep_minutes is None or woke_up_minutes is None:
            continue
        minutes_by_source_date[source_date] = (fell_asleep_minutes, woke_up_minutes)

    candidate_source_dates = {
        shifted
        for source_date in minutes_by_source_date
        if (shifted := _shift_iso_date(source_date, 1)) is not None
    }
    consistency_by_source_date: dict[str, float] = {}
    for source_date in sorted(candidate_source_dates):
        baseline_dates = [
            shifted
            for offset in range(7, 0, -1)
            if (shifted := _shift_iso_date(source_date, -offset)) is not None
        ]
        if len(baseline_dates) != 7:
            continue

        baseline_minutes = [
            minutes_by_source_date.get(baseline_date)
            for baseline_date in baseline_dates
        ]
        if any(value is None for value in baseline_minutes):
            continue
        typed_baseline_minutes = [
            value for value in baseline_minutes if value is not None
        ]

        sleep_stddev = _circular_stddev_minutes(
            [value[0] for value in typed_baseline_minutes]
        )
        wake_stddev = _circular_stddev_minutes(
            [value[1] for value in typed_baseline_minutes]
        )
        if sleep_stddev is None or wake_stddev is None:
            continue
        consistency_by_source_date[source_date] = (sleep_stddev + wake_stddev) / 2

    return consistency_by_source_date


def _analysis_value_columns(
    value: Any,
) -> tuple[float | None, str | None, int | None] | None:
    if isinstance(value, bool):
        return (None, None, 1 if value else 0)
    if isinstance(value, (int, float)):
        numeric = _as_float(value)
        return (numeric, None, None) if numeric is not None else None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        return (None, stripped, None)
    return None


def _append_analysis_row(
    rows: list[tuple[Any, ...]],
    *,
    analysis_date: str,
    role: str,
    feature_key: str,
    value_num: float | None,
    value_text: str | None,
    value_bool: int | None,
    source_date: str,
    lag_days: int,
    alignment_rule: str,
    refreshed_at: str,
) -> None:
    rows.append(
        (
            analysis_date,
            role,
            feature_key,
            value_num,
            value_text,
            value_bool,
            source_date,
            lag_days,
            alignment_rule,
            refreshed_at,
        )
    )


def rebuild_analysis_values(connection: sqlite3.Connection) -> None:
    refreshed_at = utc_now()
    rows_to_insert: list[tuple[Any, ...]] = []

    connection.execute("DELETE FROM analysis_values")

    training_days: dict[str, int] = {}
    for row in connection.execute(
        """
        SELECT substr(start_time_local, 1, 10) AS activity_date, COUNT(*) AS activity_count
        FROM activities
        WHERE start_time_local IS NOT NULL
        GROUP BY activity_date
        """
    ).fetchall():
        activity_date = row["activity_date"]
        if activity_date is None:
            continue
        training_days[str(activity_date)] = (
            1 if row["activity_count"] and int(row["activity_count"]) > 0 else 0
        )

    daily_metric_rows = connection.execute(
        """
        SELECT
            metric_date,
            steps,
            calories,
            stress_avg,
            body_battery,
            sleep_seconds,
            resting_heart_rate,
            fell_asleep_at,
            woke_up_at
        FROM daily_metrics
        ORDER BY metric_date
        """
    ).fetchall()
    sleep_consistency_by_source_date = build_sleep_consistency_by_source_date(
        daily_metric_rows
    )
    sleep_start_minutes_by_metric_date = {
        str(row["metric_date"]): _clock_minutes(row["fell_asleep_at"])
        for row in daily_metric_rows
        if row["metric_date"] is not None
    }

    for row in daily_metric_rows:
        source_date = str(row["metric_date"])
        predictor_analysis_date = _shift_iso_date(source_date, 1)

        if predictor_analysis_date is not None:
            for feature_key, column_name in (
                ("garmin:steps", "steps"),
                ("garmin:calories", "calories"),
                ("garmin:stressAvg", "stress_avg"),
                ("garmin:bodyBattery", "body_battery"),
            ):
                value_num = _as_float(row[column_name])
                if value_num is None:
                    continue
                _append_analysis_row(
                    rows_to_insert,
                    analysis_date=predictor_analysis_date,
                    role="predictor",
                    feature_key=feature_key,
                    value_num=value_num,
                    value_text=None,
                    value_bool=None,
                    source_date=source_date,
                    lag_days=-1,
                    alignment_rule="garmin_previous_day",
                    refreshed_at=refreshed_at,
                )

            sleep_seconds = _as_float(row["sleep_seconds"])
            sleep_source_date = _shift_iso_date(source_date, -1)
            if sleep_seconds is not None and sleep_source_date is not None:
                _append_analysis_row(
                    rows_to_insert,
                    analysis_date=source_date,
                    role="predictor",
                    feature_key="garmin:sleepSeconds",
                    value_num=sleep_seconds,
                    value_text=None,
                    value_bool=None,
                    source_date=sleep_source_date,
                    lag_days=-1,
                    alignment_rule="garmin_sleep_previous_night",
                    refreshed_at=refreshed_at,
                )
            sleep_consistency = (
                sleep_consistency_by_source_date.get(sleep_source_date)
                if sleep_source_date is not None
                else None
            )
            if sleep_consistency is not None and sleep_source_date is not None:
                _append_analysis_row(
                    rows_to_insert,
                    analysis_date=source_date,
                    role="predictor",
                    feature_key="garmin:sleepConsistency",
                    value_num=sleep_consistency,
                    value_text=None,
                    value_bool=None,
                    source_date=sleep_source_date,
                    lag_days=-1,
                    alignment_rule="garmin_previous_day",
                    refreshed_at=refreshed_at,
                )

            _append_analysis_row(
                rows_to_insert,
                analysis_date=predictor_analysis_date,
                role="predictor",
                feature_key="garmin:isTrainingDay",
                value_num=None,
                value_text=None,
                value_bool=training_days.get(source_date, 0),
                source_date=source_date,
                lag_days=-1,
                alignment_rule="training_previous_day",
                refreshed_at=refreshed_at,
            )

        for feature_key, value in _metric_features_from_daily_metrics_row(row).items():
            if value is None:
                continue
            _append_analysis_row(
                rows_to_insert,
                analysis_date=source_date,
                role="target",
                feature_key=feature_key,
                value_num=float(value),
                value_text=None,
                value_bool=None,
                source_date=source_date,
                lag_days=0,
                alignment_rule="metric_same_day",
                refreshed_at=refreshed_at,
            )

    checkin_rows = connection.execute(
        """
        SELECT checkin_date, answers_json
        FROM checkin_entries
        ORDER BY checkin_date
        """
    ).fetchall()

    for row in checkin_rows:
        source_date = str(row["checkin_date"])
        predictor_analysis_date = _shift_iso_date(source_date, 1)
        try:
            answers = json.loads(str(row["answers_json"]))
        except json.JSONDecodeError:
            continue
        if not isinstance(answers, dict):
            continue

        for raw_key, raw_value in answers.items():
            if not isinstance(raw_key, str):
                continue
            key = raw_key.strip()
            if not key:
                continue
            value_columns = _analysis_value_columns(raw_value)
            if value_columns is None:
                continue
            value_num, value_text, value_bool = value_columns
            feature_key = f"question:{key}"

            _append_analysis_row(
                rows_to_insert,
                analysis_date=source_date,
                role="target",
                feature_key=feature_key,
                value_num=value_num,
                value_text=value_text,
                value_bool=value_bool,
                source_date=source_date,
                lag_days=0,
                alignment_rule="checkin_same_day",
                refreshed_at=refreshed_at,
            )

            if predictor_analysis_date is None:
                continue
            _append_analysis_row(
                rows_to_insert,
                analysis_date=predictor_analysis_date,
                role="predictor",
                feature_key=feature_key,
                value_num=value_num,
                value_text=value_text,
                value_bool=value_bool,
                source_date=source_date,
                lag_days=-1,
                alignment_rule="checkin_previous_day",
                refreshed_at=refreshed_at,
            )

        if predictor_analysis_date is None:
            continue
        meal_minutes = _clock_minutes(answers.get("late_meal"))
        sleep_minutes = sleep_start_minutes_by_metric_date.get(predictor_analysis_date)
        if meal_minutes is None or sleep_minutes is None:
            continue
        _append_analysis_row(
            rows_to_insert,
            analysis_date=predictor_analysis_date,
            role="predictor",
            feature_key="garmin:mealToSleepGapMinutes",
            value_num=float(_meal_to_sleep_gap_minutes(meal_minutes, sleep_minutes)),
            value_text=None,
            value_bool=None,
            source_date=source_date,
            lag_days=-1,
            alignment_rule="meal_sleep_gap_previous_day",
            refreshed_at=refreshed_at,
        )

    if rows_to_insert:
        connection.executemany(
            """
            INSERT INTO analysis_values (
                analysis_date,
                role,
                feature_key,
                value_num,
                value_text,
                value_bool,
                source_date,
                lag_days,
                alignment_rule,
                refreshed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows_to_insert,
        )
    connection.commit()


def get_analysis_values(
    connection: sqlite3.Connection, *, from_date: str, to_date: str
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
            analysis_date,
            role,
            feature_key,
            value_num,
            value_text,
            value_bool,
            source_date,
            lag_days,
            alignment_rule
        FROM analysis_values
        WHERE analysis_date BETWEEN ? AND ?
        ORDER BY analysis_date, role, feature_key
        """,
        (from_date, to_date),
    ).fetchall()
    values: list[dict[str, Any]] = []
    for row in rows:
        value_bool: bool | None
        if row["value_bool"] is None:
            value_bool = None
        else:
            value_bool = bool(int(row["value_bool"]))
        values.append(
            {
                "analysisDate": str(row["analysis_date"]),
                "role": str(row["role"]),
                "featureKey": str(row["feature_key"]),
                "valueNum": (
                    float(row["value_num"]) if row["value_num"] is not None else None
                ),
                "valueText": (
                    str(row["value_text"]) if row["value_text"] is not None else None
                ),
                "valueBool": value_bool,
                "sourceDate": str(row["source_date"]),
                "lagDays": int(row["lag_days"]),
                "alignmentRule": str(row["alignment_rule"]),
            }
        )
    return values
