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
    assert health.json()["version"] == "4.17"
    assert health.json()["scraping"] is False
    assert client.get("/").status_code == 200
    index_html = client.get("/").text
    assert "Comic OCR Studio" in index_html
    assert '<span class="ver">۴.۱۷ · Python</span>' in index_html
    assert 'id="licenseTopStatusBtn"' in index_html
    assert "09361111111" in index_html
    assert "مدیریت مدل‌های OCR" in index_html
    assert "مدیریت ترجمه‌ها" in index_html
    assert 'id="deleteModelsMenuBtn"' not in index_html
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
    assert 'id="modelsLanguage"' in index_html
    assert 'id="translationTargetLang"' in index_html
    assert 'id="aiTargetLanguage"' in index_html
    assert '<option value="fas">' in index_html
    assert 'id="modelsRamStatus"' in index_html
    assert 'id="freeModelsRamBtn"' in index_html
    assert 'id="modelsActiveProgressWrap"' in index_html
    assert 'id="ocrQuickProgressWrap"' in index_html
    assert 'id="engineNoticeProgressWrap"' in index_html
    engines_resp = client.get("/api/engines")
    assert engines_resp.status_code == 200
    engines_list = engines_resp.json()
    assert len(engines_list) == 14
    for eng in engines_list:
        suit = eng.get("suitability")
        assert isinstance(suit, dict)
        for mode in ("auto", "comic", "document"):
            assert suit[mode]["tier"] in {"best", "medium", "weak"}
            assert len(suit[mode]["reason"]) > 15
        suit_by_lang = eng.get("suitabilityByLanguage")
        assert isinstance(suit_by_lang, dict)
        for lang_code in ("eng", "fas", "kor", "jpn", "chi_sim"):
            for mode in ("auto", "comic", "document"):
                assert suit_by_lang[lang_code][mode]["tier"] in {"best", "medium", "weak"}
                assert len(suit_by_lang[lang_code][mode]["reason"]) > 10
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
    assert len(payload["engines"]) == 14


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


def test_v385_parallel_pdf_import_multi_page_ocr_and_low_ram_spooled_exports(client, monkeypatch):
    import contextlib
    import threading
    import time
    import pymupdf as fitz

    # 1) Create a 5-page synthetic PDF and import it via multi-core _import_pdf
    pdf_doc = fitz.open()
    for p_idx in range(5):
        p = pdf_doc.new_page(width=240, height=160)
        p.insert_text((24, 72), f"PAGE {p_idx + 1}")
    raw_pdf = pdf_doc.tobytes()
    pdf_doc.close()

    proj = client.post("/api/projects", json={"name": "v3.85 MultiCore"}).json()
    pid = proj["id"]
    imp = client.post(f"/api/projects/{pid}/files", files=[("files", ("chapter.pdf", raw_pdf, "application/pdf"))])
    assert imp.status_code == 200, imp.text
    imported_images = imp.json()["images"]
    assert len(imported_images) == 5
    assert [im["name"] for im in imported_images] == [f"chapter — صفحهٔ {i}.png" for i in range(1, 6)]
    assert all(im["width"] == 960 and im["height"] == 640 for im in imported_images)

    # 2) Run multi-page OCR across all 5 pages using a multi-worker batch engine
    seen_threads: set[int] = set()
    seen_lock = threading.Lock()
    reg_engine = client.app.state  # verify via monkeypatching recognize_image + RapidEngine.configure_batch

    from comic_studio.ocr import RapidEngine
    monkeypatch.setattr(
        RapidEngine,
        "configure_batch",
        contextlib.contextmanager(lambda self, total_pages, threads_per_worker=None: (yield min(3, total_pages))),
    )

    def parallel_fake_ocr(engine, image, *args, **kwargs):
        with seen_lock:
            seen_threads.add(threading.get_ident())
        time.sleep(0.025)
        w, h = image.size
        return [{"id": 1, "text": f"OCR-{w}x{h}", "tr": "ترجمهٔ آزمایشی", "x0": 20, "y0": 20, "x1": 220, "y1": 80, "lineH": 28, "enabled": True}]

    monkeypatch.setattr("comic_studio.main.recognize_image", parallel_fake_ocr)
    all_ids = [im["id"] for im in imported_images]
    ocr_resp = client.post(
        f"/api/projects/{pid}/ocr",
        json={"image_ids": all_ids, "engine": "rapidocr-v6", "language": "eng", "page_mode": "comic"},
    )
    assert ocr_resp.status_code == 200, ocr_resp.text
    ocr_images = ocr_resp.json()["images"]
    assert all(im["ocrCompleted"] is True and im["blocks"][0]["text"] == "OCR-960x640" for im in ocr_images)
    assert len(seen_threads) >= 2

    # Memory endpoint confirms 0 models remain resident in RAM after parallel OCR
    mem_resp = client.get("/api/engines/memory")
    assert mem_resp.status_code == 200
    assert mem_resp.json()["loadedCount"] == 0

    # Add translation text so visual DOCX & PPTX embed cleaned page backgrounds + textboxes
    for im in ocr_images:
        im["blocks"][0]["tr"] = f"صفحهٔ فارسی {im['order'] + 1}"
    assert client.put(f"/api/projects/{pid}/state", json={"state": {**ocr_resp.json(), "images": ocr_images}}).status_code == 200

    # 3) Export PDF, ZIP, visual DOCX (spooled), and visual PPTX (spooled)
    pdf_exp = client.post(f"/api/projects/{pid}/export", json={"kind": "pdf", "image_ids": all_ids, "name": "multi-out"})
    assert pdf_exp.status_code == 200
    with fitz.open(stream=pdf_exp.content, filetype="pdf") as out_pdf:
        assert len(out_pdf) == 5

    zip_exp = client.post(f"/api/projects/{pid}/export", json={"kind": "images", "image_ids": all_ids, "name": "multi-out", "image_format": "jpg"})
    assert zip_exp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(zip_exp.content)) as out_zip:
        jpgs = sorted(n for n in out_zip.namelist() if n.endswith(".jpg"))
        assert len(jpgs) == 5

    docx_exp = client.post(f"/api/projects/{pid}/export", json={"kind": "docx", "image_ids": all_ids, "name": "multi-out", "docx_layout": "visual"})
    assert docx_exp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(docx_exp.content)) as out_docx:
        media_infos = [zi for zi in out_docx.infolist() if zi.filename.startswith("word/media/page_")]
        assert len(media_infos) == 5
        assert all(zi.compress_type == zipfile.ZIP_STORED for zi in media_infos)

    pptx_exp = client.post(f"/api/projects/{pid}/export", json={"kind": "pptx", "image_ids": all_ids, "name": "multi-out", "pptx_layout": "visual"})
    assert pptx_exp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(pptx_exp.content)) as out_pptx:
        slide_infos = [zi for zi in out_pptx.infolist() if zi.filename.startswith("ppt/media/slide_bg_")]
        assert len(slide_infos) == 5
        assert all(zi.compress_type == zipfile.ZIP_STORED for zi in slide_infos)


def test_v386_project_export_name_sync_and_non_bold_translation_defaults(client):
    from urllib.parse import unquote
    from comic_studio.context_run import apply_translated_block_defaults
    from comic_studio.ocr import OcrLine, _blocks_from_lines

    # 1. Newly created project syncs output.name to project.name with nameCustomized=False
    proj = client.post("/api/projects", json={"name": "مرد عنکبوتی ۱"}).json()
    pid = proj["id"]
    assert proj["name"] == "مرد عنکبوتی ۱"
    assert proj["settings"]["output"]["name"] == "مرد عنکبوتی ۱"
    assert proj["settings"]["output"]["nameCustomized"] is False

    imported = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("p1.png", png_bytes(), "image/png"))],
    )
    assert imported.status_code == 200
    img_id = imported.json()["images"][0]["id"]

    # 2. Exporting with empty/omitted name defaults to project.name; custom name overrides it
    exp_default = client.post(f"/api/projects/{pid}/export", json={"kind": "pdf", "image_ids": [img_id]})
    assert exp_default.status_code == 200
    disp_default = unquote(exp_default.headers.get("content-disposition", ""))
    assert "مرد عنکبوتی ۱.pdf" in disp_default

    exp_custom = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "pdf", "image_ids": [img_id], "name": "نسخه-ویژه-کمیک"},
    )
    assert exp_custom.status_code == 200
    disp_custom = unquote(exp_custom.headers.get("content-disposition", ""))
    assert "نسخه-ویژه-کمیک.pdf" in disp_custom

    # 3. OCR blocks and placed translations default to normal weight (bold=False), while document headings remain bold=True
    ocr_blocks = _blocks_from_lines([OcrLine(text="Hello there!", confidence=0.98, polygon=[[10, 10], [90, 10], [90, 35], [10, 35]])])
    assert ocr_blocks[0]["bold"] is False

    legacy_block = {"id": 1, "text": "Hello!", "tr": "سلام دوستان", "bold": True, "x0": 10, "y0": 10, "x1": 100, "y1": 45, "polygon": [[10, 10], [100, 10], [100, 45], [10, 45]], "enabled": True}
    apply_translated_block_defaults(legacy_block)
    assert legacy_block["bold"] is False

    heading_block = {"id": 2, "text": "Chapter 1", "tr": "فصل اول", "pageRole": "heading", "bold": True}
    apply_translated_block_defaults(heading_block)
    assert heading_block["bold"] is True

    # Verify Visual DOCX & Visual PPTX exports do NOT emit bold runs for normal translated blocks
    state = imported.json()
    state["images"][0]["blocks"] = [legacy_block]
    assert client.put(f"/api/projects/{pid}/state", json={"state": state}).status_code == 200

    vis_docx = client.post(f"/api/projects/{pid}/export", json={"kind": "docx", "image_ids": [img_id], "docx_layout": "visual"})
    assert vis_docx.status_code == 200
    with zipfile.ZipFile(io.BytesIO(vis_docx.content)) as zdoc:
        doc_xml = zdoc.read("word/document.xml").decode("utf-8")
        assert "سلام دوستان" in doc_xml
        assert "<w:b/>" not in doc_xml and "<w:bCs/>" not in doc_xml

    vis_pptx = client.post(f"/api/projects/{pid}/export", json={"kind": "pptx", "image_ids": [img_id], "pptx_layout": "visual"})
    assert vis_pptx.status_code == 200
    with zipfile.ZipFile(io.BytesIO(vis_pptx.content)) as zppt:
        slide_xml = zppt.read("ppt/slides/slide1.xml").decode("utf-8")
        assert "سلام دوستان" in slide_xml
        assert ' b="1"' not in slide_xml


def test_v387_audit_project_id_validation_404_routes_mpo_jpeg_and_flowing_bold(client, monkeypatch):
    from comic_studio import backup
    from comic_studio.store import ProjectStore

    # 1. Non-ASCII alphanumeric strings (e.g. Persian digits "۱۲۳۴") are rejected cleanly with 404
    assert client.get("/api/projects/۱۲۳۴").status_code == 404
    assert client.post("/api/projects/missing999/duplicate", json=["img1"]).status_code == 404
    assert client.post("/api/projects/missing999/delete", json=["img1"]).status_code == 404

    # 2. MPO camera JPEG format is normalized to JPEG (.jpg) across import, export, and backup/restore
    project = client.post("/api/projects", json={"name": "آزمون ممیزی"}).json()
    pid = project["id"]
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (220, 210, 200)).save(buf, "JPEG", quality=92)
    raw_jpg = buf.getvalue()

    real_open = Image.open

    def mpo_open(fp, *args, **kwargs):
        im = real_open(fp, *args, **kwargs)
        if getattr(im, "format", None) == "JPEG":
            im.format = "MPO"
        return im

    monkeypatch.setattr(Image, "open", mpo_open)
    imported = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("camera-shot.jpg", raw_jpg, "image/jpeg"))],
    )
    assert imported.status_code == 200, imported.text
    img = imported.json()["images"][0]
    assert img["format"] == "JPEG"
    assert img["file"].endswith(".jpg")

    backup_res = client.post(f"/api/projects/{pid}/backup", json={"drafts": []})
    assert backup_res.status_code == 200
    restored, _ = backup.restore_backup(ProjectStore(), io.BytesIO(backup_res.content))
    assert restored["images"][0]["format"] == "JPEG"
    monkeypatch.setattr(Image, "open", real_open)

    # 3. Flowing DOCX and Flowing PPTX honor explicit user Bold=True on blocks without pageRole while keeping Bold=False normal
    state = imported.json()
    state["images"][0]["blocks"] = [
        {"id": 1, "text": "Plain line", "tr": "خط معمولی بدون بولد", "bold": False, "x0": 5, "y0": 5, "x1": 55, "y1": 20, "polygon": [[5, 5], [55, 5], [55, 20], [5, 20]], "enabled": True},
        {"id": 2, "text": "Bold line", "tr": "خط تأکیدی بولد", "bold": True, "x0": 5, "y0": 24, "x1": 55, "y1": 42, "polygon": [[5, 24], [55, 24], [55, 42], [5, 42]], "enabled": True},
    ]
    assert client.put(f"/api/projects/{pid}/state", json={"state": state}).status_code == 200

    flow_docx = client.post(f"/api/projects/{pid}/export", json={"kind": "docx", "image_ids": [img["id"]], "docx_layout": "flowing"})
    assert flow_docx.status_code == 200
    with zipfile.ZipFile(io.BytesIO(flow_docx.content)) as zdoc:
        doc_xml = zdoc.read("word/document.xml").decode("utf-8")
        assert "خط معمولی بدون بولد" in doc_xml
        assert "خط تأکیدی بولد" in doc_xml
        assert "<w:b/>" in doc_xml

    flow_pptx = client.post(f"/api/projects/{pid}/export", json={"kind": "pptx", "image_ids": [img["id"]], "pptx_layout": "flowing"})
    assert flow_pptx.status_code == 200
    with zipfile.ZipFile(io.BytesIO(flow_pptx.content)) as zppt:
        slide_xml = zppt.read("ppt/slides/slide1.xml").decode("utf-8")
        assert "خط معمولی بدون بولد" in slide_xml
        assert "خط تأکیدی بولد" in slide_xml
        assert slide_xml.count(' b="1"') == 1  # only the bold block has b="1", not the normal block


