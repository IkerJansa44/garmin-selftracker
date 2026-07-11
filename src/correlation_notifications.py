from __future__ import annotations

import logging
import math
import smtplib
from dataclasses import dataclass
from datetime import date, timedelta
from email.message import EmailMessage
from html import escape
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from src.db import (
    connect_db,
    get_setting_json,
    get_analysis_values,
    init_db,
    rebuild_analysis_values,
    upsert_setting_json,
)

logger = logging.getLogger(__name__)

NOTIFIED_CORRELATIONS_KEY = "notified_meaningful_correlations"
MIN_SAMPLE_COUNT = 20
MIN_STRENGTH = 0.2
MAX_Q_VALUE = 0.05
SCAN_DAYS = 365
FeatureDisplayKind = Literal["numeric", "binary", "time"]

FEATURE_LABELS = {
    "garmin:steps": "Steps",
    "garmin:calories": "Calories",
    "garmin:stressAvg": "Stress Avg",
    "garmin:bodyBattery": "Body Battery",
    "garmin:runningKilometers": "Running Distance (km)",
    "garmin:sleepSeconds": "Sleep Duration (h)",
    "garmin:vo2Max": "VO2 Max",
    "garmin:avgHr1hBeforeSleep": "Avg HR 1h Before Sleep",
    "garmin:sleepConsistency": "Sleep Consistency (min)",
    "garmin:isTrainingDay": "Training Day",
    "garmin:mealToSleepGapMinutes": "Meal to Sleep Gap (min)",
    "garmin:caffeineToSleepGapMinutes": "Caffeine to Sleep Gap (min)",
    "metric:recoveryIndex": "Recovery Index",
    "metric:restingHr": "Resting HR",
    "metric:stress": "Stress",
    "metric:bodyBattery": "Body Battery",
    "metric:trainingReadiness": "Training Readiness",
    "metric:deepSleepPercentage": "Deep Sleep (%)",
    "metric:remSleepPercentage": "REM Sleep (%)",
    "metric:remOrDeepSleepPercentage": "REM + Deep Sleep (%)",
    "metric:avgOvernightHrv": "Overnight HRV",
    "metric:sleepScore": "Sleep Score",
    "metric:avgHr1hBeforeSleep": "Avg HR 1h Before Sleep",
}


@dataclass(frozen=True)
class CorrelationEmailSettings:
    db_path: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_pass: str
    recipient_email: str
    dashboard_url: str


@dataclass(frozen=True)
class MeaningfulCorrelation:
    key: str
    predictor: str
    outcome: str
    predictor_label: str
    outcome_label: str
    sample_count: int
    correlation: float
    p_value: float
    q_value: float
    predictor_kind: FeatureDisplayKind = "numeric"
    outcome_kind: FeatureDisplayKind = "numeric"
    predictor_positive_label: str | None = None
    outcome_positive_label: str | None = None


def current_meaningful_correlation_keys(db_path: str) -> set[str]:
    return {correlation.key for correlation in scan_meaningful_correlations(db_path)}


def notify_new_meaningful_correlations(
    settings: CorrelationEmailSettings,
    *,
    previous_keys: set[str] | None = None,
) -> list[MeaningfulCorrelation]:
    correlations = scan_meaningful_correlations(settings.db_path)
    current_keys = {correlation.key for correlation in correlations}
    known_keys = (
        previous_keys
        if previous_keys is not None
        else _load_notified_keys(settings.db_path)
    )

    if known_keys is None:
        _save_notified_keys(settings.db_path, current_keys)
        logger.info(
            "Stored %d meaningful correlation notification baselines", len(current_keys)
        )
        return []

    new_correlations = [
        correlation for correlation in correlations if correlation.key not in known_keys
    ]
    if not new_correlations:
        _save_notified_keys(settings.db_path, current_keys)
        return []

    try:
        _send_correlation_email(settings, new_correlations)
    except Exception:
        logger.exception("Failed to send meaningful correlation email")
    _save_notified_keys(settings.db_path, current_keys)
    logger.info(
        "Recorded %d new meaningful correlation notifications", len(new_correlations)
    )
    return new_correlations


def scan_meaningful_correlations(db_path: str) -> list[MeaningfulCorrelation]:
    values = _load_recent_analysis_values(db_path)
    questions = _load_questions(db_path)
    labels = _feature_labels(questions)
    pairs = _build_correlation_pairs(values, labels, questions)
    _apply_benjamini_hochberg(pairs)
    return [
        pair
        for pair in pairs
        if (
            pair.sample_count >= MIN_SAMPLE_COUNT
            and abs(pair.correlation) >= MIN_STRENGTH
            and pair.q_value < MAX_Q_VALUE
        )
    ]


