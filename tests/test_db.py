from __future__ import annotations

import json
from pathlib import Path

from src.db import (
    connect_db,
    create_sync_run,
    finalize_sync_run,
    get_setting_json,
    init_db,
    upsert_activity,
    upsert_daily_metrics,
    upsert_raw_payload,
    upsert_setting_json,
)


def test_upserts_are_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    conn = connect_db(str(db_path))
    init_db(conn)

    run_id = create_sync_run(conn, days_requested=1)
    upsert_raw_payload(
        conn,
        payload_date="2026-02-20",
        endpoint="stats",
        payload={"totalSteps": 1000},
        sync_run_id=run_id,
    )
    upsert_raw_payload(
        conn,
        payload_date="2026-02-20",
        endpoint="stats",
        payload={"totalSteps": 2000},
        sync_run_id=run_id,
    )

    upsert_daily_metrics(
        conn,
        {
            "metric_date": "2026-02-20",
            "steps": 1000,
            "calories": 2000,
            "resting_heart_rate": 50,
            "body_battery": 60,
            "stress_avg": 30,
            "sleep_seconds": 24000,
            "fell_asleep_at": "2026-02-19T23:22:00+00:00",
            "vo2max": 48,
        },
    )
    upsert_daily_metrics(
        conn,
        {
            "metric_date": "2026-02-20",
            "steps": 3000,
            "calories": 2200,
            "resting_heart_rate": 49,
            "body_battery": 62,
            "stress_avg": 28,
            "sleep_seconds": 25000,
            "fell_asleep_at": "2026-02-19T23:11:00+00:00",
            "vo2max": 49,
        },
    )

    upsert_activity(
        conn,
        {
            "garmin_activity_id": 1,
            "activity_name": "Morning Run",
            "activity_type": "running",
            "start_time_local": "2026-02-20T07:00:00",
            "duration_seconds": 1800,
            "distance_meters": 5000,
            "average_hr": 150,
            "max_hr": 170,
            "calories": 350,
            "raw_json": {"activityId": 1, "activityName": "Morning Run"},
        },
    )
    upsert_activity(
        conn,
        {
            "garmin_activity_id": 1,
            "activity_name": "Morning Run Updated",
            "activity_type": "running",
            "start_time_local": "2026-02-20T07:00:00",
            "duration_seconds": 1800,
            "distance_meters": 5200,
            "average_hr": 151,
            "max_hr": 170,
            "calories": 360,
            "raw_json": {"activityId": 1, "activityName": "Morning Run Updated"},
        },
    )

    finalize_sync_run(conn, run_id, status="success", days_succeeded=1)
    conn.commit()

    raw_count = conn.execute("SELECT COUNT(*) FROM raw_garmin_payloads").fetchone()[0]
    assert raw_count == 1

    metric_row = conn.execute(
        """
        SELECT steps, fell_asleep_at
        FROM daily_metrics
        WHERE metric_date = '2026-02-20'
        """
    ).fetchone()
    assert metric_row[0] == 3000
    fell_asleep_at = metric_row[1]
    assert fell_asleep_at == "2026-02-19T23:11:00+00:00"

    activity_row = conn.execute(
        "SELECT activity_name, distance_meters, raw_json FROM activities WHERE garmin_activity_id = 1"
    ).fetchone()
    assert activity_row[0] == "Morning Run Updated"
    assert activity_row[1] == 5200
    assert json.loads(activity_row[2])["activityName"] == "Morning Run Updated"

    conn.close()


def test_setting_json_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    conn = connect_db(str(db_path))
    init_db(conn)

    upsert_setting_json(
        conn, "checkin_questions", [{"id": "q1", "prompt": "Question 1"}]
    )
    upsert_setting_json(
        conn, "checkin_questions", [{"id": "q2", "prompt": "Question 2"}]
    )

    stored = get_setting_json(conn, "checkin_questions")
    assert stored == [{"id": "q2", "prompt": "Question 2"}]

    conn.close()
