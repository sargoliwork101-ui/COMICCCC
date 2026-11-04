"""Group nearby OCR lines into comic bubbles or structured book/document blocks."""
from __future__ import annotations

import copy
import re
from statistics import median
from typing import Any

from .text_preparation import join_ocr_lines

_LIST_ITEM_RE = re.compile(
    r"^\s*(?:[•●▪◦‣⁃\-–—*]|\(?[0-9۰-۹]{1,3}[.)]|\([a-zA-Z]\)|\[[0-9]{1,3}\])\s+\S"
)
_HEADING_PREFIX_RE = re.compile(
    r"^\s*(?:chapter|section|part|appendix|abstract|introduction|conclusion|references|"
    r"فصل|بخش|مقدمه|نتیجه‌گیری|منابع|\d+(?:\.\d+){0,3}\s+[A-ZА-Я\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff])\b",
    re.IGNORECASE,
)
_SENTENCE_END_RE = re.compile(r'[.!?…。！？:؛»")\]]\s*$')


def _height(block: dict[str, Any]) -> float:
    return max(8.0, float(block.get("y1", 0)) - float(block.get("y0", 0)))


def _width(block: dict[str, Any]) -> float:
    return max(1.0, float(block.get("x1", 0)) - float(block.get("x0", 0)))


def _line_h(block: dict[str, Any]) -> float:
    raw = float(block.get("lineH") or 0)
    return max(8.0, raw if raw > 0 else _height(block))


def _is_multi_line_box(block: dict[str, Any]) -> bool:
    lh = _line_h(block)
    return _height(block) > lh * 1.85 or "\n" in str(block.get("text") or "").strip()


def _prose_character_stats(blocks: list[dict[str, Any]]) -> tuple[int, int, int, int]:
    total_chars = 0
    alpha_chars = 0
    lower_chars = 0
    cjk_chars = 0
    for blk in blocks:
        txt = str(blk.get("text") or "").strip()
        total_chars += len(txt)
        for ch in txt:
            code = ord(ch)
            if (0x4E00 <= code <= 0x9FFF) or (0x3040 <= code <= 0x30FF) or (0xAC00 <= code <= 0xD7AF):
                cjk_chars += 1
            elif ch.isalpha():
                alpha_chars += 1
                if ch.islower():
                    lower_chars += 1
    return total_chars, alpha_chars, lower_chars, cjk_chars


def detect_page_mode(
    blocks: list[dict[str, Any]],
    page_size: tuple[int, int] | None = None,
) -> str:
    """Classify OCR blocks into 'document' (book/article/handout) or 'comic' (speech bubbles)."""
    valid = [b for b in blocks if str(b.get("text") or "").strip()]
    if not valid:
        return "comic"

    total_chars, alpha_chars, lower_chars, cjk_chars = _prose_character_stats(valid)
    lower_ratio = (lower_chars / alpha_chars) if alpha_chars else 0.0
    has_natural_case = lower_ratio >= 0.42 or cjk_chars >= 60

    # Case 1: VLM / layout engines already returned multi-sentence paragraph blocks.
    lengths = [len(str(b.get("text") or "").strip()) for b in valid]
    if total_chars >= 260 and has_natural_case and (max(lengths) >= 150 or median(lengths) >= 75):
        return "document"

    if len(valid) < 5:
        return "comic"

    med_lh = median(_line_h(b) for b in valid)
    page_w = float(page_size[0]) if page_size and page_size[0] > 0 else max(float(b.get("x1", 0)) for b in valid)
    page_w = max(page_w, 1.0)

    wide_lines = [
        b for b in valid
        if len(str(b.get("text") or "").strip()) >= 38
        or _width(b) >= max(page_w * 0.42, med_lh * 11.5)
    ]
    list_or_heading_hits = sum(
        1 for b in valid
        if _LIST_ITEM_RE.match(str(b.get("text") or "")) or _HEADING_PREFIX_RE.match(str(b.get("text") or ""))
    )

    # Check margin alignment consistency (1-column or 2-column book/article pages).
    x0s = sorted(float(b.get("x0", 0)) for b in valid)
    tol = max(14.0, med_lh * 1.8)
    best_cluster = 0
    for anchor in x0s:
        best_cluster = max(best_cluster, sum(1 for x in x0s if abs(x - anchor) <= tol))

    columns = _detect_column_ranges(valid, med_lh)
    if len(columns) >= 2 and len(valid) >= 6 and (has_natural_case or total_chars >= 180):
        return "document"

    if len(wide_lines) >= 4 and (has_natural_case or best_cluster >= max(4, int(len(valid) * 0.5))):
        return "document"

    if total_chars >= 280 and len(valid) >= 6 and has_natural_case and best_cluster >= max(4, int(len(valid) * 0.45)):
        return "document"

    if list_or_heading_hits >= 2 and len(valid) >= 5 and (has_natural_case or total_chars >= 160):
        return "document"

    return "comic"


