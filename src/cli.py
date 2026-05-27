from __future__ import annotations

import argparse
import logging
from datetime import date, timedelta

from src.config import Settings, SettingsError, load_settings
from src.correlation_notifications import (
    CorrelationEmailSettings,
    current_meaningful_correlation_keys,
    notify_new_meaningful_correlations,
)
from src.db import connect_db, init_db
from src.manual_import import run_manual_import_dir
from src.sync import run_sync


def parse_date(date_value: str) -> date:
    return date.fromisoformat(date_value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Garmin Connect extraction CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init-db", help="Create SQLite schema")

    sync_parser = subparsers.add_parser("sync", help="Sync the latest N days")
    sync_parser.add_argument(
        "--days",
        type=int,
        help="Number of days to sync (inclusive of today)",
    )

    backfill_parser = subparsers.add_parser("backfill", help="Sync a fixed date range")
    backfill_parser.add_argument("--from-date", type=parse_date, required=True)
    backfill_parser.add_argument("--to-date", type=parse_date, required=True)

    manual_parser = subparsers.add_parser(
        "import-manual",
        help="Import Garmin wellness zip files from the manual import folder",
    )
    manual_parser.add_argument(
        "--path",
        help="Folder containing Garmin wellness .zip files",
    )

    return parser


def _correlation_email_settings(settings: Settings) -> CorrelationEmailSettings:
    return CorrelationEmailSettings(
        db_path=settings.db_path,
        smtp_host=settings.smtp_host,
        smtp_port=settings.smtp_port,
        smtp_user=settings.smtp_user,
        smtp_pass=settings.smtp_pass,
        recipient_email=settings.garmin_email,
        dashboard_url=settings.dashboard_url,
    )


def _current_meaningful_correlation_keys(db_path: str) -> set[str] | None:
    try:
        return current_meaningful_correlation_keys(db_path)
    except Exception:
        logging.exception("Failed to scan meaningful correlations before import")
        return None


def _notify_new_meaningful_correlations(
    settings: Settings,
    *,
    previous_keys: set[str] | None,
) -> None:
    try:
        notify_new_meaningful_correlations(
            _correlation_email_settings(settings),
            previous_keys=previous_keys,
        )
    except Exception:
        logging.exception("Failed to send meaningful correlation notification")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "init-db":
        settings = load_settings(require_garmin_credentials=False)
        connection = connect_db(settings.db_path)
        init_db(connection)
        connection.close()
        logging.info("Database initialized at %s", settings.db_path)
        return 0

    if args.command == "import-manual":
        settings = load_settings(require_garmin_credentials=False)
        previous_correlation_keys = _current_meaningful_correlation_keys(
            settings.db_path
        )
        result = run_manual_import_dir(
            db_path=settings.db_path,
            import_dir=args.path or settings.garmin_manual_import_dir,
        )
        if result.status != "failed" and result.days_imported > 0:
            _notify_new_meaningful_correlations(
                settings,
                previous_keys=previous_correlation_keys,
            )
        logging.info(
            "Manual import run %s finished with status=%s (%s/%s archives)",
            result.run_id,
            result.status,
            result.archives_imported,
            result.archives_found,
        )
        return 0 if result.status == "success" else 1

    try:
        settings = load_settings(require_garmin_credentials=True)
    except SettingsError as exc:
        logging.error(str(exc))
        return 1

    if args.command == "sync":
        days = args.days or settings.default_sync_days
        if days < 1:
            logging.error("--days must be >= 1")
            return 1
        end_date = date.today()
        start_date = end_date - timedelta(days=days - 1)
    elif args.command == "backfill":
        start_date = args.from_date
        end_date = args.to_date
    else:  # pragma: no cover - argparse enforces commands
        logging.error("Unknown command")
        return 1

    previous_correlation_keys = _current_meaningful_correlation_keys(settings.db_path)
    result = run_sync(
        db_path=settings.db_path,
        garmin_email=settings.garmin_email,
        garmin_password=settings.garmin_password,
        garmin_tokenstore=settings.garmin_tokenstore,
        start_date=start_date,
        end_date=end_date,
    )
    if result.status != "failed" and result.days_succeeded > 0:
        _notify_new_meaningful_correlations(
            settings,
            previous_keys=previous_correlation_keys,
        )
    logging.info(
        "Sync run %s finished with status=%s (%s/%s days)",
        result.run_id,
        result.status,
        result.days_succeeded,
        result.days_requested,
    )
    return 0 if result.status == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