def test_v388_url_ipv6_nan_progress_reuse_repeated_and_duplicate_edited_sync(client, tmp_path):
    import pytest
    from comic_studio.__main__ import _format_browser_url
    from comic_studio.activity import ActivityLog
    from comic_studio.backup import make_backup
    from comic_studio.paths import project_root
    from comic_studio.store import ProjectStore, atomic_json
    from comic_studio.translation import TranslationService

    # 1. IPv6 URL formatting brackets literals properly
    assert _format_browser_url("0.0.0.0", 8765) == "http://127.0.0.1:8765"
    assert _format_browser_url("::", 8765) == "http://[::1]:8765"
    assert _format_browser_url("::1", 8765) == "http://[::1]:8765"
    assert _format_browser_url("[::1]", 8765) == "http://[::1]:8765"

    # 2. ActivityLog ignores NaN / infinite progress instead of turning NaN into 1.0
    feed = ActivityLog()
    feed.add("nan test", progress=float("nan"))
    feed.add("inf test", progress=float("inf"))
    feed.add("finite test", progress=0.45)
    entries = feed.since(0)["entries"]
    assert entries[0]["progress"] is None
    assert entries[1]["progress"] is None
    assert entries[2]["progress"] == 0.45

    # 3. TranslationService.save_settings validates reuse_repeated boolean and preserves False on None/omission
    svc = TranslationService()
    saved = svc.save_settings({"reuse_repeated": False})
    assert saved["reuse_repeated"] is False
    saved_after_none = svc.save_settings({"reuse_repeated": None})
    assert saved_after_none["reuse_repeated"] is False
    with pytest.raises(ValueError):
        svc.save_settings({"reuse_repeated": "false"})

    # 4. ProjectStore.duplicate syncs new["edited"] with actual -edited.png existence so backup never fails
    project, image = make_project(client)
    pid, iid = project["id"], image["id"]
    store = ProjectStore()
    state = store.get(pid)
    state["images"][0]["edited"] = True  # stale flag without -edited.png on disk
    atomic_json(project_root(pid) / "project.json", state)
    duplicated = store.duplicate(pid, [iid])
    dup_item = [it for it in duplicated["images"] if it["id"] != iid][0]
    assert dup_item["edited"] is False
    # Fix source flag too and verify backup endpoint succeeds cleanly
    duplicated["images"][0]["edited"] = False
    store.save(duplicated)
    backup_res = client.post(f"/api/projects/{pid}/backup", json={"drafts": []})
    assert backup_res.status_code == 200 and len(backup_res.content) > 100


def test_v389_proportional_headings_typography_and_indent_exports(client):
    from comic_studio.context_run import apply_translated_block_defaults

    project, item = make_project(client)
    pid, iid = project["id"], item["id"]

    heading_blk = {
        "id": 1, "text": "8.3.5.7.1 Minimum Heel Fillet", "tr": "۸.۳.۵.۷.۱ حداقل ارتفاع فیلهٔ پاشنه",
        "pageRole": "heading", "x0": 40, "y0": 20, "x1": 280, "y1": 48, "lineH": 28, "enabled": True,
    }
    indented_para = {
        "id": 2, "text": "The solder joint shall wet cleanly.", "tr": "اتصال لحیم باید کاملاً یکنواخت باشد.",
        "pageRole": "paragraph", "x0": 65, "y0": 60, "x1": 290, "y1": 100, "lineH": 20,
        "firstLineIndent": 1.5, "sourceIndent": 4, "_detectedItalic": True, "italic": True, "enabled": True,
    }
    hanging_bullet = {
        "id": 3, "text": "• Target condition\ncontinuation line", "tr": "• وضعیت هدف\nادامهٔ سطر دوم",
        "pageRole": "list", "x0": 40, "y0": 110, "x1": 290, "y1": 150, "lineH": 20,
        "hangingIndent": 1.4, "_detectedBold": True, "bold": True, "enabled": True,
    }
    apply_translated_block_defaults(heading_blk)
    apply_translated_block_defaults(indented_para)
    apply_translated_block_defaults(hanging_bullet)

    assert heading_blk["size"] == round(28 * 0.78) and heading_blk["size"] > 12 and heading_blk["bold"] is True
    assert indented_para["size"] == 12 and indented_para["bold"] is False and indented_para["italic"] is True
    assert hanging_bullet["size"] == 12 and hanging_bullet["bold"] is True

    state = client.get(f"/api/projects/{pid}").json()
    state["images"][0]["pageMode"] = "document"
    state["images"][0]["blocks"] = [heading_blk, indented_para, hanging_bullet]
    assert client.put(f"/api/projects/{pid}/state", json={"state": state}).status_code == 200

    # 1. TXT export formats headings distinctly with ■ تیتر + rule and preserves indents & line breaks
    txt_res = client.post(f"/api/projects/{pid}/export", json={"kind": "txt", "image_ids": [iid], "name": "ipc-txt"})
    assert txt_res.status_code == 200
    txt_body = txt_res.content.decode("utf-8-sig")
    assert "■ تیتر: 8.3.5.7.1 Minimum Heel Fillet" in txt_body
    assert "────────────" in txt_body
    assert "← ■ ۸.۳.۵.۷.۱ حداقل ارتفاع فیلهٔ پاشنه" in txt_body
    assert "• وضعیت هدف\n" in txt_body and "ادامهٔ سطر دوم" in txt_body

    # 2. Flowing DOCX export emits proportional heading size (>30 half-pt), firstLine, hanging, and italic <w:i/>
    docx_res = client.post(f"/api/projects/{pid}/export", json={"kind": "docx", "image_ids": [iid], "docx_layout": "flowing"})
    assert docx_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zdoc:
        doc_xml = zdoc.read("word/document.xml").decode("utf-8")
        assert 'w:firstLine="' in doc_xml
        assert 'w:hanging="' in doc_xml
        assert "<w:i/>" in doc_xml
        assert 'w:sz w:val="42"' in doc_xml  # round(22 * 0.95, 1) * 2 = 41.8 -> 42 half-pt (21pt heading vs 12pt body)

    # 3. Flowing PPTX export emits proportional heading size, indent/marL attributes, and italic i="1"
    pptx_res = client.post(f"/api/projects/{pid}/export", json={"kind": "pptx", "image_ids": [iid], "pptx_layout": "flowing"})
    assert pptx_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(pptx_res.content)) as zppt:
        slide_xml = zppt.read("ppt/slides/slide1.xml").decode("utf-8")
        assert 'indent="' in slide_xml
        assert 'indent="-' in slide_xml
        assert ' i="1"' in slide_xml


def test_target_language_settings_persian_and_english_translation_pipeline(client, monkeypatch):
    from comic_studio.translation import TranslationService

    # 1. Default target_language is 'fa', and PUT /api/ai-settings persists 'en' and back to 'fa'
    initial_ai = client.get("/api/ai-settings").json()
    assert initial_ai["target_language"] == "fa"
    assert "fa" in initial_ai["target_languages"]
    assert "en" in initial_ai["target_languages"]

    saved_en = client.put("/api/ai-settings", json={"provider": "openai", "api_key": "sk-test", "target_language": "en"}).json()
    assert saved_en["target_language"] == "en"

    # 2. Project context-preview & context-step translate Persian OCR text -> English with LTR block placement
    project, item = make_project(client)
    pid, iid = project["id"], item["id"]
    state = client.get(f"/api/projects/{pid}").json()
    state["images"][0]["ocrCompleted"] = True
    state["images"][0]["blocks"] = [
        {"id": 1, "text": "۱. مقدمه", "tr": "", "x0": 400, "y0": 40, "x1": 760, "y1": 72, "lineH": 28, "pageRole": "heading", "dir": "rtl", "enabled": True},
        {"id": 2, "text": "امروز هوا بسیار خوب است.", "tr": "", "x0": 320, "y0": 90, "x1": 760, "y1": 120, "lineH": 24, "dir": "rtl", "enabled": True},
    ]
    client.put(f"/api/projects/{pid}/state", json={"state": state})

    captured_prompts = []

    def fake_translate_context(self, request, text, sources, provider, policy):
        captured_prompts.append(f"{request.system}\n{request.user_prefix}")
        return "1. Introduction\nThe weather is great today.", "Intro summary"

    monkeypatch.setattr(TranslationService, "translate_context", fake_translate_context)

    req_en = {
        "image_ids": [iid],
        "provider": "openai",
        "source_language": "fas",
        "target_language": "en",
        "skill": "",
        "summary": "",
    }
    prev_en = client.post(f"/api/projects/{pid}/context-preview", json=req_en)
    assert prev_en.status_code == 200
    prev_json = prev_en.json()
    assert prev_json["targetLanguage"] == "en"
    assert "English" in prev_json["systemPrompt"]
    assert "انگلیسی" in prev_json["note"]

    start_en = client.post(f"/api/projects/{pid}/context-start", json={**req_en, "confirmation": prev_json["signature"]})
    assert start_en.status_code == 200
    run_id = start_en.json()["runId"]

    step_en = client.post(f"/api/projects/{pid}/context-step", json={"run_id": run_id, "completed": 0, "skill": ""})
    assert step_en.status_code == 200
    step_blocks = step_en.json()["project"]["images"][0]["blocks"]
    assert step_blocks[0]["tr"] == "1. Introduction"
    assert step_blocks[0]["dir"] == "ltr"
    assert step_blocks[0]["align"] == "left"
    assert step_blocks[1]["tr"] == "The weather is great today."
    assert step_blocks[1]["dir"] == "ltr"
    assert any(("فارسی" in sys_p or "Persian" in sys_p) and "English" in sys_p for sys_p in captured_prompts)

    # 3. Single-block context preview/translate also respects target_language (including Persian 'fa' and Turkish 'tr')
    single_prev = client.post("/api/translate-text/context-preview", json={
        "text": "سلام دنیا",
        "source_language": "fas",
        "target_language": "tr",
        "provider": "free",
    })
    assert single_prev.status_code == 200
    sp_json = single_prev.json()
    assert sp_json["targetLanguage"] == "tr"
    assert "ترکی" in sp_json["note"]

    monkeypatch.setattr(TranslationService, "translate_free_batch", lambda self, req, txt, srcs, sl, pol, target_language="fa": f"[{sl}->{target_language}] Merhaba Dunya")
    single_tr = client.post("/api/translate-text/context", json={
        "text": "سلام دنیا",
        "source_language": "fas",
        "target_language": "tr",
        "provider": "free",
        "confirmation": sp_json["signature"],
    })
    assert single_tr.status_code == 200
    assert single_tr.json()["text"] == "[fas->tr] Merhaba Dunya"


def test_v398_uninstall_engine_api_endpoint(client, monkeypatch, tmp_path):
    import os

    models_root = tmp_path / "models_uninstall_api"
    monkeypatch.setattr("comic_studio.ocr.models_dir", lambda: models_root)
    monkeypatch.setattr("comic_studio.ocr_managed.models_dir", lambda: models_root)

    # Create installed Hezar Persian OCR layout in isolated env + HF cache
    hezar_env = models_root / "envs" / "hezar-ocr"
    hezar_py = hezar_env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    hezar_py.parent.mkdir(parents=True, exist_ok=True)
    hezar_py.write_bytes(b"P" * 2048)
    (hezar_env / ".runtime-ready").write_text("ready", encoding="utf-8")
    hezar_state = models_root / "isolated" / "hezar-ocr"
    hezar_state.mkdir(parents=True, exist_ok=True)
    (hezar_state / ".ready-fas").write_text("ready", encoding="utf-8")
    hezar_hf = models_root / "hf-repos" / "hezarai__crnn_base_fa_v2"
    hezar_hf.mkdir(parents=True, exist_ok=True)
    (hezar_hf / "model.pt").write_bytes(b"M" * (2 * 1024 * 1024))

    before = {e["id"]: e for e in client.get("/api/engines").json()}
    assert before["hezar-ocr"]["canUninstall"] is True
    assert before["hezar-ocr"]["modelReady"] is True

    resp = client.post("/api/engines/hezar-ocr/uninstall")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["engineId"] == "hezar-ocr"
    assert body["freedMb"] >= 2.0
    after = {e["id"]: e for e in body["engines"]}
    assert after["hezar-ocr"]["canUninstall"] is False
    assert after["hezar-ocr"]["runtimeInstalled"] is False
    assert after["hezar-ocr"]["modelReady"] is False

    # Built-in base engine rejects uninstall cleanly
    base_resp = client.post("/api/engines/rapidocr-v6/uninstall")
    assert base_resp.status_code in {400, 422, 500} or base_resp.json().get("ok") is not True


