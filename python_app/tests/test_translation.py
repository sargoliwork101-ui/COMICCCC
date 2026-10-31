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
    assert "one output line for every input line" in prompt
    assert "without adding labels" in prompt
    assert TRANSLATION_SEPARATOR not in prompt
    assert "same number of lines" in prompt


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


def test_translation_lines_follow_each_block_line_count_without_markers():
    sources = ["first line\nsecond line", "second bubble", "third line\ncontinuation"]
    payload = combine_translation_texts(sources)
    assert payload == "first line\nsecond line\nsecond bubble\nthird line\ncontinuation"
    assert TRANSLATION_SEPARATOR not in payload
    translated = "ترجمهٔ اول\nخط دوم\nحباب دوم\nخط سوم\nادامه"
    assert distribute_translation(sources, translated) == ["ترجمهٔ اول\nخط دوم", "حباب دوم", "خط سوم\nادامه"]
    example = combine_translation_texts(["WHY ARE YOU", "RUNNING AROUND", "SO FRIVOLOUSLY,", "MY CHILD?"])
    assert example == "WHY ARE YOU\nRUNNING AROUND\nSO FRIVOLOUSLY,\nMY CHILD?"
    assert combine_translation_texts(["literal ␞ symbol", "next"]) == "literal ␞ symbol\nnext"


def test_translation_distribution_rejects_missing_or_empty_sections():
    with pytest.raises(TranslationError):
        distribute_translation(["one", "two"], "یک دو")
    with pytest.raises(TranslationError):
        distribute_translation(["one", "two"], "یک\nدو\nسه")
    with pytest.raises(TranslationError):
        distribute_translation(["one", "two", "three"], "یک\n\nسه")


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
    assert public["providers"]["openai"]["profiles"] == [{"id": "open-1", "name": "OpenAI من", "hasApiKey": True, "timeout_seconds": 90, "retry_count": 0, "retry_wait_seconds": 20}]
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
                {"id": "quota", "name": "سهمیه تمام", "api_key": "first-secret", "retry_wait_seconds": 0},
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
            {"id": "a", "name": "حساب اول", "api_key": "private-one", "retry_wait_seconds": 0},
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
            {"id": "bad", "name": "پاسخ ناقص", "api_key": "bad-key", "retry_wait_seconds": 0},
            {"id": "good", "name": "پاسخ کامل", "api_key": "good-key"},
        ]}},
    })
    calls = []

    def fake_post(url, **kwargs):
        key = kwargs["headers"]["Authorization"]
        calls.append(key)
        text = "فقط یک خط" if key == "Bearer bad-key" else "بخش اول\nبخش دوم"
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    source = combine_translation_texts(["first", "second"])
    assert service.translate(source, "eng", source_texts=["first", "second"]) == "بخش اول\nبخش دوم"
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


def test_single_block_translation_allows_natural_multiline_reply():
    assert distribute_translation(["One paragraph"], "ترجمهٔ اول\nادامه") == ["ترجمهٔ اول\nادامه"]
    assert distribute_translation(["first\nsecond"], "ترجمهٔ یکپارچه") == ["ترجمهٔ یکپارچه"]


def test_blank_source_lines_are_not_mistaken_for_missing_translation():
    assert distribute_translation(["first\n\nsecond", "third"], "یک\n\nدو\nسه") == ["یک\n\nدو", "سه"]
    with pytest.raises(TranslationError):
        distribute_translation(["first\n\nsecond", "third"], "یک\nچیز\nدو\nسه")


def test_ai_timeout_never_automatically_resends_page_with_another_key(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    service.save_settings({'provider': 'openai', 'providers': {'openai': {'profiles': [
        {'id': 'first', 'api_key': 'one'}, {'id': 'second', 'api_key': 'two'},
    ]}}})
    calls = []
    def timeout(url, **kwargs):
        calls.append(kwargs['headers']['Authorization'])
        raise httpx.ReadTimeout('private detail')
    monkeypatch.setattr(httpx, 'post', timeout)
    with pytest.raises(TranslationError, match='کلید بعدی خودکار امتحان نشد') as error:
        service.translate('one page', 'eng', 'openai', ['one page'])
    assert calls == ['Bearer one']
    assert 'ReadTimeout' in str(error.value) and 'private detail' in str(error.value)


@pytest.mark.parametrize("field,value", [
    ("timeout_seconds", 4), ("timeout_seconds", 601), ("timeout_seconds", True),
    ("timeout_seconds", "90"), ("retry_count", -1), ("retry_count", 6), ("retry_count", 1.5),
])
def test_invalid_profile_policy_is_rejected_without_losing_settings(tmp_path, monkeypatch, field, value):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "avalai", "api_key": "secret"})
    with pytest.raises(ValueError, match="عدد صحیح"):
        service.save_settings({"provider": "avalai", "providers": {"avalai": {"profiles": [{"id": "legacy", field: value}]}}})
    assert service._secret()["api_key"] == "secret"


