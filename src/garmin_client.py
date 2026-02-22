from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class DayPayload:
    payload_date: date
    endpoints: dict[str, Any]


class GarminConnectAdapter:
    def __init__(self, email: str, password: str) -> None:
        self._email = email
        self._password = password
        self._client = None

    def login(self) -> None:
        garmin_module = __import__("garminconnect", fromlist=["Garmin"])
        garmin_cls = getattr(garmin_module, "Garmin")
        self._client = garmin_cls(self._email, self._password)
        self._client.login()

    def fetch_day(self, day: date) -> DayPayload:
        if self._client is None:
            raise RuntimeError("Garmin client is not logged in")

        day_str = day.isoformat()
        endpoints = {
            "stats": self._safe_call("get_stats", day_str),
            "user_summary": self._safe_call("get_user_summary", day_str),
            "body_composition": self._safe_call("get_body_composition", day_str),
            "sleep": self._safe_call("get_sleep_data", day_str),
            "heart_rates": self._safe_call("get_heart_rates", day_str),
            "activities": self._safe_call("get_activities_by_date", day_str, day_str),
        }
        return DayPayload(payload_date=day, endpoints=endpoints)

    def fetch_hr_zones(self, activity_id: int) -> list[int] | None:
        result = self._safe_call("get_activity_hr_in_timezones", activity_id)
        if not isinstance(result, list) or not result:
            return None
        try:
            sorted_zones = sorted(result, key=lambda z: z.get("zoneNumber", 0))
            bounds = [int(z["zoneLowBoundary"]) for z in sorted_zones if "zoneLowBoundary" in z]
        except (KeyError, TypeError, ValueError):
            return None
        # Schema supports exactly zone0–zone5 (5 lower bounds). Reject unexpected shapes.
        if len(bounds) != 5:
            return None
        return bounds

    def _safe_call(self, method_name: str, *args: Any) -> Any:
        if self._client is None:
            raise RuntimeError("Garmin client is not logged in")

        method = getattr(self._client, method_name, None)
        if method is None:
            return {"_warning": f"{method_name} unavailable in installed garminconnect"}

        try:
            return method(*args)
        except Exception as exc:  # pragma: no cover - depends on external API behavior
            return {"_error": str(exc)}


def _pick_value(candidates: list[dict[str, Any] | None], keys: list[str]) -> Any:
    for source in candidates:
        if not isinstance(source, dict):
            continue
        for key in keys:
            value = source.get(key)
            if value is not None:
                return value
    return None


def _extract_sleep_seconds(sleep_payload: Any) -> int | None:
    if not isinstance(sleep_payload, dict):
        return None

    # Common garminconnect shape: {"dailySleepDTO": {"sleepTimeSeconds": ...}}
    daily = sleep_payload.get("dailySleepDTO")
    if isinstance(daily, dict):
        sleep_seconds = daily.get("sleepTimeSeconds")
        if sleep_seconds is not None:
            return int(sleep_seconds)

    sleep_seconds = sleep_payload.get("sleepTimeSeconds")
    return int(sleep_seconds) if sleep_seconds is not None else None


def _normalize_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped.isdigit():
            value = int(stripped)
        else:
            return stripped
    if not isinstance(value, (int, float)):
        return None

    seconds = float(value)
    if seconds > 10_000_000_000:
        seconds = seconds / 1000
    try:
        parsed = datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None
    return parsed.isoformat()


def _extract_fell_asleep_at(sleep_payload: Any) -> str | None:
    if not isinstance(sleep_payload, dict):
        return None

    sources: list[dict[str, Any]] = []
    daily = sleep_payload.get("dailySleepDTO")
    if isinstance(daily, dict):
        sources.append(daily)
    sources.append(sleep_payload)

    for source in sources:
        for key in (
            "sleepStartTimestampLocal",
            "sleepStartTimestampGMT",
            "sleepStartTimestamp",
            "sleepStartTimeGMT",
            "sleepStartTimeLocal",
        ):
            normalized = _normalize_timestamp(source.get(key))
            if normalized:
                return normalized
    return None


def _extract_woke_up_at(sleep_payload: Any) -> str | None:
    if not isinstance(sleep_payload, dict):
        return None

    sources: list[dict[str, Any]] = []
    daily = sleep_payload.get("dailySleepDTO")
    if isinstance(daily, dict):
        sources.append(daily)
    sources.append(sleep_payload)

    for source in sources:
        for key in (
            "sleepEndTimestampLocal",
            "sleepEndTimestampGMT",
            "sleepEndTimestamp",
            "sleepEndTimeGMT",
            "sleepEndTimeLocal",
        ):
            normalized = _normalize_timestamp(source.get(key))
            if normalized:
                return normalized
    return None


