# garmin-selftracker

Local-first Garmin self-tracking workspace with:
- Python extractor that syncs Garmin Connect data into SQLite
- Python API that serves dashboard-ready data from SQLite
- React 19 daylight "Ceramic Ops" dashboard UI for Today, Explore, Correlation Lab, Check-In, and Settings

## Architecture

- `extractor` service: Python CLI + SQLite ingestion
- `api` service: Python HTTP API over SQLite (`/api/dashboard`)
- `dashboard` service: React 19.2.4 + Tailwind + GSAP + Recharts frontend
- SQLite DB path inside extractor container: `/data/garmin.db`
- SQLite host file path: `/Users/ikerjansa/Documents/garmin-selftracker/data/garmin.db`

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

The dashboard fetches `/api/dashboard` through the Vite dev proxy and renders
actual SQLite-backed Garmin data.

DBeaver JDBC URL:
- `jdbc:sqlite:/Users/ikerjansa/Documents/garmin-selftracker/data/garmin.db`

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

- UI reads real records from SQLite through the `api` service:
  - `daily_metrics` powers daily metric series
  - `activities` powers training-day flags
  - `sync_runs` powers import state + last import timestamp
- Metrics not directly present in the extractor schema (`sleepScore`, `recoveryIndex`, `trainingReadiness`)
    are deterministically derived from available SQLite fields for UI continuity.
- LocalStorage is used only for UI state:
  - last view
  - selected metrics
  - range preset
  - explore toggles
  - in-progress check-in draft
- Analytical source of truth is **not** localStorage.
  - Metrics/check-in analysis data comes from SQLite-backed backend flows.

## Daily Import Status

Import status in the UI is sourced from `sync_runs`:
- `OK`: latest run status is success/partial
- `Running`: latest run status is running
- `Failed`: latest run status is failed (or no data available)
- Last import timestamp comes from latest run `ended_at` (or `started_at` when running)

## Data Model (SQLite)

- `sync_runs`: run metadata and status
- `raw_garmin_payloads`: one payload per endpoint per day (`UNIQUE(payload_date, endpoint)`)
- `daily_metrics`: normalized daily stats (`PRIMARY KEY(metric_date)`)
- `activities`: normalized activities (`PRIMARY KEY(garmin_activity_id)`)

## Notes

- Sync operations are idempotent via SQLite `ON CONFLICT ... DO UPDATE`.
- Raw JSON payloads are preserved for schema evolution and reprocessing.
- Frontend sources live in `web/`.