def _load_recent_analysis_values(db_path: str) -> list[dict[str, Any]]:
    end_date = date.today()
    start_date = end_date - timedelta(days=SCAN_DAYS - 1)
    connection = connect_db(db_path)
    try:
        init_db(connection)
        rebuild_analysis_values(connection)
        return get_analysis_values(
            connection,
            from_date=start_date.isoformat(),
            to_date=end_date.isoformat(),
        )
    finally:
        connection.close()


def _build_correlation_pairs(
    values: list[dict[str, Any]],
    labels: dict[str, str],
    questions: dict[str, dict[str, Any]],
) -> list[MeaningfulCorrelation]:
    by_role_feature: dict[tuple[str, str], dict[str, float]] = {}
    for value in values:
        numeric = _numeric_value(value, questions)
        if numeric is None:
            continue
        role = str(value["role"])
        feature_key = str(value["featureKey"])
        date_key = str(value["analysisDate"])
        by_role_feature.setdefault((role, feature_key), {})[date_key] = numeric

    predictors = sorted(
        feature for role, feature in by_role_feature if role == "predictor"
    )
    outcomes = sorted(feature for role, feature in by_role_feature if role == "target")
    pairs: list[MeaningfulCorrelation] = []

    for predictor in predictors:
        predictor_values = by_role_feature[("predictor", predictor)]
        for outcome in outcomes:
            if (
                predictor == "garmin:avgHr1hBeforeSleep"
                and outcome == "metric:avgHr1hBeforeSleep"
            ):
                continue
            outcome_values = by_role_feature[("target", outcome)]
            common_dates = sorted(predictor_values.keys() & outcome_values.keys())
            xs = [predictor_values[date_key] for date_key in common_dates]
            ys = [outcome_values[date_key] for date_key in common_dates]
            correlation = _pearson(xs, ys)
            p_value = _pearson_p_value(correlation, len(xs))
            if correlation is None or p_value is None:
                continue
            pairs.append(
                MeaningfulCorrelation(
                    key=f"{predictor}__{outcome}",
                    predictor=predictor,
                    outcome=outcome,
                    predictor_label=labels.get(predictor, predictor),
                    outcome_label=labels.get(outcome, outcome),
                    sample_count=len(xs),
                    correlation=correlation,
                    p_value=p_value,
                    q_value=1.0,
                    predictor_kind=_feature_display_kind(predictor, questions),
                    outcome_kind=_feature_display_kind(outcome, questions),
                    predictor_positive_label=_feature_positive_label(
                        predictor, questions
                    ),
                    outcome_positive_label=_feature_positive_label(outcome, questions),
                )
            )
    return pairs


def _numeric_value(
    value: dict[str, Any],
    questions: dict[str, dict[str, Any]],
) -> float | None:
    if value.get("valueNum") is not None:
        return float(value["valueNum"])
    if value.get("valueBool") is not None:
        return 1.0 if bool(value["valueBool"]) else 0.0
    feature_key = str(value["featureKey"])
    if feature_key.startswith("question:"):
        return _question_numeric_value(
            questions.get(feature_key.removeprefix("question:")),
            value.get("valueText"),
        )
    return None


def _question_numeric_value(
    question: dict[str, Any] | None, value: Any
) -> float | None:
    if question is None:
        return None
    input_type = question.get("inputType")
    if input_type == "time":
        if not isinstance(value, str):
            return None
        hours_minutes = value.split(":")
        if len(hours_minutes) != 2:
            return None
        try:
            hours, minutes = (int(part) for part in hours_minutes)
        except ValueError:
            return None
        if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
            return None
        return float(hours * 60 + minutes)
    if input_type == "multi-choice" and isinstance(value, str):
        normalized = value.strip()
        options = question.get("options")
        if isinstance(options, list):
            for option in options:
                if (
                    isinstance(option, dict)
                    and option.get("id") == normalized
                    and isinstance(option.get("score"), (int, float))
                ):
                    return float(option["score"])
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2 or len(xs) != len(ys):
        return None
    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)
    numerator = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys, strict=True))
    x_variance = sum((x - x_mean) ** 2 for x in xs)
    y_variance = sum((y - y_mean) ** 2 for y in ys)
    denominator = math.sqrt(x_variance * y_variance)
    if denominator == 0:
        return None
    return max(-1.0, min(1.0, numerator / denominator))