def _detect_column_ranges(
    blocks: list[dict[str, Any]],
    med_lh: float,
) -> list[tuple[float, float]]:
    """Detect horizontal column intervals separated by a clean vertical gutter."""
    if len(blocks) < 4:
        return []
    min_x = min(float(b.get("x0", 0)) for b in blocks)
    max_x = max(float(b.get("x1", 0)) for b in blocks)
    span = max_x - min_x
    if span < max(160.0, med_lh * 8.0):
        return [(min_x, max_x)]

    # Exclude full-width spanning headers/titles/footers when probing column gutters.
    candidates = [b for b in blocks if _width(b) <= span * 0.68]
    if len(candidates) < 4:
        return [(min_x, max_x)]

    intervals = sorted((float(b.get("x0", 0)), float(b.get("x1", 0))) for b in candidates)
    min_gutter = max(16.0, med_lh * 1.15)
    merged: list[list[float]] = []
    for x0, x1 in intervals:
        if not merged or x0 - merged[-1][1] >= min_gutter:
            merged.append([x0, x1])
        else:
            merged[-1][1] = max(merged[-1][1], x1)

    if len(merged) < 2 or len(merged) > 4:
        return [(min_x, max_x)]

    # Verify at least two columns actually contain stacked lines overlapping vertically.
    col_members: list[list[dict[str, Any]]] = [[] for _ in merged]
    for blk in candidates:
        cx = (float(blk.get("x0", 0)) + float(blk.get("x1", 0))) * 0.5
        best_idx = min(range(len(merged)), key=lambda idx: 0.0 if merged[idx][0] <= cx <= merged[idx][1] else min(abs(cx - merged[idx][0]), abs(cx - merged[idx][1])))
        col_members[best_idx].append(blk)

    populated = [
        (rng, members)
        for rng, members in zip(merged, col_members)
        if len(members) >= 2 or (len(members) == 1 and _is_multi_line_box(members[0]))
    ]
    if len(populated) < 2:
        return [(min_x, max_x)]

    # Check vertical overlap between the two main columns so diagonal comic bubbles aren't mistaken for columns.
    y_ranges = [
        (min(float(m.get("y0", 0)) for m in members), max(float(m.get("y1", 0)) for m in members))
        for _, members in populated
    ]
    overlap_y = min(r[1] for r in y_ranges[:2]) - max(r[0] for r in y_ranges[:2])
    min_col_h = min(max(1.0, r[1] - r[0]) for r in y_ranges[:2])
    if overlap_y < min(min_col_h * 0.35, med_lh * 2.0):
        return [(min_x, max_x)]

    return [(rng[0], rng[1]) for rng, _ in populated]


