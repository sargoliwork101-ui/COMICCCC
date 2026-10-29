from __future__ import annotations

import json
import os
from pathlib import Path
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
            return self._free(text, source_language)
        if selected == "openai":
            return self._openai(text, source_language, settings)
        raise TranslationError("Unknown translation provider")

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
                    params={"q": text[:480], "langpair": f"{source.split('-')[0]}|fa"},
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
                    "Translate comic dialogue to natural Persian. Preserve every physical line break, "
                    "indentation, name, number and sound effect. Return only the translation; no explanations."
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