def normalize_daily_metrics(day_payload: DayPayload) -> dict[str, Any]:
    stats = day_payload.endpoints.get("stats")
    summary = day_payload.endpoints.get("user_summary")
    sleep = day_payload.endpoints.get("sleep")

    sources = [
        stats if isinstance(stats, dict) else None,
        summary if isinstance(summary, dict) else None,
    ]

    return {
        "metric_date": day_payload.payload_date.isoformat(),
        "steps": _pick_value(sources, ["totalSteps", "steps"]),
        "calories": _pick_value(sources, ["totalKilocalories", "calories"]),
        "resting_heart_rate": _pick_value(sources, ["restingHeartRate", "restingHR"]),
        "body_battery": _pick_value(
            sources,
            ["bodyBatteryMostRecentValue", "averageBodyBattery", "bodyBattery"],
        ),
        "stress_avg": _pick_value(
            sources, ["averageStressLevel", "stressAvg", "stressAverage"]
        ),
        "sleep_seconds": _extract_sleep_seconds(sleep),
        "fell_asleep_at": _extract_fell_asleep_at(sleep),
        "woke_up_at": _extract_woke_up_at(sleep),
        "vo2max": _pick_value(sources, ["vo2MaxValue", "vo2max", "vO2MaxValue"]),
    }


def compute_zone_minutes(
    heart_rates_payload: Any,
    zone_lower_bounds: list[int],
) -> dict[str, int]:
    """Classify each BPM sample into a zone and accumulate minutes per zone.

    Zone 0 is below the first lower bound; zones 1–N match the provided bounds.
    Each sample's duration is derived from the gap to the next timestamp (ms).
    The final sample defaults to 2 minutes.
    """
    num_zones = len(zone_lower_bounds) + 1
    result: dict[str, int] = {f"zone{i}_minutes": 0 for i in range(num_zones)}

    if not isinstance(heart_rates_payload, dict):
        return result

    samples = heart_rates_payload.get("heartRateValues")
    if not isinstance(samples, list) or not samples:
        return result

    sorted_bounds = sorted(zone_lower_bounds)
    # Accumulate fractional minutes per zone; round once at the end.
    totals: dict[str, float] = {f"zone{i}_minutes": 0.0 for i in range(num_zones)}

    for i, sample in enumerate(samples):
        if not isinstance(sample, (list, tuple)) or len(sample) < 2:
            continue
        bpm = sample[1]
        if bpm is None:
            continue

        # Determine interval duration in minutes
        if i + 1 < len(samples) and isinstance(samples[i + 1], (list, tuple)):
            duration_minutes = max(0.0, (samples[i + 1][0] - sample[0]) / 60_000)
        else:
            duration_minutes = 2.0

        # Assign zone
        zone = 0
        for j, bound in enumerate(sorted_bounds):
            if bpm >= bound:
                zone = j + 1

        totals[f"zone{zone}_minutes"] += duration_minutes

    return {key: round(value) for key, value in totals.items()}


def normalize_activities(day_payload: DayPayload) -> list[dict[str, Any]]:
    activities = day_payload.endpoints.get("activities")
    if not isinstance(activities, list):
        return []

    normalized: list[dict[str, Any]] = []
    for entry in activities:
        if not isinstance(entry, dict):
            continue

        activity_id = entry.get("activityId")
        if activity_id is None:
            continue

        activity_type = entry.get("activityType")
        if isinstance(activity_type, dict):
            activity_type = activity_type.get("typeKey") or activity_type.get("typeId")

        normalized.append(
            {
                "garmin_activity_id": int(activity_id),
                "activity_name": entry.get("activityName"),
                "activity_type": activity_type,
                "start_time_local": entry.get("startTimeLocal")
                or entry.get("startTimeGMT"),
                "duration_seconds": entry.get("duration"),
                "distance_meters": entry.get("distance"),
                "average_hr": entry.get("averageHR") or entry.get("avgHr"),
                "max_hr": entry.get("maxHR") or entry.get("maxHr"),
                "calories": entry.get("calories"),
                "raw_json": entry,
            }
        )

    return normalized
