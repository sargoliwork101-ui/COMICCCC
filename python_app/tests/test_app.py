from __future__ import annotations

import io
import zipfile

import httpx
import pymupdf
import pytest
from fastapi.testclient import TestClient
from support_client import scoped_client
from PIL import Image, ImageDraw

from comic_studio.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    with scoped_client(create_app()) as test_client:
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
    assert health.json()["version"] == "3.84"
    assert health.json()["scraping"] is False
    assert client.get("/").status_code == 200
    index_html = client.get("/").text
    assert "Comic OCR Studio" in index_html
    assert '<span class="ver">۳.۸۴ · Python</span>' in index_html
    assert 'class="action-group group-select"' in index_html
    assert 'class="action-group group-merge"' in index_html
    assert 'class="action-group group-approve"' in index_html
    assert 'class="action-group group-manage"' in index_html
    assert 'class="editor-head-group ehg-view"' in index_html
    assert 'class="editor-head-group ehg-finish"' in index_html
    assert 'class="overlay-mode-control"' not in index_html
    assert 'id="appModalInput"' in index_html
    assert 'class="box-sub-group bsg-select"' in index_html
    assert 'class="box-sub-group bsg-size"' in index_html
    assert 'class="box-sub-group bsg-align-h"' in index_html
    assert 'class="box-sub-group bsg-align-v"' in index_html
    blank_proj = client.post("/api/projects", json={"name": "   "}).json()
    assert blank_proj["name"] == "پروژهٔ کمیک"
    named_proj = client.post("/api/projects", json={"name": "  تن‌تن در تبت  "}).json()
    assert named_proj["name"] == "تن‌تن در تبت"
    assert 'id="dragGuideBtn"' in index_html
    assert 'id="approveSelectedBtn"' in index_html
    assert 'id="selectApprovedBtn"' in index_html
    assert 'id="editorApproveClose"' in index_html
    assert 'id="editorCancel"' in index_html
    assert 'id="exportPptxBtn"' in index_html
    assert 'id="pptxExportDialog"' in index_html
    assert 'id="helpTopBtn"' in index_html
    assert 'id="helpDialog"' in index_html
    assert 'id="helpMenuBtn"' not in index_html
    assert 'بک‌آپ شامل تصاویر، متن‌ها، پیش‌نمایش‌ها' not in index_html
    assert 'id="ocrSuitabilityPanel"' not in index_html
    assert 'id="ocrEngineTierGrid"' not in index_html
    assert 'id="ocrEngineFitBanner"' not in index_html
    assert '<select id="ocrPageMode"><option value="comic">' in index_html
    assert 'تشخیص خودکار' not in index_html
    assert 'id="ocrConfidence" type="number" min="0" max="0.95" step="0.05" value="0.35"' in index_html
    assert 'id="modelsPageMode"' in index_html
    assert 'id="modelsRamStatus"' in index_html
    assert 'id="freeModelsRamBtn"' in index_html
    assert 'id="modelsActiveProgressWrap"' in index_html
    assert 'id="ocrQuickProgressWrap"' in index_html
    assert 'id="engineNoticeProgressWrap"' in index_html
    engines_resp = client.get("/api/engines")
    assert engines_resp.status_code == 200
    engines_list = engines_resp.json()
    assert len(engines_list) == 13
    for eng in engines_list:
        suit = eng.get("suitability")
        assert isinstance(suit, dict)
        for mode in ("auto", "comic", "document"):
            assert suit[mode]["tier"] in {"best", "medium", "weak"}
            assert len(suit[mode]["reason"]) > 15
    help_js = client.get("/help-guide.js")
    assert help_js.status_code == 200
    assert "ComicHelpGuide" in help_js.text and "مثال عملی" in help_js.text
    assert client.get("/typeset.js").status_code == 200
    assert "no-store" in client.get("/").headers.get("cache-control", "")
    assert "no-store" in client.get("/typeset.js").headers.get("cache-control", "")
    from comic_studio.exporter import _box_inset_px
    assert abs(_box_inset_px(85) - 1.7) < 1e-6
    assert abs(_box_inset_px(200) - 4.0) < 1e-6
    assert abs(_box_inset_px(500) - 4.0) < 1e-6


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
    # A single unbroken 600-character line must never be cut mid-line.
    assert response.status_code == 502


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
    monkeypatch.setattr(TranslationService, "translate_free_batch", lambda self, request, text, sources, source_language, policy: calls.append(text) or "پاسخ تکی")
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

    def fake_free(self, request, text, sources, source_language, policy):
        calls.append(text)
        return "سلام\nدر دو خط\nدنیا\nحباب دیگر"

    monkeypatch.setattr(TranslationService, "translate_free_batch", fake_free)
    preview = client.post(f"/api/projects/{project['id']}/translation-preview", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng"}).json()
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng", "confirmation": preview["signature"]})
    assert response.status_code == 200, response.text
    assert calls == ["Hello\nin two lines\nworld\nAnother bubble"]
    blocks = response.json()["images"][0]["blocks"]
    assert [block["tr"] for block in blocks] == ["سلام\nدر دو خط", "دنیا", "حباب دیگر"]
    assert all(block["richHtml"] == "" for block in blocks)
    assert all(TRANSLATION_SEPARATOR not in block["tr"] and "&#10" not in block["tr"] and "[[[" not in block["tr"] for block in blocks)
    feed = client.get("/api/activity?after=0").json()["entries"]
    assert any("ذخیره شد" in entry["message"] for entry in feed)
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

    def fake_free(self, request, text, source_texts, source_language, policy):
        calls.append(text)
        return "اول" if text == sources[0] else "دوم"

    monkeypatch.setattr(TranslationService, "translate_free_batch", fake_free)
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
    monkeypatch.setattr(TranslationService, "translate_free_batch", lambda self, request, text, sources, source_language, policy: "یک دو")
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

    def fake_translate(self, text, source_language, provider=None, source_texts=None, skill=None):
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
    monkeypatch.setattr(TranslationService, "translate", lambda self, text, source_language, provider=None, source_texts=None, skill=None: "یک دو")
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


def test_all_models_auto_download_hardware_gate_and_updates_api(client, monkeypatch):
    import json as _json

    monkeypatch.setenv(
        "COMIC_STUDIO_FAKE_HARDWARE_JSON",
        _json.dumps({"hasNvidiaGpu": False, "gpuNames": [], "vramGb": 0.0, "diskFreeGb": 60.0, "os": "linux", "arch": "x86_64"}),
    )
    response = client.get("/api/engines")
    assert response.status_code == 200
    engines = {entry["id"]: entry for entry in response.json()}
    assert "paddleocr-vl-1-6" in engines
    assert all(entry["selectable"] is True for entry in engines.values())
    assert engines["olmocr"]["requiresNvidiaGpu"] is True
    assert engines["olmocr"]["hardwareCheck"]["compatible"] is False

    # Heavy GPU model without force returns 409 hardware_warning with Persian message
    warn_res = client.post("/api/engines/olmocr/download", json={"language": "eng"})
    assert warn_res.status_code == 409
    warn_body = warn_res.json()
    assert warn_body["kind"] == "hardware_warning"
    assert any("NVIDIA" in msg for msg in warn_body["warnings"])

    # With force=True, proceeds to registry.download
    downloaded = []
    monkeypatch.setattr(
        "comic_studio.ocr.EngineRegistry.download",
        lambda self, engine_id, language: downloaded.append((engine_id, language)),
    )
    forced_res = client.post("/api/engines/olmocr/download", json={"language": "eng", "force": True})
    assert forced_res.status_code == 200
    assert forced_res.json()["ok"] is True
    assert downloaded == [("olmocr", "eng")]

    # CPU-friendly advanced model downloads directly without needing force
    cpu_adv_res = client.post("/api/engines/glm-ocr/download", json={"language": "eng"})
    assert cpu_adv_res.status_code == 200
    assert cpu_adv_res.json()["ok"] is True
    assert downloaded[-1] == ("glm-ocr", "eng")

    # Hardware summary, check-updates, and update endpoints
    hw_res = client.get("/api/engines/hardware")
    assert hw_res.status_code == 200
    assert hw_res.json()["freeDiskGb"] == 60.0

    monkeypatch.setattr(
        "comic_studio.ocr.EngineRegistry.check_updates",
        lambda self, force=False: {"checkedAt": 123456.0, "cached": not force, "updates": [], "updatesCount": 0, "engines": self.status()},
    )
    chk_res = client.post("/api/engines/check-updates", json={"force": True})
    assert chk_res.status_code == 200
    assert chk_res.json()["updatesCount"] == 0

    updated = []
    monkeypatch.setattr(
        "comic_studio.ocr.EngineRegistry.update",
        lambda self, engine_id, language="eng": updated.append((engine_id, language)),
    )
    upd_res = client.post("/api/engines/glm-ocr/update", json={"language": "kor"})
    assert upd_res.status_code == 200
    assert upd_res.json()["ok"] is True
    assert updated == [("glm-ocr", "kor")]


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
            {'id': 'bad', 'api_key': 'bad', 'retry_wait_seconds': 0}, {'id': 'good', 'api_key': 'good'},
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
    monkeypatch.setattr(TranslationService, 'translate_free_batch', lambda self, request, text, sources, source, policy: 'بند اول\nادامهٔ ترجمه')
    result = client.post(f'{route}/translate', json={'image_ids': [item['id']], 'provider': 'free'})
    assert result.status_code == 200, result.text
    assert result.json()['images'][0]['blocks'][0]['tr'] == 'بند اول\nادامهٔ ترجمه'


def test_translation_output_is_returned_if_project_save_hits_a_file_lock(client, monkeypatch):
    import comic_studio.store as store_module
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'original', 'tr': 'old translation', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    assert client.put('/api/ai-settings', json={'provider': 'openai', 'api_key': 'test-key'}).status_code == 200
    monkeypatch.setattr(TranslationService, 'translate', lambda *args, **kwargs: 'new translation')
    real_atomic_json = store_module.atomic_json

    def deny_project_replace(path, value):
        if path.name == 'project.json':
            raise PermissionError(5, 'Access is denied')
        return real_atomic_json(path, value)

    monkeypatch.setattr(store_module, 'atomic_json', deny_project_replace)
    response = client.post(f'{route}/translate', json={'image_ids': [item['id']], 'provider': 'openai'})
    assert response.status_code == 507
    assert response.json()['translation'] == 'new translation'
    assert client.get(route).json()['images'][0]['blocks'][0]['tr'] == 'old translation'


def test_translation_does_not_overwrite_edits_made_during_request(client, monkeypatch):
    from comic_studio.store import ProjectStore
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'original', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200

    def translate_while_editing(self, request, text, sources, language, policy):
        other_store = ProjectStore()
        current = other_store.get(project['id'])
        current['images'][0]['blocks'][0]['text'] = 'edited during translation'
        other_store.save(current)
        return 'ترجمه'

    monkeypatch.setattr(TranslationService, 'translate_free_batch', translate_while_editing)
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
    assert response.status_code == 200, response.text
    saved = client.get(route).json()
    assert saved['name'] == 'edited during OCR' and saved['images'][0]['blocks'][0]['text'] == 'new OCR'
    assert client.get(preview).status_code == 404


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
    assert result.status_code == 200, result.text
    saved = client.get(route).json()
    assert saved['name'] == 'edited during import'
    assert len(saved['images']) == 2 and saved['images'][0]['id'] == item['id']
    assert saved['images'][1]['order'] == 1
    assert len({p.name for p in image_dir.iterdir()} - before) == 1


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
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
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
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: calls.append(text) or 'saved')
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


