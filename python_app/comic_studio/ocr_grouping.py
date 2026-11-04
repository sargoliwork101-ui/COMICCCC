"""Group nearby OCR lines into comic bubbles or structured book/document blocks."""
from __future__ import annotations

import copy
import re
from statistics import median
from typing import Any

from .text_preparation import join_ocr_lines

_LIST_ITEM_RE = re.compile(
    r"^\s*(?:[•●▪▫◦‣⁃\-–—*]|\(?[0-9۰-۹]{1,3}[.)]|\([a-zA-Zآ-ی]\)|\[[0-9]{1,3}\])\s+\S"
)
_MULTI_LEVEL_NUM_HEADING_RE = re.compile(
    r"^\s*\d+(?:\.\d+){1,8}\b[\s.:)\-–—]*\S"
)
_SINGLE_NUM_TITLE_RE = re.compile(
    r"^\s*(?:\d{1,3}|[IVXLCDM]{1,6})[.)\-:]\s+\S"
)
_HEADING_PREFIX_RE = re.compile(
    r"^\s*(?:"
    r"(?:chapter|section|part|appendix|annex|clause|abstract|introduction|conclusion|references|summary|overview|scope|"
    r"table|figure|fig\.|"
    r"فصل|بخش|گفتار|مقدمه|پیشگفتار|نتیجه‌گیری|منابع|پیوست|ضمیمه|خلاصه|جدول|شکل)\b"
    r"|(?:target|acceptable|process\s+indicator|defect|nonconforming)\s*[-–—:]\s*class\b"
    r"|[IVXLCDM]{1,6}[.)\-:]\s+[A-Zآ-ی]"
    r"|\d+(?:\.\d+){1,8}\b[\s.:)\-–—]*[A-Za-zآ-یА-Я\u4e00-\u9fff\uac00-\ud7af\u3040-\u30ff]"
    r")",
    re.IGNORECASE,
)
_STRUCTURED_LABEL_LINE_RE = re.compile(
    r"^\s*(?:class\s*[0-9,/\s]+|note\s*\d*|warning|caution|target|acceptable|defect|process\s+indicator|minimum|maximum|"
    r"کلاس\s*[۰-۹0-9]+|تبصره|نکته|هشدار|حداقل|حداکثر)\b[^.!?]{0,32}[:\-–—]\s*\S",
    re.IGNORECASE,
)
_SENTENCE_END_RE = re.compile(r'[.!?…。！？:؛»")\]]\s*$')
_PROSE_STOP_PUNCT_RE = re.compile(r'[.!?…。！？؛,،]\s*$')
_RTL_TEXT_RE = re.compile(r"[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]")


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
        if _LIST_ITEM_RE.match(str(b.get("text") or ""))
        or _HEADING_PREFIX_RE.match(str(b.get("text") or ""))
        or _MULTI_LEVEL_NUM_HEADING_RE.match(str(b.get("text") or ""))
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


def _is_all_caps_title(txt: str) -> bool:
    words = txt.split()
    if not (1 <= len(words) <= 14) or len(txt) > 100 or txt.endswith((".", ",", ";")):
        return False
    latin_alpha = [ch for ch in txt if "A" <= ch.upper() <= "Z" and ch.isalpha()]
    if len(latin_alpha) < 4:
        return False
    if any("a" <= ch <= "z" for ch in latin_alpha):
        return False
    if _RTL_TEXT_RE.search(txt):
        return False
    return True


