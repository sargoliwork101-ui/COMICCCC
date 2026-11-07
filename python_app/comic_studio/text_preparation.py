"""Opt-in translation-unit preparation; the established translation path is unchanged."""
from __future__ import annotations

import json
import re
import statistics
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from .activity import emit

# Tunable preparation policy. Keeping these here avoids changing OCR/public schemas.
DEFAULT_MODE = "bubble"
VERTICAL_GAP_THRESHOLD = 1.5
BATCH_SIZE_CHARS = 4000
DOCUMENT_INDENT_HEIGHT_RATIO = 0.5
READING_ROW_TOLERANCE = 12.0

TRANSLATION_INSTRUCTION = (
    "هر شماره یک واحد کامل است. هر کدام را جداگانه و کامل ترجمه کن، "
    "شماره‌ها و ترتیب را حفظ کن، چیزی اضافه یا حذف نکن."
)
CONTEXT_INSTRUCTION = "پاراگراف قبلی فقط زمینه است؛ آن را ترجمه نکن و در خروجی نیاور."
OUTPUT_INSTRUCTION = (
    'خروجی فقط یک آرایهٔ JSON با این شکل باشد: [{"id":1,"text":"..."}, ...]. '
    "برای هر ورودی دقیقاً یک خروجی با همان id برگردان."
)

_SPECIAL_KINDS = {"heading", "list_item", "table_cell", "formula", "code", "term"}
_KIND_ALIASES = {
    "title": "heading",
    "list": "list_item",
    "item": "list_item",
    "table": "table_cell",
    "cell": "table_cell",
    "math": "formula",
    "source_code": "code",
}


class TextPreparationError(RuntimeError):
    """A structured response cannot be mapped safely back to its source units."""


@dataclass
class _Line:
    raw: str
    normalized: str
    kind: str
    x0: float
    y0: float
    x1: float
    y1: float
    index: int
    page: str
    region: str
    unit_key: str | None
    paragraph_start: bool

    @property
    def height(self) -> float:
        return max(0.0, self.y1 - self.y0)


@dataclass
class _Unit:
    id: int
    text: str
    kind: str
    page: str

    @property
    def translatable(self) -> bool:
        return self.kind not in {"formula", "code"}


@dataclass
class _Piece:
    unit: _Unit
    text: str