def test_v399_per_page_ocr_keep_engine_loaded_and_memory_release(client, monkeypatch):
    import comic_studio.main as main_mod
    import comic_studio.ocr as ocr_mod
    from comic_studio.ocr import EngineRegistry

    project, item1 = make_project(client)
    pid = project["id"]
    jbuf = io.BytesIO()
    Image.new("RGB", (300, 220), "white").save(jbuf, format="JPEG")
    up2 = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("page2.jpg", jbuf.getvalue(), "image/jpeg"))],
    )
    assert up2.status_code == 200
    item2 = up2.json()["images"][1]

    trim_calls: list[str] = []
    unload_calls: list[str | None] = []
    orig_trim = main_mod.trim_process_memory
    orig_unload_all = EngineRegistry.unload_all

    def spy_trim():
        trim_calls.append("trim")
        return orig_trim()

    def spy_unload_all(self, except_engine_id=None):
        unload_calls.append(except_engine_id)
        return orig_unload_all(self, except_engine_id)

    monkeypatch.setattr(main_mod, "trim_process_memory", spy_trim)
    monkeypatch.setattr(EngineRegistry, "unload_all", spy_unload_all)
    monkeypatch.setattr(
        ocr_mod,
        "recognize_image",
        lambda engine, image, *a, **kw: [{"text": "HELLO", "confidence": 0.96, "polygon": [[10, 10], [90, 10], [90, 36], [10, 36]]}],
    )
    monkeypatch.setattr(
        main_mod,
        "recognize_image",
        lambda engine, image, *a, **kw: [{"text": "HELLO", "confidence": 0.96, "polygon": [[10, 10], [90, 10], [90, 36], [10, 36]]}],
    )

    # 1. Uncropped JPEG /content?cropped=true streams original JPEG directly without transcoding to PNG in RAM
    uncropped_res = client.get(f"/api/projects/{pid}/images/{item2['id']}/content?cropped=true")
    assert uncropped_res.status_code == 200
    assert uncropped_res.content[:3] == b"\xff\xd8\xff"

    # 2. Page 1 OCR with keep_engine_loaded=True trims memory WITHOUT calling unload_all(None) at end
    unload_calls.clear()
    trim_calls.clear()
    r1 = client.post(
        f"/api/projects/{pid}/ocr",
        json={"image_ids": [item1["id"]], "engine": "rapidocr-v6", "language": "eng", "keep_engine_loaded": True},
    )
    assert r1.status_code == 200
    assert unload_calls == ["rapidocr-v6"]  # pre-run unload of other engines only; active engine kept warm!
    assert len(trim_calls) >= 1

    # 3. Saving rendered PNG for page 1 immediately releases RAM via trim_process_memory()
    trim_before_render = len(trim_calls)
    r_up = client.post(
        f"/api/projects/{pid}/images/{item1['id']}/rendered",
        content=png_bytes((item1["width"], item1["height"]), "white"),
        headers={"Content-Type": "image/png"},
    )
    assert r_up.status_code == 200
    assert len(trim_calls) >= trim_before_render + 1

    # 4. Final page OCR with keep_engine_loaded=False calls full unload_all(None) at end
    unload_calls.clear()
    r2 = client.post(
        f"/api/projects/{pid}/ocr",
        json={"image_ids": [item2["id"]], "engine": "rapidocr-v6", "language": "eng", "keep_engine_loaded": False},
    )
    assert r2.status_code == 200
    assert None in unload_calls


def test_v400_optional_custom_storage_migration_validation_and_roundtrip(tmp_path, monkeypatch):
    import json
    import os
    from pathlib import Path
    import shutil
    from comic_studio import APP_VERSION
    import comic_studio.paths as paths_mod
    import comic_studio.ocr_managed as managed_mod
    import comic_studio.ocr_worker as worker_mod
    import comic_studio.ocr as ocr_mod

    assert APP_VERSION == "4.17"

    default_root = tmp_path / "default_c_drive"
    custom_root = tmp_path / "custom_d_drive" / "ComicOCRStudio"
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(default_root))
    monkeypatch.delenv("COMIC_STUDIO_CONFIG", raising=False)
    paths_mod._CONFIG_CACHE = None

    local_client = TestClient(create_app(), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))

    # 1. Default behavior is 100% optional and unchanged
    st0 = local_client.get("/api/storage-settings")
    assert st0.status_code == 200
    info0 = st0.json()
    assert info0["mode"] == "default"
    assert info0["customActive"] is False
    assert info0["customPath"] == ""
    assert Path(info0["activePath"]).resolve() == default_root.resolve()

    # Seed project + AI settings + downloaded OCR model files in default_root
    proj, item = make_project(local_client)
    pid = proj["id"]
    ai_res = local_client.put(
        "/api/ai-settings",
        json={"provider": "gemini", "target_language": "en", "reuse_repeated": False},
    )
    assert ai_res.status_code == 200
    fake_weight = default_root / "models" / "hezar" / "crnn_fa_v2.safetensors"
    fake_weight.parent.mkdir(parents=True, exist_ok=True)
    fake_weight.write_bytes(b"PERSIAN-MODEL-WEIGHTS" * 120)
    (default_root / "models" / "isolated" / "hezar-ocr").mkdir(parents=True, exist_ok=True)
    (default_root / "models" / "isolated" / "hezar-ocr" / ".ready-all").write_text("ok", encoding="utf-8")

    # 2. Invalid/unsafe paths are rejected before touching storage-config.json
    bad_rel = local_client.put("/api/storage-settings", json={"custom_path": "relative/folder"})
    assert bad_rel.status_code == 400
    bad_nested = local_client.put("/api/storage-settings", json={"custom_path": str(default_root / "nested_inside")})
    assert bad_nested.status_code == 400
    bad_app = local_client.put("/api/storage-settings", json={"custom_path": str(paths_mod.APP_DIR)})
    assert bad_app.status_code == 400
    bad_pkg = local_client.put("/api/storage-settings", json={"custom_path": str(paths_mod.PACKAGE_DIR / "sub")})
    assert bad_pkg.status_code == 400

    # 3. Insufficient destination disk space aborts cleanly BEFORE deleting or changing anything
    def _tiny_disk_usage(_p):
        return shutil._ntuple_diskusage(1024 * 1024, 1020 * 1024, 4096)

    monkeypatch.setattr(paths_mod.shutil, "disk_usage", _tiny_disk_usage)
    low_space_res = local_client.put(
        "/api/storage-settings",
        json={"custom_path": str(custom_root), "migrate_existing": True, "cleanup_source": True},
    )
    assert low_space_res.status_code == 400
    assert "فضای خالی" in low_space_res.json()["detail"]
    assert fake_weight.is_file()  # Source untouched!
    assert paths_mod.is_custom_data_dir_active() is False
    monkeypatch.undo()
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(default_root))
    monkeypatch.delenv("COMIC_STUDIO_CONFIG", raising=False)
    paths_mod._CONFIG_CACHE = None

    # 4. Full migration + verification + source space cleanup onto custom_root
    sw_res = local_client.put(
        "/api/storage-settings",
        json={"custom_path": str(custom_root), "migrate_existing": True, "cleanup_source": True},
    )
    assert sw_res.status_code == 200
    sw_body = sw_res.json()
    assert sw_body["storage"]["mode"] == "custom"
    assert sw_body["storage"]["customActive"] is True
    assert Path(sw_body["storage"]["activePath"]).resolve() == custom_root.resolve()
    assert sw_body["storage"]["migratedBytes"] >= fake_weight.stat().st_size if fake_weight.exists() else 2000
    assert sw_body["ai"]["provider"] == "gemini"
    assert sw_body["ai"]["target_language"] == "en"
    assert any(p["id"] == pid for p in sw_body["projects"])

    # Verify files exist in custom_root AND were freed from default_root (except storage-config.json)
    assert (custom_root / "models" / "hezar" / "crnn_fa_v2.safetensors").read_bytes() == b"PERSIAN-MODEL-WEIGHTS" * 120
    assert (custom_root / "projects" / pid / "project.json").is_file()
    assert (custom_root / "ai-settings.json").is_file()
    assert (default_root / "storage-config.json").is_file()
    assert not (default_root / "models").exists()
    assert not (default_root / "projects").exists()

    # 5. Zero-C:-leak check: pip env, worker env, worker cache dirs, and EasyOCR install_packages all route to custom_root
    pip_env = managed_mod.clean_pip_env()
    assert Path(pip_env["PIP_CACHE_DIR"]).resolve() == (custom_root / "models" / "pip-cache").resolve()
    assert Path(pip_env["TEMP"]).resolve() == (custom_root / "models" / "tmp").resolve()
    assert Path(pip_env["TMP"]).resolve() == (custom_root / "models" / "tmp").resolve()
    assert Path(pip_env["XDG_CACHE_HOME"]).resolve() == (custom_root / "models" / "cache").resolve()

    iso_eng = managed_mod.IsolatedOcrEngine("surya", ["eng", "fas"], ocr_mod._INSTALL_LOCK, ocr_mod.OcrLine, ocr_mod.OcrError)
    w_env = iso_eng._worker_env()
    assert Path(w_env["HF_HOME"]).resolve() == (custom_root / "models" / "hf").resolve()
    assert Path(w_env["MODEL_CACHE_DIR"]).resolve() == (custom_root / "models" / "surya").resolve()
    assert Path(w_env["TEMP"]).resolve() == (custom_root / "models" / "tmp").resolve()

    # Even if user had a stale HF_HOME on C:\, ocr_worker._configure_cache_dirs overrides it to models_root!
    old_hf = os.environ.get("HF_HOME")
    try:
        os.environ["HF_HOME"] = "/stale/c_drive/hf"
        worker_mod._configure_cache_dirs(custom_root / "models")
        assert Path(os.environ["HF_HOME"]).resolve() == (custom_root / "models" / "hf").resolve()
    finally:
        if old_hf is None:
            os.environ.pop("HF_HOME", None)
        else:
            os.environ["HF_HOME"] = old_hf

    # Standard install_packages routes --target into <custom_root>/models/site-packages when custom dir is active
    pip_cmds: list[list[str]] = []
    monkeypatch.setattr(
        ocr_mod.subprocess,
        "run",
        lambda cmd, **kw: (pip_cmds.append(list(cmd)), type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})())[1],
    )
    ocr_mod.install_packages(["easyocr>=1.7,<2"])
    assert "--target" in pip_cmds[0]
    target_idx = pip_cmds[0].index("--target")
    assert Path(pip_cmds[0][target_idx + 1]).resolve() == (custom_root / "models" / "site-packages").resolve()

    # 6. Active job lock blocks directory switch with HTTP 409
    with ocr_mod._INSTALL_LOCK:
        busy_res = local_client.put("/api/storage-settings", json={"custom_path": ""})
        assert busy_res.status_code == 409

    # 7. Switch back to default path with migration restores everything back cleanly
    back_res = local_client.put(
        "/api/storage-settings",
        json={"custom_path": "", "migrate_existing": True, "cleanup_source": True},
    )
    assert back_res.status_code == 200
    assert back_res.json()["storage"]["mode"] == "default"
    assert (default_root / "projects" / pid / "project.json").is_file()
    assert (default_root / "models" / "hezar" / "crnn_fa_v2.safetensors").is_file()


def test_v400_unplugged_custom_drive_fallback_remote_guard_and_app_relocation(tmp_path, monkeypatch):
    import base64
    import importlib.util
    import json
    from pathlib import Path
    import shutil
    import sys
    import comic_studio.paths as paths_mod

    default_root = tmp_path / "default_home"
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(default_root))
    monkeypatch.delenv("COMIC_STUDIO_CONFIG", raising=False)
    paths_mod._CONFIG_CACHE = None

    # 1. Simulate unplugged/unavailable custom drive: app starts safely on default_root & preserves custom_data_dir!
    blocking_file = tmp_path / "not_a_directory_file"
    blocking_file.write_text("blocks mkdir", encoding="utf-8")
    unplugged_path = blocking_file / "ComicOCROnUnpluggedDrive"
    default_root.mkdir(parents=True, exist_ok=True)
    (default_root / "storage-config.json").write_text(
        json.dumps({"custom_data_dir": str(unplugged_path)}),
        encoding="utf-8",
    )
    paths_mod._CONFIG_CACHE = None

    local_client = TestClient(create_app(), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))
    st = local_client.get("/api/storage-settings")
    assert st.status_code == 200
    st_json = st.json()
    assert st_json["mode"] == "default"
    assert st_json["customPath"] == str(unplugged_path)
    assert "در دسترس نیست" in st_json["fallbackWarning"]

    # 2. Remote LAN client cannot mutate host storage settings or open native folder picker even with valid password
    pw = "S" * 24
    monkeypatch.setenv("COMIC_STUDIO_ACCESS_PASSWORD", pw)
    auth_hdr = {"Authorization": "Basic " + base64.b64encode(f"comic:{pw}".encode()).decode()}
    lan_client = TestClient(create_app(), base_url="http://192.168.1.10:8765", client=("192.168.1.55", 51000))
    r_put = lan_client.put("/api/storage-settings", json={"custom_path": ""}, headers=auth_hdr)
    assert r_put.status_code == 403
    r_pick = lan_client.post("/api/storage-settings/pick-folder", json={}, headers=auth_hdr)
    assert r_pick.status_code == 403
    monkeypatch.delenv("COMIC_STUDIO_ACCESS_PASSWORD", raising=False)

    # 3. Relocating `python_app` to another directory self-heals stale editable finders in `run.py`
    relocated_app = tmp_path / "DriveD" / "MovedComicApp" / "python_app"
    (relocated_app / "comic_studio").mkdir(parents=True)
    shutil.copy2(paths_mod.APP_DIR / "run.py", relocated_app / "run.py")
    (relocated_app / "comic_studio" / "__init__.py").write_text('MARKER = "FROM_MOVED_DRIVE_D"\n', encoding="utf-8")

    spec = importlib.util.spec_from_file_location("relocated_run_mod", relocated_app / "run.py")
    assert spec and spec.loader
    relocated_run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(relocated_run)

    class _StaleEditableFinder:
        MAPPING = {"comic_studio": str(tmp_path / "OldDeletedDriveC" / "python_app" / "comic_studio")}

    old_sys_path = list(sys.path)
    old_meta_path = list(sys.meta_path)
    old_pkg = sys.modules.get("comic_studio")
    try:
        sys.meta_path.insert(0, _StaleEditableFinder())
        relocated_run._ensure_local_package_resolution()
        assert not any(isinstance(f, _StaleEditableFinder) for f in sys.meta_path)
        assert Path(sys.path[0]).resolve() == relocated_app.resolve()
    finally:
        sys.path[:] = old_sys_path
        sys.meta_path[:] = old_meta_path
        if old_pkg is not None:
            sys.modules["comic_studio"] = old_pkg


