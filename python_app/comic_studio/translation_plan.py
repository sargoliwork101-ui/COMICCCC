"""Shared translation request planning, exact previews, and confirmation signatures."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .translation import (
    AI_PROVIDERS, MAX_FREE_QUERY_CHARS, TranslationError, combine_translation_texts,
    translation_request_view,
)


PARAGRAPH_MAX_GAP_RATIO = 0.9
PARAGRAPH_MIN_HORIZONTAL_OVERLAP = 0.2


def continuous_paragraph_text(value: Any) -> str:
    """Return one continuous paragraph without OCR line-wrap whitespace."""
    return " ".join(str(value or "").split())


def _block_box(block: dict[str, Any], layout: bool = False) -> tuple[float, float, float, float] | None:
    source_keys = ("x0", "y0", "x1", "y1")
    keys = ("tx0", "ty0", "tx1", "ty1") if layout else source_keys
    values = []
    for key, source_key in zip(keys, source_keys):
        raw = block.get(key)
        if raw is None:
            raw = block.get(source_key)
        try:
            values.append(float(raw))
        except (TypeError, ValueError):
            return None
    x0, y0, x1, y1 = values
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _same_paragraph(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    """Conservatively join stacked, horizontally overlapping OCR lines."""
    first = _block_box(previous)
    second = _block_box(current)
    if not first or not second:
        return False
    line_h = max(
        8.0, first[3] - first[1], second[3] - second[1],
        float(previous.get("lineH") or 0), float(current.get("lineH") or 0),
    )
    # Side-by-side fragments and new columns are not automatically paragraphs.
    if second[1] < first[3] - line_h * 0.5:
        return False
    if second[1] - first[3] > line_h * PARAGRAPH_MAX_GAP_RATIO:
        return False
    overlap = min(first[2], second[2]) - max(first[0], second[0])
    narrower = min(first[2] - first[0], second[2] - second[0])
    return overlap > 0 and overlap / narrower >= PARAGRAPH_MIN_HORIZONTAL_OVERLAP


def _union_box(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    return (
        min(box[0] for box in boxes), min(box[1] for box in boxes),
        max(box[2] for box in boxes), max(box[3] for box in boxes),
    )


def _merged_paragraph_block(group: dict[str, Any], translated: str) -> dict[str, Any]:
    blocks = group["blocks"]
    merged = dict(blocks[0])
    merged["text"] = group["text"]
    merged["tr"] = translated
    merged["richHtml"] = ""
    merged["enabled"] = True
    source_boxes = [_block_box(block) for block in blocks]
    source_boxes = [box for box in source_boxes if box]
    if source_boxes:
        x0, y0, x1, y1 = _union_box(source_boxes)
        merged.update({"x0": x0, "y0": y0, "x1": x1, "y1": y1})
        merged["polygon"] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        layout_boxes = [_block_box(block, True) for block in blocks]
        layout_boxes = [box for box in layout_boxes if box]
        tx0, ty0, tx1, ty1 = _union_box(layout_boxes or source_boxes)
        merged.update({"tx0": tx0, "ty0": ty0, "tx1": tx1, "ty1": ty1})
    line_heights = [float(block.get("lineH") or 0) for block in blocks]
    if any(line_heights):
        merged["lineH"] = max(line_heights)
    weights = [max(1, len(continuous_paragraph_text(block.get("text")))) for block in blocks]
    merged["conf"] = round(sum(float(block.get("conf") or 0) * weight for block, weight in zip(blocks, weights)) / sum(weights), 2)
    modes = {block.get("textMode") for block in blocks if block.get("textMode") in {"ocr", "translation"}}
    if len(modes) == 1:
        merged["textMode"] = modes.pop()
    else:
        merged.pop("textMode", None)
    return merged


def apply_paragraph_translations(plan: dict[str, Any], translations: list[str]) -> None:
    """Atomically replace every successfully translated OCR group with one box."""
    groups = plan["groups"]
    if len(translations) != len(groups):
        raise TranslationError("تعداد ترجمه‌ها با پاراگراف‌های مبدأ یکسان نیست؛ کادرها تغییر نکردند.")
    merged_groups = [(group, _merged_paragraph_block(group, translated)) for group, translated in zip(groups, translations)]
    for item in plan["items"]:
        replacements = {}
        removed = set()
        for group, merged in merged_groups:
            if group["item"] is not item:
                continue
            replacements[id(group["blocks"][0])] = merged
            removed.update(id(block) for block in group["blocks"][1:])
        if not replacements:
            continue
        item["blocks"] = [
            replacements[id(block)] if id(block) in replacements else block
            for block in item.get("blocks", []) if id(block) not in removed
        ]


def build_project_plan(state: dict[str, Any], image_ids: list[str], provider: str) -> dict[str, Any]:
    ids = set(image_ids)
    items = [
        item for item in sorted(state["images"], key=lambda entry: entry.get("order", 0))
        if item["id"] in ids
    ]
    groups = []
    for item in items:
        item_groups: list[list[dict[str, Any]]] = []
        for block in item.get("blocks", []):
            if not block.get("enabled", True) or not continuous_paragraph_text(block.get("text")):
                continue
            if item_groups and _same_paragraph(item_groups[-1][-1], block):
                item_groups[-1].append(block)
            else:
                item_groups.append([block])
        for blocks in item_groups:
            text = " ".join(continuous_paragraph_text(block.get("text")) for block in blocks)
            groups.append({"item": item, "blocks": blocks, "text": text})
    blocks = [group["blocks"][0] for group in groups]
    source_texts = [group["text"] for group in groups]
    combined_source = combine_translation_texts(source_texts)
    combined_free = provider == "free" and len(combined_source) <= MAX_FREE_QUERY_CHARS
    if not groups:
        calls: list[dict[str, Any]] = []
    elif combined_free or provider != "free":
        calls = [{"text": combined_source, "indices": list(range(len(groups))), "combined": True}]
    else:
        calls = [{"text": text, "indices": [index], "combined": False} for index, text in enumerate(source_texts)]
    return {
        "items": items,
        "blocks": blocks,
        "groups": groups,
        "keys": [
            "+".join(f"{group['item']['id']}:{block.get('id', '')}" for block in group["blocks"])
            for group in groups
        ],
        "source_texts": source_texts,
        "calls": calls,
        "combined_free": combined_free,
    }


def build_single_plan(text: str, provider: str) -> dict[str, Any]:
    clean = str(text or "").strip()
    return {
        "items": [], "blocks": [], "keys": ["single-text"] if clean else [],
        "source_texts": [clean] if clean else [],
        "calls": [{"text": clean, "indices": [0], "combined": False}] if clean else [],
        "combined_free": provider == "free" and len(clean) <= MAX_FREE_QUERY_CHARS,
    }


def plan_signature(
    plan: dict[str, Any], provider: str, source_language: str,
    public_settings: dict[str, Any],
) -> str:
    config = public_settings.get("providers", {}).get(provider, {})
    canonical = {
        "provider": provider,
        "source_language": source_language,
        "model": config.get("model", "") if provider != "free" else "",
        "base_url": config.get("base_url", "") if provider != "free" else "",
        "keys": plan["keys"],
        "texts": [call["text"] for call in plan["calls"]],
    }
    encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def plan_preview(
    plan: dict[str, Any], provider: str, source_language: str,
    public_settings: dict[str, Any],
) -> dict[str, Any]:
    requests: list[dict[str, Any]] = []
    system_prompt = ""
    for call_index, call in enumerate(plan["calls"], start=1):
        view = translation_request_view(call["text"], source_language, provider)
        system_prompt = system_prompt or view["systemPrompt"]
        for text in view["texts"]:
            requests.append({
                "index": len(requests) + 1, "call": call_index,
                "text": text, "characters": len(text),
            })
    config = public_settings.get("providers", {}).get(provider, {})
    if provider == "free":
        label = "سرویس رایگان — Google Translate؛ هنگام خطا MyMemory"
        note = "هر query ابتدا به Google Translate می‌رود؛ فقط اگر خطا بدهد، همان query به MyMemory فرستاده می‌شود."
    else:
        label = AI_PROVIDERS.get(provider, {}).get("label", provider)
        note = "اگر کلیدی خطا بدهد، همین متن با کلید بعدی همان سرویس تکرار می‌شود؛ متن به سرویس دیگری نمی‌رود."
    return {
        "provider": provider,
        "providerLabel": label,
        "model": config.get("model", "") if provider != "free" else "",
        "base_url": config.get("base_url", "") if provider != "free" else "https://translate.googleapis.com/translate_a/single",
        "fallback_url": "https://api.mymemory.translated.net/get" if provider == "free" else "",
        "blockCount": len(plan["source_texts"]),
        "requestCount": len(requests),
        "requests": requests,
        "systemPrompt": system_prompt,
        "note": note,
        "signature": plan_signature(plan, provider, source_language, public_settings),
    }
