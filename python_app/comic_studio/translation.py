from __future__ import annotations

import html
import json
import os
import re
from typing import Any

import httpx

from .ocr import LANGUAGES
from .paths import data_dir
from .store import atomic_json, read_json

DEFAULTS = {
    "provider": "free",
    "base_url": "https://api.avalai.ir/v1",
    "model": "gpt-6-luna",
}


class TranslationError(RuntimeError):
    pass


# U+241E SYMBOL FOR RECORD SEPARATOR: one visible-to-the-provider, non-linguistic
# character that is reserved for internal boundaries and removed before display.
TRANSLATION_SEPARATOR = "\u241e"


def combine_translation_texts(source_texts: list[str]) -> str:
    """Combine all blocks with unambiguous boundaries in one provider payload."""
    return f"\n{TRANSLATION_SEPARATOR}\n".join(
        str(source or "").replace(TRANSLATION_SEPARATOR, " ").strip() for source in source_texts
    )


def distribute_translation(source_texts: list[str], translated: str) -> list[str]:
    """Split only at our separators; never guess or report a false successful mapping."""
    count = len(source_texts)
    text = str(translated or "").strip()
    if not count:
        return []
    if count == 1:
        result = text.replace(TRANSLATION_SEPARATOR, "").strip()
        if not result:
            raise TranslationError("مترجم پاسخ خالی برگرداند؛ متن در کادر قرار نگرفت.")
        return [result]
    if TRANSLATION_SEPARATOR not in text:
        raise TranslationError("جداکنندهٔ داخلی در پاسخ مترجم وجود ندارد؛ تقسیم متن انجام نشد.")
    parts = [part.strip() for part in text.split(TRANSLATION_SEPARATOR)]
    if len(parts) != count:
        raise TranslationError(
            f"تعداد جداکننده‌های پاسخ مترجم درست نیست؛ {count} بخش لازم بود اما {len(parts)} بخش رسید."
        )
    if any(not part for part in parts):
        raise TranslationError("بخشی از پاسخ مترجم بین جداکننده‌ها خالی است؛ ترجمهٔ ناقص در کادرها قرار نگرفت.")
    return parts


_ENCODED_LINE_BREAK = re.compile(r"&(?:amp;)?#(?:0*10|0*13|x0*a|x0*d);?", re.IGNORECASE)
_ENCODED_TRANSLATION_SEPARATOR = re.compile(r"&(?:amp;)?#(?:0*9246|x0*241e);?", re.IGNORECASE)


def normalize_translation_text(value: Any) -> str:
    """Decode provider-escaped text so entities never become visible overlay content."""
    text = _ENCODED_TRANSLATION_SEPARATOR.sub(TRANSLATION_SEPARATOR, str(value or ""))
    text = _ENCODED_LINE_BREAK.sub("\n", text)
    text = html.unescape(text)
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