def sort_document_reading_order(
    blocks: list[dict[str, Any]],
    page_size: tuple[int, int] | None = None,
    *,
    rtl_columns: bool = False,
) -> list[dict[str, Any]]:
    """Sort blocks in book/article reading order, preserving spanning headers and multi-column flow."""
    if len(blocks) < 2:
        return [copy.deepcopy(b) for b in blocks]

    working = [copy.deepcopy(b) for b in blocks]
    med_lh = median(_line_h(b) for b in working)
    columns = _detect_column_ranges(working, med_lh)
    if len(columns) < 2:
        working.sort(key=lambda b: (round(((float(b.get("y0", 0)) + float(b.get("y1", 0))) * 0.5) / max(8.0, med_lh * 0.55)), float(b.get("x0", 0)), float(b.get("y0", 0))))
        return working

    total_left = columns[0][0]
    total_right = columns[-1][1]
    total_span = max(1.0, total_right - total_left)

    def _is_spanning(blk: dict[str, Any]) -> bool:
        bx0, bx1 = float(blk.get("x0", 0)), float(blk.get("x1", 0))
        if (bx1 - bx0) > total_span * 0.68:
            return True
        touched = sum(1 for c0, c1 in columns if min(bx1, c1) - max(bx0, c0) > max(12.0, med_lh))
        return touched >= 2

    # Partition vertically at spanning titles/dividers/footers so top titles stay first and bottom footers stay last.
    by_y = sorted(working, key=lambda b: (float(b.get("y0", 0)), float(b.get("x0", 0))))
    ordered: list[dict[str, Any]] = []
    band: list[dict[str, Any]] = []

    def _flush_band() -> None:
        if not band:
            return
        band_cols = _detect_column_ranges(band, med_lh)
        if len(band_cols) < 2:
            band_cols = columns
        buckets: list[list[dict[str, Any]]] = [[] for _ in band_cols]
        for item in band:
            cx = (float(item.get("x0", 0)) + float(item.get("x1", 0))) * 0.5
            idx = min(
                range(len(band_cols)),
                key=lambda k: 0.0 if band_cols[k][0] <= cx <= band_cols[k][1] else min(abs(cx - band_cols[k][0]), abs(cx - band_cols[k][1])),
            )
            buckets[idx].append(item)
        col_indices = list(reversed(range(len(buckets)))) if rtl_columns else list(range(len(buckets)))
        for idx in col_indices:
            col_items = buckets[idx]
            col_items.sort(key=lambda b: (round(((float(b.get("y0", 0)) + float(b.get("y1", 0))) * 0.5) / max(8.0, med_lh * 0.55)), float(b.get("x0", 0))))
            ordered.extend(col_items)
        band.clear()

    for blk in by_y:
        if _is_spanning(blk):
            _flush_band()
            ordered.append(blk)
        else:
            band.append(blk)
    _flush_band()
    return ordered


def _classify_document_line_role(
    block: dict[str, Any],
    med_lh: float,
    col_width: float,
) -> str:
    txt = str(block.get("text") or "").strip()
    lh = _line_h(block)
    if lh >= med_lh * 1.26 and len(txt) <= 140:
        return "heading"
    if _HEADING_PREFIX_RE.match(txt) and len(txt) <= 110 and not txt.endswith("."):
        return "heading"
    if _LIST_ITEM_RE.match(txt):
        return "list"
    if (
        not _is_multi_line_box(block)
        and len(txt) <= 70
        and _width(block) <= col_width * 0.72
        and lh >= med_lh * 1.12
        and not _SENTENCE_END_RE.search(txt)
    ):
        return "heading"
    return "paragraph"


def _apply_document_block_defaults(block: dict[str, Any], role: str) -> dict[str, Any]:
    block["pageRole"] = role
    if "_explicitBold" not in block:
        block["bold"] = role == "heading"
    return block


