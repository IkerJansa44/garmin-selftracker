from __future__ import annotations

import json
from pathlib import Path

from src.db import (
    connect_db,
    create_sync_run,
    finalize_sync_run,
    get_checkin_entries,
    get_setting_json,
    init_db,
    update_sync_run_progress,
    upsert_activity,
    upsert_checkin_entry,
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
            "deep_sleep_seconds": 5400,
            "light_sleep_seconds": 15600,
            "rem_sleep_seconds": 3000,
            "deep_sleep_percentage": 22.5,
            "rem_sleep_percentage": 12.5,
            "rem_or_deep_sleep_percentage": 35.0,
            "average_respiration_value": 12.0,
            "lowest_respiration_value": 9.0,
            "fell_asleep_at": "2026-02-19T23:22:00+00:00",
            "woke_up_at": "2026-02-20T06:44:00+00:00",
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
            "deep_sleep_seconds": 6300,
            "light_sleep_seconds": 14800,
            "rem_sleep_seconds": 3900,
            "deep_sleep_percentage": 25.2,
            "rem_sleep_percentage": 15.6,
            "rem_or_deep_sleep_percentage": 40.8,
            "average_respiration_value": 11.5,
            "lowest_respiration_value": 8.5,
            "fell_asleep_at": "2026-02-19T23:11:00+00:00",
            "woke_up_at": "2026-02-20T06:30:00+00:00",
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
        SELECT
            steps,
            deep_sleep_seconds,
            light_sleep_seconds,
            rem_sleep_seconds,
            deep_sleep_percentage,
            rem_sleep_percentage,
            rem_or_deep_sleep_percentage,
            average_respiration_value,
            lowest_respiration_value,
            fell_asleep_at,
            woke_up_at
        FROM daily_metrics
        WHERE metric_date = '2026-02-20'
        """
    ).fetchone()
    assert metric_row[0] == 3000
    assert metric_row[1] == 6300
    assert metric_row[2] == 14800
    assert metric_row[3] == 3900
    assert metric_row[4] == 25.2
    assert metric_row[5] == 15.6
    assert metric_row[6] == 40.8
    assert metric_row[7] == 11.5
    assert metric_row[8] == 8.5
    fell_asleep_at = metric_row[9]
    woke_up_at = metric_row[10]
    assert fell_asleep_at == "2026-02-19T23:11:00+00:00"
    assert woke_up_at == "2026-02-20T06:30:00+00:00"

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


def test_update_sync_run_progress_updates_running_row(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    conn = connect_db(str(db_path))
    init_db(conn)

    run_id = create_sync_run(conn, days_requested=3)
    update_sync_run_progress(conn, run_id, days_succeeded=2)
    conn.commit()

    row = conn.execute(
        """
        SELECT status, days_requested, days_succeeded
        FROM sync_runs
        WHERE id = ?
        """,
        (run_id,),
    ).fetchone()
    assert row is not None
    assert row["status"] == "running"
    assert row["days_requested"] == 3
    assert row["days_succeeded"] == 2

    conn.close()


def test_checkin_entries_upsert_and_query(tmp_path: Path) -> None:
    db_path = tmp_path / "garmin.db"
    conn = connect_db(str(db_path))
    init_db(conn)

    upsert_checkin_entry(
        conn,
        checkin_date="2026-02-20",
        answers={"energy": 7, "late_meal": "21:30"},
    )
    upsert_checkin_entry(
        conn,
        checkin_date="2026-02-20",
        answers={"energy": 8, "late_meal": "20:50"},
    )
    upsert_checkin_entry(
        conn,
        checkin_date="2026-02-21",
        answers={"energy": 6, "late_meal": "22:10"},
    )

    entries = get_checkin_entries(
        conn,
        from_date="2026-02-20",
        to_date="2026-02-21",
    )
    assert len(entries) == 2
    assert entries[0]["date"] == "2026-02-20"
    assert entries[0]["answers"] == {"energy": 8, "late_meal": "20:50"}
    assert entries[1]["date"] == "2026-02-21"
    assert entries[1]["answers"] == {"energy": 6, "late_meal": "22:10"}

    conn.close()