def _classify_document_line_role(
    block: dict[str, Any],
    med_lh: float,
    col_width: float,
) -> str:
    preset_role = str(block.get("pageRole") or "").strip().lower()
    if preset_role in {"heading", "list"}:
        return preset_role

    txt = str(block.get("text") or "").strip()
    if not txt:
        return "paragraph"
    lh = _line_h(block)
    words = txt.split()
    word_count = len(words)
    is_bold = bool(block.get("_detectedBold") or block.get("_explicitBold") or block.get("bold"))

    if lh >= med_lh * 1.24 and len(txt) <= 140 and not txt.endswith((".", "،", ",", ";", "؛")):
        return "heading"
    if (
        (_MULTI_LEVEL_NUM_HEADING_RE.match(txt) or _HEADING_PREFIX_RE.match(txt))
        and len(txt) <= 130
        and word_count <= 22
        and not txt.endswith(".")
    ):
        return "heading"
    if (
        _SINGLE_NUM_TITLE_RE.match(txt)
        and word_count <= 14
        and len(txt) <= 100
        and not txt.endswith(".")
        and (is_bold or lh >= med_lh * 1.15 or _is_all_caps_title(txt))
    ):
        return "heading"
    if _LIST_ITEM_RE.match(txt):
        return "list"
    if (
        is_bold
        and not _is_multi_line_box(block)
        and word_count <= 16
        and len(txt) <= 110
        and _width(block) <= max(col_width * 0.88, med_lh * 18.0)
        and not _PROSE_STOP_PUNCT_RE.search(txt)
    ):
        return "heading"
    if not _is_multi_line_box(block) and _is_all_caps_title(txt) and _width(block) <= max(col_width * 0.88, med_lh * 18.0):
        return "heading"
    if (
        not _is_multi_line_box(block)
        and len(txt) <= 70
        and _width(block) <= col_width * 0.72
        and lh >= med_lh * 1.12
        and not _SENTENCE_END_RE.search(txt)
    ):
        return "heading"
    return "paragraph"


def _dominant_margin(values: list[float], tol: float, *, pick_high: bool = False) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    best_cluster: list[float] = [sorted_vals[0]]
    for anchor in sorted_vals:
        cluster = [v for v in sorted_vals if abs(v - anchor) <= tol]
        if len(cluster) > len(best_cluster):
            best_cluster = cluster
        elif len(cluster) == len(best_cluster):
            if pick_high and median(cluster) > median(best_cluster):
                best_cluster = cluster
            elif not pick_high and median(cluster) < median(best_cluster):
                best_cluster = cluster
    return float(median(best_cluster))


