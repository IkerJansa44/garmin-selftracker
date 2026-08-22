from __future__ import annotations

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
    _page_base(
        pdf,
        1,
        total_pages,
        f"{datetime.strptime(snapshot['reportMonth'], '%Y-%m').strftime('%B')}, at a glance",
        f"Monthly overview  /  {_friendly_period(period['start'], period['end'])}",
        TERRACOTTA,
        month_label,
    )
    pdf.setFillColor(MUTED)
    pdf.setFont("Helvetica", 9)
    pdf.drawString(
        MARGIN,
        PAGE_H - 128,
        "A compact review of the dashboard signals and daily context that mattered most.",
    )
    _card(pdf, MARGIN, 635, CONTENT_W, 70, CARD)
    stats = [
        (
            "GARMIN COVERAGE",
            f"{coverage['importedDays']} / {coverage['expectedDays']} days",
        ),
        (
            "CHECK-IN COVERAGE",
            f"{coverage['checkinDays']} / {coverage['expectedDays']} days",
        ),
        ("COMPARISON", "Prior 90 days"),
    ]
    column_width = CONTENT_W / 3
    for index, (label, value) in enumerate(stats):
        x = MARGIN + index * column_width + 16
        pdf.setFillColor(MUTED)
        pdf.setFont("Helvetica-Bold", 7)
        pdf.drawString(x, 681, label)
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica-Bold", 15)
        pdf.drawString(x, 654, value)

    sections = [
        ("sleep", "SLEEP", SLEEP, SLEEP_LIGHT),
        ("training", "TRAINING", TRAIN, TRAIN_LIGHT),
        ("selfReported", "SELF-REPORTED", SELF, SELF_LIGHT),
    ]
    y = 465
    for key, label, accent, fill in sections:
        analysis = snapshot["analysis"][key]
        _card(pdf, MARGIN, y, CONTENT_W, 142, fill)
        pdf.setFillColor(accent)
        pdf.setFont("Helvetica-Bold", 8)
        pdf.drawString(MARGIN + 18, y + 112, label)
        pdf.setFont("Helvetica-Bold", 14)
        pdf.drawRightString(
            PAGE_W - MARGIN - 18,
            y + 109,
            analysis["assessment"].replace("_", " ").upper(),
        )
        pdf.setFillColor(INK)
        pdf.setFont("Helvetica", 10)
        for line_index, line in enumerate(
            _wrap(analysis["recap"], "Helvetica", 10, CONTENT_W - 36)[:5]
        ):
            pdf.drawString(MARGIN + 18, y + 83 - line_index * 14, line)
        y -= 158
    pdf.setFillColor(FAINT)
    pdf.setFont("Helvetica", 7)
    source = (
        "Codex editorial analysis"
        if snapshot["analysisSource"] == "codex"
        else "Deterministic editorial fallback"
    )
    pdf.drawString(
        MARGIN,
        52,
        f"{source}. Values are calculated locally; comparisons are descriptive, not medical advice.",
    )
    pdf.showPage()


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
    pdf.drawString(MARGIN, PAGE_H - 128, description)

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
        pdf.setFont("Helvetica-Bold", 16)
        pdf.drawString(x + 12, y + 38, _format_value(current, metric))
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


def _format_value(value: float, metric: dict[str, Any]) -> str:
    return f"{value:,.{metric['decimals']}f} {metric['unit']}".strip()


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
