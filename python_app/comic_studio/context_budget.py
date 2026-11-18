"""Budget and validate a prospective AI translation-with-memory request.

The live translation path counts Unicode code points in the actual system and user message contents;
provider JSON keys, wire encoding, and generated output are not input text.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .translation import (
    TranslationError,
    distribute_translation,
    normalize_target_language,
    normalize_translation_text,
    target_language_english_name,
)

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
            raise ValueError("درصد زمینهٔ داستان و درصد اسکیل باید روی‌هم بیشتر از ۱۰۰ نباشند.")

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

    @staticmethod
    def line_count_instruction(text: str) -> str:
        line_count = len(text.split("\n"))
        unit = "line" if line_count == 1 else "lines"
        return f"Source has {line_count} {unit}; output exactly {line_count} {unit}.\n"

    def fits(self, text: str) -> bool:
        return isinstance(text, str) and len(text) + len(self.line_count_instruction(text)) <= self.source_capacity

    def user_message(self, text: str) -> str:
        # State the exact count for this chunk in every request; model-level
        # system instructions alone are often ignored. Count this directive
        # against the same API character budget as all other message text.
        if not isinstance(text, str) or not text.strip():
            raise TranslationError("متن مبدأ خالی است.")
        if not self.fits(text):
            raise TranslationError(f"متن مبدأ و دستور تعداد خطوط از فضای باقی‌ماندهٔ {self.source_capacity} نویسه بیشتر است؛ متن را در مرز امن تقسیم کنید.")
        marker = "Text:\n"
        base = self.user_prefix[:-len(marker)] if self.user_prefix.endswith(marker) else self.user_prefix
        return base + self.line_count_instruction(text) + marker + text

    def character_count(self, text: str) -> int:
        return len(self.system) + len(self.user_message(text))


def build_context_request(
    budget: ContextBudget,
    language: str,
    skill: str,
    previous_context: str,
    *,
    target_language: str = "fa",
) -> ContextRequest:
    """Construct the exact strings and calculate source capacity from actual usage.

    Unused capacity is automatically available to the source text. Neither a
    pre-existing skill nor a previous summary is truncated to make it fit.
    """
    if not all(isinstance(value, str) for value in (language, skill, previous_context)):
        raise ValueError("زبان، اسکیل و زمینهٔ قبلی باید متن باشند.")
    if len(skill) > budget.skill_limit:
        raise TranslationError(f"راهنمای ترجمه {len(skill)} نویسه دارد و از سقف {budget.skill_limit} نویسه بیشتر است؛ پیش از ارسال آن را کوتاه کنید یا درصد اسکیل را تغییر دهید.")
    if len(previous_context) > budget.context_limit:
        raise TranslationError(f"خلاصهٔ قبلی {len(previous_context)} نویسه دارد و از سقف {budget.context_limit} نویسه بیشتر است؛ پیش از ارسال آن را اصلاح کنید یا درصد خلاصه را تغییر دهید.")
    if "\n" in previous_context or "\r" in previous_context:
        raise TranslationError("خلاصهٔ قبلی باید یک خط باشد؛ پیش از ارسال آن را اصلاح کنید.")
    target_name = target_language_english_name(normalize_target_language(target_language))
    system = (
        f"Translate to {target_name}; preserve names/terms/numbers/sounds. JSON keys: \"translation\", \"summary\". "
        "CRITICAL: translation line count/order must exactly match Text, one output line per input line. "
        "Add no lines, breaks, headings or commentary; verify count. "
        f"Summary: one {target_name} line, max {budget.context_limit} chars incl spaces; shorten to fit. "
        "Both JSON values must be plain string."
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


def shorten_context(text: str, limit: int) -> str:
    """Normalize a one-line context and cap it on a nearby word boundary."""
    text = " ".join(str(text or "").split()).strip()
    if len(text) <= limit:
        return text
    text = text[:limit]
    word_boundary = text.rfind(" ")
    if word_boundary >= limit * 0.7:
        text = text[:word_boundary]
    return text.rstrip()


_REASONING_TAG_RE = re.compile(r"<(?:think|thinking)\b[^>]*>.*?</(?:think|thinking)\s*>", re.IGNORECASE | re.DOTALL)
_WRAPPER_DICT_KEYS = {"result", "output", "data", "response"}
_TRANSLATION_ALIAS_KEYS = ("translations", "translated_text", "translated", "persian_translation", "english_translation", "target_translation", "persian", "fa", "lines")
_SUMMARY_ALIAS_KEYS = ("story_summary", "context_summary", "context", "memory")
_ITEM_TEXT_KEYS = ("translation", "translated_text", "translated", "persian", "fa", "en", "text", "line")


def _normalize_translation_field(raw: object) -> str | None:
    if isinstance(raw, str):
        return normalize_translation_text(raw)
    if isinstance(raw, list) and raw:
        if all(isinstance(item, str) for item in raw):
            return "\n".join(normalize_translation_text(item) for item in raw)
        if all(isinstance(item, dict) for item in raw):
            extracted: list[str] = []
            for item in raw:
                lower_map = {str(k).strip().lower(): v for k, v in item.items()}
                picked: object = None
                for candidate_key in _ITEM_TEXT_KEYS:
                    if candidate_key in lower_map:
                        picked = lower_map[candidate_key]
                        break
                if not isinstance(picked, str):
                    return None
                extracted.append(normalize_translation_text(picked))
            return "\n".join(extracted)
    return None


def _normalize_summary_field(raw: object) -> str | None:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list) and all(isinstance(item, str) for item in raw):
        return " ".join(item.strip() for item in raw if item.strip())
    return None


def _extract_context_fields(value: dict[str, object]) -> tuple[str, str]:
    current: dict[str, object] = value
    for _ in range(2):
        lower_keys = {str(k).strip().lower() for k in current}
        if "translation" in lower_keys or any(alias in lower_keys for alias in _TRANSLATION_ALIAS_KEYS):
            break
        if len(current) == 1:
            sole_key, sole_val = next(iter(current.items()))
            if isinstance(sole_val, dict) and str(sole_key).strip().lower() in _WRAPPER_DICT_KEYS:
                current = sole_val
                continue
        break

    # Resolve translation field (exact -> case-insensitive -> single unambiguous alias).
    has_translation = False
    raw_translation: object = None
    if "translation" in current:
        has_translation = True
        raw_translation = current["translation"]
    else:
        ci_matches = [k for k in current if str(k).strip().lower() == "translation"]
        if len(ci_matches) == 1:
            has_translation = True
            raw_translation = current[ci_matches[0]]
        elif len(ci_matches) == 0:
            alias_matches = [k for k in current if str(k).strip().lower() in _TRANSLATION_ALIAS_KEYS]
            if len(alias_matches) == 1:
                has_translation = True
                raw_translation = current[alias_matches[0]]

    # Resolve summary field (exact -> case-insensitive -> single unambiguous alias -> omitted => "").
    raw_summary: object = None
    if "summary" in current:
        raw_summary = current["summary"]
    else:
        ci_sum = [k for k in current if str(k).strip().lower() == "summary"]
        if len(ci_sum) == 1:
            raw_summary = current[ci_sum[0]]
        elif len(ci_sum) > 1:
            raise TranslationError("پاسخ AI کلیدهای خلاصهٔ مبهم دارد؛ چیزی ذخیره نشد.")
        else:
            alias_sum = [k for k in current if str(k).strip().lower() in _SUMMARY_ALIAS_KEYS]
            if len(alias_sum) == 1:
                raw_summary = current[alias_sum[0]]

    if not has_translation:
        raise TranslationError("پاسخ AI فاقد ترجمه یا خلاصهٔ معتبر است؛ چیزی ذخیره نشد.")
    translation = _normalize_translation_field(raw_translation)
    summary = _normalize_summary_field(raw_summary)
    if translation is None or summary is None:
        raise TranslationError("پاسخ AI فاقد ترجمه یا خلاصهٔ معتبر است؛ چیزی ذخیره نشد.")
    return translation, summary


def parse_context_response(response: str, source_texts: list[str], context_limit: int) -> tuple[str, str]:
    """Accept both pieces together only after validating structure and boundaries."""
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("کلید تکراری در پاسخ JSON وجود دارد.")
            result[key] = item
        return result

    if not isinstance(response, str) or len(response) > 200_000:
        raise TranslationError("پاسخ AI خالی یا بیش از حد بزرگ است؛ ترجمه و خلاصه ذخیره نشدند.")
    text = response.strip()
    stripped_reasoning = _REASONING_TAG_RE.sub("", text).strip()
    if stripped_reasoning:
        text = stripped_reasoning
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
    if not isinstance(value, dict):
        raise TranslationError("پاسخ AI فاقد ترجمه یا خلاصهٔ معتبر است؛ چیزی ذخیره نشد.")
    raw_translation, raw_summary = _extract_context_fields(value)
    translation = raw_translation.strip()
    # The prompt asks the model to obey this exact dynamic budget, but model
    # output is not guaranteed. Normalize it locally so an overlong summary
    # cannot discard an otherwise valid translation or consume the next request's
    # budget. Prefer a whole-word boundary when one is close to the cap.
    summary = shorten_context(raw_summary, context_limit)
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


@dataclass(frozen=True)
class LocalRequest:
    """Plain source-only request for offline local NMT (character-bounded, no 500-byte MyMemory cap)."""
    source_capacity: int
    system: str = ''
    context_limit: int = 0
    skill_limit: int = 0

    def fits(self, text: str) -> bool:
        return isinstance(text, str) and len(text) <= self.source_capacity

    def user_message(self, text: str) -> str:
        if not isinstance(text, str) or not text.strip() or not self.fits(text):
            raise TranslationError('متن از سقف نویسهٔ مترجم آفلاین بیشتر است.')
        return text

    def character_count(self, text: str) -> int:
        return len(self.user_message(text))

