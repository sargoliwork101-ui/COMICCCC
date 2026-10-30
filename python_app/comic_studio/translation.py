from __future__ import annotations

import html
import json
import os
import re
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from .activity import emit
from .ocr import LANGUAGES
from .paths import data_dir
from .store import atomic_json, read_json

AI_PROVIDERS: dict[str, dict[str, str]] = {
    "gemini": {
        "label": "Google Gemini", "model": "gemini-2.5-flash",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "key_url": "https://aistudio.google.com/apikey", "key_label": "ساخت کلید در Google AI Studio",
    },
    "openai": {
        "label": "OpenAI", "model": "gpt-4o-mini", "base_url": "https://api.openai.com/v1",
        "key_url": "https://platform.openai.com/api-keys", "key_label": "ساخت کلید در OpenAI",
    },
    "openrouter": {
        "label": "OpenRouter", "model": "openai/gpt-4o-mini", "base_url": "https://openrouter.ai/api/v1",
        "key_url": "https://openrouter.ai/settings/keys", "key_label": "ساخت کلید در OpenRouter",
    },
    "avalai": {
        "label": "AvalAI", "model": "gpt-6-luna", "base_url": "https://api.avalai.ir/v1",
        "key_url": "https://docs.avalai.ir/en/quickstart", "key_label": "راهنمای AvalAI",
    },
}
DEFAULTS = {
    "provider": "free",
    "base_url": AI_PROVIDERS["avalai"]["base_url"],
    "model": AI_PROVIDERS["avalai"]["model"],
}


class TranslationError(RuntimeError):
    pass


# U+241E SYMBOL FOR RECORD SEPARATOR: one visible-to-the-provider, non-linguistic
# character that is reserved for internal boundaries and removed before display.
TRANSLATION_SEPARATOR = "\u241e"
MAX_FREE_QUERY_CHARS = 500