def test_v401_real_progress_bars_across_paged_ocr_import_backup_and_weight_download(client, tmp_path, monkeypatch):
    import threading
    from comic_studio.activity import reporting
    import comic_studio.ocr as ocr_mod
    import comic_studio.ocr_managed as managed_mod

    # 1. File import emits real monotonic per-file progress in (0, 1]
    client.post("/api/activity/clear")
    pid = client.post("/api/projects", json={"name": "پروژهٔ پیشرفت واقعی"}).json()["id"]
    files = [
        ("files", ("p1.png", png_bytes((240, 160), "white"), "image/png")),
        ("files", ("p2.png", png_bytes((240, 160), "white"), "image/png")),
        ("files", ("p3.png", png_bytes((240, 160), "white"), "image/png")),
    ]
    r_imp = client.post(f"/api/projects/{pid}/files", files=files)
    assert r_imp.status_code == 200
    images = r_imp.json()["images"]
    assert len(images) == 3

    imp_entries = client.get("/api/activity").json()["entries"]
    imp_progs = [e["progress"] for e in imp_entries if isinstance(e.get("progress"), (int, float))]
    assert len(imp_progs) >= 3
    assert imp_progs == sorted(imp_progs), f"import progress must be monotonic: {imp_progs}"
    assert any(0.25 <= p <= 0.40 for p in imp_progs)
    assert imp_progs[-1] == pytest.approx(1.0)

    # 2. Multi-page UI OCR (batch_index / batch_total) NEVER emits 1.0 on page 1 or 2 of 3
    monkeypatch.setattr(
        ocr_mod,
        "recognize_image",
        lambda *_a, **_kw: [{"id": 1, "text": "HELLO", "confidence": 0.92, "x0": 10, "y0": 10, "x1": 90, "y1": 35}],
    )
    client.post("/api/activity/clear")
    r_ocr1 = client.post(
        f"/api/projects/{pid}/ocr",
        json={
            "image_ids": [images[0]["id"]],
            "engine": "rapidocr-v6",
            "language": "eng",
            "keep_engine_loaded": True,
            "batch_index": 1,
            "batch_total": 3,
        },
    )
    assert r_ocr1.status_code == 200
    p1_entries = client.get("/api/activity").json()["entries"]
    p1_progs = [e["progress"] for e in p1_entries if isinstance(e.get("progress"), (int, float))]
    assert p1_progs and max(p1_progs) <= 0.30, f"page 1 of 3 must never report 100%: {p1_progs}"
    assert not any("OCR تمام شد" in e["message"] for e in p1_entries)

    r_ocr2 = client.post(
        f"/api/projects/{pid}/ocr",
        json={
            "image_ids": [images[1]["id"]],
            "engine": "rapidocr-v6",
            "language": "eng",
            "keep_engine_loaded": True,
            "batch_index": 2,
            "batch_total": 3,
        },
    )
    assert r_ocr2.status_code == 200
    p2_entries = client.get("/api/activity").json()["entries"]
    p2_progs = [e["progress"] for e in p2_entries if isinstance(e.get("progress"), (int, float))]
    assert max(p2_progs) <= 0.62, f"page 2 of 3 must stay within ~60%: {p2_progs}"

    r_ocr3 = client.post(
        f"/api/projects/{pid}/ocr",
        json={
            "image_ids": [images[2]["id"]],
            "engine": "rapidocr-v6",
            "language": "eng",
            "keep_engine_loaded": False,
            "batch_index": 3,
            "batch_total": 3,
        },
    )
    assert r_ocr3.status_code == 200
    all_ocr_entries = client.get("/api/activity").json()["entries"]
    all_ocr_progs = [e["progress"] for e in all_ocr_entries if isinstance(e.get("progress"), (int, float))]
    assert all_ocr_progs == sorted(all_ocr_progs), f"paged OCR progress must never go backwards: {all_ocr_progs}"
    assert 0.85 <= all_ocr_progs[-1] < 1.0, f"server leaves final slice for browser text placement: {all_ocr_progs}"
    assert sum(1 for e in all_ocr_entries if "OCR تمام شد" in e["message"]) == 1

    # 3. Backup & Restore emit real per-file monotonic progress
    client.post("/api/activity/clear")
    b_res = client.post(f"/api/projects/{pid}/backup", json={"drafts": []})
    assert b_res.status_code == 200
    bk_progs = [e["progress"] for e in client.get("/api/activity").json()["entries"] if isinstance(e.get("progress"), (int, float))]
    assert len(bk_progs) >= 3 and bk_progs == sorted(bk_progs) and bk_progs[-1] == pytest.approx(1.0)

    # 4. IsolatedOcrEngine weight-only download does NOT jump falsely to 65%/80% at 0 MB downloaded
    fake_models = tmp_path / "models_test"
    monkeypatch.setattr(managed_mod, "models_dir", lambda: fake_models)
    eng = managed_mod.IsolatedOcrEngine("glm-ocr", ["eng"], threading.Lock(), ocr_mod.OcrLine, ocr_mod.OcrError)
    monkeypatch.setattr(type(eng), "runtime_installed", property(lambda self: True))
    monkeypatch.setattr(type(eng), "model_ready", property(lambda self: False))
    monkeypatch.setattr(type(eng), "installed_version", property(lambda self: "0.1.5"))
    seen_dl_progs: list[float] = []

    def _fake_prepare_weights(_lang: str) -> str:
        w_lo, w_hi = eng._active_wt_span
        assert w_lo <= 0.10, f"weight-only download must start near 8%, not jump to 80%: {w_lo}"
        assert w_hi == pytest.approx(0.96)
        return "rev-v401"

    monkeypatch.setattr(eng, "_prepare_weights", _fake_prepare_weights)
    with reporting(lambda _m, _k="info", p=None: seen_dl_progs.append(p) if isinstance(p, (int, float)) else None):
        eng.download("eng")
    assert seen_dl_progs[0] == pytest.approx(0.04)
    assert seen_dl_progs[1] == pytest.approx(0.08)
    assert seen_dl_progs[-1] == pytest.approx(1.0)


def test_v403_backup_prepare_stream_cleanup_restore_empty_projects_office_locks_and_exif(client, tmp_path):
    import shutil
    from comic_studio.paths import data_dir, project_root

    # 1. EXIF-rotated phone JPEG (raw 120x80 with Orientation=6 -> normalized upright 80x120)
    proj = client.post("/api/projects", json={"name": "پروژهٔ بک‌آپ ریشه‌ای"}).json()
    pid = proj["id"]
    raw_sensor = Image.new("RGB", (120, 80), "navy")
    exif = raw_sensor.getexif()
    exif[0x0112] = 6  # Rotate 90 CW -> upright 80x120
    jbuf = io.BytesIO()
    raw_sensor.save(jbuf, format="JPEG", exif=exif.tobytes())

    imp = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("phone-vertical.jpg", jbuf.getvalue(), "image/jpeg"))],
    )
    assert imp.status_code == 200, imp.text
    img_item = imp.json()["images"][0]
    assert (img_item["width"], img_item["height"]) == (80, 120)

    rendered_upright = png_bytes((80, 120), "white")
    ren_res = client.post(
        f"/api/projects/{pid}/images/{img_item['id']}/rendered",
        content=rendered_upright,
        headers={"Content-Type": "image/png"},
    )
    assert ren_res.status_code == 200, ren_res.text
    latest_updated_at = ren_res.json()["updatedAt"]

    # 2. Office lock files (~$*.docx / ~$*.pptx) and dot-temp files in exports/ are ignored during backup
    exports_dir = project_root(pid) / "exports"
    (exports_dir / "clean-doc.txt").write_text("متن خروجی واقعی", encoding="utf-8")
    (exports_dir / "~$clean-doc.docx").write_bytes(b"office-lock-junk")
    (exports_dir / ".clean-doc.pdf.999.tmp").write_bytes(b"partial-temp")

    # 3. Prepared zero-RAM streaming backup mode (?prepare=true -> GET & re-download -> DELETE cleanup)
    prep = client.post(
        f"/api/projects/{pid}/backup?prepare=true",
        json={"drafts": [], "expected_updated_at": latest_updated_at},
    )
    assert prep.status_code == 200, prep.text
    prep_json = prep.json()
    token = prep_json["token"]
    assert prep_json["filename"].endswith("-backup.zip")
    assert prep_json["size"] > 0

    dl1 = client.get(f"/api/projects/{pid}/backup/{token}")
    dl2 = client.get(f"/api/projects/{pid}/backup/{token}")
    assert dl1.status_code == 200 and dl2.status_code == 200
    assert dl1.content == dl2.content

    with zipfile.ZipFile(io.BytesIO(dl1.content)) as zf:
        names = set(zf.namelist())
        assert "exports/clean-doc.txt" in names
        assert "exports/~$clean-doc.docx" not in names
        assert "exports/.clean-doc.pdf.999.tmp" not in names
        assert f"images/{img_item['id']}-edited.png" in names

    del_tok = client.delete(f"/api/projects/{pid}/backup/{token}")
    assert del_tok.status_code == 204
    assert client.get(f"/api/projects/{pid}/backup/{token}").status_code == 404
    assert not list((data_dir() / "backup-temp").glob("*.zip"))

    # 4. Restore works cleanly even if <data_dir>/projects was removed on disk
    fresh_drive = tmp_path / "empty_drive_without_projects"
    r_sw = client.put(
        "/api/storage-settings",
        json={"custom_path": str(fresh_drive), "migrate_existing": False, "cleanup_source": False},
    )
    assert r_sw.status_code == 200
    shutil.rmtree(fresh_drive / "projects", ignore_errors=True)
    assert not (fresh_drive / "projects").exists()

    restored = client.post(
        "/api/projects/restore",
        files={"file": ("backup.zip", dl1.content, "application/zip")},
    )
    assert restored.status_code == 201, restored.text
    restored_proj = restored.json()["project"]
    assert (fresh_drive / "projects" / restored_proj["id"] / "project.json").is_file()
    assert (restored_proj["images"][0]["width"], restored_proj["images"][0]["height"]) == (80, 120)

    # 5. Startup sweeps orphan files in backup-temp/ and restore-staging/
    orphan_zip = fresh_drive / "backup-temp" / "project-orphan.zip"
    orphan_zip.parent.mkdir(parents=True, exist_ok=True)
    orphan_zip.write_bytes(b"stale")
    orphan_stage = fresh_drive / "restore-staging" / "project-orphan"
    orphan_stage.mkdir(parents=True, exist_ok=True)
    with scoped_client(create_app()):
        assert not orphan_zip.exists()
        assert not orphan_stage.exists()


