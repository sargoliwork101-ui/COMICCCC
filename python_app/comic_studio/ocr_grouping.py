"""Conservative grouping of positioned OCR lines into reversible paragraph blocks."""
from __future__ import annotations

from copy import deepcopy
from statistics import median
from typing import Any


def join_lines(texts: list[str]) -> str:
    return " ".join(" ".join(str(text or "").split()) for text in texts if str(text or "").strip())


def _merge(lines: list[dict[str, Any]]) -> dict[str, Any]:
    first = deepcopy(lines[0])
    x0 = min(line["x0"] for line in lines)
    y0 = min(line["y0"] for line in lines)
    x1 = max(line["x1"] for line in lines)
    y1 = max(line["y1"] for line in lines)
    weights = [max(1, len(str(line.get("text", "")).strip())) for line in lines]
    first.update({
        "text": join_lines([line.get("text", "") for line in lines]),
        "x0": x0, "y0": y0, "x1": x1, "y1": y1,
        "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        "lineH": median(float(line.get("lineH") or max(1, line["y1"] - line["y0"])) for line in lines),
        "conf": round(sum(float(line.get("conf", 0)) * weight for line, weight in zip(lines, weights)) / sum(weights), 2),
        "sourceLines": deepcopy(lines),
    })
    return first


def group_ocr_lines(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join nearby, horizontally overlapping lines; retain originals for manual splitting.

    Geometry alone cannot reliably detect bubbles, so ambiguous cases remain separate.
    """
    ordered = sorted(blocks, key=lambda b: (float(b["y0"]), float(b["x0"]), b["id"]))
    groups: list[list[dict[str, Any]]] = []
    for line in ordered:
        height = max(1.0, float(line["y1"]) - float(line["y0"]))
        width = max(1.0, float(line["x1"]) - float(line["x0"]))
        candidates: list[tuple[float, int]] = []
        for index, group in enumerate(groups):
            prev = group[-1]
            prev_height = max(1.0, float(prev["y1"]) - float(prev["y0"]))
            gap = float(line["y0"]) - float(prev["y1"])
            if gap < -0.2 * min(height, prev_height) or gap > 0.9 * max(height, prev_height):
                continue
            if min(height, prev_height) / max(height, prev_height) < 0.5:
                continue
            overlap = min(float(line["x1"]), float(prev["x1"])) - max(float(line["x0"]), float(prev["x0"]))
            prev_width = max(1.0, float(prev["x1"]) - float(prev["x0"]))
            if overlap < 0.4 * min(width, prev_width):
                continue
            candidates.append((max(0.0, gap) / max(height, prev_height), index))
        candidates.sort()
        # Equal-distance alternatives are ambiguous; do not guess between two bubbles.
        if candidates and (len(candidates) == 1 or candidates[1][0] - candidates[0][0] > 0.1):
            groups[candidates[0][1]].append(line)
        else:
            groups.append([line])
    result = [_merge(group) if len(group) > 1 else group[0] for group in groups]
    return sorted(result, key=lambda b: (float(b["y0"]), float(b["x0"]), b["id"]))