class TranslationService:
    def __init__(self) -> None:
        self.path = data_dir() / "ai-settings.json"

    def public_settings(self) -> dict[str, Any]:
        stored = read_json(self.path, {})
        return {**DEFAULTS, "provider": stored.get("provider", "free"),
                "base_url": stored.get("base_url", DEFAULTS["base_url"]),
                "model": stored.get("model", DEFAULTS["model"]),
                "hasApiKey": bool(stored.get("api_key"))}

    def save_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        current = read_json(self.path, {})
        provider = values.get("provider", current.get("provider", "free"))
        if provider not in {"free", "openai"}:
            raise ValueError("Unknown translation provider")
        next_value = {
            "provider": provider,
            "base_url": str(values.get("base_url", current.get("base_url", DEFAULTS["base_url"]))).rstrip("/"),
            "model": str(values.get("model", current.get("model", DEFAULTS["model"]))),
            "api_key": current.get("api_key", ""),
        }
        supplied_key = values.get("api_key")
        if supplied_key == "__clear__":
            next_value["api_key"] = ""
        elif isinstance(supplied_key, str) and supplied_key.strip():
            next_value["api_key"] = supplied_key.strip()
        if not next_value["base_url"].startswith(("https://", "http://")):
            raise ValueError("Invalid API base URL")
        atomic_json(self.path, next_value)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        return self.public_settings()

    def _secret(self) -> dict[str, Any]:
        return {**DEFAULTS, **read_json(self.path, {})}

    def translate(self, text: str, source_language: str, provider: str | None = None) -> str:
        text = str(text or "").strip()
        if not text:
            return ""
        settings = self._secret()
        selected = provider or settings.get("provider", "free")
        if selected == "free":
            translated = self._free(text, source_language)
        elif selected == "openai":
            translated = self._openai(text, source_language, settings)
        else:
            raise TranslationError("Unknown translation provider")
        return normalize_translation_text(translated)

    def _free(self, text: str, source_language: str) -> str:
        source = LANGUAGES.get(source_language, LANGUAGES["eng"])["source"]
        errors = []
        with httpx.Client(timeout=35, follow_redirects=True) as client:
            try:
                response = client.get(
                    "https://translate.googleapis.com/translate_a/single",
                    params={"client": "gtx", "sl": source, "tl": "fa", "dt": "t", "q": text},
                )
                response.raise_for_status()
                payload = response.json()
                translated = "".join(part[0] or "" for part in (payload[0] or [])).strip()
                if translated:
                    return translated
            except Exception as exc:
                errors.append(str(exc))
            try:
                response = client.get(
                    "https://api.mymemory.translated.net/get",
                    params={"q": text, "langpair": f"{source.split('-')[0]}|fa"},
                )
                response.raise_for_status()
                translated = str(response.json().get("responseData", {}).get("translatedText", "")).strip()
                if translated and "MYMEMORY WARNING" not in translated.upper():
                    return translated
            except Exception as exc:
                errors.append(str(exc))
        raise TranslationError("Free translation failed: " + "; ".join(errors[-2:]))

    def _openai(self, text: str, source_language: str, settings: dict[str, Any]) -> str:
        if not settings.get("api_key"):
            raise TranslationError("API key is not configured")
        source = LANGUAGES.get(source_language, LANGUAGES["eng"])["name"]
        payload = {
            "model": settings["model"],
            "messages": [
                {"role": "system", "content": (
                    "Translate the entire input to natural Persian using all paragraphs and comic bubbles together as shared context. "
                    "Translate each paragraph or bubble as one continuous unit, not as isolated lines. "
                    "Keep the original order and preserve names, numbers and sound effects. "
                    f"The {TRANSLATION_SEPARATOR} character is an internal record separator, not source text. "
                    f"Keep every {TRANSLATION_SEPARATOR} exactly unchanged, on its own line, and in the original order; never translate, remove, add, or duplicate it. "
                    "Return only the translation and the original separators, without adding labels, numbers, other markers, or explanations."
                )},
                {"role": "user", "content": f"Source language: {source}\n\n{text}"},
            ],
            "temperature": 0.2,
        }
        try:
            response = httpx.post(
                settings["base_url"].rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {settings['api_key']}"},
                json=payload, timeout=90, follow_redirects=True,
            )
            response.raise_for_status()
            translated = response.json()["choices"][0]["message"]["content"].strip()
            if not translated:
                raise TranslationError("AI returned an empty translation")
            return translated
        except TranslationError:
            raise
        except Exception as exc:
            raise TranslationError(f"AI translation failed: {exc}") from exc

    def test_connection(self) -> dict[str, Any]:
        settings = self._secret()
        if settings.get("provider") == "free":
            return {"ok": True, "message": "سرویس ترجمهٔ رایگان انتخاب است؛ هنگام ترجمه به اینترنت نیاز دارد."}
        if not settings.get("api_key"):
            raise TranslationError("API key is not configured")
        try:
            response = httpx.get(
                settings["base_url"].rstrip("/") + "/models",
                headers={"Authorization": f"Bearer {settings['api_key']}"}, timeout=30,
            )
            response.raise_for_status()
            return {"ok": True, "message": "اتصال و کلید معتبر است."}
        except Exception as exc:
            raise TranslationError(f"Connection failed: {exc}") from exc
