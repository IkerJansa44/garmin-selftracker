from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta

from src.db import (
    backfill_zone_minutes,
    connect_db,
    create_sync_run,
    finalize_sync_run,
    get_hr_zone_bounds,
    init_db,
    update_sync_run_progress,
    upsert_activity,
    upsert_daily_metrics,
    upsert_hr_zone_bounds,
    upsert_raw_payload,
)
from src.garmin_client import (
    GarminConnectAdapter,
    compute_zone_minutes,
    normalize_activities,
    normalize_daily_metrics,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SyncResult:
    run_id: int
    days_requested: int
    days_succeeded: int
    status: str


def date_span(start_date: date, end_date: date) -> list[date]:
    if end_date < start_date:
        raise ValueError("end_date must be on or after start_date")

    return [
        start_date + timedelta(days=offset)
        for offset in range((end_date - start_date).days + 1)
    ]


def run_sync(
    *,
    db_path: str,
    garmin_email: str,
    garmin_password: str,
    start_date: date,
    end_date: date,
) -> SyncResult:
    days = date_span(start_date, end_date)
    connection = connect_db(db_path)
    init_db(connection)

    run_id = create_sync_run(connection, days_requested=len(days))
    days_succeeded = 0
    status = "success"
    error_message = None

    adapter = GarminConnectAdapter(garmin_email, garmin_password)

    try:
        adapter.login()
        zone_bounds: list[int] | None = get_hr_zone_bounds(connection)

        # Bootstrap zone bounds from recent activities if not yet stored
        if zone_bounds is None:
            bootstrapped = adapter.fetch_hr_zones_from_recent_activities()
            if bootstrapped:
                zone_bounds = bootstrapped
                upsert_hr_zone_bounds(connection, zone_bounds)
                connection.commit()
                logger.info("Bootstrapped HR zone bounds: %s", zone_bounds)
                # Backfill zone minutes for all already-synced days
                filled = backfill_zone_minutes(connection, zone_bounds)
                connection.commit()
                logger.info("Backfilled zone minutes for %d days", filled)

        for day in days:
            day_payload = adapter.fetch_day(day)

            for endpoint, payload in day_payload.endpoints.items():
                upsert_raw_payload(
                    connection,
                    payload_date=day.isoformat(),
                    endpoint=endpoint,
                    payload=payload,
                    sync_run_id=run_id,
                )

            # Update zone bounds from the first activity that returns valid bounds
            activities_payload = day_payload.endpoints.get("activities")
            if isinstance(activities_payload, list):
                for act in activities_payload:
                    if isinstance(act, dict) and act.get("activityId"):
                        fetched = adapter.fetch_hr_zones(int(act["activityId"]))
                        if fetched:
                            if fetched != zone_bounds:
                                zone_bounds = fetched
                                upsert_hr_zone_bounds(connection, zone_bounds)
                            break

            metrics = normalize_daily_metrics(day_payload)
            if zone_bounds is not None:
                metrics.update(
                    compute_zone_minutes(day_payload.endpoints.get("heart_rates"), zone_bounds)
                )
            upsert_daily_metrics(connection, metrics)
            for activity in normalize_activities(day_payload):
                upsert_activity(connection, activity)

            days_succeeded += 1
            update_sync_run_progress(
                connection,
                run_id=run_id,
                days_succeeded=days_succeeded,
            )
            connection.commit()
            logger.info("Synced %s", day.isoformat())
    except Exception as exc:
        connection.rollback()
        status = "failed"
        error_message = str(exc)
        logger.exception("Sync run failed")
    finally:
        if status == "success" and days_succeeded != len(days):
            status = "partial"
        finalize_sync_run(
            connection,
            run_id,
            status=status,
            days_succeeded=days_succeeded,
            error_message=error_message,
        )
        connection.close()

    return SyncResult(
        run_id=run_id,
        days_requested=len(days),
        days_succeeded=days_succeeded,
        status=status,
    )
