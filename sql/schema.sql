PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    days_requested INTEGER NOT NULL,
    days_succeeded INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS raw_garmin_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload_date TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    sync_run_id INTEGER,
    data_json TEXT NOT NULL,
    FOREIGN KEY (sync_run_id) REFERENCES sync_runs (id),
    UNIQUE (payload_date, endpoint)
);

CREATE TABLE IF NOT EXISTS daily_metrics (
    metric_date TEXT PRIMARY KEY,
    steps INTEGER,
    calories INTEGER,
    resting_heart_rate INTEGER,
    body_battery INTEGER,
    stress_avg REAL,
    sleep_seconds INTEGER,
    fell_asleep_at TEXT,
    woke_up_at TEXT,
    vo2max REAL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
    garmin_activity_id INTEGER PRIMARY KEY,
    activity_name TEXT,
    activity_type TEXT,
    start_time_local TEXT,
    duration_seconds REAL,
    distance_meters REAL,
    average_hr REAL,
    max_hr REAL,
    calories REAL,
    raw_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkin_entries (
    checkin_date TEXT PRIMARY KEY,
    answers_json TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_values (
    analysis_date TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('predictor', 'target')),
    feature_key TEXT NOT NULL,
    value_num REAL,
    value_text TEXT,
    value_bool INTEGER,
    source_date TEXT NOT NULL,
    lag_days INTEGER NOT NULL,
    alignment_rule TEXT NOT NULL,
    refreshed_at TEXT NOT NULL,
    PRIMARY KEY (analysis_date, role, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_analysis_values_feature
ON analysis_values (feature_key, role, analysis_date);
