#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import struct
import zlib
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


ROOT = Path(__file__).resolve().parents[1]
SUMMARY_DIR = ROOT / "results" / "summary"
VISUALS_DIR = ROOT / "results" / "visuals"

CONFIG_ORDER = [
    "heuristic_off",
    "auto_off",
    "heuristic_hybrid",
    "auto_hybrid",
]

CONFIG_LABELS = {
    "heuristic_off": "HEURISTIC / EMBEDDINGS OFF",
    "auto_off": "AUTO / EMBEDDINGS OFF",
    "heuristic_hybrid": "HEURISTIC / EMBEDDINGS ON",
    "auto_hybrid": "AUTO / EMBEDDINGS ON",
}

CONFIG_COLORS = {
    "heuristic_off": (122, 127, 138),
    "auto_off": (47, 111, 237),
    "heuristic_hybrid": (240, 138, 36),
    "auto_hybrid": (10, 138, 91),
}

SUBSET_COLORS = {
    "all": (31, 78, 121),
    "embedding_sensitive": (184, 92, 56),
}

POSITIVE_COLOR = (10, 138, 91)
NEGATIVE_COLOR = (192, 58, 43)
GRID_COLOR = (213, 221, 232)
TEXT_COLOR = (23, 32, 42)
SUBTEXT_COLOR = (81, 96, 111)
BG_COLOR = (247, 249, 252)
AXIS_COLOR = (107, 114, 128)


