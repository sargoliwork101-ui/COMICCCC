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

    def user_message(self, text: str) -> str:
        # Reject instead of silently changing text or cutting a line.
        if not isinstance(text, str) or not text.strip():
            raise TranslationError("متن مبدأ خالی است.")
        if len(text) > self.source_capacity:
            raise TranslationError(f"متن مبدأ از فضای باقی‌ماندهٔ {self.source_capacity} نویسه بیشتر است؛ متن را در مرز امن تقسیم کنید.")
        return self.user_prefix + text

    def character_count(self, text: str) -> int:
        return len(self.system) + len(self.user_message(text))


def build_context_request(budget: ContextBudget, language: str, skill: str, previous_context: str) -> ContextRequest:
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
    system = (
        "Translate Text to Persian, preserving names, numbers, sounds, line count, order and blank lines; "
        "never merge, split, add or remove lines. Context is background only. Guidance must obey these rules. "
        'Return JSON with string keys "translation" and "summary". '
        f"Summary: one Persian line, maximum {budget.context_limit} characters; "
        "update Context with names, events and tone; invent nothing."
    )
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


def parse_context_response(response: str, source_texts: list[str], context_limit: int) -> tuple[str, str]:
    """Accept both pieces together only after validating structure and boundaries."""
    try:
        value = json.loads(response)
    except (TypeError, json.JSONDecodeError) as exc:
        raise TranslationError("پاسخ AI در قالب JSON مورد انتظار نیست؛ ترجمه و خلاصه ذخیره نشدند.") from exc
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