def test_profile_policies_are_independent_and_preserved_without_resending_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    public = service.save_settings({"provider": "avalai", "providers": {"avalai": {"profiles": [
        {"id": "a", "api_key": "secret-a", "timeout_seconds": 125, "retry_count": 2},
        {"id": "b", "api_key": "secret-b", "timeout_seconds": 20, "retry_count": 1},
    ]}}})
    assert [p["timeout_seconds"] for p in public["providers"]["avalai"]["profiles"]] == [125, 20]
    assert [p["retry_count"] for p in public["providers"]["avalai"]["profiles"]] == [2, 1]
    assert "secret-a" not in json.dumps(public)
    service.save_settings({"provider": "avalai", "providers": public["providers"]})
    assert [p["api_key"] for p in service._secret()["providers"]["avalai"]["profiles"]] == ["secret-a", "secret-b"]
    assert service.public_settings()["providers"]["avalai"]["profiles"][0]["retry_count"] == 2


def test_retry_timeout_exhaustion_shows_safe_actual_error_and_stops_before_next_key(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "avalai", "providers": {"avalai": {"profiles": [
        {"id": "a", "name": "first", "api_key": "real-private-key", "timeout_seconds": 135, "retry_count": 2},
        {"id": "b", "api_key": "other-private-key", "timeout_seconds": 12, "retry_count": 1},
    ]}}})
    monkeypatch.setattr("comic_studio.translation.time.sleep", lambda _: None)
    calls = []
    def post(url, **kwargs):
        calls.append((kwargs["headers"]["Authorization"], kwargs["timeout"]))
        raise httpx.ReadTimeout("socket timed out; key=real-private-key and other-private-key")
    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(TranslationError) as caught:
        service.translate("hello", "eng", "avalai")
    message = str(caught.value)
    assert calls == [("Bearer real-private-key", 135)] * 3
    assert "ReadTimeout" in message and "socket timed out" in message
    assert "real-private-key" not in message and "other-private-key" not in message
    assert "کلید بعدی خودکار امتحان نشد" in message


def test_http_status_and_provider_message_redacted_and_retry_then_success(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "openai", "providers": {"openai": {"profiles": [
        {"id": "a", "api_key": "sensitive-secret", "timeout_seconds": 44, "retry_count": 1}
    ]}}})
    monkeypatch.setattr("comic_studio.translation.time.sleep", lambda _: None)
    calls = []
    def post(url, **kwargs):
        calls.append(kwargs["timeout"])
        if len(calls) == 1:
            return httpx.Response(429, json={"error": {"message": "Rate limit sensitive-secret", "code": "quota_exceeded"}}, request=httpx.Request("POST", url))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ترجمه"}}]}, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", post)
    assert service.translate("hello", "eng", "openai") == "ترجمه"
    assert calls == [44, 44]
    def reject(url, **kwargs):
        return httpx.Response(401, json={"error": {"message": "wrong key sensitive-secret", "code": "invalid_api_key"}}, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", reject)
    with pytest.raises(TranslationError) as caught:
        service.translate("hello", "eng", "openai")
    assert "HTTP 401" in str(caught.value) and "wrong key" in str(caught.value)
    assert "invalid_api_key" in str(caught.value) and "sensitive-secret" not in str(caught.value)


def test_connection_test_uses_profile_policy_and_reports_real_redacted_error(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "gemini", "providers": {"gemini": {"profiles": [
        {"id": "g", "api_key": "gemini-secret", "timeout_seconds": 22, "retry_count": 1}
    ]}}})
    monkeypatch.setattr("comic_studio.translation.time.sleep", lambda _: None)
    calls = []
    def get(url, **kwargs):
        calls.append(kwargs["timeout"])
        return httpx.Response(503, json={"error": {"message": "temporarily unavailable", "status": "UNAVAILABLE"}}, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx, "get", get)
    with pytest.raises(TranslationError) as caught:
        service.test_connection({"provider": "gemini", "profile_id": "g"})
    assert calls == [22, 22]
    assert "HTTP 503" in str(caught.value) and "temporarily unavailable" in str(caught.value)
    assert "gemini-secret" not in str(caught.value)


