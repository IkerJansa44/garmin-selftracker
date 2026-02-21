# garmin-selftracker

Local-first Garmin self-tracking workspace with:
- Python extractor that syncs Garmin Connect data into SQLite
- React 19 daylight "Ceramic Ops" dashboard UI for Today, Explore, Correlation Lab, Check-In, and Settings

## Architecture

- `extractor` service: Python CLI + SQLite ingestion
- `dashboard` service: React 19.2.4 + Tailwind + GSAP + Recharts frontend
- SQLite DB path inside extractor container: `/data/garmin.db`
- SQLite persistence volume: `sqlite_data`

## Run with Docker

1. Create env file:

```bash
cp .env.example .env
```

2. Set Garmin credentials in `.env`:

```bash
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=your_password
```

3. Start services:

```bash
docker compose up --build
```

4. Open dashboard:

- [http://localhost:5180](http://localhost:5180)

## Extractor Commands

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

## Dashboard Data and Persistence Model

- UI uses a deterministic 365-day mock generator for realistic chart behavior:
  - weekly rhythms
  - missing days and import gap simulation
  - lag effects (for example, alcohol -> sleep score down; high intensity -> HRV dip next day)
- LocalStorage is used only for UI state:
  - last view
  - selected metrics
  - range preset
  - explore toggles
  - in-progress check-in draft
- Analytical source of truth is **not** localStorage.
  - Metrics/check-in analysis data is intended to come from SQLite-backed backend flows.

## Daily Import Status Simulation (UI Contract)

The dashboard import status is UI-only and deterministic:
- Scheduled daily at **06:00 local time**
- State labels: `OK`, `Running`, `Failed`
- `Running` window: approximately **05:55-06:30 local** for the current day
- `Failed` is shown on deterministic simulated import-gap days
- Last import timestamp is shown in navbar and settings

## Data Model (SQLite)

- `sync_runs`: run metadata and status
- `raw_garmin_payloads`: one payload per endpoint per day (`UNIQUE(payload_date, endpoint)`)
- `daily_metrics`: normalized daily stats (`PRIMARY KEY(metric_date)`)
- `activities`: normalized activities (`PRIMARY KEY(garmin_activity_id)`)

## Notes

- Sync operations are idempotent via SQLite `ON CONFLICT ... DO UPDATE`.
- Raw JSON payloads are preserved for schema evolution and reprocessing.
- Frontend sources live in `web/`.
