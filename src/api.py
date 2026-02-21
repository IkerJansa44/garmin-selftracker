from __future__ import annotations

import argparse
import errno
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from src.config import load_settings
from src.db import connect_db, get_setting_json, init_db, upsert_setting_json

logger = logging.getLogger(__name__)
QUESTION_SETTINGS_KEY = "checkin_questions"
QUESTION_INPUT_TYPES = {"slider", "multi-choice", "boolean", "time", "text"}


@dataclass(frozen=True)
class ApiSettings:
    db_path: str
    host: str
    port: int


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sleep_score(sleep_seconds: int | None) -> int | None:
    if sleep_seconds is None:
        return None
    hours = sleep_seconds / 3600
    score = 50 + (hours - 4.0) * 10
    return int(round(_clamp(score, 40, 100)))


def _recovery_index(
    resting_hr: int | None, stress_avg: float | None, sleep_score: int | None
) -> int | None:
    if resting_hr is None or stress_avg is None:
        return None
    sleep_term = 0 if sleep_score is None else (sleep_score - 70) * 0.3
    value = 95 - resting_hr - stress_avg * 0.6 + sleep_term
    return int(round(_clamp(value, 20, 120)))


def _training_readiness(
    body_battery: int | None,
    sleep_score: int | None,
    stress_avg: float | None,
) -> int | None:
    weighted_sum = 0.0
    weight_total = 0.0

    if body_battery is not None:
        weighted_sum += body_battery * 0.45
        weight_total += 0.45
    if sleep_score is not None:
        weighted_sum += sleep_score * 0.35
        weight_total += 0.35
    if stress_avg is not None:
        weighted_sum += (100 - stress_avg) * 0.20
        weight_total += 0.20

    if weight_total == 0:
        return None

    value = weighted_sum / weight_total
    return int(round(_clamp(value, 20, 100)))


def _parse_days(query: dict[str, list[str]]) -> int:
    values = query.get("days", ["365"])
    try:
        parsed = int(values[0])
    except (TypeError, ValueError):
        return 365
    return max(7, min(365, parsed))


def _coverage(row_exists: bool, value: Any) -> str:
    if not row_exists:
        return "missing"
    return "complete" if value is not None else "partial"


def _as_clock_time(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds = seconds / 1000
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%H:%M")
        except (OSError, OverflowError, ValueError):
            return None
    if not isinstance(value, str):
        return None

    stripped = value.strip()
    if not stripped:
        return None
    if stripped.isdigit():
        return _as_clock_time(int(stripped))
    if (
        len(stripped) >= 5
        and stripped[2] == ":"
        and stripped[:2].isdigit()
        and stripped[3:5].isdigit()
    ):
        return stripped[:5]

    try:
        normalized = stripped.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).strftime("%H:%M")
    except ValueError:
        return None


def _metric_payload(row: Any | None) -> tuple[dict[str, int | None], dict[str, str]]:
    if row is None:
        metrics = {
            "recoveryIndex": None,
            "sleepScore": None,
            "restingHr": None,
            "stress": None,
            "bodyBattery": None,
            "trainingReadiness": None,
        }
        coverage = {key: "missing" for key in metrics}
        return metrics, coverage

    resting_hr = _as_int(row["resting_heart_rate"])
    body_battery = _as_int(row["body_battery"])
    stress_avg = _as_float(row["stress_avg"])
    stress_value = _as_int(stress_avg)
    sleep_seconds = _as_int(row["sleep_seconds"])

    sleep_score = _sleep_score(sleep_seconds)
    recovery_index_value = _recovery_index(resting_hr, stress_avg, sleep_score)
    readiness = _training_readiness(body_battery, sleep_score, stress_avg)

    metrics = {
        "recoveryIndex": recovery_index_value,
        "sleepScore": sleep_score,
        "restingHr": resting_hr,
        "stress": stress_value,
        "bodyBattery": body_battery,
        "trainingReadiness": readiness,
    }
    coverage = {key: _coverage(True, value) for key, value in metrics.items()}
    return metrics, coverage