def split_free_query(text: str, limit: int = MAX_FREE_QUERY_CHARS) -> list[str]:
    """Close at the last sentence end within the limit; never fill it with a partial next sentence."""
    remaining = str(text or "").strip()
    if limit < 1:
        raise ValueError("Query limit must be positive")
    if not remaining:
        return []
    chunks = []
    while len(remaining) > limit:
        window = remaining[:limit]
        sentence_cut = 0
        for match in re.finditer(r"[.!?…。！？][\"'”’»)]*", window):
            sentence_cut = match.end()
        cut = sentence_cut if sentence_cut > 0 else 0
        if not cut:
            cut = max(window.rfind("\n"), window.rfind(" "))
        if cut <= 0:
            cut = limit
        chunk = remaining[:cut].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[cut:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


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


def _default_providers() -> dict[str, dict[str, Any]]:
    return {
        provider: {"model": info["model"], "base_url": info["base_url"], "profiles": []}
        for provider, info in AI_PROVIDERS.items()
    }


def _legacy_provider(settings: dict[str, Any]) -> str:
    base_url = str(settings.get("base_url") or "").lower()
    if "avalai.ir" in base_url:
        return "avalai"
    if "openrouter.ai" in base_url:
        return "openrouter"
    if settings.get("provider") == "gemini":
        return "gemini"
    return "openai"


def _profile_id(value: Any, index: int) -> str:
    text = str(value or "").strip()
    return text[:120] if text else f"api-{index + 1}"


def _normalize_settings(raw: dict[str, Any]) -> dict[str, Any]:
    providers = _default_providers()
    stored_providers = raw.get("providers")
    if isinstance(stored_providers, dict):
        for provider in AI_PROVIDERS:
            source = stored_providers.get(provider)
            if not isinstance(source, dict):
                continue
            target = providers[provider]
            target["model"] = str(source.get("model") or target["model"]).strip()
            target["base_url"] = str(source.get("base_url") or target["base_url"]).strip().rstrip("/")
            profiles = source.get("profiles")
            if isinstance(profiles, list):
                target["profiles"] = [
                    {
                        "id": _profile_id(item.get("id"), index),
                        "name": str(item.get("name") or "").strip()[:160],
                        "api_key": str(item.get("api_key") or "").strip(),
                    }
                    for index, item in enumerate(profiles) if isinstance(item, dict)
                ]
    else:
        # Migrate the former single-key generic OpenAI-compatible form once.
        target_name = _legacy_provider(raw)
        target = providers[target_name]
        target["model"] = str(raw.get("model") or target["model"]).strip()
        target["base_url"] = str(raw.get("base_url") or target["base_url"]).strip().rstrip("/")
        key = str(raw.get("api_key") or "").strip()
        if key:
            target["profiles"] = [{"id": "legacy", "name": "کلید اصلی", "api_key": key}]

    provider = str(raw.get("provider") or "free").strip().lower()
    if provider not in {"free", *AI_PROVIDERS}:
        provider = "free"
    if not isinstance(stored_providers, dict) and provider == "openai":
        # Old AvalAI-default settings were labelled openai even though they used
        # AvalAI's endpoint. Preserve their working destination and credentials.
        provider = _legacy_provider(raw)
    return {"provider": provider, "providers": providers}


def _normalize_model(value: Any, provider: str) -> str:
    info = AI_PROVIDERS[provider]
    model = str(value or info["model"]).strip()
    if provider == "gemini":
        model = re.sub(r"^models/", "", model)
        valid = bool(re.fullmatch(r"[a-z0-9][a-z0-9._-]*", model, re.I))
    else:
        valid = bool(re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*", model, re.I)) and ".." not in model and "//" not in model and not model.endswith(("/", ":"))
    if not valid:
        raise TranslationError("نام مدل واردشده معتبر نیست.")
    return model


def _normalize_base_url(value: Any, provider: str) -> str:
    base_url = str(value or AI_PROVIDERS[provider]["base_url"]).strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.query or parsed.fragment:
        raise TranslationError("نشانی پایهٔ API معتبر نیست.")
    return base_url


def _safe_error(error: Exception, provider: str) -> str:
    label = AI_PROVIDERS.get(provider, {}).get("label", "سرویس هوش مصنوعی")
    response = getattr(error, "response", None)
    status = int(getattr(response, "status_code", 0) or 0)
    if status == 400:
        return f"درخواست یا نام مدل انتخاب‌شده برای {label} معتبر نیست."
    if status in {401, 403}:
        return "کلید API معتبر نیست یا اجازهٔ استفاده از این سرویس/مدل را ندارد."
    if status == 404:
        return "مدل یا مسیر انتخاب‌شده پیدا نشد؛ نام مدل و نشانی API را بررسی کنید."
    if status == 429:
        return "سقف استفاده یا سرعت درخواست‌های این سرویس پر شده است."
    if status >= 500:
        return f"سرویس {label} فعلاً پاسخ نمی‌دهد."
    if isinstance(error, TranslationError):
        return str(error)
    return f"ارتباط با {label} برقرار نشد؛ اینترنت، نشانی API یا دسترسی به سرویس را بررسی کنید."


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                parts.append(text)
            elif isinstance(text, dict) and isinstance(text.get("value"), str):
                parts.append(text["value"])
    return "".join(parts)


def _response_text(payload: dict[str, Any], provider: str) -> str:
    if provider == "gemini":
        candidates = payload.get("candidates")
        candidate = candidates[0] if isinstance(candidates, list) and candidates else {}
        content = candidate.get("content") if isinstance(candidate, dict) else {}
        parts = content.get("parts") if isinstance(content, dict) else []
        if not isinstance(parts, list):
            return ""
        return "".join(str(part.get("text") or "") for part in parts if isinstance(part, dict) and not part.get("thought"))
    choices = payload.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else {}
    if not isinstance(choice, dict):
        return ""
    message = choice.get("message")
    if isinstance(message, dict):
        text = _content_text(message.get("content"))
        if text:
            return text
    return _content_text(choice.get("text"))


def _ai_prompt(source_language: str) -> tuple[str, str]:
    source = LANGUAGES.get(source_language, LANGUAGES["eng"])["name"]
    return (
        "Translate the entire input to natural Persian using all paragraphs and comic bubbles together as shared context. "
        "Translate each paragraph or bubble as one continuous unit, not as isolated lines. "
        "Keep the original order and preserve names, numbers and sound effects. "
        f"The {TRANSLATION_SEPARATOR} character is an internal record separator, not source text. "
        f"Keep every {TRANSLATION_SEPARATOR} exactly unchanged, on its own line, and in the original order; never translate, remove, add, or duplicate it. "
        "Return only the translation and the original separators, without adding labels, numbers, other markers, or explanations."
    ), source


def translation_request_view(text: str, source_language: str, provider: str) -> dict[str, Any]:
    """Return the exact user-visible request text without performing network I/O."""
    clean = str(text or "").strip()
    if provider == "free":
        return {"texts": split_free_query(clean), "systemPrompt": ""}
    if provider not in AI_PROVIDERS:
        raise TranslationError("Unknown translation provider")
    system_prompt, source = _ai_prompt(source_language)
    return {"texts": [f"Source language: {source}\n\n{clean}"], "systemPrompt": system_prompt}


class TranslationService:
    def __init__(self) -> None:
        self.path = data_dir() / "ai-settings.json"

    def _secret(self) -> dict[str, Any]:
        normalized = _normalize_settings(read_json(self.path, {}))
        provider = normalized["provider"]
        active_name = provider if provider in AI_PROVIDERS else "avalai"
        active = normalized["providers"][active_name]
        first_key = next((p["api_key"] for p in active["profiles"] if p["api_key"]), "")
        return {
            **normalized,
            "base_url": active["base_url"],
            "model": active["model"],
            "api_key": first_key,
        }

    def public_settings(self) -> dict[str, Any]:
        secret = self._secret()
        provider = secret["provider"]
        active_name = provider if provider in AI_PROVIDERS else "avalai"
        active = secret["providers"][active_name]
        providers: dict[str, dict[str, Any]] = {}
        for name, info in AI_PROVIDERS.items():
            config = secret["providers"][name]
            providers[name] = {
                "label": info["label"],
                "defaultModel": info["model"],
                "model": config["model"],
                "base_url": config["base_url"],
                "keyUrl": info["key_url"],
                "keyLabel": info["key_label"],
                "profiles": [
                    {"id": profile["id"], "name": profile["name"], "hasApiKey": bool(profile["api_key"])}
                    for profile in config["profiles"]
                ],
            }
        return {
            "provider": provider,
            "base_url": active["base_url"],
            "model": active["model"],
            "hasApiKey": any(profile["api_key"] for profile in active["profiles"]),
            "providers": providers,
        }

    def save_settings(self, values: dict[str, Any]) -> dict[str, Any]:
        current = _normalize_settings(read_json(self.path, {}))
        provider = str(values.get("provider", current["provider"]) or "free").strip().lower()
        if provider not in {"free", *AI_PROVIDERS}:
            raise ValueError("Unknown translation provider")
        incoming = values.get("providers")
        incoming = incoming if isinstance(incoming, dict) else {}
        providers = _default_providers()

        for name in AI_PROVIDERS:
            old = current["providers"][name]
            config: dict[str, Any] = {
                "model": old["model"], "base_url": old["base_url"],
                "profiles": [dict(profile) for profile in old["profiles"]],
            }
            raw = incoming.get(name)
            if not isinstance(raw, dict) and name == provider and any(key in values for key in ("model", "base_url", "api_key", "profiles")):
                raw = values
            if isinstance(raw, dict):
                config["model"] = str(raw.get("model", config["model"]) or AI_PROVIDERS[name]["model"]).strip()
                config["base_url"] = str(raw.get("base_url", config["base_url"]) or AI_PROVIDERS[name]["base_url"]).strip().rstrip("/")
                if name == provider:
                    if "model" in values:
                        config["model"] = str(values.get("model") or AI_PROVIDERS[name]["model"]).strip()
                    if "base_url" in values:
                        config["base_url"] = str(values.get("base_url") or AI_PROVIDERS[name]["base_url"]).strip().rstrip("/")

                old_by_id = {profile["id"]: profile for profile in config["profiles"]}
                raw_profiles = raw.get("profiles")
                if isinstance(raw_profiles, list):
                    profiles: list[dict[str, str]] = []
                    for index, item in enumerate(raw_profiles):
                        if not isinstance(item, dict):
                            continue
                        profile_id = _profile_id(item.get("id"), index)
                        previous = old_by_id.get(profile_id, {})
                        supplied_key = item.get("api_key", item.get("apiKey"))
                        if supplied_key is None or not str(supplied_key).strip():
                            key = str(previous.get("api_key") or "")
                        elif str(supplied_key).strip() == "__clear__":
                            key = ""
                        else:
                            key = str(supplied_key).strip()
                        profiles.append({
                            "id": profile_id,
                            "name": str(item.get("name") or previous.get("name") or "").strip()[:160],
                            "api_key": key,
                        })
                    config["profiles"] = profiles
                elif name == provider and "api_key" in values:
                    # Backward-compatible single-key update used by older API clients.
                    previous = config["profiles"][0] if config["profiles"] else {"id": "legacy", "name": "کلید اصلی", "api_key": ""}
                    supplied_key = values.get("api_key")
                    if supplied_key is None or not str(supplied_key).strip():
                        key = previous["api_key"]
                    elif str(supplied_key).strip() == "__clear__":
                        key = ""
                    else:
                        key = str(supplied_key).strip()
                    config["profiles"] = [{**previous, "api_key": key}, *config["profiles"][1:]]
            providers[name] = config

        if provider in AI_PROVIDERS:
            providers[provider]["model"] = _normalize_model(providers[provider]["model"], provider)
            providers[provider]["base_url"] = _normalize_base_url(providers[provider]["base_url"], provider)
        active_name = provider if provider in AI_PROVIDERS else "avalai"
        active = providers[active_name]
        active_key = next((profile["api_key"] for profile in active["profiles"] if profile["api_key"]), "")
        next_value = {
            "provider": provider, "providers": providers,
            # Legacy top-level fields keep older local API clients and backups readable.
            "base_url": active["base_url"], "model": active["model"], "api_key": active_key,
        }
        atomic_json(self.path, next_value)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass
        return self.public_settings()

    def _profiles(self, settings: dict[str, Any], provider: str) -> list[dict[str, Any]]:
        config = settings["providers"][provider]
        return [
            {
                "provider": provider, "model": config["model"], "base_url": config["base_url"],
                "api_key": profile["api_key"], "profile_id": profile["id"],
                "profile_name": profile["name"] or f"API {index + 1}",
            }
            for index, profile in enumerate(config["profiles"]) if profile["api_key"]
        ]

    def translate(self, text: str, source_language: str, provider: str | None = None) -> str:
        text = str(text or "").strip()
        if not text:
            return ""
        settings = self._secret()
        selected = provider or settings.get("provider", "free")
        if selected == "free":
            translated = self._free(text, source_language)
        elif selected in AI_PROVIDERS:
            profiles = self._profiles(settings, selected)
            if not profiles:
                raise TranslationError(f"برای {AI_PROVIDERS[selected]['label']} حداقل یک کلید API معتبر وارد کنید.")
            failures: list[str] = []
            for profile in profiles:
                name = profile["profile_name"]
                emit(f"ترجمه با {AI_PROVIDERS[selected]['label']} و {name}…")
                try:
                    translated = self._gemini(text, source_language, profile) if selected == "gemini" else self._openai(text, source_language, profile)
                    if not translated.strip():
                        raise TranslationError("این کلید پاسخ قابل‌استفاده‌ای نداشت.")
                    normalized = normalize_translation_text(translated)
                    # A collective reply is usable only if every existing ␞ box
                    # can be restored unambiguously; otherwise try the next key.
                    distribute_translation([""] * (text.count(TRANSLATION_SEPARATOR) + 1), normalized)
                    emit(f"پاسخ ترجمه با {name} دریافت شد.", "success")
                    return normalized
                except Exception as exc:
                    message = _safe_error(exc, selected)
                    failures.append(f"{name}: {message}")
                    emit(f"تلاش با {name} ناموفق بود: {message}", "error")
            raise TranslationError("هیچ‌یک از کلیدهای این سرویس پاسخ قابل‌استفاده‌ای ندادند. " + "؛ ".join(failures))
        else:
            raise TranslationError("Unknown translation provider")
        return normalize_translation_text(translated)

    def _free(self, text: str, source_language: str) -> str:
        source = LANGUAGES.get(source_language, LANGUAGES["eng"])["source"]
        queries = split_free_query(text)
        translated_parts = []
        with httpx.Client(timeout=35, follow_redirects=True) as client:
            for query in queries:
                translated_parts.append(self._free_query(client, query, source))
        return " ".join(part.strip() for part in translated_parts if part.strip()).strip()

    def _free_query(self, client: httpx.Client, text: str, source: str) -> str:
        errors = []
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
            errors.append("Google returned no translation")
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
            errors.append("MyMemory returned no translation")
        except Exception as exc:
            errors.append(str(exc))
        raise TranslationError("Free translation failed: " + "; ".join(errors[-2:]))

    def _openai(self, text: str, source_language: str, settings: dict[str, Any]) -> str:
        if not settings.get("api_key"):
            raise TranslationError("API key is not configured")
        provider = str(settings.get("provider") or "openai")
        if provider not in AI_PROVIDERS or provider == "gemini":
            provider = "openai"
        base_url = _normalize_base_url(settings.get("base_url"), provider)
        model = _normalize_model(settings.get("model"), provider)
        system_prompt, source = _ai_prompt(source_language)
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Source language: {source}\n\n{text}"},
            ],
            "temperature": 0.2,
        }
        response = httpx.post(
            base_url + "/chat/completions",
            headers={"Authorization": f"Bearer {settings['api_key']}"},
            json=payload, timeout=90, follow_redirects=True,
        )
        response.raise_for_status()
        translated = _response_text(response.json(), provider).strip()
        if not translated:
            raise TranslationError("AI returned an empty translation")
        return translated

    def _gemini(self, text: str, source_language: str, settings: dict[str, Any]) -> str:
        if not settings.get("api_key"):
            raise TranslationError("API key is not configured")
        base_url = _normalize_base_url(settings.get("base_url"), "gemini")
        model = _normalize_model(settings.get("model"), "gemini")
        system_prompt, source = _ai_prompt(source_language)
        response = httpx.post(
            f"{base_url}/models/{quote(model, safe='')}:generateContent",
            headers={"x-goog-api-key": settings["api_key"]},
            json={
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": f"Source language: {source}\n\n{text}"}]}],
                "generationConfig": {"temperature": 0.2},
            },
            timeout=90, follow_redirects=True,
        )
        response.raise_for_status()
        translated = _response_text(response.json(), "gemini").strip()
        if not translated:
            raise TranslationError("AI returned an empty translation")
        return translated

    def test_connection(self, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        overrides = overrides or {}
        settings = self._secret()
        provider = str(overrides.get("provider") or settings.get("provider", "free"))
        if provider == "free":
            return {"ok": True, "message": "سرویس ترجمهٔ رایگان انتخاب است؛ هنگام ترجمه به اینترنت نیاز دارد."}
        if provider not in AI_PROVIDERS:
            raise TranslationError("Unknown translation provider")
        config = dict(settings["providers"][provider])
        if overrides.get("model") is not None:
            config["model"] = overrides["model"]
        if overrides.get("base_url") is not None:
            config["base_url"] = overrides["base_url"]
        model = _normalize_model(config.get("model"), provider)
        base_url = _normalize_base_url(config.get("base_url"), provider)

        profiles = config["profiles"]
        selected_profile: dict[str, Any] | None = None
        profile_id = str(overrides.get("profile_id") or "")
        if profile_id:
            selected_profile = next((profile for profile in profiles if profile["id"] == profile_id), None)
            if selected_profile is None:
                raise TranslationError("کلید انتخاب‌شده در تنظیمات ذخیره‌شده پیدا نشد.")
        else:
            selected_profile = next((profile for profile in profiles if profile["api_key"]), None)
        supplied_key = str(overrides.get("api_key") or "").strip()
        key = supplied_key or str((selected_profile or {}).get("api_key") or "").strip()
        if not key:
            raise TranslationError("برای تست ارتباط، ابتدا کلید API را وارد کنید.")

        headers = {"x-goog-api-key": key} if provider == "gemini" else {"Authorization": f"Bearer {key}"}
        url = f"{base_url}/models/{quote(model, safe='')}" if provider == "gemini" else f"{base_url}/models"
        try:
            response = httpx.get(url, headers=headers, timeout=30, follow_redirects=True)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise TranslationError(_safe_error(exc, provider)) from exc

        if provider == "gemini":
            if not isinstance(payload, dict) or payload.get("name") != f"models/{model}":
                raise TranslationError(f"پاسخ سرویس برای مدل «{model}» معتبر نبود؛ نام مدل را بررسی کنید.")
        else:
            models = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(models, list) or not any(isinstance(item, dict) and item.get("id") == model for item in models):
                raise TranslationError(f"مدل «{model}» در فهرست مدل‌های {AI_PROVIDERS[provider]['label']} پیدا نشد؛ نام مدل را بررسی کنید.")
        return {"ok": True, "provider": provider, "model": model, "message": f"اتصال برقرار است؛ مدل {model} در دسترس است."}
