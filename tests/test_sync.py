from __future__ import annotations

from datetime import date

import pytest

from src.sync import date_span


def test_date_span_inclusive() -> None:
    days = date_span(date(2026, 2, 1), date(2026, 2, 3))
    assert days == [date(2026, 2, 1), date(2026, 2, 2), date(2026, 2, 3)]


def test_date_span_rejects_inverted_range() -> None:
    with pytest.raises(ValueError):
        date_span(date(2026, 2, 3), date(2026, 2, 1))
