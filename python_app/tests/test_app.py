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
    assert health.json()["version"] == "3.04"
    assert health.json()["scraping"] is False
    assert client.get("/").status_code == 200
    assert "Comic OCR Studio" in client.get("/").text
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
    project["images"].reverse()
    response = client.put(f"/api/projects/{project_id}/state", json={"state": project})
    assert response.status_code == 200
    assert response.json()["images"][0]["groupId"] == "گروه ۱"
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