def _pearson_p_value(correlation: float | None, sample_count: int) -> float | None:
    if correlation is None or sample_count < 4:
        return None
    bounded = max(-0.999999, min(0.999999, correlation))
    fisher_z = 0.5 * math.log((1 + bounded) / (1 - bounded))
    z_score = fisher_z * math.sqrt(sample_count - 3)
    return max(0.0, min(1.0, 2 * (1 - _normal_cdf(abs(z_score)))))


def _normal_cdf(value: float) -> float:
    return 0.5 * (1 + math.erf(value / math.sqrt(2)))


def _apply_benjamini_hochberg(pairs: list[MeaningfulCorrelation]) -> None:
    ranked = sorted(enumerate(pairs), key=lambda item: item[1].p_value)
    adjusted = [1.0] * len(ranked)
    for index in range(len(ranked) - 1, -1, -1):
        rank = index + 1
        raw = ranked[index][1].p_value * len(ranked) / rank
        adjusted[index] = min(
            raw, adjusted[index + 1] if index + 1 < len(ranked) else raw, 1.0
        )

    for index, (pair_index, pair) in enumerate(ranked):
        pairs[pair_index] = MeaningfulCorrelation(
            key=pair.key,
            predictor=pair.predictor,
            outcome=pair.outcome,
            predictor_label=pair.predictor_label,
            outcome_label=pair.outcome_label,
            sample_count=pair.sample_count,
            correlation=pair.correlation,
            p_value=pair.p_value,
            q_value=adjusted[index],
            predictor_kind=pair.predictor_kind,
            outcome_kind=pair.outcome_kind,
            predictor_positive_label=pair.predictor_positive_label,
            outcome_positive_label=pair.outcome_positive_label,
        )


def _feature_display_kind(
    feature_key: str,
    questions: dict[str, dict[str, Any]],
) -> FeatureDisplayKind:
    if feature_key == "garmin:isTrainingDay":
        return "binary"
    if not feature_key.startswith("question:"):
        return "numeric"
    question = questions.get(feature_key.removeprefix("question:"))
    input_type = question.get("inputType") if question else None
    if input_type == "boolean":
        return "binary"
    if input_type == "time":
        return "time"
    if input_type == "multi-choice" and _choice_positive_label(question):
        return "binary"
    return "numeric"


def _feature_positive_label(
    feature_key: str,
    questions: dict[str, dict[str, Any]],
) -> str | None:
    if feature_key == "garmin:isTrainingDay":
        return "Yes"
    if not feature_key.startswith("question:"):
        return None
    question = questions.get(feature_key.removeprefix("question:"))
    if not question:
        return None
    if question.get("inputType") == "boolean":
        return "Yes"
    if question.get("inputType") == "multi-choice":
        return _choice_positive_label(question)
    return None


def _choice_positive_label(question: dict[str, Any]) -> str | None:
    options = question.get("options")
    if not isinstance(options, list) or len(options) != 2:
        return None
    scored_options = [
        option
        for option in options
        if isinstance(option, dict) and isinstance(option.get("score"), (int, float))
    ]
    if len(scored_options) != 2:
        return None
    positive = max(scored_options, key=lambda option: float(option["score"]))
    label = positive.get("label") or positive.get("id")
    return str(label).strip() if label else "Yes"


def _load_questions(db_path: str) -> dict[str, dict[str, Any]]:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        raw_questions = get_setting_json(connection, "checkin_questions")
    finally:
        connection.close()

    return {
        str(question["id"]): question
        for question in _flatten_questions(raw_questions)
        if isinstance(question.get("id"), str)
    }


def _feature_labels(questions: dict[str, dict[str, Any]]) -> dict[str, str]:
    labels = dict(FEATURE_LABELS)
    for question_id, question in questions.items():
        prompt = question.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            labels[f"question:{question_id}"] = prompt.strip()
    return labels


def _flatten_questions(raw_questions: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_questions, list):
        return []
    flattened: list[dict[str, Any]] = []
    for question in raw_questions:
        if not isinstance(question, dict):
            continue
        flattened.append(question)
        children = question.get("children")
        if isinstance(children, list):
            flattened.extend(child for child in children if isinstance(child, dict))
    return flattened


def _load_notified_keys(db_path: str) -> set[str] | None:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        raw_keys = get_setting_json(connection, NOTIFIED_CORRELATIONS_KEY)
    finally:
        connection.close()
    if raw_keys is None:
        return None
    if not isinstance(raw_keys, list):
        return set()
    return {key for key in raw_keys if isinstance(key, str)}


def _save_notified_keys(db_path: str, keys: set[str]) -> None:
    connection = connect_db(db_path)
    try:
        init_db(connection)
        upsert_setting_json(connection, NOTIFIED_CORRELATIONS_KEY, sorted(keys))
        connection.commit()
    finally:
        connection.close()


