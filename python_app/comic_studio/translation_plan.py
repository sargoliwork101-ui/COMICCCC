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
AI_REUSE_KEY = "_aiReusedTranslation"


def split_ai_paragraph(text: str, limit: int = MAX_AI_SOURCE_CHARS) -> tuple[list[str], list[str]]:
    """Split oversized paragraphs at sentence/whitespace boundaries, preserving joins."""
    remaining = str(text).strip(); parts: list[str] = []; joins: list[str] = []
    while len(remaining) > limit:
        # Avoid producing an almost-empty final chunk when a long block is
        # only slightly over the limit. Keep sentence/space boundaries where possible.
        count = (len(remaining) + limit - 1) // limit
        target = (len(remaining) + count - 1) // count
        window = remaining[:target]
        ends = list(re.finditer(r"[.!?…。！？][\"'”’»)]*(?=\s|$)", window))
        cut = ends[-1].end() if ends else 0
        if cut < target // 3:
            cut = max(window.rfind("\n"), window.rfind(" "), window.rfind("\t"))
        if cut <= 0:
            cut = target
        part = remaining[:cut].rstrip()
        if not part:
            cut = target; part = remaining[:cut]
        rest = remaining[len(part):]
        whitespace = re.match(r"\s*", rest).group(0)
        parts.append(part); joins.append("\n" if "\n" in whitespace else (" " if whitespace else ""))
        remaining = rest[len(whitespace):]
    if remaining:
        parts.append(remaining)
    return parts, joins