def _normalize_question_option(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    option_id = raw.get("id")
    label = raw.get("label")
    if not isinstance(option_id, str) or not option_id.strip():
        return None
    if not isinstance(label, str) or not label.strip():
        return None
    return {"id": option_id.strip(), "label": label.strip()}


def _normalize_question(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    question_id = raw.get("id")
    section = raw.get("section")
    prompt = raw.get("prompt")
    input_type = raw.get("inputType")
    default_included = raw.get("defaultIncluded")

    if not isinstance(question_id, str) or not question_id.strip():
        return None
    if not isinstance(section, str) or not section.strip():
        return None
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    if not isinstance(input_type, str) or input_type not in QUESTION_INPUT_TYPES:
        return None
    if not isinstance(default_included, bool):
        return None

    normalized: dict[str, Any] = {
        "id": question_id.strip(),
        "section": section.strip(),
        "prompt": prompt.strip(),
        "inputType": input_type,
        "defaultIncluded": default_included,
    }

    if input_type == "slider":
        for key in ("min", "max", "step"):
            value = raw.get(key)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            normalized[key] = value

    if input_type == "multi-choice":
        options_raw = raw.get("options", [])
        if not isinstance(options_raw, list):
            return None
        options = []
        for option_raw in options_raw:
            option = _normalize_question_option(option_raw)
            if option is None:
                return None
            options.append(option)
        normalized["options"] = options

    return normalized


def _normalize_questions_payload(payload: Any) -> list[dict[str, Any]] | None:
    if not isinstance(payload, list):
        return None
    normalized = []
    seen_ids: set[str] = set()
    for raw_question in payload:
        question = _normalize_question(raw_question)
        if question is None:
            return None
        question_id = str(question["id"])
        if question_id in seen_ids:
            return None
        seen_ids.add(question_id)
        normalized.append(question)
    return normalized


def _load_questions_payload(db_path: str) -> list[dict[str, Any]]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        raw_payload = get_setting_json(connection, QUESTION_SETTINGS_KEY)
    finally:
        connection.close()
    if raw_payload is None:
        return []
    normalized = _normalize_questions_payload(raw_payload)
    return normalized if normalized is not None else []


def _save_questions_payload(db_path: str, payload: Any) -> list[dict[str, Any]]:
    normalized = _normalize_questions_payload(payload)
    if normalized is None:
        raise ValueError("Invalid question payload")
    connection = connect_db(db_path)
    try:
        init_db(connection)
        upsert_setting_json(connection, QUESTION_SETTINGS_KEY, normalized)
    finally:
        connection.close()
    return normalized


def _load_dashboard_payload(db_path: str, days: int) -> dict[str, Any]:
    end_date = date.today()
    start_date = end_date - timedelta(days=days - 1)

    connection = connect_db(db_path)
    init_db(connection)

    metric_rows = connection.execute(
        """
        SELECT
            metric_date,
            resting_heart_rate,
            body_battery,
            stress_avg,
            sleep_seconds,
            fell_asleep_at
        FROM daily_metrics
        WHERE metric_date BETWEEN ? AND ?
        ORDER BY metric_date
        """,
        (start_date.isoformat(), end_date.isoformat()),
    ).fetchall()
    rows_by_date = {row["metric_date"]: row for row in metric_rows}

    activity_rows = connection.execute(
        """
        SELECT substr(start_time_local, 1, 10) AS activity_date, COUNT(*) AS activity_count
        FROM activities
        WHERE start_time_local IS NOT NULL
          AND substr(start_time_local, 1, 10) BETWEEN ? AND ?
        GROUP BY activity_date
        """,
        (start_date.isoformat(), end_date.isoformat()),
    ).fetchall()
    training_days = {
        row["activity_date"]
        for row in activity_rows
        if row["activity_date"]
        and row["activity_count"]
        and int(row["activity_count"]) > 0
    }

    latest_run = connection.execute(
        """
        SELECT status, started_at, ended_at
        FROM sync_runs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()

    connection.close()

    if latest_run is None:
        summary_state = "ok" if metric_rows else "failed"
        last_import_at = None
    else:
        raw_status = str(latest_run["status"])
        summary_state = "ok"
        if raw_status == "running":
            summary_state = "running"
        elif raw_status == "failed":
            summary_state = "failed"
        last_import_at = latest_run["ended_at"] or latest_run["started_at"]

    records: list[dict[str, Any]] = []
    for offset in range(days):
        current = start_date + timedelta(days=offset)
        date_key = current.isoformat()
        row = rows_by_date.get(date_key)
        metrics, coverage = _metric_payload(row)

        import_state = "ok"
        if row is None:
            import_state = "failed"
        if date_key == end_date.isoformat() and summary_state == "running":
            import_state = "running"
        elif (
            date_key == end_date.isoformat()
            and summary_state == "failed"
            and row is None
        ):
            import_state = "failed"

        records.append(
            {
                "date": date_key,
                "dayIndex": offset,
                "weekday": (current.weekday() + 1) % 7,
                "isTrainingDay": date_key in training_days,
                "importGap": row is None,
                "importState": import_state,
                "fellAsleepAt": _as_clock_time(row["fell_asleep_at"]) if row else None,
                "metrics": metrics,
                "coverage": coverage,
            }
        )

    return {
        "records": records,
        "importStatus": {
            "state": summary_state,
            "lastImportAt": last_import_at,
            "message": "Daily import scheduled · 06:00 local",
        },
        "meta": {
            "source": "sqlite",
            "days": days,
            "availableDays": len(metric_rows),
        },
    }


class ApiHandler(BaseHTTPRequestHandler):
    db_path: str = "/data/garmin.db"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler signature
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if parsed.path == "/api/dashboard":
            query = parse_qs(parsed.query)
            days = _parse_days(query)
            try:
                payload = _load_dashboard_payload(self.db_path, days)
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to build dashboard payload")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": "Failed to load dashboard data", "details": str(exc)},
                )
                return

            self._send_json(HTTPStatus.OK, payload)
            return

        if parsed.path == "/api/questions":
            try:
                payload = _load_questions_payload(self.db_path)
            except Exception as exc:  # pragma: no cover - runtime guard
                logger.exception("Failed to load question settings")
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {
                        "error": "Failed to load question settings",
                        "details": str(exc),
                    },
                )
                return
            self._send_json(HTTPStatus.OK, {"questions": payload})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_PUT(self) -> None:  # noqa: N802 - stdlib handler signature
        parsed = urlparse(self.path)
        if parsed.path != "/api/questions":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        raw_payload = self._read_json_body()
        if raw_payload is None:
            return
        questions_payload = (
            raw_payload.get("questions")
            if isinstance(raw_payload, dict)
            else raw_payload
        )
        try:
            normalized = _save_questions_payload(self.db_path, questions_payload)
        except ValueError as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "Invalid question settings payload", "details": str(exc)},
            )
            return
        except Exception as exc:  # pragma: no cover - runtime guard
            logger.exception("Failed to save question settings")
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Failed to save question settings", "details": str(exc)},
            )
            return
        self._send_json(HTTPStatus.OK, {"questions": normalized})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        logger.info("API %s - %s", self.address_string(), format % args)

    def _read_json_body(self) -> Any | None:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing request body"})
            return None
        try:
            length = int(length_header)
        except ValueError:
            self._send_json(
                HTTPStatus.BAD_REQUEST, {"error": "Invalid Content-Length header"}
            )
            return None
        if length <= 0:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Empty request body"})
            return None

        raw_bytes = self.rfile.read(length)
        try:
            return json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "Request body must be valid JSON"},
            )
            return None

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        try:
            self.end_headers()
            self.wfile.write(data)
        except OSError as exc:
            if isinstance(
                exc, (BrokenPipeError, ConnectionResetError)
            ) or exc.errno in {
                errno.EPIPE,
                errno.ECONNRESET,
            }:
                logger.info("Client disconnected before response completed")
                return
            raise


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SQLite API server for dashboard data")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8000, type=int)
    parser.add_argument("--db-path", default=None)
    return parser.parse_args()


def _build_settings() -> ApiSettings:
    args = _parse_args()
    env_settings = load_settings(require_garmin_credentials=False)
    db_path = args.db_path or env_settings.db_path
    return ApiSettings(db_path=db_path, host=args.host, port=args.port)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    settings = _build_settings()

    handler = ApiHandler
    handler.db_path = settings.db_path

    with ThreadingHTTPServer((settings.host, settings.port), handler) as server:
        logger.info(
            "Dashboard API listening on %s:%s (db=%s)",
            settings.host,
            settings.port,
            settings.db_path,
        )
        server.serve_forever()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
