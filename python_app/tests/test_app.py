from __future__ import annotations

import io
import zipfile

import httpx
import pymupdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from comic_studio.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    with TestClient(create_app()) as test_client:
        yield test_client


def png_bytes(size=(320, 200), color="white") -> bytes:
    image = Image.new("RGB", size, color)
    ImageDraw.Draw(image).text((12, 15), "hello", fill="black")
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()


def make_project(client: TestClient) -> tuple[dict, dict]:
    response = client.post("/api/projects", json={"name": "آزمایش"})
    assert response.status_code == 201
    project = response.json()
    response = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", ("page.png", png_bytes(), "image/png"))],
    )
    assert response.status_code == 200, response.text
    project = response.json()
    return project, project["images"][0]


def test_health_and_static_shell(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["version"] == "3.43"
    assert health.json()["scraping"] is False
    assert client.get("/").status_code == 200
    assert "Comic OCR Studio" in client.get("/").text
    assert '<span class="ver">۳.۴۳ · Python</span>' in client.get("/").text
    assert client.get("/typeset.js").status_code == 200
    assert "no-store" in client.get("/").headers.get("cache-control", "")
    assert "no-store" in client.get("/typeset.js").headers.get("cache-control", "")


def test_ai_connection_endpoint_tests_the_selected_saved_profile(client, monkeypatch):
    saved = client.put("/api/ai-settings", json={
        "provider": "openrouter",
        "providers": {"openrouter": {
            "model": "anthropic/claude-api-test",
            "profiles": [
                {"id": "first", "name": "اول", "api_key": "first-api-secret"},
                {"id": "second", "name": "دوم", "api_key": "second-api-secret"},
            ],
        }},
    })
    assert saved.status_code == 200, saved.text
    assert "first-api-secret" not in saved.text and "second-api-secret" not in saved.text
    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return httpx.Response(200, json={"data": [{"id": "anthropic/claude-api-test"}]}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    tested = client.post("/api/ai-settings/test", json={"provider": "openrouter", "profile_id": "second"})
    assert tested.status_code == 200, tested.text
    assert tested.json()["model"] == "anthropic/claude-api-test"
    assert captured["url"] == "https://openrouter.ai/api/v1/models"
    assert captured["headers"]["Authorization"] == "Bearer second-api-secret"
    assert "second-api-secret" not in tested.text


def test_project_image_render_and_all_exports(client):
    project, item = make_project(client)
    project_id, image_id = project["id"], item["id"]
    assert client.get(f"/api/projects/{project_id}/images/{image_id}/content").content == png_bytes()

    project["images"][0]["crop"] = {"x": 10, "y": 10, "w": 200, "h": 120}
    project["images"][0]["blocks"] = [{
        "id": 1, "text": "hello", "tr": "سلام", "enabled": True,
        "x0": 10, "y0": 10, "x1": 110, "y1": 45, "lineH": 35,
        "sourceIndent": 3, "bg": "auto", "dir": "rtl", "align": "right",
    }]
    assert client.put(f"/api/projects/{project_id}/state", json={"state": project}).status_code == 200
    edited = png_bytes((320, 200), "white")
    response = client.post(
        f"/api/projects/{project_id}/images/{image_id}/rendered",
        content=edited, headers={"Content-Type": "image/png"},
    )
    assert response.status_code == 200
    assert response.json()["images"][0]["edited"] is True
    assert client.get(f"/api/projects/{project_id}/images/{image_id}/content?edited=true").status_code == 200

    response = client.post(f"/api/projects/{project_id}/export", json={
        "kind": "pdf", "image_ids": [image_id], "name": "خروجی",
    })
    assert response.status_code == 200
    with pymupdf.open(stream=response.content, filetype="pdf") as document:
        assert len(document) == 1

    response = client.post(f"/api/projects/{project_id}/export", json={
        "kind": "images", "image_ids": [image_id], "name": "خروجی", "folder_name": "chapter",
    })
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert names == ["chapter/001-page.png"]
        with Image.open(io.BytesIO(archive.read(names[0]))) as image:
            assert image.size == (200, 120)
            assert image.format == "PNG"

    response = client.post(f"/api/projects/{project_id}/export", json={
        "kind": "txt", "image_ids": [image_id], "name": "خروجی",
    })
    assert response.status_code == 200
    assert "hello" in response.content.decode("utf-8-sig")
    assert "سلام" in response.content.decode("utf-8-sig")


def test_untouched_original_bytes_are_preserved(client):
    project, item = make_project(client)
    response = client.post(f"/api/projects/{project['id']}/export", json={
        "kind": "images", "image_ids": [item["id"]], "name": "original",
    })
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read(archive.namelist()[0]) == png_bytes()


def test_reverting_rendered_image_restores_original_export_bytes(client):
    project, item = make_project(client)
    response = client.post(
        f"/api/projects/{project['id']}/images/{item['id']}/rendered",
        content=png_bytes((320, 200), "red"), headers={"Content-Type": "image/png"},
    )
    assert response.status_code == 200
    assert response.json()["images"][0]["edited"] is True
    response = client.post(f"/api/projects/{project['id']}/images/{item['id']}/revert")
    assert response.status_code == 200
    response = client.post(f"/api/projects/{project['id']}/export", json={
        "kind": "images", "image_ids": [item["id"]], "name": "without-overlay",
    })
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read(archive.namelist()[0]) == png_bytes()


def test_duplicate_group_reorder_and_delete(client):
    project, item = make_project(client)
    project_id = project["id"]
    response = client.post(f"/api/projects/{project_id}/duplicate", json=[item["id"]])
    assert response.status_code == 200
    project = response.json()
    assert len(project["images"]) == 2
    project["images"][0]["groupId"] = "گروه ۱"
    project["images"][1]["groupId"] = "گروه ۱"
    project["images"][0]["selected"] = False
    project["images"][0]["blocks"] = [{"id": 1, "text": "ONE", "tr": "یک", "textMode": "ocr", "enabled": True}]
    project["settings"]["overlayMode"] = "ocr"
    project["images"].reverse()
    response = client.put(f"/api/projects/{project_id}/state", json={"state": project})
    assert response.status_code == 200
    assert response.json()["images"][0]["groupId"] == "گروه ۱"
    assert response.json()["settings"]["overlayMode"] == "ocr"
    saved_original = next(image for image in response.json()["images"] if image["id"] == item["id"])
    assert saved_original["blocks"][0]["textMode"] == "ocr"
    assert client.get(f"/api/projects/{project_id}").json()["settings"]["overlayMode"] == "ocr"
    ids = [entry["id"] for entry in response.json()["images"]]
    response = client.post(f"/api/projects/{project_id}/delete", json=ids[:1])
    assert response.status_code == 200
    assert len(response.json()["images"]) == 1


def test_ocr_endpoint_stores_geometry_without_network(client, monkeypatch):
    project, item = make_project(client)
    def fake_ocr(engine, image, language, contrast, precise, min_confidence):
        return [{"id": 1, "text": "خط آزمایش", "tr": "", "richHtml": "", "conf": 99,
                 "x0": 4, "y0": 8, "x1": 100, "y1": 40, "lineH": 32,
                 "sourceIndent": 0, "enabled": True}]
    monkeypatch.setattr("comic_studio.main.recognize_image", fake_ocr)
    response = client.post(f"/api/projects/{project['id']}/ocr", json={
        "image_ids": [item["id"]], "engine": "rapidocr-v6", "language": "eng",
    })
    assert response.status_code == 200, response.text
    block = response.json()["images"][0]["blocks"][0]
    assert block["text"] == "خط آزمایش"
    assert block["bg"] == "auto"
    feed = client.get("/api/activity?after=0").json()
    assert any("متن خوانده‌شده" in entry["message"] and "خط آزمایش" in entry["message"] for entry in feed["entries"])
    assert any(entry["kind"] == "success" and "OCR تمام شد" in entry["message"] for entry in feed["entries"])


def test_translation_preview_shows_exact_free_payload_without_sending(client, monkeypatch):
    from comic_studio.translation import TRANSLATION_SEPARATOR, TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [
        {"id": 1, "text": "Hello", "tr": "old one", "enabled": True},
        {"id": 2, "text": "world", "tr": "old two", "enabled": True},
        {"id": 3, "text": "disabled", "tr": "old three", "enabled": False},
    ]
    assert client.put(f"/api/projects/{project['id']}/state", json={ "state": project }).status_code == 200

    def must_not_send(*args, **kwargs):
        raise AssertionError("preview must not call the translator")

    monkeypatch.setattr(TranslationService, "translate", must_not_send)
    response = client.post(f"/api/projects/{project['id']}/translation-preview", json={
        "image_ids": [item["id"]], "provider": "free", "source_language": "eng",
    })
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["requestCount"] == 1
    assert preview["requests"][0]["text"] == "Hello\nworld"
    assert TRANSLATION_SEPARATOR not in preview["requests"][0]["text"]
    assert "Google Translate" in preview["providerLabel"] and "MyMemory" in preview["providerLabel"]
    assert preview["base_url"] == "https://translate.googleapis.com/translate_a/single"
    assert preview["fallback_url"] == "https://api.mymemory.translated.net/get"
    assert preview["signature"]
    stored = client.get(f"/api/projects/{project['id']}").json()
    assert [block["tr"] for block in stored["images"][0]["blocks"]] == ["old one", "old two", "old three"]


def test_translation_preview_expands_real_500_character_queries(client):
    project, item = make_project(client)
    source = "x" * 600
    project["images"][0]["blocks"] = [{"id": 1, "text": source, "tr": "old", "enabled": True}]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    response = client.post(f"/api/projects/{project['id']}/translation-preview", json={
        "image_ids": [item["id"]], "provider": "free", "source_language": "eng",
    })
    assert response.status_code == 200, response.text
    requests = response.json()["requests"]
    assert [len(request["text"]) for request in requests] == [500, 100]
    assert "".join(request["text"] for request in requests) == source


def test_translation_confirmation_rejects_changed_project_text(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [{"id": 1, "text": "before", "tr": "old", "enabled": True}]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    preview = client.post(f"/api/projects/{project['id']}/translation-preview", json={
        "image_ids": [item["id"]], "provider": "free", "source_language": "eng",
    }).json()
    project["images"][0]["blocks"][0]["text"] = "after"
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    monkeypatch.setattr(TranslationService, "translate", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("stale confirmation must not send")))
    response = client.post(f"/api/projects/{project['id']}/translate", json={
        "image_ids": [item["id"]], "provider": "free", "source_language": "eng",
        "confirmation": preview["signature"],
    })
    assert response.status_code == 409
    assert client.get(f"/api/projects/{project['id']}").json()["images"][0]["blocks"][0]["tr"] == "old"


def test_ai_and_single_text_previews_show_full_user_message(client):
    project, item = make_project(client)
    project["images"][0]["blocks"] = [{"id": 1, "text": "Hello AI", "tr": "old", "enabled": True}]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    response = client.post(f"/api/projects/{project['id']}/translation-preview", json={
        "image_ids": [item["id"]], "provider": "openai", "source_language": "eng",
    })
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["requests"][0]["text"] == "Source language: English\n\nHello AI"
    assert "entire input" in preview["systemPrompt"]
    assert preview["model"] == "gpt-4o-mini"

    single = client.post("/api/translate-text/preview", json={
        "text": "  Single line  ", "provider": "free", "source_language": "eng",
    })
    assert single.status_code == 200, single.text
    assert single.json()["requests"][0]["text"] == "Single line"


def test_single_text_confirmation_previews_then_sends_the_same_text(client, monkeypatch):
    from comic_studio.translation import TranslationService
    calls = []
    monkeypatch.setattr(TranslationService, "_free", lambda self, text, source_language: calls.append(text) or "پاسخ تکی")
    preview = client.post("/api/translate-text/preview", json={"text": "Exact single text", "provider": "free", "source_language": "eng"})
    assert preview.status_code == 200, preview.text
    assert calls == []
    response = client.post("/api/translate-text", json={
        "text": "Exact single text", "provider": "free", "source_language": "eng",
        "confirmation": preview.json()["signature"],
    })
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "پاسخ تکی"}
    assert calls == ["Exact single text"]


def test_ai_destination_change_invalidates_preview_before_sending(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [{"id": 1, "text": "Hello AI", "tr": "old", "enabled": True}]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    preview = client.post(f"/api/projects/{project['id']}/translation-preview", json={
        "image_ids": [item["id"]], "provider": "openai", "source_language": "eng",
    }).json()
    changed = client.put("/api/ai-settings", json={"provider": "openai", "providers": {"openai": {
        "model": "different-model", "base_url": "https://example.com/v2",
    }}})
    assert changed.status_code == 200, changed.text
    monkeypatch.setattr(TranslationService, "translate", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("stale AI destination must not send")))
    response = client.post(f"/api/projects/{project['id']}/translate", json={
        "image_ids": [item["id"]], "provider": "openai", "source_language": "eng",
        "confirmation": preview["signature"],
    })
    assert response.status_code == 409


def test_free_translation_combines_ocr_blocks_when_payload_fits_500(client, monkeypatch):
    from comic_studio.translation import TRANSLATION_SEPARATOR, TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [
        {"id": 1, "text": "Hello\nin two lines", "tr": "old", "richHtml": "old", "enabled": True, "x0": 10, "y0": 10, "x1": 180, "y1": 35, "lineH": 25},
        {"id": 2, "text": "world", "tr": "old", "richHtml": "old", "enabled": True, "x0": 30, "y0": 42, "x1": 160, "y1": 67, "lineH": 25},
        {"id": 3, "text": "Another bubble", "tr": "old", "richHtml": "old", "enabled": True, "x0": 10, "y0": 150, "x1": 180, "y1": 175, "lineH": 25},
    ]
    response = client.put(f"/api/projects/{project['id']}/state", json={"state": project})
    assert response.status_code == 200
    calls = []

    def fake_free(self, text, source_language):
        calls.append(text)
        return "سلام&#10در دو خط\nدنیا\nحباب دیگر"

    monkeypatch.setattr(TranslationService, "_free", fake_free)
    preview = client.post(f"/api/projects/{project['id']}/translation-preview", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng"}).json()
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng", "confirmation": preview["signature"]})
    assert response.status_code == 200, response.text
    assert calls == ["Hello\nin two lines\nworld\nAnother bubble"]
    blocks = response.json()["images"][0]["blocks"]
    assert [block["tr"] for block in blocks] == ["سلام\nدر دو خط", "دنیا", "حباب دیگر"]
    assert all(block["richHtml"] == "" for block in blocks)
    assert all(TRANSLATION_SEPARATOR not in block["tr"] and "&#10" not in block["tr"] and "[[[" not in block["tr"] for block in blocks)
    feed = client.get("/api/activity?after=0").json()["entries"]
    assert any("یک درخواست" in entry["message"] and entry["progress"] == pytest.approx(1.0) for entry in feed)
    assert not any("جدا ترجمه" in entry["message"] for entry in feed)


def test_free_translation_over_500_keeps_safe_block_requests(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    sources = ["A" * 300, "B" * 300]
    project["images"][0]["blocks"] = [
        {"id": index, "text": text, "tr": "قبلی", "enabled": True}
        for index, text in enumerate(sources, start=1)
    ]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    calls = []

    def fake_free(self, text, source_language):
        calls.append(text)
        return "اول" if text == sources[0] else "دوم"

    monkeypatch.setattr(TranslationService, "_free", fake_free)
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng"})
    assert response.status_code == 200, response.text
    assert calls == sources
    assert [block["tr"] for block in response.json()["images"][0]["blocks"]] == ["اول", "دوم"]


def test_free_combined_response_requires_exact_line_count(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [
        {"id": 1, "text": "Hello", "tr": "قبلی یک", "richHtml": "قبلی یک", "enabled": True},
        {"id": 2, "text": "World", "tr": "قبلی دو", "richHtml": "قبلی دو", "enabled": True},
    ]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    monkeypatch.setattr(TranslationService, "translate", lambda self, text, source_language, provider=None, source_texts=None: "یک دو")
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng"})
    assert response.status_code == 502
    stored = client.get(f"/api/projects/{project['id']}").json()
    assert [block["tr"] for block in stored["images"][0]["blocks"]] == ["قبلی یک", "قبلی دو"]
    assert [block["richHtml"] for block in stored["images"][0]["blocks"]] == ["قبلی یک", "قبلی دو"]


def test_ai_translation_uses_one_request_per_page_and_reports_stages(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    response = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", ("second.png", png_bytes(), "image/png"))],
    )
    project = response.json()
    for image_index, image in enumerate(project["images"]):
        image["blocks"] = [
            {"id": 1, "text": f"Page {image_index} first" + ("\ncontinued" if image_index == 0 else ""), "enabled": True, "x0": 10, "y0": 10, "x1": 180, "y1": 35, "lineH": 25},
            {"id": 2, "text": f"Page {image_index} distant", "enabled": True, "x0": 10, "y0": 150, "x1": 180, "y1": 175, "lineH": 25},
        ]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    calls = []

    def fake_translate(self, text, source_language, provider=None, source_texts=None):
        calls.append((text, source_texts))
        return "یک\nادامه\nدو" if len(calls) == 1 else "سه\nچهار"

    monkeypatch.setattr(TranslationService, "translate", fake_translate)
    ids = [image["id"] for image in project["images"]]
    preview = client.post(f"/api/projects/{project['id']}/translation-preview", json={"image_ids": ids, "provider": "openai", "source_language": "eng"})
    assert preview.status_code == 200, preview.text
    assert preview.json()["requests"][0]["text"].startswith("Source language: English\n\nPage 0 first")
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": ids, "provider": "openai", "source_language": "eng", "confirmation": preview.json()["signature"]})
    assert response.status_code == 200, response.text
    assert preview.json()["requestCount"] == 2
    assert [request["imageId"] for request in preview.json()["requests"]] == ids
    assert "Page 1" not in preview.json()["requests"][0]["text"]
    assert calls == [("Page 0 first\ncontinued\nPage 0 distant", ["Page 0 first\ncontinued", "Page 0 distant"]), ("Page 1 first\nPage 1 distant", ["Page 1 first", "Page 1 distant"])]
    assert [[block["tr"] for block in image["blocks"]] for image in response.json()["images"]] == [["یک\nادامه", "دو"], ["سه", "چهار"]]
    feed = client.get("/api/activity?after=0").json()["entries"]
    assert any("درخواست 1 از 2" in entry["message"] and entry["progress"] == pytest.approx(0.5) for entry in feed)
    assert any("درخواست 2 از 2" in entry["message"] and entry["progress"] == pytest.approx(1.0) for entry in feed)


def test_translation_rejects_wrong_line_count_without_false_success(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [
        {"id": 1, "text": "Hello", "tr": "قبلی یک", "richHtml": "قبلی یک", "enabled": True},
        {"id": 2, "text": "World", "tr": "قبلی دو", "richHtml": "قبلی دو", "enabled": True},
    ]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    monkeypatch.setattr(TranslationService, "translate", lambda self, text, source_language, provider=None, source_texts=None: "یک دو")
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": [item["id"]], "provider": "openai", "source_language": "eng"})
    assert response.status_code == 502
    assert "خط" in response.json()["detail"]
    stored = client.get(f"/api/projects/{project['id']}").json()
    assert [block["tr"] for block in stored["images"][0]["blocks"]] == ["قبلی یک", "قبلی دو"]
    assert [block["richHtml"] for block in stored["images"][0]["blocks"]] == ["قبلی یک", "قبلی دو"]
    feed = client.get("/api/activity?after=0").json()["entries"]
    assert any(entry["kind"] == "error" and "ترجمه ناموفق" in entry["message"] for entry in feed)
    assert not any(entry["kind"] == "success" and "با هم و در یک درخواست" in entry["message"] for entry in feed)


def test_model_download_receives_only_selected_language(client, monkeypatch):
    from comic_studio.main import EngineRegistry
    calls = []
    monkeypatch.setattr(EngineRegistry, "download", lambda self, engine_id, language: calls.append((engine_id, language)))
    response = client.post("/api/engines/rapidocr-v5/download", json={"language": "kor"})
    assert response.status_code == 200, response.text
    assert response.json()["language"] == "kor"
    assert calls == [("rapidocr-v5", "kor")]


def test_model_download_error_is_returned_to_the_ui(client, monkeypatch):
    from comic_studio.main import EngineRegistry
    from comic_studio.ocr import OcrError
    def fail(self, engine_id, language):
        raise OcrError("model host blocked")
    monkeypatch.setattr(EngineRegistry, "download", fail)
    response = client.post("/api/engines/rapidocr-v5/download", json={"language": "eng"})
    assert response.status_code == 503
    assert "model host blocked" in response.json()["detail"]


def test_activity_feed_contains_progress_during_explicit_download(client, monkeypatch):
    from comic_studio.activity import emit
    from comic_studio.main import EngineRegistry
    def fake_download(self, engine_id, language):
        emit("در حال دانلود مدل آزمایشی", progress=0.42)
    monkeypatch.setattr(EngineRegistry, "download", fake_download)
    response = client.post("/api/engines/rapidocr-v5/download", json={"language": "eng"})
    assert response.status_code == 200, response.text
    feed = client.get("/api/activity?after=0").json()
    assert any(entry["message"] == "در حال دانلود مدل آزمایشی" and entry["progress"] == pytest.approx(0.42) for entry in feed["entries"])
    later = client.get(f"/api/activity?after={feed['next']}").json()
    assert later["entries"] == []


def test_activity_clear_removes_history_without_reusing_ids(client):
    activity = client.app.state.activity
    activity.add("گزارش قدیمی")
    before = client.get("/api/activity?after=0").json()
    response = client.post("/api/activity/clear")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "next": before["next"]}
    assert client.get("/api/activity?after=0").json()["entries"] == []
    activity.add("گزارش کار جدید")
    later = client.get(f"/api/activity?after={before['next']}").json()
    assert [entry["message"] for entry in later["entries"]] == ["گزارش کار جدید"]
    assert later["entries"][0]["id"] > before["next"]


def test_browser_session_heartbeat_and_close(client):
    response = client.post("/api/session/heartbeat", json={"client_id": "test-tab-0001"})
    assert response.status_code == 200
    assert response.json()["active"] == 1
    response = client.post("/api/session/close", json={"client_id": "test-tab-0001"})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "active": 0, "accepted": True}


def test_external_model_guide_is_explicit_and_not_executable(client):
    response = client.get("/api/engines")
    assert response.status_code == 200
    engines = {entry["id"]: entry for entry in response.json()}
    assert "paddleocr-vl-1-6" in engines
    assert engines["paddleocr-vl-1-6"]["selectable"] is False
    response = client.post("/api/engines/glm-ocr/download", json={"language": "eng"})
    assert response.status_code == 200
    assert response.json()["guide"] is True
    assert response.json()["ok"] is False
    response = client.post("/api/engines/glm-ocr/test", json={"project_id": "missing", "image_id": "missing", "language": "eng"})
    assert response.status_code == 400
    assert "external runtime" in response.json()["detail"]


def test_pdf_import(client):
    document = pymupdf.open()
    page = document.new_page(width=180, height=240)
    page.insert_text((25, 80), "PDF page", fontsize=20)
    pdf = document.tobytes()
    document.close()
    project = client.post("/api/projects", json={}).json()
    response = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", ("chapter.pdf", pdf, "application/pdf"))],
    )
    assert response.status_code == 200, response.text
    images = response.json()["images"]
    assert len(images) == 1
    assert images[0]["width"] > 180
    assert images[0]["height"] > 240


def test_state_cannot_replace_server_file_metadata(client):
    project, item = make_project(client)
    original_file = item["file"]
    project["images"][0]["file"] = "../../outside"
    project["images"][0]["id"] = item["id"]
    project["images"].append({"id": "not-real", "file": "bad"})
    response = client.put(f"/api/projects/{project['id']}/state", json={"state": project})
    assert response.status_code == 200
    saved = response.json()
    assert len(saved["images"]) == 1
    assert saved["images"][0]["file"] == original_file


def test_export_requires_explicit_selection(client):
    project, _ = make_project(client)
    response = client.post(f"/api/projects/{project['id']}/export", json={"kind": "pdf", "image_ids": []})
    assert response.status_code == 400


def test_invalid_upload_and_missing_project(client):
    project = client.post("/api/projects", json={}).json()
    response = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", ("bad.txt", b"not an image", "text/plain"))],
    )
    assert response.status_code == 400
    assert client.get("/api/projects/not-real").status_code == 404


def test_group_members_become_one_pdf_page_and_pairs_skip_groups(client):
    project = client.post("/api/projects", json={}).json()
    response = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", (f"page-{index}.png", png_bytes((320 + index * 10, 200)), "image/png")) for index in range(4)],
    )
    assert response.status_code == 200, response.text
    project = response.json()
    project["images"][0]["groupId"] = 1
    project["images"][1]["groupId"] = 1
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    ids = [item["id"] for item in project["images"]]
    response = client.post(f"/api/projects/{project['id']}/export", json={"kind": "pdf", "image_ids": ids, "name": "grouped"})
    assert response.status_code == 200, response.text
    with pymupdf.open(stream=response.content, filetype="pdf") as document:
        assert len(document) == 3  # one composed group page plus two ungrouped pages
    response = client.post(f"/api/projects/{project['id']}/export", json={"kind": "pdf", "image_ids": ids, "name": "grouped-pairs", "two_per_page": True})
    assert response.status_code == 200, response.text
    with pymupdf.open(stream=response.content, filetype="pdf") as document:
        assert len(document) == 2  # the group stays whole; only the other two are paired


