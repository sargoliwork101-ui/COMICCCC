"""Shared translation request planning, exact previews, and confirmation signatures."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .translation import (
    AI_PROVIDERS, MAX_FREE_QUERY_CHARS, combine_translation_texts,
    translation_request_view,
)


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
        # One request per image, in page order; never mix separate pages.
        calls = []
        for item in items:
            indices = [index for index, (owner, _, _) in enumerate(entries) if owner is item]
            if indices:
                calls.append({"text": combine_translation_texts([source_texts[index] for index in indices]),
                              "indices": indices, "combined": True,
                              "image_id": item["id"], "image_name": item.get("name", "")})
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
        "target_snapshots": [hashlib.sha256(json.dumps(block, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest() for block in blocks],
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
        # Equal joined payloads can have different per-box line boundaries.
        "source_texts": plan["source_texts"],
        "target_snapshots": plan.get("target_snapshots", []),
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
                **({"imageId": call["image_id"], "imageName": call["image_name"]} if "image_id" in call else {}),
            })
    config = public_settings.get("providers", {}).get(provider, {})
    if provider == "free":
        label = "سرویس رایگان — Google Translate؛ هنگام خطا MyMemory"
        note = "هر query ابتدا به Google Translate می‌رود؛ فقط اگر خطا بدهد، همان query به MyMemory فرستاده می‌شود."
    else:
        label = AI_PROVIDERS.get(provider, {}).get("label", provider)
        note = "هر درخواست فقط متن یک صفحه است؛ پاسخ هر صفحه بررسی و ذخیره می‌شود و سپس صفحهٔ بعد ارسال می‌شود. در برخی خطاهای سرویس یا پاسخ نامعتبر، کلید بعدی همان صفحه را تکرار می‌کند؛ در قطع ارتباط یا timeout تکرار خودکار متوقف می‌شود."
    # The browser sends one page per HTTP request; each signature binds exactly
    # the page payload and current destination shown in the full preview.
    pages = []
    if provider != "free":
        for call in plan["calls"]:
            if "image_id" not in call:
                continue
            indices = call["indices"]
            page_plan = {"keys": [plan["keys"][i] for i in indices],
                         "source_texts": [plan["source_texts"][i] for i in indices],
                         "target_snapshots": [plan["target_snapshots"][i] for i in indices],
                         "calls": [{"text": call["text"]}]}
            pages.append({"imageId": call["image_id"], "imageName": call["image_name"],
                          "signature": plan_signature(page_plan, provider, source_language, public_settings)})
    return {
        "pages": pages,
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
