# garmin-selftracker

Local-first Garmin self-tracking workspace with:
- Python extractor that syncs Garmin Connect data into SQLite
- Python API that serves dashboard-ready data from SQLite
- React 19 daylight "Ceramic Ops" dashboard UI for Today, Explore, Correlation Lab, Check-In, and Settings

## Run with Docker

1. Create env file:

```bash
cp .env.example .env
```

2. Set Garmin credentials in `.env` and email configuration if you want an email reminder:

```bash
GARMIN_EMAIL=you@example.com
GARMIN_PASSWORD=your_password
# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=example@gmail.com
SMTP_PASS=
```

3. Start services:

```bash
docker compose up --build
```

4. Open dashboard:

- [http://localhost:5180](http://localhost:5180)

