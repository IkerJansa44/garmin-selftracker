from __future__ import annotations

from calendar import Calendar
from datetime import date, datetime
from pathlib import Path
from typing import Any

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

PAGE_W, PAGE_H = A4
MARGIN = 42
CONTENT_W = PAGE_W - MARGIN * 2
INK = HexColor("#181816")
MUTED = HexColor("#77746F")
FAINT = HexColor("#AAA69F")
PAPER = HexColor("#F7F5F0")
CARD = HexColor("#FFFFFF")
LINE = HexColor("#E6E2DA")
TERRACOTTA = HexColor("#D75A2C")
SLEEP = HexColor("#356A8A")
SLEEP_LIGHT = HexColor("#DCE9F0")
TRAIN = HexColor("#4E7962")
TRAIN_LIGHT = HexColor("#DFEBE4")
SELF = HexColor("#9A7044")
SELF_LIGHT = HexColor("#EFE4D5")
NEGATIVE = HexColor("#BA5B50")


def render_monthly_report(snapshot: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_month = datetime.strptime(snapshot["reportMonth"], "%Y-%m")
    month_label = report_month.strftime("%B %Y")
    pdf = canvas.Canvas(str(output_path), pagesize=A4)
    pdf.setTitle(f"Selftracker monthly report - {month_label}")
    pdf.setAuthor("Garmin Selftracker")
    section_pages: list[tuple[str, str, Any, Any, list[dict[str, Any]], bool]] = []
    for key, title, accent, accent_light in (
        ("sleep", "Sleep", SLEEP, SLEEP_LIGHT),
        ("training", "Training", TRAIN, TRAIN_LIGHT),
        ("selfReported", "Self-reported", SELF, SELF_LIGHT),
    ):
        metrics = snapshot["sections"][key]
        chunks = [
            metrics[index : index + 8] for index in range(0, len(metrics), 8)
        ] or [[]]
        section_pages.extend(
            (key, title, accent, accent_light, chunk, index > 0)
            for index, chunk in enumerate(chunks)
        )
    total_pages = len(section_pages) + 1
    _overview_page(pdf, snapshot, month_label, total_pages)
    for page_number, (
        key,
        title,
        accent,
        accent_light,
        metrics,
        continued,
    ) in enumerate(section_pages, start=2):
        _section_page(
            pdf,
            snapshot,
            key,
            f"{title} (continued)" if continued else title,
            accent,
            accent_light,
            page_number,
            total_pages,
            month_label,
            metrics,
        )
    pdf.save()


def _page_base(
    pdf: canvas.Canvas,
    page_number: int,
    total_pages: int,
    title: str,
    kicker: str,
    color: Any,
    month_label: str,
) -> None:
    pdf.setFillColor(PAPER)
    pdf.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    pdf.setFillColor(color)
    pdf.roundRect(MARGIN, PAGE_H - 61, 24, 4, 2, fill=1, stroke=0)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica-Bold", 7.5)
    pdf.drawString(MARGIN, PAGE_H - 78, kicker.upper())
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 25)
    pdf.drawString(MARGIN, PAGE_H - 109, title)
    pdf.setStrokeColor(LINE)
    pdf.line(MARGIN, 31, PAGE_W - MARGIN, 31)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 7.5)
    pdf.drawString(MARGIN, 19, f"GARMIN SELFTRACKER  /  {month_label.upper()}")
    pdf.drawRightString(PAGE_W - MARGIN, 19, f"{page_number:02d}  /  {total_pages:02d}")


def _card(
    pdf: canvas.Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    fill: Any = CARD,
) -> None:
    pdf.setFillColor(fill)
    pdf.roundRect(x, y, width, height, 12, fill=1, stroke=0)