def test_v405_manual_blocks_watermarks_erase_original_and_bundled_models(client, tmp_path, monkeypatch):
    import base64
    import io
    import zipfile
    from PIL import Image
    import comic_studio.paths as paths_mod
    import comic_studio.main as main_mod
    from comic_studio.local_nmt import LocalNmtManager
    from comic_studio.ocr import RapidEngine
    from comic_studio.watermark_render import apply_watermark_pil, has_active_watermark, shape_visual_text

    # 1. Persian shaping + PIL watermark rendering (Text + Transparent PNG Logo across corner & tile)
    shaped = shape_visual_text("سلام دنیا 123")
    assert shaped and len(shaped) >= 8
    logo_buf = io.BytesIO()
    Image.new("RGBA", (32, 32), (255, 40, 40, 210)).save(logo_buf, "PNG")
    logo_data_url = "data:image/png;base64," + base64.b64encode(logo_buf.getvalue()).decode("ascii")
    logos_map = {"logo-1": {"id": "logo-1", "name": "قرمز", "dataUrl": logo_data_url}}
    base_img = Image.new("RGB", (320, 240), (245, 245, 245))
    wm_cfg = {
        "enabled": True,
        "text": "ترجمه اختصاصی",
        "logoId": "logo-1",
        "logoScalePct": 12,
        "position": "bottom-left",
        "sizePct": 5,
        "opacity": 85,
        "outline": True,
        "bgPill": True,
    }
    assert has_active_watermark(wm_cfg)
    stamped = apply_watermark_pil(base_img, wm_cfg, logos_map)
    assert stamped.size == base_img.size
    assert stamped.tobytes() != base_img.tobytes()

    tiled = apply_watermark_pil(base_img, {**wm_cfg, "position": "tile", "tileGapPct": 25}, logos_map)
    assert tiled.tobytes() != base_img.tobytes()

    # 2. Create a dark-patterned page and save manual blocks + watermark + eraseOriginal=False
    project = client.post("/api/projects", json={"name": "آزمون ۴.۰۵"}).json()
    pid = project["id"]
    dark_page = Image.new("RGB", (300, 220), (20, 30, 45))
    img_buf = io.BytesIO()
    dark_page.save(img_buf, "PNG")
    uploaded = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("cover.png", img_buf.getvalue(), "image/png"))],
    )
    assert uploaded.status_code == 200
    proj_state = uploaded.json()
    img_item = proj_state["images"][0]

    proj_state["settings"]["eraseOriginal"] = False
    proj_state["settings"]["watermarkLogos"] = logos_map
    img_item["watermark"] = wm_cfg
    img_item["blocks"] = [
        {
            "id": 1,
            "manual": True,
            "manualLang": "fa",
            "text": "",
            "tr": "متن دستی فارسی روی جلد",
            "richHtml": "",
            "conf": 100,
            "enabled": True,
            "bg": "auto",
            "textMode": "translation",
            "dir": "rtl",
            "align": "center",
            "x0": 30, "y0": 25, "x1": 240, "y1": 85,
            "tx0": 30, "ty0": 25, "tx1": 240, "ty1": 85,
            "lineH": 26,
        },
        {
            "id": 2,
            "manual": True,
            "manualLang": "en",
            "text": "",
            "tr": "Special Edition",
            "richHtml": "",
            "conf": 100,
            "enabled": True,
            "bg": "none",
            "textMode": "translation",
            "dir": "ltr",
            "align": "center",
            "x0": 40, "y0": 100, "x1": 220, "y1": 145,
            "tx0": 40, "ty0": 100, "tx1": 220, "ty1": 145,
            "lineH": 22,
        },
    ]
    saved = client.put(f"/api/projects/{pid}/state", json={"state": proj_state})
    assert saved.status_code == 200
    reloaded = saved.json()
    assert reloaded["images"][0]["watermark"]["text"] == "ترجمه اختصاصی"
    assert reloaded["images"][0]["blocks"][0]["manual"] is True

    # 3. Backup + Restore preserves watermark and manual blocks
    backup_zip = client.post(f"/api/projects/{pid}/backup", json={})
    assert backup_zip.status_code == 200
    restored = client.post(
        "/api/projects/restore",
        files={"file": ("wm-backup.zip", backup_zip.content, "application/zip")},
    )
    assert restored.status_code == 201
    restored_img = restored.json()["project"]["images"][0]
    assert restored_img["watermark"]["logoId"] == "logo-1"
    assert len(restored_img["blocks"]) == 2

    # 4. Exports (TXT, Visual DOCX, Visual PPTX, ZIP, PDF) include manual blocks & watermark, and honor eraseOriginal=False
    img_ids = [img_item["id"]]
    txt_res = client.post(f"/api/projects/{pid}/export", json={"kind": "txt", "name": "out", "image_ids": img_ids})
    assert txt_res.status_code == 200
    txt_body = txt_res.content.decode("utf-8")
    assert "(متن دستی): متن دستی فارسی روی جلد" in txt_body
    assert "Special Edition" in txt_body

    docx_res = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "docx", "name": "out", "image_ids": img_ids, "docx_layout": "visual", "overlay_mode": "translation"},
    )
    assert docx_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
        assert "متن دستی فارسی روی جلد" in doc_xml
        assert "Special Edition" in doc_xml
        bg_media = [n for n in zf.namelist() if n.startswith("word/media/")]
        assert bg_media
        with Image.open(io.BytesIO(zf.read(bg_media[0]))) as doc_bg:
            # With eraseOriginal=False and bg="auto", pixel (60, 50) inside block 1 keeps original dark (20,30,45) color
            r, g, b = doc_bg.convert("RGB").getpixel((60, 50))
            assert r < 60 and g < 70 and b < 80

    pptx_res = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "pptx", "name": "out", "image_ids": img_ids, "pptx_layout": "visual", "overlay_mode": "ocr"},
    )
    assert pptx_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(pptx_res.content)) as zf:
        slide_xml = zf.read("ppt/slides/slide1.xml").decode("utf-8")
        # Even in OCR mode, manual blocks with empty source text still export their custom text
        assert "متن دستی فارسی روی جلد" in slide_xml

    zip_res = client.post(f"/api/projects/{pid}/export", json={"kind": "images", "name": "out", "image_ids": img_ids, "image_format": "png"})
    assert zip_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(zip_res.content)) as zf:
        exported_png = zf.read(zf.namelist()[0])
        with Image.open(io.BytesIO(exported_png)) as exp_im:
            assert exp_im.convert("RGB").tobytes() != dark_page.tobytes()

    pdf_res = client.post(f"/api/projects/{pid}/export", json={"kind": "pdf", "name": "out", "image_ids": img_ids})
    assert pdf_res.status_code == 200 and pdf_res.content.startswith(b"%PDF")

    # 5. Re-running OCR via HTTP endpoint preserves manual blocks with fresh non-colliding IDs
    monkeypatch.setattr(
        main_mod,
        "recognize_image",
        lambda *_a, **_kw: [
            {"id": 1, "text": "Detected Bubble", "tr": "", "conf": 95.0, "x0": 10, "y0": 10, "x1": 120, "y1": 45, "lineH": 22, "enabled": True}
        ],
    )
    ocr_res = client.post(
        f"/api/projects/{pid}/ocr",
        json={"engine": "rapidocr-v6", "language": "eng", "image_ids": [img_item["id"]], "page_mode": "comic"},
    )
    assert ocr_res.status_code == 200
    after_ocr_blocks = ocr_res.json()["images"][0]["blocks"]
    assert len(after_ocr_blocks) == 3
    ids = [b["id"] for b in after_ocr_blocks]
    assert len(ids) == len(set(ids))
    manual_preserved = [b for b in after_ocr_blocks if b.get("manual") is True]
    assert len(manual_preserved) == 2

    # 6. Bundled offline models directory is discovered by RapidEngine & LocalNmtManager while keeping model_dir writable
    bundled_root = tmp_path / "frozen_bundle" / "bundled_models"
    (bundled_root / "rapidocr").mkdir(parents=True)
    for fname in ("ch_PP-OCRv5_det_mobile.onnx", "latin_PP-OCRv5_rec_mobile.onnx", "arabic_PP-OCRv5_rec_mobile.onnx"):
        (bundled_root / "rapidocr" / fname).write_bytes(b"fake-onnx")
    nmt_bundle = bundled_root / "local-nmt" / "nllb-600m"
    nmt_bundle.mkdir(parents=True)
    (nmt_bundle / "model.bin").write_bytes(b"x" * 2048)
    (nmt_bundle / "config.json").write_text("{}", encoding="utf-8")
    (nmt_bundle / "sentencepiece.bpe.model").write_bytes(b"sp" * 600)
    (nmt_bundle / "shared_vocabulary.txt").write_text("a\nb\n", encoding="utf-8")

    empty_user_models = tmp_path / "empty_user_models"
    monkeypatch.setattr(paths_mod, "bundled_models_dir", lambda: bundled_root)
    monkeypatch.setattr("comic_studio.ocr.bundled_models_dir", lambda: bundled_root)
    monkeypatch.setattr("comic_studio.local_nmt.bundled_models_dir", lambda: bundled_root)
    monkeypatch.setattr("comic_studio.local_nmt.models_dir", lambda: empty_user_models)

    rapid_eng = RapidEngine("rapidocr-v5", "v5")
    assert "eng" in rapid_eng.ready_languages and "fas" in rapid_eng.ready_languages
    assert rapid_eng.model_ready is True
    nmt_mgr = LocalNmtManager()
    assert nmt_mgr.is_model_files_present("nllb-600m") is True
    assert nmt_mgr.resolved_model_dir("nllb-600m") == nmt_bundle
    assert nmt_mgr.model_dir("nllb-600m") == empty_user_models / "local-nmt" / "nllb-600m"


def test_v408_api_key_priority_reorder_preserves_secrets_and_changes_failover_order(client, monkeypatch):
    from comic_studio.translation import TranslationError, TranslationService

    # 1. Save 3 named API keys with distinct secrets and per-key network policies
    initial_save = client.put(
        "/api/ai-settings",
        json={
            "provider": "openrouter",
            "providers": {
                "openrouter": {
                    "model": "openai/gpt-4o-mini",
                    "profiles": [
                        {
                            "id": "k-alpha",
                            "name": "کلید آلفا",
                            "api_key": "sk-alpha-secret-001",
                            "timeout_seconds": 30,
                            "retry_count": 0,
                            "retry_wait_seconds": 0,
                            "source_limit": 1200,
                        },
                        {
                            "id": "k-beta",
                            "name": "کلید بتا",
                            "api_key": "sk-beta-secret-002",
                            "timeout_seconds": 45,
                            "retry_count": 0,
                            "retry_wait_seconds": 0,
                            "source_limit": 1600,
                        },
                        {
                            "id": "k-gamma",
                            "name": "کلید گاما",
                            "api_key": "sk-gamma-secret-003",
                            "timeout_seconds": 75,
                            "retry_count": 0,
                            "retry_wait_seconds": 0,
                            "source_limit": 2400,
                        },
                    ],
                }
            },
        },
    )
    assert initial_save.status_code == 200, initial_save.text
    for raw_secret in ("sk-alpha-secret-001", "sk-beta-secret-002", "sk-gamma-secret-003"):
        assert raw_secret not in initial_save.text

    # Capture context-preview signature BEFORE reordering priority
    project, item = make_project(client)
    project["images"][0]["blocks"] = [{"id": 1, "text": "Hello priority world", "tr": "", "enabled": True}]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    pre_preview = client.post(
        f"/api/projects/{project['id']}/context-preview",
        json={"image_ids": [item["id"]], "provider": "openrouter", "source_language": "eng"},
    )
    assert pre_preview.status_code == 200, pre_preview.text
    old_signature = pre_preview.json()["signature"]

    # 2. Reorder priority in UI payload to [k-gamma, k-alpha, k-beta] WITHOUT re-sending stored secrets
    reordered_save = client.put(
        "/api/ai-settings",
        json={
            "provider": "openrouter",
            "providers": {
                "openrouter": {
                    "model": "openai/gpt-4o-mini",
                    "profiles": [
                        {
                            "id": "k-gamma",
                            "name": "کلید گاما",
                            "api_key": "",
                            "timeout_seconds": 75,
                            "retry_count": 0,
                            "retry_wait_seconds": 0,
                            "source_limit": 2400,
                        },
                        {
                            "id": "k-alpha",
                            "name": "کلید آلفا",
                            "api_key": "",
                            "timeout_seconds": 30,
                            "retry_count": 0,
                            "retry_wait_seconds": 0,
                            "source_limit": 1200,
                        },
                        {
                            "id": "k-beta",
                            "name": "کلید بتا",
                            "api_key": "",
                            "timeout_seconds": 45,
                            "retry_count": 0,
                            "retry_wait_seconds": 0,
                            "source_limit": 1600,
                        },
                    ],
                }
            },
        },
    )
    assert reordered_save.status_code == 200, reordered_save.text
    public_profiles = reordered_save.json()["providers"]["openrouter"]["profiles"]
    assert [p["id"] for p in public_profiles] == ["k-gamma", "k-alpha", "k-beta"]
    assert [p["hasApiKey"] for p in public_profiles] == [True, True, True]
    assert [p["timeout_seconds"] for p in public_profiles] == [75, 30, 45]
    assert [p["source_limit"] for p in public_profiles] == [2400, 1200, 1600]

    # 3. Changing priority refreshes context-preview signature so stale order is detected cleanly
    post_preview = client.post(
        f"/api/projects/{project['id']}/context-preview",
        json={"image_ids": [item["id"]], "provider": "openrouter", "source_language": "eng"},
    )
    assert post_preview.status_code == 200, post_preview.text
    assert post_preview.json()["signature"] != old_signature

    # 4. Verify live failover tries k-gamma FIRST (priority 1), then falls back to k-alpha (priority 2)
    tried_profiles: list[tuple[str, str, str]] = []

    def fake_openai(self, text, source_language, profile, **kwargs):
        tried_profiles.append((profile["profile_id"], profile["api_key"], profile["profile_name"]))
        if profile["profile_id"] == "k-gamma":
            raise TranslationError("سهمیهٔ کلید گاما تمام شده است (429).")
        return "سلام دنیای اولویت"

    monkeypatch.setattr(TranslationService, "_openai", fake_openai)
    single_prev = client.post(
        "/api/translate-text/preview",
        json={"text": "Hello priority world", "provider": "openrouter", "source_language": "eng"},
    )
    assert single_prev.status_code == 200, single_prev.text
    translated = client.post(
        "/api/translate-text",
        json={
            "text": "Hello priority world",
            "provider": "openrouter",
            "source_language": "eng",
            "confirmation": single_prev.json()["signature"],
        },
    )
    assert translated.status_code == 200, translated.text
    assert translated.json() == {"text": "سلام دنیای اولویت"}
    assert tried_profiles == [
        ("k-gamma", "sk-gamma-secret-003", "کلید گاما"),
        ("k-alpha", "sk-alpha-secret-001", "کلید آلفا"),
    ]


