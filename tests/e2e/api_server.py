from __future__ import annotations

import argparse
import signal
import tempfile
import threading
from datetime import date
from http.server import ThreadingHTTPServer
from pathlib import Path

from src.api import ApiHandler
from src.db import connect_db, init_db, upsert_setting_json, utc_now

TEST_QUESTIONS = [
    {
        "id": "journal",
        "section": "General",
        "prompt": "Journal",
        "inputType": "text",
        "analysisMode": "predictor_next_day",
        "defaultIncluded": True,
    }
]


def seed_database(db_path: str) -> None:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        today = date.today().isoformat()
        connection.execute(
            "INSERT INTO daily_metrics (metric_date, steps, updated_at) VALUES (?, ?, ?)",
            (today, 8_000, utc_now()),
        )
        upsert_setting_json(connection, "checkin_questions", TEST_QUESTIONS)
        connection.commit()
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="garmin-e2e-") as temp_dir:
        db_path = str(Path(temp_dir) / "garmin.db")
        seed_database(db_path)

        class TestApiHandler(ApiHandler):
            pass

        TestApiHandler.db_path = db_path
        server = ThreadingHTTPServer(("127.0.0.1", args.port), TestApiHandler)
        signal.signal(
            signal.SIGTERM,
            lambda *_: threading.Thread(target=server.shutdown, daemon=True).start(),
        )
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
