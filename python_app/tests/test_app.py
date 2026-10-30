from __future__ import annotations

import io
import zipfile

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
    assert health.json()["version"] == "3.17"
    assert health.json()["scraping"] is False
    assert client.get("/").status_code == 200
    assert "Comic OCR Studio" in client.get("/").text
    assert '<span class="ver">۳.۱۷ · Python</span>' in client.get("/").text
    assert client.get("/typeset.js").status_code == 200


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


def test_translation_sends_all_selected_text_as_one_plain_payload(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, item = make_project(client)
    project["images"][0]["blocks"] = [
        {"id": 1, "text": "Hello", "tr": "old", "richHtml": "old", "enabled": True, "x0": 10, "y0": 10, "x1": 180, "y1": 35, "lineH": 25},
        {"id": 2, "text": "world", "tr": "old", "richHtml": "old", "enabled": True, "x0": 30, "y0": 42, "x1": 160, "y1": 67, "lineH": 25},
        {"id": 3, "text": "Another bubble", "tr": "old", "richHtml": "old", "enabled": True, "x0": 10, "y0": 150, "x1": 180, "y1": 175, "lineH": 25},
    ]
    response = client.put(f"/api/projects/{project['id']}/state", json={"state": project})
    assert response.status_code == 200
    calls = []

    def fake_free(self, text, source_language):
        calls.append(text)
        return "سلام&#10دنیا&amp;#10;حباب دیگر"

    monkeypatch.setattr(TranslationService, "_free", fake_free)
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": [item["id"]], "provider": "free", "source_language": "eng"})
    assert response.status_code == 200, response.text
    assert calls == ["Hello\nworld\nAnother bubble"]
    blocks = response.json()["images"][0]["blocks"]
    assert [block["tr"] for block in blocks] == ["سلام", "دنیا", "حباب دیگر"]
    assert all(block["richHtml"] == "" for block in blocks)
    assert all("[[[" not in block["tr"] and "&#10" not in block["tr"] for block in blocks)
    feed = client.get("/api/activity?after=0").json()["entries"]
    assert any("یک درخواست" in entry["message"] and entry["progress"] == pytest.approx(1.0) for entry in feed)


def test_translation_uses_one_request_across_images_and_reports_stages(client, monkeypatch):
    from comic_studio.translation import TranslationService
    project, _ = make_project(client)
    response = client.post(
        f"/api/projects/{project['id']}/files",
        files=[("files", ("second.png", png_bytes(), "image/png"))],
    )
    project = response.json()
    for image_index, image in enumerate(project["images"]):
        image["blocks"] = [
            {"id": 1, "text": f"Page {image_index} first", "enabled": True, "x0": 10, "y0": 10, "x1": 180, "y1": 35, "lineH": 25},
            {"id": 2, "text": f"Page {image_index} distant", "enabled": True, "x0": 10, "y0": 150, "x1": 180, "y1": 175, "lineH": 25},
        ]
    assert client.put(f"/api/projects/{project['id']}/state", json={"state": project}).status_code == 200
    calls = []

    def fake_translate(self, text, source_language, provider=None):
        calls.append(text)
        return "یک\nدو\nسه\nچهار"

    monkeypatch.setattr(TranslationService, "translate", fake_translate)
    ids = [image["id"] for image in project["images"]]
    response = client.post(f"/api/projects/{project['id']}/translate", json={"image_ids": ids, "provider": "free", "source_language": "eng"})
    assert response.status_code == 200, response.text
    assert calls == ["Page 0 first\nPage 0 distant\nPage 1 first\nPage 1 distant"]
    assert [[block["tr"] for block in image["blocks"]] for image in response.json()["images"]] == [["یک", "دو"], ["سه", "چهار"]]
    feed = client.get("/api/activity?after=0").json()["entries"]
    assert any("تقسیم" in entry["message"] and entry["progress"] == pytest.approx(0.5) for entry in feed)
    assert any("یک درخواست" in entry["message"] and entry["progress"] == pytest.approx(1.0) for entry in feed)


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
