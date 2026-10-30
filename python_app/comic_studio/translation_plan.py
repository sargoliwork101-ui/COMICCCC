"""Shared translation request planning, exact previews, and confirmation signatures."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .translation import (
    AI_PROVIDERS, MAX_FREE_QUERY_CHARS, combine_translation_texts,
    translation_request_view,
)


MAX_AI_SOURCE_CHARS = 1000
AI_PARTS_KEY = "_aiTranslationParts"
AI_PAGE_PROGRESS_KEY = "_aiPageProgress"


def split_ai_paragraph(text: str, limit: int = MAX_AI_SOURCE_CHARS) -> tuple[list[str], list[str]]:
    """Split oversized paragraphs at sentence/whitespace boundaries, preserving joins."""
    remaining = str(text).strip(); parts: list[str] = []; joins: list[str] = []
    while len(remaining) > limit:
        window = remaining[:limit]
        ends = list(re.finditer(r"[.!?…。！？][\"'”’»)]*(?=\s|$)", window))
        cut = ends[-1].end() if ends else 0
        if cut < limit // 3:
            cut = max(window.rfind("\n"), window.rfind(" "), window.rfind("\t"))
        if cut <= 0:
            cut = limit
        part = remaining[:cut].rstrip()
        if not part:
            cut = limit; part = remaining[:cut]
        rest = remaining[len(part):]
        whitespace = re.match(r"\s*", rest).group(0)
        parts.append(part); joins.append("\n" if "\n" in whitespace else (" " if whitespace else ""))
        remaining = rest[len(whitespace):]
    if remaining:
        parts.append(remaining)
    return parts, joins


def target_snapshot(block: dict[str, Any]) -> str:
    target = {k: v for k, v in block.items() if k != AI_PARTS_KEY}
    return hashlib.sha256(json.dumps(target, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def part_fingerprint(call: dict[str, Any], plan: dict[str, Any], provider: str, language: str, settings: dict[str, Any]) -> str:
    config = settings.get("providers", {}).get(provider, {})
    index = call["indices"][0]
    payload = [provider, language, config.get("model", ""), config.get("base_url", ""), plan["keys"][index],
               plan["source_texts"][index], plan["target_snapshots"][index]]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def saved_part(call: dict[str, Any], plan: dict[str, Any], provider: str, language: str, settings: dict[str, Any]) -> bool:
    if call.get("part_count", 1) <= 1:
        return False
    saved = plan["blocks"][call["indices"][0]].get(AI_PARTS_KEY) or {}
    return (isinstance(saved, dict) and saved.get("fingerprint") == part_fingerprint(call, plan, provider, language, settings)
            and isinstance(saved.get("parts"), dict) and bool(saved["parts"].get(str(call["part_index"]))))


def page_fingerprint(call: dict[str, Any], plan: dict[str, Any], provider: str, language: str, settings: dict[str, Any]) -> str:
    config = settings.get("providers", {}).get(provider, {})
    indices = sorted({i for c in plan["calls"] if c.get("image_id") == call["image_id"] for i in c["indices"]})
    payload = [provider, language, config.get("model", ""), config.get("base_url", ""), call["image_id"],
               [plan["keys"][i] for i in indices], [plan["source_texts"][i] for i in indices]]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def page_item(call: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    return next(item for item in plan["items"] if item["id"] == call["image_id"])


def saved_call(call: dict[str, Any], plan: dict[str, Any], provider: str, language: str, settings: dict[str, Any]) -> bool:
    if saved_part(call, plan, provider, language, settings):
        return True
    saved = page_item(call, plan).get(AI_PAGE_PROGRESS_KEY) or {}
    if not isinstance(saved, dict) or saved.get("fingerprint") != page_fingerprint(call, plan, provider, language, settings):
        return False
    done = saved.get("done") or {}
    return isinstance(done, dict) and done.get(call["call_id"]) == [target_snapshot(plan["blocks"][i]) for i in call["indices"]]


def mark_completed_call(call: dict[str, Any], plan: dict[str, Any], provider: str, language: str, settings: dict[str, Any], completed_block: bool) -> None:
    item = page_item(call, plan); fingerprint = page_fingerprint(call, plan, provider, language, settings)
    saved = item.get(AI_PAGE_PROGRESS_KEY)
    if not isinstance(saved, dict) or saved.get("fingerprint") != fingerprint or not isinstance(saved.get("done"), dict):
        saved = {"fingerprint": fingerprint, "done": {}}; item[AI_PAGE_PROGRESS_KEY] = saved
    if completed_block:
        # If a long block just finished, all of its chunks are now represented
        # by the finished translation and can be skipped after an interruption.
        completed = [c for c in plan["calls"] if c.get("image_id") == call["image_id"] and c["indices"] == call["indices"]] if call.get("part_count", 1) > 1 else [call]
        for entry in completed:
            saved["done"][entry["call_id"]] = [target_snapshot(plan["blocks"][i]) for i in entry["indices"]]
    if all(saved_call(entry, plan, provider, language, settings) for entry in plan["calls"] if entry.get("image_id") == call["image_id"]):
        item.pop(AI_PAGE_PROGRESS_KEY, None)


def call_plan(plan: dict[str, Any], call: dict[str, Any]) -> dict[str, Any]:
    indices = call["indices"]
    return {"keys": [plan["keys"][i] for i in indices], "source_texts": [plan["source_texts"][i] for i in indices],
            "target_snapshots": [plan["target_snapshots"][i] for i in indices],
            "calls": [{"text": call["text"], "call_id": call.get("call_id", "")}]}


def build_project_plan(state: dict[str, Any], image_ids: list[str], provider: str) -> dict[str, Any]:
    ids = set(image_ids)
    items = [
        item for item in sorted(state["images"], key=lambda entry: entry.get("order", 0))
        if item["id"] in ids
    ]
    entries = [
        (item, block, block_index)
        for item in items for block_index, block in enumerate(item.get("blocks", []))
        if block.get("enabled", True) and str(block.get("text", "")).strip()
    ]
    blocks = [block for _, block, _ in entries]
    source_texts = [str(block.get("text", "")).strip() for block in blocks]
    combined_source = combine_translation_texts(source_texts)
    combined_free = provider == "free" and len(combined_source) <= MAX_FREE_QUERY_CHARS
    if not blocks:
        calls: list[dict[str, Any]] = []
    elif provider != "free":
        calls = []
        for item in items:
            indices = [index for index, (owner, _, _) in enumerate(entries) if owner is item]
            if not indices:
                continue
            page_text = combine_translation_texts([source_texts[index] for index in indices])
            common = {"image_id": item["id"], "image_name": item.get("name", "")}
            if len(page_text) <= MAX_AI_SOURCE_CHARS:
                calls.append({**common, "text": page_text, "indices": indices, "combined": True, "call_id": "page"})
                continue
            for paragraph, index in enumerate(indices):
                parts, joins = split_ai_paragraph(source_texts[index])
                for part_index, part in enumerate(parts):
                    calls.append({**common, "text": part, "indices": [index], "combined": False,
                                  "call_id": f"p{paragraph}.{part_index}", "paragraph": paragraph + 1,
                                  "part_index": part_index, "part_count": len(parts), "joins": joins})
    elif combined_free:
        calls = [{"text": combined_source, "indices": list(range(len(blocks))), "combined": True}]
    else:
        calls = [{"text": text, "indices": [index], "combined": False} for index, text in enumerate(source_texts)]
    return {
        "items": items,
        "blocks": blocks,
        "keys": [f"{item['id']}:{block.get('id', block_index + 1)}" for item, block, block_index in entries],
        "source_texts": source_texts,
        # Bind confirmation to the exact target blocks too, so edits to a later
        # page after preview are not silently overwritten by its translation.
        "target_snapshots": [target_snapshot(block) for block in blocks],
        "calls": calls,
        "combined_free": combined_free,
    }


def build_single_plan(text: str, provider: str) -> dict[str, Any]:
    clean = str(text or "").strip()
    parts, joins = split_ai_paragraph(clean) if clean and provider != "free" else ([clean] if clean else [], [])
    return {
        "items": [], "blocks": [], "keys": ["single-text"] if clean else [],
        "source_texts": [clean] if clean else [],
        "calls": [{"text": part, "indices": [0], "combined": False, "joins": joins,
                   "part_index": index, "part_count": len(parts)} for index, part in enumerate(parts)],
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
        # Equal joined payloads can have different per-box line boundaries.
        "source_texts": plan["source_texts"],
        "target_snapshots": plan.get("target_snapshots", []),
        "texts": [call["text"] for call in plan["calls"]],
        "call_ids": [call.get("call_id", "") for call in plan["calls"]],
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
        if "image_id" in call and saved_call(call, plan, provider, source_language, public_settings):
            continue
        view = translation_request_view(call["text"], source_language, provider)
        system_prompt = system_prompt or view["systemPrompt"]
        for text in view["texts"]:
            requests.append({
                "index": len(requests) + 1, "call": call_index,
                "text": text, "characters": len(text),
                **({"imageId": call["image_id"], "imageName": call["image_name"], "paragraph": call.get("paragraph"),
                    "part": call.get("part_index", 0) + 1, "partCount": call.get("part_count", 1)} if "image_id" in call else {}),
            })
    config = public_settings.get("providers", {}).get(provider, {})
    if provider == "free":
        label = "سرویس رایگان — Google Translate؛ هنگام خطا MyMemory"
        note = "هر query ابتدا به Google Translate می‌رود؛ فقط اگر خطا بدهد، همان query به MyMemory فرستاده می‌شود."
    else:
        label = AI_PROVIDERS.get(provider, {}).get("label", provider)
        note = ("صفحه‌های بیش از ۱۰۰۰ نویسه کادر به کادر فرستاده می‌شوند؛ کادر بلندتر نیز به بخش‌های حداکثر ۱۰۰۰ نویسه تقسیم می‌شود. "
                + ("هر پاسخ پیش از درخواست بعد بررسی و ذخیره می‌شود. " if plan["items"] else "بازترجمهٔ یک کادر پس از دریافت همهٔ بخش‌ها ثبت می‌شود. ")
                + "در برخی خطاهای سرویس یا پاسخ نامعتبر، کلید بعدی همان متن را تکرار می‌کند؛ در قطع ارتباط یا timeout تکرار خودکار متوقف می‌شود.")
    pages = []
    tasks = []
    if provider != "free":
        for item in plan["items"]:
            page_calls = [call for call in plan["calls"] if call.get("image_id") == item["id"]]
            if not page_calls:
                continue
            indices = sorted({index for call in page_calls for index in call["indices"]})
            page_plan = {"keys": [plan["keys"][i] for i in indices], "source_texts": [plan["source_texts"][i] for i in indices],
                         "target_snapshots": [plan["target_snapshots"][i] for i in indices], "calls": page_calls}
            pages.append({"imageId": item["id"], "imageName": item.get("name", ""),
                          "signature": plan_signature(page_plan, provider, source_language, public_settings)})
        for call in plan["calls"]:
            if "image_id" not in call or saved_call(call, plan, provider, source_language, public_settings):
                continue
            tasks.append({"imageId": call["image_id"], "imageName": call["image_name"], "callId": call["call_id"],
                          "paragraph": call.get("paragraph"), "part": call.get("part_index", 0) + 1,
                          "partCount": call.get("part_count", 1),
                          "signature": plan_signature(call_plan(plan, call), provider, source_language, public_settings)})
    return {
        "pages": pages,
        "tasks": tasks,
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