def test_v409_lossless_pdf_import_native_embedded_resolution_and_export_roundtrip(client):
    import io
    import zipfile
    import pymupdf as fitz
    from PIL import Image, ImageChops

    # 1. High-DPI (~450 DPI) detailed raster image embedded inside a compact PDF page (288x400 pt -> 1800x2500 px = 6.25x scale)
    src_img = Image.effect_mandelbrot((1800, 2500), (-2.1, -1.5, 0.9, 1.5), 36).convert("RGB")
    src_buf = io.BytesIO()
    src_img.save(src_buf, "PNG")
    src_png = src_buf.getvalue()

    pdf_doc = fitz.open()
    p1 = pdf_doc.new_page(width=288.0, height=400.0)
    p1.insert_image(fitz.Rect(0.0, 0.0, 288.0, 400.0), stream=src_png)

    # Page 2: Rotated 90° page with native 900x1400 image -> rotated view is 1400x900
    rot_img = Image.effect_mandelbrot((900, 1400), (-1.8, -1.2, 0.8, 1.2), 24).convert("RGB")
    rot_buf = io.BytesIO()
    rot_img.save(rot_buf, "PNG")
    p2 = pdf_doc.new_page(width=450.0, height=700.0)
    p2.insert_image(fitz.Rect(0.0, 0.0, 450.0, 700.0), stream=rot_buf.getvalue())
    p2.set_rotation(90)

    # Page 3: Pure vector text page (200x300 pt -> 4.0x = 800x1200 px archival quality)
    p3 = pdf_doc.new_page(width=200.0, height=300.0)
    p3.insert_text((24, 90), "Crisp Vector Typography", fontsize=18)

    raw_pdf = pdf_doc.tobytes()
    pdf_doc.close()

    proj = client.post("/api/projects", json={"name": "v4.09 Lossless PDF"}).json()
    pid = proj["id"]
    imp = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("highres.pdf", raw_pdf, "application/pdf"))],
    )
    assert imp.status_code == 200, imp.text
    imgs = imp.json()["images"]
    assert len(imgs) == 3

    # Page 1 must keep exact 1800x2500 native dimensions (NOT downscaled to 576x800 or 1152x1600) with ZERO pixel loss
    assert (imgs[0]["width"], imgs[0]["height"]) == (1800, 2500)
    p1_content = client.get(f"/api/projects/{pid}/images/{imgs[0]['id']}/content").content
    with Image.open(io.BytesIO(p1_content)) as imported_p1:
        assert ImageChops.difference(src_img, imported_p1.convert("RGB")).getbbox() is None

    # Page 2 (rotated 90°) must keep exact 1400x900 rotated dimensions with ZERO pixel loss
    assert (imgs[1]["width"], imgs[1]["height"]) == (1400, 900)
    p2_content = client.get(f"/api/projects/{pid}/images/{imgs[1]['id']}/content").content
    expected_rot = rot_img.rotate(-90, expand=True)
    with Image.open(io.BytesIO(p2_content)) as imported_p2:
        assert ImageChops.difference(expected_rot, imported_p2.convert("RGB")).getbbox() is None

    # Page 3 (vector text) must render at crisp 4.0x (800x1200)
    assert (imgs[2]["width"], imgs[2]["height"]) == (800, 1200)

    # 2. Export Page 1 back to PDF & ZIP and verify ZERO pixel loss in both exports, plus re-importing the exported PDF!
    exp_pdf = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "pdf", "image_ids": [imgs[0]["id"]], "name": "roundtrip-hq"},
    )
    assert exp_pdf.status_code == 200, exp_pdf.text
    exported_pdf_bytes = exp_pdf.content
    with fitz.open(stream=exported_pdf_bytes, filetype="pdf") as out_doc:
        assert len(out_doc) == 1
        out_info = out_doc[0].get_image_info(xrefs=True)[0]
        assert (out_info["width"], out_info["height"]) == (1800, 2500)
        extracted = out_doc.extract_image(out_info["xref"])
        with Image.open(io.BytesIO(extracted["image"])) as out_im:
            assert ImageChops.difference(src_img, out_im.convert("RGB")).getbbox() is None

    # Re-import that exported PDF into a fresh project -> still exact 1800x2500 with ZERO pixel loss!
    proj2 = client.post("/api/projects", json={"name": "v4.09 Roundtrip 2"}).json()
    imp2 = client.post(
        f"/api/projects/{proj2['id']}/files",
        files=[("files", ("roundtrip-hq.pdf", exported_pdf_bytes, "application/pdf"))],
    )
    assert imp2.status_code == 200, imp2.text
    re_img = imp2.json()["images"][0]
    assert (re_img["width"], re_img["height"]) == (1800, 2500)
    re_content = client.get(f"/api/projects/{proj2['id']}/images/{re_img['id']}/content").content
    with Image.open(io.BytesIO(re_content)) as re_opened:
        assert ImageChops.difference(src_img, re_opened.convert("RGB")).getbbox() is None

    exp_zip = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "images", "image_ids": [imgs[0]["id"]], "name": "roundtrip-zip", "image_format": "png"},
    )
    assert exp_zip.status_code == 200, exp_zip.text
    zip_bytes = exp_zip.content
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        assert len(names) == 1
        with Image.open(io.BytesIO(zf.read(names[0]))) as zip_im:
            assert zip_im.size == (1800, 2500)
            assert ImageChops.difference(src_img, zip_im.convert("RGB")).getbbox() is None


def test_v409_grouped_pages_translated_as_single_logical_page(client, monkeypatch):
    from comic_studio.translation import TranslationService

    # Create project with 4 images: images 0, 1, 2 grouped in Group 1; image 3 ungrouped
    proj = client.post("/api/projects", json={"name": "v4.09 Grouped Translation"}).json()
    pid = proj["id"]
    up = client.post(
        f"/api/projects/{pid}/files",
        files=[
            ("files", ("slice-1.png", png_bytes(), "image/png")),
            ("files", ("slice-2.png", png_bytes(), "image/png")),
            ("files", ("slice-3.png", png_bytes(), "image/png")),
            ("files", ("page-4.png", png_bytes(), "image/png")),
        ],
    )
    assert up.status_code == 200, up.text
    state = up.json()
    for idx, text in enumerate([
        "Wait, look at",
        "that glowing door!",
        "Let us open it together.",
        "Meanwhile outside the castle...",
    ]):
        state["images"][idx]["groupId"] = 1 if idx < 3 else None
        state["images"][idx]["ocrCompleted"] = True
        state["images"][idx]["blocks"] = [{"id": 1, "text": text, "tr": "", "enabled": True}]
    saved_state = client.put(f"/api/projects/{pid}/state", json={"state": state})
    assert saved_state.status_code == 200, saved_state.text
    all_ids = [im["id"] for im in saved_state.json()["images"]]

    # Configure AI provider with ample source_limit so Group 1 fits in a single page request
    assert client.put(
        "/api/ai-settings",
        json={
            "provider": "openai",
            "providers": {
                "openai": {
                    "model": "gpt-4o-mini",
                    "profiles": [{"id": "g-key", "name": "Main", "api_key": "sk-group-test", "source_limit": 2000}],
                }
            },
        },
    ).status_code == 200

    # 1. Direct plan preview (/translation-preview) must combine Group 1 (3 images) into Call 1 and ungrouped Page 4 into Call 2
    plan_prev = client.post(
        f"/api/projects/{pid}/translation-preview",
        json={"image_ids": all_ids, "provider": "openai", "source_language": "eng"},
    )
    assert plan_prev.status_code == 200, plan_prev.text
    plan_json = plan_prev.json()
    assert plan_json["requestCount"] == 2
    assert "گروه 1" in plan_json["requests"][0]["imageName"]
    assert "Wait, look at\nthat glowing door!\nLet us open it together." in plan_json["requests"][0]["text"]
    assert plan_json["requests"][1]["imageName"] == "page-4.png"

    # 2. Rolling context engine (/context-preview -> /context-start -> /context-step) must send all 3 Group 1 slices in Step 1!
    ctx_prev = client.post(
        f"/api/projects/{pid}/context-preview",
        json={
            "image_ids": all_ids,
            "provider": "openai",
            "source_language": "eng",
            "skill": "",
            "summary": "",
            "reuse_repeated": True,
        },
    )
    assert ctx_prev.status_code == 200, ctx_prev.text
    ctx_json = ctx_prev.json()
    assert "گروه 1" in ctx_json["requests"][0]["imageName"]
    assert "صفحات هم‌گروه" in ctx_json["note"]
    assert "Wait, look at\nthat glowing door!\nLet us open it together." in ctx_json["requests"][0]["text"]
    assert "Meanwhile outside" not in ctx_json["requests"][0]["text"]

    sent_batches: list[list[str]] = []

    def fake_translate_context(self, request, text, source_texts, provider, policy, **kwargs):
        sent_batches.append(list(source_texts))
        if len(sent_batches) == 1:
            return ("صبر کن، نگاه کن به\nآن درِ درخشان!\nبیا با هم بازش کنیم.", "قهرمانان جلوی درِ درخشان ایستادند.")
        return ("در همین حال بیرون قلعه...", "صحنه به بیرون قلعه منتقل شد.")

    monkeypatch.setattr(TranslationService, "translate_context", fake_translate_context)

    started = client.post(
        f"/api/projects/{pid}/context-start",
        json={
            "image_ids": all_ids,
            "provider": "openai",
            "source_language": "eng",
            "skill": "",
            "summary": "",
            "reuse_repeated": True,
            "confirmation": ctx_json["signature"],
        },
    )
    assert started.status_code == 200, started.text
    run_id = started.json()["runId"]

    # Step 1 translates ALL 3 grouped images together in ONE request and distributes back to each image!
    step1 = client.post(
        f"/api/projects/{pid}/context-step",
        json={"run_id": run_id, "completed": 0, "skill": ""},
    )
    assert step1.status_code == 200, step1.text
    s1 = step1.json()
    assert s1["done"] is False
    assert sorted(s1["affectedImageIds"]) == sorted(all_ids[:3])
    assert sent_batches == [["Wait, look at", "that glowing door!", "Let us open it together."]]
    imgs_after_s1 = s1["project"]["images"]
    assert [imgs_after_s1[i]["blocks"][0]["tr"] for i in range(4)] == [
        "صبر کن، نگاه کن به",
        "آن درِ درخشان!",
        "بیا با هم بازش کنیم.",
        "",
    ]

    # Step 2 translates ungrouped image 4 using Group 1's rolling summary
    step2 = client.post(
        f"/api/projects/{pid}/context-step",
        json={"run_id": run_id, "completed": 1, "skill": ""},
    )
    assert step2.status_code == 200, step2.text
    s2 = step2.json()
    assert s2["done"] is True
    assert s2["affectedImageIds"] == [all_ids[3]]
    assert s2["project"]["images"][3]["blocks"][0]["tr"] == "در همین حال بیرون قلعه..."

    # 3. Changing group membership after preview invalidates stale confirmation signature cleanly (409)
    fresh_prev = client.post(
        f"/api/projects/{pid}/context-preview",
        json={
            "image_ids": all_ids,
            "provider": "openai",
            "source_language": "eng",
            "skill": "",
            "summary": "",
            "reuse_repeated": True,
        },
    )
    assert fresh_prev.status_code == 200
    cur_proj = client.get(f"/api/projects/{pid}").json()
    cur_proj["images"][2]["groupId"] = None
    assert client.put(f"/api/projects/{pid}/state", json={"state": cur_proj}).status_code == 200
    stale_start = client.post(
        f"/api/projects/{pid}/context-start",
        json={
            "image_ids": all_ids,
            "provider": "openai",
            "source_language": "eng",
            "skill": "",
            "summary": "",
            "reuse_repeated": True,
            "confirmation": fresh_prev.json()["signature"],
        },
    )
    assert stale_start.status_code == 409