def test_group_composition_preserves_mixed_width_image_geometry():
    from comic_studio.exporter import compose_images

    def solid(width, height, color):
        output = io.BytesIO()
        Image.new("RGB", (width, height), color).save(output, "PNG")
        return {"data": output.getvalue(), "w": width, "h": height, "order": 0}

    composed = compose_images([solid(100, 100, "red"), solid(200, 100, "blue")])
    assert (composed["w"], composed["h"]) == (200, 300)
    with Image.open(io.BytesIO(composed["data"])) as image:
        assert image.getpixel((0, 0)) == (255, 0, 0)
        assert image.getpixel((199, 199)) == (255, 0, 0)
        assert image.getpixel((0, 200)) == (0, 0, 255)
        assert image.getpixel((199, 299)) == (0, 0, 255)


def test_cropped_preview_revert_and_project_delete(client):
    project, item = make_project(client)
    project["images"][0]["crop"] = {"x": 10, "y": 10, "w": 120, "h": 80}
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    response = client.get(f"/api/projects/{project['id']}/images/{item['id']}/content?cropped=true")
    assert response.status_code == 200
    with Image.open(io.BytesIO(response.content)) as preview:
        assert preview.size == (120, 80)
    rendered = png_bytes((320, 200), "white")
    assert client.post(f"/api/projects/{project['id']}/images/{item['id']}/rendered", content=rendered, headers={"Content-Type": "image/png"}).status_code == 200
    response = client.post(f"/api/projects/{project['id']}/images/{item['id']}/revert")
    assert response.status_code == 200
    assert response.json()["images"][0]["edited"] is False
    assert client.delete(f"/api/projects/{project['id']}").status_code == 204
    assert client.get(f"/api/projects/{project['id']}").status_code == 404


