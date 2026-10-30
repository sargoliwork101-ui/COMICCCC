from __future__ import annotations

import json

import httpx
import pytest

from comic_studio.translation import (
    TRANSLATION_SEPARATOR, TranslationError, TranslationService,
    combine_translation_texts, distribute_translation, split_free_query,
)


def test_ai_settings_do_not_expose_key(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    public = service.save_settings({"provider": "openai", "base_url": "http://localhost:1234/v1", "model": "local-model", "api_key": "secret"})
    assert public["hasApiKey"] is True
    assert "api_key" not in public
    assert service.public_settings()["model"] == "local-model"
    assert json.loads(service.path.read_text())["api_key"] == "secret"
    service.save_settings({"provider": "openai", "api_key": "__clear__"})
    assert service.public_settings()["hasApiKey"] is False


def test_openai_payload_and_response(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "openai", "base_url": "http://local.test/v1", "model": "demo", "api_key": "key"})
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return httpx.Response(200, json={"choices": [{"message": {"content": "سلام"}}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    assert service.translate("Hello", "eng") == "سلام"
    assert captured["url"] == "http://local.test/v1/chat/completions"
    assert captured["json"]["model"] == "demo"
    prompt = captured["json"]["messages"][0]["content"]
    assert "entire input" in prompt
    assert "not as isolated lines" in prompt
    assert "without adding labels" in prompt
    assert TRANSLATION_SEPARATOR in prompt
    assert "unchanged" in prompt


def test_free_fallback_and_empty_text(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    assert service.translate("  ", "eng") == ""
    monkeypatch.setattr(service, "_free", lambda text, language: "ترجمه")
    assert service.translate("hello", "eng") == "ترجمه"


def test_translation_decodes_literal_newline_entities(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    monkeypatch.setattr(service, "_free", lambda text, language: "اول&#10دوم&amp;#10;سوم&#x0A;چهارم")
    assert service.translate("one\ntwo\nthree\nfour", "eng") == "اول\nدوم\nسوم\nچهارم"
    monkeypatch.setattr(service, "_free", lambda text, language: "اول&amp;#x241E;دوم")
    assert service.translate("one\u241etwo", "eng") == f"اول{TRANSLATION_SEPARATOR}دوم"


def test_free_fallback_splits_every_long_query_at_500_chars(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    text = "x" * 600
    calls = []

    class Response:
        def __init__(self, payload=None, error=None):
            self.payload = payload
            self.error = error

        def raise_for_status(self):
            if self.error:
                raise httpx.HTTPError(self.error)

        def json(self):
            return self.payload

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def get(self, url, **kwargs):
            calls.append((url, kwargs))
            if "googleapis" in url:
                return Response(error="offline")
            return Response({"responseData": {"translatedText": "ترجمهٔ کامل"}})

    monkeypatch.setattr(httpx, "Client", Client)
    assert service._free(text, "eng") == "ترجمهٔ کامل ترجمهٔ کامل"
    assert len(calls) == 4
    query_lengths = [len(call[1]["params"]["q"]) for call in calls]
    assert query_lengths == [500, 500, 100, 100]
    assert all(length <= 500 for length in query_lengths)


def test_free_query_split_prefers_sentence_boundaries():
    first = "A" * 300 + "."
    second = "B" * 300 + "."
    parts = split_free_query(first + " " + second)
    assert parts == [first, second]
    assert all(len(part) <= 500 for part in parts)


def test_free_query_closes_at_sentence_end_instead_of_filling_500():
    first = "A" * 100 + "."
    second = ("word " * 89).strip() + "."
    assert len(first + " " + second) > 500
    assert len(second) <= 500
    parts = split_free_query(first + " " + second)
    assert parts == [first, second]
    assert all(len(part) <= 500 for part in parts)


def test_unknown_provider_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    with pytest.raises(ValueError):
        service.save_settings({"provider": "unknown"})
    with pytest.raises(TranslationError):
        service.translate("hello", "eng", provider="unknown")


def test_translation_separator_splits_exact_blocks_not_inner_newlines():
    sources = ["first line", "second bubble", "third line"]
    payload = combine_translation_texts(sources)
    assert payload == f"first line\n{TRANSLATION_SEPARATOR}\nsecond bubble\n{TRANSLATION_SEPARATOR}\nthird line"
    translated = f"ترجمهٔ اول\n{TRANSLATION_SEPARATOR}\nخط دوم\nادامهٔ همان کادر\n{TRANSLATION_SEPARATOR}\nترجمهٔ سوم"
    assert distribute_translation(sources, translated) == ["ترجمهٔ اول", "خط دوم\nادامهٔ همان کادر", "ترجمهٔ سوم"]


def test_translation_distribution_rejects_missing_or_empty_sections():
    with pytest.raises(TranslationError):
        distribute_translation(["one", "two"], "یک\nدو")
    with pytest.raises(TranslationError):
        distribute_translation(["one", "two"], f"یک{TRANSLATION_SEPARATOR}")
    with pytest.raises(TranslationError):
        distribute_translation(["one", "two"], f"یک{TRANSLATION_SEPARATOR}دو{TRANSLATION_SEPARATOR}سه")


def test_provider_settings_keep_models_and_keys_separate_without_exposing_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    public = service.save_settings({
        "provider": "openai",
        "providers": {
            "openai": {"model": "gpt-custom", "profiles": [{"id": "open-1", "name": "OpenAI من", "api_key": "open-secret"}]},
            "gemini": {"model": "gemini-custom", "profiles": [{"id": "gem-1", "name": "Gemini من", "api_key": "gem-secret"}]},
        },
    })
    assert public["providers"]["openai"]["model"] == "gpt-custom"
    assert public["providers"]["gemini"]["model"] == "gemini-custom"
    assert public["providers"]["openai"]["profiles"] == [{"id": "open-1", "name": "OpenAI من", "hasApiKey": True}]
    assert "open-secret" not in json.dumps(public) and "gem-secret" not in json.dumps(public)

    public = service.save_settings({"provider": "gemini", "providers": public["providers"]})
    secret = service._secret()
    assert public["provider"] == "gemini"
    assert secret["providers"]["openai"]["profiles"][0]["api_key"] == "open-secret"
    assert secret["providers"]["gemini"]["profiles"][0]["api_key"] == "gem-secret"


def test_gemini_uses_its_model_endpoint_header_and_response_parts(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "gemini", "model": "models/gemini-test", "api_key": "gemini-secret"})
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "سلام"}, {"text": "دنیا"}]}}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    assert service.translate("Hello", "eng", provider="gemini") == "سلامدنیا"
    assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
    assert captured["headers"]["x-goog-api-key"] == "gemini-secret"
    assert "gemini-secret" not in captured["url"]
    assert captured["json"]["contents"][0]["parts"][0]["text"].endswith("Hello")


def test_openrouter_content_parts_and_named_key_failover(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({
        "provider": "openrouter",
        "providers": {"openrouter": {
            "model": "anthropic/claude-test",
            "profiles": [
                {"id": "quota", "name": "سهمیه تمام", "api_key": "first-secret"},
                {"id": "working", "name": "کلید سالم", "api_key": "second-secret"},
            ],
        }},
    })
    calls = []

    def fake_post(url, **kwargs):
        key = kwargs["headers"]["Authorization"]
        calls.append((url, key, kwargs["json"]))
        if key == "Bearer first-secret":
            return httpx.Response(429, json={"error": "quota"}, request=httpx.Request("POST", url))
        return httpx.Response(200, json={"choices": [{"message": {"content": [{"type": "text", "text": "موفق"}]}}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    assert service.translate("Hello", "eng", provider="openrouter") == "موفق"
    assert len(calls) == 2
    assert calls[0][0] == calls[1][0] == "https://openrouter.ai/api/v1/chat/completions"
    assert calls[1][2]["model"] == "anthropic/claude-test"


def test_connection_test_rejects_missing_selected_model(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "openai", "base_url": "http://local.test/v1", "model": "missing-model", "api_key": "secret"})

    def fake_get(url, **kwargs):
        return httpx.Response(200, json={"data": [{"id": "another-model"}]}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    with pytest.raises(TranslationError, match="missing-model"):
        service.test_connection()


def test_all_failed_keys_stop_once_and_errors_hide_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({
        "provider": "avalai",
        "providers": {"avalai": {"profiles": [
            {"id": "a", "name": "حساب اول", "api_key": "private-one"},
            {"id": "b", "name": "حساب دوم", "api_key": "private-two"},
        ]}},
    })
    calls = []

    def fake_post(url, **kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        return httpx.Response(401, json={}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    with pytest.raises(TranslationError) as caught:
        service.translate("Hello", "eng", provider="avalai")
    message = str(caught.value)
    assert len(calls) == 2
    assert "حساب اول" in message and "حساب دوم" in message
    assert "private-one" not in message and "private-two" not in message


def test_malformed_collective_response_uses_next_key(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({
        "provider": "openai", "base_url": "http://local.test/v1", "model": "demo",
        "providers": {"openai": {"base_url": "http://local.test/v1", "model": "demo", "profiles": [
            {"id": "bad", "name": "پاسخ ناقص", "api_key": "bad-key"},
            {"id": "good", "name": "پاسخ کامل", "api_key": "good-key"},
        ]}},
    })
    calls = []

    def fake_post(url, **kwargs):
        key = kwargs["headers"]["Authorization"]
        calls.append(key)
        text = "فقط یک بخش" if key == "Bearer bad-key" else f"بخش اول{TRANSLATION_SEPARATOR}بخش دوم"
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    source = combine_translation_texts(["first", "second"])
    assert service.translate(source, "eng") == f"بخش اول{TRANSLATION_SEPARATOR}بخش دوم"
    assert calls == ["Bearer bad-key", "Bearer good-key"]


def test_legacy_avalai_settings_migrate_without_losing_key(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.path.parent.mkdir(parents=True, exist_ok=True)
    service.path.write_text(json.dumps({
        "provider": "openai", "base_url": "https://api.avalai.ir/v1",
        "model": "gpt-6-luna", "api_key": "legacy-secret",
    }))
    public = service.public_settings()
    assert public["provider"] == "avalai"
    assert public["model"] == "gpt-6-luna"
    assert public["providers"]["avalai"]["profiles"][0]["hasApiKey"] is True
    assert "legacy-secret" not in json.dumps(public)


def test_key_only_update_preserves_custom_model_and_base_url(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "openai", "base_url": "http://local.test/v1", "model": "local-custom", "api_key": "first"})
    public = service.save_settings({"provider": "openai", "api_key": "replacement"})
    assert public["base_url"] == "http://local.test/v1"
    assert public["model"] == "local-custom"
    assert service._secret()["api_key"] == "replacement"
