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
    # Latin "1.2.3" and Persian/Arabic-Indic "۲-۴" or "۱٫۲" numbering.
    r"^\s*(?:\d+(?:\.\d+){1,8}\b[\s.:)\-–—]*\S"
    r"|[\u06f0-\u06f9\u0660-\u0669]{1,3}(?:[.\-–—٫][\u06f0-\u06f9\u0660-\u0669]{1,3})+[\s.:)\-–—]*\S)"
)
_SINGLE_NUM_TITLE_RE = re.compile(
    r"^\s*(?:\d{1,3}|[IVXLCDM]{1,6})[.)\-:]\s+\S"
    # Persian section numbers such as «۲- روش…» / «۴. نتیجه‌گیری»
    r"|^\s*[\u06f0-\u06f9\u0660-\u0669]{1,3}[.)\-–—:\s]\s*\S"
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
# References to a chapter/figure in running prose are not section titles.
_PREFIX_PROSE_RE = re.compile(
    r"^\s*(?:chapter|section|part|appendix|annex|table|figure|fig\.)\s+"
    r"(?:[0-9IVXLCDM]+(?:[.\-][0-9]+)*|[A-Z])\s+"
    r"(?:explains?|describes?|introduces?|discusses?|presents?|shows?|illustrates?|"
    r"provides?|contains?|covers?|summarizes?|examines?|demonstrates?|is|are|was|were)\b",
    re.IGNORECASE,
)
_STRUCTURED_LABEL_LINE_RE = re.compile(
    r"^\s*(?:class\s*[0-9,/\s]+|note\s*\d*|warning|caution|target|acceptable|defect|process\s+indicator|minimum|maximum|"
    r"کلاس\s*[۰-۹0-9]+|تبصره|نکته|هشدار|حداقل|حداکثر)\b[^.!?]{0,32}[:\-–—]\s*\S",
    re.IGNORECASE,
)
_SENTENCE_END_RE = re.compile(r'[.!?؟…。！？:؛»")\]]\s*$')
# A genuine end of a sentence: terminal mark (optionally followed by closing
# quotes/brackets) at the end of a run of words - not '.5' style numbers and not
# a lone dot glued to a misread word in the middle of a line.
_TERMINAL_SENTENCE_RE = re.compile(r"""\S\.(?:["'”’)\]]*)\s*$|\S[!?؟…。！？](?:["'”’)\]]*)\s*$""")
_PROSE_STOP_PUNCT_RE = re.compile(r'[.!?؟…。！？؛,،]\s*$')
_RTL_TEXT_RE = re.compile(r"[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]")


def _is_mostly_rtl_blocks(blocks: list[dict[str, Any]]) -> bool:
    rtl_count = 0
    ltr_count = 0
    for blk in blocks:
        txt = str(blk.get("text") or "")
        for ch in txt:
            code = ord(ch)
            if (0x0590 <= code <= 0x08FF) or (0xFB1D <= code <= 0xFDFF) or (0xFE70 <= code <= 0xFEFC):
                rtl_count += 1
            elif ("A" <= ch <= "Z") or ("a" <= ch <= "z"):
                ltr_count += 1
    return rtl_count >= 6 and rtl_count >= ltr_count * 0.8


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


def _prose_character_stats(blocks: list[dict[str, Any]]) -> tuple[int, int, int, int, int]:
    total_chars = 0
    alpha_chars = 0
    lower_chars = 0
    cjk_chars = 0
    rtl_chars = 0
    for blk in blocks:
        txt = str(blk.get("text") or "").strip()
        total_chars += len(txt)
        for ch in txt:
            code = ord(ch)
            if (0x4E00 <= code <= 0x9FFF) or (0x3040 <= code <= 0x30FF) or (0xAC00 <= code <= 0xD7AF):
                cjk_chars += 1
            elif (0x0590 <= code <= 0x08FF) or (0xFB1D <= code <= 0xFDFF) or (0xFE70 <= code <= 0xFEFC):
                rtl_chars += 1
            elif ch.isalpha():
                alpha_chars += 1
                if ch.islower():
                    lower_chars += 1
    return total_chars, alpha_chars, lower_chars, cjk_chars, rtl_chars


def detect_page_mode(
    blocks: list[dict[str, Any]],
    page_size: tuple[int, int] | None = None,
) -> str:
    """Classify OCR blocks into 'document' (book/article/handout) or 'comic' (speech bubbles)."""
    valid = [b for b in blocks if str(b.get("text") or "").strip()]
    if not valid:
        return "comic"

    total_chars, alpha_chars, lower_chars, cjk_chars, rtl_chars = _prose_character_stats(valid)
    lower_ratio = (lower_chars / alpha_chars) if alpha_chars else 0.0
    has_natural_case = lower_ratio >= 0.42 or cjk_chars >= 60 or rtl_chars >= 60

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

    # Check margin alignment consistency (left-aligned LTR or right-aligned RTL book/article pages).
    x0s = sorted(float(b.get("x0", 0)) for b in valid)
    x1s = sorted(float(b.get("x1", 0)) for b in valid)
    tol = max(14.0, med_lh * 1.8)
    best_cluster = 0
    for anchor in x0s:
        best_cluster = max(best_cluster, sum(1 for x in x0s if abs(x - anchor) <= tol))
    for anchor in x1s:
        best_cluster = max(best_cluster, sum(1 for x in x1s if abs(x - anchor) <= tol))

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
    effective_rtl = rtl_columns or _is_mostly_rtl_blocks(working)
    med_lh = median(_line_h(b) for b in working)
    columns = _detect_column_ranges(working, med_lh)
    if len(columns) < 2:
        working.sort(
            key=lambda b: (
                round(((float(b.get("y0", 0)) + float(b.get("y1", 0))) * 0.5) / max(8.0, med_lh * 0.55)),
                -float(b.get("x1", 0)) if effective_rtl else float(b.get("x0", 0)),
                float(b.get("y0", 0)),
            )
        )
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
    by_y = sorted(
        working,
        key=lambda b: (float(b.get("y0", 0)), -float(b.get("x1", 0)) if effective_rtl else float(b.get("x0", 0))),
    )
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
        col_indices = list(reversed(range(len(buckets)))) if effective_rtl else list(range(len(buckets)))
        for idx in col_indices:
            col_items = buckets[idx]
            col_items.sort(
                key=lambda b: (
                    round(((float(b.get("y0", 0)) + float(b.get("y1", 0))) * 0.5) / max(8.0, med_lh * 0.55)),
                    -float(b.get("x1", 0)) if effective_rtl else float(b.get("x0", 0)),
                )
            )
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


def _latin_alpha_ratio(txt: str) -> float:
    """Share of alphabetic characters that are Latin (used to tell prose from titles)."""
    alpha = [ch for ch in txt if ch.isalpha()]
    if not alpha:
        return 1.0
    latin = sum(1 for ch in alpha if "A" <= ch.upper() <= "Z")
    return latin / len(alpha)


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


def _body_line_height(blocks: list[dict[str, Any]], med_lh: float) -> float:
    """Dominant line height of *text* lines, ignoring caption/badge-size fragments.

    A screenshot can carry tiny interface labels (``EN``, ``3``, ``中``) whose
    height is a third of a real line.  A plain median then reports a body line as
    "much taller than average", which used to turn ordinary prose into headings.
    Weighting by real text length keeps the answer on the body text.
    """
    weighted: list[tuple[float, int]] = []
    for blk in blocks:
        txt = str(blk.get("text") or "").strip()
        if len(txt) < 3:
            continue
        weighted.append((_line_h(blk), len(txt)))
    if not weighted:
        return med_lh
    weighted.sort(key=lambda item: item[0])
    total_chars = sum(chars for _, chars in weighted)
    if not total_chars:
        return med_lh
    running = 0
    for height, chars in weighted:
        running += chars
        if running >= total_chars * 0.5:
            return max(8.0, height)
    return max(8.0, weighted[-1][0])


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
    # A line whose words are glued into one long run looks like a "short" title
    # to the word based tests below.  Its real length is in characters, so it
    # must be measured like a full sentence.
    glued_prose = bool(
        word_count <= 2
        and re.search(r"[A-Za-z]{25,}", txt)
        and len(txt) >= 40
        and not _is_all_caps_title(txt)
    )
    if glued_prose:
        word_count = max(word_count, 14)

    if lh >= med_lh * 1.24 and len(txt) <= 140 and not txt.endswith((".", "،", ",", ";", "؛")):
        return "heading"
    prefixed_title = bool(
        _MULTI_LEVEL_NUM_HEADING_RE.match(txt) or (_HEADING_PREFIX_RE.match(txt) and not _PREFIX_PROSE_RE.match(txt))
    )
    if prefixed_title and len(txt) <= 130 and word_count <= 22 and not txt.endswith("."):
        # OCR may misread the verb that marks a prefixed line as running prose
        # ("Chapter 1 exp1ains ..."), so the prose filter above cannot always see
        # it.  A long, wordy line is body text, not a one-line section title.
        if (
            _latin_alpha_ratio(txt) >= 0.55
            and not _TERMINAL_SENTENCE_RE.search(txt)
            and not _PROSE_STOP_PUNCT_RE.search(txt)
            and not is_bold
            and (word_count >= 12 or len(txt) >= 95)
        ):
            return "paragraph"
        return "heading"
    if _SINGLE_NUM_TITLE_RE.match(txt):
        # "2. Setup" and "1. Introduction to Modern Physics" are section titles; a
        # numbered run of ordinary words ("1. First numbered list entry") is a list
        # item, and a numbered sentence that fills the line is prose.
        linkers = {"a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "with", "from", "at", "by"}
        inner_words = [w for w in txt.split()[1:] if w.isalpha()]
        title_case = bool(inner_words) and all(
            w[:1].isupper() or w.lower() in linkers for w in inner_words
        )
        article_start = bool(inner_words) and inner_words[0].lower() in {
            "a", "an", "the", "this", "these", "those", "it", "we", "you", "they",
        }
        if word_count <= 4 or title_case or article_start:
            return "heading"
        if (
            word_count <= 14
            and len(txt) <= 100
            and not txt.endswith(".")
            and (is_bold or lh >= med_lh * 1.15 or _is_all_caps_title(txt))
        ):
            return "heading"
        if (
            _LIST_ITEM_RE.match(txt)
            and _latin_alpha_ratio(txt) >= 0.55
            and not _TERMINAL_SENTENCE_RE.search(txt)
            and not _PROSE_STOP_PUNCT_RE.search(txt)
            and not is_bold
            and (word_count >= 10 or len(txt) >= 75)
        ):
            return "paragraph"
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


_BARE_SECTION_NUMBER_RE = re.compile(
    r"^\s*(?:\d{1,3}(?:\.\d{1,3}){0,5}|[IVXLCDM]{1,6})[.):\-–—]?\s*$"
)
# The same number glued to the start of its title ("1.2WHAT YOU WILL FIND…").
# The detector sometimes returns both boxes as one line, and then the title must
# still read "1.2 WHAT YOU WILL FIND…" instead of losing its space.
_LEADING_SECTION_NUMBER_RE = re.compile(
    r"^\s*(?P<num>\d{1,3}(?:\.\d{1,3}){1,5}|[IVXLCDM]{1,6}[.)])"
    r"(?P<rest>[A-Za-z\u0600-\u06ff]\S*.*)$"
)


def _split_leading_section_number(text: str) -> str:
    """Insert the missing space between a section number and its title."""
    changed = text
    while True:
        match = _LEADING_SECTION_NUMBER_RE.match(changed)
        if not match:
            return changed
        rest = match.group("rest")
        # Only a single short token is a number plated to a word; a long run is
        # prose that happens to start with digits (a year, a quantity).
        if rest.split()[0][:1].isdigit():
            return changed
        fixed = f"{match.group('num')} {rest}"
        if fixed == changed:
            return changed
        changed = fixed


def _join_section_number_rows(blocks: list[dict[str, Any]], med_lh: float) -> list[dict[str, Any]]:
    """Put a standalone section number back in front of its title.

    Book pages often print "1.2" and "WHAT YOU WILL FIND ..." as two boxes on
    the same baseline.  Left apart, the number became its own little block and
    the title lost its numbering.  Only a bare number sitting on the same row
    as a title-like neighbour is joined; nothing else changes.
    """
    if len(blocks) < 2:
        return blocks
    items = [copy.deepcopy(b) for b in blocks]
    used: set[int] = set()
    result: list[dict[str, Any]] = []
    # Section numbers first: a title may sit a pixel or two higher than its
    # number, so plain top-to-bottom order would consume the title first.
    order = sorted(
        range(len(items)),
        key=lambda i: (
            0 if _BARE_SECTION_NUMBER_RE.match(str(items[i].get("text") or "").strip()) else 1,
            float(items[i].get("y0", 0)),
        ),
    )
    for idx in order:
        if idx in used:
            continue
        first = items[idx]
        first_txt = str(first.get("text") or "").strip()
        if not _BARE_SECTION_NUMBER_RE.match(first_txt) or len(first_txt) > 8:
            result.append(first)
            used.add(idx)
            continue
        # Find a neighbour on the same row whose text continues the title.
        best = None
        best_gap = None
        for other_idx, other in enumerate(items):
            if other_idx == idx or other_idx in used:
                continue
            other_txt = str(other.get("text") or "").strip()
            if len(other_txt) < 4 or _BARE_SECTION_NUMBER_RE.match(other_txt):
                continue
            h1, h2 = _height(first), _height(other)
            if max(h1, h2) > min(h1, h2) * 1.9:
                continue
            cy1 = (float(first.get("y0", 0)) + float(first.get("y1", 0))) * 0.5
            cy2 = (float(other.get("y0", 0)) + float(other.get("y1", 0))) * 0.5
            if abs(cy1 - cy2) > max(h1, h2) * 0.55:
                continue
            # Reading order: the title follows the number (LTR) or precedes it (RTL).
            rtl_title = bool(_RTL_TEXT_RE.search(other_txt)) and not bool(re.search(r"[A-Za-z]{3,}", other_txt))
            if rtl_title:
                gap = float(first.get("x1", 0)) - float(other.get("x0", 0))
            else:
                gap = float(other.get("x0", 0)) - float(first.get("x1", 0))
            if gap < -max(h1, h2) * 0.6:
                continue
            if gap > max(med_lh * 3.2, 90.0):
                continue
            if best_gap is None or abs(gap) < abs(best_gap):
                best, best_gap = other_idx, gap
        if best is None:
            result.append(first)
            used.add(idx)
            continue
        other = items[best]
        other_txt = str(other.get("text") or "").strip()
        rtl_title = bool(_RTL_TEXT_RE.search(other_txt)) and not bool(re.search(r"[A-Za-z]{3,}", other_txt))
        merged_text = f"{other_txt} {first_txt}".strip() if rtl_title else f"{first_txt} {other_txt}".strip()
        merged = copy.deepcopy(other)
        x0 = min(float(first.get("x0", 0)), float(other.get("x0", 0)))
        y0 = min(float(first.get("y0", 0)), float(other.get("y0", 0)))
        x1 = max(float(first.get("x1", 0)), float(other.get("x1", 0)))
        y1 = max(float(first.get("y1", 0)), float(other.get("y1", 0)))
        merged.update({
            "text": merged_text,
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            "lineH": round(median([_height(first), _height(other)]), 2),
            "sourceLines": copy.deepcopy([
                *(other.get("sourceLines") or [other]),
                *(first.get("sourceLines") or [first]),
            ] if rtl_title else [
                *(first.get("sourceLines") or [first]),
                *(other.get("sourceLines") or [other]),
            ]),
        })
        used.add(idx)
        used.add(best)
        result.append(merged)
    return result


def _split_glued_section_numbers(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give "1.2WHAT YOU WILL FIND…" its missing space after the number."""
    fixed_blocks: list[dict[str, Any]] = []
    for original in blocks:
        text = str(original.get("text") or "")
        fixed = _split_leading_section_number(text) if text else text
        if fixed == text:
            fixed_blocks.append(original)
            continue
        block = copy.deepcopy(original)
        block["text"] = fixed
        source_lines = block.get("sourceLines")
        if isinstance(source_lines, list):
            block["sourceLines"] = [
                {**line, "text": _split_leading_section_number(str(line.get("text") or ""))}
                if isinstance(line, dict) and line.get("text") else line
                for line in source_lines
            ]
        fixed_blocks.append(block)
    return fixed_blocks


def _repair_dropped_spaces(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Restore word spaces an engine dropped, without touching anything else.

    Only blocks whose Latin text has lost most of its spaces are rewritten; the
    coordinates, ids and every other field stay byte-identical.
    """
    repaired: list[dict[str, Any]] = []
    for original in blocks:
        block = original
        text = str(block.get("text") or "")
        fixed = restore_missing_word_spaces(text) if text else text
        if fixed != text:
            block = copy.deepcopy(block)
            block["text"] = fixed
            source_lines = block.get("sourceLines")
            if isinstance(source_lines, list):
                fixed_lines = []
                for line in source_lines:
                    if isinstance(line, dict) and line.get("text"):
                        copy_line = dict(line)
                        copy_line["text"] = restore_missing_word_spaces(str(line["text"]))
                        fixed_lines.append(copy_line)
                    else:
                        fixed_lines.append(line)
                block["sourceLines"] = fixed_lines
        repaired.append(block)
    return repaired


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


_RTL_DUAL_JOIN_CONSONANTS = frozenset("بپتثجچحخسشصضطظعغفقکگلمن")
_RTL_SHORT_STANDALONE_WORDS = frozenset({
    "و", "به", "از", "در", "با", "بر", "تا", "را", "که", "چه", "نه", "هم", "هر",
    "من", "ما", "تو", "او", "آن", "این", "یک", "دو", "سه", "یا", "ای", "بی", "می",
    "کم", "گم", "دل", "دم", "سر", "پا", "لب", "شب", "زن", "کل", "پر", "پس", "چپ", "حق", "خط", "سد", "شد", "صف", "طی", "فن", "قد", "مد", "نم",
})
_RTL_ZWNJ_SUFFIXES = frozenset({
    "ها", "های", "هایی", "هایم", "هایت", "هایش", "هایمان", "هایتان", "هایشان",
    "تر", "ترین", "ام", "ات", "اش", "مان", "تان", "شان",
})


def _rtl_horizontal_join_sep(right_txt: str, left_txt: str, h_gap: float, avg_h: float) -> str:
    r_clean = right_txt.strip()
    l_clean = left_txt.strip()
    if not r_clean or not l_clean:
        return " "
    if re.search(r"(?<![\u0621-\u06cc])ن?می$", r_clean) and re.match(r"^[\u0621-\u06cc]{2,}", l_clean):
        return "\u200c"
    if l_clean in _RTL_ZWNJ_SUFFIXES and re.search(r"[\u0621-\u06cc]$", r_clean):
        return "\u200c"
    safe_h = max(8.0, float(avg_h))
    r_last = r_clean.split()[-1]
    l_first = l_clean.split()[0]
    if (
        h_gap <= 0.08 * safe_h
        and r_last not in _RTL_SHORT_STANDALONE_WORDS
        and re.search(r"[\u0621-\u06cc]$", r_last)
        and re.match(r"^[\u0621-\u06cc]", l_first)
    ):
        return ""
    if (
        h_gap <= 0.16 * safe_h
        and r_last not in _RTL_SHORT_STANDALONE_WORDS
        and r_last[-1] in _RTL_DUAL_JOIN_CONSONANTS
        and re.match(r"^[\u0621-\u06cc]", l_first)
    ):
        return ""
    return " "


def _coalesce_rtl_same_row_blocks(
    blocks: list[dict[str, Any]],
    *,
    max_gap_ratio: float = 0.82,
    columns: list[tuple[float, float]] | None = None,
) -> list[dict[str, Any]]:
    """Coalesce shattered RTL word/sub-word fragments sitting on the same horizontal baseline
    right-to-left (`-x1`), while keeping side-by-side comic bubbles and separate columns distinct."""
    if len(blocks) < 2 or not _is_mostly_rtl_blocks(blocks):
        return [copy.deepcopy(b) for b in blocks]

    def _col_of(blk: dict[str, Any]) -> int:
        if not columns or len(columns) < 2:
            return 0
        bx0, bx1 = float(blk.get("x0", 0)), float(blk.get("x1", 0))
        total_span = max(1.0, columns[-1][1] - columns[0][0])
        if (bx1 - bx0) > total_span * 0.68:
            return -1
        cx = 0.5 * (bx0 + bx1)
        return min(
            range(len(columns)),
            key=lambda k: 0.0 if columns[k][0] <= cx <= columns[k][1] else min(abs(cx - columns[k][0]), abs(cx - columns[k][1])),
        )

    copied = [copy.deepcopy(b) for b in blocks]
    copied.sort(key=lambda b: (0.5 * (float(b.get("y0", 0)) + float(b.get("y1", 0))), -float(b.get("x1", 0))))
    rows: list[list[dict[str, Any]]] = []
    for blk in copied:
        by0, by1 = float(blk.get("y0", 0)), float(blk.get("y1", 0))
        bh = max(4.0, _height(blk))
        bcy = 0.5 * (by0 + by1)
        placed = False
        if not _is_multi_line_box(blk):
            for row in rows:
                if any(_is_multi_line_box(r) for r in row):
                    continue
                ry0 = min(float(r.get("y0", 0)) for r in row)
                ry1 = max(float(r.get("y1", 0)) for r in row)
                rh = median(_height(r) for r in row)
                rcy = sum(0.5 * (float(r.get("y0", 0)) + float(r.get("y1", 0))) for r in row) / len(row)
                v_ov = min(by1, ry1) - max(by0, ry0)
                if abs(bcy - rcy) <= 0.36 * max(bh, rh) and v_ov >= 0.45 * min(bh, rh) and 0.55 <= (bh / rh) <= 1.82:
                    row.append(blk)
                    placed = True
                    break
        if not placed:
            rows.append([blk])

    result: list[dict[str, Any]] = []
    for row in rows:
        if len(row) == 1:
            result.append(row[0])
            continue
        row.sort(key=lambda r: -float(r.get("x1", 0)))
        cur = row[0]
        cur_members = list(cur.get("sourceLines") or [copy.deepcopy(cur)])
        for nxt in row[1:]:
            cx0, cy0, cx1, cy1 = float(cur.get("x0", 0)), float(cur.get("y0", 0)), float(cur.get("x1", 0)), float(cur.get("y1", 0))
            nx0, ny0, nx1, ny1 = float(nxt.get("x0", 0)), float(nxt.get("y0", 0)), float(nxt.get("x1", 0)), float(nxt.get("y1", 0))
            avg_h = 0.5 * (_height(cur) + _height(nxt))
            h_gap = cx0 - nx1
            c_txt = str(cur.get("text") or "").strip()
            n_txt = str(nxt.get("text") or "").strip()
            has_rtl = bool(_RTL_TEXT_RE.search(c_txt) or _RTL_TEXT_RE.search(n_txt))
            same_col = _col_of(cur) == _col_of(nxt)
            if has_rtl and same_col and -0.35 * avg_h <= h_gap <= max_gap_ratio * avg_h:
                sep = _rtl_horizontal_join_sep(c_txt, n_txt, h_gap, avg_h)
                joined_txt = f"{c_txt}{sep}{n_txt}".strip()
                nxt_members = list(nxt.get("sourceLines") or [copy.deepcopy(nxt)])
                cur_members.extend(nxt_members)
                c_w = max(1, len(c_txt))
                n_w = max(1, len(n_txt))
                w_conf = round((float(cur.get("conf", 0)) * c_w + float(nxt.get("conf", 0)) * n_w) / (c_w + n_w), 2)
                mx0, my0 = min(cx0, nx0), min(cy0, ny0)
                mx1, my1 = max(cx1, nx1), max(cy1, ny1)
                cur.update({
                    "text": joined_txt,
                    "conf": w_conf,
                    "x0": mx0, "y0": my0, "x1": mx1, "y1": my1,
                    "polygon": [[mx0, my0], [mx1, my0], [mx1, my1], [mx0, my1]],
                    "lineH": round(median(_height(m) for m in cur_members), 2),
                    "sourceLines": copy.deepcopy(cur_members),
                })
                for k in ("tx0", "ty0", "tx1", "ty1"):
                    cur.pop(k, None)
            else:
                result.append(cur)
                cur = nxt
                cur_members = list(cur.get("sourceLines") or [copy.deepcopy(cur)])
        result.append(cur)
    return result


def group_document_lines(
    blocks: list[dict[str, Any]],
    page_size: tuple[int, int] | None = None,
    *,
    rtl_columns: bool = False,
) -> list[dict[str, Any]]:
    """Group OCR lines into structured book/article headings, lists, and paragraphs."""
    if not blocks:
        return []
    blocks = _split_glued_section_numbers(_repair_dropped_spaces(blocks))
    blocks = _join_section_number_rows(blocks, median(_line_h(b) for b in blocks))
    effective_rtl = rtl_columns or _is_mostly_rtl_blocks(blocks)
    if effective_rtl and len(blocks) >= 2:
        prelim_lh = median(_line_h(b) for b in blocks)
        prelim_cols = _detect_column_ranges(blocks, prelim_lh)
        blocks = _coalesce_rtl_same_row_blocks(blocks, max_gap_ratio=1.25, columns=prelim_cols)
    ordered = sort_document_reading_order(blocks, page_size=page_size, rtl_columns=effective_rtl)
    if len(ordered) == 1:
        single = copy.deepcopy(ordered[0])
        med_lh = _line_h(single)
        role = _classify_document_line_role(single, med_lh, _width(single))
        single["id"] = 1
        single["sourceIndent"] = 0
        return [_apply_document_block_defaults(single, role)]

    med_lh = median(_line_h(b) for b in ordered)
    body_lh = _body_line_height(ordered, med_lh)
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

    # OCR boxes often hug the ink, not the full typographic line height. In
    # double-spaced books the normal gap can therefore exceed the old fixed
    # 0.85*lineH sampling limit, leaving every line of a long paragraph separate.
    # Learn a repeated prose cadence per column, never from isolated blocks,
    # heading/list rows, or across a column boundary.
    column_para_gaps: dict[int, float] = {}
    for c_idx, items in col_lines_map.items():
        if c_idx == -1:
            continue
        candidates = []
        for prev, nxt in zip(items, items[1:]):
            _, left, right = _column_bounds(prev)
            width = right - left
            lh = min(_line_h(prev), _line_h(nxt))
            gap = float(nxt.get("y0", 0)) - float(prev.get("y1", 0))
            leading_edge = "x1" if effective_rtl else "x0"
            if (
                not _is_multi_line_box(prev) and not _is_multi_line_box(nxt)
                and _classify_document_line_role(prev, med_lh, width) == "paragraph"
                and _classify_document_line_role(nxt, med_lh, width) == "paragraph"
                and min(_width(prev), _width(nxt)) >= width * 0.60
                and abs(float(prev.get(leading_edge, 0)) - float(nxt.get(leading_edge, 0))) <= lh * 0.60
                and max(_line_h(prev), _line_h(nxt)) <= lh * 1.35
                and 0 <= gap <= med_lh * 1.8
            ):
                candidates.append(gap)
        if len(candidates) >= 3:
            center = median(candidates)
            repeated = [gap for gap in candidates if abs(gap - center) <= med_lh * 0.25]
            if len(repeated) >= 3 and len(repeated) >= len(candidates) * 0.60:
                column_para_gaps[c_idx] = max(max_para_gap, median(repeated) + med_lh * 0.32)

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
        role = _classify_document_line_role(line, body_lh, col_w)

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

        col_base_right = col_base_right_map.get(col_idx, col_right)
        combined_sample = f"{prev_txt} {cur_txt}"
        line_is_rtl = effective_rtl or (
            bool(_RTL_TEXT_RE.search(combined_sample))
            and not bool(re.search(r"[A-Za-z]{3,}", combined_sample))
        )

        # Detect first-line paragraph indentation or outward outdent step (right edge for RTL, left edge for LTR).
        if line_is_rtl:
            indent_delta = float(prev.get("x1", 0)) - float(line.get("x1", 0))
            first_line_indent = (
                cur_role == "paragraph"
                and indent_delta >= avg_lh * 1.15
                and (col_base_right - float(line.get("x1", 0))) >= avg_lh * 1.10
                and abs(col_base_right - float(prev.get("x1", 0))) <= avg_lh * 1.15
            )
            outdent_break = (
                cur_role == "paragraph"
                and -indent_delta >= avg_lh * 1.10
                and float(line.get("x1", 0)) > col_base_right + avg_lh * 0.80
            )
            trail_slack = max(0.0, float(prev.get("x0", 0)) - col_left)
            aligned_margin = (
                abs(float(line.get("x1", 0)) - float(cur_lines[0].get("x1", 0))) <= avg_lh * 2.2
                or abs(float(line.get("x1", 0)) - col_base_right) <= avg_lh * 2.2
            )
        else:
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
            trail_slack = col_right - float(prev.get("x1", 0))
            aligned_margin = (
                abs(float(line.get("x0", 0)) - float(cur_lines[0].get("x0", 0))) <= avg_lh * 2.2
                or abs(float(line.get("x0", 0)) - col_base_left) <= avg_lh * 2.2
            )

        # OCR boxes are not typeset lines, so a short line alone is not proof that
        # the paragraph ended - a box may stop early or hug its last word while the
        # text continues on the next line.  A real break therefore needs a wide
        # trailing gap AND terminal sentence punctuation; without the punctuation
        # the lines stay together (merging two paragraphs is much less harmful than
        # cutting one paragraph in half).
        prev_ends_sentence = _TERMINAL_SENTENCE_RE.search(prev_txt) is not None
        prev_ended_early = bool(
            prev_txt
            and cur_role in {"paragraph", "list"}
            and trail_slack >= max(avg_lh * 2.6, col_w * 0.22)
            and len(prev_txt) >= 45
            and prev_ends_sentence
        )
        prev_hard_break = bool(
            prev_txt
            and cur_role in {"paragraph", "list"}
            and trail_slack >= max(avg_lh * 3.2, col_w * 0.28)
            and _width(prev) < max(_width(line) * 0.80, col_w * 0.56)
            and prev_ends_sentence
        )
        structured_label = bool(cur_txt and _STRUCTURED_LABEL_LINE_RE.match(cur_txt))

        x_overlap = min(float(prev.get("x1", 0)), float(line.get("x1", 0))) - max(float(prev.get("x0", 0)), float(line.get("x0", 0)))

        can_merge = (
            same_col
            and not new_list_item
            and not either_heading
            and not already_segmented
            and not style_changed
            and not structured_label
            and lh_ratio <= 1.35
            and -0.35 * min(prev_lh, cur_lh) <= v_gap <= column_para_gaps.get(col_idx, max_para_gap)
            and (x_overlap >= 0.15 * min(_width(prev), _width(line)) or aligned_margin)
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
            "sourceLines": copy.deepcopy([sl for m in members for sl in (m.get("sourceLines") or [m])]),
        })
        for key in ("tx0", "ty0", "tx1", "ty1", "firstLineIndent", "hangingIndent", "blockIndent", "blockOutdent"):
            first.pop(key, None)
        _compute_indent_fields(first, col_idx, members, role)
        grouped.append(_apply_document_block_defaults(first, role))
    return grouped


def _group_comic_lines(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Original comic speech-bubble union-find grouping (with RTL same-row word/sub-word coalescing)."""
    if len(blocks) < 2:
        return [copy.deepcopy(block) for block in blocks]
    lines = _coalesce_rtl_same_row_blocks(blocks, max_gap_ratio=0.82) if _is_mostly_rtl_blocks(blocks) else [copy.deepcopy(block) for block in blocks]
    if len(lines) < 2:
        single = copy.deepcopy(lines[0])
        single["id"] = 1
        return [single]
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

    is_rtl_comic = _is_mostly_rtl_blocks(lines)
    grouped = []
    if is_rtl_comic:
        # Order side-by-side Persian/RTL bubbles right-to-left (-x1) within the same horizontal band.
        med_bh = median(max(float(b["y1"]) - float(b["y0"]) for b in items) for items in buckets.values())
        band_h = max(24.0, round(med_bh * 0.9))
        ordered_groups = sorted(
            buckets.values(),
            key=lambda items: (
                round(min(float(b["y0"]) for b in items) / band_h) * band_h,
                -max(float(b["x1"]) for b in items),
                min(float(b["y0"]) for b in items),
            ),
        )
    else:
        ordered_groups = sorted(buckets.values(), key=lambda items: (min(float(b["y0"]) for b in items), min(float(b["x0"]) for b in items)))
    for block_id, items in enumerate(ordered_groups, start=1):
        items.sort(
            key=lambda b: (
                round(((float(b["y0"]) + float(b["y1"])) / 2) / 10) * 10,
                -float(b["x1"]) if is_rtl_comic else float(b["x0"]),
            )
        )
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
            "sourceLines": copy.deepcopy([sl for b in items for sl in (b.get("sourceLines") or [b])]),
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
        page_is_rtl = _is_mostly_rtl_blocks(ordered)
        x0_vals = [float(b.get("x0", 0)) for b in ordered if str(b.get("text") or "").strip()]
        x1_vals = [float(b.get("x1", 0)) for b in ordered if str(b.get("text") or "").strip()]
        min_x0 = min(x0_vals) if x0_vals else 0.0
        max_x1 = max(x1_vals) if x1_vals else 0.0
        base_left = _dominant_margin(x0_vals, max(10.0, med_lh * 0.75), pick_high=False) if x0_vals else 0.0
        base_right = _dominant_margin(x1_vals, max(10.0, med_lh * 0.75), pick_high=True) if x1_vals else 0.0
        space_px = max(4.0, med_lh * 0.45)
        for idx, blk in enumerate(ordered, start=1):
            blk["id"] = idx
            role = _classify_document_line_role(blk, med_lh, col_w)
            if page_is_rtl:
                bx1 = float(blk.get("x1", 0))
                rel_ext = max(0.0, max_x1 - bx1)
                rel_base = base_right - bx1
            else:
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
    page_is_rtl = _is_mostly_rtl_blocks(copied)
    if copied:
        med_lh = median(_line_h(b) for b in copied)
        x0_vals = [float(b.get("x0", 0)) for b in copied if str(b.get("text") or "").strip()]
        x1_vals = [float(b.get("x1", 0)) for b in copied if str(b.get("text") or "").strip()]
        min_x0 = min(x0_vals) if x0_vals else 0.0
        max_x1 = max(x1_vals) if x1_vals else 0.0
        space_px = max(4.0, med_lh * 0.45)
        if page_is_rtl and len(copied) >= 2:
            band_h = max(14.0, round(med_lh * 0.65))
            copied.sort(
                key=lambda b: (
                    round(((float(b.get("y0", 0)) + float(b.get("y1", 0))) / 2.0) / band_h) * band_h,
                    -float(b.get("x1", 0)),
                    float(b.get("y0", 0)),
                )
            )
    else:
        med_lh, min_x0, max_x1, space_px = 16.0, 0.0, 0.0, 7.2
    for idx, blk in enumerate(copied, start=1):
        blk["id"] = idx
        rel_ext = (
            max(0.0, max_x1 - float(blk.get("x1", 0)))
            if page_is_rtl
            else max(0.0, float(blk.get("x0", 0)) - min_x0)
        )
        blk["sourceIndent"] = min(32, max(0, round(rel_ext / space_px))) if rel_ext >= med_lh * 0.75 else 0
    return copied, "comic"


# ---------------------------------------------------------------------------
# Word-space repair
#
# Some engines (chiefly the PP-OCR recognisers used by RapidOCR) return a whole
# line with the inter-word spaces missing: "WHATYOULLFINDINTHEFOLLOWINGPAGES".
# The characters are right, only the boundaries are lost.  Splitting such a run
# back into words is inherently ambiguous, so this is deliberately a *light*
# repair: only letter runs of eight or more characters are split, a small
# dictionary of very common words is preferred, impossible pairs (q followed by
# a consonant, a hard run of four consonants) are avoided, and a run is left
# untouched unless every piece of the split is a known word.  Nothing here can
# invent or delete a character.
# ---------------------------------------------------------------------------
_COMMON_EN_WORDS = frozenset(
    """
    a an the and or but if of to in on at by for from with without into onto over under
    is are was were be been being am do does did done has have had will would can could
    shall should may might must not no nor so as than then that this these those there their
    they them we us our you your he she it its his her who whom which what when where why how
    all any both each few many most other some such only own same very just also more less
    up down out off about after again against before below between during through during
    chapter chapters section sections part parts figure figures table tables page pages book
    books power supply supplies design designs converter converters voltage current circuit
    circuits switch switches switching mode modes technique techniques result results example
    examples simulation simulations model models analysis method methods system systems
    introduction conclusion summary overview appendix references contents index preface
    you will find following pages what why how where when
    """.split()
)
_COMMON_EN_STEMS = frozenset(
    """
    explain describe introduce discuss present show illustrate provide contain cover summarize
    examine demonstrate facilitate understand question balance strive design derive develop
    improve simulate test let want need use make take give find get know think see look work
    call come go keep put run move live believe hold bring happen write provide sit stand lose
    pay meet include continue set learn lead understand watch follow stop create speak read
    allow add spend grow open walk win offer remember love consider appear buy wait serve die
    send expect build stay fall cut reach kill remain suggest raise pass sell require report
    decide pull requirement general soldering heel fillet height dimensional criteria target
    class minimum maximum typical range value values order part parts step steps note notes
    figure table chapter section appendix index contents preface glossary bibliography
    switch switching mode modes supply supplies power converter converters voltage current
    circuit circuits design designs analysis method methods control loop loops signal signals
    model models simulation example examples technique techniques application applications
    component components resistor capacitor inductor diode transistor transformer magnetic
    thermal efficiency loss losses frequency response output input load line lines source
    """.split()
)
_MAX_GLUED_RUN = 120


def _english_word_ok(word: str) -> bool:
    low = word.lower()
    if low in _COMMON_EN_WORDS or low.rstrip("s") in _COMMON_EN_WORDS:
        return True
    if low in _COMMON_EN_STEMS:
        return True
    # Very common inflections of the stems above.
    for suffix in ("s", "es", "ed", "ing", "d", "ly"):
        if low.endswith(suffix) and low[: -len(suffix)] in _COMMON_EN_STEMS:
            return True
    return False


def _looks_glued(run: str) -> bool:
    """A Latin run with no spaces that is long enough to hide several words."""
    if not (4 <= len(run) <= _MAX_GLUED_RUN):
        return False
    if not run.isalpha():
        return False
    # CamelCase (lower, upper, lower - "MechanicalEngineering") is a name or a
    # technical token, not a glued sentence; an acronym tail ("...theSPICE") is fine.
    if re.search(r"[a-z][A-Z][a-z]", run):
        return False
    return True


def _segment_glued_run(run: str) -> list[str] | None:
    """Best-effort split of one glued run; returns None when it should be left alone."""
    n = len(run)
    if n < 8:
        return None
    low = run.lower()
    # Dynamic programming over the cheapest split; word cost favours the common
    # vocabulary, unknown chunks are allowed but expensive so real names survive.
    best: list[tuple[float, int, str]] = [(0.0, 0, "")] * (n + 1)
    for end in range(1, n + 1):
        best_score: float | None = None
        best_start = 0
        best_word = ""
        for start in range(max(0, end - 22), end):
            chunk = low[start:end]
            if not chunk.isalpha():
                continue
            score = best[start][0]
            if score >= 1e9:
                continue
            length = end - start
            if length == 1:
                # Single-letter pieces are legal only as "a" / "I".
                if chunk not in {"a", "i"}:
                    continue
                score += 3.4
            elif _english_word_ok(chunk):
                score += 0.35 if chunk in _COMMON_EN_WORDS else 0.75
            else:
                if length < 3:
                    continue
                # Unknown chunk: penalise in proportion to length so that a
                # long unrelated word is not shredded for no reason.
                score += 1.9 + 0.16 * length
            # Cheap sanity checks that remove the worst impossible splits.
            if re.search(r"q(?!u)", chunk):
                score += 2.0
            if re.search(r"[bcdfghjklmnpqrstvwxz]{4}", chunk):
                score += 1.2
            score += 0.12  # mild preference for fewer, longer chunks
            if best_score is None or score < best_score:
                best_score, best_start, best_word = score, start, run[start:end]
        if best_score is None:
            best[end] = (1e9, end, "")
        else:
            best[end] = (best_score, best_start, best_word)
    if best[n][0] >= 1e9:
        return None
    parts: list[str] = []
    idx = n
    while idx > 0:
        _, start, word = best[idx]
        parts.append(word)
        idx = start
    parts.reverse()
    if len(parts) < 2:
        return None
    # Accept only when EVERY piece is a known word.  Anything less risks
    # cutting a genuine word in half ("REQUIREMENTS" -> "REQUIRE MENTS"),
    # which is far worse for the reader than leaving the line glued.
    if not all(_english_word_ok(part.lower()) for part in parts):
        return None
    return parts


def restore_missing_word_spaces(text: str, *, minimum_ratio: float = 0.45) -> str:
    """Re-insert word spaces that an OCR engine dropped inside Latin text.

    Only long letter runs are considered; in a line that keeps most of its
    spaces the function does nothing, so normal engine output is untouched.
    """
    raw = str(text or "")
    # Count how much of the text already has spaces; a healthy line keeps them.
    latin_runs = re.findall(r"[A-Za-z]{4,}", raw)
    if not latin_runs:
        return raw
    words = raw.split()
    if not words:
        return raw
    long_runs = [run for run in latin_runs if len(run) >= 8]
    if not long_runs:
        return raw
    glued_chars = sum(len(run) for run in long_runs)
    latin_chars = sum(len(run) for run in latin_runs)
    if latin_chars and (glued_chars / latin_chars) < minimum_ratio:
        return raw
    changed = False
    out_words: list[str] = []
    for word in words:
        pieces = _segment_glued_run(word) if _looks_glued(word) else None
        if pieces:
            out_words.extend(pieces)
            changed = True
        else:
            out_words.append(word)
    if not changed:
        return raw
    return " ".join(out_words)
