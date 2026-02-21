# garmin-selftracker

Local-first app that imports Garmin Connect data into SQLite for later behavior and health correlation analysis.

## Current scope

- Data extraction from Garmin Connect
- Persistent local storage in SQLite (Docker volume)
- Raw payload storage for reprocessing
- Normalized tables for daily metrics and activities

## Architecture

- `extractor` service runs Python CLI commands
- SQLite DB path inside container: `/data/garmin.db`
- Docker named volume `sqlite_data` persists the database

## Setup

1. Create env file:

```bash
cp .env.example .env
```

2. Set Garmin credentials in `.env`:

```bash
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=your_password
```

3. Build image:

```bash
docker compose build
```

## Commands

Initialize DB schema:

```bash
docker compose run --rm extractor python -m src.cli init-db
```

Sync latest 2 days:

```bash
docker compose run --rm extractor python -m src.cli sync --days 2
```

Backfill date range:

```bash
docker compose run --rm extractor python -m src.cli backfill --from-date 2026-01-01 --to-date 2026-01-31
```

## Tables

- `sync_runs`: run metadata and status
- `raw_garmin_payloads`: one payload per endpoint per day (`UNIQUE(payload_date, endpoint)`)
- `daily_metrics`: normalized daily stats (`PRIMARY KEY(metric_date)`)
- `activities`: normalized activities (`PRIMARY KEY(garmin_activity_id)`)

## Notes

- Sync operations are idempotent via SQLite `ON CONFLICT ... DO UPDATE`.
- Raw JSON payloads are preserved for schema evolution and reprocessing.
