from __future__ import annotations

import html
import json
import os
import re
import time
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


# Legacy symbol, retained only to decode literal HTML entities; no longer a boundary.
TRANSLATION_SEPARATOR = "\u241e"
MAX_FREE_QUERY_CHARS = 500
DEFAULT_AI_TIMEOUT = 90
DEFAULT_AI_RETRIES = 0
DEFAULT_AI_RETRY_WAIT = 20
MAX_AI_RETRY_WAIT = 300
MIN_AI_TIMEOUT, MAX_AI_TIMEOUT = 5, 600
MAX_AI_RETRIES = 5


def _setting_int(value: Any, default: int, minimum: int, maximum: int, *, strict: bool = False) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        if strict:
            raise ValueError(f"مقدار تنظیم باید عدد صحیح بین {minimum} و {maximum} باشد.")
        return default
    return value


def _profile_policy(profile: dict[str, Any], *, strict: bool = False) -> dict[str, int]:
    return {
        "timeout_seconds": _setting_int(profile.get("timeout_seconds"), DEFAULT_AI_TIMEOUT, MIN_AI_TIMEOUT, MAX_AI_TIMEOUT, strict=strict),
        "retry_count": _setting_int(profile.get("retry_count"), DEFAULT_AI_RETRIES, 0, MAX_AI_RETRIES, strict=strict),
        "retry_wait_seconds": _setting_int(profile.get("retry_wait_seconds"), DEFAULT_AI_RETRY_WAIT, 0, MAX_AI_RETRY_WAIT, strict=strict),
    }


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


def _translation_lines(value: Any) -> list[str]:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip().split("\n")


def combine_translation_texts(source_texts: list[str]) -> str:
    """Combine blocks using ordinary newlines, without inserting a marker."""
    return "\n".join("\n".join(_translation_lines(source)) for source in source_texts)


