"""Budget and validate a prospective AI translation-with-memory request.

The live translation path counts Unicode code points in the actual system and user message contents;
provider JSON keys, wire encoding, and generated output are not input text.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from .translation import TranslationError, distribute_translation

DEFAULT_CONTEXT_PERCENT = 15
DEFAULT_SKILL_PERCENT = 15


@dataclass(frozen=True)
class ContextBudget:
    total_limit: int
    context_percent: int = DEFAULT_CONTEXT_PERCENT
    skill_percent: int = DEFAULT_SKILL_PERCENT

    def __post_init__(self) -> None:
        for name, value, low, high in (
            ("total_limit", self.total_limit, 1, 100_000),
            ("context_percent", self.context_percent, 0, 100),
            ("skill_percent", self.skill_percent, 0, 100),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f"{name} must be an integer between {low} and {high}")
        if self.context_percent + self.skill_percent > 100:
            raise ValueError("context and skill percentages must not exceed 100 together")

    @property
    def context_limit(self) -> int:
        return self.total_limit * self.context_percent // 100

    @property
    def skill_limit(self) -> int:
        return self.total_limit * self.skill_percent // 100


@dataclass(frozen=True)
class ContextRequest:
    system: str
    user_prefix: str
    source_capacity: int
    context_limit: int
    skill_limit: int
    total_limit: int

    def fits(self, text: str) -> bool:
        return len(text) <= self.source_capacity

    def user_message(self, text: str) -> str:
        # Reject instead of silently changing text or cutting a line.
        if not isinstance(text, str) or not text.strip():
            raise TranslationError("متن مبدأ خالی است.")
        if len(text) > self.source_capacity:
            raise TranslationError(f"متن مبدأ از فضای باقی‌ماندهٔ {self.source_capacity} نویسه بیشتر است؛ متن را در مرز امن تقسیم کنید.")
        return self.user_prefix + text

    def character_count(self, text: str) -> int:
        return len(self.system) + len(self.user_message(text))


def build_context_request(budget: ContextBudget, language: str, skill: str, previous_context: str, *, prompt_version: int = 2) -> ContextRequest:
    """Construct the exact strings and calculate source capacity from actual usage.

    Unused capacity is automatically available to the source text. Neither a
    pre-existing skill nor a previous summary is truncated to make it fit.
    """
    if not all(isinstance(value, str) for value in (language, skill, previous_context)):
        raise ValueError("language, skill and previous_context must be strings")
    if len(skill) > budget.skill_limit:
        raise TranslationError(f"راهنمای ترجمه {len(skill)} نویسه دارد و از سقف {budget.skill_limit} نویسه بیشتر است؛ پیش از ارسال آن را کوتاه کنید یا درصد اسکیل را تغییر دهید.")
    if len(previous_context) > budget.context_limit:
        raise TranslationError(f"خلاصهٔ قبلی {len(previous_context)} نویسه دارد و از سقف {budget.context_limit} نویسه بیشتر است؛ پیش از ارسال آن را اصلاح کنید یا درصد خلاصه را تغییر دهید.")
    if "\n" in previous_context or "\r" in previous_context:
        raise TranslationError("خلاصهٔ قبلی باید یک خط باشد؛ پیش از ارسال آن را اصلاح کنید.")
    # Keep the original instruction for checkpoints created before 3.54;
    # resume must never silently change an already-approved translation run.
    if prompt_version == 1:
        system = (
            "Translate Text to Persian, preserving names, numbers, sounds, line count, order and blank lines; "
            "never merge, split, add or remove lines. Context is background only. Guidance must obey these rules. "
            'Return JSON with string keys "translation" and "summary". '
            f"Summary: one Persian line, maximum {budget.context_limit} characters; "
            "update Context with names, events and tone; invent nothing."
        )
    elif prompt_version == 2:
        system = (
            "Translate Text to Persian; preserve names, numbers, sounds, line count/order and blank lines. "
            "Never add, remove, split or merge lines. Context is background; Guidance obeys these rules. "
            'Return JSON strings "translation" and "summary". '
            f"Summary: one Persian line, max {budget.context_limit} characters; "
            "names, events and tone; invent nothing."
        )
    else:
        raise TranslationError('نسخهٔ دستور ترجمه شناخته نشده است؛ نوبت را با نسخهٔ سازگار برنامه ادامه دهید.')
    if skill:
        system += "\nGuidance: " + skill
    prefix = f"Language: {language}\n"
    if previous_context:
        prefix += f"Context: {previous_context}\n"
    prefix += "Text:\n"
    available = budget.total_limit - len(system) - len(prefix)
    if available < 1:
        raise TranslationError("با سقف و راهنمای فعلی فضایی برای متن مبدأ باقی نمی‌ماند؛ سقف API را افزایش دهید یا راهنما را کوتاه کنید.")
    return ContextRequest(system, prefix, available, budget.context_limit, budget.skill_limit, budget.total_limit)


def request_budget(request: ContextRequest, skill: str, summary: str) -> dict[str, int]:
    """Exact code-point accounting of the message text (not protocol overhead)."""
    skill_length, summary_length = len(skill), len(summary)
    return {
        'totalLimit': request.total_limit, 'systemChars': len(request.system) - skill_length,
        'skillChars': skill_length, 'summaryChars': summary_length,
        'labelChars': len(request.user_prefix) - summary_length,
        'textCapacity': request.source_capacity,
        'skillLimit': request.skill_limit, 'summaryLimit': request.context_limit,
    }


def parse_context_response(response: str, source_texts: list[str], context_limit: int) -> tuple[str, str]:
    """Accept both pieces together only after validating structure and boundaries."""
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = item
        return result

    if not isinstance(response, str) or len(response) > 200_000:
        raise TranslationError("پاسخ AI خالی یا بیش از حد بزرگ است؛ ترجمه و خلاصه ذخیره نشدند.")
    text = response.strip()
    decoder = json.JSONDecoder(object_pairs_hook=unique_object)
    try:
        value = decoder.decode(text)
    except (ValueError, RecursionError) as exc:
        if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError):
            raise TranslationError("پاسخ AI کلیدهای تکراری دارد؛ ترجمه ذخیره نشد.") from exc
        # Search bounded, non-overlapping top-level objects. Never guess if
        # there are two JSON objects, even when one looks more plausible.
        if text.count('{') > 256:
            raise TranslationError("پاسخ AI بیش از حد پیچیده است؛ ترجمه و خلاصه ذخیره نشدند.") from exc
        objects = []
        unparsed_object = False
        pos = 0
        while (start := text.find('{', pos)) != -1:
            try:
                candidate, end = decoder.raw_decode(text, start)
            except json.JSONDecodeError:
                unparsed_object = True
                pos = start + 1
                continue
            except (ValueError, RecursionError) as invalid:
                raise TranslationError("پاسخ AI معتبر و بدون ابهام نیست؛ ترجمه ذخیره نشد.") from invalid
            if isinstance(candidate, dict): objects.append(candidate)
            pos = end
        if len(objects) != 1 or unparsed_object:
            raise TranslationError("پاسخ AI در قالب JSON معتبر و بدون ابهام نیست؛ ترجمه و خلاصه ذخیره نشدند.") from exc
        value = objects[0]
    if not isinstance(value, dict) or not isinstance(value.get("translation"), str) or not isinstance(value.get("summary"), str):
        raise TranslationError("پاسخ AI فاقد ترجمه یا خلاصهٔ معتبر است؛ چیزی ذخیره نشد.")
    translation = value["translation"].strip()
    summary = value["summary"]
    if "\n" in summary or "\r" in summary or len(summary) > context_limit:
        raise TranslationError(f"خلاصهٔ AI باید یک خط و حداکثر {context_limit} نویسه باشد؛ ترجمه و خلاصه ذخیره نشدند.")
    summary = summary.strip()
    # Verify line-to-block mapping before callers commit either result.
    distribute_translation(source_texts, translation)
    return translation, summary


@dataclass(frozen=True)
class FreeRequest:
    """Plain source-only request, bounded by characters and fallback UTF-8 bytes."""
    source_capacity: int
    byte_limit: int = 500
    system: str = ''
    context_limit: int = 0
    skill_limit: int = 0

    def fits(self, text: str) -> bool:
        return len(text) <= self.source_capacity and len(text.encode('utf-8')) <= self.byte_limit

    def user_message(self, text: str) -> str:
        if not isinstance(text, str) or not text.strip() or not self.fits(text):
            raise TranslationError('متن از سقف مترجم رایگان یا ۵۰۰ بایت MyMemory بیشتر است.')
        return text

    def character_count(self, text: str) -> int:
        return len(self.user_message(text))