def test_duplicate_is_inserted_after_source_without_group_membership(client):
    project, item = make_project(client)
    project["images"][0]["groupId"] = 7
    # A singleton is cleaned by the UI, but the server still must not copy it.
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    response = client.post(f"/api/projects/{project['id']}/duplicate", json=[item["id"]])
    assert response.status_code == 200
    images = response.json()["images"]
    assert len(images) == 2
    assert images[1]["name"].startswith("کپی")
    assert images[1]["groupId"] is None
    assert images[1]["order"] == 1


def test_delete_ignores_unknown_and_glob_image_ids(client):
    project, item = make_project(client)
    response = client.post(f"/api/projects/{project['id']}/delete", json=["*", "", item["id"][:4]])
    assert response.status_code == 200
    assert len(response.json()["images"]) == 1
    assert client.get(f"/api/projects/{project['id']}/images/{item['id']}/content").content == png_bytes()


def test_failed_import_batch_removes_new_files_and_preserves_existing(client, tmp_path):
    project, item = make_project(client)
    image_dir = tmp_path / "data" / "projects" / project["id"] / "images"
    before = {path.name for path in image_dir.iterdir()}
    response = client.post(f"/api/projects/{project['id']}/files", files=[
        ("files", ("new.png", png_bytes(), "image/png")),
        ("files", ("bad.txt", b"not an image", "text/plain")),
    ])
    assert response.status_code == 400
    assert {path.name for path in image_dir.iterdir()} == before
    assert [entry["id"] for entry in client.get(f"/api/projects/{project['id']}").json()["images"]] == [item["id"]]