def group_document_lines(
    blocks: list[dict[str, Any]],
    page_size: tuple[int, int] | None = None,
    *,
    rtl_columns: bool = False,
) -> list[dict[str, Any]]:
    """Group OCR lines into structured book/article headings, lists, and paragraphs."""
    if not blocks:
        return []
    ordered = sort_document_reading_order(blocks, page_size=page_size, rtl_columns=rtl_columns)
    if len(ordered) == 1:
        single = copy.deepcopy(ordered[0])
        med_lh = _line_h(single)
        role = _classify_document_line_role(single, med_lh, _width(single))
        single["id"] = 1
        return [_apply_document_block_defaults(single, role)]

    med_lh = median(_line_h(b) for b in ordered)
    columns = _detect_column_ranges(ordered, med_lh)

    def _column_bounds(blk: dict[str, Any]) -> tuple[int, float, float]:
        if len(columns) < 2:
            c0 = min(float(b.get("x0", 0)) for b in ordered)
            c1 = max(float(b.get("x1", 0)) for b in ordered)
            return 0, c0, max(c0 + 1.0, c1)
        bx0, bx1 = float(blk.get("x0", 0)), float(blk.get("x1", 0))
        total_span = max(1.0, columns[-1][1] - columns[0][0])
        if (bx1 - bx0) > total_span * 0.68:
            return -1, bx0, bx1
        cx = (bx0 + bx1) * 0.5
        idx = min(
            range(len(columns)),
            key=lambda k: 0.0 if columns[k][0] <= cx <= columns[k][1] else min(abs(cx - columns[k][0]), abs(cx - columns[k][1])),
        )
        return idx, columns[idx][0], max(columns[idx][0] + 1.0, columns[idx][1])

    # Estimate typical intra-paragraph vertical line gap on this page.
    small_gaps = []
    for prev, cur in zip(ordered, ordered[1:]):
        gap = float(cur.get("y0", 0)) - float(prev.get("y1", 0))
        if -0.3 * med_lh <= gap <= 0.85 * med_lh:
            small_gaps.append(gap)
    typical_gap = median(small_gaps) if small_gaps else med_lh * 0.25
    max_para_gap = max(med_lh * 0.65, typical_gap + med_lh * 0.32)

    groups: list[tuple[str, list[dict[str, Any]]]] = []
    cur_lines: list[dict[str, Any]] = []
    cur_role = "paragraph"
    cur_col = -2

    def _flush() -> None:
        if not cur_lines:
            return
        groups.append((cur_role, list(cur_lines)))
        cur_lines.clear()

    for line in ordered:
        col_idx, col_left, col_right = _column_bounds(line)
        col_w = max(1.0, col_right - col_left)
        role = _classify_document_line_role(line, med_lh, col_w)

        if not cur_lines:
            cur_lines.append(line)
            cur_role = role
            cur_col = col_idx
            continue

        prev = cur_lines[-1]
        prev_lh = _line_h(prev)
        cur_lh = _line_h(line)
        avg_lh = (prev_lh + cur_lh) * 0.5
        v_gap = float(line.get("y0", 0)) - float(prev.get("y1", 0))
        lh_ratio = max(prev_lh, cur_lh) / max(1.0, min(prev_lh, cur_lh))

        # Never merge across different columns, already-segmented multi-line VLM boxes, headings, or new list markers.
        same_col = col_idx == cur_col and col_idx != -1
        new_list_item = role == "list"
        either_heading = cur_role == "heading" or role == "heading"
        already_segmented = _is_multi_line_box(prev) or _is_multi_line_box(line)

        # Detect first-line paragraph indentation or previous short paragraph-ending line.
        indent_delta = float(line.get("x0", 0)) - float(prev.get("x0", 0))
        first_line_indent = (
            cur_role == "paragraph"
            and indent_delta >= avg_lh * 1.25
            and (float(line.get("x0", 0)) - col_left) >= avg_lh * 1.15
            and abs(float(prev.get("x0", 0)) - col_left) <= avg_lh * 1.1
        )
        prev_ended_early = (
            cur_role in {"paragraph", "list"}
            and (col_right - float(prev.get("x1", 0))) >= max(avg_lh * 2.6, col_w * 0.22)
            and _SENTENCE_END_RE.search(str(prev.get("text") or "")) is not None
        )

        x_overlap = min(float(prev.get("x1", 0)), float(line.get("x1", 0))) - max(float(prev.get("x0", 0)), float(line.get("x0", 0)))
        aligned_left = abs(float(line.get("x0", 0)) - float( cur_lines[0].get("x0", 0))) <= avg_lh * 2.2 or abs(float(line.get("x0", 0)) - col_left) <= avg_lh * 2.2

        can_merge = (
            same_col
            and not new_list_item
            and not either_heading
            and not already_segmented
            and lh_ratio <= 1.35
            and -0.35 * min(prev_lh, cur_lh) <= v_gap <= max_para_gap
            and (x_overlap >= 0.15 * min(_width(prev), _width(line)) or aligned_left)
            and not first_line_indent
            and not prev_ended_early
        )

        if can_merge:
            cur_lines.append(line)
        else:
            _flush()
            cur_lines.append(line)
            cur_role = role
            cur_col = col_idx

    _flush()

    grouped: list[dict[str, Any]] = []
    for block_id, (role, members) in enumerate(groups, start=1):
        if len(members) == 1:
            single = copy.deepcopy(members[0])
            single["id"] = block_id
            grouped.append(_apply_document_block_defaults(single, role))
            continue
        first = copy.deepcopy(members[0])
        x0 = min(float(m["x0"]) for m in members)
        y0 = min(float(m["y0"]) for m in members)
        x1 = max(float(m["x1"]) for m in members)
        y1 = max(float(m["y1"]) for m in members)
        paired = [(t, float(m.get("conf", 0))) for m in members if (t := str(m.get("text") or "").strip())]
        texts = [t for t, _ in paired]
        if paired:
            weights = [max(1, len(t)) for t, _ in paired]
            weighted_conf = round(sum(c * w for (_, c), w in zip(paired, weights)) / sum(weights), 2)
        else:
            weighted_conf = round(sum(float(m.get("conf", 0)) for m in members) / max(1, len(members)), 2)
        first.update({
            "id": block_id,
            "text": join_ocr_lines(texts),
            "tr": "",
            "richHtml": "",
            "conf": weighted_conf,
            "x0": x0,
            "y0": y0,
            "x1": x1,
            "y1": y1,
            "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "lineH": round(median(_line_h(m) for m in members), 2),
            "sourceIndent": int(members[0].get("sourceIndent") or 0),
            "sourceLines": copy.deepcopy(members),
        })
        for key in ("tx0", "ty0", "tx1", "ty1"):
            first.pop(key, None)
        grouped.append(_apply_document_block_defaults(first, role))
    return grouped