def test_ai_large_page_groups_paragraphs_and_preserves_completed_results(client, monkeypatch):
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
    assert preview['requestCount'] == 2
    assert [entry['paragraph'] for entry in preview['requests']] == [1, 2]
    assert [entry['text'].split('\n\n', 1)[1] for entry in preview['requests']] == [sources[0], sources[1] + '\n' + sources[2]]
    calls = []
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
        calls.append(text)
        if text.startswith(sources[1]):
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
    assert calls == [sources[0], sources[1] + '\n' + sources[2]]
    stored = client.get(route).json()['images'][0]['blocks']
    assert [block['tr'] for block in stored] == ['first translated', 'old1', 'old2']
    resumed = client.post(f'{route}/translation-preview', json=request).json()
    assert [entry['text'].split('\n\n', 1)[1] for entry in resumed['requests']] == [sources[1] + '\n' + sources[2]]
    # A manual edit to an earlier translation invalidates its completed receipt.
    edited = client.get(route).json(); edited['images'][0]['blocks'][0]['tr'] = 'manual edit'
    assert client.put(f'{route}/state', json={'state': edited}).status_code == 200
    fresh = client.post(f'{route}/translation-preview', json=request).json()
    assert [entry['text'].split('\n\n', 1)[1] for entry in fresh['requests']] == [sources[0], sources[1] + '\n' + sources[2]]


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
    above = client.post(f'{route}/translation-preview', json=req)
    assert above.status_code == 502 and 'سقف' in above.json()['detail']


