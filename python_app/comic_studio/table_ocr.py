"""Table-aware Persian/Arabic OCR (ruled-table detection + per-cell reading).

Root cause of "Persian table data cannot be read at all":
Tesseract's page layout analysis (``Textord``) treats a ruled table as one wide
text line, so words coming from *different columns* are glued together, the
right-to-left reading order is destroyed and every number ends up inside the
neighbouring Persian word (e.g. ``۱۳0-۸-610`` instead of ``IPC-A-610``).

This module fixes it at the source instead of patching the produced text:

1. **Detect** ruled tables on the page (horizontal / vertical rule lines that
   are long and solid, never the thin decorative frames of a comic panel).
2. **Segment** every table into a row/column grid (rules first, whitespace
   gutters only as a fallback) and keep every cell rectangle.
3. **Read** every cell *on its own* with a single-line Tesseract pass
   (``--psm 7`` then ``--psm 6``) plus the existing Persian/English arbitration,
   so a cell keeps its own text, its own confidence and its own box.
4. **Order** the cells right-to-left (Persian) row by row, so the exported
   document reads like the original table.

The module is engine agnostic: Tesseract, RapidOCR, EasyOCR and the Persian
native Hezar engine can read cells; heavy VLM engines (Surya, PaddleOCR-VL,
dots.ocr, ...) keep their own document layout analysis and are left untouched.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# --- tuning knobs -------------------------------------------------------
MIN_RULE_LENGTH_RATIO = 0.16          # a rule must span at least this share of the page
MIN_RULE_THICKNESS_RATIO = 0.02       # a rule must stay thin (rejects panel frames)
MIN_REGION_SIDE = 110                 # ignore tiny regions (icons, separators)
MIN_ROWS = 2                          # a table needs at least two rows ...
MIN_COLS = 2                          # ... and at least two columns
MAX_COLUMNS = 12
MAX_CELLS = 160                       # hard cap so a huge page can never hang the OCR
MIN_CELL_INK_RATIO = 0.004            # a cell with almost no ink is skipped
TARGET_TEXT_HEIGHT = 46.0             # cells are upscaled to this ink height for Tesseract
MAX_CELL_UPSCALE = 4.0

_RTL_LANGUAGES = {"fas", "ara"}


@dataclass(frozen=True)
class TableRegion:
    """A detected table: its bounding box plus the row/column grid inside it."""

    x0: int
    y0: int
    x1: int
    y1: int
    row_bands: tuple[tuple[int, int], ...]
    col_bands: tuple[tuple[int, int], ...]
    source: str = "rules"


@dataclass(frozen=True)
class TableCellText:
    """One read cell: its text, confidence and box in *page* pixel coordinates."""

    text: str
    confidence: float
    x0: float
    y0: float
    x1: float
    y1: float
    row: int
    col: int
    region_index: int


@dataclass(frozen=True)
class TableReadout:
    regions: tuple[TableRegion, ...]
    cells: tuple[TableCellText, ...]


# --- image helpers -------------------------------------------------------


def _rgb_array(image: Any) -> Any:
    import numpy as np
    from PIL import ImageOps

    oriented = ImageOps.exif_transpose(image)
    if oriented.mode != "RGB":
        oriented = oriented.convert("RGB")
    return np.asarray(oriented, dtype=np.uint8)


def _ink_mask(rgb: Any) -> Any:
    """Binary ink mask (255 = ink) that keeps thin Persian dots and table rules."""
    import cv2

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape[:2]
    block = max(15, (int(round(min(h, w) * 0.04)) | 1))
    bw = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 12
    )
    return bw


def _find_horizontal_rules(ink: Any, page_w: int, page_h: int) -> list[tuple[int, int, int, int]]:
    import cv2

    kernel_len = max(40, int(page_w * MIN_RULE_LENGTH_RATIO))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_len, 1))
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, kernel)
    horiz = cv2.dilate(horiz, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3)))
    num, _, stats, _ = cv2.connectedComponentsWithStats(horiz, connectivity=8)
    max_thickness = max(8, int(page_h * MIN_RULE_THICKNESS_RATIO))
    rules: list[tuple[int, int, int, int]] = []
    for idx in range(1, num):
        x = int(stats[idx, cv2.CC_STAT_LEFT])
        y = int(stats[idx, cv2.CC_STAT_TOP])
        w = int(stats[idx, cv2.CC_STAT_WIDTH])
        h = int(stats[idx, cv2.CC_STAT_HEIGHT])
        area = int(stats[idx, cv2.CC_STAT_AREA])
        if w < kernel_len * 0.55 or h > max_thickness:
            continue
        if area < 0.45 * w * max(1, h):
            continue
        rules.append((x, y, x + w, y + h))
    return rules


def _find_vertical_rules(ink: Any, page_w: int, page_h: int) -> list[tuple[int, int, int, int]]:
    import cv2

    kernel_len = max(30, int(page_h * 0.05))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, kernel_len))
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, kernel)
    vert = cv2.dilate(vert, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1)))
    num, _, stats, _ = cv2.connectedComponentsWithStats(vert, connectivity=8)
    max_thickness = max(8, int(page_w * MIN_RULE_THICKNESS_RATIO))
    rules: list[tuple[int, int, int, int]] = []
    for idx in range(1, num):
        x = int(stats[idx, cv2.CC_STAT_LEFT])
        y = int(stats[idx, cv2.CC_STAT_TOP])
        w = int(stats[idx, cv2.CC_STAT_WIDTH])
        h = int(stats[idx, cv2.CC_STAT_HEIGHT])
        area = int(stats[idx, cv2.CC_STAT_AREA])
        if h < kernel_len * 0.55 or w > max_thickness:
            continue
        if area < 0.45 * max(1, w) * h:
            continue
        rules.append((x, y, x + w, y + h))
    return rules


def _group_rules(
    rules: list[tuple[int, int, int, int]],
    *,
    axis: str,
    page_span: int,
) -> list[list[tuple[int, int, int, int]]]:
    """Group parallel rules that belong to the same table.

    Rules join the same group when they overlap strongly on the *other* axis and
    are not separated by a huge gap (two different tables on the same page stay
    apart).
    """
    groups: list[list[tuple[int, int, int, int]]] = []
    ordered = sorted(rules, key=lambda r: (r[1], r[0]) if axis == "y" else (r[0], r[1]))
    max_gap = max(120.0, page_span * 0.35)
    for rule in ordered:
        placed = False
        for grp in groups:
            if axis == "y":
                gx0 = min(r[0] for r in grp)
                gx1 = max(r[2] for r in grp)
                inter = min(rule[2], gx1) - max(rule[0], gx0)
                base = min(rule[2] - rule[0], gx1 - gx0)
                last_y = max(r[3] for r in grp)
                gap = rule[1] - last_y
            else:
                gy0 = min(r[1] for r in grp)
                gy1 = max(r[3] for r in grp)
                inter = min(rule[3], gy1) - max(rule[1], gy0)
                base = min(rule[3] - rule[1], gy1 - gy0)
                last_x = max(r[2] for r in grp)
                gap = rule[0] - last_x
            if base <= 0:
                continue
            if inter < 0.5 * base:
                continue
            if gap > max_gap or gap < -page_span:
                continue
            grp.append(rule)
            placed = True
            break
        if not placed:
            groups.append([rule])
    return groups


def _text_row_bands(ink: Any, x0: int, y0: int, x1: int, y1: int) -> list[tuple[int, int]]:
    """Find the horizontal text rows inside a region (used when rows have no rule)."""
    import numpy as np

    sub = ink[y0:y1, x0:x1]
    if sub.size == 0:
        return []
    counts = (sub > 0).sum(axis=1).astype(np.float32)
    if counts.size == 0 or float(counts.max()) <= 0.0:
        return []
    threshold = max(1.0, 0.02 * float(counts.max()))
    active = counts >= threshold
    runs: list[list[int]] = []
    start = -1
    for idx, flag in enumerate(active):
        if flag and start < 0:
            start = idx
        elif not flag and start >= 0:
            runs.append([start, idx])
            start = -1
    if start >= 0:
        runs.append([start, len(active)])
    if not runs:
        return []
    heights = sorted(max(1, r[1] - r[0]) for r in runs)
    median_h = heights[len(heights) // 2]
    merged: list[list[int]] = [runs[0][:]]
    for run in runs[1:]:
        prev = merged[-1]
        gap = run[0] - prev[1]
        if gap <= max(2, int(median_h * 0.65)):
            prev[1] = run[1]
        else:
            merged.append(run[:])
    bands: list[tuple[int, int]] = []
    for r0, r1 in merged:
        if r1 - r0 < 5:
            continue
        bands.append((y0 + r0, y0 + r1))
    return bands


def _infer_column_separators(
    ink: Any,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    row_bands: list[tuple[int, int]],
) -> list[int]:
    """Find whitespace gutters that separate columns when no vertical rule exists."""
    import numpy as np

    sub = ink[y0:y1, x0:x1]
    if sub.size == 0:
        return []
    masked = sub.copy()
    keep = np.zeros((y1 - y0,), dtype=bool)
    for ry0, ry1 in row_bands:
        a = max(0, ry0 - y0)
        b = min(y1 - y0, ry1 - y0)
        if b > a:
            keep[a:b] = True
    if not keep.any():
        keep[:] = True
    masked[~keep] = 0
    counts = (masked > 0).sum(axis=0).astype(np.float32)
    if counts.size == 0 or float(counts.max()) <= 0.0:
        return []
    threshold = max(1.0, 0.03 * float(counts.max()))
    separators: list[int] = []
    run_start = -1
    for idx, value in enumerate(counts):
        if value <= threshold:
            if run_start < 0:
                run_start = idx
        elif run_start >= 0:
            if idx - run_start >= 4:
                separators.append(x0 + (run_start + idx) // 2)
            run_start = -1
    if run_start >= 0 and len(counts) - run_start >= 4:
        separators.append(x0 + (run_start + len(counts)) // 2)
    # A separator must sit between two inked columns, never on the outer edge.
    inked = counts > threshold
    valid: list[int] = []
    for sep in separators:
        rel = sep - x0
        if rel <= 0 or rel >= len(inked) - 1:
            continue
        if not inked[:rel].any() or not inked[rel + 1:].any():
            continue
        valid.append(sep)
    return valid


def _bands_from_separators(lo: int, hi: int, separators: list[int]) -> list[tuple[int, int]]:
    edges = [lo] + sorted({s for s in separators if lo < s < hi}) + [hi]
    bands: list[tuple[int, int]] = []
    for idx in range(len(edges) - 1):
        a, b = edges[idx], edges[idx + 1]
        if b - a >= 8:
            bands.append((a, b))
    return bands


# --- detection -----------------------------------------------------------


def detect_table_regions(image: Any) -> list[TableRegion]:
    """Detect ruled tables on the page and split them into a row/column grid."""
    try:
        import cv2  # noqa: F401
    except Exception:
        return []
    try:
        rgb = _rgb_array(image)
    except Exception:
        return []
    page_h, page_w = rgb.shape[:2]
    if page_w < MIN_REGION_SIDE * 2 or page_h < MIN_REGION_SIDE * 2:
        return []
    ink = _ink_mask(rgb)
    h_rules = _find_horizontal_rules(ink, page_w, page_h)
    v_rules = _find_vertical_rules(ink, page_w, page_h)
    regions: list[TableRegion] = []

    # Branch A: at least three horizontal rules -> the rows are rule separated.
    for grp in _group_rules(h_rules, axis="y", page_span=page_h):
        if len(grp) < 3:
            continue
        grp = sorted(grp, key=lambda r: r[1])
        x0 = max(r[0] for r in grp)
        x1 = min(r[2] for r in grp)
        if x1 - x0 < page_w * 0.25:
            x0 = min(r[0] for r in grp)
            x1 = max(r[2] for r in grp)
        y0 = grp[0][1]
        y1 = grp[-1][3]
        if x1 - x0 < MIN_REGION_SIDE or y1 - y0 < MIN_REGION_SIDE:
            continue
        row_bands: list[tuple[int, int]] = []
        for idx in range(len(grp) - 1):
            band = (grp[idx][3], grp[idx + 1][1])
            if band[1] - band[0] >= 8:
                row_bands.append(band)
        if len(row_bands) < MIN_ROWS:
            continue
        inner_v = [
            r for r in v_rules
            if r[0] > x0 + 4 and r[2] < x1 - 4 and (min(r[3], y1) - max(r[1], y0)) >= 0.55 * (y1 - y0)
        ]
        separators = sorted({int((r[0] + r[2]) // 2) for r in inner_v})
        if not separators:
            separators = _infer_column_separators(ink, x0, y0, x1, y1, row_bands)
        col_bands = _bands_from_separators(x0, x1, separators)
        if len(col_bands) < MIN_COLS or len(col_bands) > MAX_COLUMNS:
            continue
        regions.append(TableRegion(x0, y0, x1, y1, tuple(row_bands), tuple(col_bands), "h-rules"))

    # Branch B: at least three vertical rules -> the columns are rule separated
    # and the rows come from the text rows inside the table.
    for grp in _group_rules(v_rules, axis="x", page_span=page_w):
        if len(grp) < 3:
            continue
        grp = sorted(grp, key=lambda r: r[0])
        x0 = grp[0][0]
        x1 = grp[-1][2]
        y0 = min(r[1] for r in grp)
        y1 = max(r[3] for r in grp)
        if x1 - x0 < MIN_REGION_SIDE or y1 - y0 < MIN_REGION_SIDE:
            continue
        separators = sorted({int((r[0] + r[2]) // 2) for r in grp[1:-1]})
        col_bands = _bands_from_separators(x0, x1, separators)
        if len(col_bands) < MIN_COLS or len(col_bands) > MAX_COLUMNS:
            continue
        row_bands = _text_row_bands(ink, x0, y0, x1, y1)
        if len(row_bands) < MIN_ROWS:
            continue
        regions.append(TableRegion(x0, y0, x1, y1, tuple(row_bands), tuple(col_bands), "v-rules"))

    # Drop duplicated / nested detections.
    unique: list[TableRegion] = []
    for region in sorted(regions, key=lambda r: (r.y0, r.x0)):
        duplicate = False
        for kept in unique:
            if (
                region.x0 >= kept.x0 - 4 and region.x1 <= kept.x1 + 4
                and region.y0 >= kept.y0 - 4 and region.y1 <= kept.y1 + 4
            ):
                duplicate = True
                break
        if not duplicate:
            unique.append(region)
    return unique


# --- cell reading --------------------------------------------------------


def _engine_reads_cells(engine: Any) -> bool:
    """Only engines that can read a *crop* reliably may be used for cells."""
    if callable(getattr(engine, "_run_tesseract_tsv", None)):
        return True
    engine_id = str(getattr(engine, "id", "") or "")
    if engine_id == "hezar-ocr":
        return True
    return type(engine).__name__ in {"RapidEngine", "EasyEngine"}


def _cell_scale(ink: Any, box: tuple[int, int, int, int]) -> float:
    import numpy as np

    x0, y0, x1, y1 = box
    sub = ink[y0:y1, x0:x1]
    if sub.size == 0:
        return 1.0
    rows = (sub > 0).sum(axis=1)
    active = np.nonzero(rows > 0)[0]
    if active.size == 0:
        return 1.0
    ink_h = float(active[-1] - active[0] + 1)
    if ink_h <= 2.0:
        return 1.0
    scale = TARGET_TEXT_HEIGHT / ink_h
    return float(max(1.0, min(MAX_CELL_UPSCALE, scale)))


def _read_cell_tesseract(engine: Any, crop: Any, language: str) -> tuple[str, float, tuple[float, float, float, float]]:
    from .ocr import _fuse_bilingual_persian_english_tsv, _parse_tsv_word_spans, _persian_line_needs_bilingual_check

    best_text = ""
    best_conf = 0.0
    best_words: list[dict[str, Any]] = []
    for psm in ("7", "6"):
        try:
            tsv = engine._run_tesseract_tsv(crop, language, psm)
        except Exception:
            continue
        words = _parse_tsv_word_spans(tsv)
        if not words:
            continue
        text = " ".join(str(w["text"]) for w in words).strip()
        confs = [float(w.get("conf", 0.0)) for w in words if float(w.get("conf", -1)) >= 0]
        conf = (sum(confs) / len(confs) / 100.0) if confs else 0.0
        if language in _RTL_LANGUAGES and text and _persian_line_needs_bilingual_check(text, words):
            try:
                eng_tsv = engine._run_tesseract_tsv(crop, "eng", "7")
            except Exception:
                eng_tsv = ""
            eng_words = _parse_tsv_word_spans(eng_tsv) if eng_tsv else []
            if eng_words:
                text = _fuse_bilingual_persian_english_tsv(words, eng_words)
        if text and (not best_text or conf > best_conf):
            best_text = text
            best_conf = conf
            best_words = words
        if text:
            break
    if not best_words:
        return best_text, best_conf, (0.0, 0.0, 0.0, 0.0)
    x0 = float(min(int(w["x0"]) for w in best_words))
    y0 = float(min(int(w["y0"]) for w in best_words))
    x1 = float(max(int(w["x1"]) for w in best_words))
    y1 = float(max(int(w["y1"]) for w in best_words))
    return best_text, best_conf, (x0, y0, x1, y1)


def _read_cell_generic(engine: Any, crop: Any, language: str) -> tuple[str, float, tuple[float, float, float, float]]:
    try:
        lines = engine.recognize(crop, language)
    except TypeError:
        try:
            lines = engine.recognize(crop, language, page_mode="auto")
        except Exception:
            return "", 0.0, (0.0, 0.0, 0.0, 0.0)
    except Exception:
        return "", 0.0, (0.0, 0.0, 0.0, 0.0)
    texts: list[str] = []
    confs: list[float] = []
    xs0: list[float] = []
    ys0: list[float] = []
    xs1: list[float] = []
    ys1: list[float] = []
    for line in lines or []:
        text = str(getattr(line, "text", "") or "").strip()
        if not text:
            continue
        texts.append(text)
        try:
            confs.append(float(getattr(line, "confidence", 0.0)))
        except (TypeError, ValueError):
            confs.append(0.0)
        box = getattr(line, "box", None)
        if box and len(box) == 4:
            xs0.append(float(box[0])); ys0.append(float(box[1]))
            xs1.append(float(box[2])); ys1.append(float(box[3]))
    if not texts:
        return "", 0.0, (0.0, 0.0, 0.0, 0.0)
    conf = sum(confs) / len(confs) if confs else 0.0
    bounds = (min(xs0), min(ys0), max(xs1), max(ys1)) if xs0 else (0.0, 0.0, 0.0, 0.0)
    return " ".join(texts), conf, bounds


def recognize_tables(
    engine: Any,
    image: Any,
    language: str,
    *,
    min_confidence: float = 0.35,
    max_cells: int = MAX_CELLS,
) -> TableReadout:
    """Detect the tables of the page and read every cell on its own."""
    from .activity import check_cancelled

    if language not in _RTL_LANGUAGES:
        return TableReadout((), ())
    if not _engine_reads_cells(engine):
        return TableReadout((), ())
    regions = detect_table_regions(image)
    if not regions:
        return TableReadout((), ())
    try:
        rgb = _rgb_array(image)
    except Exception:
        return TableReadout((), ())
    ink = _ink_mask(rgb)
    page_h, page_w = ink.shape[:2]
    cells: list[TableCellText] = []
    budget = max(1, int(max_cells))
    for region_index, region in enumerate(regions):
        check_cancelled("عملیات OCR به درخواست کاربر لغو شد.")
        expected_cells = len(region.row_bands) * len(region.col_bands)
        if expected_cells > max(1, int(max_cells)):
            # A huge grid would need hundreds of single-cell OCR passes: keep the
            # page level result instead of returning a half read table.
            continue
        for row_index, (ry0, ry1) in enumerate(region.row_bands):
            for col_index, (cx0, cx1) in enumerate(region.col_bands):
                if budget <= 0:
                    break
                inset = 3
                x0 = max(region.x0, cx0 + inset)
                x1 = min(region.x1, cx1 - inset)
                y0 = max(region.y0, ry0 + inset)
                y1 = min(region.y1, ry1 - inset)
                if x1 - x0 < 10 or y1 - y0 < 8:
                    continue
                sub = ink[y0:y1, x0:x1]
                if sub.size == 0 or float((sub > 0).sum()) < MIN_CELL_INK_RATIO * sub.size:
                    continue
                scale = _cell_scale(ink, (x0, y0, x1, y1))
                try:
                    crop = image.crop((x0, y0, x1, y1))
                except Exception:
                    continue
                try:
                    if scale > 1.05:
                        crop = crop.resize(
                            (max(1, int(round((x1 - x0) * scale))), max(1, int(round((y1 - y0) * scale)))),
                            _resample_lanczos(),
                        )
                    if callable(getattr(engine, "_run_tesseract_tsv", None)):
                        text, conf, bounds = _read_cell_tesseract(engine, crop, language)
                    else:
                        text, conf, bounds = _read_cell_generic(engine, crop, language)
                finally:
                    try:
                        crop.close()
                    except Exception:
                        pass
                budget -= 1
                if not text:
                    continue
                if language in _RTL_LANGUAGES:
                    text = _normalize_cell_text(text)
                if conf < min_confidence and len(text) < 3:
                    continue
                if bounds == (0.0, 0.0, 0.0, 0.0):
                    bx0, by0, bx1, by1 = float(x0), float(y0), float(x1), float(y1)
                else:
                    inv = 1.0 / max(1e-6, scale)
                    bx0 = x0 + bounds[0] * inv
                    by0 = y0 + bounds[1] * inv
                    bx1 = x0 + bounds[2] * inv
                    by1 = y0 + bounds[3] * inv
                bx0 = max(0.0, min(page_w, bx0))
                bx1 = max(bx0 + 1.0, min(page_w, bx1))
                by0 = max(0.0, min(page_h, by0))
                by1 = max(by0 + 1.0, min(page_h, by1))
                cells.append(
                    TableCellText(
                        text=text,
                        confidence=float(max(0.0, min(1.0, conf))),
                        x0=bx0, y0=by0, x1=bx1, y1=by1,
                        row=row_index, col=col_index, region_index=region_index,
                    )
                )
    return TableReadout(tuple(regions), tuple(cells))


def _resample_lanczos() -> Any:
    from PIL import Image

    return Image.Resampling.LANCZOS


def _normalize_cell_text(text: str) -> str:
    try:
        from .ocr import normalize_persian_ocr_text

        return normalize_persian_ocr_text(text)
    except Exception:
        return text
