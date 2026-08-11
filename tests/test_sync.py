from __future__ import annotations

from datetime import date

import pytest

from src.sync import _is_running_activity, date_span


def test_date_span_inclusive() -> None:
    days = date_span(date(2026, 2, 1), date(2026, 2, 3))
    assert days == [date(2026, 2, 1), date(2026, 2, 2), date(2026, 2, 3)]


def test_date_span_rejects_inverted_range() -> None:
    with pytest.raises(ValueError):
        date_span(date(2026, 2, 3), date(2026, 2, 1))


@pytest.mark.parametrize(
    ("activity_type", "expected"),
    [
        ({"typeKey": "running"}, True),
        ({"typeKey": "trail_running"}, True),
        ({"typeKey": "strength_training"}, False),
    ],
)
def test_is_running_activity(activity_type: object, expected: bool) -> None:
    assert _is_running_activity({"activityType": activity_type}) is expected