def test_ai_long_paragraph_recovery_preserves_completed_chunks_and_old_translation(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    source = 'alpha ' * 140 + '.\n' + 'beta ' * 140 + '.'
    project['images'][0]['blocks'] = [{'id': 1, 'text': source, 'tr': 'old', 'richHtml': '<b>old</b>', 'enabled': True}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert len(preview['tasks']) >= 2
    assert all(len(entry['text'].split('\n\n', 1)[1]) <= 1000 for entry in preview['requests'])
    calls = []
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
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
    source = '\n'.join([('word ' * 150).strip() + '.'] * 3)
    req = {'text': source, 'provider': 'openai', 'source_language': 'eng'}
    preview = client.post('/api/translate-text/preview', json=req).json()
    pieces = [r['text'].split('\n\n', 1)[1] for r in preview['requests']]
    assert len(pieces) > 1 and all(len(piece) <= 1000 for piece in pieces)
    seen = []
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
        seen.append(text)
        return f'response{len(seen)}'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    result = client.post('/api/translate-text', json={**req, 'confirmation': preview['signature']})
    assert result.status_code == 200, result.text
    assert seen == pieces
    assert result.json()['text'] == '\n'.join(f'response{i + 1}' for i in range(len(pieces)))


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
    with scoped_client(create_app()) as destination:
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


def test_ai_exact_duplicates_applied_across_pages_without_cross_page_payload(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, first = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[
        ('files', ('second.png', png_bytes(), 'image/png')),
        ('files', ('third.png', png_bytes(), 'image/png')),
    ]).json()
    sources = [['REPEATED TITLE', 'first content'], ['REPEATED TITLE', 'second content'], ['REPEATED TITLE']]
    for image, texts in zip(project['images'], sources):
        image['blocks'] = [{'id': i + 1, 'text': text, 'tr': 'old', 'richHtml': '', 'enabled': True} for i, text in enumerate(texts)]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai', 'source_language': 'eng', 'reuse_repeated': True}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert preview['duplicateCount'] == 2 and len(preview['tasks']) == 2
    payloads = [r['text'].split('\n\n', 1)[1] for r in preview['requests']]
    assert payloads == ['REPEATED TITLE\nfirst content', 'second content']
    assert set(preview['tasks'][0]['affectedImageIds']) == set(ids)
    calls = []
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
        calls.append(text)
        return 'عنوان مشترک\nمحتوای اول' if text.startswith('REPEATED') else 'محتوای دوم'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    def send(task):
        return client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
    first_result = send(preview['tasks'][0]); assert first_result.status_code == 200, first_result.text
    state = first_result.json()
    assert [image['blocks'][0]['tr'] for image in state['images']] == ['عنوان مشترک'] * 3
    resumed = client.post(f'{route}/translation-preview', json={**req, 'image_ids': ids[1:]}).json()
    assert [r['text'].split('\n\n', 1)[1] for r in resumed['requests']] == ['second content']
    second_result = send(preview['tasks'][1]); assert second_result.status_code == 200, second_result.text
    assert calls == payloads
    assert second_result.json()['images'][1]['blocks'][1]['tr'] == 'محتوای دوم'
    # Re-translating the original and copies must propagate the new result too.
    fresh = client.post(f'{route}/translation-preview', json=req).json()
    assert fresh['duplicateCount'] == 2
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: 'عنوان جدید\nمحتوای اول')
    again = send(fresh['tasks'][0]); assert again.status_code == 200, again.text
    assert [image['blocks'][0]['tr'] for image in again.json()['images']] == ['عنوان جدید'] * 3
    # The opt-out really sends the repeated texts separately, and applies no reuse.
    disabled = client.post(f'{route}/translation-preview', json={**req, 'reuse_repeated': False}).json()
    assert disabled['duplicateCount'] == 0 and len(disabled['tasks']) == 3
    assert sum('REPEATED TITLE' in r['text'] for r in disabled['requests']) == 3


def test_ai_duplicate_propagation_rejects_concurrent_edit(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    for image in project['images']:
        image['blocks'] = [{'id': 1, 'text': 'SAME', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai', 'reuse_repeated': True}
    task = client.post(f'{route}/translation-preview', json=req).json()['tasks'][0]
    edited = client.get(route).json(); edited['images'][1]['blocks'][0]['tr'] = 'manual'
    assert client.put(f'{route}/state', json={'state': edited}).status_code == 200
    monkeypatch.setattr(TranslationService, 'translate', lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not send')))
    result = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
    assert result.status_code == 409
    assert client.get(route).json()['images'][1]['blocks'][0]['tr'] == 'manual'


def test_ai_duplicate_long_text_propagates_only_when_all_parts_finish(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    for image in project['images']:
        image['blocks'] = [{'id': 1, 'text': 'x' * 500 + '.\n' + 'y' * 500 + '.', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai', 'reuse_repeated': True}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert len(preview['tasks']) == 2 and preview['duplicateCount'] == 1
    lengths = [len(r['text'].split('\n\n', 1)[1]) for r in preview['requests']]
    assert min(lengths) >= 500 and max(lengths) <= 1000
    sent = []
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: sent.append(text) or f'part{len(sent)}')
    for index, task in enumerate(preview['tasks']):
        response = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
        assert response.status_code == 200, response.text
        values = [image['blocks'][0]['tr'] for image in response.json()['images']]
        if index == 0:
            assert values == ['old', 'old']
        else:
            assert values == ['part1\npart2', 'part1\npart2']
    assert len(sent) == 2


def test_ai_reuse_marker_invalidated_when_translation_or_model_changes(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    for image in project['images']:
        image['blocks'] = [{'id': 1, 'text': 'same title', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai', 'reuse_repeated': True}
    task = client.post(f'{route}/translation-preview', json=req).json()['tasks'][0]
    monkeypatch.setattr(TranslationService, 'translate', lambda *a, **k: 'عنوان')
    assert client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']}).status_code == 200
    remaining = {**req, 'image_ids': ids[1:]}
    assert client.post(f'{route}/translation-preview', json=remaining).json()['requestCount'] == 0
    edited = client.get(route).json(); edited['images'][1]['blocks'][0]['tr'] = 'edited manually'
    assert client.put(f'{route}/state', json={'state': edited}).status_code == 200
    assert client.post(f'{route}/translation-preview', json=remaining).json()['requestCount'] == 1


def test_ai_resume_later_page_retains_group_checkpoints_and_reused_title(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    project['images'][0]['blocks'] = [{'id': 1, 'text': 'TITLE', 'tr': '', 'enabled': True}]
    project['images'][1]['blocks'] = [
        {'id': 1, 'text': 'TITLE', 'tr': '', 'enabled': True},
        {'id': 2, 'text': 'A' * 600, 'tr': '', 'enabled': True},
        {'id': 3, 'text': 'B' * 600, 'tr': '', 'enabled': True},
        {'id': 4, 'text': 'SHORT', 'tr': '', 'enabled': True},
    ]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai', 'reuse_repeated': True}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert len(preview['tasks']) == 3
    calls = []
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
        calls.append(text)
        return 'عنوان' if text == 'TITLE' else 'بخش الف'
    monkeypatch.setattr(TranslationService, 'translate', translate)
    for task in preview['tasks'][:2]:
        result = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
        assert result.status_code == 200, result.text
    later = client.post(f'{route}/translation-preview', json={**req, 'image_ids': ids[1:]}).json()
    assert [r['text'].split('\n\n', 1)[1] for r in later['requests']] == ['B' * 600 + '\nSHORT']
    assert len(later['tasks']) == 1
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: 'بخش ب\nکوتاه')
    task = later['tasks'][0]
    result = client.post(f'{route}/translate', json={**req, 'image_ids': ids[1:], 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
    assert result.status_code == 200, result.text
    assert [b['tr'] for b in result.json()['images'][1]['blocks']] == ['عنوان', 'بخش الف', 'بخش ب', 'کوتاه']


def test_reuse_setting_persists_and_opt_out_translates_each_page_independently(client, monkeypatch):
    from comic_studio.translation import TranslationService
    saved = client.put('/api/ai-settings', json={'provider': 'openai', 'reuse_repeated': False})
    assert saved.status_code == 200 and saved.json()['reuse_repeated'] is False
    assert client.get('/api/ai-settings').json()['reuse_repeated'] is False
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    for image in project['images']:
        image['blocks'] = [{'id': 1, 'text': 'same', 'tr': 'old', 'enabled': True}]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert preview['reuseRepeated'] is False and len(preview['tasks']) == 2
    calls = []
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: calls.append(text) or f'translated-{len(calls)}')
    for task in preview['tasks']:
        response = client.post(f'{route}/translate', json={**req, 'reuse_repeated': False, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
        assert response.status_code == 200, response.text
    assert calls == ['same', 'same']
    assert [image['blocks'][0]['tr'] for image in response.json()['images']] == ['translated-1', 'translated-2']


def test_preview_standalone_page_signature_handles_within_page_and_cross_page_duplicates(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    project['images'][0]['blocks'] = [{'id': i, 'text': 'same', 'tr': '', 'enabled': True} for i in (1, 2)]
    project['images'][1]['blocks'] = [{'id': 1, 'text': 'same', 'tr': '', 'enabled': True}]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    preview = client.post(f'{route}/translation-preview', json={'image_ids': ids, 'provider': 'openai'}).json()
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: 'ترجمه')
    response = client.post(f'{route}/translate', json={'image_ids': ids[:1], 'provider': 'openai', 'confirmation': preview['pages'][0]['signature']})
    assert response.status_code == 200, response.text
    assert [block['tr'] for block in response.json()['images'][0]['blocks']] == ['ترجمه', 'ترجمه']
    assert response.json()['images'][1]['blocks'][0]['tr'] == ''


def test_ai_per_key_limit_uses_smallest_active_key_and_complete_sentence_lines(client, monkeypatch):
    from comic_studio.translation import TranslationService
    saved = client.put('/api/ai-settings', json={'provider': 'openai', 'providers': {'openai': {'profiles': [
        {'id': 'large', 'api_key': 'key1', 'source_limit': 130},
        {'id': 'small', 'api_key': 'key2', 'source_limit': 100},
        {'id': 'inactive', 'source_limit': 5},
    ]}}})
    assert saved.status_code == 200, saved.text
    assert [p['source_limit'] for p in saved.json()['providers']['openai']['profiles']] == [130, 100, 5]
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    source = 'A' * 65 + '\n' + 'B' * 10 + '.\n' + 'C' * 60 + '.'
    project['images'][0]['blocks'] = [{'id': 1, 'text': source, 'tr': '', 'enabled': True}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert preview['sourceLimit'] == 100
    chunks = [r['text'].split('\n\n', 1)[1] for r in preview['requests']]
    assert chunks == ['A' * 65 + '\n' + 'B' * 10 + '.', 'C' * 60 + '.']
    assert all(len(chunk) <= 100 for chunk in chunks)
    assert '\n'.join(chunks) == source
    seen = []
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: seen.append(text) or f'result{len(seen)}')
    for task in preview['tasks']:
        response = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
        assert response.status_code == 200, response.text
    assert seen == chunks and response.json()['images'][0]['blocks'][0]['tr'] == 'result1\nresult2'


def test_ai_oversize_unbroken_line_or_sentence_is_rejected_before_any_send(client, monkeypatch):
    from comic_studio.translation import TranslationService
    assert client.put('/api/ai-settings', json={'provider': 'openai', 'providers': {'openai': {'profiles': [{'id': 'a', 'api_key': 'test-key', 'source_limit': 50}]}}}).status_code == 200
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    seen = []; monkeypatch.setattr(TranslationService, 'translate', lambda *a, **kw: seen.append(a) or 'result')
    for source in ('x' * 51, 'first line is unfinished\n' + 'continued ' * 4 + '.'):
        project['images'][0]['blocks'] = [{'id': 1, 'text': source, 'tr': 'old', 'enabled': True}]
        assert client.put(f'{route}/state', json={'state': project}).status_code == 200
        req = {'image_ids': [item['id']], 'provider': 'openai'}
        for endpoint in ('translation-preview', 'translate'):
            response = client.post(f'{route}/{endpoint}', json=req)
            assert response.status_code == 502 and 'سقف 50' in response.json()['detail']
        response = client.post('/api/translate-text/preview', json={'text': source, 'provider': 'openai'})
        assert response.status_code == 502
        assert client.get(route).json()['images'][0]['blocks'][0]['tr'] == 'old'
    assert seen == []


def test_changed_limit_invalidates_preview_and_prior_chunk_boundaries(client, monkeypatch):
    from comic_studio.translation import TranslationService
    def settings(limit):
        return {'provider': 'openai', 'providers': {'openai': {'profiles': [{'id': 'a', 'api_key': 'test-key', 'source_limit': limit}]}}}
    assert client.put('/api/ai-settings', json=settings(200)).status_code == 200
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    project['images'][0]['blocks'] = [{'id': 1, 'text': '\n'.join([('x' * 88) + '.'] * 3), 'tr': 'old', 'enabled': True}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai'}
    preview = client.post(f'{route}/translation-preview', json=req).json(); assert len(preview['tasks']) == 2
    monkeypatch.setattr(TranslationService, 'translate', lambda *a, **kw: 'partial')
    task = preview['tasks'][0]
    result = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
    assert result.status_code == 200 and result.json()['images'][0]['blocks'][0]['tr'] == 'old'
    assert client.put('/api/ai-settings', json=settings(100)).status_code == 200
    old_next = preview['tasks'][1]
    result = client.post(f'{route}/translate', json={**req, 'call_id': old_next['callId'], 'confirmation': old_next['signature']})
    assert result.status_code == 409
    fresh = client.post(f'{route}/translation-preview', json=req).json()
    assert len(fresh['tasks']) == 3 and fresh['sourceLimit'] == 100
    task = fresh['tasks'][0]
    result = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
    assert result.status_code == 200
    assert result.json()['images'][0]['blocks'][0]['_aiTranslationParts']['parts'] == {'0': 'partial'}


def test_merged_ocr_uses_verified_original_line_endings_for_safe_boundaries(client, monkeypatch):
    from comic_studio.translation import TranslationService
    assert client.put('/api/ai-settings', json={'provider': 'openai', 'providers': {'openai': {'profiles': [{'id': 'a', 'api_key': 'test', 'source_limit': 80}]}}}).status_code == 200
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    lines = [{'text': 'A' * 59 + '.'}, {'text': 'B' * 59 + '.'}]
    source = ' '.join(line['text'] for line in lines)
    project['images'][0]['blocks'] = [{'id': 1, 'text': source, 'sourceLines': lines, 'tr': '', 'enabled': True}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert [r['text'].split('\n\n', 1)[1] for r in preview['requests']] == [line['text'] for line in lines]
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: 'tr1' if text.startswith('A') else 'tr2')
    for task in preview['tasks']:
        response = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']})
        assert response.status_code == 200, response.text
    assert response.json()['images'][0]['blocks'][0]['tr'] == 'tr1 tr2'
    single = {'text': source, 'source_lines': lines, 'provider': 'openai'}
    single_preview = client.post('/api/translate-text/preview', json=single).json()
    assert [r['text'].split('\n\n', 1)[1] for r in single_preview['requests']] == [line['text'] for line in lines]
    result = client.post('/api/translate-text', json={**single, 'confirmation': single_preview['signature']})
    assert result.status_code == 200 and result.json()['text'] == 'tr1 tr2'
    # An edited text cannot rely on obsolete OCR line metadata.
    assert client.post('/api/translate-text/preview', json={**single, 'text': source + ' edited'}).status_code == 502
    changed = client.post('/api/translate-text', json={**single, 'source_lines': list(reversed(lines)), 'confirmation': single_preview['signature']})
    assert changed.status_code == 502  # invalid metadata is never used to split an edited line


def test_skill_preview_confirmation_applies_to_every_page_and_reused_translation_cache(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    project = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    for image in project['images']:
        image['blocks'] = [{'id': 1, 'text': 'same title', 'tr': '', 'enabled': True}, {'id': 2, 'text': 'other ' + image['id'], 'tr': '', 'enabled': True}]
    route = f"/api/projects/{project['id']}"; ids = [image['id'] for image in project['images']]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': ids, 'provider': 'openai', 'skill': '  لحن رسمی  '}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    assert preview['skill'] == 'لحن رسمی' and preview['skill'] in preview['systemPrompt'] and preview['defaultSkill']
    seen = []
    def translate(self, text, language, provider=None, source_texts=None, skill=None):
        seen.append((text, skill))
        return '\n'.join('ترجمه' for _ in text.split('\n'))
    monkeypatch.setattr(TranslationService, 'translate', translate)
    for task in preview['tasks']:
        before = len(seen)
        altered = client.post(f'{route}/translate', json={**req, 'skill': 'لحن متفاوت', 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
        assert altered.status_code == 409 and len(seen) == before
        result = client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'call_image_id': task['imageId'], 'confirmation': task['signature']})
        assert result.status_code == 200, result.text
    assert len(seen) == 2 and all(skill == 'لحن رسمی' for _, skill in seen)
    remaining = {**req, 'image_ids': ids[1:]}
    same = client.post(f'{route}/translation-preview', json=remaining).json()
    changed = client.post(f'{route}/translation-preview', json={**remaining, 'skill': 'لحن محاوره‌ای'}).json()
    assert same['duplicateCount'] == 0 and 'same title' not in ' '.join(r['text'] for r in same['requests'])
    assert 'same title' in ' '.join(r['text'] for r in changed['requests'])
    # A page containing only a reused translation has no pending calls, but
    # still needs to expose the instructions that produced that empty plan.
    state = client.get(route).json()
    state['images'][1]['blocks'][1]['enabled'] = False
    assert client.put(f'{route}/state', json={'state': state}).status_code == 200
    empty = client.post(f'{route}/translation-preview', json=remaining).json()
    assert empty['requests'] == [] and empty['tasks'] == []
    assert 'لحن رسمی' in empty['systemPrompt']
    different = client.post(f'{route}/translation-preview', json={**remaining, 'skill': 'لحن محاوره‌ای'}).json()
    assert len(different['requests']) == 1 and 'same title' in different['requests'][0]['text']


def test_skill_change_invalidates_partial_checkpoint_and_single_text_confirmation(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    source = 'A' * 800 + '.\n' + 'B' * 800 + '.'
    project['images'][0]['blocks'] = [{'id': 1, 'text': source, 'tr': 'old', 'enabled': True}]
    assert client.put(f'{route}/state', json={'state': project}).status_code == 200
    req = {'image_ids': [item['id']], 'provider': 'openai', 'skill': 'first'}
    preview = client.post(f'{route}/translation-preview', json=req).json()
    seen = []
    monkeypatch.setattr(TranslationService, 'translate', lambda self, text, language, provider=None, source_texts=None, skill=None: seen.append(skill) or 'partial')
    task = preview['tasks'][0]
    assert client.post(f'{route}/translate', json={**req, 'call_id': task['callId'], 'confirmation': task['signature']}).status_code == 200
    assert len(client.post(f'{route}/translation-preview', json=req).json()['tasks']) == 1
    assert len(client.post(f'{route}/translation-preview', json={**req, 'skill': 'second'}).json()['tasks']) == 2
    single = {'text': 'Hello', 'provider': 'openai', 'skill': 'first'}
    one = client.post('/api/translate-text/preview', json=single).json()
    assert client.post('/api/translate-text', json={**single, 'skill': 'second', 'confirmation': one['signature']}).status_code == 409
    assert client.post('/api/translate-text', json={**single, 'confirmation': one['signature']}).status_code == 200
    assert seen == ['first', 'first']
    assert client.post('/api/translate-text/preview', json={**single, 'skill': 'x' * 4001}).status_code == 422


def test_ocr_records_completed_even_when_no_text_and_leaves_other_images(client, monkeypatch):
    project, item = make_project(client)
    more = client.post(f"/api/projects/{project['id']}/files", files=[('files', ('second.png', png_bytes(), 'image/png'))]).json()
    more['images'][0]['blocks'] = [{'id':1,'text':'manual text','tr':'existing','enabled':True}]
    route=f"/api/projects/{more['id']}"
    client.put(route+'/state',json={'state':more})
    monkeypatch.setattr('comic_studio.main.recognize_image', lambda *args: [])
    result=client.post(route+'/ocr',json={'image_ids':[more['images'][1]['id']], 'engine':'rapidocr-v6', 'language':'eng'})
    assert result.status_code==200, result.text
    assert result.json()['images'][1]['ocrCompleted'] is True
    assert result.json()['images'][1]['blocks'] == []
    assert result.json()['images'][0]['blocks'][0]['tr'] == 'existing'
    # UI snapshots cannot accidentally delete or forge the server-owned marker.
    incoming=result.json(); incoming['images'][1].pop('ocrCompleted')
    client.put(route+'/state',json={'state':incoming})
    assert client.get(route).json()['images'][1]['ocrCompleted'] is True


def test_unexpected_error_reports_stage_type_and_location_without_keys(tmp_path, monkeypatch):
    from comic_studio.translation import TranslationService
    monkeypatch.setenv('COMIC_STUDIO_DATA',str(tmp_path))
    with scoped_client(create_app(), raise_server_exceptions=False) as client:
        settings=client.put('/api/ai-settings',json={'provider':'openai','api_key':'test-private-key-xyz'})
        assert settings.status_code==200
        project,item=make_project(client)
        project['images'][0]['blocks']=[{'id':1,'text':'hello','tr':'','enabled':True}]
        route=f"/api/projects/{project['id']}"
        client.put(route+'/state',json={'state':project})
        def broken(self):
            raise RuntimeError('diagnostic provider broke: test-private-key-xyz https://example.test/path?api_key=test-private-key-xyz')
        monkeypatch.setattr(TranslationService,'public_settings',broken)
        result=client.post(route+'/context-preview',json={'image_ids':[item['id']],'provider':'openai','skill':'','summary':''})
        assert result.status_code==500, result.text
        assert 'RuntimeError' in result.text and 'diagnostic provider broke' in result.text and 'test_app.py' in result.text
        assert 'test-private-key-xyz' not in result.text and '[REDACTED]' in result.text
        assert result.json()['error_id']


def test_ocr_real_conflict_persists_and_offers_choice(client, monkeypatch):
    from comic_studio.store import ProjectStore
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    calls = []
    def fake(*args):
        calls.append(1); other = ProjectStore(); state = other.get(project['id'])
        state['images'][0]['blocks'] = [{'id':7, 'text':'user edit', 'tr':'', 'enabled':True}]
        other.save(state); return [{'id':1, 'text':'generated OCR', 'enabled':True}]
    monkeypatch.setattr('comic_studio.main.recognize_image', fake)
    response = client.post(route+'/ocr', json={'image_ids':[item['id']]})
    assert response.status_code == 409, response.text
    token = response.json()['pending_id']
    assert client.post(route+'/ocr', json={'image_ids':[item['id']]}).json()['pending_id'] == token
    assert len(calls) == 1
    view = client.get(route+'/pending/'+token).json()
    assert view['rows'][0]['conflict'] and view['rows'][0]['current'] == 'user edit'
    result = client.post(route+'/pending/'+token+'/resolve', json={'revision':view['revision'],'choices':{item['id']:'apply'}})
    assert result.status_code == 200, result.text
    assert result.json()['project']['images'][0]['blocks'][0]['text'] == 'generated OCR'
    assert client.get(route+'/pending').json() == []


def test_ocr_crash_cleanup_does_not_delete_later_preview(client, monkeypatch):
    from comic_studio import pending_results
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    monkeypatch.setattr('comic_studio.main.recognize_image', lambda *a: [{'id':1, 'text':'ocr', 'enabled':True}])
    original = pending_results.remove
    monkeypatch.setattr(pending_results, 'remove', lambda *a: (_ for _ in ()).throw(OSError('crash')))
    with pytest.raises(OSError): client.post(route+'/ocr', json={'image_ids':[item['id']]})
    monkeypatch.setattr(pending_results, 'remove', original)
    red = png_bytes((320, 200), 'red')
    assert client.post(f"{route}/images/{item['id']}/rendered", content=red).status_code == 200
    assert client.get(route+'/pending').json() == []
    assert client.get(f"{route}/images/{item['id']}/content?edited=true").content == red


def test_pending_result_is_not_in_backup(client, monkeypatch):
    from comic_studio.store import ProjectStore
    project, item = make_project(client); route = f"/api/projects/{project['id']}"
    def fake(*a):
        s = ProjectStore(); current = s.get(project['id'])
        current['images'][0]['blocks'] = [{'id':7, 'text':'private user edit'}]; s.save(current)
        return [{'id':1, 'text':'private staged text', 'enabled':True}]
    monkeypatch.setattr('comic_studio.main.recognize_image', fake)
    assert client.post(route+'/ocr', json={'image_ids':[item['id']]}).status_code == 409
    response = client.post(route+'/backup', json={'drafts':[]})
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert all('.pending-results' not in name for name in archive.namelist())
        assert b'private staged text' not in archive.read('project.json')


def test_exports_recreate_missing_dir_and_avoid_recompressing_uncropped_renders(client):
    import shutil
    from comic_studio.exporter import build_images_zip, build_txt, image_payload
    from comic_studio.paths import project_root
    from comic_studio.store import ProjectStore

    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    rendered_png = png_bytes((320, 200), 'blue')
    assert client.post(f"{route}/images/{item['id']}/rendered", content=rendered_png).status_code == 200

    store = ProjectStore()
    state = store.get(project['id'])
    payload_bytes, ext, w, h = image_payload(store, project['id'], state['images'][0], 'orig')
    assert (ext, w, h) == ('png', 320, 200)
    assert payload_bytes == rendered_png

    exports_dir = project_root(project['id']) / 'exports'
    shutil.rmtree(exports_dir, ignore_errors=True)
    txt_path = build_txt(store, state, {'name': 'check-txt', 'image_ids': [item['id']]})
    assert txt_path.is_file()
    shutil.rmtree(exports_dir, ignore_errors=True)
    zip_path = build_images_zip(store, state, {'name': 'check-zip', 'image_ids': [item['id']]})
    assert zip_path.is_file()


def test_restore_backup_enforces_actual_decompressed_byte_cap(client, monkeypatch):
    from comic_studio import backup
    from comic_studio.store import ProjectStore

    project, _ = make_project(client)
    response = client.post(f"/api/projects/{project['id']}/backup", json={'drafts': []})
    assert response.status_code == 200
    orig_getinfo = zipfile.ZipFile.getinfo
    orig_infolist = zipfile.ZipFile.infolist

    def spoofed_infolist(self):
        infos = orig_infolist(self)
        for info in infos:
            if info.filename.startswith('images/'):
                info.file_size = 1
        return infos

    def spoofed_getinfo(self, name):
        info = orig_getinfo(self, name)
        if info.filename.startswith('images/'):
            info.file_size = 1
        return info

    monkeypatch.setattr(zipfile.ZipFile, 'infolist', spoofed_infolist)
    monkeypatch.setattr(zipfile.ZipFile, 'getinfo', spoofed_getinfo)
    monkeypatch.setattr(backup, 'MAX_IMAGE', 32)
    with pytest.raises(backup.BackupError):
        backup.restore_backup(ProjectStore(), io.BytesIO(response.content))


def test_docx_export_produces_valid_rtl_ooxml_and_survives_backup(client):
    import xml.etree.ElementTree as ET
    from comic_studio import backup
    from comic_studio.store import ProjectStore, project_root

    project, item = make_project(client)
    project["name"] = "آزمون خروجی Word"
    project["images"][0]["blocks"] = [
        {"id": 2, "text": "SECOND\x07 LINE\nWITH <TAGS> & \"QUOTES\"", "tr": "خط دوم\nترجمه‌شده", "richHtml": "<b>خط دوم</b><br>ترجمه‌شده", "x0": 10, "y0": 80, "x1": 140, "y1": 120, "bg": "white"},
        {"id": 1, "text": "FIRST LINE", "tr": "سلام کمیک!", "x0": 10, "y0": 10, "x1": 140, "y1": 50, "bg": "white"},
    ]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200

    res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "docx", "image_ids": [item["id"]], "name": "comic-word-out", "docx_mode": "translation"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    assert "comic-word-out.docx" in res.headers.get("content-disposition", "")

    with zipfile.ZipFile(io.BytesIO(res.content)) as archive:
        names = set(archive.namelist())
        assert {"[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/styles.xml", "word/document.xml", "word/media/page_001.png"} <= names
        for member in names:
            if member.endswith((".xml", ".rels")):
                ET.fromstring(archive.read(member))
        with Image.open(io.BytesIO(archive.read("word/media/page_001.png"))) as bg_img:
            assert bg_img.getpixel((30, 25)) == (255, 255, 255)
            assert bg_img.getpixel((30, 95)) == (255, 255, 255)
        doc_root = ET.fromstring(archive.read("word/document.xml"))
        ns = {
            "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
            "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
            "v": "urn:schemas-microsoft-com:vml",
        }
        full_text = "".join(t.text or "" for t in doc_root.findall(".//w:t", ns))
        assert full_text.index("سلام کمیک!") < full_text.index("خط دوم")
        assert "FIRST LINE" not in full_text
        assert "\x07" not in full_text
        assert doc_root.find(".//wp:anchor[@behindDoc='1']", ns) is not None
        assert len(doc_root.findall(".//v:textbox/w:txbxContent", ns)) == 2
        assert doc_root.find(".//w:bidi", ns) is not None
        assert doc_root.find(".//w:rtl", ns) is not None

    ocr_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "docx", "image_ids": [item["id"]], "name": "comic-word-ocr", "docx_mode": "ocr"},
    )
    assert ocr_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(ocr_res.content)) as archive:
        doc_root = ET.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        full_text = "".join(t.text or "" for t in doc_root.findall(".//w:t", ns))
        assert full_text.index("FIRST LINE") < full_text.index("SECOND LINE")
        assert 'WITH <TAGS> & "QUOTES"' in full_text
        assert "سلام کمیک!" not in full_text
        assert "\x07" not in full_text

    backup_res = client.post(f"/api/projects/{project['id']}/backup", json={"drafts": []})
    assert backup_res.status_code == 200
    restored, _ = backup.restore_backup(ProjectStore(), io.BytesIO(backup_res.content))
    assert (project_root(restored["id"]) / "exports" / "comic-word-out.docx").is_file()
    assert (project_root(restored["id"]) / "exports" / "comic-word-ocr.docx").is_file()


def test_docx_escapes_quotes_and_control_chars_in_page_names(client):
    import xml.etree.ElementTree as ET
    from comic_studio.store import ProjectStore

    project, item = make_project(client)
    store = ProjectStore()
    current = store.get(project["id"])
    current["images"][0]["name"] = 'ep "01"\x07 & <special>\'name.png'
    current["images"][0]["blocks"] = [
        {"id": 1, "text": "HELLO", "tr": "سلام", "x0": 10, "y0": 10, "x1": 120, "y1": 50, "bg": "white"},
    ]
    store.save(current)

    res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "docx", "image_ids": [item["id"]], "name": "quoted-page-name", "docx_mode": "translation"},
    )
    assert res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(res.content)) as archive:
        raw_doc = archive.read("word/document.xml")
        assert b"\x07" not in raw_doc
        doc_root = ET.fromstring(raw_doc)
        ns = {
            "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
            "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
        }
        doc_pr = doc_root.find(".//wp:docPr", ns)
        cnv_pr = doc_root.find(".//pic:cNvPr", ns)
        assert doc_pr is not None and cnv_pr is not None
        assert doc_pr.attrib["name"] == 'ep "01" & <special>\'name.png'
        assert cnv_pr.attrib["name"] == 'ep "01" & <special>\'name.png'


def test_clean_name_windows_compatibility_and_backup_roundtrip(client):
    from comic_studio import backup, exporter
    from comic_studio.paths import project_root
    from comic_studio.store import ProjectStore

    assert exporter.clean_name("CON") == "_CON"
    assert exporter.clean_name("aux.part1") == "_aux.part1"
    assert exporter.clean_name("lpt9") == "_lpt9"
    assert exporter.clean_name("a" * 119 + ".b") == "a" * 119
    assert exporter.clean_name("a" * 119 + " b") == "a" * 119
    assert exporter.clean_name("...", "") == ""

    project, item = make_project(client)
    for kind, raw_name in [
        ("pdf", "CON"),
        ("docx", "aux.v1"),
        ("txt", "a" * 119 + ".trailing"),
        ("images", "LPT1"),
    ]:
        res = client.post(
            f"/api/projects/{project['id']}/export",
            json={"kind": kind, "image_ids": [item["id"]], "name": raw_name, "folder_name": "NUL"},
        )
        assert res.status_code == 200, (kind, raw_name, res.text)

    backup_res = client.post(f"/api/projects/{project['id']}/backup", json={"drafts": []})
    assert backup_res.status_code == 200, backup_res.text
    restored, _ = backup.restore_backup(ProjectStore(), io.BytesIO(backup_res.content))
    exports_dir = project_root(restored["id"]) / "exports"
    assert (exports_dir / "_CON.pdf").is_file()
    assert (exports_dir / "_aux.v1.docx").is_file()
    assert (exports_dir / f"{'a' * 119}.txt").is_file()
    assert (exports_dir / "_LPT1-images.zip").is_file()
    with zipfile.ZipFile(exports_dir / "_LPT1-images.zip") as zf:
        assert all(name.startswith("_NUL/") for name in zf.namelist())


def test_atomic_exports_leave_no_partial_or_tmp_files_on_failure(client, monkeypatch):
    from comic_studio import exporter
    from comic_studio.paths import project_root
    from comic_studio.store import ProjectStore

    project, item = make_project(client)
    store = ProjectStore()
    state = store.get(project["id"])
    exports_dir = project_root(project["id"]) / "exports"

    pdf_out = exporter.build_pdf(store, state, {"name": "atomic-check", "image_ids": [item["id"]]})
    original_pdf_bytes = pdf_out.read_bytes()
    assert original_pdf_bytes.startswith(b"%PDF")
    assert list(exports_dir.glob("*.tmp")) == []

    orig_payload = exporter.image_payload

    def fail_payload(*args, **kwargs):
        raise RuntimeError("disk error mid-zip")

    monkeypatch.setattr(exporter, "image_payload", fail_payload)
    with pytest.raises(RuntimeError, match="disk error mid-zip"):
        exporter.build_images_zip(store, state, {"name": "broken-zip", "image_ids": [item["id"]]})
    assert not (exports_dir / "broken-zip-images.zip").exists()
    assert list(exports_dir.glob("*.tmp")) == []
    monkeypatch.setattr(exporter, "image_payload", orig_payload)

    def fail_replace(src, dst):
        raise PermissionError("file locked in viewer")

    monkeypatch.setattr(exporter.os, "replace", fail_replace)
    for builder in (exporter.build_pdf, exporter.build_txt, exporter.build_docx, exporter.build_images_zip):
        with pytest.raises(PermissionError, match="file locked in viewer"):
            builder(store, state, {"name": "atomic-check", "image_ids": [item["id"]]})
    assert pdf_out.read_bytes() == original_pdf_bytes
    assert not (exports_dir / "atomic-check.txt").exists()
    assert not (exports_dir / "atomic-check.docx").exists()
    assert not (exports_dir / "atomic-check-images.zip").exists()
    assert list(exports_dir.glob("*.tmp")) == []


def test_docx_extreme_aspect_ratio_aligns_textbox_coordinates_with_clamped_page(client):
    import re
    import xml.etree.ElementTree as ET

    buf = io.BytesIO()
    Image.new("RGB", (300, 12000), "white").save(buf, "PNG")
    create_res = client.post("/api/projects", json={"name": "Webtoon Clamp"})
    assert create_res.status_code == 201
    project_id = create_res.json()["id"]
    up_res = client.post(
        f"/api/projects/{project_id}/files",
        files=[("files", ("strip.png", buf.getvalue(), "image/png"))],
    )
    assert up_res.status_code == 200
    img_item = up_res.json()["images"][0]
    state = client.get(f"/api/projects/{project_id}").json()
    state["images"][0]["blocks"] = [
        {
            "id": 1,
            "x0": 75,
            "y0": 1200,
            "x1": 225,
            "y1": 2400,
            "tx0": 75,
            "ty0": 1200,
            "tx1": 225,
            "ty1": 2400,
            "text": "TALL",
            "tr": "حباب وسط نوار باریک",
            "enabled": True,
        }
    ]
    put_res = client.put(f"/api/projects/{project_id}/state", json={"state": state})
    assert put_res.status_code == 200

    exp_res = client.post(
        f"/api/projects/{project_id}/export",
        json={"kind": "docx", "image_ids": [img_item["id"]], "name": "webtoon-clamp", "docx_mode": "translation"},
    )
    assert exp_res.status_code == 200, exp_res.text
    with zipfile.ZipFile(io.BytesIO(exp_res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")

    ET.fromstring(doc_xml)
    assert 'w:w="1440"' in doc_xml
    assert 'w:h="30000"' in doc_xml
    m = re.search(
        r'margin-left:([0-9.]+)pt;margin-top:([0-9.]+)pt;width:([0-9.]+)pt;height:([0-9.]+)pt',
        doc_xml,
    )
    assert m is not None, doc_xml
    left_pt, top_pt, width_pt, height_pt = (float(v) for v in m.groups())
    # Clamped page width is 1440 dxa = 72pt; bubble spans 25%..75% horizontally -> left=18pt, width=36pt.
    assert abs(left_pt - 18.0) < 0.05
    assert abs(width_pt - 36.0) < 0.05
    # Page height is 30000 dxa = 1500pt; bubble spans 10%..20% vertically -> top=150pt, height=150pt.
    assert abs(top_pt - 150.0) < 0.05
    assert abs(height_pt - 150.0) < 0.05


def test_txt_and_docx_clean_legacy_markers_extract_rich_html_and_skip_disabled(client):
    import re

    project, item = make_project(client)
    state = client.get(f"/api/projects/{project['id']}").json()
    state["images"][0]["blocks"] = [
        {
            "id": 1,
            "x0": 20,
            "y0": 20,
            "x1": 180,
            "y1": 80,
            "text": "**HELLO** [color=#ff0000]WORLD[/color]",
            "tr": "**سلام** __دوست__ *خوب* [size=20][color=#112233]من[/color][/size]",
            "enabled": True,
        },
        {
            "id": 2,
            "x0": 20,
            "y0": 90,
            "x1": 120,
            "y1": 130,
            "tx0": 20,
            "ty0": 90,
            "tx1": 120,
            "ty1": 130,
            "text": "RICH ONLY",
            "tr": "",
            "richHtml": "<div><b>خط اول طولانی برای آزمایش اندازه خودکار متن داخل کادر</b></div><div>خط دوم</div>",
            "enabled": True,
        },
        {
            "id": 3,
            "x0": 20,
            "y0": 140,
            "x1": 120,
            "y1": 175,
            "text": "HIDDEN SOURCE",
            "tr": "این کادر غیرفعال نباید در خروجی متنی بیاید",
            "enabled": False,
        },
    ]
    put_res = client.put(f"/api/projects/{project['id']}/state", json={"state": state})
    assert put_res.status_code == 200

    txt_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "txt", "image_ids": [item["id"]], "name": "clean-export"},
    )
    assert txt_res.status_code == 200, txt_res.text
    txt_body = txt_res.content.decode("utf-8-sig")
    assert "HELLO WORLD" in txt_body
    assert "سلام دوست خوب من" in txt_body
    assert "**" not in txt_body and "[size=" not in txt_body and "[color=" not in txt_body
    assert "خط اول طولانی برای آزمایش اندازه خودکار متن داخل کادر\nخط دوم" in txt_body
    assert "(بدون ترجمه)" not in txt_body
    assert "HIDDEN SOURCE" not in txt_body
    assert "این کادر غیرفعال" not in txt_body

    docx_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "docx", "image_ids": [item["id"]], "name": "clean-docx", "docx_mode": "translation"},
    )
    assert docx_res.status_code == 200, docx_res.text
    with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
    assert "**" not in doc_xml and "[size=" not in doc_xml and "[color=" not in doc_xml
    assert "HIDDEN SOURCE" not in doc_xml and "این کادر غیرفعال" not in doc_xml
    # Block 2 (100x40px with long richHtml and empty `tr`) must auto-fit cleanly instead of exploding to 44px (~238 half-pts).
    sz_vals = [int(v) for v in re.findall(r'<w:sz w:val="(\d+)"/>', doc_xml)]
    assert sz_vals and max(sz_vals) < 160


def test_docx_translation_mode_honors_per_block_ocr_text_mode(client):
    project, item = make_project(client)
    state = client.get(f"/api/projects/{project['id']}").json()
    state["images"][0]["blocks"] = [
        {
            "id": 1,
            "x0": 20,
            "y0": 20,
            "x1": 180,
            "y1": 80,
            "text": "HELLO HERO",
            "tr": "سلام قهرمان",
            "textMode": "translation",
            "enabled": True,
        },
        {
            "id": 2,
            "x0": 20,
            "y0": 95,
            "x1": 180,
            "y1": 155,
            "text": "BOOM SFX!",
            "tr": "ترجمه پنهان جلوه صوتی",
            "align": "right",
            "textMode": "ocr",
            "enabled": True,
        },
    ]
    put_res = client.put(f"/api/projects/{project['id']}/state", json={"state": state})
    assert put_res.status_code == 200

    docx_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "docx", "image_ids": [item["id"]], "name": "mixed-mode", "docx_mode": "translation"},
    )
    assert docx_res.status_code == 200, docx_res.text
    with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")

    assert "سلام قهرمان" in doc_xml
    assert "BOOM SFX!" in doc_xml
    assert "ترجمه پنهان جلوه صوتی" not in doc_xml
    assert '<w:jc w:val="left"/>' in doc_xml


def test_book_and_article_ocr_and_flowing_docx_export(client, monkeypatch):
    project, item = make_project(client)

    def fake_two_col_ocr(*args, **kwargs):
        raw = [
            (1, "Chapter 1: Foundations of Optics", 40, 15, 240, 24),
            (2, "Light propagates through media-", 40, 52, 115, 16),
            (3, "• Wave interference principle", 180, 52, 120, 16),
            (4, "ted electromagnetic fields.", 40, 72, 105, 16),
            (5, "• Snell refraction law", 180, 72, 120, 16),
            (6, "    Second indented paragraph starts", 62, 94, 98, 16),
            (7, "here on the left column.", 40, 114, 110, 16),
        ]
        return [
            {
                "id": idx,
                "text": txt,
                "tr": "",
                "richHtml": "",
                "enabled": True,
                "x0": x,
                "y0": y,
                "x1": x + w,
                "y1": y + h,
                "lineH": h,
                "conf": 95,
                "bg": "auto",
            }
            for idx, txt, x, y, w, h in raw
        ]

    monkeypatch.setattr("comic_studio.main.recognize_image", fake_two_col_ocr)
    ocr_res = client.post(
        f"/api/projects/{project['id']}/ocr",
        json={"image_ids": [item["id"]], "group_lines": True, "page_mode": "auto"},
    )
    assert ocr_res.status_code == 200, ocr_res.text
    img_state = ocr_res.json()["images"][0]
    assert img_state["pageMode"] == "document"
    blocks = img_state["blocks"]
    assert [b["text"] for b in blocks] == [
        "Chapter 1: Foundations of Optics",
        "Light propagates through mediated electromagnetic fields.",
        "Second indented paragraph starts here on the left column.",
        "• Wave interference principle",
        "• Snell refraction law",
    ]
    assert blocks[0]["pageRole"] == "heading" and blocks[0]["bold"] is True
    assert blocks[1]["pageRole"] == "paragraph" and blocks[1]["bold"] is False

    # Add Persian translations & rich formatting, then export BOTH flowing Word (.docx) and TXT
    state = ocr_res.json()
    translations = [
        "فصل اول: مبانی اپتیک",
        "نور از طریق میدان‌های الکترومغناطیسی منتشر می‌شود.",
        "پاراگراف دوم با تورفتگی در ستون چپ آغاز می‌شود.",
        "• اصل تداخل امواج",
        "• قانون شکست اسنل",
    ]
    for blk, tr in zip(state["images"][0]["blocks"], translations):
        blk["tr"] = tr
    state["images"][0]["blocks"][1]["richHtml"] = "نور از طریق <b>میدان‌های الکترومغناطیسی</b> منتشر می‌شود."
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": state}).status_code == 200

    # 1. Flowing Word export (translation): no raster background image, standard A4 book layout, keepNext heading, bold inline run
    flowing_tr = client.post(
        f"/api/projects/{project['id']}/export",
        json={
            "kind": "docx",
            "image_ids": [item["id"]],
            "name": "optics-book-fa",
            "docx_mode": "translation",
            "docx_layout": "flowing",
        },
    )
    assert flowing_tr.status_code == 200, flowing_tr.text
    with zipfile.ZipFile(io.BytesIO(flowing_tr.content)) as zf:
        names = zf.namelist()
        assert not any(n.startswith("word/media/") for n in names)
        doc_xml = zf.read("word/document.xml").decode("utf-8")
    assert "فصل اول: مبانی اپتیک" in doc_xml
    assert "میدان‌های الکترومغناطیسی" in doc_xml
    assert "<w:keepNext/>" in doc_xml
    assert '<w:pgMar w:top="1440"' in doc_xml

    # 2. Flowing Word export (OCR): preserves English book text in column reading order without background images
    flowing_ocr = client.post(
        f"/api/projects/{project['id']}/export",
        json={
            "kind": "docx",
            "image_ids": [item["id"]],
            "name": "optics-book-en",
            "docx_mode": "ocr",
            "docx_layout": "flowing",
        },
    )
    assert flowing_ocr.status_code == 200, flowing_ocr.text
    with zipfile.ZipFile(io.BytesIO(flowing_ocr.content)) as zf:
        ocr_xml = zf.read("word/document.xml").decode("utf-8")
    assert "Light propagates through mediated electromagnetic fields." in ocr_xml
    assert ocr_xml.index("Second indented paragraph") < ocr_xml.index("Wave interference principle")

    # 3. TXT export also follows multi-column reading order
    txt_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "txt", "image_ids": [item["id"]], "name": "optics-book"},
    )
    assert txt_res.status_code == 200
    txt_body = txt_res.content.decode("utf-8-sig")
    assert txt_body.index("Second indented paragraph") < txt_body.index("Wave interference principle")


def test_engine_update_endpoint_clears_update_loop_and_emits_progress(client, monkeypatch):
    import importlib.util
    from comic_studio import ocr as ocr_mod
    from comic_studio import ocr_managed

    monkeypatch.setattr(ocr_managed, "detect_builtin_installed_version", lambda eid, eng=None: "3.8.0" if str(eid).startswith("rapidocr") else None)
    monkeypatch.setattr(ocr_mod, "detect_builtin_installed_version", lambda eid, eng=None: "3.8.0" if str(eid).startswith("rapidocr") else None)
    monkeypatch.setattr(ocr_managed, "fetch_pypi_latest_version", lambda pkg, timeout=6.0: "3.10.0" if pkg == "rapidocr" else None)
    monkeypatch.setattr(ocr_managed, "fetch_remote_repo_revision", lambda repo, timeout=6.0: None)
    monkeypatch.setattr(ocr_managed, "fetch_tessdata_revision", lambda langs, timeout=6.0: None)
    orig_find_spec = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda name, *a, **kw: object() if name in {"rapidocr", "onnxruntime"} else orig_find_spec(name, *a, **kw))
    monkeypatch.setattr(ocr_mod, "install_packages", lambda pkgs, upgrade=False: None)
    monkeypatch.setattr(ocr_mod.RapidEngine, "ready_languages", property(lambda self: ["eng"] if self.id == "rapidocr-v6" else []))
    monkeypatch.setattr(ocr_mod.RapidEngine, "_get", lambda self, lang, allow_download=False: "dummy")
    monkeypatch.setattr(ocr_mod.RapidEngine, "_warm", staticmethod(lambda inst: None))

    ocr_managed.update_manifest_entry("rapidocr-v6", installedVersion="3.8.0")

    # Step 1: Check updates -> rapidocr-v6 shows updateAvailable=True, un-prepared rapidocr-v5 stays False
    chk1 = client.post("/api/engines/check-updates", json={"force": True})
    assert chk1.status_code == 200
    engines_before = {e["id"]: e for e in chk1.json()["engines"]}
    assert engines_before["rapidocr-v6"]["updateAvailable"] is True
    assert engines_before["rapidocr-v5"]["updateAvailable"] is False

    # Step 2: Update rapidocr-v6 -> even if wheel ceiling stays 3.8.0 on older Python, update is acknowledged & loop stops
    upd = client.post("/api/engines/rapidocr-v6/update", json={"language": "eng"})
    assert upd.status_code == 200
    engines_after_upd = {e["id"]: e for e in upd.json()["engines"]}
    assert engines_after_upd["rapidocr-v6"]["updateAvailable"] is False

    # Step 3: Subsequent forced check-updates still reports updateAvailable=False (no infinite update loop!)
    chk2 = client.post("/api/engines/check-updates", json={"force": True})
    assert chk2.status_code == 200
    engines_rechecked = {e["id"]: e for e in chk2.json()["engines"]}
    assert engines_rechecked["rapidocr-v6"]["updateAvailable"] is False

    # Step 4: Activity log recorded determinate numeric progress values ending at 1.0
    act = client.get("/api/activity?after=0").json()["entries"]
    progresses = [e["progress"] for e in act if isinstance(e.get("progress"), (int, float))]
    assert any(0 < p < 1 for p in progresses)
    assert progresses[-1] == 1.0


def test_memory_endpoints_and_immediate_unload_after_ocr(client, monkeypatch):
    from comic_studio import ocr as ocr_mod
    from comic_studio.ocr import OcrLine

    project, item = make_project(client)

    def fake_recognize(self, image, language):
        # Simulate loading ONNX session into _instances during recognition
        self._instances[language] = {"session": "loaded"}
        return [OcrLine("CLEAN RAM TEST", 0.96, [[12, 14], [140, 14], [140, 44], [12, 44]])]

    monkeypatch.setattr(ocr_mod.RapidEngine, "recognize", fake_recognize)

    mem_before = client.get("/api/engines/memory")
    assert mem_before.status_code == 200
    assert mem_before.json()["loadedCount"] == 0

    ocr_res = client.post(
        f"/api/projects/{project['id']}/ocr",
        json={"image_ids": [item["id"]], "engine": "rapidocr-v6", "language": "eng"},
    )
    assert ocr_res.status_code == 200
    assert ocr_res.json()["images"][0]["blocks"][0]["text"] == "CLEAN RAM TEST"

    # Immediately after OCR completes, model must already be unloaded from RAM!
    mem_after_ocr = client.get("/api/engines/memory")
    assert mem_after_ocr.status_code == 200
    assert mem_after_ocr.json()["loadedCount"] == 0
    assert mem_after_ocr.json()["loadedEngines"] == []

    # Manual POST /api/engines/unload also succeeds cleanly and returns memory + engines
    unload_res = client.post("/api/engines/unload", json={})
    assert unload_res.status_code == 200
    payload = unload_res.json()
    assert payload["ok"] is True
    assert payload["memory"]["loadedCount"] == 0
    assert len(payload["engines"]) == 13


def test_pptx_export_visual_and_flowing_slides_and_backup_restore(client):
    import xml.etree.ElementTree as ET
    from PIL import ImageDraw
    from comic_studio import backup
    from comic_studio.paths import project_root
    from comic_studio.store import ProjectStore

    project, item = make_project(client)
    store = ProjectStore()
    img_path = project_root(project["id"]) / "images" / item["file"]
    with Image.open(img_path) as opened:
        canvas = opened.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([20, 15, 110, 50], fill=(10, 10, 10))
    canvas.save(img_path)

    state = store.get(project["id"])
    state["images"][0]["pageMode"] = "document"
    state["images"][0]["blocks"] = [
        {
            "id": 1,
            "text": "CHAPTER ONE: PPTX",
            "tr": "فصل اول: ارائهٔ پاورپوینت",
            "richHtml": '<b><span style="color:#dc2626">فصل اول:</span> ارائهٔ پاورپوینت</b>',
            "x0": 20, "y0": 15, "x1": 110, "y1": 50,
            "enabled": True,
            "bg": "white",
            "dir": "rtl",
            "align": "right",
            "pageRole": "heading",
        },
        {
            "id": 2,
            "text": 'Point <A> & "B"',
            "tr": "نکتهٔ کلیدی اول",
            "richHtml": "",
            "x0": 20, "y0": 65, "x1": 140, "y1": 100,
            "enabled": True,
            "bg": "auto",
            "dir": "rtl",
            "align": "justify",
            "pageRole": "list",
        },
    ]
    store.save(state)

    # 1. Visual PPTX (translated text boxes over cleaned background image)
    vis_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={
            "kind": "pptx",
            "image_ids": [item["id"]],
            "name": "comic-slides-out",
            "pptx_mode": "translation",
            "pptx_layout": "visual",
        },
    )
    assert vis_res.status_code == 200
    assert vis_res.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )
    assert "comic-slides-out.pptx" in vis_res.headers.get("content-disposition", "")

    ns = {
        "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    }
    with zipfile.ZipFile(io.BytesIO(vis_res.content)) as archive:
        names = set(archive.namelist())
        required_parts = {
            "[Content_Types].xml",
            "_rels/.rels",
            "docProps/core.xml",
            "docProps/app.xml",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
            "ppt/presProps.xml",
            "ppt/viewProps.xml",
            "ppt/tableStyles.xml",
            "ppt/theme/theme1.xml",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            "ppt/slides/slide1.xml",
            "ppt/slides/_rels/slide1.xml.rels",
            "ppt/media/slide_bg_001.png",
        }
        assert required_parts <= names
        for member in names:
            if member.endswith((".xml", ".rels")):
                ET.fromstring(archive.read(member))

        with Image.open(io.BytesIO(archive.read("ppt/media/slide_bg_001.png"))) as bg_img:
            assert bg_img.getpixel((40, 30)) == (255, 255, 255)

        pres_root = ET.fromstring(archive.read("ppt/presentation.xml"))
        sld_sz = pres_root.find("p:sldSz", ns)
        assert sld_sz is not None
        assert 914400 <= int(sld_sz.attrib["cx"]) <= 51206400
        assert 914400 <= int(sld_sz.attrib["cy"]) <= 51206400

        slide_root = ET.fromstring(archive.read("ppt/slides/slide1.xml"))
        assert slide_root.find(".//p:pic", ns) is not None
        tx_shapes = slide_root.findall(".//p:sp", ns)
        assert len(tx_shapes) == 2
        slide_text = "".join(t.text or "" for t in slide_root.findall(".//a:t", ns))
        assert "فصل اول:" in slide_text
        assert "ارائهٔ پاورپوینت" in slide_text
        assert "نکتهٔ کلیدی اول" in slide_text
        assert "CHAPTER ONE" not in slide_text
        # Verify ECMA-376 CT_TextCharacterProperties child sequence: solidFill BEFORE latin/ea/cs
        first_rpr = slide_root.find(".//a:r/a:rPr", ns)
        assert first_rpr is not None
        rpr_tags = [child.tag.rsplit("}", 1)[-1] for child in list(first_rpr)]
        assert rpr_tags.index("solidFill") < rpr_tags.index("latin")

    # 2. Visual PPTX in OCR (original source text) mode
    ocr_vis_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={
            "kind": "pptx",
            "image_ids": [item["id"]],
            "name": "comic-slides-en",
            "pptx_mode": "ocr",
            "pptx_layout": "visual",
        },
    )
    assert ocr_vis_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(ocr_vis_res.content)) as archive:
        slide_root = ET.fromstring(archive.read("ppt/slides/slide1.xml"))
        slide_text = "".join(t.text or "" for t in slide_root.findall(".//a:t", ns))
        assert "CHAPTER ONE: PPTX" in slide_text
        assert 'Point <A> & "B"' in slide_text
        assert "فصل اول" not in slide_text

    # 3. Flowing 16:9 Presentation PPTX (no background media images, clean widescreen slides)
    flow_res = client.post(
        f"/api/projects/{project['id']}/export",
        json={
            "kind": "pptx",
            "image_ids": [item["id"]],
            "name": "book-lecture-slides",
            "pptx_mode": "translation",
            "pptx_layout": "flowing",
        },
    )
    assert flow_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(flow_res.content)) as archive:
        names = set(archive.namelist())
        assert not any(n.startswith("ppt/media/") for n in names)
        pres_root = ET.fromstring(archive.read("ppt/presentation.xml"))
        sld_sz = pres_root.find("p:sldSz", ns)
        assert sld_sz.attrib["cx"] == "12192000"
        assert sld_sz.attrib["cy"] == "6858000"
        slide_root = ET.fromstring(archive.read("ppt/slides/slide1.xml"))
        slide_text = "".join(t.text or "" for t in slide_root.findall(".//a:t", ns))
        assert "فصل اول:" in slide_text
        assert "نکتهٔ کلیدی اول" in slide_text
        assert slide_root.find(".//a:buChar", ns) is not None

    # 4. Project Backup & Restore preserves exported .pptx files atomically
    backup_res = client.post(f"/api/projects/{project['id']}/backup", json={"drafts": []})
    assert backup_res.status_code == 200
    restored, _ = backup.restore_backup(ProjectStore(), io.BytesIO(backup_res.content))
    assert (project_root(restored["id"]) / "exports" / "comic-slides-out.pptx").is_file()
    assert (project_root(restored["id"]) / "exports" / "book-lecture-slides.pptx").is_file()