def _wrap(text: str, font: str, size: float, width: float) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if stringWidth(candidate, font, size) <= width:
            current = candidate
        elif current:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def _overview_page(
    pdf: canvas.Canvas,
    snapshot: dict[str, Any],
    month_label: str,
    total_pages: int,
) -> None:
    period = snapshot["period"]
    coverage = snapshot["coverage"]
    month = datetime.strptime(snapshot["reportMonth"], "%Y-%m")
    _page_base(
        pdf,
        1,
        total_pages,
        f"{month:%B}, in focus",
        f"Your month in review / {_friendly_period(period['start'], period['end'])}",
        TERRACOTTA,
        month_label,
    )
    highlights = _standout_metrics(snapshot)
    lead = max(highlights, key=lambda item: _relative_change(item[1]), default=None)
    headline = "A month of small moments."
    if lead and lead[1]["delta"]:
        metric = lead[1]
        direction = "up" if metric["delta"] > 0 else "down"
        headline = f"{metric['label']} moved {direction}."
    pdf.setFillColor(TERRACOTTA)
    size = min(22, 22 * CONTENT_W / stringWidth(headline, "Helvetica-Bold", 22))
    pdf.setFont("Helvetica-Bold", size)
    pdf.drawString(MARGIN, 689, headline)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 9)
    pdf.drawString(
        MARGIN, 669, "Three signals from your month, compared with your prior 90 days."
    )
    styles = {
        "sleep": (SLEEP, SLEEP_LIGHT),
        "training": (TRAIN, TRAIN_LIGHT),
        "selfReported": (SELF, SELF_LIGHT),
    }
    width = (CONTENT_W - 18) / 3
    for index, key in enumerate(styles):
        x = MARGIN + index * (width + 9)
        accent, fill = styles[key]
        _card(pdf, x, 502, width, 141, fill)
        pdf.setFillColor(accent)
        pdf.setFont("Helvetica-Bold", 7)
        pdf.drawString(
            x + 14,
            623,
            {"sleep": "SLEEP", "training": "TRAINING", "selfReported": "DAILY LIFE"}[
                key
            ],
        )
        metric = next(
            (metric for section, metric in highlights if section == key), None
        )
        if metric is None:
            pdf.setFont("Helvetica-Bold", 13)
            pdf.drawString(x + 14, 581, "More data needed")
            pdf.setFont("Helvetica", 8)
            pdf.drawString(x + 14, 557, "A highlight will appear here.")
            continue
        pdf.setFillColor(INK)
        value = f"{metric['current']:,.{metric['decimals']}f}"
        size = min(29, 29 * (width - 28) / stringWidth(value, "Helvetica-Bold", 29))
        pdf.setFont("Helvetica-Bold", size)
        pdf.drawString(x + 14, 586, value)
        pdf.setFont("Helvetica", 8)
        pdf.drawString(
            x + 14, 571, _fit_text(metric["unit"], "Helvetica", 8, width - 28)
        )
        pdf.setFont("Helvetica-Bold", 9)
        for line_index, line in enumerate(
            _wrap(metric["label"], "Helvetica-Bold", 9, width - 28)[:2]
        ):
            pdf.drawString(x + 14, 552 - line_index * 11, line)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 7)
        delta_unit = "pp" if metric["unit"] == "%" else metric["unit"]
        change = f"{metric['delta']:+,.{metric['decimals']}f} {delta_unit} vs prior 90d"
        pdf.drawString(x + 14, 516, _fit_text(change, "Helvetica", 7, width - 28))
    _calendar_card(pdf, snapshot)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(
        MARGIN,
        96,
        f"Garmin: {coverage['importedDays']}/{coverage['expectedDays']} days"
        f"    /    Check-ins: {coverage['checkinDays']}/{coverage['expectedDays']} days",
    )
    pdf.setFont("Helvetica", 7)
    pdf.drawString(
        MARGIN,
        78,
        "Highlights need at least 7 monthly and 14 baseline observations; one per section.",
    )
    pdf.drawString(
        MARGIN,
        65,
        "Movement describes change, not necessarily improvement. Full context follows.",
    )
    pdf.showPage()


def _relative_change(metric: dict[str, Any]) -> float:
    # Percentage metrics use their full scale; other metrics use relative change.
    scale = 100 if metric["unit"] == "%" else max(abs(metric["baseline"]), 1)
    return abs(metric["delta"]) / scale