FONT_5X7: Dict[str, Sequence[str]] = {
    " ": ["00000"] * 7,
    ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
    ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
    ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
    "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "11100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "J": ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
}


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def latest_stem(summary_dir: Path) -> str:
    candidates = sorted(
        summary_dir.glob("*.overall-summary.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise SystemExit("No overall-summary.json files found in testing-rec/results/summary")
    return candidates[0].name[: -len(".overall-summary.json")]


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def sanitize_text(value: str, max_len: int | None = None) -> str:
    upper = value.upper()
    upper = upper.replace("&", " AND ")
    upper = upper.replace("_", " ")
    upper = re.sub(r"[^A-Z0-9 .,:+/%-]", " ", upper)
    upper = re.sub(r"\s+", " ", upper).strip()
    if max_len and len(upper) > max_len:
        upper = upper[: max_len - 3].rstrip() + "..."
    return upper


def nice_number(value: float) -> str:
    if abs(value) >= 1:
        return f"{value:.2f}"
    return f"{value:.3f}"


def legend_item_width(label: str, scale: int = 2) -> int:
    sanitized = sanitize_text(label)
    return 34 + len(sanitized) * (6 * scale) + 28


def wrap_legend_rows(labels: Sequence[str], max_width: int) -> List[List[Tuple[str, int]]]:
    rows: List[List[Tuple[str, int]]] = []
    current: List[Tuple[str, int]] = []
    cursor = 0
    for label in labels:
        item_w = legend_item_width(label)
        if current and cursor + item_w > max_width:
            rows.append(current)
            current = []
            cursor = 0
        current.append((label, cursor))
        cursor += item_w
    if current:
        rows.append(current)
    return rows


class Canvas:
    def __init__(self, width: int, height: int, bg: Tuple[int, int, int] = BG_COLOR):
        self.width = width
        self.height = height
        self.pixels = bytearray(bg * width * height)

    def set_pixel(self, x: int, y: int, color: Tuple[int, int, int]) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            idx = (y * self.width + x) * 3
            self.pixels[idx : idx + 3] = bytes(color)

    def fill_rect(self, x: int, y: int, width: int, height: int, color: Tuple[int, int, int]) -> None:
        x0 = max(0, x)
        y0 = max(0, y)
        x1 = min(self.width, x + width)
        y1 = min(self.height, y + height)
        if x1 <= x0 or y1 <= y0:
            return
        row = bytes(color * (x1 - x0))
        for yy in range(y0, y1):
            idx = (yy * self.width + x0) * 3
            self.pixels[idx : idx + len(row)] = row

    def draw_line(self, x1: int, y1: int, x2: int, y2: int, color: Tuple[int, int, int], width: int = 1, dash: int | None = None) -> None:
        dx = x2 - x1
        dy = y2 - y1
        steps = max(abs(dx), abs(dy), 1)
        for i in range(steps + 1):
            if dash and ((i // dash) % 2 == 1):
                continue
            x = round(x1 + dx * i / steps)
            y = round(y1 + dy * i / steps)
            half = max(0, width // 2)
            for ox in range(-half, half + 1):
                for oy in range(-half, half + 1):
                    self.set_pixel(x + ox, y + oy, color)

    def draw_text(self, x: int, y: int, value: str, color: Tuple[int, int, int] = TEXT_COLOR, scale: int = 2) -> None:
        cursor = x
        for ch in sanitize_text(value):
            glyph = FONT_5X7.get(ch, FONT_5X7[" "])
            for row_idx, row in enumerate(glyph):
                for col_idx, bit in enumerate(row):
                    if bit != "1":
                        continue
                    self.fill_rect(cursor + col_idx * scale, y + row_idx * scale, scale, scale, color)
            cursor += 6 * scale

    def save_png(self, path: Path) -> None:
        raw = bytearray()
        stride = self.width * 3
        for y in range(self.height):
            raw.append(0)
            start = y * stride
            raw.extend(self.pixels[start : start + stride])
        compressed = zlib.compress(bytes(raw), level=9)

        def chunk(tag: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + tag
                + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        png = bytearray(b"\x89PNG\r\n\x1a\n")
        png.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)))
        png.extend(chunk(b"IDAT", compressed))
        png.extend(chunk(b"IEND", b""))
        path.write_bytes(png)


def grouped_bar_chart(
    path: Path,
    title: str,
    subtitle: str,
    categories: Sequence[str],
    series: Sequence[Tuple[str, Tuple[int, int, int], Sequence[float]]],
    y_max: float = 1.0,
    width: int = 1400,
    height: int = 820,
) -> None:
    left = 120
    right = 50
    top = 120
    legend_rows = wrap_legend_rows([label for label, _color, _values in series], width - left - right)
    bottom = max(170, 86 + len(legend_rows) * 38)
    canvas = Canvas(width, height)
    plot_w = width - left - right
    plot_h = height - top - bottom

    canvas.draw_text(left, 34, title, scale=3)
    canvas.draw_text(left, 72, subtitle, color=SUBTEXT_COLOR, scale=2)

    for i in range(6):
        ratio = i / 5
        y = top + plot_h - int(ratio * plot_h)
        value = ratio * y_max
        canvas.draw_line(left, y, left + plot_w, y, GRID_COLOR, dash=8)
        canvas.draw_text(18, y - 8, nice_number(value), color=SUBTEXT_COLOR, scale=2)

    groups = len(categories)
    series_count = len(series)
    group_gap = 30
    group_w = int((plot_w - group_gap * max(groups - 1, 0)) / max(groups, 1))
    bar_gap = 10
    bar_w = max(10, int((group_w - bar_gap * max(series_count - 1, 0)) / max(series_count, 1)))

    for idx, category in enumerate(categories):
        group_x = left + idx * (group_w + group_gap)
        canvas.draw_text(group_x + 6, top + plot_h + 28, category, scale=2)
        for s_idx, (_label, color, values) in enumerate(series):
            value = values[idx] if idx < len(values) else 0.0
            value = max(0.0, value)
            bar_h = int((value / y_max) * plot_h) if y_max > 0 else 0
            bar_x = group_x + s_idx * (bar_w + bar_gap)
            bar_y = top + plot_h - bar_h
            canvas.fill_rect(bar_x, bar_y, bar_w, bar_h, color)
            canvas.draw_text(bar_x, max(88, bar_y - 18), nice_number(value), scale=2)

    legend_x = left
    legend_y = top + plot_h + 72
    color_by_label = {label: color for label, color, _values in series}
    for row_idx, row in enumerate(legend_rows):
        row_y = legend_y + row_idx * 38
        for label, offset in row:
            color = color_by_label[label]
            cursor = legend_x + offset
            canvas.fill_rect(cursor, row_y, 24, 24, color)
            canvas.draw_text(cursor + 34, row_y + 4, label, scale=2)

    canvas.save_png(path)


def horizontal_bar_chart(
    path: Path,
    title: str,
    subtitle: str,
    rows: Sequence[Tuple[str, float, Tuple[int, int, int]]],
    min_x: float,
    max_x: float,
    center_line: float | None = None,
    width: int = 1800,
    row_height: int = 30,
) -> None:
    top = 120
    bottom = 60
    left = 520
    right = 80
    height = top + bottom + row_height * len(rows)
    plot_w = width - left - right
    span = max(max_x - min_x, 1e-9)
    canvas = Canvas(width, height)

    canvas.draw_text(left, 34, title, scale=3)
    canvas.draw_text(left, 72, subtitle, color=SUBTEXT_COLOR, scale=2)

    for i in range(7):
        ratio = i / 6
        x = left + int(ratio * plot_w)
        value = min_x + ratio * span
        canvas.draw_line(x, top - 6, x, height - bottom + 4, GRID_COLOR, dash=8)
        canvas.draw_text(x - 10, top - 34, nice_number(value), color=SUBTEXT_COLOR, scale=2)

    if center_line is not None and min_x <= center_line <= max_x:
        x = left + int(((center_line - min_x) / span) * plot_w)
        canvas.draw_line(x, top - 8, x, height - bottom + 4, AXIS_COLOR, width=2)

    for idx, (label, value, color) in enumerate(rows):
        y = top + idx * row_height
        display = sanitize_text(label, 42)
        canvas.draw_text(16, y + 6, display, scale=2)
        start_val = center_line if center_line is not None else min_x
        lo = min(value, start_val)
        hi = max(value, start_val)
        x1 = left + int(((lo - min_x) / span) * plot_w)
        x2 = left + int(((hi - min_x) / span) * plot_w)
        canvas.fill_rect(x1, y + 4, max(2, x2 - x1), row_height - 10, color)
        label_x = x2 + 8 if value >= start_val else max(0, x1 - 90)
        canvas.draw_text(label_x, y + 6, nice_number(value), scale=2)

    canvas.save_png(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate PNG charts from benchmark summary JSON files.")
    parser.add_argument("--stem", help="Benchmark output stem. Defaults to latest overall-summary stem.")
    args = parser.parse_args()

    stem = args.stem or latest_stem(SUMMARY_DIR)
    overall = load_json(SUMMARY_DIR / f"{stem}.overall-summary.json")
    metrics = load_json(SUMMARY_DIR / f"{stem}.metric-summary.json")
    subsets = load_json(SUMMARY_DIR / f"{stem}.subset-summary.json")
    embedding_impact = load_json(SUMMARY_DIR / f"{stem}.embedding-impact.json")
    cases = load_json(SUMMARY_DIR / f"{stem}.case-summary.json")

    output_dir = VISUALS_DIR / stem
    ensure_dir(output_dir)

    overall_map = {row["configId"]: row for row in overall}
    metric_map: Dict[str, Dict[str, float]] = {}
    for row in metrics:
        metric_map.setdefault(row["metric"], {})[row["configId"]] = row["mean"]

    subset_map: Dict[str, Dict[str, dict]] = {}
    for row in subsets:
        subset_map.setdefault(row["subsetId"], {})[row["configId"]] = row

    impact_map: Dict[str, Dict[str, float]] = {}
    for row in embedding_impact:
        impact_map.setdefault(row["subsetId"], {})[row["metric"]] = row["meanDelta"]

    case_map: Dict[str, Dict[str, dict]] = {}
    for row in cases:
        case_map.setdefault(row["caseId"], {})[row["configId"]] = row

    generated: List[str] = []

    grouped_bar_chart(
        output_dir / "overall_accuracy.png",
        "OVERALL ACCURACY BY CONFIG",
        f"RUN {stem}",
        ["OVERALL"],
        [
            (CONFIG_LABELS[cfg], CONFIG_COLORS[cfg], [overall_map[cfg]["overall"]])
            for cfg in CONFIG_ORDER
            if cfg in overall_map
        ],
        y_max=1.0,
        width=1000,
        height=760,
    )
    generated.append("overall_accuracy.png")

    key_metrics = ["selection", "semantic", "negation", "color", "persona", "pool_quality", "diversity", "progression"]
    key_labels = ["SELECTION", "SEMANTIC", "NEGATION", "COLOR", "PERSONA", "POOL", "DIVERSITY", "PROGRESSION"]
    grouped_bar_chart(
        output_dir / "key_metrics_by_config.png",
        "KEY METRICS BY CONFIG",
        "MAIN BENCHMARK METRICS",
        key_labels,
        [
            (CONFIG_LABELS[cfg], CONFIG_COLORS[cfg], [metric_map.get(m, {}).get(cfg, 0.0) for m in key_metrics])
            for cfg in CONFIG_ORDER
            if cfg in overall_map
        ],
        y_max=1.0,
        width=1600,
        height=820,
    )
    generated.append("key_metrics_by_config.png")

    grouped_bar_chart(
        output_dir / "subset_overall.png",
        "OVERALL BY SUBSET",
        "ALL CASES VS EMBEDDING SENSITIVE CASES",
        ["ALL CASES", "EMBEDDING SENSITIVE"],
        [
            (
                CONFIG_LABELS[cfg],
                CONFIG_COLORS[cfg],
                [
                    subset_map.get("all", {}).get(cfg, {}).get("overall", 0.0),
                    subset_map.get("embedding_sensitive", {}).get(cfg, {}).get("overall", 0.0),
                ],
            )
            for cfg in CONFIG_ORDER
            if cfg in overall_map
        ],
        y_max=1.0,
        width=1200,
        height=760,
    )
    generated.append("subset_overall.png")

    impact_metrics = ["overall", "selection", "semantic", "pool_quality", "diversity", "semanticShare", "semanticFrontierShare"]
    impact_labels = ["OVERALL", "SELECTION", "SEMANTIC", "POOL", "DIVERSITY", "SEM SHARE", "FRONTIER"]
    impact_y_max = max(
        0.2,
        max([impact_map.get("all", {}).get(metric, 0.0) for metric in impact_metrics] +
            [impact_map.get("embedding_sensitive", {}).get(metric, 0.0) for metric in impact_metrics]) * 1.25,
    )
    grouped_bar_chart(
        output_dir / "hybrid_vs_auto_off_impact.png",
        "AUTO EMBEDDINGS ON VS AUTO EMBEDDINGS OFF",
        "POSITIVE BARS FAVOR EMBEDDINGS ON",
        impact_labels,
        [
            ("ALL CASES", SUBSET_COLORS["all"], [impact_map.get("all", {}).get(m, 0.0) for m in impact_metrics]),
            ("EMBED SENSITIVE", SUBSET_COLORS["embedding_sensitive"], [impact_map.get("embedding_sensitive", {}).get(m, 0.0) for m in impact_metrics]),
        ],
        y_max=impact_y_max,
        width=1500,
        height=820,
    )
    generated.append("hybrid_vs_auto_off_impact.png")

    grouped_bar_chart(
        output_dir / "semantic_frontier_by_config.png",
        "SEMANTIC USAGE BY CONFIG",
        "HOW MUCH EACH CONFIG USES SEMANTIC SCORING AND FRONTIER PROMOTION",
        ["SEM SHARE", "FRONTIER SHARE"],
        [
            (
                CONFIG_LABELS[cfg],
                CONFIG_COLORS[cfg],
                [overall_map[cfg].get("semanticShare", 0.0), overall_map[cfg].get("semanticFrontierShare", 0.0)],
            )
            for cfg in CONFIG_ORDER
            if cfg in overall_map
        ],
        y_max=max(0.15, max(overall_map[cfg].get("semanticFrontierShare", 0.0) for cfg in overall_map) * 1.4),
        width=1100,
        height=760,
    )
    generated.append("semantic_frontier_by_config.png")

    auto_hybrid_rows = []
    for row in cases:
        if row["configId"] != "auto_hybrid":
            continue
        color = POSITIVE_COLOR if "embedding_sensitive" in row.get("tags", []) else CONFIG_COLORS["auto_hybrid"]
        auto_hybrid_rows.append((row["prompt"], row["metrics"]["overall"], color))
    auto_hybrid_rows.sort(key=lambda item: item[1], reverse=True)
    horizontal_bar_chart(
        output_dir / "auto_hybrid_case_accuracy.png",
        "AUTO EMBEDDINGS ON OVERALL SCORE BY CASE",
        "PER CASE OVERALL ACCURACY",
        auto_hybrid_rows,
        min_x=0.0,
        max_x=1.0,
        width=1900,
    )
    generated.append("auto_hybrid_case_accuracy.png")

    delta_rows = []
    for case_id, cfg_rows in case_map.items():
        if "auto_hybrid" not in cfg_rows or "auto_off" not in cfg_rows:
            continue
        prompt = cfg_rows["auto_hybrid"]["prompt"]
        delta = cfg_rows["auto_hybrid"]["metrics"]["overall"] - cfg_rows["auto_off"]["metrics"]["overall"]
        delta_rows.append((prompt, delta, POSITIVE_COLOR if delta >= 0 else NEGATIVE_COLOR))
    delta_rows.sort(key=lambda item: item[1], reverse=True)
    delta_bound = max([abs(row[1]) for row in delta_rows] + [0.1]) * 1.1
    horizontal_bar_chart(
        output_dir / "auto_hybrid_vs_auto_off_case_delta.png",
        "AUTO EMBEDDINGS ON MINUS AUTO EMBEDDINGS OFF",
        "GREEN FAVORS EMBEDDINGS ON, RED FAVORS EMBEDDINGS OFF",
        delta_rows,
        min_x=-delta_bound,
        max_x=delta_bound,
        center_line=0.0,
        width=1900,
    )
    generated.append("auto_hybrid_vs_auto_off_case_delta.png")

    summary = {
        "stem": stem,
        "charts": generated,
        "topline": {
            cfg: {
                "overall": overall_map[cfg]["overall"],
                "meanLatencyMs": overall_map[cfg]["meanLatencyMs"],
                "semanticShare": overall_map[cfg].get("semanticShare", 0.0),
                "semanticFrontierShare": overall_map[cfg].get("semanticFrontierShare", 0.0),
            }
            for cfg in CONFIG_ORDER
            if cfg in overall_map
        },
    }
    (output_dir / "visual-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    generated.append("visual-summary.json")

    print(json.dumps({"stem": stem, "outputDir": str(output_dir), "charts": generated}, indent=2))


if __name__ == "__main__":
    main()