def target_snapshot(block: dict[str, Any]) -> str:
    target = {k: v for k, v in block.items() if k not in {AI_PARTS_KEY, AI_REUSE_KEY}}
    return hashlib.sha256(json.dumps(target, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def reuse_fingerprint(block: dict[str, Any], source: str, provider: str, language: str, settings: dict[str, Any]) -> str:
    config = settings.get("providers", {}).get(provider, {})
    value = [provider, language, config.get("model", ""), config.get("base_url", ""), source, target_snapshot(block)]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def has_reused_translation(block: dict[str, Any], source: str, provider: str, language: str, settings: dict[str, Any]) -> bool:
    marker = block.get(AI_REUSE_KEY)
    return bool(block.get("tr")) and isinstance(marker, dict) and marker.get("fingerprint") == reuse_fingerprint(block, source, provider, language, settings)


def mark_reused_translation(block: dict[str, Any], source: str, provider: str, language: str, settings: dict[str, Any]) -> None:
    block[AI_REUSE_KEY] = {"fingerprint": reuse_fingerprint(block, source, provider, language, settings)}


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
    # All duplicate destinations are confirmed too, so a concurrent edit cannot
    # silently be overwritten by propagation of a reused translation.
    indices = list(dict.fromkeys(i for group in call.get("targets", [[i] for i in call["indices"]]) for i in group))
    return {"keys": [plan["keys"][i] for i in indices], "source_texts": [plan["source_texts"][i] for i in indices],
            "target_snapshots": [plan["target_snapshots"][i] for i in indices], "reuse_repeated": plan.get("reuse_repeated", False),
            "calls": [{"text": call["text"], "call_id": call.get("call_id", "")}]}


def build_project_plan(state: dict[str, Any], image_ids: list[str], provider: str,
                       reuse_repeated: bool = False, source_language: str = "eng",
                       settings: dict[str, Any] | None = None) -> dict[str, Any]:
    ids = set(image_ids); settings = settings or {}
    items = [item for item in sorted(state["images"], key=lambda entry: entry.get("order", 0)) if item["id"] in ids]
    entries = [(item, block, block_index) for item in items for block_index, block in enumerate(item.get("blocks", []))
               if block.get("enabled", True) and str(block.get("text", "")).strip()]
    blocks = [block for _, block, _ in entries]
    source_texts = [str(block.get("text", "")).strip() for block in blocks]
    owners = [item["id"] for item, _, _ in entries]
    combined_source = combine_translation_texts(source_texts)
    combined_free = provider == "free" and len(combined_source) <= MAX_FREE_QUERY_CHARS
    reuse = bool(reuse_repeated and provider != "free")
    groups: dict[int, list[int]] = {}
    already_reused = 0
    if reuse:
        occurrences: dict[str, list[int]] = {}
        for i, source in enumerate(source_texts):
            occurrences.setdefault(source, []).append(i)
        for source, targets in occurrences.items():
            pending = [i for i in targets if not has_reused_translation(blocks[i], source, provider, source_language, settings)]
            if pending:
                # Re-send when an original/edited occurrence is selected, and
                # propagate the new result to *all* selected copies, even if
                # some were marked as reused by an earlier translation.
                groups[pending[0]] = targets
            else:
                already_reused += len(targets)
    else:
        groups = {i: [i] for i in range(len(source_texts))}

    if not blocks:
        calls: list[dict[str, Any]] = []
    elif provider != "free":
        calls = []
        for item in items:
            indices = [i for i in sorted(groups) if owners[i] == item["id"]]
            if not indices:
                continue
            common = {"image_id": item["id"], "image_name": item.get("name", "")}
            page_text = combine_translation_texts([source_texts[i] for i in indices])
            if len(page_text) <= MAX_AI_SOURCE_CHARS:
                calls.append({**common, "text": page_text, "indices": indices, "targets": [groups[i] for i in indices], "combined": True, "call_id": "page"})
                continue
            pending: list[int] = []
            def flush() -> None:
                if not pending:
                    return
                chunk = list(pending); pending.clear()
                calls.append({**common, "text": combine_translation_texts([source_texts[i] for i in chunk]),
                              "indices": chunk, "targets": [groups[i] for i in chunk], "combined": True,
                              "call_id": f"b{entries[chunk[0]][2]}", "paragraph": entries[chunk[0]][2] + 1})
            for index in indices:
                source = source_texts[index]
                if len(source) > MAX_AI_SOURCE_CHARS:
                    flush()
                    parts, joins = split_ai_paragraph(source)
                    for part_index, part in enumerate(parts):
                        calls.append({**common, "text": part, "indices": [index], "targets": [groups[index]], "combined": False,
                                      "call_id": f"p{entries[index][2]}.{part_index}", "paragraph": entries[index][2] + 1,
                                      "part_index": part_index, "part_count": len(parts), "joins": joins})
                elif pending and len(combine_translation_texts([source_texts[i] for i in pending] + [source])) > MAX_AI_SOURCE_CHARS:
                    flush(); pending.append(index)
                else:
                    pending.append(index)
            flush()
    elif combined_free:
        calls = [{"text": combined_source, "indices": list(range(len(blocks))), "combined": True}]
    else:
        calls = [{"text": text, "indices": [index], "combined": False} for index, text in enumerate(source_texts)]
    return {"items": items, "blocks": blocks, "owner_ids": owners,
            "keys": [f"{item['id']}:{block.get('id', block_index + 1)}" for item, block, block_index in entries],
            "source_texts": source_texts, "target_snapshots": [target_snapshot(block) for block in blocks],
            "calls": calls, "combined_free": combined_free, "reuse_repeated": reuse,
            "duplicate_count": sum(len(v) - 1 for v in groups.values()), "already_reused": already_reused}


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
        # Confirm retry/cost and timeout policy as well as the text and destination.
        "profile_policy": [{"id": p.get("id", ""), "timeout_seconds": p.get("timeout_seconds", 90), "retry_count": p.get("retry_count", 0), "retry_wait_seconds": p.get("retry_wait_seconds", 20), "hasApiKey": p.get("hasApiKey", False)} for p in config.get("profiles", [])] if provider != "free" else [],
        "reuse_repeated": plan.get("reuse_repeated", False),
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
        note = ("کادرهای همان صفحه تا سقف ۱۰۰۰ نویسه در هر درخواست تجمیع می‌شوند؛ کادر بلندتر نیز تقسیم می‌شود. "
                + ("هر پاسخ پیش از درخواست بعد بررسی و ذخیره می‌شود. " if plan["items"] else "بازترجمهٔ یک کادر پس از دریافت همهٔ بخش‌ها ثبت می‌شود. ")
                + "تعداد نمایش‌داده‌شده بدون تکرارهاست؛ تکرار ممکن است هزینه داشته باشد. در برخی خطاها کلید بعدی همان متن را امتحان می‌کند. پس از پایان تکرار خطای ارتباطی، کلید بعدی خودکار امتحان نمی‌شود.")
        if plan.get("reuse_repeated"):
            note += f" تطبیق دقیق فعال است: {plan.get('duplicate_count', 0)} کادر تکراری همراه نخستین نتیجه به‌روزرسانی می‌شود؛ {plan.get('already_reused', 0)} کادر قبلاً به‌روزرسانی شده است. نام فایل‌ها جداگانه به AI ارسال نمی‌شود."
        else:
            note += " استفادهٔ مجدد از متن تکراری خاموش است."
        profiles = [profile for profile in config.get("profiles", []) if profile.get("hasApiKey")]
        if profiles:
            policies = [f"{profile.get('name') or f'API {index}'}: انتظار {profile.get('timeout_seconds', 90)} ثانیه، {profile.get('retry_count', 0)} تکرار با فاصلهٔ {profile.get('retry_wait_seconds', 20)} ثانیه" for index, profile in enumerate(profiles, start=1)]
            note += " تنظیمات: " + "؛ ".join(policies) + "."
    pages = []
    tasks = []
    if provider != "free":
        for item in plan["items"]:
            page_calls = [call for call in plan["calls"] if call.get("image_id") == item["id"]]
            if not page_calls:
                continue
            # A standalone page signature must describe that page on its own,
            # not the cross-page duplicate map used by the multi-page tasks.
            page_plan = build_project_plan({"images": [item]}, [item["id"]], provider,
                                           plan.get("reuse_repeated", False), source_language, public_settings)
            pages.append({"imageId": item["id"], "imageName": item.get("name", ""),
                          "signature": plan_signature(page_plan, provider, source_language, public_settings)})
        for call in plan["calls"]:
            if "image_id" not in call or saved_call(call, plan, provider, source_language, public_settings):
                continue
            affected = list(dict.fromkeys(plan["owner_ids"][i] for group in call.get("targets", [[i] for i in call["indices"]]) for i in group))
            tasks.append({"imageId": call["image_id"], "imageName": call["image_name"], "callId": call["call_id"], "affectedImageIds": affected,
                          "paragraph": call.get("paragraph"), "part": call.get("part_index", 0) + 1,
                          "partCount": call.get("part_count", 1),
                          "signature": plan_signature(call_plan(plan, call), provider, source_language, public_settings)})
    return {
        "pages": pages,
        "tasks": tasks,
        "reuseRepeated": plan.get("reuse_repeated", False),
        "duplicateCount": plan.get("duplicate_count", 0),
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