def test_configured_provider_and_profile_selection_for_translation(client, monkeypatch):
    import httpx
    project, item = make_project(client)
    route = f"/api/projects/{project['id']}"
    project["images"][0]["blocks"] = [{"id": 1, "text": "HELLO FROM COMIC", "tr": "", "enabled": True}]
    assert client.put(f"{route}/state", json={"state": project}).status_code == 200

    save_res = client.put(
        "/api/ai-settings",
        json={
            "provider": "free",
            "providers": {
                "openrouter": {
                    "model": "openai/gpt-4o-mini",
                    "base_url": "https://openrouter.ai/api/v1",
                    "profiles": [
                        {"id": "prof-small", "name": "کلید کم‌سقف", "api_key": "secret-small", "source_limit": 700, "retry_count": 0, "retry_wait_seconds": 0},
                        {"id": "prof-big", "name": "کلید پرسقف", "api_key": "secret-big", "source_limit": 2400, "retry_count": 0, "retry_wait_seconds": 0},
                    ],
                },
                "gemini": {
                    "model": "gemini-2.5-flash",
                    "base_url": "https://generativelanguage.googleapis.com/v1beta",
                    "profiles": [
                        {"id": "gem-1", "name": "کلید Gemini", "api_key": "secret-gemini", "source_limit": 1600, "retry_count": 0, "retry_wait_seconds": 0},
                    ],
                },
            },
        },
    )
    assert save_res.status_code == 200
    assert save_res.json()["provider"] == "free"

    # Unknown / unconfigured profile_id is rejected cleanly with 400
    bad_preview = client.post(f"{route}/context-preview", json={"image_ids": [item["id"]], "provider": "openrouter", "profile_id": "missing-id"})
    assert bad_preview.status_code == 400

    # Selecting specific profile_id="prof-big" uses its 2400 limit and only its key
    preview_big = client.post(
        f"{route}/context-preview",
        json={"image_ids": [item["id"]], "provider": "openrouter", "profile_id": "prof-big", "skill": "لحن صمیمی", "summary": ""},
    )
    assert preview_big.status_code == 200
    preview_json = preview_big.json()
    assert preview_json["totalLimit"] == 2400
    assert preview_json["profileId"] == "prof-big"
    assert "کلید پرسقف" in preview_json["providerLabel"]

    used_headers: list[str] = []

    def fake_post(url, **kwargs):
        used_headers.append(kwargs.get("headers", {}).get("Authorization", ""))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"translation":"سلام از کمیک","summary":"شروع"}'}}]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    started = client.post(
        f"{route}/context-start",
        json={
            "image_ids": [item["id"]],
            "provider": "openrouter",
            "profile_id": "prof-big",
            "skill": "لحن صمیمی",
            "summary": "",
            "confirmation": preview_json["signature"],
        },
    )
    assert started.status_code == 200
    stepped = client.post(f"{route}/context-step", json={"run_id": started.json()["runId"], "completed": 0, "skill": "لحن صمیمی"})
    assert stepped.status_code == 200
    assert used_headers == ["Bearer secret-big"]
    assert stepped.json()["project"]["images"][0]["blocks"][0]["tr"] == "سلام از کمیک"

    # Single-block retranslate also respects profile_id
    single_prev = client.post(
        "/api/translate-text/context-preview",
        json={"text": "ONE BLOCK", "provider": "openrouter", "profile_id": "prof-big", "skill": "", "summary": ""},
    )
    assert single_prev.status_code == 200
    assert single_prev.json()["totalLimit"] == 2400
    single_res = client.post(
        "/api/translate-text/context",
        json={
            "text": "ONE BLOCK",
            "provider": "openrouter",
            "profile_id": "prof-big",
            "skill": "",
            "summary": "",
            "confirmation": single_prev.json()["signature"],
        },
    )
    assert single_res.status_code == 200
    assert single_res.json()["text"] == "سلام از کمیک"
    assert used_headers == ["Bearer secret-big", "Bearer secret-big"]


