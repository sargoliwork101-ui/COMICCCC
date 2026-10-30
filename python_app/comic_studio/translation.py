from __future__ import annotations

import json
import math
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


def _paragraph_geometry(block: dict[str, Any]) -> tuple[float, float, float, float, float] | None:
    try:
        x0, y0, x1, y1 = (float(block.get(key)) for key in ("x0", "y0", "x1", "y1"))
        line_h = float(block.get("lineH") or y1 - y0)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in (x0, y0, x1, y1, line_h)) or x1 <= x0 or y1 <= y0 or line_h <= 0:
        return None
    return x0, y0, x1, y1, line_h


def _same_paragraph(first: dict[str, Any], second: dict[str, Any]) -> bool:
    a = _paragraph_geometry(first)
    b = _paragraph_geometry(second)
    if not a or not b:
        return False
    top, bottom = (a, b) if a[1] <= b[1] else (b, a)
    gap = bottom[1] - top[3]
    if gap < -.35 * min(top[4], bottom[4]) or gap > .9 * max(top[4], bottom[4]):
        return False
    overlap = min(top[2], bottom[2]) - max(top[0], bottom[0])
    return overlap >= .2 * min(top[2] - top[0], bottom[2] - bottom[0])


def group_translation_blocks(blocks: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Cluster adjacent OCR lines into bubbles/paragraphs without changing their schema."""
    eligible = [index for index, block in enumerate(blocks) if block.get("enabled", True) and str(block.get("text", "")).strip()]
    parent = {index: index for index in eligible}

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for position, first in enumerate(eligible):
        for second in eligible[position + 1:]:
            if _same_paragraph(blocks[first], blocks[second]):
                parent[find(second)] = find(first)
    clusters: dict[int, list[int]] = {}
    for index in eligible:
        clusters.setdefault(find(index), []).append(index)
    return [[blocks[index] for index in indices] for indices in sorted(clusters.values(), key=lambda values: values[0])]


def distribute_translation(source_texts: list[str], translated: str) -> list[str]:
    """Keep exact line mapping when possible and never drop a merged translation."""
    count = len(source_texts)
    text = str(translated or "").strip()
    if not count:
        return []
    if count == 1:
        return [text]
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) == count:
        return lines
    words = text.split()
    if len(words) < count:
        return [text] + [""] * (count - 1)
    weights = [max(1, len(str(source).strip())) for source in source_texts]
    total_weight = sum(weights)
    result = []
    offset = 0
    for index, weight in enumerate(weights[:-1]):
        wanted = round(len(words) * weight / total_weight)
        size = max(1, min(wanted, len(words) - offset - (count - index - 1)))
        result.append(" ".join(words[offset:offset + size]))
        offset += size
    result.append(" ".join(words[offset:]))
    return result


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
                    "Translate each complete comic bubble or paragraph to natural Persian as one contextual unit. "
                    "Preserve every physical line break, indentation, name, number and sound effect. Return only the translation; no explanations."
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