def test_failed_multi_image_ocr_preserves_all_existing_previews(client, monkeypatch):
    from comic_studio.ocr import OcrError
    project, first = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/duplicate", json=[first["id"]]).json()
    images = project["images"]
    for item in images:
        response = client.post(f"/api/projects/{project['id']}/images/{item['id']}/rendered", content=png_bytes((320, 200), "red"))
        assert response.status_code == 200
    calls = 0

    def fake_ocr(*args):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OcrError("second page failed")
        return [{"id": 1, "text": "new", "enabled": True}]

    monkeypatch.setattr("comic_studio.main.recognize_image", fake_ocr)
    result = client.post(f"/api/projects/{project['id']}/ocr", json={"image_ids": [item["id"] for item in images], "engine": "rapidocr-v6", "language": "eng"})
    assert result.status_code == 503
    state = client.get(f"/api/projects/{project['id']}").json()
    assert all(item["edited"] and item["blocks"] == [] for item in state["images"])
    for item in images:
        assert client.get(f"/api/projects/{project['id']}/images/{item['id']}/content?edited=true").content == png_bytes((320, 200), "red")


def test_ocr_save_failure_preserves_previous_render(client, monkeypatch):
    from comic_studio.ocr import OcrError
    from comic_studio.store import ProjectStore

    project, item = make_project(client)
    url = f"/api/projects/{project['id']}/images/{item['id']}/content?edited=true"
    assert client.post(f"/api/projects/{project['id']}/images/{item['id']}/rendered", content=png_bytes((320, 200), "red")).status_code == 200
    monkeypatch.setattr("comic_studio.main.recognize_image", lambda *args: [{"id": 1, "text": "new", "enabled": True}])
    monkeypatch.setattr(ProjectStore, "save", lambda *args: (_ for _ in ()).throw(OcrError("save failed")))
    result = client.post(f"/api/projects/{project['id']}/ocr", json={"image_ids": [item['id']], "engine": "rapidocr-v6", "language": "eng"})
    assert result.status_code == 503
    assert client.get(url).content == png_bytes((320, 200), "red")
    saved = client.get(f"/api/projects/{project['id']}").json()["images"][0]
    assert saved["edited"] is True and saved["blocks"] == []