def test_page_approval_persists_excludes_exports_and_resets_on_reprocess(client, monkeypatch):
    project, item1 = make_project(client)
    imported2 = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", ("page-2.png", png_bytes(), "image/png"))],
    )
    assert imported2.status_code == 200
    project = imported2.json()
    item2 = project["images"][1]
    assert item1.get("approved") is False
    assert item2.get("approved") is False

    # Mark both pages approved and save state
    project["images"][0]["approved"] = True
    project["images"][0]["blocks"] = [{"id": 1, "text": "PAGE ONE", "tr": "صفحه اول", "x0": 10, "y0": 10, "x1": 90, "y1": 40, "bg": "white"}]
    project["images"][1]["approved"] = True
    project["images"][1]["blocks"] = [{"id": 1, "text": "PAGE TWO", "tr": "صفحه دوم", "x0": 10, "y0": 10, "x1": 90, "y1": 40, "bg": "white"}]
    saved = client.put(f"/api/projects/{project['id']}/state", json={"state": project})
    assert saved.status_code == 200
    reloaded = client.get(f"/api/projects/{project['id']}").json()
    assert reloaded["images"][0]["approved"] is True
    assert reloaded["images"][1]["approved"] is True

    # Duplicating an approved page creates an independent unapproved copy
    duplicated = client.post(f"/api/projects/{project['id']}/duplicate", json=[item1["id"]])
    assert duplicated.status_code == 200
    dup_images = duplicated.json()["images"]
    assert len(dup_images) == 3
    assert dup_images[0]["approved"] is True
    assert dup_images[1]["approved"] is False

    # Exported ZIP image pixels remain pure white at center (approval stamp is strictly UI-only)
    exp = client.post(
        f"/api/projects/{project['id']}/export",
        json={"kind": "images", "image_ids": [item1["id"]], "name": "approved-check", "image_format": "png"},
    )
    assert exp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exp.content)) as zf:
        img_names = [n for n in zf.namelist() if n.endswith(".png")]
        assert len(img_names) == 1
        with Image.open(io.BytesIO(zf.read(img_names[0]))) as exported_im:
            w, h = exported_im.size
            assert exported_im.convert("RGB").getpixel((w // 2, h // 2)) == (255, 255, 255)

    # Re-running OCR on page 1 resets approved=False on page 1 while keeping page 2 approved=True
    monkeypatch.setattr(
        "comic_studio.main.recognize_image",
        lambda *a, **kw: [{"id": 1, "text": "NEW OCR", "tr": "", "x0": 12, "y0": 12, "x1": 80, "y1": 36, "lineH": 24, "enabled": True}],
    )
    ocr_res = client.post(
        f"/api/projects/{project['id']}/ocr",
        json={"image_ids": [item1["id"]], "engine": "rapidocr-v6", "language": "eng", "page_mode": "comic"},
    )
    assert ocr_res.status_code == 200
    after_ocr = {im["id"]: im for im in ocr_res.json()["images"]}
    assert after_ocr[item1["id"]]["approved"] is False
    assert after_ocr[item2["id"]]["approved"] is True










