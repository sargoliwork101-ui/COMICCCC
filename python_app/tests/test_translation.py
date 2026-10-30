from __future__ import annotations

import json

import httpx
import pytest

from comic_studio.translation import (
    TRANSLATION_SEPARATOR, TranslationError, TranslationService,
    combine_translation_texts, distribute_translation,
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


def test_free_fallback_does_not_truncate_a_shared_page(tmp_path, monkeypatch):
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
    assert service._free(text, "eng") == "ترجمهٔ کامل"
    assert len(calls) == 2
    assert calls[1][1]["params"]["q"] == text


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