def _send_correlation_email(
    settings: CorrelationEmailSettings,
    correlations: list[MeaningfulCorrelation],
) -> None:
    missing_fields = [
        name
        for name, value in (
            ("SMTP_HOST", settings.smtp_host),
            ("SMTP_USER", settings.smtp_user),
            ("SMTP_PASS", settings.smtp_pass),
            ("GARMIN_EMAIL", settings.recipient_email),
        )
        if not value
    ]
    if missing_fields:
        raise RuntimeError(
            "Correlation email cannot be sent until required configuration is provided: "
            + ", ".join(missing_fields)
        )

    message = EmailMessage()
    message["Subject"] = "New meaningful Garmin correlation"
    message["From"] = settings.smtp_user
    message["To"] = settings.recipient_email
    message.set_content(_build_email_body(correlations, settings.dashboard_url))
    message.add_alternative(
        _build_email_html(correlations, settings.dashboard_url),
        subtype="html",
    )

    with smtplib.SMTP(
        host=settings.smtp_host,
        port=settings.smtp_port,
        timeout=30,
    ) as smtp_client:
        smtp_client.starttls()
        smtp_client.login(settings.smtp_user, settings.smtp_pass)
        smtp_client.send_message(message)


def _build_email_body(
    correlations: list[MeaningfulCorrelation],
    dashboard_url: str,
) -> str:
    lines = ["New meaningful correlations were found after the latest import:", ""]
    for correlation in sorted(
        correlations, key=lambda item: abs(item.correlation), reverse=True
    ):
        lines.append(
            f"- {_describe_correlation(correlation)} "
            f"(r={correlation.correlation:.2f}, q={correlation.q_value:.3g}, "
            f"N={correlation.sample_count})"
        )
        if link := _build_correlation_link(dashboard_url, correlation):
            lines.append(f"  View scatterplot: {link}")
    if dashboard_url:
        lines.extend(["", f"Dashboard: {dashboard_url}"])
    return "\n".join(lines)


def _describe_correlation(correlation: MeaningfulCorrelation) -> str:
    outcome_direction = _outcome_direction(correlation)
    return (
        f"When {correlation.predictor_label} {_predictor_condition(correlation)}, "
        f"{correlation.outcome_label} tends to be {outcome_direction}."
    )


def _predictor_condition(correlation: MeaningfulCorrelation) -> str:
    if correlation.predictor_kind == "binary":
        return f"is {correlation.predictor_positive_label or 'Yes'}"
    if correlation.predictor_kind == "time":
        return "is later"
    return "is higher"


def _outcome_direction(correlation: MeaningfulCorrelation) -> str:
    is_positive = correlation.correlation > 0
    if correlation.outcome_kind == "binary":
        label = correlation.outcome_positive_label or "Yes"
        return f"{label} more often" if is_positive else f"{label} less often"
    if correlation.outcome_kind == "time":
        return "later" if is_positive else "earlier"
    return "higher too" if is_positive else "lower"


def _build_email_html(
    correlations: list[MeaningfulCorrelation],
    dashboard_url: str,
) -> str:
    items = []
    for correlation in sorted(
        correlations, key=lambda item: abs(item.correlation), reverse=True
    ):
        stats = (
            f"r={correlation.correlation:.2f}, "
            f"q={correlation.q_value:.3g}, N={correlation.sample_count}"
        )
        link = _build_correlation_link(dashboard_url, correlation)
        link_html = (
            f'<p><a href="{escape(link, quote=True)}">View scatterplot</a></p>'
            if link
            else ""
        )
        items.append(
            "<li>"
            f"<p>{escape(_describe_correlation(correlation))} "
            f"<span>({escape(stats)})</span></p>"
            f"{link_html}"
            "</li>"
        )
    dashboard_html = (
        f'<p><a href="{escape(dashboard_url, quote=True)}">Open dashboard</a></p>'
        if dashboard_url
        else ""
    )
    return (
        "<!doctype html>"
        '<html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#202124">'
        "<p>New meaningful correlations were found after the latest import:</p>"
        f"<ul>{''.join(items)}</ul>"
        f"{dashboard_html}"
        "</body></html>"
    )


def _build_correlation_link(
    dashboard_url: str,
    correlation: MeaningfulCorrelation,
) -> str | None:
    if not dashboard_url:
        return None
    parts = urlsplit(dashboard_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.update(
        {
            "view": "lab",
            "predictor": correlation.predictor,
            "outcome": correlation.outcome,
        }
    )
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urlencode(query),
            parts.fragment,
        )
    )
