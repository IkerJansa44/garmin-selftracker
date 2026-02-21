from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"


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
    connection.commit()


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
            vo2max,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric_date) DO UPDATE SET
            steps = excluded.steps,
            calories = excluded.calories,
            resting_heart_rate = excluded.resting_heart_rate,
            body_battery = excluded.body_battery,
            stress_avg = excluded.stress_avg,
            sleep_seconds = excluded.sleep_seconds,
            vo2max = excluded.vo2max,
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
            metrics.get("vo2max"),
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
