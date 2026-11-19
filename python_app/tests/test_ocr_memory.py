"""Regression coverage for cleanup between pages with a resident PP-OCR model.

These tests use fake runtimes: they verify lifecycle and cleanup, not a Windows
native crash or recognition accuracy with the user's original document.
"""
from __future__ import annotations

import gc
import io
from types import SimpleNamespace
import weakref

import pytest
from PIL import Image

from comic_studio import ocr_managed as managed
from comic_studio.main import create_app
from comic_studio.ocr import RapidEngine
from support_client import scoped_client


@pytest.mark.parametrize("platform_name", ["nt", "posix"])
def test_between_page_cleanup_never_calls_native_heap_or_global_gpu_apis(monkeypatch, platform_name):
    calls = []

    def touched(*args, **kwargs):
        calls.append("native")
        return 1

    # Record even calls hidden by an `except Exception` block. No real native
    # function is used, so this exercises the Windows branch safely on Linux.
    native = SimpleNamespace(
        GetCurrentProcess=touched, EmptyWorkingSet=touched,
        SetProcessWorkingSetSize=touched, _heapmin=touched, malloc_trim=touched,
    )
    gpu = SimpleNamespace(
        is_available=touched, empty_cache=touched, ipc_collect=touched,
        is_compiled_with_cuda=touched, device_count=touched,
    )
    monkeypatch.setattr(managed.ctypes, "windll", SimpleNamespace(kernel32=native, psapi=native), raising=False)
    monkeypatch.setattr(managed.ctypes, "cdll", SimpleNamespace(msvcrt=native))
    monkeypatch.setattr(managed.ctypes, "CDLL", lambda *a, **kw: (calls.append("CDLL") or native))
    monkeypatch.setitem(managed.sys.modules, "torch", SimpleNamespace(cuda=gpu, mps=gpu))
    monkeypatch.setitem(managed.sys.modules, "paddle", SimpleNamespace(device=SimpleNamespace(cuda=gpu)))
    collections = []
    monkeypatch.setattr(gc, "collect", lambda: collections.append(True))
    # os is shared by pathlib and pytest; restore it before making assertions.
    with monkeypatch.context() as mp:
        mp.setattr(managed.os, "name", platform_name)
        mp.setattr(managed.sys, "platform", "win32" if platform_name == "nt" else "linux")
        for _ in range(64):
            managed.trim_process_memory()
    assert collections == [True] * 64
    assert calls == []


def test_cleanup_still_collects_unreachable_objects_without_destroying_live_session():
    class Session:
        pass

    live = Session()
    live_ref = weakref.ref(live)
    abandoned = Session()
    abandoned.cycle = abandoned
    abandoned_ref = weakref.ref(abandoned)
    del abandoned
    managed.trim_process_memory()
    assert abandoned_ref() is None
    assert live_ref() is live


@pytest.mark.parametrize("engine_id,version", [("rapidocr-v5", "v5"), ("rapidocr-v6", "v6")])
def test_32_paged_ocr_requests_reuse_session_save_each_page_and_unload_at_end(tmp_path, monkeypatch, engine_id, version):
    import comic_studio.main as main_mod

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    created = []
    active_engines = []

    def create(engine, language):
        session = object()
        created.append(session)
        return session

    def recognize(engine, image, language, *args, **kwargs):
        assert engine.id == engine_id and engine.version == version
        active_engines.append(engine)
        assert engine._get(language) is created[0]
        return [{"id": 1, "text": "page text", "tr": "", "conf": 96,
                 "x0": 5, "y0": 5, "x1": 80, "y1": 25, "lineH": 20}]

    monkeypatch.setattr(RapidEngine, "_validate_ready", lambda *a, **kw: None)
    monkeypatch.setattr(RapidEngine, "_create", create)
    monkeypatch.setattr(main_mod, "recognize_image", recognize)
    content = io.BytesIO()
    with Image.new("RGB", (100, 60), "white") as image:
        image.save(content, "PNG")
    data = content.getvalue()

    with scoped_client(create_app()) as client:
        project_id = client.post("/api/projects", json={"name": "32 pages"}).json()["id"]
        uploaded = client.post(f"/api/projects/{project_id}/files", files=[
            ("files", (f"page-{i}.png", data, "image/png")) for i in range(32)
        ])
        assert uploaded.status_code == 200, uploaded.text
        image_ids = [item["id"] for item in uploaded.json()["images"]]
        assert len(image_ids) == 32
        for index, image_id in enumerate(image_ids, start=1):
            result = client.post(f"/api/projects/{project_id}/ocr", json={
                "engine": engine_id, "language": "eng", "image_ids": [image_id],
                "keep_engine_loaded": index < 32, "batch_index": index, "batch_total": 32,
            })
            assert result.status_code == 200, result.text
            rendered = client.post(f"/api/projects/{project_id}/images/{image_id}/rendered",
                                   content=data, headers={"Content-Type": "image/png"})
            assert rendered.status_code == 200, rendered.text
            # Read durable state, rather than trusting only the OCR response.
            saved = client.get(f"/api/projects/{project_id}").json()
            assert sum(bool(item.get("ocrCompleted")) for item in saved["images"]) == index
            assert all(item["blocks"][0]["text"] == "page text"
                       for item in saved["images"] if item.get("ocrCompleted"))
            assert len(created) == 1
            assert active_engines[-1].is_loaded_in_ram is (index < 32)
        assert client.get("/api/health").status_code == 200
        assert len(active_engines) == 32
