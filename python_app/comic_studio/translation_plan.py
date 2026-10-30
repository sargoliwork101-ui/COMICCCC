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
        (item, block)
        for item in items for block in item.get("blocks", [])
        if block.get("enabled", True) and str(block.get("text", "")).strip()
    ]
    blocks = [block for _, block in entries]
    source_texts = [str(block.get("text", "")).strip() for block in blocks]
    combined_source = combine_translation_texts(source_texts)
    combined_free = provider == "free" and len(combined_source) <= MAX_FREE_QUERY_CHARS
    if not blocks:
        calls: list[dict[str, Any]] = []
    elif combined_free or provider != "free":
        calls = [{"text": combined_source, "indices": list(range(len(blocks))), "combined": True}]
    else:
        calls = [{"text": text, "indices": [index], "combined": False} for index, text in enumerate(source_texts)]
    return {
        "items": items,
        "blocks": blocks,
        "keys": [f"{item['id']}:{block.get('id', index + 1)}" for index, (item, block) in enumerate(entries)],
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
        # Equal joined payloads can have different per-box line boundaries.
        "source_texts": plan["source_texts"],
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