def distribute_translation(source_texts: list[str], translated: str) -> list[str]:
    """Map a response by source line counts, rejecting ambiguous multi-block output."""
    if not source_texts:
        return []
    text = str(translated or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise TranslationError("مترجم پاسخ خالی برگرداند؛ متن در کادر قرار نگرفت.")
    # A single block needs no boundary inference; natural translations may wrap
    # or contain paragraphs regardless of the input line count.
    if len(source_texts) == 1:
        return [text]
    source_lines = [_translation_lines(source) for source in source_texts]
    expected = [line for lines in source_lines for line in lines]
    actual = text.split("\n")
    if len(actual) != len(expected):
        raise TranslationError(f"تعداد خطوط پاسخ ({len(actual)}) با متن مبدأ ({len(expected)}) یکسان نیست؛ هیچ ترجمه‌ای جابه‌جا نشد.")
    # Empty input lines must stay empty, and a nonempty source cannot map to an
    # empty output; otherwise the positions of later blocks cannot be trusted.
    if any(bool(source.strip()) != bool(result.strip()) for source, result in zip(expected, actual)):
        raise TranslationError("خط خالی پاسخ با متن مبدأ سازگار نیست؛ هیچ ترجمه‌ای جابه‌جا نشد.")
    output = []
    cursor = 0
    for lines in source_lines:
        output.append("\n".join(line.strip() for line in actual[cursor:cursor + len(lines)]))
        cursor += len(lines)
    return output


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
                        **_profile_policy(item),
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
            target["profiles"] = [{"id": "legacy", "name": "کلید اصلی", "api_key": key, **_profile_policy({})}]

    provider = str(raw.get("provider") or "free").strip().lower()
    if provider not in {"free", *AI_PROVIDERS}:
        provider = "free"
    if not isinstance(stored_providers, dict) and provider == "openai":
        # Old AvalAI-default settings were labelled openai even though they used
        # AvalAI's endpoint. Preserve their working destination and credentials.
        provider = _legacy_provider(raw)
    return {"provider": provider, "providers": providers, "reuse_repeated": raw.get("reuse_repeated", True) if isinstance(raw.get("reuse_repeated", True), bool) else True}


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


def _redact_diagnostic(value: Any, secrets: list[str]) -> str:
    """Keep useful service diagnostics without printing known keys or credentials."""
    text = str(value or "").replace("\x00", "")
    for secret in sorted({str(key) for key in secrets if key}, key=len, reverse=True):
        for variant in {secret, quote(secret, safe=""), html.escape(secret)}:
            text = text.replace(variant, "[REDACTED]")
    text = re.sub(r"(?i)(https?://)[^/\s@]+@", r"\1[REDACTED]@", text)
    text = re.sub(r"(?i)\bBearer\s+[^\s,;\"']+", "Bearer [REDACTED]", text)
    text = re.sub(r"(?i)([\"']?(?:api[_-]?key|access[_-]?token|authorization|password|secret)[\"']?\s*[:=]\s*[\"']?)([^\s,;\"'&}]+)", r"\1[REDACTED]", text)
    return text.strip()[:1200]


def _safe_error(error: Exception, provider: str, secrets: list[str] | None = None) -> str:
    """Include HTTP status/provider message or transport exception, not request headers."""
    secrets = secrets or []
    label = AI_PROVIDERS.get(provider, {}).get("label", "سرویس هوش مصنوعی")
    response = getattr(error, "response", None)
    status = int(getattr(response, "status_code", 0) or 0)
    if status:
        detail: Any = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = body.get("error", body.get("detail", body.get("message", "")))
                if isinstance(detail, dict):
                    detail = " | ".join(str(detail[k]) for k in ("message", "code", "type", "status") if detail.get(k) is not None)
                elif not isinstance(detail, (str, int, float)):
                    detail = ""
            elif isinstance(body, str):
                detail = body
        except (ValueError, UnicodeError):
            # HTML error pages can contain arbitrary data and are not useful to paste.
            content_type = response.headers.get("content-type", "").lower()
            if "text/plain" in content_type:
                detail = response.text
            elif "text/html" in content_type:
                title = re.search(r"<title[^>]*>(.*?)</title\s*>", response.text, re.IGNORECASE | re.DOTALL)
                if title:
                    detail = html.unescape(re.sub(r"<[^>]*>", "", title.group(1)))
        message = f"{label}: HTTP {status}"
        if detail:
            message += f"؛ پیام سرویس: {_redact_diagnostic(detail, secrets)}"
        for header in ("x-request-id", "request-id", "cf-ray", "retry-after"):
            if response.headers.get(header):
                message += f"؛ {header}: {_redact_diagnostic(response.headers[header], secrets)[:160]}"
        return message
    if isinstance(error, TranslationError):
        return _redact_diagnostic(str(error), secrets)
    detail = _redact_diagnostic(str(error), secrets)
    kind = type(error).__name__
    return f"{label}: {kind}" + (f"؛ جزئیات: {detail}" if detail else "؛ سرویس جزئیات بیشتری برنگرداند.")


def _retryable(error: Exception) -> bool:
    if isinstance(error, (httpx.TransportError, TranslationError, json.JSONDecodeError)):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return status in {408, 429} or status >= 500
    return False


def _run_with_retries(action: Any, profile: dict[str, Any], provider: str, secrets: list[str]) -> Any:
    retries = profile.get("retry_count", DEFAULT_AI_RETRIES)
    for attempt in range(retries + 1):
        try:
            return action()
        except Exception as exc:
            if not _retryable(exc) or attempt >= retries:
                raise
            wait = profile.get("retry_wait_seconds", DEFAULT_AI_RETRY_WAIT)
            emit(f"تلاش {attempt + 1} ناموفق بود: {_safe_error(exc, provider, secrets)}؛ پس از {wait} ثانیه، تکرار {attempt + 1} از {retries} برای همین API (ممکن است هزینه تکرار شود).", "warning")
            time.sleep(wait)
    raise AssertionError("unreachable")


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


def _empty_response_error(payload: Any) -> str:
    """Explain a provider error carried in an otherwise successful HTTP response."""
    if not isinstance(payload, dict):
        return "AI returned an empty translation (HTTP 200)."
    error = payload.get("error")
    if isinstance(error, dict):
        detail = " | ".join(str(error[k]) for k in ("message", "code", "type", "status") if error.get(k) is not None)
    elif isinstance(error, str):
        detail = error
    else:
        detail = ""
    feedback = payload.get("promptFeedback")
    if isinstance(feedback, dict) and feedback.get("blockReason"):
        detail = f"{detail} blockReason={feedback['blockReason']}".strip()
    candidates = payload.get("candidates")
    if isinstance(candidates, list) and candidates and isinstance(candidates[0], dict) and candidates[0].get("finishReason"):
        detail = f"{detail} finishReason={candidates[0]['finishReason']}".strip()
    return "AI returned an empty translation (HTTP 200)." + (f" Provider detail: {detail}" if detail else "")


def _ai_prompt(source_language: str) -> tuple[str, str]:
    source = LANGUAGES.get(source_language, LANGUAGES["eng"])["name"]
    return (
        "Translate the entire input to natural Persian using all paragraphs and comic bubbles together as shared context. "
        "Use every line as context while preserving the original order, names, numbers and sound effects. "
        "Return exactly one output line for every input line, with the same number of lines. "
        "Never merge, split, add, remove, or reorder lines; keep blank lines in place and each translated line on one ordinary text line. "
        "Return only the translation without adding labels, numbers, markers, code fences, or explanations."
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
                    {"id": profile["id"], "name": profile["name"], "hasApiKey": bool(profile["api_key"]), **_profile_policy(profile)}
                    for profile in config["profiles"]
                ],
            }
        return {
            "provider": provider,
            "reuse_repeated": secret["reuse_repeated"],
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
                            **_profile_policy({**_profile_policy(previous), **{k: item[k] for k in ("timeout_seconds", "retry_count", "retry_wait_seconds") if k in item}}, strict=True),
                        })
                    config["profiles"] = profiles
                elif name == provider and "api_key" in values:
                    # Backward-compatible single-key update used by older API clients.
                    previous = config["profiles"][0] if config["profiles"] else {"id": "legacy", "name": "کلید اصلی", "api_key": "", **_profile_policy({})}
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
            "provider": provider, "providers": providers, "reuse_repeated": values.get("reuse_repeated", current["reuse_repeated"]),
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
                "profile_name": profile["name"] or f"API {index + 1}", **_profile_policy(profile),
            }
            for index, profile in enumerate(config["profiles"]) if profile["api_key"]
        ]

    def translate(self, text: str, source_language: str, provider: str | None = None, source_texts: list[str] | None = None) -> str:
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
            secrets = [p["api_key"] for c in settings["providers"].values() for p in c["profiles"] if p["api_key"]]
            for profile_index, profile in enumerate(profiles):
                name = _redact_diagnostic(profile["profile_name"], secrets)
                emit(f"ترجمه با {AI_PROVIDERS[selected]['label']} و {name} (انتظار {profile['timeout_seconds']} ثانیه، {profile['retry_count']} تکرار)…")
                def request_translation() -> str:
                    translated = self._gemini(text, source_language, profile) if selected == "gemini" else self._openai(text, source_language, profile)
                    if not translated.strip():
                        raise TranslationError("این کلید پاسخ قابل‌استفاده‌ای نداشت.")
                    normalized = normalize_translation_text(translated)
                    if source_texts is not None:
                        distribute_translation(source_texts, normalized)
                    return normalized
                try:
                    normalized = _run_with_retries(request_translation, profile, selected, secrets)
                    emit(f"پاسخ ترجمه با {name} دریافت شد.", "success")
                    return normalized
                except Exception as exc:
                    message = _safe_error(exc, selected, secrets)
                    if isinstance(exc, httpx.TransportError):
                        emit(f"پاسخ {name} به‌علت خطای ارتباطی دریافت نشد: {message}؛ کلید بعدی خودکار امتحان نشد.", "error")
                        previous = (" خطاهای کلیدهای قبلی: " + "؛ ".join(failures)) if failures else ""
                        raise TranslationError(f"ارتباط {name} قطع شد (سقف انتظار هر مرحله {profile['timeout_seconds']} ثانیه، حداکثر {profile['retry_count']} تکرار)؛ ممکن است سرویس درخواست را پردازش یا هزینه را حساب کرده باشد. کلید بعدی خودکار امتحان نشد. جزئیات واقعی: {message}{previous}") from exc
                    failures.append(f"{name}: {message}")
                    emit(f"تلاش با {name} ناموفق بود: {message}", "error")
                    if profile_index + 1 < len(profiles):
                        wait = profile["retry_wait_seconds"]
                        emit(f"تلاش با کلید بعدی پس از {wait} ثانیه انجام می‌شود؛ ممکن است هزینه تکرار شود.", "warning")
                        time.sleep(wait)
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
            json=payload, timeout=settings.get("timeout_seconds", DEFAULT_AI_TIMEOUT), follow_redirects=True,
        )
        response.raise_for_status()
        payload_result = response.json()
        translated = _response_text(payload_result, provider).strip()
        if not translated:
            raise TranslationError(_empty_response_error(payload_result))
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
            timeout=settings.get("timeout_seconds", DEFAULT_AI_TIMEOUT), follow_redirects=True,
        )
        response.raise_for_status()
        payload_result = response.json()
        translated = _response_text(payload_result, "gemini").strip()
        if not translated:
            raise TranslationError(_empty_response_error(payload_result))
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
        policy = _profile_policy(selected_profile or {})
        secrets = [p["api_key"] for c in settings["providers"].values() for p in c["profiles"] if p["api_key"]] + [key]
        def request_models() -> Any:
            response = httpx.get(url, headers=headers, timeout=policy["timeout_seconds"], follow_redirects=True)
            response.raise_for_status()
            return response.json()
        try:
            payload = _run_with_retries(request_models, policy, provider, secrets)
        except (httpx.HTTPError, ValueError) as exc:
            raise TranslationError(_safe_error(exc, provider, secrets)) from exc

        if provider == "gemini":
            if not isinstance(payload, dict) or payload.get("name") != f"models/{model}":
                raise TranslationError(f"پاسخ سرویس برای مدل «{model}» معتبر نبود؛ نام مدل را بررسی کنید.")
        else:
            models = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(models, list) or not any(isinstance(item, dict) and item.get("id") == model for item in models):
                raise TranslationError(f"مدل «{model}» در فهرست مدل‌های {AI_PROVIDERS[provider]['label']} پیدا نشد؛ نام مدل را بررسی کنید.")
        return {"ok": True, "provider": provider, "model": model, "message": f"اتصال برقرار است؛ مدل {model} در دسترس است."}