def _group_comic_lines(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Original comic speech-bubble union-find grouping (preserved 100% intact)."""
    if len(blocks) < 2:
        return [copy.deepcopy(block) for block in blocks]
    lines = [copy.deepcopy(block) for block in blocks]
    parent = list(range(len(lines)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(first: int, second: int) -> None:
        root_a, root_b = find(first), find(second)
        if root_a != root_b:
            parent[root_b] = root_a

    order = sorted(range(len(lines)), key=lambda idx: (float(lines[idx].get("y0", 0)), float(lines[idx].get("x0", 0))))
    for pos, idx in enumerate(order):
        line = lines[idx]
        height = _height(line)
        width = _width(line)
        center = (float(line["x0"]) + float(line["x1"])) / 2
        candidates = []
        for prev_idx in order[:pos]:
            prev = lines[prev_idx]
            prev_height = _height(prev)
            gap = float(line["y0"]) - float(prev["y1"])
            if gap < -0.35 * min(height, prev_height) or gap > 0.9 * max(height, prev_height):
                continue
            ratio = max(height, prev_height) / min(height, prev_height)
            if ratio > 1.65:
                continue
            prev_width = _width(prev)
            overlap = min(float(line["x1"]), float(prev["x1"])) - max(float(line["x0"]), float(prev["x0"]))
            if overlap < 0.4 * min(width, prev_width):
                continue
            prev_center = (float(prev["x0"]) + float(prev["x1"])) / 2
            if abs(center - prev_center) > 0.55 * max(width, prev_width):
                continue
            candidates.append((gap, abs(center - prev_center), prev_idx))
        if not candidates:
            continue
        roots = {find(prev_idx) for _, _, prev_idx in candidates}
        if len(roots) == 1:
            union(candidates[0][2], idx)

    buckets: dict[int, list[dict[str, Any]]] = {}
    for idx in order:
        buckets.setdefault(find(idx), []).append(lines[idx])

    grouped = []
    ordered_groups = sorted(buckets.values(), key=lambda items: (min(float(b["y0"]) for b in items), min(float(b["x0"]) for b in items)))
    for block_id, items in enumerate(ordered_groups, start=1):
        items.sort(key=lambda b: (round(((float(b["y0"]) + float(b["y1"])) / 2) / 10) * 10, float(b["x0"])))
        if len(items) == 1:
            single = copy.deepcopy(items[0])
            single["id"] = block_id
            grouped.append(single)
            continue
        first = copy.deepcopy(items[0])
        x0 = min(float(b["x0"]) for b in items)
        y0 = min(float(b["y0"]) for b in items)
        x1 = max(float(b["x1"]) for b in items)
        y1 = max(float(b["y1"]) for b in items)
        paired = [(t, float(b.get("conf", 0))) for b in items if (t := str(b.get("text") or "").strip())]
        texts = [t for t, _ in paired]
        if paired:
            weights = [max(1, len(text)) for text, _ in paired]
            weighted_conf = round(sum(c * w for (_, c), w in zip(paired, weights)) / sum(weights), 2)
        else:
            weighted_conf = first.get("conf", 0)
        first.update({
            "id": block_id,
            "text": " ".join(texts),
            "tr": "",
            "richHtml": "",
            "conf": weighted_conf,
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "lineH": round(median(_height(b) for b in items), 2),
            "sourceLines": copy.deepcopy(items),
        })
        for key in ("tx0", "ty0", "tx1", "ty1"):
            first.pop(key, None)
        grouped.append(first)
    return grouped


def group_ocr_lines(
    blocks: list[dict[str, Any]],
    *,
    page_mode: str = "comic",
    page_size: tuple[int, int] | None = None,
) -> list[dict[str, Any]]:
    """Group OCR lines according to comic bubble mode, document mode, or auto-detection."""
    effective = detect_page_mode(blocks, page_size=page_size) if page_mode == "auto" else page_mode
    if effective == "document":
        return group_document_lines(blocks, page_size=page_size)
    return _group_comic_lines(blocks)


def organize_ocr_blocks(
    blocks: list[dict[str, Any]],
    *,
    page_mode: str = "auto",
    group_lines: bool = True,
    page_size: tuple[int, int] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Order and optionally group OCR blocks for comics, books, articles, and handouts."""
    effective = detect_page_mode(blocks, page_size=page_size) if page_mode == "auto" else page_mode
    if effective == "document":
        if group_lines:
            return group_document_lines(blocks, page_size=page_size), "document"
        ordered = sort_document_reading_order(blocks, page_size=page_size)
        med_lh = median(_line_h(b) for b in ordered) if ordered else 16.0
        col_w = max((_width(b) for b in ordered), default=200.0)
        for idx, blk in enumerate(ordered, start=1):
            blk["id"] = idx
            role = _classify_document_line_role(blk, med_lh, col_w)
            _apply_document_block_defaults(blk, role)
        return ordered, "document"

    if group_lines:
        return _group_comic_lines(blocks), "comic"
    copied = [copy.deepcopy(b) for b in blocks]
    for idx, blk in enumerate(copied, start=1):
        blk["id"] = idx
    return copied, "comic"