def test_corrupt_image_returns_client_error_without_changing_project(client):
    project, item = make_project(client)
    result = client.post(f"/api/projects/{project['id']}/files", files=[
        ("files", ("broken.png", b"not a png", "image/png")),
    ])
    assert result.status_code == 400
    assert "broken.png" in result.json()["detail"]
    assert [entry["id"] for entry in client.get(f"/api/projects/{project['id']}").json()["images"]] == [item['id']]
    assert client.get(f"/api/projects/{project['id']}/images/{item['id']}/content").content == png_bytes()


def test_grouped_ocr_builds_one_translation_preview_item(client, monkeypatch):
    project, item = make_project(client)
    def fake_ocr(*args):
        return [{"id": i, "text": text, "tr": "", "richHtml": "", "enabled": True,
                 "x0": 10, "y0": 10 + (i - 1) * 25, "x1": 140, "y1": 30 + (i - 1) * 25,
                 "lineH": 20, "conf": 95, "bg": "auto"}
                for i, text in enumerate(['WHY ARE YOU', 'RUNNING AROUND', 'SO FRIVOLOUSLY,', 'MY CHILD?'], 1)]
    monkeypatch.setattr("comic_studio.main.recognize_image", fake_ocr)
    response = client.post(f"/api/projects/{project['id']}/ocr", json={"image_ids": [item['id']], "group_lines": True})
    assert response.status_code == 200, response.text
    blocks = response.json()['images'][0]['blocks']
    assert len(blocks) == 1 and len(blocks[0]['sourceLines']) == 4
    preview = client.post(f"/api/projects/{project['id']}/translation-preview", json={"image_ids": [item['id']], "provider": "free"}).json()
    assert preview['blockCount'] == 1
    assert preview['requests'][0]['text'] == 'WHY ARE YOU RUNNING AROUND SO FRIVOLOUSLY, MY CHILD?'
    assert len(client.get(f"/api/projects/{project['id']}").json()['images'][0]['blocks'][0]['sourceLines']) == 4
    separate = client.post(f"/api/projects/{project['id']}/ocr", json={"image_ids": [item['id']], "group_lines": False})
    assert separate.status_code == 200
    assert [block['text'] for block in separate.json()['images'][0]['blocks']] == ['WHY ARE YOU', 'RUNNING AROUND', 'SO FRIVOLOUSLY,', 'MY CHILD?']


def test_preview_signature_changes_when_source_line_boundaries_change(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project['images'][0]['blocks'] = [
        {'id': 1, 'text': 'A\nB', 'tr': 'old A', 'enabled': True},
        {'id': 2, 'text': 'C', 'tr': 'old B', 'enabled': True},
    ]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    request = {'image_ids': [item['id']], 'provider': 'free', 'source_language': 'eng'}
    before = client.post(f'{route}/translation-preview', json=request).json()
    project['images'][0]['blocks'][0]['text'] = 'A'
    project['images'][0]['blocks'][1]['text'] = 'B\nC'
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    after = client.post(f'{route}/translation-preview', json=request).json()
    assert before['requests'][0]['text'] == after['requests'][0]['text'] == 'A\nB\nC'
    assert before['signature'] != after['signature']
    monkeypatch.setattr(TranslationService, 'translate', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('must not send')))
    result = client.post(f'{route}/translate', json={**request, 'confirmation': before['signature']})
    assert result.status_code == 409