def _value(source: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(source, Mapping) and name in source:
            return source[name]
        if hasattr(source, name):
            return getattr(source, name)
    return default


def _normalize(value: Any) -> str:
    return " ".join(str(value or "").split())


def join_ocr_lines(lines: Iterable[str]) -> str:
    """Join one unit only, removing a word-break hyphen and redundant whitespace."""
    result = ""
    for value in lines:
        part = _normalize(value)
        if not part:
            continue
        if result and re.search(r"\w[-\u2010\u2011]$", result, re.UNICODE) and re.match(r"\w", part, re.UNICODE):
            result = result[:-1] + part
        else:
            result += (" " if result else "") + part
    return result


def _geometry(source: Any) -> tuple[float, float, float, float]:
    values = [_value(source, name, default=None) for name in ("x0", "y0", "x1", "y1")]
    if any(value is None for value in values):
        box = _value(source, "box", default=None)
        if box is not None and len(box) >= 4:
            values = list(box[:4])
    if any(value is None for value in values):
        polygon = _value(source, "polygon", default=[]) or []
        if polygon:
            xs = [float(point[0]) for point in polygon]
            ys = [float(point[1]) for point in polygon]
            values = [min(xs), min(ys), max(xs), max(ys)]
    defaults = [0.0, 0.0, 0.0, 0.0]
    return tuple(float(value if value is not None else fallback) for value, fallback in zip(values, defaults))  # type: ignore[return-value]


def _kind(source: Any, text: str) -> str:
    raw_kind = str(_value(source, "kind", "type", default="") or "").strip().lower().replace("-", "_").replace(" ", "_")
    raw_kind = _KIND_ALIASES.get(raw_kind, raw_kind)
    if raw_kind in _SPECIAL_KINDS | {"paragraph"}:
        return raw_kind
    for name, kind in (("heading", "heading"), ("list_item", "list_item"), ("table_cell", "table_cell"), ("formula", "formula"), ("code", "code"), ("term", "term")):
        if bool(_value(source, name, f"is_{name}", default=False)):
            return kind
    stripped = text.strip()
    if re.match(r"^#{1,6}\s+\S", stripped):
        return "heading"
    if re.match(r"^(?:[-*•▪◦]|\d+[.)])\s+\S", stripped):
        return "list_item"
    if ((stripped.startswith("$$") and stripped.endswith("$$") and len(stripped) > 4)
            or (stripped.startswith("\\[") and stripped.endswith("\\]"))
            or (stripped.startswith("\\(") and stripped.endswith("\\)"))):
        return "formula"
    return "paragraph"


def _line(source: Any, index: int) -> _Line:
    raw = str(_value(source, "text", default="") or "")
    x0, y0, x1, y1 = _geometry(source)
    unit_key = _value(source, "unit_id", "unitId", "item_id", "itemId", "cell_id", "cellId", default=None)
    return _Line(
        raw=raw,
        normalized=_normalize(raw),
        kind=_kind(source, raw),
        x0=x0, y0=y0, x1=x1, y1=y1,
        index=index,
        page=str(_value(source, "page", "page_id", "pageId", default="") or ""),
        region=str(_value(source, "region", "region_id", "regionId", "bubble", "bubble_id", "bubbleId", default="") or ""),
        unit_key=str(unit_key) if unit_key is not None else None,
        paragraph_start=bool(_value(source, "first_line_indent", "firstLineIndent", "paragraph_start", "paragraphStart", default=False)),
    )


def _reading_key(line: _Line) -> tuple[float, float, float, int]:
    center_y = (line.y0 + line.y1) / 2
    row = round(center_y / READING_ROW_TOLERANCE) * READING_ROW_TOLERANCE
    return row, line.x0, line.y0, line.index


def _unit(lines: list[_Line], kind: str, unit_id: int = 0) -> _Unit:
    if kind in {"formula", "code"}:
        text = "\n".join(line.raw for line in lines)
    else:
        text = join_ocr_lines(line.normalized for line in lines)
    return _Unit(unit_id, text, kind, lines[0].page)


def _bubble_units(lines: list[_Line]) -> list[_Unit]:
    pages: dict[str, list[_Line]] = {}
    for line in lines:
        pages.setdefault(line.page, []).append(line)
    result: list[_Unit] = []
    for page_lines in pages.values():
        regions: dict[str, list[_Line]] = {}
        for line in page_lines:
            if line.normalized:
                regions.setdefault(line.region, []).append(line)
        page_units: list[tuple[tuple[float, float, float, int], _Unit]] = []
        for region_lines in regions.values():
            ordered = sorted(region_lines, key=lambda line: (line.y0, line.x0, line.index))
            heights = [line.height for line in ordered if line.height > 0]
            median_height = statistics.median(heights) if heights else 1.0
            groups: list[list[_Line]] = []
            current: list[_Line] = []
            for line in ordered:
                if current and line.y0 - current[-1].y1 > VERTICAL_GAP_THRESHOLD * median_height:
                    groups.append(current)
                    current = []
                current.append(line)
            if current:
                groups.append(current)
            for group in groups:
                page_units.append((_reading_key(group[0]), _unit(group, "paragraph")))
        result.extend(unit for _, unit in sorted(page_units, key=lambda entry: entry[0]))
    for unit_id, unit in enumerate(result, start=1):
        unit.id = unit_id
    return result


def _usual_document_gap(lines: list[_Line]) -> float:
    gaps = []
    heights = [line.height for line in lines if line.height > 0]
    previous: _Line | None = None
    for line in lines:
        if not line.normalized:
            previous = None
            continue
        if previous is not None and previous.kind == line.kind == "paragraph":
            gap = line.y0 - previous.y1
            if gap >= 0:
                gaps.append(gap)
        previous = line
    fallback = statistics.median(heights) if heights else 1.0
    usual = statistics.median(gaps) if gaps else fallback
    return usual if usual > 0 else (fallback if fallback > 0 else 1.0)


def _document_units(lines: list[_Line]) -> list[_Unit]:
    usual_gap = _usual_document_gap(lines)
    heights = [line.height for line in lines if line.height > 0]
    indent_tolerance = (statistics.median(heights) if heights else 1.0) * DOCUMENT_INDENT_HEIGHT_RATIO
    groups: list[tuple[list[_Line], str]] = []
    current: list[_Line] = []
    current_kind = "paragraph"
    current_key: str | None = None
    fence_active = False

    def flush() -> None:
        nonlocal current, current_key
        if current:
            groups.append((current, current_kind))
        current = []
        current_key = None

    for line in lines:
        fence = line.normalized.strip().startswith("```")
        if fence_active:
            current.append(line)
            if fence:
                fence_active = False
                flush()
            continue
        if fence:
            flush()
            current = [line]
            current_kind = "code"
            current_key = f"fence-{line.index}"
            if line.normalized.count("```") >= 2:
                flush()
            else:
                fence_active = True
            continue
        if not line.normalized:
            flush()
            continue
        if line.kind in _SPECIAL_KINDS:
            if current and line.unit_key is not None and current_key == line.unit_key and current_kind == line.kind:
                current.append(line)
                continue
            flush()
            current = [line]
            current_kind = line.kind
            current_key = line.unit_key
            if line.unit_key is None:
                flush()
            continue
        if current and current_kind in {"list_item", "table_cell", "formula", "code"} and line.unit_key is not None and line.unit_key == current_key:
            current.append(line)
            continue
        if current and current_kind != "paragraph":
            flush()
        if current:
            previous = current[-1]
            vertical_break = line.y0 - previous.y1 > VERTICAL_GAP_THRESHOLD * usual_gap
            indent_break = (line.x0 - previous.x0 > indent_tolerance and line.x0 - current[0].x0 > indent_tolerance)
            if line.paragraph_start or vertical_break or indent_break:
                flush()
        current.append(line)
        current_kind = "paragraph"
        current_key = line.unit_key
    flush()
    result = [_unit(group, kind) for group, kind in groups if group]
    for unit_id, unit in enumerate(result, start=1):
        unit.id = unit_id
    return result


def _prepare(lines: list[Any], mode: str) -> list[_Unit]:
    if mode not in {"bubble", "document"}:
        raise ValueError("mode must be 'bubble' or 'document'")
    positioned = [_line(source, index) for index, source in enumerate(lines)]
    return _bubble_units(positioned) if mode == "bubble" else _document_units(positioned)


def prepare_translation_units(lines: list[Any], mode: str = DEFAULT_MODE) -> list[dict[str, Any]]:
    """Return JSON-ready units without changing the existing OCR block schema."""
    return [{"id": unit.id, "text": unit.text} for unit in _prepare(lines, mode)]


def build_translation_prompt(
    items: list[dict[str, Any]],
    glossary: Mapping[str, str] | None = None,
    context: str | None = None,
) -> str:
    payload: dict[str, Any] = {
        "instruction": f"{TRANSLATION_INSTRUCTION} {OUTPUT_INSTRUCTION}",
        "glossary": dict(glossary or {}),
        "items": [{"id": item["id"], "text": item["text"]} for item in items],
    }
    if context:
        payload["context"] = {"instruction": CONTEXT_INSTRUCTION, "text": context}
    return json.dumps(payload, ensure_ascii=False)


def parse_translation_response(response: Any, expected_ids: list[int]) -> list[dict[str, Any]]:
    """Validate count, order and ids before any translation can be mapped back."""
    try:
        if isinstance(response, str):
            text = response.strip()
            fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
            if fenced:
                text = fenced.group(1)
            payload = json.loads(text)
        else:
            payload = response
        if not isinstance(payload, list):
            raise TextPreparationError("Translation response must be a JSON array.")
        if len(payload) != len(expected_ids):
            raise TextPreparationError(f"Translation count mismatch: expected {len(expected_ids)}, received {len(payload)}.")
        result = []
        for item in payload:
            if not isinstance(item, dict) or isinstance(item.get("id"), bool) or not isinstance(item.get("id"), int):
                raise TextPreparationError("Every translated item must have an integer id.")
            if not isinstance(item.get("text"), str) or not item["text"].strip():
                raise TextPreparationError("Every translated item must have nonempty text.")
            result.append({"id": item["id"], "text": item["text"].strip()})
        ids = [item["id"] for item in result]
        if ids != expected_ids:
            raise TextPreparationError(f"Translation ids/order mismatch: expected {expected_ids}, received {ids}.")
        return result
    except TextPreparationError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise TextPreparationError(f"Invalid translation JSON: {exc}") from exc


def _sentence_chunks(text: str, limit: int) -> list[str]:
    remaining = text.strip()
    chunks: list[str] = []
    while len(remaining) > limit:
        ends = [match.end() for match in re.finditer(r"[.!?…。！？؟][\"'”’»)\]}]*", remaining)]
        within = [end for end in ends if end <= limit]
        if within:
            cut = max(within)
        elif ends:
            # A single sentence can exceed the limit; never cut that sentence in half.
            cut = ends[0]
        else:
            break
        chunk = remaining[:cut].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


def _batches(units: list[_Unit], mode: str, batch_size: int) -> list[list[_Piece]]:
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    if mode == "bubble":
        pages: dict[str, list[_Piece]] = {}
        for unit in units:
            if unit.translatable:
                pages.setdefault(unit.page, []).append(_Piece(unit, unit.text))
        return list(pages.values())
    batches: list[list[_Piece]] = []
    current: list[_Piece] = []
    current_size = 0

    def flush() -> None:
        nonlocal current, current_size
        if current:
            batches.append(current)
        current = []
        current_size = 0

    for unit in units:
        if not unit.translatable:
            continue
        if len(unit.text) > batch_size:
            flush()
            if unit.kind == "paragraph":
                emit(
                    f"Paragraph {unit.id} exceeds the {batch_size}-character batch limit; "
                    "sentence-boundary splitting is being used as a last resort.",
                    "warning",
                )
                parts = _sentence_chunks(unit.text, batch_size)
            else:
                parts = [unit.text]
            for part in parts:
                batches.append([_Piece(unit, part)])
            continue
        if current and current_size + len(unit.text) > batch_size:
            flush()
        current.append(_Piece(unit, unit.text))
        current_size += len(unit.text)
    flush()
    return batches


def translate_prepared(
    lines: list[Any],
    request: Callable[[str], Any],
    mode: str = DEFAULT_MODE,
    glossary: dict[str, str] | None = None,
    batch_size: int = BATCH_SIZE_CHARS,
    learn_terms: Callable[[list[dict[str, Any]], list[dict[str, Any]]], Mapping[str, str] | None] | None = None,
) -> list[dict[str, Any]]:
    """Run the opt-in structured path and return JSON-ready id/text translations."""
    units = _prepare(lines, mode)
    terms = glossary if glossary is not None else {}
    contexts: dict[int, str | None] = {}
    previous_paragraph: str | None = None
    for unit in units:
        contexts[unit.id] = previous_paragraph
        if unit.kind == "paragraph":
            previous_paragraph = unit.text
    translated_parts: dict[int, list[str]] = {}
    for batch in _batches(units, mode, batch_size):
        source_items = [{"id": piece.unit.id, "text": piece.text} for piece in batch]
        expected_ids = [item["id"] for item in source_items]
        context = contexts[batch[0].unit.id] if mode == "document" else None
        prompt = build_translation_prompt(source_items, terms, context)
        translated = None
        last_error: TextPreparationError | None = None
        for _attempt in range(2):
            response = request(prompt)
            try:
                translated = parse_translation_response(response, expected_ids)
                break
            except TextPreparationError as exc:
                last_error = exc
        if translated is None:
            raise TextPreparationError(f"Translation response is still incompatible after one retry: {last_error}")
        for item in translated:
            translated_parts.setdefault(item["id"], []).append(item["text"])
        for piece in batch:
            if piece.unit.kind == "term":
                source_text = piece.unit.text
                joined = " ".join(translated_parts.get(piece.unit.id, []))
                if joined:
                    terms[source_text] = joined
        if learn_terms is not None:
            learned = learn_terms(source_items, translated)
            if learned:
                terms.update({str(key): str(value) for key, value in learned.items()})
    result = []
    for unit in units:
        if not unit.translatable:
            result.append({"id": unit.id, "text": unit.text})
            continue
        parts = translated_parts.get(unit.id)
        if not parts:
            raise TextPreparationError(f"No translation was returned for unit {unit.id}.")
        result.append({"id": unit.id, "text": " ".join(parts)})
    return result