def test_bad_ai_response_is_retried_only_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    service = TranslationService()
    service.save_settings({"provider": "openai", "providers": {"openai": {"profiles": [
        {"id": "a", "api_key": "secret", "retry_count": 1}
    ]}}})
    monkeypatch.setattr("comic_studio.translation.time.sleep", lambda _: None)
    calls = []
    def post(url, **kwargs):
        calls.append(1)
        text = "one line" if len(calls) == 1 else "یک\nدو"
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}]}, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", post)
    assert service.translate("first\nsecond", "eng", "openai", ["first", "second"]) == "یک\nدو"
    assert len(calls) == 2


def test_200_error_payload_and_html_title_preserve_diagnostics_without_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    service.save_settings({'provider': 'openai', 'api_key': 'private-key'})
    def payload_error(url, **kwargs):
        return httpx.Response(200, json={'error': {'message': 'credits exhausted private-key', 'code': 'quota'}}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', payload_error)
    with pytest.raises(TranslationError) as caught:
        service.translate('hello', 'eng')
    assert 'HTTP 200' in str(caught.value) and 'credits exhausted' in str(caught.value) and 'quota' in str(caught.value)
    assert 'private-key' not in str(caught.value)
    def html_error(url, **kwargs):
        return httpx.Response(502, text='<html><title>Gateway failed private-key</title><body>do not include body</body></html>',
                              headers={'content-type': 'text/html'}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', html_error)
    with pytest.raises(TranslationError) as caught:
        service.translate('hello', 'eng')
    assert 'HTTP 502' in str(caught.value) and 'Gateway failed' in str(caught.value)
    assert 'private-key' not in str(caught.value) and 'do not include body' not in str(caught.value)


def test_retry_wait_settings_apply_to_retries_and_next_key(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    saved = service.save_settings({'provider': 'openai', 'providers': {'openai': {'profiles': [
        {'id': 'a', 'api_key': 'first-key', 'retry_count': 1, 'retry_wait_seconds': 17},
        {'id': 'b', 'api_key': 'second-key', 'retry_count': 0, 'retry_wait_seconds': 3},
    ]}}})
    assert [p['retry_wait_seconds'] for p in saved['providers']['openai']['profiles']] == [17, 3]
    waits = []; monkeypatch.setattr('comic_studio.translation.time.sleep', waits.append)
    calls = []
    def post(url, **kwargs):
        key = kwargs['headers']['Authorization']; calls.append(key)
        if key == 'Bearer first-key':
            return httpx.Response(503, json={'error': 'busy'}, request=httpx.Request('POST', url))
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}]}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', post)
    assert service.translate('hello', 'eng', 'openai') == 'ok'
    assert calls == ['Bearer first-key', 'Bearer first-key', 'Bearer second-key']
    assert waits == [17, 17]


@pytest.mark.parametrize('value', [-1, 301, True, 2.5, '20'])
def test_invalid_retry_wait_rejected(tmp_path, monkeypatch, value):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    with pytest.raises(ValueError):
        service.save_settings({'provider': 'openai', 'providers': {'openai': {'profiles': [{'id': 'a', 'retry_wait_seconds': value}]}}})


def test_default_retry_wait_and_connection_test_respect_per_key_delay(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path))
    service = TranslationService()
    saved = service.save_settings({'provider': 'openai', 'providers': {'openai': {'profiles': [
        {'id': 'a', 'api_key': 'secret', 'retry_count': 1}
    ]}}})
    assert saved['providers']['openai']['profiles'][0]['retry_wait_seconds'] == 20
    waits = []; monkeypatch.setattr('comic_studio.translation.time.sleep', waits.append)
    calls = []
    def get(url, **kwargs):
        calls.append(url)
        if len(calls) == 1:
            return httpx.Response(429, json={'error': 'rate limited'}, request=httpx.Request('GET', url))
        return httpx.Response(200, json={'data': [{'id': 'gpt-4o-mini'}]}, request=httpx.Request('GET', url))
    monkeypatch.setattr(httpx, 'get', get)
    assert service.test_connection({'provider': 'openai', 'profile_id': 'a'})['ok']
    assert len(calls) == 2 and waits == [20]