def _standout_metrics(snapshot: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    highlights = []
    for section in ("sleep", "training", "selfReported"):
        candidates = [
            metric
            for metric in snapshot["sections"][section]
            if metric["current"] is not None
            and metric["baseline"] is not None
            and metric["delta"] is not None
            and metric["currentSamples"] >= 7
            and metric["baselineSamples"] >= 14
            and round(metric["delta"], metric["decimals"]) != 0
        ]
        if candidates:
            highlights.append((section, max(candidates, key=_relative_change)))
    return highlights


def _calendar_card(pdf: canvas.Canvas, snapshot: dict[str, Any]) -> None:
    _card(pdf, MARGIN, 123, CONTENT_W, 359)
    month = date.fromisoformat(f"{snapshot['reportMonth']}-01")
    end = date.fromisoformat(snapshot["period"]["end"])
    days = {item["date"]: item["status"] for item in snapshot.get("calendar", [])}
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 15)
    pdf.drawString(MARGIN + 18, 454, "The rhythm of your month")
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 8)
    note = snapshot.get(
        "calendarNote", "Recorded training, quieter days and gaps in your data."
    )
    pdf.drawString(MARGIN + 18, 437, _fit_text(note, "Helvetica", 8, CONTENT_W - 36))
    cell_width = (CONTENT_W - 36) / 7
    for column, label in enumerate(("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")):
        pdf.setFont("Helvetica-Bold", 7)
        pdf.drawString(MARGIN + 18 + column * cell_width + 9, 413, label)
    for row, week in enumerate(Calendar().monthdatescalendar(month.year, month.month)):
        for column, day in enumerate(week):
            if day.month != month.month:
                continue
            status = "outside" if day > end else days.get(day.isoformat(), "missing")
            fill, color = {
                "training": (TRAIN, CARD),
                "rest": (TRAIN_LIGHT, TRAIN),
                "missing": (PAPER, MUTED),
                "outside": (CARD, FAINT),
            }[status]
            x = MARGIN + 18 + column * cell_width
            y = 373 - row * 34
            _card(pdf, x, y, cell_width - 5, 29, fill)
            pdf.setFillColor(color)
            pdf.setFont("Helvetica-Bold", 9)
            pdf.drawString(x + 9, y + 10, str(day.day))
            if status == "missing":
                pdf.setFont("Helvetica", 8)
                pdf.drawRightString(x + cell_width - 13, y + 10, "?")
    for index, (label, fill) in enumerate(
        (
            ("Training", TRAIN),
            ("No training recorded", TRAIN_LIGHT),
            ("?  Missing data", PAPER),
            ("Outside period", CARD),
        )
    ):
        x = MARGIN + 18 + index * (CONTENT_W - 36) / 4
        pdf.setFillColor(fill)
        pdf.setStrokeColor(LINE)
        pdf.roundRect(x, 153, 9, 9, 2, fill=1, stroke=1)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 7)
        pdf.drawString(x + 13, 155, label)


def _section_page(
    pdf: canvas.Canvas,
    snapshot: dict[str, Any],
    key: str,
    title: str,
    accent: Any,
    accent_light: Any,
    page_number: int,
    total_pages: int,
    month_label: str,
    metrics: list[dict[str, Any]],
) -> None:
    analysis = snapshot["analysis"][key]
    kicker = (
        "Dashboard metrics only"
        if key != "selfReported"
        else "Coffee, reading and answered questions"
    )
    _page_base(pdf, page_number, total_pages, title, kicker, accent, month_label)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 9)
    description = (
        "Monthly values compared with the 90 days immediately before this report."
        if key != "selfReported"
        else "Only answered days are included; missing check-ins are never treated as zero."
    )
    headline = analysis.get("headline")
    if headline:
        pdf.setFillColor(accent)
        size = min(13, 13 * CONTENT_W / stringWidth(headline, "Helvetica-Bold", 13))
        pdf.setFont("Helvetica-Bold", size)
        pdf.drawString(MARGIN, PAGE_H - 128, headline)
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 7.5)
    pdf.drawString(MARGIN, PAGE_H - (143 if headline else 128), description)

    shown_metrics = metrics
    if not shown_metrics:
        _card(pdf, MARGIN, 570, CONTENT_W, 112, accent_light)
        pdf.setFillColor(accent)
        pdf.setFont("Helvetica-Bold", 16)
        pdf.drawString(MARGIN + 18, 630, "No comparable data")
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica", 9)
        pdf.drawString(
            MARGIN + 18, 604, "Complete more tracked days to unlock this section."
        )
        recap_y = 240
        recap_h = 285
    else:
        columns = 4 if len(shown_metrics) > 3 else max(1, len(shown_metrics))
        rows = (len(shown_metrics) + columns - 1) // columns
        gap = 9
        width = (CONTENT_W - gap * (columns - 1)) / columns
        card_height = 92
        top = 692
        for index, metric in enumerate(shown_metrics):
            row, column = divmod(index, columns)
            _metric_card(
                pdf,
                MARGIN + column * (width + gap),
                top - (row + 1) * card_height - row * gap,
                width,
                card_height,
                metric,
                accent,
            )
        recap_y = 215 if rows == 2 else 305
        recap_h = 275 if rows == 2 else 275
    _recap_card(
        pdf, MARGIN, recap_y, CONTENT_W, recap_h, analysis, accent, accent_light
    )
    pdf.setFillColor(FAINT)
    pdf.setFont("Helvetica", 7)
    pdf.drawString(
        MARGIN,
        52,
        "n = report / baseline observations. Small samples and incomplete coverage should be interpreted cautiously.",
    )
    pdf.showPage()