def test_v410_audit_watermark_parity_bundled_models_crop_txt_surya_cache_and_preview_error(client, tmp_path, monkeypatch):
    """v4.10 end-to-end audit regression test covering watermark logo/opacity/RTL parity, bundled_models, Surya cache, crop TXT, image_content edited flag, and previewError propagation."""
    import base64
    import json
    import os
    import comic_studio.paths as paths_mod
    from comic_studio.ocr_worker import _SuryaAdapter
    from comic_studio.watermark_render import apply_watermark_pil, has_active_watermark

    # 1. Logo-only & text+logo watermark parity (UI dict schema without `mode`, dict `logos_map`, 0..100 opacity, RTL logo-right)
    logo_buf = io.BytesIO()
    Image.new("RGBA", (40, 40), (255, 0, 0, 255)).save(logo_buf, "PNG")
    logo_url = "data:image/png;base64," + base64.b64encode(logo_buf.getvalue()).decode("ascii")
    logos_map = {"logo-red": {"id": "logo-red", "name": "قرمز", "dataUrl": logo_url}}

    logo_only_wm = {
        "enabled": True,
        "text": "",
        "logoId": "logo-red",
        "logoScalePct": 25,
        "position": "center",
        "opacity": 50,
    }
    assert has_active_watermark(logo_only_wm) is True
    white = Image.new("RGB", (240, 240), (255, 255, 255))
    stamped_logo = apply_watermark_pil(white, logo_only_wm, logos_map)
    cx_r, cx_g, cx_b = stamped_logo.getpixel((120, 120))
    # 50% red over white => R stays ~255 while G/B sit near ~127 (neither untouched 255 nor 100%-opaque 0)
    assert cx_r >= 245 and 100 <= cx_g <= 155 and 100 <= cx_b <= 155

    rtl_combo = apply_watermark_pil(
        white,
        {"enabled": True, "text": "ترجمه کمیک", "logoId": "logo-red", "logoScalePct": 16, "sizePct": 6, "position": "center", "opacity": 100, "color": "#00ff00", "outline": False},
        logos_map,
    )
    red_xs = [x for y in range(240) for x in range(240) if rtl_combo.getpixel((x, y))[0] > 220 and rtl_combo.getpixel((x, y))[1] < 40]
    green_xs = [x for y in range(240) for x in range(240) if rtl_combo.getpixel((x, y))[1] > 200 and rtl_combo.getpixel((x, y))[0] < 60]
    assert red_xs and green_xs
    assert (sum(red_xs) / len(red_xs)) > (sum(green_xs) / len(green_xs)), "In RTL, logo must sit to the right of Persian text"

    # 2. bundled_models_dir discovers `bundled_models` (underscore) staged by build_offline_package.py
    fake_app_dir = tmp_path / "frozen_app"
    underscore_bundle = fake_app_dir / "bundled_models"
    underscore_bundle.mkdir(parents=True)
    monkeypatch.delenv("COMIC_STUDIO_BUNDLED_MODELS", raising=False)
    monkeypatch.setattr(paths_mod, "APP_DIR", fake_app_dir)
    assert paths_mod.bundled_models_dir() == underscore_bundle

    # 3. Surya custom-storage cache resolves llamacpp_server.{log,json} inside models_root/cache
    surya_models_root = tmp_path / "custom_drive" / "models"
    surya_dir = surya_models_root / "cache" / "datalab" / "surya"
    surya_dir.mkdir(parents=True)
    (surya_dir / "llamacpp_server.log").write_text("booting\nCUDA out of memory\n", encoding="utf-8")
    (surya_dir / "llamacpp_server.json").write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
    monkeypatch.setenv("XDG_CACHE_HOME", str(surya_models_root / "cache"))
    adapter = _SuryaAdapter(surya_models_root)
    assert "CUDA out of memory" in adapter._read_llama_server_error_tail()
    adapter.close()
    assert not (surya_dir / "llamacpp_server.json").exists()

    # 4. image_content(cropped=True) honors edited=False vs edited=True AND renders unedited watermarked previews, while build_txt filters cropped-out blocks
    proj = client.post("/api/projects", json={"name": "v4.10 Audit"}).json()
    pid = proj["id"]
    orig_blue = png_bytes((200, 200), "blue")
    up = client.post(f"/api/projects/{pid}/files", files=[("files", ("page1.png", orig_blue, "image/png"))])
    assert up.status_code == 200
    proj = up.json()
    iid = proj["images"][0]["id"]

    # Save an edited red render, then set crop + inside/outside blocks
    edited_red = png_bytes((200, 200), "red")
    assert client.post(f"/api/projects/{pid}/images/{iid}/rendered", content=edited_red, headers={"Content-Type": "image/png"}).status_code == 200
    proj = client.get(f"/api/projects/{pid}").json()
    proj["images"][0]["crop"] = {"x": 20, "y": 40, "w": 120, "h": 120}
    proj["images"][0]["blocks"] = [
        {"id": 1, "text": "NOISY HEADER", "tr": "سرصفحه مزاحم", "x0": 25, "y0": 4, "x1": 110, "y1": 24, "enabled": True},
        {"id": 2, "text": "CLEAN BODY", "tr": "متن اصلی داخل کادر", "x0": 30, "y0": 60, "x1": 120, "y1": 100, "enabled": True},
    ]
    assert client.put(f"/api/projects/{pid}/state", json={"state": proj}).status_code == 200

    raw_crop_res = client.get(f"/api/projects/{pid}/images/{iid}/content?cropped=true")
    ed_crop_res = client.get(f"/api/projects/{pid}/images/{iid}/content?edited=true&cropped=true")
    with Image.open(io.BytesIO(raw_crop_res.content)) as im_raw, Image.open(io.BytesIO(ed_crop_res.content)) as im_ed:
        assert im_raw.size == (120, 120) and im_ed.size == (120, 120)
        assert im_raw.getpixel((10, 10))[:3] == (0, 0, 255), "edited=False must crop original blue image, not edited red"
        assert im_ed.getpixel((10, 10))[:3] == (255, 0, 0), "edited=True must crop edited red image"

    txt_export = client.post(f"/api/projects/{pid}/export", json={"kind": "txt", "image_ids": [iid], "name": "cropped-txt"})
    assert txt_export.status_code == 200
    txt_body = txt_export.content.decode("utf-8")
    assert "CLEAN BODY" in txt_body and "متن اصلی داخل کادر" in txt_body
    assert "NOISY HEADER" not in txt_body and "سرصفحه مزاحم" not in txt_body

    # Revert edited render, attach logo-only watermark, remove crop -> /content?cropped=true renders watermark!
    assert client.post(f"/api/projects/{pid}/images/{iid}/revert").status_code == 200
    proj = client.get(f"/api/projects/{pid}").json()
    proj["settings"] = proj.get("settings") or {}
    proj["settings"]["watermarkLogos"] = logos_map
    proj["images"][0]["crop"] = None
    proj["images"][0]["watermark"] = logo_only_wm
    assert client.put(f"/api/projects/{pid}/state", json={"state": proj}).status_code == 200
    wm_prev_res = client.get(f"/api/projects/{pid}/images/{iid}/content?cropped=true")
    with Image.open(io.BytesIO(wm_prev_res.content)) as wm_im:
        assert wm_im.getpixel((100, 100))[0] > 100, "Unedited watermarked page preview must composite red logo"

    # 5. context_start & context_text_translate surface actionable previewError instead of generic empty-text error
    import comic_studio.local_nmt as nmt_mod
    monkeypatch.setattr(nmt_mod, "models_dir", lambda: tmp_path / "empty_nmt_models")
    prev_local = client.post(
        f"/api/projects/{pid}/context-preview",
        json={"image_ids": [iid], "provider": "local", "source_language": "eng", "skill": "", "summary": "", "reuse_repeated": True},
    )
    assert prev_local.status_code == 200
    prev_json = prev_local.json()
    assert prev_json["previewError"] and "دانلود" in prev_json["previewError"]
    start_local = client.post(
        f"/api/projects/{pid}/context-start",
        json={"image_ids": [iid], "provider": "local", "source_language": "eng", "skill": "", "summary": "", "reuse_repeated": True, "confirmation": prev_json["signature"]},
    )
    assert start_local.status_code == 400
    assert start_local.json()["detail"] == prev_json["previewError"]
    assert "متنی برای ترجمه وجود ندارد" not in start_local.json()["detail"]

    # Single-box context_text_preview & context_text_translate also surface actionable previewError instead of generic empty-text error
    single_prev = client.post(
        "/api/translate-text/context-preview",
        json={"text": "Hello world!", "provider": "local", "source_language": "eng", "target_language": "fa"},
    )
    assert single_prev.status_code == 200
    single_json = single_prev.json()
    assert single_json["previewError"] and "دانلود" in single_json["previewError"]
    single_exec = client.post(
        "/api/translate-text/context",
        json={
            "text": "Hello world!",
            "provider": "local",
            "source_language": "eng",
            "target_language": "fa",
            "confirmation": single_json["signature"],
        },
    )
    assert single_exec.status_code == 400
    assert single_exec.json()["detail"] == single_json["previewError"]
    assert "متنی برای ترجمه وجود ندارد" not in single_exec.json()["detail"]


def test_v411_export_prepare_stream_non_empty_guard_pdf_fallback_moved_box_erase_and_pure_asgi(client, tmp_path, monkeypatch):
    """v4.11 regression test for empty-export fix, prepared direct-stream downloads, PDF C-save fallback, moved-box erase, and pure ASGI middleware."""
    import re
    from pathlib import Path
    from starlette.middleware.base import BaseHTTPMiddleware
    import comic_studio.exporter as exp_mod
    from comic_studio.paths import project_root

    # 1. Pure ASGI middleware: zero BaseHTTPMiddleware wrappers that buffer/truncate large FileResponse streams
    assert all(
        not (isinstance(m.cls, type) and issubclass(m.cls, BaseHTTPMiddleware))
        for m in client.app.user_middleware
    ), "app must not use BaseHTTPMiddleware around streaming FileResponse routes"

    # Create project with Persian default-like name + dark text in top-left box moved to bottom-right with custom hex bg
    proj = client.post("/api/projects", json={"name": "پروژهٔ کمیک ۴.۱۱"}).json()
    pid = proj["id"]

    canvas_img = Image.new("RGB", (240, 240), (255, 255, 255))
    # Draw black ink at original OCR box (20..100, 20..60) so we can verify moved-box source erasing in Visual DOCX
    for x in range(30, 90):
        for y in range(30, 50):
            canvas_img.putpixel((x, y), (0, 0, 0))
    buf = io.BytesIO()
    canvas_img.save(buf, "PNG")
    proj = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("page1.png", buf.getvalue(), "image/png"))],
    ).json()
    iid = proj["images"][0]["id"]
    proj["images"][0]["blocks"] = [
        {
            "id": 1,
            "text": "ORIGINAL INK",
            "tr": "متن جابه‌جاشده",
            "enabled": True,
            "x0": 20,
            "y0": 20,
            "x1": 100,
            "y1": 60,
            "tx0": 120,
            "ty0": 140,
            "tx1": 220,
            "ty1": 210,
            "bg": "#ff2244",
        }
    ]
    assert client.put(f"/api/projects/{pid}/state", json={"state": proj}).status_code == 200

    # 2. Prepared export token flow (X-Export-Prepare: 1) works across all 5 formats & supports repeat downloads
    for kind, magic in [
        ("pdf", b"%PDF-"),
        ("images", b"PK\x03\x04"),
        ("txt", "\ufeff".encode("utf-8")),
        ("docx", b"PK\x03\x04"),
        ("pptx", b"PK\x03\x04"),
    ]:
        prep = client.post(
            f"/api/projects/{pid}/export",
            headers={"X-Export-Prepare": "1"},
            json={"kind": kind, "image_ids": [iid], "name": "پروژهٔ کمیک"},
        )
        assert prep.status_code == 200, (kind, prep.text)
        prep_json = prep.json()
        assert re.fullmatch(r"[0-9a-f]{32}", prep_json["token"])
        assert prep_json["size"] > 0
        dl1 = client.get(f"/api/projects/{pid}/export/{prep_json['token']}")
        dl2 = client.get(f"/api/projects/{pid}/export/{prep_json['token']}")
        assert dl1.status_code == 200 and dl2.status_code == 200
        assert len(dl1.content) == prep_json["size"] and dl1.content == dl2.content
        assert dl1.content.startswith(magic)

        if kind == "docx":
            with zipfile.ZipFile(io.BytesIO(dl1.content)) as zf:
                bg_png = zf.read("word/media/page_001.png")
            with Image.open(io.BytesIO(bg_png)) as bg_im:
                # Original OCR box (40, 40) was erased back to white; moved target box (160, 170) filled with #ff2244
                assert bg_im.getpixel((40, 40))[:3] == (255, 255, 255)
                r_px, g_px, b_px = bg_im.getpixel((160, 170))[:3]
                assert r_px > 230 and g_px < 60 and b_px < 90

        # Discard token via DELETE -> 404 on token URL, while exports/ file on disk remains intact for project backups
        assert client.delete(f"/api/projects/{pid}/export/{prep_json['token']}").status_code == 204
        assert client.get(f"/api/projects/{pid}/export/{prep_json['token']}").status_code == 404
        saved_export = project_root(pid) / "exports" / prep_json["filename"]
        assert saved_export.is_file() and saved_export.stat().st_size == prep_json["size"]

    # 3. _atomic_export_path refuses 0-byte temp outputs and never clobbers an existing good export
    existing_out = tmp_path / "good-export.pdf"
    existing_out.write_bytes(b"%PDF-1.7-valid")
    with pytest.raises(ValueError, match="خالی"):
        with exp_mod._atomic_export_path(existing_out) as _tmp_zero:
            pass  # leaves 0-byte mkstemp placeholder untouched
    assert existing_out.read_bytes() == b"%PDF-1.7-valid"

    # 4. Server-side 0-byte export guard returns HTTP 500 with Persian message instead of 200 OK empty body
    empty_file = tmp_path / "empty-broken.txt"
    empty_file.write_bytes(b"")
    orig_build_txt = exp_mod.build_txt
    import comic_studio.main as main_mod
    monkeypatch.setattr(main_mod, "build_txt", lambda *_a, **_kw: empty_file)
    zero_res = client.post(f"/api/projects/{pid}/export", json={"kind": "txt", "image_ids": [iid]})
    assert zero_res.status_code == 500
    assert "خالی" in zero_res.json()["detail"]
    monkeypatch.setattr(main_mod, "build_txt", orig_build_txt)

    # 5. build_pdf falls back to document.tobytes() when PyMuPDF C path save fails on special Windows/UNC paths
    import pymupdf as fitz
    orig_doc_save = fitz.Document.save

    def broken_c_save(self, *args, **kwargs):
        if args and isinstance(args[0], (str, Path)):
            raise RuntimeError("Simulated Win32 C path save failure")
        return orig_doc_save(self, *args, **kwargs)

    monkeypatch.setattr(fitz.Document, "save", broken_c_save)
    fallback_pdf = client.post(f"/api/projects/{pid}/export", json={"kind": "pdf", "image_ids": [iid], "name": "fallback-test"})
    monkeypatch.setattr(fitz.Document, "save", orig_doc_save)
    assert fallback_pdf.status_code == 200
    assert fallback_pdf.content.startswith(b"%PDF-") and len(fallback_pdf.content) > 500

    # 6. image_payload ignores 0-byte or reverted stale -edited.png files
    stale_edited = project_root(pid) / "images" / f"{iid}-edited.png"
    stale_edited.write_bytes(b"")
    data_bytes, ext_str, w_out, h_out = exp_mod.image_payload(client.app.state if hasattr(client.app.state, "get") else exp_mod.ProjectStore(), pid, proj["images"][0])
    assert len(data_bytes) > 100 and ext_str == "png" and (w_out, h_out) == (240, 240)
    stale_edited.unlink(missing_ok=True)


