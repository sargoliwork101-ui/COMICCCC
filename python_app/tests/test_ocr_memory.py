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


@pytest.mark.parametrize("mode", ["RGB", "RGBA", "L"])
def test_bright_text_fallback_preserves_pixels_and_releases_rgb_arrays_before_output(monkeypatch, mode):
    import cv2
    import numpy as np
    from PIL import ImageOps
    import comic_studio.ocr as ocr

    rng = np.random.default_rng(27)
    source = Image.fromarray(rng.integers(0, 256, (73, 121, 3), dtype=np.uint8)).convert(mode)
    # Reference: the exact previous cubic -> grayscale -> threshold -> invert path.
    rgb = np.asarray(ImageOps.exif_transpose(source).convert("RGB"))
    enlarged = cv2.resize(rgb, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_RGB2GRAY)
    _, bright = cv2.threshold(gray, ocr.EXTRA_PREPROCESS_THRESHOLD, 255, cv2.THRESH_BINARY)
    expected = cv2.cvtColor(cv2.bitwise_not(bright), cv2.COLOR_GRAY2RGB)
    del rgb, enlarged, gray, bright

    enlarged_refs = []
    original_resize = cv2.resize
    original_fromarray = Image.fromarray

    def resize(*args, **kwargs):
        result = original_resize(*args, **kwargs)
        enlarged_refs.append(weakref.ref(result))
        return result

    def fromarray(*args, **kwargs):
        # A live 3x RGB intermediate here used to overlap with the final RGB
        # allocation and three full-size masks. It is no longer needed.
        assert enlarged_refs and all(ref() is None for ref in enlarged_refs)
        return original_fromarray(*args, **kwargs)

    monkeypatch.setattr(cv2, "resize", resize)
    monkeypatch.setattr(Image, "fromarray", fromarray)
    with ocr._extra_preprocess_image(source) as result:
        assert result.size == (363, 219)
        assert np.array_equal(np.asarray(result), expected)
    source.getpixel((0, 0))  # the caller still owns its input
    source.close()


@pytest.mark.parametrize("failure", [None, "contrast", "resize"])
def test_preprocess_closes_replaced_images_even_on_failure(monkeypatch, failure):
    from PIL import ImageOps
    import comic_studio.ocr as ocr

    with Image.new("RGB", (50, 30), "white") as source:
        base = source.copy()
        contrast_copy = source.copy()
        monkeypatch.setattr(ocr, "_to_white_backed_rgb", lambda image: base)

        def contrast(image, **kwargs):
            assert image is base
            if failure == "contrast":
                raise RuntimeError("contrast failed")
            return contrast_copy

        original_resize = Image.Image.resize

        def resize(image, *args, **kwargs):
            if image is contrast_copy:
                with pytest.raises(ValueError, match="closed"):
                    base.getpixel((0, 0))
                if failure == "resize":
                    raise RuntimeError("resize failed")
            return original_resize(image, *args, **kwargs)

        monkeypatch.setattr(ImageOps, "autocontrast", contrast)
        monkeypatch.setattr(Image.Image, "resize", resize)
        try:
            if failure:
                with pytest.raises(RuntimeError, match="failed"):
                    ocr.preprocess(source, True, True)
            else:
                result, scale = ocr.preprocess(source, True, True)
                with result:
                    assert result.size == (100, 60) and scale == 2
            with pytest.raises(ValueError, match="closed"):
                base.getpixel((0, 0))
            if failure != "contrast":
                with pytest.raises(ValueError, match="closed"):
                    contrast_copy.getpixel((0, 0))
            assert source.getpixel((0, 0)) == (255, 255, 255)
        finally:
            base.close()
            contrast_copy.close()
