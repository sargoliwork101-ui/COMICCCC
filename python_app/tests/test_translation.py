from __future__ import annotations

import json

import httpx
import pytest

from comic_studio.translation import TranslationError, TranslationService, distribute_translation, group_translation_blocks


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
    assert "physical line break" in captured["json"]["messages"][0]["content"]


def test_free_fallback_and_empty_text(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    assert service.translate("  ", "eng") == ""
    monkeypatch.setattr(service, "_free", lambda text, language: "ترجمه")
    assert service.translate("hello", "eng") == "ترجمه"


def test_unknown_provider_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    with pytest.raises(ValueError):
        service.save_settings({"provider": "unknown"})
    with pytest.raises(TranslationError):
        service.translate("hello", "eng", provider="unknown")


def test_translation_groups_join_paragraph_lines_not_neighboring_bubbles():
    def block(text, x0, y0, x1, y1, enabled=True):
        return {"text": text, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "lineH": y1 - y0, "enabled": enabled}
    blocks = [
        block("first", 10, 10, 180, 35),
        block("second", 30, 42, 160, 67),
        block("side", 300, 12, 450, 37),
        block("distant", 10, 150, 180, 175),
        block("disabled", 20, 72, 170, 97, False),
    ]
    groups = group_translation_blocks(blocks)
    assert [[block["text"] for block in group] for group in groups] == [["first", "second"], ["side"], ["distant"]]


def test_group_translation_distribution_preserves_all_text():
    assert distribute_translation(["one", "two"], "یک\nدو") == ["یک", "دو"]
    translated = "یک دو سه چهار پنج شش"
    distributed = distribute_translation(["a", "longer", "longest line"], translated)
    assert len(distributed) == 3
    assert all(distributed)
    assert " ".join(distributed) == translated