def _apply_document_block_defaults(block: dict[str, Any], role: str) -> dict[str, Any]:
    block["pageRole"] = role
    if role == "heading":
        block["bold"] = True
    else:
        block["bold"] = bool(block.get("_detectedBold") or block.get("_explicitBold"))
    if block.get("_detectedItalic") or block.get("italic"):
        block["italic"] = True
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
        single["sourceIndent"] = 0
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

    col_lines_map: dict[int, list[dict[str, Any]]] = {}
    for line in ordered:
        c_idx, _, _ = _column_bounds(line)
        col_lines_map.setdefault(c_idx, []).append(line)

    col_base_left_map: dict[int, float] = {}
    col_base_right_map: dict[int, float] = {}
    col_min_x0_map: dict[int, float] = {}
    col_max_x1_map: dict[int, float] = {}
    margin_tol = max(10.0, med_lh * 0.75)
    for c_idx, c_items in col_lines_map.items():
        x0_vals = [float(b.get("x0", 0)) for b in c_items if str(b.get("text") or "").strip()] or [float(b.get("x0", 0)) for b in c_items]
        x1_vals = [float(b.get("x1", 0)) for b in c_items if str(b.get("text") or "").strip()] or [float(b.get("x1", 0)) for b in c_items]
        col_min_x0_map[c_idx] = min(x0_vals)
        col_max_x1_map[c_idx] = max(x1_vals)
        col_base_left_map[c_idx] = _dominant_margin(x0_vals, margin_tol, pick_high=False)
        col_base_right_map[c_idx] = _dominant_margin(x1_vals, margin_tol, pick_high=True)

    # Estimate typical intra-paragraph vertical line gap on this page.
    small_gaps = []
    for prev, cur in zip(ordered, ordered[1:]):
        gap = float(cur.get("y0", 0)) - float(prev.get("y1", 0))
        if -0.3 * med_lh <= gap <= 0.85 * med_lh:
            small_gaps.append(gap)
    typical_gap = median(small_gaps) if small_gaps else med_lh * 0.25
    max_para_gap = max(med_lh * 0.65, typical_gap + med_lh * 0.32)

    groups: list[tuple[str, int, list[dict[str, Any]]]] = []
    cur_lines: list[dict[str, Any]] = []
    cur_role = "paragraph"
    cur_col = -2

    def _flush() -> None:
        if not cur_lines:
            return
        groups.append((cur_role, cur_col, list(cur_lines)))
        cur_lines.clear()

    for line in ordered:
        col_idx, col_left, col_right = _column_bounds(line)
        col_w = max(1.0, col_right - col_left)
        col_base_left = col_base_left_map.get(col_idx, col_left)
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

        prev_txt = str(prev.get("text") or "").strip()
        cur_txt = str(line.get("text") or "").strip()

        prev_bold = bool(prev.get("_detectedBold") or prev.get("_explicitBold") or prev.get("bold"))
        cur_bold = bool(line.get("_detectedBold") or line.get("_explicitBold") or line.get("bold"))
        prev_italic = bool(prev.get("_detectedItalic") or prev.get("italic"))
        cur_italic = bool(line.get("_detectedItalic") or line.get("italic"))
        style_changed = bool(prev_txt and cur_txt and (prev_bold != cur_bold or prev_italic != cur_italic))

        # Detect first-line paragraph indentation or outward outdent step.
        indent_delta = float(line.get("x0", 0)) - float(prev.get("x0", 0))
        first_line_indent = (
            cur_role == "paragraph"
            and indent_delta >= avg_lh * 1.15
            and (float(line.get("x0", 0)) - col_base_left) >= avg_lh * 1.10
            and abs(float(prev.get("x0", 0)) - col_base_left) <= avg_lh * 1.15
        )
        outdent_break = (
            cur_role == "paragraph"
            and -indent_delta >= avg_lh * 1.10
            and float(line.get("x0", 0)) < col_base_left - avg_lh * 0.80
        )

        right_slack = col_right - float(prev.get("x1", 0))
        prev_ended_early = bool(
            prev_txt
            and cur_role in {"paragraph", "list"}
            and right_slack >= max(avg_lh * 2.6, col_w * 0.22)
            and _SENTENCE_END_RE.search(prev_txt) is not None
        )
        prev_hard_break = bool(
            prev_txt
            and cur_role in {"paragraph", "list"}
            and right_slack >= max(avg_lh * 3.2, col_w * 0.28)
            and _width(prev) < max(_width(line) * 0.80, col_w * 0.56)
        )
        structured_label = bool(cur_txt and _STRUCTURED_LABEL_LINE_RE.match(cur_txt))

        x_overlap = min(float(prev.get("x1", 0)), float(line.get("x1", 0))) - max(float(prev.get("x0", 0)), float(line.get("x0", 0)))
        aligned_left = abs(float(line.get("x0", 0)) - float(cur_lines[0].get("x0", 0))) <= avg_lh * 2.2 or abs(float(line.get("x0", 0)) - col_base_left) <= avg_lh * 2.2

        can_merge = (
            same_col
            and not new_list_item
            and not either_heading
            and not already_segmented
            and not style_changed
            and not structured_label
            and lh_ratio <= 1.35
            and -0.35 * min(prev_lh, cur_lh) <= v_gap <= max_para_gap
            and (x_overlap >= 0.15 * min(_width(prev), _width(line)) or aligned_left)
            and not first_line_indent
            and not outdent_break
            and not prev_ended_early
            and not prev_hard_break
        )

        if can_merge:
            cur_lines.append(line)
        else:
            _flush()
            cur_lines.append(line)
            cur_role = role
            cur_col = col_idx

    _flush()

    def _compute_indent_fields(
        target: dict[str, Any],
        col_idx: int,
        members: list[dict[str, Any]],
        role: str,
    ) -> None:
        lh_ref = max(10.0, float(target.get("lineH") or med_lh))
        space_px = max(4.0, lh_ref * 0.45)
        txt_sample = str(target.get("text") or "")
        is_rtl = bool(_RTL_TEXT_RE.search(txt_sample)) and not bool(re.search(r"[A-Za-z]{3,}", txt_sample))

        if col_idx == -1:
            target["sourceIndent"] = 0
            return

        col_min_x0 = col_min_x0_map.get(col_idx, float(target.get("x0", 0)))
        col_max_x1 = col_max_x1_map.get(col_idx, float(target.get("x1", 0)))
        col_base_left = col_base_left_map.get(col_idx, col_min_x0)
        col_base_right = col_base_right_map.get(col_idx, col_max_x1)

        if is_rtl:
            outer_edge = float(target.get("x1", 0))
            rel_from_extreme = max(0.0, col_max_x1 - outer_edge)
            rel_from_base = col_base_right - outer_edge
        else:
            outer_edge = float(target.get("x0", 0))
            rel_from_extreme = max(0.0, outer_edge - col_min_x0)
            rel_from_base = outer_edge - col_base_left

        if role == "heading" and abs(rel_from_base) < lh_ref * 1.2:
            target["sourceIndent"] = 0
        else:
            target["sourceIndent"] = min(32, max(0, round(rel_from_extreme / space_px))) if rel_from_extreme >= lh_ref * 0.75 else 0

        if rel_from_base >= lh_ref * 0.85:
            target["blockIndent"] = round(min(6.0, rel_from_base / lh_ref), 2)
        elif -rel_from_base >= lh_ref * 0.85:
            target["blockOutdent"] = round(min(6.0, (-rel_from_base) / lh_ref), 2)

        non_empty_members = [m for m in members if str(m.get("text") or "").strip()]
        if len(non_empty_members) >= 2:
            m0 = non_empty_members[0]
            rest = non_empty_members[1:]
            if is_rtl:
                delta = float(median(float(m.get("x1", 0)) for m in rest)) - float(m0.get("x1", 0))
            else:
                delta = float(m0.get("x0", 0)) - float(median(float(m.get("x0", 0)) for m in rest))
            if delta >= lh_ref * 0.80:
                target["firstLineIndent"] = round(min(4.0, delta / lh_ref), 2)
            elif -delta >= lh_ref * 0.80:
                target["hangingIndent"] = round(min(4.0, (-delta) / lh_ref), 2)

    grouped: list[dict[str, Any]] = []
    for block_id, (role, col_idx, members) in enumerate(groups, start=1):
        if len(members) == 1:
            single = copy.deepcopy(members[0])
            single["id"] = block_id
            _compute_indent_fields(single, col_idx, members, role)
            grouped.append(_apply_document_block_defaults(single, role))
            continue
        first = copy.deepcopy(members[0])
        x0 = min(float(m["x0"]) for m in members)
        y0 = min(float(m["y0"]) for m in members)
        x1 = max(float(m["x1"]) for m in members)
        y1 = max(float(m["y1"]) for m in members)
        non_empty = [m for m in members if str(m.get("text") or "").strip()]
        paired = [(str(m.get("text") or "").strip(), float(m.get("conf", 0))) for m in non_empty]
        texts = [t for t, _ in paired]
        if paired:
            weights = [max(1, len(t)) for t, _ in paired]
            weighted_conf = round(sum(c * w for (_, c), w in zip(paired, weights)) / sum(weights), 2)
        else:
            weighted_conf = round(sum(float(m.get("conf", 0)) for m in members) / max(1, len(members)), 2)
        bold_votes = sum(1 for m in non_empty if m.get("_detectedBold") or m.get("_explicitBold") or m.get("bold"))
        italic_votes = sum(1 for m in non_empty if m.get("_detectedItalic") or m.get("italic"))
        if non_empty and bold_votes * 2 >= len(non_empty):
            first["_detectedBold"] = True
            first["_explicitBold"] = True
        else:
            first.pop("_detectedBold", None)
            first.pop("_explicitBold", None)
        if non_empty and italic_votes * 2 >= len(non_empty):
            first["_detectedItalic"] = True
            first["italic"] = True
        else:
            first.pop("_detectedItalic", None)
            first["italic"] = False
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
            "sourceLines": copy.deepcopy(members),
        })
        for key in ("tx0", "ty0", "tx1", "ty1", "firstLineIndent", "hangingIndent", "blockIndent", "blockOutdent"):
            first.pop(key, None)
        _compute_indent_fields(first, col_idx, members, role)
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
        non_empty = [b for b in items if str(b.get("text") or "").strip()]
        paired = [(str(b.get("text") or "").strip(), float(b.get("conf", 0))) for b in non_empty]
        texts = [t for t, _ in paired]
        if paired:
            weights = [max(1, len(text)) for text, _ in paired]
            weighted_conf = round(sum(c * w for (_, c), w in zip(paired, weights)) / sum(weights), 2)
        else:
            weighted_conf = first.get("conf", 0)
        bold_votes = sum(1 for b in non_empty if b.get("_detectedBold") or b.get("_explicitBold") or b.get("bold"))
        italic_votes = sum(1 for b in non_empty if b.get("_detectedItalic") or b.get("italic"))
        first.update({
            "id": block_id,
            "text": " ".join(texts),
            "tr": "",
            "richHtml": "",
            "conf": weighted_conf,
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "lineH": round(median(_height(b) for b in items), 2),
            "bold": bool(non_empty and bold_votes * 2 >= len(non_empty)),
            "italic": bool(non_empty and italic_votes * 2 >= len(non_empty)),
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
    effective = "document" if page_mode == "document" else detect_page_mode(blocks, page_size=page_size)
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
    effective = "document" if page_mode == "document" else detect_page_mode(blocks, page_size=page_size)
    if effective == "document":
        if group_lines:
            return group_document_lines(blocks, page_size=page_size), "document"
        ordered = sort_document_reading_order(blocks, page_size=page_size)
        med_lh = median(_line_h(b) for b in ordered) if ordered else 16.0
        col_w = max((_width(b) for b in ordered), default=200.0)
        x0_vals = [float(b.get("x0", 0)) for b in ordered if str(b.get("text") or "").strip()]
        min_x0 = min(x0_vals) if x0_vals else 0.0
        base_left = _dominant_margin(x0_vals, max(10.0, med_lh * 0.75), pick_high=False) if x0_vals else 0.0
        space_px = max(4.0, med_lh * 0.45)
        for idx, blk in enumerate(ordered, start=1):
            blk["id"] = idx
            role = _classify_document_line_role(blk, med_lh, col_w)
            bx0 = float(blk.get("x0", 0))
            rel_ext = max(0.0, bx0 - min_x0)
            rel_base = bx0 - base_left
            blk["sourceIndent"] = min(32, max(0, round(rel_ext / space_px))) if rel_ext >= med_lh * 0.75 else 0
            if rel_base >= med_lh * 0.85:
                blk["blockIndent"] = round(min(6.0, rel_base / med_lh), 2)
            elif -rel_base >= med_lh * 0.85:
                blk["blockOutdent"] = round(min(6.0, (-rel_base) / med_lh), 2)
            _apply_document_block_defaults(blk, role)
        return ordered, "document"

    if group_lines:
        return _group_comic_lines(blocks), "comic"
    copied = [copy.deepcopy(b) for b in blocks]
    if copied:
        med_lh = median(_line_h(b) for b in copied)
        x0_vals = [float(b.get("x0", 0)) for b in copied if str(b.get("text") or "").strip()]
        min_x0 = min(x0_vals) if x0_vals else 0.0
        space_px = max(4.0, med_lh * 0.45)
    else:
        med_lh, min_x0, space_px = 16.0, 0.0, 7.2
    for idx, blk in enumerate(copied, start=1):
        blk["id"] = idx
        rel_ext = max(0.0, float(blk.get("x0", 0)) - min_x0)
        blk["sourceIndent"] = min(32, max(0, round(rel_ext / space_px))) if rel_ext >= med_lh * 0.75 else 0
    return copied, "comic"