def _metric_card(
    pdf: canvas.Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    metric: dict[str, Any],
    accent: Any,
) -> None:
    _card(pdf, x, y, width, height)
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica-Bold", 6.7)
    label_lines = _wrap(metric["label"].upper(), "Helvetica-Bold", 6.7, width - 24)[:2]
    for index, line in enumerate(label_lines):
        pdf.drawString(x + 12, y + height - 18 - index * 8, line)
    current = metric["current"]
    if current is None:
        pdf.setFillColor(FAINT)
        pdf.setFont("Helvetica-Bold", 15)
        pdf.drawString(x + 12, y + 38, "No data")
        delta_text = "No monthly values"
        delta_color = MUTED
    else:
        pdf.setFillColor(INK)
        value_text = f"{current:,.{metric['decimals']}f}"
        value_size = min(
            16, 16 * (width - 24) / stringWidth(value_text, "Helvetica-Bold", 16)
        )
        pdf.setFont("Helvetica-Bold", value_size)
        pdf.drawString(x + 12, y + 42, value_text)
        unit = metric["unit"]
        if unit:
            unit_size = min(
                7.5, 7.5 * (width - 24) / stringWidth(unit, "Helvetica", 7.5)
            )
            pdf.setFillColor(MUTED)
            pdf.setFont("Helvetica", unit_size)
            pdf.drawString(x + 12, y + 30, unit)
        delta = metric["delta"]
        delta_text = (
            "No prior baseline"
            if delta is None
            else f"{delta:+,.{metric['decimals']}f} {metric['unit']} vs 90d"
        )
        favorable = (
            delta is not None
            and metric["higherIsBetter"] is not None
            and ((delta >= 0) == metric["higherIsBetter"])
        )
        delta_color = (
            accent
            if favorable
            else NEGATIVE
            if delta is not None and metric["higherIsBetter"] is not None
            else MUTED
        )
    pdf.setFillColor(delta_color)
    pdf.setFont("Helvetica-Bold", 6.5)
    pdf.drawString(
        x + 12,
        y + 18,
        _fit_text(delta_text, "Helvetica-Bold", 6.5, width - 24),
    )
    pdf.setFillColor(FAINT)
    pdf.setFont("Helvetica", 6)
    pdf.drawString(
        x + 12, y + 7, f"n={metric['currentSamples']} / {metric['baselineSamples']}"
    )


def _fit_text(text: str, font: str, size: float, width: float) -> str:
    if stringWidth(text, font, size) <= width:
        return text
    shortened = text
    while shortened and stringWidth(f"{shortened}...", font, size) > width:
        shortened = shortened[:-1]
    return f"{shortened.rstrip()}..."


def _recap_card(
    pdf: canvas.Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    analysis: dict[str, Any],
    accent: Any,
    accent_light: Any,
) -> None:
    _card(pdf, x, y, width, height)
    pdf.setFillColor(accent)
    pdf.setFont("Helvetica-Bold", 8)
    pdf.drawString(x + 18, y + height - 27, "MONTHLY RECAP")
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica", 10)
    for index, line in enumerate(
        _wrap(analysis["recap"], "Helvetica", 10, width - 36)[:6]
    ):
        pdf.drawString(x + 18, y + height - 53 - index * 14, line)
    panel_width = (width - 46) / 2
    for index, (label, points, fill, color) in enumerate(
        (
            ("WENT WELL", analysis["wentWell"], accent_light, accent),
            (
                "NEEDS ATTENTION",
                analysis["needsAttention"],
                HexColor("#F2E2DE"),
                NEGATIVE,
            ),
        )
    ):
        panel_x = x + 18 + index * (panel_width + 10)
        _card(pdf, panel_x, y + 18, panel_width, 94, fill)
        pdf.setFillColor(color)
        pdf.setFont("Helvetica-Bold", 7)
        pdf.drawString(panel_x + 12, y + 88, label)
        copy = "No clear signal yet." if not points else " ".join(points)
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica", 8)
        for line_index, line in enumerate(
            _wrap(copy, "Helvetica", 8, panel_width - 24)[:5]
        ):
            pdf.drawString(panel_x + 12, y + 70 - line_index * 11, line)


def _friendly_period(start_raw: str, end_raw: str) -> str:
    start = date.fromisoformat(start_raw)
    end = date.fromisoformat(end_raw)
    return f"{start.strftime('%d %b')}–{end.strftime('%d %b %Y')}"