def test_ai_endpoint_retries_key_using_actual_block_boundaries(client, monkeypatch):
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    project['images'][0]['blocks'] = [
        {'id': 1, 'text': 'first\ncontinued', 'tr': 'old 1', 'enabled': True},
        {'id': 2, 'text': 'second', 'tr': 'old 2', 'enabled': True},
    ]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    assert client.put('/api/ai-settings', json={'provider': 'openai', 'providers': {'openai': {
        'base_url': 'http://local.test/v1', 'model': 'demo', 'profiles': [
            {'id': 'bad', 'api_key': 'bad'}, {'id': 'good', 'api_key': 'good'},
        ],
    }}}).status_code == 200
    keys = []
    def fake_post(url, **kwargs):
        key = kwargs['headers']['Authorization']; keys.append(key)
        text = 'یک\nدو' if key == 'Bearer bad' else 'یک\nادامه\nدو'
        return httpx.Response(200, json={'choices': [{'message': {'content': text}}]}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', fake_post)
    request = {'image_ids': [item['id']], 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post(f'{route}/translation-preview', json=request).json()
    result = client.post(f'{route}/translate', json={**request, 'confirmation': preview['signature']})
    assert result.status_code == 200, result.text
    assert keys == ['Bearer bad', 'Bearer good']
    assert [block['tr'] for block in result.json()['images'][0]['blocks']] == ['یک\nادامه', 'دو']


def test_one_paragraph_accepts_multiline_free_translation(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'One full paragraph', 'tr': '', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    monkeypatch.setattr(TranslationService, '_free', lambda self, text, source: 'بند اول\nادامهٔ ترجمه')
    result = client.post(f'{route}/translate', json={'image_ids': [item['id']], 'provider': 'free'})
    assert result.status_code == 200, result.text
    assert result.json()['images'][0]['blocks'][0]['tr'] == 'بند اول\nادامهٔ ترجمه'


def test_translation_does_not_overwrite_edits_made_during_request(client, monkeypatch):
    from comic_studio.store import ProjectStore
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'original', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200

    def translate_while_editing(self, text, language, provider=None):
        other_store = ProjectStore()
        current = other_store.get(project['id'])
        current['images'][0]['blocks'][0]['text'] = 'edited during translation'
        other_store.save(current)
        return 'ترجمه'

    monkeypatch.setattr(TranslationService, 'translate', translate_while_editing)
    response = client.post(f'{route}/translate', json={'image_ids': [item['id']], 'provider': 'free'})
    assert response.status_code == 409
    block = client.get(route).json()['images'][0]['blocks'][0]
    assert block['text'] == 'edited during translation' and block['tr'] == 'old'


def test_ocr_does_not_overwrite_edits_made_during_request(client, monkeypatch):
    from comic_studio.store import ProjectStore
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    preview = f"{route}/images/{item['id']}/content?edited=true"
    assert client.post(f"{route}/images/{item['id']}/rendered", content=png_bytes((320, 200), 'red')).status_code == 200

    def ocr_while_editing(*args):
        other_store = ProjectStore()
        current = other_store.get(project['id'])
        current['name'] = 'edited during OCR'
        other_store.save(current)
        return [{'id': 1, 'text': 'new OCR', 'enabled': True}]

    monkeypatch.setattr('comic_studio.main.recognize_image', ocr_while_editing)
    response = client.post(f'{route}/ocr', json={'image_ids': [item['id']]})
    assert response.status_code == 409
    saved = client.get(route).json()
    assert saved['name'] == 'edited during OCR' and saved['images'][0]['blocks'] == []
    assert client.get(preview).content == png_bytes((320, 200), 'red')


def test_failed_delete_save_keeps_original_and_rendered_files(client, monkeypatch):
    from comic_studio.store import ProjectStore
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    assert client.post(f"{route}/images/{item['id']}/rendered", content=png_bytes((320, 200), 'red')).status_code == 200
    store = ProjectStore()
    monkeypatch.setattr(store, 'save', lambda *_: (_ for _ in ()).throw(OSError('disk failure')))
    with pytest.raises(OSError, match='disk failure'):
        store.delete(project['id'], [item['id']])
    assert client.get(route).json()['images'][0]['id'] == item['id']
    assert client.get(f"{route}/images/{item['id']}/content").content == png_bytes()
    assert client.get(f"{route}/images/{item['id']}/content?edited=true").content == png_bytes((320, 200), 'red')


def test_partial_image_write_is_removed_on_import_failure(client, monkeypatch, tmp_path):
    from pathlib import Path
    from comic_studio.store import ProjectStore
    project, _ = make_project(client)
    image_dir = tmp_path / 'data' / 'projects' / project['id'] / 'images'
    before = {p.name for p in image_dir.iterdir()}
    original_write = Path.write_bytes
    def fail_after_partial_write(path, data):
        if path.parent == image_dir:
            original_write(path, b'partial')
            raise OSError('disk full')
        return original_write(path, data)
    monkeypatch.setattr(Path, 'write_bytes', fail_after_partial_write)
    with pytest.raises(OSError, match='disk full'):
        ProjectStore().import_files(project['id'], [('new.png', png_bytes())])
    assert {p.name for p in image_dir.iterdir()} == before
    assert len(client.get(f"/api/projects/{project['id']}").json()['images']) == 1


def test_import_does_not_overwrite_edits_made_during_request(client, monkeypatch, tmp_path):
    from comic_studio.store import ProjectStore
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    image_dir = tmp_path / 'data' / 'projects' / project['id'] / 'images'
    before = {p.name for p in image_dir.iterdir()}
    original_import = ProjectStore._import_image
    def import_while_editing(self, state, filename, content):
        original_import(self, state, filename, content)
        other_store = ProjectStore()
        current = other_store.get(project['id'])
        current['name'] = 'edited during import'
        other_store.save(current)
    monkeypatch.setattr(ProjectStore, '_import_image', import_while_editing)
    result = client.post(f'{route}/files', files=[('files', ('new.png', png_bytes(), 'image/png'))])
    assert result.status_code == 409, result.text
    saved = client.get(route).json()
    assert saved['name'] == 'edited during import'
    assert [entry['id'] for entry in saved['images']] == [item['id']]
    assert {p.name for p in image_dir.iterdir()} == before


def test_ai_page_failure_keeps_completed_pages_and_never_sends_later_pages(client, monkeypatch):
    from comic_studio.translation import TranslationError, TranslationService
    project, _ = make_project(client)
    response = client.post(f"/api/projects/{project['id']}/files", files=[
        ("files", ("second.png", png_bytes(), "image/png")),
        ("files", ("third.png", png_bytes(), "image/png")),
    ])
    project = response.json()
    for index, image in enumerate(project['images']):
        image['blocks'] = [{'id': 1, 'text': f'page-{index}', 'tr': f'old-{index}', 'richHtml': '<b>old</b>', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    calls = []
    def translate(self, text, language, provider=None, source_texts=None):
        calls.append(text)
        if text == 'page-1':
            raise TranslationError('timeout')
        return 'first saved'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    ids = [image['id'] for image in project['images']]
    request = {'image_ids': ids, 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post(f'{route}/translation-preview', json=request).json()
    assert len(preview['pages']) == 3
    for page in preview['pages']:
        single = client.post(f'{route}/translation-preview', json={**request, 'image_ids': [page['imageId']]}).json()
        assert page['signature'] == single['signature']
    response = client.post(f'{route}/translate', json={**request, 'confirmation': preview['signature']})
    assert response.status_code == 502
    assert calls == ['page-0', 'page-1']
    stored = client.get(route).json()['images']
    assert [image['blocks'][0]['tr'] for image in stored] == ['first saved', 'old-1', 'old-2']
    assert [image['blocks'][0]['richHtml'] for image in stored] == ['', '<b>old</b>', '<b>old</b>']
    assert any('درخواست 1 از 3' in entry['message'] and 'ذخیره شد' in entry['message'] for entry in client.get('/api/activity').json()['entries'])


def test_ai_page_confirmations_reject_stale_text_without_resending_completed_page(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    for index, image in enumerate(project['images']):
        # Blocks without IDs still receive stable per-page signatures.
        image['blocks'] = [{'text': f'original {index}', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    ids = [image['id'] for image in project['images']]
    preview = client.post(f'{route}/translation-preview', json={'image_ids': ids, 'provider': 'openai'}).json()
    calls = []
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None: calls.append(text) or 'saved')
    first = client.post(f'{route}/translate', json={'image_ids': [ids[0]], 'provider': 'openai', 'confirmation': preview['pages'][0]['signature']})
    assert first.status_code == 200, first.text
    changed = first.json()
    changed['images'][1]['blocks'][0]['tr'] = 'manual translation before page 2'
    assert client.put(f'{route}/state', json={'state': changed}).status_code == 200
    second = client.post(f'{route}/translate', json={'image_ids': [ids[1]], 'provider': 'openai', 'confirmation': preview['pages'][1]['signature']})
    assert second.status_code == 409
    assert calls == ['original 0']
    stored = client.get(route).json()
    assert stored['images'][0]['blocks'][0]['tr'] == 'saved'
    assert stored['images'][1]['blocks'][0]['tr'] == 'manual translation before page 2'


def test_ai_large_page_sends_paragraphs_separately_and_preserves_completed_results(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    sources = ['A' * 500, 'B' * 500, 'C' * 30]
    project['images'][0]['blocks'] = [
        {'id': i + 1, 'text': text, 'tr': f'old{i}', 'richHtml': '<b>old</b>', 'enabled': True}
        for i, text in enumerate(sources)
    ]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    request = {'image_ids': [item['id']], 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post(f'{route}/translation-preview', json=request).json()
    assert preview['requestCount'] == 3
    assert [entry['paragraph'] for entry in preview['requests']] == [1, 2, 3]
    assert [entry['text'].split('\n\n', 1)[1] for entry in preview['requests']] == sources
    calls = []
    def translate(self, text, language, provider=None, source_texts=None):
        calls.append(text)
        if text == sources[1]:
            raise RuntimeError('failure')
        return 'first translated'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    first = preview['tasks'][0]
    result = client.post(f'{route}/translate', json={**request, 'call_id': first['callId'], 'confirmation': first['signature']})
    assert result.status_code == 200, result.text
    assert [b['tr'] for b in result.json()['images'][0]['blocks']] == ['first translated', 'old1', 'old2']
    # A failing second request does not send the third or overwrite the first.
    second = preview['tasks'][1]
    with pytest.raises(RuntimeError, match='failure'):
        client.post(f'{route}/translate', json={**request, 'call_id': second['callId'], 'confirmation': second['signature']})
    assert calls == sources[:2]
    stored = client.get(route).json()['images'][0]['blocks']
    assert [block['tr'] for block in stored] == ['first translated', 'old1', 'old2']
    resumed = client.post(f'{route}/translation-preview', json=request).json()
    assert [entry['text'].split('\n\n', 1)[1] for entry in resumed['requests']] == sources[1:]
    # A manual edit to an earlier translation invalidates its completed receipt.
    edited = client.get(route).json(); edited['images'][0]['blocks'][0]['tr'] = 'manual edit'
    assert client.put(f'{route}/state', json={'state': edited}).status_code == 200
    fresh = client.post(f'{route}/translation-preview', json=request).json()
    assert [entry['text'].split('\n\n', 1)[1] for entry in fresh['requests']] == sources


def test_ai_threshold_is_inclusive_and_disabled_text_does_not_count(client):
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'x' * 999, 'enabled': True}, {'id': 2, 'text': 'y', 'enabled': False}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai'}
    assert client.post(f'{route}/translation-preview', json=req).json()['requestCount'] == 1
    project['images'][0]['blocks'][0]['text'] = 'x' * 1000
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    exact = client.post(f'{route}/translation-preview', json=req).json()
    assert len(exact['tasks']) == 1 and exact['tasks'][0]['callId'] == 'page'
    project['images'][0]['blocks'][0]['text'] = 'x' * 1001
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    above = client.post(f'{route}/translation-preview', json=req).json()
    assert len(above['tasks']) == 2 and all(len(r['text'].split('\n\n', 1)[1]) <= 1000 for r in above['requests'])


def test_ai_long_paragraph_recovery_preserves_completed_chunks_and_old_translation(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    source = 'alpha ' * 170 + '\n' + 'beta ' * 170
    project['images'][0]['blocks'] = [{'id': 1, 'text': source, 'tr': 'old', 'richHtml': '<b>old</b>', 'enabled': True}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert len(preview['tasks']) >= 2
    assert all(len(entry['text'].split('\n\n', 1)[1]) <= 1000 for entry in preview['requests'])
    calls = []
    def translate(self, text, language, provider=None, source_texts=None):
        calls.append(text)
        return f'part{len(calls)}'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    first = preview['tasks'][0]
    first_result = client.post(f'{route}/translate', json={**req, 'call_id': first['callId'], 'confirmation': first['signature']})
    assert first_result.status_code == 200, first_result.text
    partial = first_result.json()['images'][0]['blocks'][0]
    assert partial['tr'] == 'old' and partial['richHtml'] == '<b>old</b>'
    assert partial['_aiTranslationParts']['parts']['0'] == 'part1'
    # A fresh preview excludes already saved pieces, which prevents re-billing.
    again = client.post(f'{route}/translation-preview', json=req).json()
    assert len(again['tasks']) == len(preview['tasks']) - 1
    assert again['tasks'][0]['callId'] != first['callId']
    for task in again['tasks']:
        result = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
        assert result.status_code == 200, result.text
    complete = client.get(route).json()['images'][0]['blocks'][0]
    assert complete['tr'].startswith('part1') and f'part{len(calls)}' in complete['tr']
    assert '_aiTranslationParts' not in complete and complete['richHtml'] == ''
    assert len(calls) == len(preview['tasks'])


def test_single_block_ai_retranslation_splits_large_source_and_matches_preview(client, monkeypatch):
    from comic_studio.translation import TranslationService
    source = ('word ' * 450).strip()
    req = {'text': source, 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post('/api/translate-text/preview', json=req).json()
    pieces = [r['text'].split('\n\n', 1)[1] for r in preview['requests']]
    assert len(pieces) > 1 and all(len(piece) <= 1000 for piece in pieces)
    seen = []
    def translate(self, text, language, provider=None, source_texts=None):
        seen.append(text)
        return f'response{len(seen)}'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    result = client.post('/api/translate-text', json={**req, 'confirmation': preview['signature']})
    assert result.status_code == 200, result.text
    assert seen == pieces
    assert result.json()['text'] == ' '.join(f'response{i + 1}' for i in range(len(pieces)))


def test_portable_project_backup_restores_images_text_exports_and_browser_drafts(client, monkeypatch, tmp_path):
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    project['name'] = 'انتقال پروژه'
    project['images'][0].update({'crop': {'x': 1, 'y': 2, 'w': 150, 'h': 100}, 'groupId': 5})
    project['images'][0]['blocks'] = [{
        'id': 9, 'text': 'OCR text', 'tr': 'ترجمه', 'richHtml': '<p><b>ترجمه</b></p>',
        'enabled': True, 'verticalAlign': 'top', 'sourceLines': [{'text': 'OCR text'}],
        'x0': 5, 'y0': 5, 'x1': 150, 'y1': 40, 'lineH': 35,
    }]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    edited = png_bytes(color='yellow')
    assert client.post(f"{route}/images/{item['id']}/rendered", content=edited, headers={'Content-Type': 'image/png'}).status_code == 200
    export = client.post(f'{route}/export', json={'kind': 'txt', 'image_ids': [item['id']], 'name': 'completed'})
    assert export.status_code == 200, export.text
    assert client.put('/api/ai-settings', json={'provider':'openai', 'api_key':'secret-never-include'}).status_code == 200
    draft = {'imageId': item['id'], 'blockId': '9', 'mode': 'translation', 'value': {'html':'<p>draft</p>', 'base':'revision', 'time':'now', 'meta':{'align':'right'}}}
    result = client.post(f'{route}/backup', json={'drafts':[draft]})
    assert result.status_code == 200, result.text
    assert result.headers['content-type'].startswith('application/zip')
    zip_content = result.content
    with zipfile.ZipFile(io.BytesIO(zip_content)) as z:
        assert set(z.namelist()) == {'manifest.json', 'project.json', 'browser-drafts.json', f"images/{item['file']}", f"images/{item['id']}-edited.png", 'exports/completed.txt'}
        assert b'secret-never-include' not in b''.join(z.read(name) for name in z.namelist())
        assert z.read(f"images/{item['file']}") == png_bytes()
        assert z.read(f"images/{item['id']}-edited.png") == edited
    # A distinct data directory simulates the destination computer.
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path / 'destination'))
    with TestClient(create_app()) as destination:
        restored = destination.post('/api/projects/restore', files={'file':('backup.zip', zip_content, 'application/zip')})
        assert restored.status_code == 201, restored.text
        state = restored.json()['project']; assert state['id'] != project['id']
        assert state['images'][0]['crop'] == project['images'][0]['crop']
        assert state['images'][0]['groupId'] == 5
        assert state['images'][0]['blocks'] == project['images'][0]['blocks']
        assert restored.json()['drafts'] == [draft]
        restored_route = f"/api/projects/{state['id']}"
        assert destination.get(f"{restored_route}/images/{item['id']}/content").content == png_bytes()
        assert destination.get(f"{restored_route}/images/{item['id']}/content?edited=true").content == edited
        assert (tmp_path / 'destination' / 'projects' / state['id'] / 'exports' / 'completed.txt').exists()
        assert destination.get('/api/ai-settings').json()['hasApiKey'] is False
        state['images'][0]['blocks'][0]['tr'] = 'ادامه در سیستم تازه'
        assert destination.put(f'{restored_route}/state', json={'state': state}).status_code == 200
        out = destination.post(f'{restored_route}/export', json={'kind':'txt', 'image_ids':[item['id']], 'name':'continued'})
        assert out.status_code == 200 and 'ادامه در سیستم تازه' in out.text
        another = destination.post('/api/projects/restore', files={'file':('backup.zip', zip_content, 'application/zip')})
        assert another.status_code == 201 and another.json()['project']['id'] != state['id']
        assert destination.get(restored_route).json()['images'][0]['blocks'][0]['tr'] == 'ادامه در سیستم تازه'


def test_backup_rejects_missing_image_instead_of_producing_incomplete_zip(client, tmp_path):
    project, item = make_project(client)
    (tmp_path / 'data' / 'projects' / project['id'] / 'images' / item['file']).unlink()
    result = client.post(f"/api/projects/{project['id']}/backup", json={'drafts':[]})
    assert result.status_code == 400
    assert not list((tmp_path / 'data' / 'backup-temp').glob('*.zip'))


@pytest.mark.parametrize('bad_member', ['../escape.txt', '/absolute.txt', 'images/../../escape.txt', 'images\\escape.png', 'exports/../evil.txt', 'project.json'])
def test_restore_rejects_traversal_unknown_and_duplicate_members_atomically(client, bad_member, tmp_path):
    project, _ = make_project(client)
    backup = client.post(f"/api/projects/{project['id']}/backup", json={'drafts':[]}).content
    modified = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(backup)) as source, zipfile.ZipFile(modified, 'w') as target:
        for info in source.infolist(): target.writestr(info.filename, source.read(info))
        target.writestr(bad_member, b'evil')
    before = client.get('/api/projects').json()
    response = client.post('/api/projects/restore', files={'file':('bad.zip', modified.getvalue(), 'application/zip')})
    assert response.status_code == 400
    assert client.get('/api/projects').json() == before
    assert not (tmp_path / 'data' / 'escape.txt').exists()
    assert not list((tmp_path / 'data' / 'restore-staging').iterdir())


def test_restore_rejects_corrupt_and_missing_images_and_bad_manifest(client):
    project, item = make_project(client)
    backup = client.post(f"/api/projects/{project['id']}/backup", json={'drafts':[]}).content
    for action in ('missing', 'corrupt', 'version'):
        result = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(backup)) as original, zipfile.ZipFile(result, 'w') as target:
            for info in original.infolist():
                if action == 'missing' and info.filename == f"images/{item['file']}": continue
                value = original.read(info)
                if action == 'corrupt' and info.filename == f"images/{item['file']}": value = b'not a png'
                if action == 'version' and info.filename == 'manifest.json': value = b'{"format":"comic-ocr-studio-project","version":999}'
                target.writestr(info.filename, value)
        response = client.post('/api/projects/restore', files={'file':('broken.zip', result.getvalue(), 'application/zip')})
        assert response.status_code == 400, (action, response.text)
    assert len(client.get('/api/projects').json()) == 1


def test_restore_rejects_symlink_and_excessive_uncompressed_size(client, monkeypatch):
    from comic_studio import backup as backup_module
    project, _ = make_project(client)
    backup = client.post(f"/api/projects/{project['id']}/backup", json={'drafts':[]}).content
    buffer = io.BytesIO()
    import stat
    with zipfile.ZipFile(io.BytesIO(backup)) as original, zipfile.ZipFile(buffer, 'w') as target:
        for info in original.infolist(): target.writestr(info.filename, original.read(info))
        link = zipfile.ZipInfo('exports/evil.txt'); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        target.writestr(link, '../project.json')
    assert client.post('/api/projects/restore', files={'file':('evil.zip', buffer.getvalue(), 'application/zip')}).status_code == 400
    monkeypatch.setattr(backup_module, 'MAX_TOTAL', 1)
    assert client.post('/api/projects/restore', files={'file':('oversize.zip', backup, 'application/zip')}).status_code == 400
    assert len(client.get('/api/projects').json()) == 1


def test_backup_includes_unselected_pages_and_rejects_stale_revision(client):
    project, _ = make_project(client)
    route = f"/api/projects/{project['id']}"
    project = client.post(f'{route}/files', files={'files': ('second.png', png_bytes(color='red'), 'image/png')}).json()
    project['images'][1]['selected'] = False
    project = client.put(f'{route}/state', json={'state':project}).json()
    stale = client.post(f'{route}/backup', json={'drafts':[], 'expected_updated_at':'old revision'})
    assert stale.status_code == 409
    good = client.post(f'{route}/backup', json={'drafts':[], 'expected_updated_at':project['updatedAt']})
    assert good.status_code == 200
    with zipfile.ZipFile(io.BytesIO(good.content)) as archive:
        assert all(f"images/{item['file']}" in archive.namelist() for item in project['images'])
    result = client.post('/api/projects/restore', files={'file':('backup.zip', good.content, 'application/zip')})
    assert result.status_code == 201
    assert len(result.json()['project']['images']) == 2
    assert result.json()['project']['images'][1]['selected'] is False


def test_ai_policy_change_invalidates_confirmed_preview(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'hello', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    profile = {'id': 'a', 'api_key': 'secret', 'timeout_seconds': 90, 'retry_count': 0}
    assert client.put('/api/ai-settings', json={'provider': 'openai', 'providers': {'openai': {'profiles': [profile]}}}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    profile['retry_count'] = 2
    assert client.put('/api/ai-settings', json={'provider': 'openai', 'providers': {'openai': {'profiles': [profile]}}}).status_code == 200
    monkeypatch.setattr(TranslationService, 'translate', lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not send')))
    task = preview['tasks'][0]
    response = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
    assert response.status_code == 409


def test_ai_real_error_and_retries_reach_response_and_activity_without_secret(client, monkeypatch):
    secret = 'a-very-sensitive-api-key'
    settings = {'provider': 'avalai', 'providers': {'avalai': {'profiles': [
        {'id': 'first', 'name': 'حساب من', 'api_key': secret, 'timeout_seconds': 25, 'retry_count': 1}
    ]}}}
    assert client.put('/api/ai-settings', json=settings).status_code == 200
    monkeypatch.setattr('comic_studio.translation.time.sleep', lambda _: None)
    calls = []
    def post(url, **kwargs):
        calls.append(kwargs['timeout'])
        return httpx.Response(503, json={'error': {'message': f'maintenance: {secret}', 'code': 'service_busy'}},
                              headers={'x-request-id': 'req-123'}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', post)
    project, item = make_project(client)
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'hello', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'avalai'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    task = preview['tasks'][0]
    response = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
    assert response.status_code == 502
    assert calls == [25, 25]
    assert 'HTTP 503' in response.text and 'maintenance' in response.text and 'service_busy' in response.text and 'req-123' in response.text
    assert secret not in response.text
    feed = str(client.get('/api/activity').json())
    assert 'تکرار 1 از 1' in feed and 'HTTP 503' in feed
    assert secret not in feed
    assert client.get(route).json()['images'][0]['blocks'][0]['tr'] == 'old'