def test_v412_exporter_shapes_rotation_corner_radius_and_font_family(client):
    """v4.12 regression test for custom fontFamily, box shapes, cornerRadius, and angle in Visual & Flowing DOCX/PPTX."""
    import zipfile

    proj = client.post("/api/projects", json={"name": "پروژه ۴.۱۲"}).json()
    pid = proj["id"]
    big_img = Image.new("RGB", (260, 220), (255, 255, 255))
    img_buf = io.BytesIO()
    big_img.save(img_buf, "PNG")
    state = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("page412.png", img_buf.getvalue(), "image/png"))],
    ).json()
    state["images"][0]["blocks"] = [
        {
            "id": 1,
            "x0": 20, "y0": 20, "x1": 220, "y1": 80,
            "tx0": 25, "ty0": 25, "tx1": 225, "ty1": 85,
            "text": "HELLO HERO",
            "tr": "سلام قهرمان",
            "richHtml": '<p><span style="font-family:Tahoma">سلام</span> قهرمان</p>',
            "enabled": True,
            "bg": "#fff3b0",
            "color": "#dd2255",
            "fontFamily": "Impact",
            "shape": "rect",
            "cornerRadius": 40,
            "angle": 30,
            "dir": "rtl",
            "align": "center",
        },
        {
            "id": 2,
            "x0": 30, "y0": 100, "x1": 210, "y1": 160,
            "text": "",
            "tr": "فکر عمیق!",
            "richHtml": "",
            "enabled": True,
            "manual": True,
            "manualLang": "fa",
            "bg": "white",
            "fontFamily": "Comic Sans MS",
            "shape": "cloud",
            "cornerRadius": 0,
            "angle": -15,
            "dir": "rtl",
            "align": "center",
        },
    ]
    iid = state["images"][0]["id"]
    put_res = client.put(f"/api/projects/{pid}/state", json={"state": state})
    assert put_res.status_code == 200

    docx_res = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "docx", "image_ids": [iid], "docx_layout": "visual", "docx_mode": "translation"},
    )
    assert docx_res.status_code == 200, docx_res.text
    with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
        assert 'w:ascii="Tahoma"' in doc_xml
        assert 'w:ascii="Impact"' in doc_xml
        assert 'w:ascii="Comic Sans MS"' in doc_xml
        assert "rotation:30.00;" in doc_xml
        assert "rotation:-15.00;" in doc_xml

    pptx_res = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "pptx", "image_ids": [iid], "pptx_layout": "visual", "pptx_mode": "translation"},
    )
    assert pptx_res.status_code == 200, pptx_res.text
    with zipfile.ZipFile(io.BytesIO(pptx_res.content)) as zf:
        slide_xml = zf.read("ppt/slides/slide1.xml").decode("utf-8")
        assert 'rot="1800000"' in slide_xml  # +30 deg * 60000
        assert 'rot="20700000"' in slide_xml  # -15 deg -> 345 deg * 60000
        assert 'prst="roundRect"' in slide_xml and 'val 20000' in slide_xml  # 40% * 500
        assert 'prst="cloud"' in slide_xml
        assert 'typeface="Tahoma"' in slide_xml
        assert 'typeface="Comic Sans MS"' in slide_xml


def test_v413_full_audit_backend_fixes(client, tmp_path, monkeypatch):
    """v4.13 regression test covering bundled rapidocr-v5 validation, frozen PyInstaller anti-recursion,
    manual-box styling preservation in context_run, 0-byte edited PNG guards, browser preferences, and data-font export."""
    import sys
    from PIL import Image
    import comic_studio.browser as browser_mod
    import comic_studio.context_run as context_run_mod
    import comic_studio.ocr as ocr_mod
    import comic_studio.ocr_managed as managed_mod
    from comic_studio.paths import project_root

    # 1. Bundled rapidocr-v5 validates against _effective_v5_dir (offline .exe) & hides non-functional uninstall
    bundled = tmp_path / "bundled_models"
    (bundled / "rapidocr").mkdir(parents=True)
    (bundled / "rapidocr" / "ch_PP-OCRv5_det_mobile.onnx").write_bytes(b"ONNX-DET-WEIGHTS")
    (bundled / "rapidocr" / "latin_PP-OCRv5_rec_mobile.onnx").write_bytes(b"ONNX-REC-WEIGHTS")
    monkeypatch.setenv("COMIC_STUDIO_BUNDLED_MODELS", str(bundled))
    v5 = ocr_mod.RapidEngine("rapidocr-v5", "v5")
    monkeypatch.setattr(ocr_mod.RapidEngine, "runtime_installed", property(lambda _self: True))
    assert "eng" in v5.ready_languages
    # Must NOT raise OcrError when user writable models/rapidocr is empty!
    v5._validate_ready("eng", allow_download=False)
    assert managed_mod.engine_has_uninstallable_files("rapidocr-v5", v5) is False
    monkeypatch.delenv("COMIC_STUDIO_BUNDLED_MODELS", raising=False)

    # 2. Frozen PyInstaller mode never spawns sys.executable as python -m pip / venv
    fake_exe = tmp_path / "ComicOCRStudio.exe"
    fake_exe.write_bytes(b"MZ")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(fake_exe))
    monkeypatch.setattr(ocr_mod.shutil, "which", lambda _name: None)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "no_py"))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "no_py2"))
    try:
        ocr_mod._resolve_pip_python_executable(match_current_minor=True)
        raise AssertionError("Expected OcrError when frozen without host Python")
    except ocr_mod.OcrError as exc:
        assert ".exe" in str(exc)
    monkeypatch.delattr(sys, "frozen", raising=False)

    # 3. context_run.apply_translated_block_defaults preserves manual/cloned box custom size, align, bold, verticalAlign
    manual_blk = {
        "id": 1, "manual": True, "manualLang": "en", "textMode": "ocr",
        "size": 28, "align": "center", "verticalAlign": "middle", "bold": True,
    }
    context_run_mod.apply_translated_block_defaults(manual_blk, "fa")
    assert manual_blk["dir"] == "rtl"
    assert manual_blk["textMode"] == "translation"
    assert manual_blk["size"] == 28
    assert manual_blk["align"] == "center"
    assert manual_blk["verticalAlign"] == "middle"
    assert manual_blk["bold"] is True

    # 4. browser.save_preferences creates missing parent directories & writes atomically
    pref_data = tmp_path / "fresh_prefs_dir"
    monkeypatch.setattr(browser_mod, "data_dir", lambda: pref_data)
    browser_mod.save_preferences("edge", "new")
    assert browser_mod.load_preferences() == ("edge", "new")

    # 5. store.py ignores 0-byte -edited.png and exporter.py supports data-font + Arial Black + manual box in OCR mode
    proj = client.post("/api/projects", json={"name": "پروژه ۴.۱۳"}).json()
    pid = proj["id"]
    buf = io.BytesIO()
    Image.new("RGB", (280, 220), (245, 245, 250)).save(buf, format="PNG")
    up = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("page1.png", buf.getvalue(), "image/png"))],
    )
    assert up.status_code == 200
    state = up.json()
    iid = state["images"][0]["id"]
    zero_edited = project_root(pid) / "images" / f"{iid}-edited.png"
    zero_edited.write_bytes(b"")
    state["images"][0]["blocks"] = [
        {
            "id": 1, "x0": 20, "y0": 20, "x1": 240, "y1": 110,
            "text": "", "tr": "کادر دستی فارسی در حالت OCR",
            "richHtml": '<p><span data-font="Arial Black">کادر دستی فارسی در حالت OCR</span></p>',
            "manual": True, "manualLang": "fa", "enabled": True, "dir": "rtl", "align": "center",
        }
    ]
    saved_state = client.put(f"/api/projects/{pid}/state", json={"state": state}).json()
    assert saved_state["images"][0]["edited"] is False
    assert client.get(f"/api/projects/{pid}/images/{iid}/content?edited=true").status_code == 404
    dup_state = client.post(f"/api/projects/{pid}/duplicate", json=[iid]).json()
    assert len(dup_state["images"]) == 2
    assert dup_state["images"][1]["edited"] is False

    docx_ocr = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "docx", "image_ids": [iid], "docx_layout": "flowing", "docx_mode": "ocr"},
    )
    assert docx_ocr.status_code == 200
    with zipfile.ZipFile(io.BytesIO(docx_ocr.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
        assert "کادر دستی فارسی در حالت OCR" in doc_xml
        assert 'w:ascii="Arial Black"' in doc_xml


def test_v414_writing_shapes_pil_docx_and_pptx(client):
    """v4.14 regression test covering all 14 writing shapes (star, burst, seal, cloud, thought,
    speech, octagon, heart, banner, etc.) across PIL masks, Visual DOCX, and Visual PPTX exports.
    """
    from comic_studio.exporter import (
        _ALLOWED_BOX_SHAPES,
        _draw_shaped_box_pil,
        _normalize_box_shape,
        _pptx_prst_geom_xml,
        _shape_insets_px,
    )

    assert len(_ALLOWED_BOX_SHAPES) == 14
    for sh in _ALLOWED_BOX_SHAPES:
        assert _normalize_box_shape(sh) == sh
        canvas = Image.new("RGB", (220, 180), (30, 40, 50))
        _draw_shaped_box_pil(
            canvas, 20, 20, 200, 160, (255, 255, 255), shape=sh, corner_radius_pct=20.0, angle_deg=0.0
        )
        # Center of the main body (upper half for callouts) must receive the white fill
        assert canvas.getpixel((110, 75)) == (255, 255, 255), f"shape {sh} did not fill interior"
        canvas.close()

    # Thought and speech reserve larger bottom insets than top insets
    px_t, pt_t, pb_t = _shape_insets_px(200, 140, "thought", 0.0)
    assert pb_t > pt_t and px_t >= 28.0
    assert 'prst="star5"' in _pptx_prst_geom_xml("star", 0.0)
    assert 'prst="star12"' in _pptx_prst_geom_xml("burst", 0.0)
    assert 'prst="star8"' in _pptx_prst_geom_xml("seal", 0.0)
    assert 'prst="cloudCallout"' in _pptx_prst_geom_xml("thought", 0.0)
    assert 'prst="wedgeRoundRectCallout"' in _pptx_prst_geom_xml("speech", 0.0)
    assert 'prst="heart"' in _pptx_prst_geom_xml("heart", 0.0)
    assert 'prst="ribbon2"' in _pptx_prst_geom_xml("banner", 0.0)

    proj = client.post("/api/projects", json={"name": "پروژه شکل‌های ۴.۱۴"}).json()
    pid = proj["id"]
    buf = io.BytesIO()
    Image.new("RGB", (400, 320), (40, 50, 60)).save(buf, format="PNG")
    up = client.post(
        f"/api/projects/{pid}/files",
        files=[("files", ("shapes.png", buf.getvalue(), "image/png"))],
    )
    assert up.status_code == 200
    state = up.json()
    iid = state["images"][0]["id"]
    state["images"][0]["blocks"] = [
        {
            "id": 1, "x0": 20, "y0": 20, "x1": 180, "y1": 140,
            "text": "", "tr": "ستارهٔ درخشان", "manual": True, "enabled": True,
            "shape": "star", "bg": "#fff3b0", "angle": -10,
        },
        {
            "id": 2, "x0": 200, "y0": 20, "x1": 380, "y1": 150,
            "text": "", "tr": "ابر فکر حباب‌دار", "manual": True, "enabled": True,
            "shape": "thought", "bg": "white", "angle": 0,
        },
        {
            "id": 3, "x0": 20, "y0": 170, "x1": 200, "y1": 300,
            "text": "", "tr": "فریاد انفجاری!", "manual": True, "enabled": True,
            "shape": "burst", "bg": "#ffd6d6", "angle": 8,
        },
        {
            "id": 4, "x0": 220, "y0": 170, "x1": 380, "y1": 300,
            "text": "", "tr": "", "manual": True, "enabled": True,
            "shape": "speech", "bg": "white", "angle": 0,
        },
    ]
    assert client.put(f"/api/projects/{pid}/state", json={"state": state}).status_code == 200

    pptx_res = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "pptx", "image_ids": [iid], "pptx_layout": "visual", "pptx_mode": "translation"},
    )
    assert pptx_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(pptx_res.content)) as zf:
        slide_xml = zf.read("ppt/slides/slide1.xml").decode("utf-8")
        assert 'prst="star5"' in slide_xml
        assert 'prst="cloudCallout"' in slide_xml
        assert 'prst="star12"' in slide_xml
        assert 'prst="wedgeRoundRectCallout"' in slide_xml
        assert "ستارهٔ درخشان" in slide_xml
        assert "ابر فکر حباب‌دار" in slide_xml

    docx_res = client.post(
        f"/api/projects/{pid}/export",
        json={"kind": "docx", "image_ids": [iid], "docx_layout": "visual", "docx_mode": "translation"},
    )
    assert docx_res.status_code == 200
    with zipfile.ZipFile(io.BytesIO(docx_res.content)) as zf:
        doc_xml = zf.read("word/document.xml").decode("utf-8")
        assert "ستارهٔ درخشان" in doc_xml
        assert "فریاد انفجاری!" in doc_xml
        assert "comicbox_4" in doc_xml


























