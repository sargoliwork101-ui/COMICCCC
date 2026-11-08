from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from comic_studio.ocr import (
    ENGINE_INFO, EasyEngine, OcrError, OcrLine, RapidEngine, TesseractEngine,
    _bubble_preprocess_regions, _extra_preprocess_image, _lines_from_rapid, _lines_from_tesseract, install_packages, recognize_image,
)


def test_modern_and_legacy_rapid_results():
    modern = SimpleNamespace(
        boxes=np.array([[[1, 2], [20, 2], [20, 12], [1, 12]]]),
        txts=["hello"], scores=np.array([0.91]),
    )
    lines = _lines_from_rapid(modern)
    assert lines[0].text == "hello"
    assert lines[0].box == [1.0, 2.0, 20.0, 12.0]
    legacy = [([[0, 0], [10, 0], [10, 5], [0, 5]], "legacy", 0.8)]
    assert _lines_from_rapid(legacy)[0].confidence == 0.8


class FakeEngine:
    def recognize(self, image: Image.Image, language: str):
        # Each slice returns a line at its local origin; the adapter must restore page coordinates.
        return [OcrLine("line", 0.95, [[4, 100], [80, 100], [80, 120], [4, 120]])]


def test_slicing_restores_coordinates_and_filters_confidence():
    image = Image.new("RGB", (200, 6100), "white")
    blocks = recognize_image(FakeEngine(), image, "eng", contrast=False, precise=False, min_confidence=0.5)
    assert len(blocks) == 3
    assert blocks[0]["y0"] == 100
    assert blocks[1]["y0"] >= 3000
    assert blocks[2]["y0"] >= 6000
    assert blocks[0]["text"] == "line"
    assert not recognize_image(FakeEngine(), image, "eng", contrast=False, precise=False, min_confidence=0.99)


def test_precise_geometry_is_scaled_back():
    image = Image.new("RGB", (100, 100), "white")
    blocks = recognize_image(FakeEngine(), image, "eng", contrast=False, precise=True)
    assert blocks[0]["x0"] == pytest.approx(2)
    assert blocks[0]["y0"] == pytest.approx(50)
    assert blocks[0]["x1"] == pytest.approx(40)


def test_v5_does_not_download_during_normal_ocr(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = RapidEngine("rapidocr-v5", "v5")
    monkeypatch.setattr(RapidEngine, "runtime_installed", property(lambda self: True))
    with pytest.raises(Exception, match="explicit model download"):
        engine._get("eng")


def test_v6_missing_model_does_not_download_during_normal_ocr(tmp_path, monkeypatch):
    engine = RapidEngine("rapidocr-v6", "v6")
    monkeypatch.setattr(RapidEngine, "runtime_installed", property(lambda self: True))
    monkeypatch.setattr(engine, "_v6_model_dir", lambda: tmp_path)
    with pytest.raises(Exception, match="explicit model download"):
        engine._get("eng")


def test_explicit_runtime_install_uses_the_app_python(monkeypatch):
    calls = []
    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, "", "")
    monkeypatch.setattr(subprocess, "run", fake_run)
    install_packages(["easyocr>=1.7,<2"])
    assert calls[0][0][:4] == [sys.executable, "-m", "pip", "install"]
    assert calls[0][0][-1] == "easyocr>=1.7,<2"
    assert calls[0][1]["check"] is False


def test_runtime_installations_do_not_overlap(monkeypatch):
    active = 0
    maximum = 0
    counter_lock = threading.Lock()
    def fake_run(command, **kwargs):
        nonlocal active, maximum
        with counter_lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.03)
        with counter_lock:
            active -= 1
        return subprocess.CompletedProcess(command, 0, "", "")
    monkeypatch.setattr(subprocess, "run", fake_run)
    workers = [threading.Thread(target=install_packages, args=(["example-package"],)) for _ in range(2)]
    for worker in workers: worker.start()
    for worker in workers: worker.join()
    assert maximum == 1


def test_install_lock_error_explains_recovery(monkeypatch):
    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, "", "[WinError 32] The process cannot access the file because it is being used by another process")
    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(OcrError, match="one installation only"):
        install_packages(["torch>=2.2,<3"])


def test_install_permission_error_points_to_admin_launcher(monkeypatch):
    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, "", "[WinError 5] Access is denied")
    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(OcrError, match="start_windows_admin.bat"):
        install_packages(["torch>=2.2,<3"])


def test_easyocr_runtime_is_installed_on_explicit_preparation(monkeypatch):
    engine = EasyEngine()
    checks = iter([False, True])
    installed = []
    monkeypatch.setattr(EasyEngine, "runtime_installed", property(lambda self: next(checks)))
    monkeypatch.setattr("comic_studio.ocr.install_packages", lambda packages: installed.extend(packages))
    engine._ensure_runtime()
    assert installed == ["easyocr>=1.7,<2", "torch>=2.2,<3"]


def test_v5_preparation_downloads_only_the_requested_language(monkeypatch):
    engine = RapidEngine("rapidocr-v5", "v5")
    seen = []
    monkeypatch.setattr(engine, "_ensure_runtime", lambda: None)
    monkeypatch.setattr(engine, "_get", lambda language, allow_download: seen.append((language, allow_download)) or object())
    monkeypatch.setattr(engine, "_warm", lambda received: seen.append("warmed"))
    engine.download("kor")
    assert seen == [("kor", True), "warmed"]


def test_v5_download_errors_are_visible_as_ocr_errors(monkeypatch):
    engine = RapidEngine("rapidocr-v5", "v5")
    monkeypatch.setattr(engine, "_ensure_runtime", lambda: None)
    monkeypatch.setattr(engine, "_get", lambda language, allow_download: (_ for _ in ()).throw(RuntimeError("model host blocked")))
    with pytest.raises(OcrError, match="Model download failed"):
        engine.download("eng")


def test_easyocr_preparation_uses_selected_language_and_marks_it_ready(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = EasyEngine()
    seen = []
    monkeypatch.setattr(engine, "_ensure_runtime", lambda: seen.append("runtime"))
    monkeypatch.setattr(engine, "_reader", lambda language, download: seen.append((language, download)))
    engine.download("kor")
    assert seen == ["runtime", ("kor", True)]
    assert (tmp_path / "models" / "easyocr" / ".ready-kor").is_file()


def test_v5_ready_languages_are_checked_per_language(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = RapidEngine("rapidocr-v5", "v5")
    monkeypatch.setattr(RapidEngine, "runtime_installed", property(lambda self: True))
    root = tmp_path / "models" / "rapidocr"
    root.mkdir(parents=True)
    for name in engine._expected_models("eng"):
        (root / name).touch()
    assert engine.ready_languages == ["eng"]


@pytest.mark.real_ocr
@pytest.mark.skipif(os.environ.get("COMIC_STUDIO_REAL_OCR") != "1", reason="set COMIC_STUDIO_REAL_OCR=1 to run the local model smoke test")
@pytest.mark.skipif(not importlib.util.find_spec("rapidocr"), reason="optional RapidOCR extra is not installed")
def test_real_pp_ocr_v6_smoke():
    # This test is opt-in because it loads a real ONNX model and must never download implicitly.
    from PIL import ImageDraw, ImageFont
    image = Image.new("RGB", (900, 360), "white")
    draw = ImageDraw.Draw(image)
    draw.text((45, 65), "HELLO COMIC", fill="black", font=ImageFont.load_default(size=52))
    draw.text((45, 190), "TEST 123", fill="black", font=ImageFont.load_default(size=52))
    engine = RapidEngine("rapidocr-v6", "v6")
    if not engine.model_ready:
        pytest.skip("PP-OCRv6 model files are not locally available")
    blocks = recognize_image(engine, image, "eng", contrast=False, precise=False, min_confidence=0.1)
    text = " ".join(block["text"] for block in blocks)
    assert "HELLO" in text
    assert "TEST" in text
    assert all(block["x1"] > block["x0"] for block in blocks)


def test_tesseract_tsv_words_become_positioned_lines():
    payload = "level\tpage_num\tblock_num\tpar_num\tline_num\tleft\ttop\twidth\theight\tconf\ttext\n" \
        "5\t1\t1\t1\t1\t4\t5\t20\t10\t90\tHello\n" \
        "5\t1\t1\t1\t1\t26\t5\t20\t10\t80\tworld\n"
    lines = _lines_from_tesseract(payload)
    assert len(lines) == 1
    assert lines[0].text == "Hello world"
    assert lines[0].box == [4.0, 5.0, 46.0, 15.0]
    assert lines[0].confidence == pytest.approx(0.85)


def test_tesseract_bubble_uses_psm6_without_changing_normal_psm(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/usr/bin/tesseract")
    monkeypatch.setattr(TesseractEngine, "ready_languages", property(lambda self: ["eng"]))
    commands = []
    def fake_run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "level\tpage_num\tblock_num\tpar_num\tline_num\tleft\ttop\twidth\theight\tconf\ttext\n", "")
    monkeypatch.setattr(subprocess, "run", fake_run)
    engine = TesseractEngine()
    image = Image.new("RGB", (40, 20), "white")
    engine.recognize(image, "eng")
    engine.recognize_bubble(image, "eng")
    assert commands[0][commands[0].index("--psm") + 1] == "11"
    assert commands[1][commands[1].index("--psm") + 1] == "6"


def test_tesseract_normal_ocr_never_downloads_a_missing_language(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = TesseractEngine()
    engine._system_languages = set()
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/usr/bin/tesseract")
    with pytest.raises(OcrError, match="explicit model download"):
        engine.recognize(Image.new("RGB", (40, 20)), "eng")


def test_tesseract_explicit_download_uses_selected_language(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = TesseractEngine()
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/usr/bin/tesseract")
    seen = []
    class Response:
        def __init__(self): self.stream = __import__("io").BytesIO(b"x" * 2000)
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, size=-1): return self.stream.read(size)
    def fake_urlopen(request, timeout):
        seen.append((request.full_url, timeout))
        return Response()
    monkeypatch.setattr("comic_studio.ocr.urllib.request.urlopen", fake_urlopen)
    engine.download("kor")
    assert seen[0][0].endswith("/kor.traineddata")
    assert (tmp_path / "models" / "tesseract" / "kor.traineddata").stat().st_size == 2000


def test_requested_model_catalog_enables_auto_download_for_all_models():
    expected = {"paddleocr-vl-1-6", "mineru-2-5-pro", "glm-ocr", "deepseek-ocr-2", "got-ocr-2", "dots-ocr", "olmocr", "hunyuan-ocr", "surya"}
    assert expected <= set(ENGINE_INFO)
    assert all(ENGINE_INFO[engine_id]["selectable"] is True for engine_id in ENGINE_INFO)
    assert all(ENGINE_INFO[engine_id]["action"] == "download" for engine_id in ENGINE_INFO)
    assert all(ENGINE_INFO[engine_id]["isolated"] is True for engine_id in expected)
    assert all(ENGINE_INFO[engine_id]["repository"].startswith("https://github.com/") for engine_id in expected)
    assert ENGINE_INFO["tesseract"]["selectable"] is True


def test_bright_fallback_preprocess_has_requested_geometry_and_polarity():
    image = Image.new("RGB", (8, 6), (20, 20, 20))
    for x in range(2, 6):
        for y in range(2, 4):
            image.putpixel((x, y), (255, 255, 255))
    processed = _extra_preprocess_image(image)
    assert processed.size == (24, 18)
    assert processed.mode == "RGB"
    pixels = np.asarray(processed)
    assert pixels.min() == 0
    assert pixels.max() == 255
    assert int((pixels[..., 0] == 0).sum()) > 0


def test_bubble_preprocess_builds_scaled_binary_crop():
    pixels = np.full((160, 220), 230, dtype=np.uint8)
    pixels[20:140, 20:200] = 80
    pixels[55:95, 65:105] = 240  # white outline around the dark letter body
    pixels[60:90, 70:100] = 0
    regions = _bubble_preprocess_regions(Image.fromarray(pixels).convert("RGB"))
    assert len(regions) == 1
    processed, x, y = regions[0]
    assert (x, y) == (20, 20)
    assert processed.size == (600, 420)  # 180x120 crop, 3x scale, 30px padding
    assert processed.mode == "RGB"
    values = np.asarray(processed)
    assert np.all(values[:30] == 255)
    assert np.any(values == 0)


def test_bubble_preprocess_rejects_small_and_nonuniform_regions():
    small = np.full((80, 80), 230, dtype=np.uint8)
    small[10:50, 10:50] = 0
    assert _bubble_preprocess_regions(Image.fromarray(small).convert("RGB")) == []
    pixels = np.full((160, 220), 230, dtype=np.uint8)
    pixels[20:140, 20:200] = 80
    for y in range(30, 130, 10):
        for x in range(30, 190, 10):
            pixels[y:y + 10, x:x + 10] = 0 if ((x + y) // 10) % 2 else 230
    assert _bubble_preprocess_regions(Image.fromarray(pixels).convert("RGB")) == []


class ConditionalFallbackEngine:
    def __init__(self, primary, fallback):
        self.primary = primary
        self.fallback = fallback
        self.sizes = []

    def recognize(self, image: Image.Image, language: str):
        self.sizes.append(image.size)
        lines = self.primary if image.size == (40, 20) else self.fallback
        return [OcrLine(text, confidence, polygon) for text, confidence, polygon in lines]


def line(text, confidence, polygon=None):
    return text, confidence, polygon or [[2, 2], [20, 2], [20, 12], [2, 12]]


def test_bubble_fallback_orders_regions_and_restores_public_blocks(monkeypatch):
    class Engine:
        def __init__(self): self.sizes = []
        def recognize(self, image, language):
            self.sizes.append(image.size)
            if image.size == (40, 20):
                return []
            text = "TOP" if image.size == (90, 60) else "BOTTOM"
            return [OcrLine(text, 0.91, [[30, 30], [60, 30], [60, 45], [30, 45]])]
    engine = Engine()
    top = Image.new("RGB", (90, 60), "white")
    bottom = Image.new("RGB", (120, 60), "white")
    monkeypatch.setattr("comic_studio.ocr.EXTRA_PREPROCESS_ENABLED", False)
    monkeypatch.setattr("comic_studio.ocr._bubble_preprocess_regions", lambda image: [(bottom, 10, 100), (top, 10, 20)])
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert engine.sizes == [(40, 20), (90, 60), (120, 60)]
    assert [block["text"] for block in blocks] == ["TOP", "BOTTOM"]
    assert [block["id"] for block in blocks] == [1, 2]
    assert blocks[0]["x0"] == pytest.approx(10)
    assert blocks[0]["x1"] == pytest.approx(20)
    assert blocks[0]["y0"] == pytest.approx(20)
    assert blocks[1]["y0"] == pytest.approx(100)
    assert {"tr", "richHtml", "polygon", "lineH", "enabled", "bg", "dir", "align"} <= set(blocks[0])


def test_bubble_region_confidence_is_word_weighted(monkeypatch):
    class Engine:
        def recognize(self, image, language):
            if image.size == (40, 20):
                return []
            return [
                OcrLine("one two three", 0.40, [[30, 30], [90, 30], [90, 45], [30, 45]]),
                OcrLine("good", 0.90, [[30, 50], [90, 50], [90, 65], [30, 65]]),
            ]
    prepared = Image.new("RGB", (150, 100), "white")
    monkeypatch.setattr("comic_studio.ocr.EXTRA_PREPROCESS_ENABLED", False)
    monkeypatch.setattr("comic_studio.ocr._bubble_preprocess_regions", lambda image: [(prepared, 0, 0)])
    blocks = recognize_image(Engine(), Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert blocks == []  # (3*40 + 1*90) / 4 = 52.5, so the whole region is rejected


def test_empty_primary_uses_bright_fallback_and_restores_coordinates():
    engine = ConditionalFallbackEngine([], [line("BRIGHT", 0.94, [[6, 6], [60, 6], [60, 36], [6, 36]])])
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert engine.sizes == [(40, 20), (120, 60)]
    assert [block["text"] for block in blocks] == ["BRIGHT"]
    assert blocks[0]["x0"] == pytest.approx(2)
    assert blocks[0]["y0"] == pytest.approx(2)
    assert blocks[0]["x1"] == pytest.approx(20)
    assert blocks[0]["y1"] == pytest.approx(12)


def test_short_high_confidence_primary_still_gets_one_fallback_attempt():
    engine = ConditionalFallbackEngine(
        [line("I", 0.99)], [line("HI", 0.98, [[6, 6], [60, 6], [60, 36], [6, 36]])],
    )
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert engine.sizes == [(40, 20), (120, 60)]
    assert blocks[0]["text"] == "HI"


def test_worse_fallback_never_replaces_low_confidence_primary():
    engine = ConditionalFallbackEngine([line("abc", 0.54)], [line("x", 0.99)])
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert len(engine.sizes) == 2
    assert [block["text"] for block in blocks] == ["abc"]
    assert blocks[0]["conf"] == pytest.approx(54)


def test_better_confidence_can_replace_a_weak_primary_with_same_length():
    engine = ConditionalFallbackEngine([line("abc", 0.54)], [line("xyz", 0.91)])
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert len(engine.sizes) == 2
    assert [block["text"] for block in blocks] == ["xyz"]


def test_strong_primary_does_not_run_fallback(monkeypatch):
    engine = ConditionalFallbackEngine([line("GOOD TEXT", 0.96)], [])
    monkeypatch.setattr("comic_studio.ocr._extra_preprocess_image", lambda image: pytest.fail("fallback ran"))
    monkeypatch.setattr("comic_studio.ocr._bubble_preprocess_regions", lambda image: pytest.fail("bubble fallback ran"))
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert engine.sizes == [(40, 20)]
    assert blocks[0]["text"] == "GOOD TEXT"


def test_bubble_failure_preserves_existing_bright_fallback(monkeypatch):
    engine = ConditionalFallbackEngine([], [line("BRIGHT", 0.94, [[6, 6], [60, 6], [60, 36], [6, 36]])])
    monkeypatch.setattr("comic_studio.ocr._bubble_preprocess_regions", lambda image: (_ for _ in ()).throw(RuntimeError("no cv2")))
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert [block["text"] for block in blocks] == ["BRIGHT"]


def test_fallback_preprocess_failure_returns_primary(monkeypatch):
    engine = ConditionalFallbackEngine([line("abc", 0.54)], [])
    monkeypatch.setattr("comic_studio.ocr._extra_preprocess_image", lambda image: (_ for _ in ()).throw(RuntimeError("no cv2")))
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert blocks[0]["text"] == "abc"


def test_hardware_evaluation_and_version_comparison(monkeypatch):
    from comic_studio.ocr_managed import evaluate_engine_hardware, is_newer_version

    assert is_newer_version("3.9.0", "3.10.0") is True
    assert is_newer_version("3.10.0", "3.10.0") is False
    assert is_newer_version("0.23.0", "0.22.9") is False
    assert is_newer_version("5.4.0.20240605", "v5.4.0.20240606") is True

    cpu_hw = {"hasNvidiaGpu": False, "gpuNames": [], "vramGb": 0.0, "diskFreeGb": 50.0, "os": "nt", "arch": "amd64"}
    assert evaluate_engine_hardware("rapidocr-v6", cpu_hw)["compatible"] is True
    assert evaluate_engine_hardware("surya", cpu_hw)["compatible"] is True
    heavy_eval = evaluate_engine_hardware("olmocr", cpu_hw)
    assert heavy_eval["compatible"] is False
    assert any("NVIDIA" in warning for warning in heavy_eval["warnings"])

    low_vram_hw = {"hasNvidiaGpu": True, "gpuNames": ["RTX 3060"], "vramGb": 8.0, "diskFreeGb": 50.0, "os": "nt", "arch": "amd64"}
    assert evaluate_engine_hardware("dots-ocr", low_vram_hw)["compatible"] is True
    assert evaluate_engine_hardware("hunyuan-ocr", low_vram_hw)["compatible"] is False

    low_disk_hw = {"hasNvidiaGpu": True, "gpuNames": ["RTX 4090"], "vramGb": 24.0, "diskFreeGb": 2.0, "os": "nt", "arch": "amd64"}
    disk_eval = evaluate_engine_hardware("paddleocr-vl-1-6", low_disk_hw)
    assert disk_eval["compatible"] is False
    assert any("دیسک" in warning for warning in disk_eval["warnings"])


def test_tesseract_download_auto_installs_missing_binary(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = TesseractEngine()
    portable_bin = tmp_path / "models" / "tesseract-bin" / "tesseract"

    def fake_install_tesseract(error_cls):
        portable_bin.parent.mkdir(parents=True, exist_ok=True)
        portable_bin.write_text("#!/bin/sh\necho 'tesseract 5.4.0'\n", encoding="utf-8")
        portable_bin.chmod(0o755)
        return str(portable_bin)

    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: str(portable_bin) if portable_bin.is_file() else None)
    monkeypatch.setattr("comic_studio.ocr.install_tesseract_runtime", fake_install_tesseract)

    class Response:
        def __init__(self): self.stream = __import__("io").BytesIO(b"t" * 2048)
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, size=-1): return self.stream.read(size)

    monkeypatch.setattr("comic_studio.ocr.urllib.request.urlopen", lambda req, timeout: Response())
    assert engine.runtime_installed is False
    engine.download("eng")
    assert engine.runtime_installed is True
    assert "eng" in engine.ready_languages


def test_isolated_engine_prepare_serve_and_update_lifecycle(tmp_path, monkeypatch):
    import sys as _sys
    from comic_studio.ocr import EngineRegistry

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    registry = EngineRegistry()
    engine = registry.get("glm-ocr")
    assert engine.runtime_installed is False
    assert engine.model_ready is False

    # Fake _ensure_isolated_venv to symlink current python into isolated env and write a tiny mock worker
    def fake_ensure_venv(upgrade=False):
        env_dir = engine._env_dir()
        py = engine._env_python()
        py.parent.mkdir(parents=True, exist_ok=True)
        if not py.exists():
            py.symlink_to(_sys.executable)
        sp = env_dir / ("Lib/site-packages" if __import__("os").name == "nt" else "lib/python3.11/site-packages")
        for old in sp.glob("glmocr-*.dist-info"):
            __import__("shutil").rmtree(old)
        ver = "0.2.0" if upgrade else "0.1.5"
        dist_info = sp / f"glmocr-{ver}.dist-info"
        dist_info.mkdir(parents=True, exist_ok=True)
        (dist_info / "METADATA").write_text(f"Name: glmocr\nVersion: {ver}\n", encoding="utf-8")
        (env_dir / ".runtime-ready").write_text("ok", encoding="utf-8")

    fake_worker = tmp_path / "fake_ocr_worker.py"
    fake_worker.write_text(
        "import argparse, json, sys\n"
        "p = argparse.ArgumentParser()\n"
        "p.add_argument('--engine'); p.add_argument('--models-root'); p.add_argument('--language', default='eng')\n"
        "p.add_argument('--prepare', action='store_true'); p.add_argument('--serve', action='store_true')\n"
        "args = p.parse_args()\n"
        "if args.prepare:\n"
        "    print(json.dumps({'ok': True, 'modelRevision': 'rev-1'}), flush=True)\n"
        "    raise SystemExit(0)\n"
        "if args.serve:\n"
        "    print(json.dumps({'ok': True, 'status': 'serving', 'engine': args.engine}), flush=True)\n"
        "    for raw in sys.stdin:\n"
        "        req = json.loads(raw)\n"
        "        if req.get('cmd') == 'quit':\n"
        "            break\n"
        "        print(json.dumps({'ok': True, 'lines': [{'text': 'ISOLATED HELLO', 'confidence': 0.93, 'polygon': [[10, 12], [110, 12], [110, 42], [10, 42]]}]}), flush=True)\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(engine, "_ensure_isolated_venv", fake_ensure_venv)
    monkeypatch.setattr("comic_studio.ocr_managed._worker_script_path", lambda: fake_worker)

    try:
        registry.download("glm-ocr", "eng")
        assert engine.runtime_installed is True
        assert engine.model_ready is True
        assert engine.installed_version == "0.1.5"

        sample = Image.new("RGB", (160, 80), "white")
        blocks = recognize_image(engine, sample, "eng", contrast=False, precise=False)
        assert len(blocks) == 1
        assert blocks[0]["text"] == "ISOLATED HELLO"

        # Simulate upstream PyPI having 0.2.0
        monkeypatch.setattr("comic_studio.ocr_managed.fetch_pypi_latest_version", lambda pkg: "0.2.0" if pkg == "glmocr" else None)
        monkeypatch.setattr("comic_studio.ocr_managed.fetch_remote_repo_revision", lambda repo: "rev-1")
        report = registry.check_updates(force=True)
        assert report["updatesCount"] >= 1
        glm_status = next(item for item in report["engines"] if item["id"] == "glm-ocr")
        assert glm_status["updateAvailable"] is True
        assert glm_status["latestVersion"] == "0.2.0"
        assert "GLM-OCR" in glm_status["updateSummary"]

        # Perform 1-click update and verify updateAvailable clears immediately
        registry.update("glm-ocr", "eng")
        after_status = next(item for item in registry.status() if item["id"] == "glm-ocr")
        assert after_status["installedVersion"] == "0.2.0"
        assert after_status["updateAvailable"] is False
    finally:
        engine.close()


def test_detect_comic_text_regions_supports_dense_book_pages_and_over_36_regions():
    from PIL import ImageDraw
    from comic_studio.ocr_managed import detect_comic_text_regions

    # 1. Narrow-margin dense book page (>80% page coverage) must NOT be dropped and splits into paragraph chunks:
    book_img = Image.new("RGB", (600, 900), "white")
    draw = ImageDraw.Draw(book_img)
    for para_idx, base_y in enumerate((30, 320, 610)):
        for ln in range(7):
            y = base_y + ln * 24
            draw.rectangle([20, y, 580, y + 10], fill="black")
    regions = detect_comic_text_regions(book_img, page_mode="document")
    assert len(regions) >= 2
    assert min(r[1] for r in regions) <= 40
    assert max(r[3] for r in regions) >= 740

    # 2. Dense glossary/table page with >36 separate cells preserves >36 regions:
    grid_img = Image.new("RGB", (1000, 1400), "white")
    gdraw = ImageDraw.Draw(grid_img)
    for row in range(12):
        for col in range(4):
            x0 = 40 + col * 230
            y0 = 40 + row * 105
            gdraw.rectangle([x0, y0, x0 + 130, y0 + 22], fill="black")
    grid_regions = detect_comic_text_regions(grid_img, page_mode="document")
    assert len(grid_regions) == 48


def test_tesseract_document_mode_uses_psm_3_and_skips_bubble_fallback(monkeypatch):
    from comic_studio.ocr import OcrLine, TesseractEngine

    engine = TesseractEngine()
    calls: list[str] = []

    def fake_psm(image, language, psm):
        calls.append(psm)
        return [OcrLine("Book chapter line", 0.92, [[20, 20], [320, 20], [320, 44], [20, 44]])]

    monkeypatch.setattr(engine, "_recognize_with_psm", fake_psm)
    sample = Image.new("RGB", (400, 200), "white")
    doc_blocks = recognize_image(engine, sample, "eng", contrast=False, precise=False, page_mode="document")
    assert calls == ["3"]
    assert doc_blocks[0]["text"] == "Book chapter line"

    calls.clear()
    comic_blocks = recognize_image(engine, sample, "eng", contrast=False, precise=False, page_mode="comic")
    assert calls == ["11"]
    assert comic_blocks[0]["text"] == "Book chapter line"


def test_engine_suitability_matrix_covers_all_13_engines_and_page_modes():
    from comic_studio.ocr import ENGINE_INFO, ENGINE_SUITABILITY

    assert set(ENGINE_SUITABILITY.keys()) == set(ENGINE_INFO.keys())
    assert len(ENGINE_INFO) == 14
    for engine_id, meta in ENGINE_INFO.items():
        suit = meta["suitability"]
        for mode in ("comic", "document", "auto"):
            assert suit[mode]["tier"] in {"best", "medium", "weak"}, f"{engine_id}:{mode}"
            assert isinstance(suit[mode]["reason"], str) and len(suit[mode]["reason"]) > 15

    # Comic mode tiers: comic engines green, doc-layout engines amber/red
    assert ENGINE_INFO["rapidocr-v6"]["suitability"]["comic"]["tier"] == "best"
    assert ENGINE_INFO["easyocr"]["suitability"]["comic"]["tier"] == "best"
    assert ENGINE_INFO["glm-ocr"]["suitability"]["comic"]["tier"] == "best"
    assert ENGINE_INFO["surya"]["suitability"]["comic"]["tier"] == "medium"
    assert ENGINE_INFO["paddleocr-vl-1-6"]["suitability"]["comic"]["tier"] == "medium"
    assert ENGINE_INFO["tesseract"]["suitability"]["comic"]["tier"] == "weak"
    assert ENGINE_INFO["mineru-2-5-pro"]["suitability"]["comic"]["tier"] == "weak"
    assert ENGINE_INFO["olmocr"]["suitability"]["comic"]["tier"] == "weak"

    # Document (book/article) mode tiers: document/layout engines green, comic-only red
    assert ENGINE_INFO["tesseract"]["suitability"]["document"]["tier"] == "best"
    assert ENGINE_INFO["surya"]["suitability"]["document"]["tier"] == "best"
    assert ENGINE_INFO["paddleocr-vl-1-6"]["suitability"]["document"]["tier"] == "best"
    assert ENGINE_INFO["mineru-2-5-pro"]["suitability"]["document"]["tier"] == "best"
    assert ENGINE_INFO["olmocr"]["suitability"]["document"]["tier"] == "best"
    assert ENGINE_INFO["rapidocr-v6"]["suitability"]["document"]["tier"] == "medium"
    assert ENGINE_INFO["easyocr"]["suitability"]["document"]["tier"] == "weak"


def test_update_loop_prevention_across_tesseract_hf_and_shared_packages(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from comic_studio.ocr_managed import (
        acknowledge_engine_update,
        compute_engine_update_fields,
        read_manifest,
        read_update_cache,
        update_manifest_entry,
        write_update_cache,
    )

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))

    ready_eng = SimpleNamespace(runtime_installed=True, model_ready=True, ready_languages=["eng"])
    unprepared_eng = SimpleNamespace(runtime_installed=True, model_ready=False, ready_languages=[])

    update_manifest_entry(
        "tesseract",
        installedVersion="5.4.0.20240606",
        installedTag="5.4.0.20240606",
        modelRevision="sha256:abcdef123456",
    )
    update_manifest_entry(
        "glm-ocr",
        installedVersion="0.1.5",
        modelRevision="zai-org__GLM-OCR",
    )
    update_manifest_entry("rapidocr-v6", installedVersion="3.8.0")
    write_update_cache(
        {
            "checkedAt": 9999999999,
            "engines": {
                "tesseract": {
                    "latestVersion": "5.4.0.20240606",
                    "latestRevision": "deadbeef1234",
                },
                "glm-ocr": {
                    "latestVersion": "0.1.5",
                    "latestRevision": "cafebabe9876",
                },
                "rapidocr-v6": {
                    "latestVersion": "3.10.0",
                },
                "rapidocr-v5": {
                    "latestVersion": "3.10.0",
                },
            },
        }
    )

    manifest = read_manifest()
    cache_engines = read_update_cache()["engines"]

    # 1. Tesseract: 3-part `tesseract --version` ('5.4.0') vs 4-part UB-Mannheim tag ('5.4.0.20240606') + sha256 fallback
    tess_fields = compute_engine_update_fields(
        "tesseract", "Tesseract 5 LSTM", ready_eng, "5.4.0", manifest["tesseract"], cache_engines["tesseract"]
    )
    assert tess_fields["updateAvailable"] is False

    # 2. Isolated HF engine with folder-style modelRevision ("zai-org__GLM-OCR") does not false-trigger git SHA mismatch
    glm_fields = compute_engine_update_fields(
        "glm-ocr", "GLM-OCR", ready_eng, "0.1.5", manifest["glm-ocr"], cache_engines["glm-ocr"]
    )
    assert glm_fields["updateAvailable"] is False

    # 3. Un-downloaded rapidocr-v5 does not raise false update alert merely because rapidocr package is present
    v5_unprepared = compute_engine_update_fields(
        "rapidocr-v5", "PP-OCRv5 Mobile", unprepared_eng, "3.8.0", manifest.get("rapidocr-v5"), cache_engines["rapidocr-v5"]
    )
    assert v5_unprepared["updateAvailable"] is False
    v6_prepared = compute_engine_update_fields(
        "rapidocr-v6", "PP-OCRv6 Small", ready_eng, "3.8.0", manifest["rapidocr-v6"], cache_engines["rapidocr-v6"]
    )
    assert v6_prepared["updateAvailable"] is True

    # 4. Acknowledging update clears sibling cache AND suppresses repeated prompt even if PyPI ceiling > compatible wheel
    acknowledge_engine_update("rapidocr-v6", installed_version="3.8.0")
    write_update_cache(
        {
            "checkedAt": 9999999999,
            "engines": {
                "rapidocr-v6": {"latestVersion": "3.10.0"},
                "rapidocr-v5": {"latestVersion": "3.10.0"},
            },
        }
    )
    updated_manifest = read_manifest()
    rechecked_cache = read_update_cache()["engines"]
    assert compute_engine_update_fields(
        "rapidocr-v6", "PP-OCRv6 Small", ready_eng, "3.8.0", updated_manifest["rapidocr-v6"], rechecked_cache["rapidocr-v6"]
    )["updateAvailable"] is False
    assert compute_engine_update_fields(
        "rapidocr-v5", "PP-OCRv5 Mobile", ready_eng, "3.8.0", updated_manifest.get("rapidocr-v5"), rechecked_cache["rapidocr-v5"]
    )["updateAvailable"] is False


def test_rapid_update_skips_locked_onnxruntime_and_emits_numeric_progress(tmp_path, monkeypatch):
    import importlib.util
    from comic_studio import ocr as ocr_mod

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    upgraded_calls: list[tuple[list[str], bool]] = []
    progress_events: list[tuple[str, float | None]] = []

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object() if name in {"rapidocr", "onnxruntime"} else None)
    monkeypatch.setattr(
        ocr_mod,
        "install_packages",
        lambda pkgs, upgrade=False: upgraded_calls.append((list(pkgs), upgrade)),
    )
    monkeypatch.setattr(ocr_mod, "detect_builtin_installed_version", lambda eid, eng=None: "3.10.0")
    monkeypatch.setattr(ocr_mod, "emit", lambda msg, kind="info", progress=None: progress_events.append((msg, progress)))

    engine = ocr_mod.RapidEngine("rapidocr-v6", "v6")
    monkeypatch.setattr(engine, "_get", lambda lang, allow_download=False: "dummy")
    monkeypatch.setattr(engine, "_warm", lambda inst: None)
    engine.update("eng")

    # Must upgrade only ['rapidocr>=3.10'] (not onnxruntime, preventing Windows .pyd/.dll file lock failures)
    assert upgraded_calls == [(["rapidocr>=3.10"], True)]
    numeric = [p for _, p in progress_events if isinstance(p, (int, float))]
    assert len(numeric) >= 3
    assert numeric[0] > 0.0
    assert numeric[-1] == 1.0


def test_paddleocr_vl_adapter_falls_back_cleanly_when_v1_6_not_supported(tmp_path, monkeypatch):
    import types
    from comic_studio import ocr_worker

    init_calls: list[dict[str, object]] = []

    class FakePaddleOCRVL:
        def __init__(self, pipeline_version="v1.5", **kwargs):
            init_calls.append({"pipeline_version": pipeline_version, **kwargs})
            if pipeline_version not in ["v1", "v1.5"]:
                raise ValueError(
                    f"Invalid pipeline version: {pipeline_version}. Supported versions are ['v1', 'v1.5']."
                )

        def predict(self, image_path):
            return [
                {
                    "res": {
                        "parsing_res_list": [
                            {"block_label": "text", "block_content": "Hello PaddleVL", "block_bbox": [12, 18, 180, 56]}
                        ]
                    }
                }
            ]

    fake_pkg = types.ModuleType("paddleocr")
    fake_pkg.__version__ = "3.6.0"
    fake_pkg.PaddleOCRVL = FakePaddleOCRVL
    fake_pipelines = types.ModuleType("paddleocr._pipelines")
    fake_pvl = types.ModuleType("paddleocr._pipelines.paddleocr_vl")
    fake_pvl._AVAILABLE_PIPELINE_VERSIONS = ["v1", "v1.5"]
    fake_pvl._DEFAULT_PIPELINE_VERSION = "v1.5"

    monkeypatch.setitem(sys.modules, "paddleocr", fake_pkg)
    monkeypatch.setitem(sys.modules, "paddleocr._pipelines", fake_pipelines)
    monkeypatch.setitem(sys.modules, "paddleocr._pipelines.paddleocr_vl", fake_pvl)

    img_path = tmp_path / "sample.png"
    Image.new("RGB", (240, 100), "white").save(img_path)

    adapter = ocr_worker._PaddleOcrVlAdapter(tmp_path)
    rev = adapter.prepare("eng")
    assert rev
    assert init_calls[0]["pipeline_version"] == "v1.5"

    out = adapter.recognize(str(img_path), "eng", None)
    assert len(out) == 1
    assert out[0]["text"] == "Hello PaddleVL"

    # Also verify dot-free HF folder sanitization for dots.mocr and MinerU 4.x nested payload extraction
    dots_adapter = ocr_worker._DotsOcrAdapter(tmp_path)
    assert "." not in dots_adapter._safe_repo_folder_name()
    mineru_lines = ocr_worker._MinerUAdapter._extract_mineru_payload(
        {"pages": [{"blocks": [{"text": "Chapter 1", "bbox": [50, 40, 300, 90]}]}]},
        800,
        1200,
    )
    assert len(mineru_lines) == 1
    assert mineru_lines[0]["text"] == "Chapter 1"


def test_cleanup_superseded_versions_preserves_unused_installed_models(tmp_path, monkeypatch):
    from comic_studio import ocr_managed

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    models_root = tmp_path / "models"

    # 1. Unused installed model (e.g. surya) must NEVER be deleted when cleaning another or itself!
    unused_env = models_root / "envs" / "surya"
    unused_env.mkdir(parents=True)
    (unused_env / ".runtime-ready").write_text("ok", encoding="utf-8")
    unused_weights = models_root / "isolated" / "surya" / "weights.bin"
    unused_weights.parent.mkdir(parents=True)
    unused_weights.write_bytes(b"ACTIVE_UNUSED_MODEL_WEIGHTS")

    # 2. HuggingFace repo for dots-ocr: old snapshot + unreferenced blob + legacy dotted folder + .part file
    hub_dir = models_root / "hf" / "hub" / "models--rednote-hilab--dots.mocr"
    (hub_dir / "refs").mkdir(parents=True)
    (hub_dir / "refs" / "main").write_text("new_rev_222", encoding="utf-8")
    old_snap = hub_dir / "snapshots" / "old_rev_111"
    new_snap = hub_dir / "snapshots" / "new_rev_222"
    blobs_dir = hub_dir / "blobs"
    old_snap.mkdir(parents=True)
    new_snap.mkdir(parents=True)
    blobs_dir.mkdir(parents=True)
    active_blob = blobs_dir / "blob_active"
    orphan_blob = blobs_dir / "blob_old_superseded"
    active_blob.write_bytes(b"NEW_WEIGHTS" * 200)
    orphan_blob.write_bytes(b"OLD_SUPERSEDED_WEIGHTS" * 400)
    (old_snap / "model.safetensors").symlink_to(orphan_blob)
    (new_snap / "model.safetensors").symlink_to(active_blob)

    safe_hf_dir = models_root / "hf-repos" / "rednote-hilab__dots_mocr"
    legacy_hf_dir = models_root / "hf-repos" / "rednote-hilab__dots.mocr"
    safe_hf_dir.mkdir(parents=True)
    (safe_hf_dir / "config.json").write_text("{}", encoding="utf-8")
    legacy_hf_dir.mkdir(parents=True)
    (legacy_hf_dir / "old_config.json").write_text("{}", encoding="utf-8")
    part_file = models_root / "rapidocr" / "model.onnx.part"
    part_file.parent.mkdir(parents=True)
    part_file.write_bytes(b"partial")

    # 3. Broken pip ~temp directory & older duplicate .dist-info in isolated venv
    sp = models_root / "envs" / "dots-ocr" / "lib" / "python3.11" / "site-packages"
    (sp / "~ransformers").mkdir(parents=True)
    (sp / "~ransformers" / "old.so").write_bytes(b"1234")
    (sp / "transformers-4.48.0.dist-info").mkdir(parents=True)
    (sp / "transformers-5.12.1.dist-info").mkdir(parents=True)

    freed = ocr_managed.cleanup_superseded_engine_files("dots-ocr")
    assert freed > 0
    assert not old_snap.exists()
    assert new_snap.is_dir()
    assert active_blob.is_file()
    assert not orphan_blob.exists()
    assert safe_hf_dir.is_dir()
    assert not legacy_hf_dir.exists()
    assert not part_file.exists()
    assert not (sp / "~ransformers").exists()
    assert not (sp / "transformers-4.48.0.dist-info").exists()
    assert (sp / "transformers-5.12.1.dist-info").is_dir()

    # Verify unused installed model (surya) is 100% untouched!
    assert (unused_env / ".runtime-ready").is_file()
    assert unused_weights.is_file()

    # 4. PaddleX superseded v1 directory removed when v1.5/v1.6 is present
    official = models_root / "paddlex" / "official_models"
    (official / "PaddleOCR-VL-0.9B").mkdir(parents=True)
    (official / "PaddleOCR-VL-0.9B" / "old.pdiparams").write_bytes(b"OLD_VL")
    (official / "PaddleOCR-VL-1.5-0.9B").mkdir(parents=True)
    (official / "PaddleOCR-VL-1.5-0.9B" / "new.safetensors").write_bytes(b"NEW_VL")
    ocr_managed.cleanup_superseded_engine_files("paddleocr-vl-1-6")
    assert not (official / "PaddleOCR-VL-0.9B").exists()
    assert (official / "PaddleOCR-VL-1.5-0.9B" / "new.safetensors").is_file()


def test_immediate_ram_unload_and_preprocess_memory_cap(tmp_path, monkeypatch):
    from comic_studio import ocr as ocr_mod
    from comic_studio.ocr import EngineRegistry, OcrLine, preprocess, recognize_image

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))

    # 1. Normal comic image upscales 2x when precise=True, while >4MP high-res scan skips 2x RAM spike
    small = Image.new("RGB", (600, 800), "white")
    prep_small, scale_small = preprocess(small, contrast=False, precise=True)
    assert scale_small == 2.0
    assert prep_small.size == (1200, 1600)
    prep_small.close()

    huge = Image.new("RGB", (2400, 2000), "white")  # 4.8 MP > 4.0 MP cap
    prep_huge, scale_huge = preprocess(huge, contrast=False, precise=True)
    assert scale_huge == 1.0
    assert prep_huge.size == (2400, 2000)
    prep_huge.close()

    # 2. IsolatedOcrEngine skips 2x Lanczos pre-upscaling even on small images
    registry = EngineRegistry()
    iso_engine = registry.get("surya")
    observed_sizes = []
    monkeypatch.setattr(
        iso_engine,
        "recognize",
        lambda crop, lang, page_mode="auto": (observed_sizes.append(crop.size) or [OcrLine("BOOK", 0.95, [[10, 10], [80, 10], [80, 30], [10, 30]])]),
    )
    blocks = recognize_image(iso_engine, Image.new("RGB", (500, 700), "white"), "eng", contrast=False, precise=True)
    assert observed_sizes == [(500, 700)]
    assert blocks[0]["text"] == "BOOK"

    # 3. RapidEngine download() & unload_all() leave 0 models resident in RAM
    rapid = registry.get("rapidocr-v6")
    monkeypatch.setattr(ocr_mod.RapidEngine, "runtime_installed", property(lambda self: True))
    monkeypatch.setattr(rapid, "_ensure_runtime", lambda: None)
    monkeypatch.setattr(rapid, "_create", lambda lang: lambda arr, **kw: None)
    rapid.download("eng")
    assert rapid.is_loaded_in_ram is False
    mem = registry.memory_status()
    assert mem["loadedCount"] == 0
    assert isinstance(mem["totalRamMb"], float)


def test_tesseract_custom_tessdata_passes_create_tsv_flag_and_writes_configs_tsv(tmp_path, monkeypatch):
    """Simulate real Tesseract CLI where --tessdata-dir lacks system configs/tsv unless we supply it."""
    from pathlib import Path
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/usr/bin/tesseract")
    tess_dir = tmp_path / "models" / "tesseract"
    tess_dir.mkdir(parents=True, exist_ok=True)
    (tess_dir / "eng.traineddata").write_bytes(b"traineddata" * 200)

    def strict_tesseract_cli(command, **kwargs):
        has_c_flag = False
        for idx, arg in enumerate(command[:-1]):
            if arg == "-c" and command[idx + 1] == "tessedit_create_tsv=1":
                has_c_flag = True
        has_dpi_300 = "--dpi" in command and command[command.index("--dpi") + 1] == "300"
        assert has_dpi_300, f"expected --dpi 300 in {command}"
        cfg_file_ok = True
        if "--tessdata-dir" in command:
            td = Path(command[command.index("--tessdata-dir") + 1])
            cfg_file_ok = (td / "configs" / "tsv").is_file()
        if has_c_flag and cfg_file_ok:
            tsv_out = (
                "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
                "5\t1\t1\t1\t1\t1\t30\t40\t120\t22\t94\tArticle\n"
                "5\t1\t1\t1\t1\t2\t160\t40\t180\t22\t91\tIntroduction\n"
            )
            return subprocess.CompletedProcess(command, 0, tsv_out.encode("utf-8"), b"")
        # Plain text fallback (what real Tesseract outputs when tessedit_create_tsv stays false!)
        return subprocess.CompletedProcess(command, 0, b"Article Introduction\n", b"read_params_file: Can't open tsv\n")

    monkeypatch.setattr(subprocess, "run", strict_tesseract_cli)
    engine = TesseractEngine()
    blocks = recognize_image(engine, Image.new("RGB", (600, 400), "white"), "eng", contrast=True, precise=False, page_mode="document")
    assert len(blocks) == 1
    assert blocks[0]["text"] == "Article Introduction"
    assert (tess_dir / "configs" / "tsv").is_file()


def test_tesseract_tsv_unclosed_double_quotes_in_articles_never_swallow_lines():
    payload = (
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
        '5\t1\t1\t1\t1\t1\t20\t20\t90\t18\t88\t"Modern\n'
        "5\t1\t1\t1\t1\t2\t118\t20\t80\t18\t92\tOptics\n"
        "5\t1\t1\t2\t1\t1\t20\t52\t210\t18\t95\tSecond-paragraph-kept\n"
    )
    lines = _lines_from_tesseract(payload)
    assert len(lines) == 2
    assert lines[0].text == '"Modern Optics'
    assert lines[1].text == "Second-paragraph-kept"


def test_article_transparent_png_and_document_illumination_fallback(monkeypatch):
    from PIL import ImageDraw
    from comic_studio.ocr import OcrLine, _to_white_backed_rgb

    # 1. Black ink on transparent (0, 0, 0, 0) RGBA PNG must composite onto white, never black-on-black!
    rgba = Image.new("RGBA", (120, 60), (0, 0, 0, 0))
    ImageDraw.Draw(rgba).rectangle([30, 15, 90, 45], fill=(0, 0, 0, 255))
    rgb = _to_white_backed_rgb(rgba)
    assert rgb.getpixel((5, 5)) == (255, 255, 255)
    assert rgb.getpixel((50, 30)) == (0, 0, 0)
    rgb.close()
    rgba.close()

    # 2. Shaded gray scanned article triggers _document_preprocess_image when primary is empty
    class ShadedDocEngine:
        def recognize_document(self, crop, language):
            arr = __import__("numpy").asarray(crop)
            # Only succeeds once paper background is brightened above 230
            if float(arr.max()) >= 245.0 and float(arr.mean()) >= 220.0:
                return [OcrLine("Normalized article paragraph", 0.91, [[20, 20], [260, 20], [260, 46], [20, 46]])]
            return []

        def recognize(self, crop, language):
            return []

    shaded = Image.new("RGB", (300, 160), (145, 145, 145))
    ImageDraw.Draw(shaded).rectangle([20, 20, 180, 36], fill=(95, 95, 95))
    blocks = recognize_image(ShadedDocEngine(), shaded, "eng", contrast=False, precise=False, page_mode="document")
    shaded.close()
    assert len(blocks) == 1
    assert blocks[0]["text"] == "Normalized article paragraph"


def test_windows_tesseract_installer_handles_winerror_740_via_runasinvoker_and_fallbacks(tmp_path, monkeypatch):
    import io
    from pathlib import Path
    import comic_studio.ocr_managed as managed

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    monkeypatch.setattr(managed, "_is_windows", lambda: True)
    monkeypatch.setattr(
        managed,
        "_latest_tesseract_windows_installer",
        lambda: ("5.4.0.20240606", "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe"),
    )

    class FakeDownloadResp:
        headers = {"Content-Length": str(1_200_000)}
        def __init__(self):
            self._buf = io.BytesIO(b"MZ" + b"0" * 1_200_000)
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, n=-1): return self._buf.read(n)

    monkeypatch.setattr(managed.urllib.request, "urlopen", lambda req, timeout=300: FakeDownloadResp())
    monkeypatch.setattr(managed, "_find_windows_7zip", lambda: r"C:\Program Files\7-Zip\7z.exe")

    seen_calls = []

    def fake_subproc(cmd, **kwargs):
        seen_calls.append((cmd, kwargs))
        if isinstance(cmd, str):
            # Verify installer filename avoids 'setup'/'install' and passes RunAsInvoker + /CurrentUser
            assert "tesseract-runtime-" in cmd
            assert "setup" not in cmd.lower()
            assert "/CurrentUser" in cmd
            assert kwargs.get("env", {}).get("__COMPAT_LAYER") == "RunAsInvoker"
            # Simulate corporate policy still throwing WinError 740 on CreateProcessW
            raise OSError(22, "The requested operation requires elevation", None, 740)
        # Fallback 2: 7-Zip extracts portable tesseract.exe cleanly without elevation!
        if isinstance(cmd, list) and "7z" in str(cmd[0]):
            out_arg = next(a for a in cmd if str(a).startswith("-o"))
            out_dir = Path(out_arg[2:])
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "tesseract.exe").write_bytes(b"MZ-portable")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return subprocess.CompletedProcess(cmd, 1, "", "")

    monkeypatch.setattr(managed, "_run_Subprocess", fake_subproc)
    exe_path = managed.install_tesseract_runtime(OcrError)
    assert exe_path.endswith("tesseract.exe")
    assert Path(exe_path).is_file()
    assert len(seen_calls) >= 2


def test_v385_multi_core_worker_budget_and_ordered_contextvar_propagation(monkeypatch):
    import threading
    import time
    from comic_studio.activity import reporting
    import comic_studio.ocr_managed as managed

    # 8 cores, ample RAM (16 GB) -> partitions cores cleanly without oversubscription
    monkeypatch.setattr(managed, "inspect_hardware", lambda: {"cpuCores": 8, "ramGb": 16.0})
    monkeypatch.setattr(managed, "cpu_core_count", lambda: 8)
    workers, threads_per_worker = managed.compute_worker_count(10, per_worker_mb=200, max_cap=6)
    assert workers == 6
    assert threads_per_worker >= 1
    assert workers * threads_per_worker <= 8 + workers

    # Low system RAM (1.5 GB -> usable_mb=307 MB) with 320 MB/worker -> clamps cleanly to 1 worker
    monkeypatch.setattr(managed, "inspect_hardware", lambda: {"cpuCores": 8, "ramGb": 1.5})
    low_ram_workers, low_ram_threads = managed.compute_worker_count(10, per_worker_mb=320, max_cap=6)
    assert low_ram_workers == 1
    assert low_ram_threads == 8

    # iter_parallel_ordered preserves strict order AND propagates ContextVar activity emission across threads
    emitted: list[str] = []
    emit_lock = threading.Lock()
    active_threads: set[int] = set()

    def record_emit(msg: str, kind: str = "info", progress: float | None = None) -> None:
        with emit_lock:
            emitted.append(msg)

    def slow_first_worker(idx: int, val: int) -> int:
        from comic_studio.activity import emit
        with emit_lock:
            active_threads.add(threading.get_ident())
        if idx == 0:
            time.sleep(0.04)
        emit(f"worker-{idx}")
        return val * 10

    with reporting(record_emit):
        outputs = list(managed.iter_parallel_ordered([1, 2, 3, 4], slow_first_worker, max_workers=3))

    assert [idx for idx, _, _ in outputs] == [0, 1, 2, 3]
    assert [res for _, _, res in outputs] == [10, 20, 30, 40]
    assert sorted(emitted) == ["worker-0", "worker-1", "worker-2", "worker-3"]
    assert len(active_threads) >= 2


def test_v385_onnx_gpu_detection_and_rapidengine_gpu_fallback_plus_cpu_pool(monkeypatch):
    import sys
    import threading
    import time
    import types
    import numpy as np
    from PIL import Image
    import comic_studio.ocr as ocr_mod
    from comic_studio.ocr import RapidEngine

    # 1) Windows DirectML detection includes explicit high-performance GPU dml_ep_cfg
    fake_ort = types.SimpleNamespace(
        get_available_providers=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        get_device=lambda: "GPU",
    )
    monkeypatch.setitem(sys.modules, "onnxruntime", fake_ort)
    accel = ocr_mod._detect_onnx_acceleration()
    assert accel["mode"] == "directml"
    assert accel["gpu"] is True
    assert accel["params"]["EngineConfig.onnxruntime.use_dml"] is True
    assert accel["params"]["EngineConfig.onnxruntime.dml_ep_cfg"]["performance_preference"] == "high_performance"

    # 2) CUDA takes priority when CUDAExecutionProvider is present
    fake_ort.get_available_providers = lambda: ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
    accel_cuda = ocr_mod._detect_onnx_acceleration()
    assert accel_cuda["mode"] == "cuda"
    assert accel_cuda["gpu"] is True
    assert accel_cuda["params"]["EngineConfig.onnxruntime.use_cuda"] is True

    # 3) Runtime GPU failure falls back seamlessly to CPU without failing OCR
    engine = RapidEngine("rapidocr-v6", "v6")
    monkeypatch.setattr(RapidEngine, "runtime_installed", property(lambda self: True))
    monkeypatch.setattr(RapidEngine, "model_ready", property(lambda self: True))
    monkeypatch.setattr(RapidEngine, "ready_languages", property(lambda self: ["eng"]))
    monkeypatch.setattr(RapidEngine, "_validate_ready", lambda self, language, allow_download=False: None)

    created_modes: list[bool] = []

    def fake_create(self, language: str):
        is_cpu_forced = self._force_cpu
        created_modes.append(is_cpu_forced)
        if not is_cpu_forced:
            self._using_gpu = True

            def broken_gpu_call(arr, **kw):
                raise RuntimeError("CUDA out of memory")

            return broken_gpu_call
        self._using_gpu = False
        return lambda arr, **kw: types.SimpleNamespace(boxes=[[[0, 0], [40, 0], [40, 20], [0, 20]]], txts=["FALLBACK OK"], scores=[0.95])

    monkeypatch.setattr(RapidEngine, "_create", fake_create)
    sample = Image.new("RGB", (80, 40), "white")
    lines = engine.recognize(sample, "eng")
    sample.close()
    assert [ln.text for ln in lines] == ["FALLBACK OK"]
    assert created_modes == [False, True]
    assert engine.using_gpu is False
    engine.unload()
    assert engine.is_loaded_in_ram is False

    # 4) Multi-page CPU batch pool creates distinct instances for concurrent threads and unloads cleanly
    monkeypatch.setattr(ocr_mod, "_detect_onnx_acceleration", lambda: {"mode": "cpu", "gpu": False, "params": {}})
    pool_engine = RapidEngine("rapidocr-v6", "v6")
    instance_counter = 0
    counter_lock = threading.Lock()
    barrier = threading.Barrier(2)

    def fake_pooled_create(self, language: str):
        nonlocal instance_counter
        with counter_lock:
            instance_counter += 1
            my_id = instance_counter
        self._using_gpu = False

        def run_infer(arr, **kw):
            try:
                barrier.wait(timeout=1.5)
            except threading.BrokenBarrierError:
                pass
            time.sleep(0.02)
            return types.SimpleNamespace(boxes=[[[0, 0], [30, 0], [30, 15], [0, 15]]], txts=[f"INST-{my_id}"], scores=[0.9])

        return run_infer

    monkeypatch.setattr(RapidEngine, "_create", fake_pooled_create)
    with pool_engine.configure_batch(total_pages=2, threads_per_worker=2) as slots:
        assert slots == 2
        results: list[str] = []

        def worker_task():
            im = Image.new("RGB", (60, 30), "white")
            try:
                out = pool_engine.recognize(im, "eng")
                results.append(out[0].text)
            finally:
                im.close()

        t1 = threading.Thread(target=worker_task)
        t2 = threading.Thread(target=worker_task)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    assert instance_counter == 2
    assert sorted(results) == ["INST-1", "INST-2"]
    assert pool_engine.is_loaded_in_ram is True
    pool_engine.unload()
    assert pool_engine.is_loaded_in_ram is False


def test_v385_tesseract_omp_thread_partition_and_cross_vendor_hardware_summary(monkeypatch):
    import json
    import subprocess
    import comic_studio.ocr as ocr_mod
    import comic_studio.ocr_managed as managed
    from PIL import Image

    tess = ocr_mod.TesseractEngine()
    monkeypatch.setattr(ocr_mod, "_tesseract_executable", lambda: "/usr/bin/tesseract")
    monkeypatch.setattr(ocr_mod.TesseractEngine, "ready_languages", property(lambda self: ["eng"]))
    captured_envs: list[str | None] = []

    def fake_run(cmd, **kwargs):
        captured_envs.append((kwargs.get("env") or {}).get("OMP_THREAD_LIMIT"))
        tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t92\tHELLO\n"
        return subprocess.CompletedProcess(cmd, 0, tsv, "")

    monkeypatch.setattr(ocr_mod.subprocess, "run", fake_run)
    im = Image.new("RGB", (100, 50), "white")
    try:
        with tess.configure_batch(total_pages=4, threads_per_worker=2) as workers:
            assert workers == 4
            out = tess.recognize(im, "eng")
            assert [ln.text for ln in out] == ["HELLO"]
        assert tess._omp_threads is None
    finally:
        im.close()
    assert captured_envs == ["2"]

    # Fake non-NVIDIA hardware (e.g. AMD Radeon DirectML) keeps hasNvidiaGpu=False while exposing hasGpu=True
    monkeypatch.setenv(
        "COMIC_STUDIO_FAKE_HARDWARE_JSON",
        json.dumps({"hasNvidiaGpu": False, "hasGpu": True, "gpuVendor": "amd", "gpuBackend": "directml", "gpuName": "AMD Radeon RX 7800 XT", "vramGb": 0.0, "freeDiskGb": 50.0, "cpuCores": 12}),
    )
    hw = managed.inspect_hardware()
    assert hw["hasNvidiaGpu"] is False
    assert hw["hasGpu"] is True
    assert hw["gpuBackend"] == "directml"
    assert hw["cpuCores"] == 12


def test_v387_isolated_blank_page_no_fallback_and_worker_stdout_protocol(monkeypatch, tmp_path):
    import io
    import json
    from comic_studio import ocr as ocr_mod
    from comic_studio import ocr_managed as managed
    from comic_studio import ocr_worker as worker_mod

    # 1. Blank page on an IsolatedOcrEngine returns [] immediately without running extra/bubble/document VLM fallbacks
    iso_engine = managed.IsolatedOcrEngine(
        "surya",
        ["eng"],
        threading.Lock(),
        ocr_mod.OcrLine,
        ocr_mod.OcrError,
    )
    vlm_calls = 0

    def fake_iso_recognize(crop, language, *, page_mode="auto"):
        nonlocal vlm_calls
        vlm_calls += 1
        return []

    monkeypatch.setattr(iso_engine, "recognize", fake_iso_recognize)
    blank = Image.new("RGB", (240, 320), "white")
    try:
        out = ocr_mod.recognize_image(iso_engine, blank, "eng", page_mode="document")
        assert out == []
        assert vlm_calls == 1
    finally:
        blank.close()

    # 2. ocr_worker.main redirects adapter stdout chatter to stderr so protocol stdout stays pure JSON lines
    class ChatterAdapter:
        def prepare(self, language: str) -> str:
            print("Downloading noisy third-party banner to stdout...")
            return "rev-clean"

        def recognize(self, image_path: str, language: str, regions):
            print("Inference progress 50% on stdout...")
            return [{"text": "Clean protocol", "confidence": 0.95, "polygon": [[0, 0], [40, 0], [40, 20], [0, 20]]}]

    monkeypatch.setattr(worker_mod, "_create_adapter", lambda eid, root: ChatterAdapter())
    proto_out = io.StringIO()
    proto_err = io.StringIO()
    req_in = io.StringIO(
        json.dumps({"imagePath": str(tmp_path / "dummy.png"), "language": "eng"}) + "\n"
        + json.dumps({"cmd": "quit"}) + "\n"
    )
    monkeypatch.setattr(sys, "argv", ["ocr_worker.py", "--engine", "surya", "--models-root", str(tmp_path), "--serve"])
    monkeypatch.setattr(sys, "stdout", proto_out)
    monkeypatch.setattr(sys, "stderr", proto_err)
    monkeypatch.setattr(sys, "stdin", req_in)
    assert worker_mod.main() == 0
    stdout_lines = [ln for ln in proto_out.getvalue().splitlines() if ln.strip()]
    assert len(stdout_lines) == 3
    parsed = [json.loads(ln) for ln in stdout_lines]
    assert parsed[0]["ready"] is True
    assert parsed[1]["ok"] is True and parsed[1]["lines"][0]["text"] == "Clean protocol"
    assert parsed[2]["bye"] is True
    assert "Inference progress 50% on stdout..." in proto_err.getvalue()


def test_v388_rapid_gpu_fallback_race_and_worker_edge_cases(monkeypatch, tmp_path):
    import threading
    from PIL import Image
    from comic_studio import ocr as ocr_mod
    from comic_studio import ocr_worker as worker_mod

    # 1. RapidEngine concurrent GPU->CPU fallback: both threads that checked out the GPU engine recover via CPU
    engine = ocr_mod.RapidEngine("rapidocr-v6", "v6")
    engine._using_gpu = True
    barrier = threading.Barrier(2)
    gpu_calls = 0

    def gpu_broken(_arr, **_kw):
        nonlocal gpu_calls
        gpu_calls += 1
        raise RuntimeError("DirectML VRAM exhausted")

    def cpu_ok(_arr, **_kw):
        return ([[[[0, 0], [40, 0], [40, 20], [0, 20]], "Recovered", 0.96]], None)

    orig_checkout = engine._checkout

    @ocr_mod.contextlib.contextmanager
    def synced_checkout(language: str):
        if engine.using_gpu and not engine._force_cpu:
            barrier.wait(timeout=5.0)
            yield gpu_broken
            return
        yield cpu_ok

    def fake_unload():
        engine._using_gpu = False

    monkeypatch.setattr(engine, "_checkout", synced_checkout)
    monkeypatch.setattr(engine, "unload", fake_unload)

    results = []
    errors = []

    def worker_call():
        im = Image.new("RGB", (60, 30), "white")
        try:
            results.append(engine.recognize(im, "eng"))
        except Exception as exc:
            errors.append(exc)
        finally:
            im.close()

    with engine.configure_batch(2):
        t1 = threading.Thread(target=worker_call)
        t2 = threading.Thread(target=worker_call)
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

    assert not errors, f"concurrent GPU fallback failed: {errors}"
    assert len(results) == 2 and all(r[0].text == "Recovered" for r in results)
    assert gpu_calls == 1, "second thread should skip calling the already-failed GPU instance"
    _ = orig_checkout

    # 2. _DotsOcrAdapter._extract_json_array handles leading bracket noise before actual JSON list
    noisy = '[Layout output] Note [1]:\n[{"bbox": [10, 12, 90, 34], "text": "Dots clean"}]'
    extracted = worker_mod._DotsOcrAdapter._extract_json_array(noisy)
    assert isinstance(extracted, list) and extracted[0]["text"] == "Dots clean"

    # 3. _SuryaAdapter legacy branch skips malformed lines missing both polygon and bbox
    img_file = tmp_path / "sample.png"
    im = Image.new("RGB", (100, 60), "white")
    im.save(img_file)
    im.close()
    surya = worker_mod._SuryaAdapter(tmp_path)
    monkeypatch.setattr(surya, "_ensure_loaded", lambda: None)

    class LegacyLine:
        def __init__(self, text, polygon=None, bbox=None):
            self.text = text
            self.polygon = polygon
            self.bbox = bbox
            self.confidence = 0.88

    class LegacyPage:
        text_lines = [
            LegacyLine("Bad line without coords", None, None),
            LegacyLine("Valid line", None, [5, 6, 80, 24]),
        ]

    surya._predictor = None
    surya._legacy = (lambda imgs, det_predictor=None: [LegacyPage()], object())
    out_lines = surya.recognize(str(img_file), "eng", None)
    assert len(out_lines) == 1 and out_lines[0]["text"] == "Valid line"


def test_v389_pixel_typography_bold_italic_and_worker_markup_hints():
    import io
    import pymupdf
    from PIL import Image
    from comic_studio.ocr import OcrLine, _blocks_from_lines, analyze_blocks_typography
    from comic_studio.ocr_worker import _extract_markup_hints, _strip_markup

    # 1. Worker markup hints preserve bold, italic, heading role, and leading spaces
    h_hints = _extract_markup_hints("## **8.3.5.7 Heel Fillet**", "section-header")
    assert h_hints == {"role": "heading", "bold": True}
    i_hints = _extract_markup_hints("    *Italic note line*\n      second indented line", "text")
    assert i_hints["italic"] is True
    cleaned = _strip_markup("    *Italic note line*\n      second indented line")
    assert cleaned == "    Italic note line\n      second indented line"

    # 2. Pixel-level stroke-weight (bold) and shear-projection (italic) detection on rendered page
    doc = pymupdf.open()
    page = doc.new_page(width=520, height=300)
    samples = [
        ("hebo", 14, "8.3.5.7.1 Minimum Heel Fillet", 40, 50),
        ("helv", 12, "The solder fillet shall wet the lead and land termination cleanly.", 40, 95),
        ("helv", 12, "Inspect all connections under standard magnification levels.", 40, 130),
        ("heit", 12, "Note: Refer to Figure 8-35 for side view geometry.", 40, 165),
        ("hebo", 12, "Warning: Excessive heat may delaminate the land pad.", 40, 200),
    ]
    raw_lines = []
    scale = 150.0 / 72.0
    for fontname, fsize, text, x, y in samples:
        page.insert_text((x, y), text, fontname=fontname, fontsize=fsize, color=(0, 0, 0))
    pix = page.get_pixmap(dpi=150)
    pil_img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    for w_box in page.get_text("dict")["blocks"]:
        for ln in w_box.get("lines", []):
            txt = "".join(sp["text"] for sp in ln["spans"]).strip()
            if not txt:
                continue
            bx0, by0, bx1, by1 = [v * scale for v in ln["bbox"]]
            raw_lines.append(OcrLine(txt, 0.96, [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]))
    doc.close()

    blocks = _blocks_from_lines(raw_lines)
    analyze_blocks_typography(pil_img, blocks, page_mode="document")
    pil_img.close()

    by_prefix = {b["text"].split()[0]: b for b in blocks}
    assert by_prefix["8.3.5.7.1"]["bold"] is True and by_prefix["8.3.5.7.1"].get("_detectedBold") is True
    assert by_prefix["Warning:"]["bold"] is True and by_prefix["Warning:"].get("_detectedBold") is True
    assert by_prefix["The"]["bold"] is False and by_prefix["The"]["italic"] is False
    assert by_prefix["Inspect"]["bold"] is False and by_prefix["Inspect"]["italic"] is False
    assert by_prefix["Note:"]["italic"] is True and by_prefix["Note:"].get("_detectedItalic") is True


def test_clean_pip_env_overrides_launcher_timeout_and_retries(monkeypatch):
    from comic_studio.ocr_managed import clean_pip_env

    monkeypatch.setenv("PIP_RETRIES", "1")
    monkeypatch.setenv("PIP_TIMEOUT", "15")
    monkeypatch.setenv("PIP_NO_CACHE_DIR", "1")
    env = clean_pip_env()
    assert env["PIP_TIMEOUT"] == "120"
    assert env["PIP_RETRIES"] == "10"
    assert env["PIP_PREFER_BINARY"] == "1"
    assert "PIP_NO_CACHE_DIR" not in env


def test_sync_local_wheelhouse_links_cached_wheels_from_os_pip_cache(monkeypatch, tmp_path):
    import comic_studio.ocr_managed as managed

    fake_models = tmp_path / "models"
    fake_localappdata = tmp_path / "LocalAppData"
    nested_wheel_dir = fake_localappdata / "pip" / "Cache" / "wheels" / "ab" / "cd" / "ef"
    nested_wheel_dir.mkdir(parents=True)
    wheel_file = nested_wheel_dir / "pillow-12.1.0-cp313-cp313-win_amd64.whl"
    wheel_file.write_bytes(b"fake-wheel-bytes")

    monkeypatch.setattr(managed, "models_dir", lambda: fake_models)
    monkeypatch.setattr(managed, "_is_windows", lambda: True)
    monkeypatch.setenv("LOCALAPPDATA", str(fake_localappdata))

    wh = managed.sync_local_wheelhouse()
    linked = wh / "pillow-12.1.0-cp313-cp313-win_amd64.whl"
    assert linked.is_file()
    assert linked.read_bytes() == b"fake-wheel-bytes"


def test_isolated_engine_install_retries_and_falls_back_to_pypi_mirror_on_read_timeout(monkeypatch, tmp_path):
    import comic_studio.ocr_managed as managed

    fake_models = tmp_path / "models"
    env_dir = fake_models / "envs" / "paddleocr-vl-1-6"
    py_exe = env_dir / "bin" / "python"
    py_exe.parent.mkdir(parents=True)
    py_exe.write_text("#!/bin/sh\n", encoding="utf-8")
    sp_dir = env_dir / "lib" / "python3.13" / "site-packages"
    sp_dir.mkdir(parents=True)
    broken_remnant = sp_dir / "~illow"
    broken_remnant.mkdir()

    # Pre-seed a cached wheel to verify `--find-links` is wired
    os_wheel = fake_models / "pip-cache" / "wheels" / "11" / "pillow-12.1.0-cp313-cp313-win_amd64.whl"
    os_wheel.parent.mkdir(parents=True)
    os_wheel.write_bytes(b"whl")

    monkeypatch.setattr(managed, "models_dir", lambda: fake_models)
    monkeypatch.setattr(managed, "_is_windows", lambda: False)
    monkeypatch.setattr(managed, "inspect_hardware", lambda: {"hasNvidiaGpu": False, "hasGpu": False})
    monkeypatch.setattr(managed.time, "sleep", lambda _s: None)
    monkeypatch.delenv("PIP_INDEX_URL", raising=False)
    monkeypatch.setattr(
        managed,
        "_run_Subprocess",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "pip 25.2", ""),
    )

    eng = managed.IsolatedOcrEngine("paddleocr-vl-1-6", ["eng"], threading.Lock(), OcrLine, OcrError)
    seen_cmds: list[list[str]] = []
    timeout_log = (
        "WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) "
        "after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='pypi.org', port=443): "
        "Read timed out. (read timeout=15)\")': /simple/pillow/\n"
        "WARNING: Connection timed out while downloading.\n"
        "ERROR: Could not find a version that satisfies the requirement pillow>=10.3 (from versions: none)\n"
        "ERROR: No matching distribution found for pillow>=10.3"
    )

    def fake_pip_stream(cmd, **_kwargs):
        seen_cmds.append(list(cmd))
        # Fail first two attempts on primary PyPI, succeed as soon as mirror --index-url is used
        if "--index-url" in cmd:
            return 0, "Successfully installed paddlepaddle-3.3.1 paddleocr-3.7.0 pillow-12.1.0"
        return 1, timeout_log

    monkeypatch.setattr(eng, "_run_pip_streaming", fake_pip_stream)
    eng._ensure_isolated_venv(upgrade=False)

    assert not broken_remnant.exists(), "broken ~pkg remnants must be cleaned before retrying pip"
    assert (env_dir / ".runtime-ready").is_file()
    assert len(seen_cmds) == 3
    for cmd in seen_cmds:
        assert "--no-cache-dir" not in cmd
        assert "--timeout" in cmd and cmd[cmd.index("--timeout") + 1] == "120"
        assert "--retries" in cmd and cmd[cmd.index("--retries") + 1] == "10"
        assert "--prefer-binary" in cmd
        assert "--cache-dir" in cmd
        assert "--find-links" in cmd
        # Primary 3.7.0 package preserved rather than needlessly downgrading on network timeout
        assert any("paddleocr[doc-parser]>=3.7.0" in part for part in cmd)
    assert "--index-url" not in seen_cmds[0]
    assert "--index-url" not in seen_cmds[1]
    assert "--index-url" in seen_cmds[2]
    assert "mirrors.aliyun.com/pypi/simple" in seen_cmds[2][seen_cmds[2].index("--index-url") + 1]


def test_install_packages_mirror_fallback_on_timeout(monkeypatch, tmp_path):
    import comic_studio.ocr_managed as managed

    monkeypatch.setattr(managed, "models_dir", lambda: tmp_path / "models")
    monkeypatch.setattr(time, "sleep", lambda _s: None)
    monkeypatch.delenv("PIP_INDEX_URL", raising=False)

    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(list(command))
        assert kwargs.get("env", {}).get("PIP_TIMEOUT") == "120"
        assert kwargs.get("env", {}).get("PIP_RETRIES") == "10"
        if "--index-url" in command:
            return subprocess.CompletedProcess(command, 0, "ok", "")
        return subprocess.CompletedProcess(
            command,
            1,
            "",
            "ERROR: Could not find a version that satisfies the requirement pillow>=10.3 (from versions: none)",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    install_packages(["easyocr>=1.7,<2"])
    assert len(calls) == 3
    assert "--no-cache-dir" not in calls[0]
    assert "--index-url" in calls[2]


def test_worker_requests_timeout_widener_upgrades_short_timeouts(monkeypatch):
    import types
    import comic_studio.ocr_worker as worker

    captured: list[Any] = []

    class FakeSession:
        def request(self, method, url, **kwargs):
            captured.append(kwargs.get("timeout"))
            return "ok"

    fake_requests = types.SimpleNamespace(Session=FakeSession)
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    worker._widen_requests_default_timeout(120.0)

    sess = FakeSession()
    sess.request("GET", "https://example.com/a", timeout=15)
    sess.request("GET", "https://example.com/b", timeout=(5, 15))
    sess.request("GET", "https://example.com/c", timeout=300)
    sess.request("GET", "https://example.com/d")
    assert captured == [120.0, (30.0, 120.0), 300, 120.0]


def test_pick_llama_cpp_asset_skips_empty_tag_release_and_supports_win_gpu_and_linux_targz():
    from comic_studio.ocr_managed import _pick_llama_cpp_asset

    releases = [
        {
            "tag_name": "v0.9.0",
            "assets": [{"name": "nightly-tag.txt", "browser_download_url": "https://example.com/nightly-tag.txt"}],
        },
        {
            "tag_name": "b12125",
            "assets": [
                {"name": "cudart-llama-bin-win-cuda-12.4-x64.zip", "browser_download_url": "https://example.com/cudart.zip"},
                {"name": "llama-b12125-bin-win-vulkan-x64.zip", "browser_download_url": "https://example.com/win-vulkan.zip"},
                {"name": "llama-b12125-bin-win-cpu-x64.zip", "browser_download_url": "https://example.com/win-cpu.zip"},
                {"name": "llama-b12125-bin-ubuntu-vulkan-x64.tar.gz", "browser_download_url": "https://example.com/linux-vulkan.tar.gz"},
                {"name": "llama-b12125-bin-ubuntu-x64.tar.gz", "browser_download_url": "https://example.com/linux-cpu.tar.gz"},
            ],
        },
    ]

    nm_wg, url_wg = _pick_llama_cpp_asset(releases, has_gpu=True, is_win=True, plat="win32", machine="AMD64")
    assert nm_wg == "llama-b12125-bin-win-vulkan-x64.zip" and url_wg.endswith("/win-vulkan.zip")

    nm_wc, url_wc = _pick_llama_cpp_asset(releases, has_gpu=False, is_win=True, plat="win32", machine="AMD64")
    assert nm_wc == "llama-b12125-bin-win-cpu-x64.zip" and url_wc.endswith("/win-cpu.zip")

    nm_lc, url_lc = _pick_llama_cpp_asset(releases, has_gpu=False, is_win=False, plat="linux", machine="x86_64")
    assert nm_lc == "llama-b12125-bin-ubuntu-x64.tar.gz" and url_lc.endswith("/linux-cpu.tar.gz")


def test_surya_windows_nvidia_skips_2_6gb_cu126_wheel_and_sets_llamacpp_env(monkeypatch, tmp_path):
    import comic_studio.ocr_managed as managed

    fake_models = tmp_path / "models"
    env_dir = fake_models / "envs" / "surya"
    py_exe = env_dir / "bin" / "python"
    py_exe.parent.mkdir(parents=True)
    py_exe.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.setattr(managed, "models_dir", lambda: fake_models)
    monkeypatch.setattr(managed, "_is_windows", lambda: True)
    monkeypatch.setattr(managed.os, "name", "nt", raising=False)
    monkeypatch.setattr(managed, "inspect_hardware", lambda: {"hasNvidiaGpu": True, "hasGpu": True})
    monkeypatch.setattr(
        managed,
        "_run_Subprocess",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "pip 25.2", ""),
    )

    eng = managed.IsolatedOcrEngine("surya", ["eng"], threading.Lock(), OcrLine, OcrError)
    monkeypatch.setattr(eng, "_env_python", lambda: py_exe)

    seen_cmds: list[list[str]] = []
    llama_called = [False]

    def fake_pip_stream(cmd, **_kwargs):
        seen_cmds.append(list(cmd))
        return 0, "Successfully installed surya-ocr-0.23.0"

    def fake_llama_setup():
        llama_called[0] = True
        llama_bin = env_dir / "llama-bin"
        llama_bin.mkdir(parents=True, exist_ok=True)
        (llama_bin / "llama-server.exe").write_bytes(b"MZ")

    monkeypatch.setattr(eng, "_run_pip_streaming", fake_pip_stream)
    monkeypatch.setattr(eng, "_ensure_llama_cpp_for_surya", fake_llama_setup)
    eng._ensure_isolated_venv(upgrade=False)

    assert llama_called[0] is True, "llama-server setup must run even when hasNvidiaGpu=True"
    assert len(seen_cmds) == 1
    assert "https://download.pytorch.org/whl/cu126" not in seen_cmds[0], "Surya must not pull 2.65 GB cu126 wheel"

    w_env = eng._worker_env()
    assert w_env["SURYA_INFERENCE_BACKEND"] == "llamacpp"
    assert w_env["SURYA_INFERENCE_PARALLEL"] == "1"
    assert w_env["SURYA_INFERENCE_CTX_SIZE"] == "16384"
    assert w_env["LLAMA_CPP_NGL"] == "99"
    assert w_env["LLAMA_CPP_BINARY"].endswith("llama-server.exe")


def test_surya_adapter_prepare_downloads_gguf_directly_without_spawning_server(monkeypatch, tmp_path):
    import types
    import comic_studio.ocr_worker as worker

    fake_settings = types.SimpleNamespace(
        SURYA_GGUF_REPO="datalab-to/surya-ocr-2.5-gguf",
        SURYA_GGUF_MODEL_FILE="surya-2.5.gguf",
        SURYA_GGUF_MMPROJ_FILE="surya-2.5-mmproj.gguf",
        SURYA_MODEL_CHECKPOINT="datalab-to/surya-ocr-2.5",
        FAST_LAYOUT_MODEL_CHECKPOINT="hf://datalab-to/surya_layout2",
    )
    fake_surya_pkg = types.ModuleType("surya")
    fake_surya_settings = types.ModuleType("surya.settings")
    fake_surya_settings.settings = fake_settings  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "surya", fake_surya_pkg)
    monkeypatch.setitem(sys.modules, "surya.settings", fake_surya_settings)

    downloaded_files: list[tuple[str, str]] = []
    downloaded_snaps: list[str] = []
    fake_hf = types.ModuleType("huggingface_hub")
    fake_hf.hf_hub_download = lambda repo_id, filename, **kw: downloaded_files.append((repo_id, filename)) or str(tmp_path / filename)  # type: ignore[attr-defined]
    fake_hf.snapshot_download = lambda repo_id, **kw: downloaded_snaps.append(repo_id) or str(tmp_path)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake_hf)
    monkeypatch.setattr("importlib.metadata.version", lambda pkg: "0.23.0")

    adapter = worker._SuryaAdapter(tmp_path)
    monkeypatch.setattr(adapter, "_ensure_loaded", lambda: (_ for _ in ()).throw(AssertionError("must not spawn server in prepare")))
    rev = adapter.prepare("eng")

    assert rev == "0.23.0"
    assert ("datalab-to/surya-ocr-2.5-gguf", "surya-2.5-mmproj.gguf") in downloaded_files
    assert ("datalab-to/surya-ocr-2.5-gguf", "surya-2.5.gguf") in downloaded_files
    assert "datalab-to/surya_layout2" in downloaded_snaps


def test_pip_streaming_stall_watchdog_and_cancel_kill_hung_child(monkeypatch, tmp_path):
    import comic_studio.ocr_managed as managed

    monkeypatch.setattr(managed, "models_dir", lambda: tmp_path / "models")
    eng = managed.IsolatedOcrEngine("surya", ["eng"], threading.Lock(), OcrLine, OcrError)

    # 1. Stall watchdog terminates a child that prints one Downloading line then hangs silently
    t0 = time.monotonic()
    rc, out = eng._run_pip_streaming(
        [
            sys.executable,
            "-c",
            "import sys, time; print('Downloading https://x.test/big-1.0.whl (50.0 MB)', flush=True); time.sleep(30)",
        ],
        start_p=0.2,
        end_p=0.7,
        label_prefix="تست",
        timeout=60,
        stall_timeout=1,
    )
    elapsed = time.monotonic() - t0
    assert rc != 0
    assert "ReadTimeoutError" in out
    assert elapsed < 10.0

    # 2. Explicit user cancel kills active child in < 2s
    def _cancel_soon():
        time.sleep(0.4)
        eng.cancel_install()

    threading.Thread(target=_cancel_soon, daemon=True).start()
    t1 = time.monotonic()
    rc2, out2 = eng._run_pip_streaming(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        start_p=0.2,
        end_p=0.7,
        label_prefix="تست",
        timeout=60,
        stall_timeout=30,
    )
    assert rc2 == 130
    assert "لغو" in out2
    assert (time.monotonic() - t1) < 5.0


def test_all_13_engines_specs_pins_and_dots_repo_url(tmp_path):
    import comic_studio.ocr_managed as managed
    import comic_studio.ocr_worker as worker

    assert len(ENGINE_INFO) == 14
    assert ENGINE_INFO["dots-ocr"]["repository"] == "https://github.com/rednote-hilab/dots.ocr"
    assert managed.ISOLATED_ENGINE_SPECS["dots-ocr"]["github_repo"] == "rednote-hilab/dots.ocr"
    for v4_id in ("dots-ocr", "deepseek-ocr-2", "olmocr"):
        cpu_reqs = " ".join(managed.ISOLATED_ENGINE_SPECS[v4_id]["pip_packages_cpu"])
        assert "<5.0.0" in cpu_reqs
    glm_reqs = " ".join(managed.ISOLATED_ENGINE_SPECS["glm-ocr"]["pip_packages_cpu"])
    assert "transformers>=5.3.0" in glm_reqs
    assert "sentencepiece>=0.2.0" in glm_reqs

    hy_adapter = worker._create_adapter("hunyuan-ocr", tmp_path)
    assert isinstance(hy_adapter, worker._HunyuanOcrAdapter)
    assert hy_adapter.hf_ignore_patterns == ("v1.0/*", "dflash/*")
    assert hy_adapter.preferred_attn == "eager"
    assert hy_adapter.system_prompt == ""

    eng = managed.IsolatedOcrEngine("mineru-2-5-pro", ["eng"], threading.Lock(), OcrLine, OcrError)
    env = eng._worker_env()
    assert env.get("HF_HUB_DISABLE_XET") == "1"
    assert env.get("HF_HUB_ENABLE_HF_TRANSFER") == "0"
    assert "mineru" in env.get("MINERU_HOME", "")


def test_nvidia_isolated_torch_uses_dedicated_cu128_index_with_cu126_fallback(monkeypatch, tmp_path):
    import comic_studio.ocr_managed as managed

    monkeypatch.setattr(managed, "models_dir", lambda: tmp_path / "models")
    monkeypatch.setattr(managed, "_is_windows", lambda: True)
    monkeypatch.setattr(managed, "inspect_hardware", lambda: {"hasNvidiaGpu": True, "hasGpu": True})

    env_dir = tmp_path / "models" / "envs" / "got-ocr-2"
    fake_py = env_dir / "Scripts" / "python.exe"
    fake_py.parent.mkdir(parents=True, exist_ok=True)
    fake_py.write_text("echo ok", encoding="utf-8")

    monkeypatch.setattr(managed, "_read_dist_version_in_venv", lambda d, pkg: None)

    pip_calls: list[list[str]] = []

    def fake_pip_resilient(self, py, args, *, upgrade, start_p, end_p, label_prefix):
        pip_calls.append(list(args))
        # Simulate cu128 temporarily failing so fallback to cu126 is exercised
        if "https://download.pytorch.org/whl/cu128" in args:
            return 1, "ReadTimeoutError"
        return 0, "ok"

    monkeypatch.setattr(managed.IsolatedOcrEngine, "_run_pip_resilient", fake_pip_resilient)
    monkeypatch.setattr(managed, "_run_Subprocess", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, "ok", ""))

    eng = managed.IsolatedOcrEngine("got-ocr-2", ["eng"], threading.Lock(), OcrLine, OcrError)
    monkeypatch.setattr(eng, "_env_python", lambda: fake_py)
    eng._ensure_isolated_venv(upgrade=False)

    assert pip_calls[0] == ["torch>=2.3.0", "torchvision>=0.18.0", "--index-url", "https://download.pytorch.org/whl/cu128"]
    assert pip_calls[1] == ["torch>=2.3.0", "torchvision>=0.18.0", "--index-url", "https://download.pytorch.org/whl/cu126"]
    assert "--extra-index-url" not in pip_calls[0]


def test_update_checks_cap_transformers_v4_and_eliminate_false_commit_updates(monkeypatch):
    import comic_studio.ocr_managed as managed

    urls_requested: list[str] = []

    def fake_fetch_json(url: str, timeout: float = 6.0):
        urls_requested.append(url)
        if url.endswith("/pypi/transformers/json"):
            return {
                "info": {"version": "5.22.1"},
                "releases": {
                    "4.46.3": [{"yanked": False}],
                    "4.57.3": [{"yanked": False}],
                    "5.0.0rc1": [{"yanked": False}],
                    "5.22.1": [{"yanked": False}],
                },
            }
        if "/releases/latest" in url:
            raise RuntimeError("HTTP 404 no release")
        raise AssertionError(f"Unexpected URL fetched: {url}")

    monkeypatch.setattr(managed, "_fetch_json", fake_fetch_json)

    # 1. fetch_remote_repo_revision must NEVER hit /commits?per_page=1
    assert managed.fetch_remote_repo_revision("zai-org/GLM-OCR") is None
    assert not any("/commits" in u for u in urls_requested)

    # 2. <5.0.0 engines resolve 4.57.3 instead of 5.22.1
    resolved_dots = managed._resolve_compatible_pypi_version("dots-ocr", "transformers", "5.22.1", installed_ver="4.57.3")
    assert resolved_dots == "4.57.3"
    # >=5.3.0 engines keep 5.22.1
    resolved_hunyuan = managed._resolve_compatible_pypi_version("hunyuan-ocr", "transformers", "5.22.1", installed_ver="5.13.0")
    assert resolved_hunyuan == "5.22.1"

    # 3. Stale cache with 5.22.1 or mismatched revision namespace must NOT trigger false updateAvailable
    class DummyEng:
        runtime_installed = True
        model_ready = True

    fields = managed.compute_engine_update_fields(
        engine_id="deepseek-ocr-2",
        engine_name="DeepSeek-OCR-2",
        engine=DummyEng(),
        installed_version="4.57.3",
        manifest_entry={"installedVersion": "4.57.3", "modelRevision": "hf:abcdef123456"},
        cached_remote={"latestVersion": "5.22.1", "latestRevision": "0.4.27"},
    )
    assert fields["updateAvailable"] is False

    # Same hf: namespace WITH a new weight commit DOES trigger updateAvailable
    fields_real = managed.compute_engine_update_fields(
        engine_id="deepseek-ocr-2",
        engine_name="DeepSeek-OCR-2",
        engine=DummyEng(),
        installed_version="4.57.3",
        manifest_entry={"installedVersion": "4.57.3", "modelRevision": "hf:abcdef123456"},
        cached_remote={"latestVersion": "4.57.3", "latestRevision": "hf:999999888888"},
    )
    assert fields_real["updateAvailable"] is True


def test_got_ocr_2_processor_without_chat_template_and_token_type_ids_strip(monkeypatch, tmp_path):
    import contextlib
    import types
    import comic_studio.ocr_worker as worker

    class FakeTensor:
        def __init__(self, arr):
            self._arr = arr
            self.shape = (1, len(arr[0]))
        def to(self, *args, **kwargs):
            return self
        def is_floating_point(self):
            return False
        def __getitem__(self, item):
            return FakeTensor([[10, 11]])

    class FakeGotProcessor:
        chat_template = None
        def apply_chat_template(self, *args, **kwargs):
            raise ValueError("Cannot use apply_chat_template because this processor does not have a chat template.")
        def __call__(self, *args, **kwargs):
            return {"input_ids": FakeTensor([[1, 2, 3]]), "token_type_ids": FakeTensor([[0, 0, 0]])}
        def batch_decode(self, tokens, skip_special_tokens=True):
            return ["<｜hy_begin｜>Decoded GOT Text<｜hy_end｜>"]

    seen_gen_kwargs: dict[str, object] = {}

    class FakeModel:
        dtype = None
        def generate(self, **kwargs):
            seen_gen_kwargs.update(kwargs)
            return FakeTensor([[1, 2, 3, 10, 11]])

    fake_torch = types.SimpleNamespace(no_grad=contextlib.nullcontext)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    adapter = worker._TransformersRegionAdapter(tmp_path, "stepfun-ai/GOT-OCR-2.0-hf", "OCR this.")
    monkeypatch.setattr(adapter, "_load", lambda: (FakeModel(), FakeGotProcessor(), "cpu"))
    crop = Image.new("RGB", (120, 60), "white")
    try:
        out_text = adapter._infer_crop(crop)
    finally:
        crop.close()
    assert out_text == "Decoded GOT Text"
    assert "token_type_ids" not in seen_gen_kwargs


def test_mineru_4x_norm1_and_norm1000_bboxes_and_cli_exit_check(monkeypatch, tmp_path):
    import comic_studio.ocr_worker as worker

    # 1. MiddleJson 0.0..1.0 float coordinates on a 1000x2000 page must scale to pixels (not <1px!)
    middle_json = {
        "pdf_info": [
            {
                "para_blocks": [
                    {"type": "title", "text": "Chapter One", "bbox": [0.1, 0.05, 0.8, 0.12]},
                ]
            }
        ]
    }
    res_m = worker._MinerUAdapter._extract_mineru_payload(middle_json, 1000, 2000)
    assert len(res_m) == 1
    assert res_m[0]["text"] == "Chapter One"
    assert res_m[0]["role"] == "heading"
    assert res_m[0]["polygon"][0] == [100.0, 100.0]
    assert res_m[0]["polygon"][2] == [800.0, 240.0]

    # 2. ContentListV1 0..1000 integer coordinates + list_items on a small 400x300 page
    content_list = [
        {"type": "list", "list_items": ["Item A", "Item B"], "bbox": [100, 200, 900, 500], "page_idx": 0}
    ]
    res_cl = worker._MinerUAdapter._extract_mineru_payload(content_list, 400, 300, coord_mode="norm1000")
    assert len(res_cl) == 1
    assert "Item A" in res_cl[0]["text"] and "Item B" in res_cl[0]["text"]
    assert res_cl[0]["polygon"][0] == [40.0, 60.0]
    assert res_cl[0]["polygon"][2] == [360.0, 150.0]

    # 3. CLI fallback must raise if mineru-models-download returns non-zero
    adapter = worker._MinerUAdapter(tmp_path)
    monkeypatch.setattr(worker, "shutil_which_in_venv", lambda name: "/fake/mineru-models-download")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 2, "", "network unreachable"),
    )
    with pytest.raises(RuntimeError, match="MinerU model download CLI failed"):
        adapter.prepare("eng")


def test_tesseract_language_mirror_failover_and_cancel_api_route(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from comic_studio.main import create_app

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    engine = TesseractEngine()
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/usr/bin/tesseract")

    attempted_urls: list[str] = []
    attempted_headers: list[dict[str, str]] = []

    class GoodResp:
        headers = {"Content-Length": "2048"}
        def __init__(self):
            self._buf = io.BytesIO(b"z" * 2048)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self, sz=-1):
            return self._buf.read(sz)

    def flaky_urlopen(req, timeout=180):
        attempted_urls.append(req.full_url)
        attempted_headers.append(dict(req.header_items()))
        if len(attempted_urls) < 4:
            raise urllib.error.URLError("blocked host")
        return GoodResp()

    import io
    import urllib.error
    monkeypatch.setattr("comic_studio.ocr.urllib.request.urlopen", flaky_urlopen)
    saved = engine._download_language_file("eng")
    assert saved.stat().st_size == 2048
    assert len(attempted_urls) == 4
    assert "api.github.com/repos/tesseract-ocr/tessdata_fast/contents/eng.traineddata" in attempted_urls[1]
    assert attempted_headers[1].get("Accept") == "application/vnd.github.raw"
    assert "hf-mirror.com" in attempted_urls[3]

    # Explicit POST /api/engines/{id}/cancel route works for both built-in and isolated engines
    client = TestClient(create_app(), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50000))
    resp_builtin = client.post("/api/engines/easyocr/cancel")
    assert resp_builtin.status_code == 200
    assert resp_builtin.json()["ok"] is True
    resp_iso = client.post("/api/engines/surya/cancel")
    assert resp_iso.status_code == 200
    assert resp_iso.json()["ok"] is True


def test_persian_ocr_engines_hezar_adapter_2d_suitability_and_rtl_grouping(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import comic_studio.ocr_managed as managed
    import comic_studio.ocr_worker as worker
    from comic_studio.ocr import (
        ENGINE_INFO,
        EasyEngine,
        LANGUAGES,
        RapidEngine,
        resolve_engine_suitability,
    )
    from comic_studio.ocr_grouping import organize_ocr_blocks

    # 1. Persian language definitions & coverage across built-in and isolated engines
    assert LANGUAGES["fas"] == {"name": "فارسی", "source": "fa"}
    persian_supported = {eid for eid, info in ENGINE_INFO.items() if "fas" in info["languages"]}
    assert "hezar-ocr" in persian_supported
    assert {"tesseract", "easyocr", "rapidocr-v5", "surya", "paddleocr-vl-1-6", "dots-ocr", "hunyuan-ocr", "glm-ocr", "deepseek-ocr-2", "olmocr"} <= persian_supported
    assert {"rapidocr-v6", "got-ocr-2", "mineru-2-5-pro"}.isdisjoint(persian_supported)

    # RapidEngine maps fas -> arabic on v5, rejects fas on v6 _validate_ready
    rapid_v5 = RapidEngine("rapidocr-v5", "v5")
    assert rapid_v5._language_names("fas") == ("ch", "arabic")
    assert "arabic_PP-OCRv5_rec_mobile.onnx" in rapid_v5._expected_models("fas")
    rapid_v6 = RapidEngine("rapidocr-v6", "v6")
    with pytest.raises(OcrError):
        rapid_v6._validate_ready("fas")

    # EasyEngine uses arabic.pth recognizer check for fas
    easy = EasyEngine()
    assert easy._expected_models("fas") == ["craft_mlt_25k.pth", "arabic.pth"]
    monkeypatch.setattr("comic_studio.ocr.models_dir", lambda: tmp_path)
    monkeypatch.setattr(EasyEngine, "runtime_installed", property(lambda self: True))
    (tmp_path / "easyocr").mkdir(parents=True)
    assert "fas" not in easy.ready_languages
    (tmp_path / "easyocr" / "craft_mlt_25k.pth").write_bytes(b"1")
    (tmp_path / "easyocr" / "arabic.pth").write_bytes(b"1")
    assert "fas" in easy.ready_languages

    # 2. 2D (language, page_mode) suitability matrix
    assert resolve_engine_suitability("hezar-ocr", "comic", "fas")["tier"] == "best"
    assert resolve_engine_suitability("hezar-ocr", "document", "fas")["tier"] == "best"
    assert resolve_engine_suitability("hezar-ocr", "comic", "eng")["tier"] == "weak"
    assert resolve_engine_suitability("tesseract", "document", "fas")["tier"] == "best"
    assert resolve_engine_suitability("tesseract", "comic", "fas")["tier"] == "weak"
    assert resolve_engine_suitability("easyocr", "comic", "fas")["tier"] == "best"
    assert resolve_engine_suitability("easyocr", "document", "fas")["tier"] == "weak"
    assert resolve_engine_suitability("rapidocr-v6", "comic", "fas")["tier"] == "weak"
    assert resolve_engine_suitability("rapidocr-v6", "comic", "eng")["tier"] == "best"
    assert resolve_engine_suitability("rapidocr-v5", "comic", "kor")["tier"] == "best"
    assert resolve_engine_suitability("got-ocr-2", "document", "chi_sim")["tier"] == "best"
    assert resolve_engine_suitability("got-ocr-2", "document", "fas")["tier"] == "weak"

    # 3. Hezar isolated spec, worker env, and _HezarOcrAdapter offline inference
    spec = managed.ISOLATED_ENGINE_SPECS["hezar-ocr"]
    assert spec["primary_pkg"] == "hezar"
    assert spec["requires_nvidia_gpu"] is False
    hezar_eng = managed.IsolatedOcrEngine("hezar-ocr", ["fas"], threading.Lock(), OcrLine, OcrError)
    env = hezar_eng._worker_env()
    assert "HEZAR_CACHE_DIR" in env and "hezar" in env["HEZAR_CACHE_DIR"]

    adapter = worker._create_adapter("hezar-ocr", tmp_path / "hezar_cache")
    assert isinstance(adapter, worker._HezarOcrAdapter)

    class FakeDetector:
        def predict(self, img):
            return [{"boxes": [(40, 20, 220, 32), (40, 62, 180, 32)]}]

    class FakeRecognizer:
        def predict(self, crops):
            return [{"text": f"سطر فارسی {i + 1}"} for i in range(len(crops))]

    class FakeModel:
        @staticmethod
        def load(path, device="cpu"):
            return FakeDetector() if "CRAFT" in str(path) else FakeRecognizer()

    fake_hezar_models = SimpleNamespace(Model=FakeModel)
    fake_torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        set_num_threads=lambda n: None,
    )
    monkeypatch.setitem(__import__("sys").modules, "torch", fake_torch)
    monkeypatch.setitem(__import__("sys").modules, "hezar", SimpleNamespace(models=fake_hezar_models))
    monkeypatch.setitem(__import__("sys").modules, "hezar.models", fake_hezar_models)
    downloaded_repos = []

    def fake_dl(repo_id, **kw):
        dest = tmp_path / "hezar_cache" / "hf-repos" / adapter._safe_repo_folder_name(repo_id)
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "model_config.yaml").write_text("name: fake", encoding="utf-8")
        downloaded_repos.append(repo_id)
        return dest, "hf:deadbeef1234"

    monkeypatch.setattr(adapter, "_download_hf_repo_resilient", fake_dl)
    assert adapter.prepare("fas") == "hf:deadbeef1234"
    assert downloaded_repos == ["hezarai/CRAFT", "hezarai/crnn-base-fa-v2"]

    img_path = tmp_path / "persian_sample.png"
    Image.new("RGB", (400, 160), (255, 255, 255)).save(img_path)
    lines = adapter.recognize(str(img_path), "fas", None)
    assert len(lines) == 2
    assert lines[0]["text"] == "سطر فارسی 1"
    assert lines[0]["polygon"] == [[40.0, 20.0], [260.0, 20.0], [260.0, 52.0], [40.0, 52.0]]

    # 4. RTL Persian paragraph grouping & right-margin first-line indent across 2 RTL columns
    rtl_raw = [
        # Right column (read first in RTL!), first line indented inward from right margin x1=760 -> x1=720
        {"id": 1, "text": "در این بخش اصول طراحی مدارهای چاپی بررسی می‌شود و", "conf": 95, "x0": 430, "y0": 80, "x1": 720, "y1": 106, "lineH": 26},
        {"id": 2, "text": "تمام استانداردهای لحیم‌کاری به دقت تشریح می‌گردد؟", "conf": 94, "x0": 440, "y0": 112, "x1": 760, "y1": 138, "lineH": 26},
        # Left column (read second in RTL!)
        {"id": 3, "text": "ستون چپ پس از ستون راست خوانده می‌شود و", "conf": 96, "x0": 60, "y0": 82, "x1": 360, "y1": 108, "lineH": 26},
        {"id": 4, "text": "ادامهٔ مطالب فصل در این ستون قرار می‌گیرد.", "conf": 95, "x0": 60, "y0": 114, "x1": 360, "y1": 140, "lineH": 26},
    ]
    grouped, mode = organize_ocr_blocks(rtl_raw, group_lines=True, page_size=(820, 1100), page_mode="document")
    assert mode == "document"
    assert len(grouped) == 2
    assert "اصول طراحی" in grouped[0]["text"] and "لحیم‌کاری" in grouped[0]["text"]
    assert grouped[0].get("firstLineIndent", 0) >= 0.75
    assert "ستون چپ" in grouped[1]["text"] and "ادامهٔ مطالب" in grouped[1]["text"]


def test_v394_paddleocr_vl_onednn_pir_fix_and_execution_mode_metadata(tmp_path, monkeypatch):
    import types
    import comic_studio.ocr_managed as managed
    import comic_studio.ocr_worker as worker
    from comic_studio.ocr import ENGINE_INFO, OcrError, OcrLine

    # 1. All 14 OCR engines declare local on-system execution metadata
    assert len(ENGINE_INFO) == 14
    for eid, meta in ENGINE_INFO.items():
        assert meta["executionMode"] == "local", f"{eid} must declare executionMode='local'"
        assert meta["requiresInternetForOcr"] is False
        assert meta["requiresInternetForSetup"] is True

    # 2. _worker_env disables MKLDNN/oneDNN specifically for paddleocr-vl-1-6 while keeping it for other engines
    monkeypatch.delenv("FLAGS_use_mkldnn", raising=False)
    monkeypatch.delenv("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", raising=False)
    pvl_eng = managed.IsolatedOcrEngine("paddleocr-vl-1-6", ["eng", "fas"], threading.Lock(), OcrLine, OcrError)
    pvl_env = pvl_eng._worker_env()
    assert pvl_env["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] == "False"
    assert pvl_env["FLAGS_use_mkldnn"] == "0"

    other_eng = managed.IsolatedOcrEngine("mineru-2-5-pro", ["eng"], threading.Lock(), OcrLine, OcrError)
    other_env = other_eng._worker_env()
    assert other_env["FLAGS_use_mkldnn"] == "1"

    # 3. _PaddleOcrVlAdapter disables PaddleX MKLDNN flags before init, reuses cached v1.5 weights if v1.6 is absent,
    #    downscales oversized CPU pages with exact bbox rescaling, and auto-recovers from oneDNN/PIR worker errors.
    official_dir = tmp_path / "paddlex" / "official_models"
    (official_dir / "PaddleOCR-VL-1.5-0.9B").mkdir(parents=True)

    fake_pdx_flags = types.SimpleNamespace(ENABLE_MKLDNN_BYDEFAULT=True)
    fake_pocr_consts = types.SimpleNamespace(DEFAULT_ENABLE_MKLDNN=True)
    monkeypatch.setitem(sys.modules, "paddlex.utils.flags", fake_pdx_flags)
    monkeypatch.setitem(sys.modules, "paddleocr._constants", fake_pocr_consts)

    init_calls: list[dict[str, object]] = []
    predict_calls: list[str] = []

    class FakePaddleOCRVL:
        def __init__(self, **kwargs):
            init_calls.append(dict(kwargs))

        def predict(self, img_path):
            predict_calls.append(str(img_path))
            if len(predict_calls) == 1:
                raise RuntimeError(
                    "Exception from the 'cv' worker: (Unimplemented) ConvertPirAttribute2RuntimeAttribute "
                    "not support [pir::ArrayAttribute<pir::DoubleAttribute>] "
                    "(at ..\\paddle\\fluid\\framework\\new_executor\\instruction\\onednn\\onednn_instruction.cc:118)"
                )
            with Image.open(img_path) as seen_im:
                seen_w, seen_h = seen_im.size
            assert max(seen_w, seen_h) <= worker._PaddleOcrVlAdapter._CPU_MAX_SIDE
            return [
                {
                    "res": {
                        "parsing_res_list": [
                            {
                                "block_label": "text",
                                "block_content": "Fixed Windows CPU VL",
                                "block_bbox": [seen_w * 0.1, seen_h * 0.2, seen_w * 0.5, seen_h * 0.4],
                                "score": 0.96,
                            }
                        ]
                    }
                }
            ]

    fake_pkg = types.ModuleType("paddleocr")
    fake_pkg.__version__ = "3.7.0"
    fake_pkg.PaddleOCRVL = FakePaddleOCRVL
    fake_pipelines = types.ModuleType("paddleocr._pipelines")
    fake_pvl = types.ModuleType("paddleocr._pipelines.paddleocr_vl")
    fake_pvl._AVAILABLE_PIPELINE_VERSIONS = ["v1", "v1.5", "v1.6"]
    fake_pvl._DEFAULT_PIPELINE_VERSION = "v1.6"
    fake_paddle = types.SimpleNamespace(
        device=types.SimpleNamespace(
            is_compiled_with_cuda=lambda: False,
            cuda=types.SimpleNamespace(device_count=lambda: 0),
        ),
        set_flags=lambda flags: None,
    )
    monkeypatch.setitem(sys.modules, "paddle", fake_paddle)
    monkeypatch.setitem(sys.modules, "paddleocr", fake_pkg)
    monkeypatch.setitem(sys.modules, "paddleocr._pipelines", fake_pipelines)
    monkeypatch.setitem(sys.modules, "paddleocr._pipelines.paddleocr_vl", fake_pvl)

    big_img = tmp_path / "huge_page.png"
    Image.new("RGB", (3000, 4000), "white").save(big_img)

    adapter = worker._PaddleOcrVlAdapter(tmp_path)
    out = adapter.recognize(str(big_img), "eng", None)

    assert os.environ["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] == "False"
    assert os.environ["FLAGS_use_mkldnn"] == "0"
    assert fake_pdx_flags.ENABLE_MKLDNN_BYDEFAULT is False
    assert fake_pocr_consts.DEFAULT_ENABLE_MKLDNN is False
    assert len(init_calls) == 2, "Should rebuild pipeline cleanly after simulated oneDNN/PIR crash"
    assert init_calls[0]["pipeline_version"] == "v1.5", "Should reuse cached v1.5 weights without forcing v1.6 download"
    assert init_calls[0]["enable_mkldnn"] is False
    assert init_calls[0]["use_queues"] is False
    assert len(out) == 1
    assert out[0]["text"] == "Fixed Windows CPU VL"
    # Rescaled bbox must map back to 3000x4000 original page coordinates (300, 800) -> (1500, 1600)
    assert abs(out[0]["polygon"][0][0] - 300.0) <= 3.0
    assert abs(out[0]["polygon"][0][1] - 800.0) <= 3.0
    assert abs(out[0]["polygon"][2][0] - 1500.0) <= 3.0
    assert abs(out[0]["polygon"][2][1] - 1600.0) <= 3.0


def test_v395_download_size_estimates_cover_all_14_engines():
    from comic_studio.ocr import ENGINE_INFO, EngineRegistry
    from comic_studio.ocr_managed import compute_engine_download_estimate, format_download_size_fa

    cpu_hw = {"hasNvidiaGpu": False, "hasGpu": False}
    nv_hw = {"hasNvidiaGpu": True, "hasGpu": True}

    for eid, info in ENGINE_INFO.items():
        est_cpu = compute_engine_download_estimate(
            eid, runtime_installed=False, model_ready=False, nominal_size_gb=info["downloadSizeGb"], hw=cpu_hw,
        )
        est_nv = compute_engine_download_estimate(
            eid, runtime_installed=False, model_ready=False, nominal_size_gb=info["downloadSizeGb"], hw=nv_hw,
        )
        est_weights_only = compute_engine_download_estimate(
            eid, runtime_installed=True, model_ready=False, nominal_size_gb=info["downloadSizeGb"], hw=nv_hw,
        )
        assert est_cpu["fullDownloadSizeGb"] == round(est_cpu["runtimeDownloadGb"] + est_cpu["weightsDownloadGb"], 3)
        assert est_cpu["totalDownloadGb"] == est_cpu["fullDownloadSizeGb"]
        assert est_nv["fullDownloadSizeGb"] >= est_cpu["fullDownloadSizeGb"]
        assert est_weights_only["totalDownloadGb"] == est_weights_only["weightsDownloadGb"]
        assert format_download_size_fa(est_cpu["totalDownloadGb"]).startswith("~")

    statuses = EngineRegistry().status()
    assert len(statuses) == 14
    for entry in statuses:
        assert "fullDownloadSizeGb" in entry
        assert "totalDownloadGb" in entry
        assert "runtimeDownloadGb" in entry
        assert "weightsDownloadGb" in entry
        assert entry["fullDownloadSizeGb"] > 0


def test_v395_all_isolated_and_builtin_runtime_root_cause_fixes(monkeypatch, tmp_path):
    import sys
    import types
    from PIL import Image
    from comic_studio import ocr as ocr_mod
    from comic_studio import ocr_worker as worker

    # 1. VLM crop normalizer protects <28px height & extreme aspect ratios from Qwen2.5-VL / GLM-OCR factor:28 crash
    tiny_rgba = Image.new("RGBA", (240, 14), (255, 255, 255, 0))
    norm_img, owned = worker._normalize_crop_for_vlm(tiny_rgba)
    try:
        assert owned is True
        assert norm_img.mode == "RGB"
        assert norm_img.size[0] >= 32 and norm_img.size[1] >= 32
        assert max(norm_img.size) / min(norm_img.size) <= 160.0
    finally:
        norm_img.close()
        tiny_rgba.close()

    # 2. Nested config attn_implementation sanitizer overrides hardcoded flash_attention_2 inside vision_config
    vision_cfg = types.SimpleNamespace(attn_implementation="flash_attention_2", _attn_implementation="flash_attention_2")
    root_cfg = types.SimpleNamespace(attn_implementation="flash_attention_2", vision_config=vision_cfg)
    worker._sanitize_config_attn(root_cfg, "sdpa")
    assert root_cfg.attn_implementation == "sdpa"
    assert root_cfg.vision_config.attn_implementation == "sdpa"
    assert root_cfg.vision_config._attn_implementation == "sdpa"

    # 3. DeepSeek-OCR-2 transformers 4.48–4.57 compatibility shims (LlamaFlashAttention2 + DynamicCache)
    fake_llama = types.ModuleType("transformers.models.llama.modeling_llama")
    fake_llama.LlamaAttention = type("LlamaAttention", (), {})

    class FakeDynamicCache:
        def get_seq_length(self, layer_idx: int = 0) -> int:
            return 42

        def get_max_cache_shape(self):
            return 2048

    fake_cache_utils = types.SimpleNamespace(DynamicCache=FakeDynamicCache)
    fake_tf = types.SimpleNamespace(cache_utils=fake_cache_utils)
    monkeypatch.setitem(sys.modules, "transformers.models.llama.modeling_llama", fake_llama)
    worker._install_transformers_v4_compat_shims(fake_tf)
    assert getattr(fake_llama, "LlamaFlashAttention2", None) is fake_llama.LlamaAttention
    dc = FakeDynamicCache()
    assert dc.seen_tokens == 42
    assert dc.get_max_length() == 2048
    assert dc.get_usable_length(10, 0) == 42

    # 4. MinerU 4.1.7 ModelReadyResult(ready=False) dataclass & middle_json unpacking
    assert worker._MinerUAdapter._mineru_repo_is_ready(types.SimpleNamespace(ready=False, missing_paths=["a.onnx"])) is False
    assert worker._MinerUAdapter._mineru_repo_is_ready(types.SimpleNamespace(ready=True, missing_paths=[])) is True

    mineru_img = tmp_path / "mineru_page.png"
    Image.new("RGB", (1000, 2000), "white").save(mineru_img)
    received_render_arg: list = []
    fake_middle = types.SimpleNamespace(tag="MIDDLE_JSON_INSTANCE")
    fake_parse_res = types.SimpleNamespace(middle_json=fake_middle, to_dict=lambda: {})
    fake_mineru_parser = types.ModuleType("mineru.parser")
    fake_mineru_parser.parse = lambda *a, **kw: fake_parse_res
    fake_mineru_render = types.ModuleType("mineru.render")

    def _fake_render_content_list(arg):
        received_render_arg.append(arg)
        return [{"type": "text", "text": "MinerU unpacked middle_json", "bbox": [100, 200, 500, 300]}]

    fake_mineru_render.render_content_list = _fake_render_content_list
    monkeypatch.setitem(sys.modules, "mineru", types.ModuleType("mineru"))
    monkeypatch.setitem(sys.modules, "mineru.parser", fake_mineru_parser)
    monkeypatch.setitem(sys.modules, "mineru.render", fake_mineru_render)
    mineru_lines = worker._MinerUAdapter(tmp_path).recognize(str(mineru_img), "eng", None)
    assert received_render_arg == [fake_middle]
    assert len(mineru_lines) == 1 and mineru_lines[0]["text"] == "MinerU unpacked middle_json"

    # 5. olmOCR YAML front-matter, JSON natural_text, figure tags, and "null" cleanup + GLM-OCR prompt
    glm = worker._create_adapter("glm-ocr", tmp_path)
    assert glm.prompt == "Text Recognition:"
    assert glm.repetition_penalty == 1.1
    olm = worker._create_adapter("olmocr", tmp_path)
    assert olm.max_crop_long_side == 1288
    yaml_sample = (
        "---\nprimary_language: en\nis_rotation_valid: True\nrotation_correction: 0\n"
        "is_table: False\nis_diagram: False\n---\n![Diagram](page_10_20_100_100.png)\nHello from olmOCR-2!"
    )
    assert olm._clean_olmocr_output(yaml_sample) == "Hello from olmOCR-2!"
    assert olm._clean_olmocr_output('{"primary_language": "en", "natural_text": "JSON body"}') == "JSON body"
    assert olm._clean_olmocr_output('{"primary_language": null, "natural_text": null}') == ""
    assert olm._clean_olmocr_output("null") == ""

    # 6. dots.ocr rescales bboxes from resized vision grid (e.g. 500x1000) to original image (1000x2000)
    dots_img = tmp_path / "dots_page.png"
    Image.new("RGB", (1000, 2000), "white").save(dots_img)
    dots = worker._DotsOcrAdapter(tmp_path)

    def _fake_dots_infer_raw(crop_img, *, max_tokens=None, prompt_override=None):
        dots._last_grid_size = (500, 1000)
        return '[{"bbox": [50, 100, 250, 200], "category": "Text", "text": "Scaled dots text"}, {"bbox": [0, 0, 100, 100], "category": "Picture", "text": "Ignore pic"}]'

    monkeypatch.setattr(dots, "_infer_raw", _fake_dots_infer_raw)
    dots_out = dots.recognize(str(dots_img), "eng", None)
    assert len(dots_out) == 1
    assert dots_out[0]["text"] == "Scaled dots text"
    assert dots_out[0]["polygon"][0] == [100.0, 200.0]
    assert dots_out[0]["polygon"][2] == [500.0, 400.0]

    # 7. HunyuanOCR tokenizer placeholder patch + [0, 1000] spotting_json single-pass parser
    hy = worker._HunyuanOcrAdapter(tmp_path)
    fake_tok = types.SimpleNamespace(
        image_token=None,
        image_token_id=None,
        video_token=None,
        video_token_id=None,
        unk_token_id=0,
        convert_tokens_to_ids=lambda t: 102 if "102" in str(t) else 105,
    )
    hy._patch_hunyuan_tokenizer(fake_tok)
    assert fake_tok.image_token == "<｜hy_place▁holder▁no▁102｜>"
    assert fake_tok.image_token_id == 102
    assert fake_tok.video_token_id == 105
    monkeypatch.setattr(
        hy,
        "_infer_raw",
        lambda *a, **kw: '[{"box": [100, 200, 600, 300], "text": "سلام هونیوان"}]',
    )
    hy_out = hy.recognize(str(dots_img), "fas", None)
    assert len(hy_out) == 1 and hy_out[0]["text"] == "سلام هونیوان"
    assert hy_out[0]["polygon"][0] == [100.0, 400.0]
    assert hy_out[0]["polygon"][2] == [600.0, 600.0]

    # 8. Surya retains capped blocks (error=True when finish_reason == "length") that still have text
    surya = worker._SuryaAdapter(tmp_path)
    surya._predictor = lambda imgs: [
        types.SimpleNamespace(
            blocks=[
                types.SimpleNamespace(
                    skipped=False,
                    error=True,
                    html="<p>Capped &amp; preserved<br/>second line</p>",
                    label="Text",
                    bbox=[10, 20, 300, 80],
                    polygon=None,
                    confidence=0.91,
                )
            ]
        )
    ]
    surya_out = surya.recognize(str(dots_img), "eng", None)
    assert len(surya_out) == 1
    assert surya_out[0]["text"] == "Capped & preserved\nsecond line"

    # 9. EasyEngine runtime GPU -> CPU fallback & RGBA normalization
    easy = ocr_mod.EasyEngine()
    gpu_calls = {"n": 0}

    class FakeEasyReader:
        def __init__(self, is_gpu: bool):
            self.is_gpu = is_gpu

        def readtext(self, arr, **kwargs):
            assert arr.ndim == 3 and arr.shape[2] == 3, "RGBA image must be normalized to 3-channel RGB"
            if self.is_gpu:
                gpu_calls["n"] += 1
                raise RuntimeError("CUDA error: no kernel image is available for execution on the device")
            return [([[0, 0], [80, 0], [80, 24], [0, 24]], "CPU fallback succeeded", 0.95)]

    def _fake_easy_reader(language: str, download: bool):
        if not easy._force_cpu:
            easy._using_gpu = True
            return FakeEasyReader(True)
        easy._using_gpu = False
        return FakeEasyReader(False)

    monkeypatch.setattr(easy, "_reader", _fake_easy_reader)
    rgba_sample = Image.new("RGBA", (120, 40), (255, 255, 255, 128))
    try:
        easy_lines = easy.recognize(rgba_sample, "eng")
    finally:
        rgba_sample.close()
    assert gpu_calls["n"] == 1
    assert easy._force_cpu is True
    assert len(easy_lines) == 1 and easy_lines[0].text == "CPU fallback succeeded"


def test_v396_surya_zero_block_root_cause_fixes_and_silent_error_recovery(tmp_path, monkeypatch):
    import sys
    import types
    from types import SimpleNamespace
    from PIL import Image, ImageDraw
    import comic_studio.ocr_managed as ocr_managed
    from comic_studio import ocr_worker

    # 1) _worker_env sets LLAMA_CPP_NGL="0" on non-NVIDIA Intel/AMD GPU and "99" on NVIDIA GPU,
    #    plus SURYA_MAX_TOKENS_FULL_PAGE="4096" and SURYA_INFERENCE_LOGPROBS="false".
    monkeypatch.setattr(ocr_managed, "inspect_hardware", lambda: {"hasNvidiaGpu": False, "hasGpu": True, "gpuBackend": "directml", "cpuCores": 8})
    monkeypatch.setattr(ocr_managed.sys, "platform", "win32")
    surya_engine = ocr_managed.IsolatedOcrEngine("surya", "Surya", "Datalab", "desc", ("eng", "fas"))
    env_dml = surya_engine._worker_env()
    assert env_dml["LLAMA_CPP_NGL"] == "0"
    assert env_dml["SURYA_MAX_TOKENS_FULL_PAGE"] == "4096"
    assert env_dml["SURYA_INFERENCE_LOGPROBS"] == "false"

    # 2) _SuryaAdapter._sync_surya_runtime_settings syncs ctx=24576, max_tokens=4096, logprobs=False
    fake_settings = SimpleNamespace(
        SURYA_INFERENCE_BACKEND="auto",
        SURYA_INFERENCE_PARALLEL=4,
        SURYA_INFERENCE_CTX_SIZE=16384,
        SURYA_MAX_TOKENS_FULL_PAGE=12288,
        SURYA_INFERENCE_LOGPROBS=True,
        LLAMA_CPP_NGL=99,
        FAST_LAYOUT_MODEL_CHECKPOINT="",
        FAST_LAYOUT_CONFIDENCE_THRESHOLD=0.35,
    )
    fake_surya = types.ModuleType("surya")
    fake_surya_settings = types.ModuleType("surya.settings")
    fake_surya_settings.settings = fake_settings
    monkeypatch.setitem(sys.modules, "surya", fake_surya)
    monkeypatch.setitem(sys.modules, "surya.settings", fake_surya_settings)
    monkeypatch.delenv("SURYA_INFERENCE_CTX_SIZE", raising=False)
    monkeypatch.setenv("SURYA_MAX_TOKENS_FULL_PAGE", "4096")
    monkeypatch.setenv("SURYA_INFERENCE_LOGPROBS", "false")
    monkeypatch.setenv("LLAMA_CPP_NGL", "0")

    surya_adapter = ocr_worker._SuryaAdapter(tmp_path)
    surya_adapter._sync_surya_runtime_settings()
    assert fake_settings.SURYA_INFERENCE_CTX_SIZE == 24576
    assert fake_settings.SURYA_MAX_TOKENS_FULL_PAGE == 4096
    assert fake_settings.SURYA_INFERENCE_LOGPROBS is False
    assert fake_settings.LLAMA_CPP_NGL == 0

    # Create a non-blank English document page image
    doc_path = tmp_path / "page_2.png"
    img = Image.new("RGB", (600, 400), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle([40, 60, 520, 95], fill=(15, 15, 15))
    draw.rectangle([40, 140, 500, 175], fill=(20, 20, 20))
    img.save(doc_path)
    img.close()

    # 3) Fast in-process rf-detr layout passes layout_results=[layout_res] to _predictor
    fake_layout_box = SimpleNamespace(label="Text", polygon=[[40, 60], [520, 60], [520, 95], [40, 95]])
    fake_fast_layout = SimpleNamespace(bboxes=[fake_layout_box], image_bbox=[0.0, 0.0, 600.0, 400.0])
    seen_layout_kwargs: list[bool] = []

    def _fast_pred(imgs, layout_results=None):
        seen_layout_kwargs.append(layout_results is not None)
        return [
            SimpleNamespace(
                error=False,
                blocks=[
                    SimpleNamespace(
                        html="<p>English paragraph recognized via fast block layout.</p>",
                        label="Text",
                        bbox=[40, 60, 520, 95],
                        confidence=0.96,
                        error=False,
                    )
                ],
            )
        ]

    surya_adapter._predictor = _fast_pred
    monkeypatch.setattr(surya_adapter, "_detect_fast_layout_inprocess", lambda rgb: fake_fast_layout)
    fast_lines = surya_adapter.recognize(str(doc_path), "eng", None)
    assert seen_layout_kwargs == [True]
    assert len(fast_lines) == 1 and "English paragraph" in fast_lines[0]["text"]

    # 4) Silent BlockOCRResult(error=True, raw="") with LLAMA_CPP_NGL="99" automatically recovers on CPU ("0")
    monkeypatch.setattr(surya_adapter, "_detect_fast_layout_inprocess", lambda rgb: None)
    monkeypatch.setenv("LLAMA_CPP_NGL", "99")
    ngl_history: list[str] = []

    def _silent_gpu_fail_then_cpu_ok(imgs, layout_results=None):
        cur_ngl = ocr_worker.os.environ.get("LLAMA_CPP_NGL", "0")
        ngl_history.append(cur_ngl)
        if cur_ngl != "0":
            # Exact upstream openai_client failure mode: no exception raised, 0 valid text, error=True
            return [SimpleNamespace(error=True, blocks=[SimpleNamespace(html="", text="", label="Full-Page", bbox=[0, 0, 600, 400], error=True)])]
        return [SimpleNamespace(error=False, blocks=[SimpleNamespace(html="<p>Recovered on CPU</p>", label="Text", bbox=[40, 60, 520, 95], confidence=0.92, error=False)])]

    def _reload_stub():
        surya_adapter._predictor = _silent_gpu_fail_then_cpu_ok

    monkeypatch.setattr(surya_adapter, "_ensure_loaded", _reload_stub)
    rec_lines = surya_adapter.recognize(str(doc_path), "eng", None)
    assert ngl_history == ["99", "0"]
    assert len(rec_lines) == 1 and rec_lines[0]["text"] == "Recovered on CPU"

    # 5) Persistent silent llama-server error raises clear RuntimeError instead of returning 0 silent blocks
    def _always_silent_error(imgs, layout_results=None):
        return [SimpleNamespace(error=True, blocks=[SimpleNamespace(html="", text="", label="Full-Page", bbox=[0, 0, 600, 400], error=True)])]

    surya_adapter._predictor = _always_silent_error
    monkeypatch.setattr(surya_adapter, "_ensure_loaded", lambda: None)
    monkeypatch.setattr(surya_adapter, "_build_region_layout_fallback", lambda rgb, regs: None)
    try:
        surya_adapter.recognize(str(doc_path), "eng", None)
        raise AssertionError("Expected RuntimeError when Surya llama-server returns error=True with 0 blocks")
    except RuntimeError as exc:
        assert "Surya llama-server inference returned an error" in str(exc)


def test_v396_persian_download_fixes_across_rapid_hezar_easy_and_bidi_shim(tmp_path, monkeypatch):
    import io
    import sys
    import comic_studio.ocr as ocr_mod
    from comic_studio import ocr_worker

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))

    # 1) Pure-Python fallback bidi shim reverses visual RTL runs while preserving embedded English/digits
    saved_bidi = sys.modules.pop("bidi", None)
    saved_bidi_alg = sys.modules.pop("bidi.algorithm", None)
    # Block real python-bidi import briefly so _install_fallback_bidi_shim installs its pure-Python shim
    sys.modules["bidi"] = None  # type: ignore[assignment]
    sys.modules["bidi.algorithm"] = None  # type: ignore[assignment]
    try:
        ocr_mod._install_fallback_bidi_shim()
        from bidi.algorithm import get_display as shim_get_display
        logical = shim_get_display("IPC-610 مالس")
        assert "سلام" in logical and "IPC-610" in logical
    finally:
        if saved_bidi is not None:
            sys.modules["bidi"] = saved_bidi
        else:
            sys.modules.pop("bidi", None)
        if saved_bidi_alg is not None:
            sys.modules["bidi.algorithm"] = saved_bidi_alg
        else:
            sys.modules.pop("bidi.algorithm", None)

    # 2) RapidEngine ("fas") cleans truncated <10KB .onnx files and falls back to mirrors when modelscope fails
    ocr_mod._STANDARD_CANCEL_EVENT.clear()
    rapid = ocr_mod.RapidEngine("rapidocr-v5", "v5")
    monkeypatch.setattr(rapid, "_ensure_runtime", lambda: None)
    monkeypatch.setattr(ocr_mod.RapidEngine, "runtime_installed", property(lambda self: True))
    model_dir = rapid._model_dir()
    model_dir.mkdir(parents=True, exist_ok=True)
    # Write a truncated 128-byte partial file that must be purged
    (model_dir / "arabic_PP-OCRv5_rec_mobile.onnx").write_bytes(b"truncated")

    create_calls = {"n": 0}

    class DownloadFileException(Exception):
        pass

    def _fake_create(lang: str):
        create_calls["n"] += 1
        if create_calls["n"] == 1:
            raise DownloadFileException("Failed to download from modelscope.cn")
        assert (model_dir / "ch_PP-OCRv5_det_mobile.onnx").stat().st_size >= 10_000
        assert (model_dir / "arabic_PP-OCRv5_rec_mobile.onnx").stat().st_size >= 10_000
        return object()

    class FakeMirrorResp:
        headers = {"Content-Length": "16384"}
        def __init__(self):
            self._buf = io.BytesIO(b"M" * 16384)
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self, sz=-1):
            return self._buf.read(sz)

    mirror_urls: list[str] = []

    def _fake_urlopen(req, timeout=180):
        mirror_urls.append(req.full_url)
        return FakeMirrorResp()

    monkeypatch.setattr(rapid, "_create", _fake_create)
    monkeypatch.setattr("comic_studio.ocr.urllib.request.urlopen", _fake_urlopen)
    inst = rapid._get("fas", allow_download=True)
    assert inst is not None
    assert create_calls["n"] == 2
    assert any("huggingface.co/RapidAI/RapidOCR" in u and "arabic_PP-OCRv5_rec_mobile.onnx" in u for u in mirror_urls)

    # 3) _HezarOcrAdapter._local_or_hub rejects partial .cache-only directories lacking model_config.yaml,
    #    and _is_hf_network_or_hub_error catches HfHubHTTPError / OSError to trigger hf-mirror.com
    hezar_adapter = ocr_worker._HezarOcrAdapter(tmp_path)
    partial_dir = tmp_path / "hf-repos" / "hezarai__crnn-base-fa-v2" / ".cache"
    partial_dir.mkdir(parents=True, exist_ok=True)
    (partial_dir / "partial.lock").write_text("x", encoding="utf-8")
    assert hezar_adapter._local_or_hub("hezarai/crnn-base-fa-v2") == "hezarai/crnn-base-fa-v2"
    (tmp_path / "hf-repos" / "hezarai__crnn-base-fa-v2" / "model_config.yaml").write_text("name: crnn\n", encoding="utf-8")
    assert hezar_adapter._local_or_hub("hezarai/crnn-base-fa-v2").endswith("hezarai__crnn-base-fa-v2")

    class HfHubHTTPError(Exception):
        pass

    assert ocr_worker._is_hf_network_or_hub_error(HfHubHTTPError("504 Gateway Timeout")) is True
    assert ocr_worker._is_hf_network_or_hub_error(OSError("Network is unreachable")) is True
    assert ocr_worker._is_hf_network_or_hub_error(ValueError("Unrelated invalid argument")) is False


def test_v397_idle_cpu_passive_threads_hardware_cache_and_worker_idle_reaper(tmp_path, monkeypatch):
    import io
    import time
    from comic_studio import ocr_managed, ocr_worker
    from comic_studio.ocr import TesseractEngine, analyze_blocks_typography

    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    monkeypatch.delenv("COMIC_STUDIO_FAKE_HARDWARE_JSON", raising=False)

    # 1) Passive OpenMP / MKL wait policy is configured in main process, worker env, and worker init
    ocr_managed.configure_native_runtime()
    assert os.environ.get("OMP_WAIT_POLICY") == "PASSIVE"
    assert os.environ.get("KMP_BLOCKTIME") == "0"
    iso = ocr_managed.IsolatedOcrEngine(
        engine_id="surya",
        languages=["eng", "fas"],
        install_lock=threading.Lock(),
        line_factory=OcrLine,
        error_cls=OcrError,
    )
    w_env = iso._worker_env()
    assert w_env["OMP_WAIT_POLICY"] == "PASSIVE"
    assert w_env["KMP_BLOCKTIME"] == "0"

    # 2) inspect_hardware caches static GPU/RAM discovery across >60s without re-probing subprocesses
    gpu_probes = {"n": 0}
    monkeypatch.setattr(ocr_managed, "_HW_CACHE", None)
    monkeypatch.setattr(ocr_managed, "_DISK_FREE_CACHE", None)

    def _fake_nvidia():
        gpu_probes["n"] += 1
        return True, "RTX Test", 8.0

    monkeypatch.setattr(ocr_managed, "_detect_nvidia_gpu", _fake_nvidia)
    hw1 = ocr_managed.inspect_hardware()
    ocr_managed._HW_CACHE = (ocr_managed._HW_CACHE[0] - 3600.0, ocr_managed._HW_CACHE[1])
    hw2 = ocr_managed.inspect_hardware()
    assert hw1["gpuName"] == "RTX Test" and hw2["gpuName"] == "RTX Test"
    assert gpu_probes["n"] == 1

    # 3) TesseractEngine.unload() keeps cached _system_languages so status() never respawns --list-langs
    tess = TesseractEngine()
    list_calls = {"n": 0}
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/mock/tesseract")

    def _fake_list_langs(cmd, **kwargs):
        list_calls["n"] += 1
        return subprocess.CompletedProcess(cmd, 0, "List of available languages (2):\neng\nfas\n", "")

    monkeypatch.setattr(subprocess, "run", _fake_list_langs)
    assert "fas" in tess.ready_languages
    assert list_calls["n"] == 1
    tess.unload()
    assert "fas" in tess.ready_languages
    assert list_calls["n"] == 1

    # 4) IsolatedOcrEngine idle reaper automatically terminates an idle worker process
    class _DummyWorker:
        def __init__(self):
            self.pid = 999991
            self.stdin = io.StringIO()
            self.stdout = io.StringIO()
            self.stderr = io.StringIO()
            self._exited = False
        def poll(self):
            return 0 if self._exited else None
        def wait(self, timeout=None):
            self._exited = True
            return 0
        def kill(self):
            self._exited = True

    dummy = _DummyWorker()
    iso._worker_proc = dummy  # type: ignore[assignment]
    iso._idle_timeout_sec = 0.04
    iso._arm_idle_timer()
    time.sleep(0.12)
    assert iso._worker_proc is None
    assert dummy._exited is True

    # 5) Vectorized analyze_blocks_typography runs cleanly and preserves upright non-italic detection
    canvas = Image.new("RGB", (220, 70), "white")
    from PIL import ImageDraw
    draw = ImageDraw.Draw(canvas)
    draw.text((20, 20), "NORMAL TEXT", fill="black")
    blocks = [{"id": 1, "text": "NORMAL TEXT", "x0": 16, "y0": 16, "x1": 150, "y1": 45}]
    analyze_blocks_typography(canvas, blocks, page_mode="document")
    assert blocks[0].get("italic") is not True


def test_v398_uninstall_isolated_and_standard_engines_frees_disk_and_resets_status(monkeypatch, tmp_path):
    from comic_studio import ocr_managed
    from comic_studio.ocr import EngineRegistry, OcrError

    models_root = tmp_path / "models"
    monkeypatch.setattr("comic_studio.ocr.models_dir", lambda: models_root)
    monkeypatch.setattr("comic_studio.ocr_managed.models_dir", lambda: models_root)

    reg = EngineRegistry()

    # 1) Built-in base engine rapidocr-v6 has canUninstall=False and rejects uninstall
    st0 = {e["id"]: e for e in reg.status()}
    assert st0["rapidocr-v6"]["isBuiltinBase"] is True
    assert st0["rapidocr-v6"]["canUninstall"] is False
    assert st0["glm-ocr"]["canUninstall"] is False
    with pytest.raises(OcrError):
        reg.uninstall("rapidocr-v6")

    # 2) Simulate installed isolated engine (glm-ocr) with venv, state marker, HF repo, and manifest
    glm_env = models_root / "envs" / "glm-ocr"
    glm_py = glm_env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    glm_py.parent.mkdir(parents=True, exist_ok=True)
    glm_py.write_bytes(b"PY" * 512)
    (glm_env / ".runtime-ready").write_text("ok", encoding="utf-8")
    glm_state = models_root / "isolated" / "glm-ocr"
    glm_state.mkdir(parents=True, exist_ok=True)
    (glm_state / ".ready-all").write_text("ok", encoding="utf-8")
    glm_hf = models_root / "hf-repos" / "zai_org__GLM_OCR"
    glm_hf.mkdir(parents=True, exist_ok=True)
    (glm_hf / "model.safetensors").write_bytes(b"W" * (256 * 1024))
    ocr_managed.update_manifest_entry("glm-ocr", installedVersion="0.1.2")

    st1 = {e["id"]: e for e in reg.status()}
    assert st1["glm-ocr"]["runtimeInstalled"] is True
    assert st1["glm-ocr"]["modelReady"] is True
    assert st1["glm-ocr"]["canUninstall"] is True

    res_glm = reg.uninstall("glm-ocr")
    assert res_glm["freedBytes"] >= 256 * 1024
    assert not glm_env.exists()
    assert not glm_state.exists()
    assert not glm_hf.exists()
    assert "glm-ocr" not in ocr_managed.read_manifest()

    st2 = {e["id"]: e for e in reg.status()}
    assert st2["glm-ocr"]["runtimeInstalled"] is False
    assert st2["glm-ocr"]["modelReady"] is False
    assert st2["glm-ocr"]["canUninstall"] is False

    # 3) Simulate rapidocr-v5 and tesseract downloaded packs and uninstall both cleanly
    v5_dir = models_root / "rapidocr"
    v5_dir.mkdir(parents=True, exist_ok=True)
    (v5_dir / "ch_PP-OCRv5_det_mobile.onnx").write_bytes(b"D" * 32_768)
    (v5_dir / "latin_PP-OCRv5_rec_mobile.onnx").write_bytes(b"R" * 32_768)
    tess_dir = models_root / "tesseract"
    tess_dir.mkdir(parents=True, exist_ok=True)
    (tess_dir / "fas.traineddata").write_bytes(b"T" * 16_384)

    st3 = {e["id"]: e for e in reg.status()}
    assert st3["rapidocr-v5"]["canUninstall"] is True
    assert st3["tesseract"]["canUninstall"] is True

    res_v5 = reg.uninstall("rapidocr-v5")
    res_tess = reg.uninstall("tesseract")
    assert res_v5["freedBytes"] >= 65_536
    assert res_tess["freedBytes"] >= 16_384
    assert not v5_dir.exists()
    assert not tess_dir.exists()

    st4 = {e["id"]: e for e in reg.status()}
    assert st4["rapidocr-v5"]["canUninstall"] is False
    assert st4["tesseract"]["canUninstall"] is False


def test_v399_worker_memory_trim_and_onnx_session_options():
    import os
    import tempfile
    from pathlib import Path
    import comic_studio.ocr_managed as managed
    import comic_studio.ocr_worker as worker_mod

    # 1. Both trim_process_memory and _release_worker_caches execute cleanly and configure Paddle eager deletion
    managed.trim_process_memory()
    worker_mod._release_worker_caches()

    with tempfile.TemporaryDirectory() as td:
        worker_mod._configure_cache_dirs(Path(td))
    assert os.environ.get("FLAGS_eager_delete_tensor_gb") == "0.0"
    assert os.environ.get("FLAGS_fast_eager_deletion_mode") == "1"

    # 2. RapidEngine._create disables both ONNX CPU arena and variable-shape mem_pattern caching
    from comic_studio.ocr import RapidEngine
    eng = RapidEngine("rapidocr-v6", "v6")
    try:
        inst = eng._get("eng", allow_download=False)
        from rapidocr.inference_engine.onnxruntime.main import OrtInferSession
        assert getattr(OrtInferSession._init_sess_opts, "_comic_no_spin", False) is True
        _ = inst
    finally:
        eng.unload()


def test_v421_persian_preprocess_normalization_containers_and_engines(tmp_path, monkeypatch):
    import cv2
    from PIL import ImageDraw
    import comic_studio.ocr as ocr_mod
    import comic_studio.ocr_worker as worker_mod
    from comic_studio.ocr_grouping import organize_ocr_blocks

    # 1. Persian text normalization: strips bidi marks, converts Arabic ي/ى/ك & Presentation Forms, preserves ZWNJ
    dirty = "\u200f\ufb58\u064a\u0634\u200c\u067e\u0631\u062f\u0627\u0632\u0634 \u0643\u0645\u064a\u0643, \u0639\u0627\u0644\u0649\u200e"
    cleaned = ocr_mod.normalize_persian_ocr_text(dirty)
    assert cleaned == "پیش\u200cپردازش کمیک، عالی"
    assert "\u200c" in cleaned and "\u200f" not in cleaned and "\u200e" not in cleaned

    # 2. persian_preprocess_image: auto-inverts dark caption boxes, flattens heavy scan shadows, adds white quiet-zone,
    #    and upscales tall narrow webtoon strips (>4MP total pixels) based on width!
    dark_box = Image.new("RGB", (260, 90), (24, 26, 34))
    dr = ImageDraw.Draw(dark_box)
    dr.rectangle((60, 32, 200, 56), fill=(242, 242, 246))
    prep_dark, sc_dark, pad_dark = ocr_mod.persian_preprocess_image(dark_box, precise=True, page_mode="comic")
    try:
        arr_dark = np.asarray(prep_dark)
        assert sc_dark == 2.0
        assert pad_dark == ocr_mod.PERSIAN_PREPROCESS_BORDER_PAD
        assert prep_dark.size == (260 * 2 + pad_dark * 2, 90 * 2 + pad_dark * 2)
        # Border and inverted background are white, while inverted ink center is dark
        assert np.all(arr_dark[:pad_dark, :, 0] == 255)
        assert float(arr_dark[pad_dark + 5, pad_dark + 5, 0]) > 220.0
        assert float(arr_dark[pad_dark + 88, pad_dark + 260, 0]) < 45.0
    finally:
        prep_dark.close()

    # Shadowed book scan (left side dark 75, right side bright 235) -> flattened paper >= 235 everywhere
    yy, xx = np.mgrid[0:180, 0:320]
    shaded = np.clip(75.0 + 160.0 * (xx / 320.0), 0, 255).astype(np.uint8)
    shaded[70:86, 40:280] = np.maximum(15, (shaded[70:86, 40:280] * 0.32).astype(np.uint8))
    prep_shade, sc_shade, pad_shade = ocr_mod.persian_preprocess_image(
        Image.fromarray(shaded, mode="L").convert("RGB"), precise=True, page_mode="document",
    )
    try:
        arr_shade = np.asarray(prep_shade)[pad_shade:-pad_shade, pad_shade:-pad_shade, 0]
        assert sc_shade == 2.0
        # Shadowed top-left paper corner is flattened to white (>= 240), while ink bar remains dark
        assert float(np.median(arr_shade[10:40, 10:60])) >= 240.0
        assert float(np.min(arr_shade[135:175, 100:500])) < 60.0
    finally:
        prep_shade.close()

    # Coordinate restoration through recognize_image(..., persian_preprocess=True) un-pads & un-scales accurately
    class CoordEchoEngine:
        def recognize(self, img: Image.Image, lang: str):
            # Simulate a line at native (20..120, 15..45) -> scaled by 2.0 + 18px border pad = (58..258, 48..108)
            p = ocr_mod.PERSIAN_PREPROCESS_BORDER_PAD
            return [ocr_mod.OcrLine("متن\u200f \u0643\u062a\u0627\u0628", 0.92, [[20 * 2 + p, 15 * 2 + p], [120 * 2 + p, 15 * 2 + p], [120 * 2 + p, 45 * 2 + p], [20 * 2 + p, 45 * 2 + p]])]

    restored_blocks = ocr_mod.recognize_image(
        CoordEchoEngine(), Image.new("RGB", (180, 90), "white"), "fas",
        contrast=True, precise=True, persian_preprocess=True,
    )
    assert len(restored_blocks) == 1
    assert restored_blocks[0]["text"] == "متن کتاب"
    assert restored_blocks[0]["x0"] == pytest.approx(20.0)
    assert restored_blocks[0]["y0"] == pytest.approx(15.0)
    assert restored_blocks[0]["x1"] == pytest.approx(120.0)
    assert restored_blocks[0]["y1"] == pytest.approx(45.0)

    # 3. Multi-container Persian comic extraction detects BOTH colored AND dark speech bubbles and merges them
    comic_arr = np.full((360, 480, 3), 90, dtype=np.uint8)
    cv2.rectangle(comic_arr, (30, 30), (220, 150), (180, 210, 240), thickness=-1)
    cv2.rectangle(comic_arr, (30, 30), (220, 150), (20, 30, 45), thickness=3)
    cv2.rectangle(comic_arr, (65, 72), (185, 92), (30, 40, 70), thickness=-1)
    cv2.rectangle(comic_arr, (260, 190), (450, 310), (26, 28, 38), thickness=-1)
    cv2.rectangle(comic_arr, (260, 190), (450, 310), (238, 238, 245), thickness=3)
    cv2.rectangle(comic_arr, (295, 235), (415, 255), (240, 240, 248), thickness=-1)
    containers = ocr_mod._persian_container_regions(Image.fromarray(comic_arr))
    assert len(containers) == 2
    for c_im, *_ in containers:
        c_im.close()

    # 4. Tesseract Persian uses --psm 6/3 + --oem 1 + preserve_interword_spaces=1 and RTL word order (while English keeps --psm 11)
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path))
    monkeypatch.setattr("comic_studio.ocr._tesseract_executable", lambda: "/usr/bin/tesseract")
    monkeypatch.setattr(ocr_mod.TesseractEngine, "ready_languages", property(lambda self: ["eng", "fas"]))
    tess_cmds: list[list[str]] = []

    def fake_tess_run(cmd, **kw):
        tess_cmds.append(cmd)
        tsv = (
            "level\tpage_num\tblock_num\tpar_num\tline_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t30\t10\t40\t18\t91\t\u062f\u0646\u064a\u0627\n"
            "5\t1\t1\t1\t1\t90\t10\t40\t18\t93\t\u0633\u0644\u0627\u0645\n"
        )
        return subprocess.CompletedProcess(cmd, 0, tsv.encode("utf-8"), b"")

    monkeypatch.setattr(subprocess, "run", fake_tess_run)
    tess_eng = ocr_mod.TesseractEngine()
    fa_lines = tess_eng.recognize(Image.new("RGB", (200, 80), "white"), "fas")
    en_lines = tess_eng.recognize(Image.new("RGB", (200, 80), "white"), "eng")
    assert tess_cmds[0][tess_cmds[0].index("--psm") + 1] == "6"
    assert "preserve_interword_spaces=1" in tess_cmds[0]
    assert tess_cmds[1][tess_cmds[1].index("--psm") + 1] == "11"
    assert fa_lines[0].text == "سلام دنیا"
    assert en_lines[0].text == "دنيا سلام"

    # 5. Hezar >2560px CraftImageProcessor bug workaround + RTL same-row word-box merging
    hz = worker_mod._HezarOcrAdapter(tmp_path / "hz")
    seen_det_sizes: list[tuple[int, int]] = []

    class FakeCraftLarge:
        def predict(self, img):
            seen_det_sizes.append(img.size)
            # Two word boxes on the same row in LTR order -> must merge RTL ("سلام خوبی؟") and rescale 2x back to 3200px!
            return [{"boxes": [(50, 40, 80, 28), (150, 42, 90, 28)]}]

    class FakeCrnnWords:
        def predict(self, crops):
            return [{"text": "خوبی؟"}, {"text": "سلام"}]

    monkeypatch.setattr(hz, "_ensure_loaded", lambda force_cpu=False: (FakeCraftLarge(), FakeCrnnWords()))
    tall_img = tmp_path / "tall_fa.png"
    Image.new("RGB", (1600, 5120), "white").save(tall_img)
    hz_lines = hz.recognize(str(tall_img), "fas", None)
    assert seen_det_sizes == [(800, 2560)]
    assert len(hz_lines) == 1
    assert hz_lines[0]["text"] == "سلام خوبی؟"
    assert hz_lines[0]["polygon"] == [[100.0, 80.0], [480.0, 80.0], [480.0, 140.0], [100.0, 140.0]]

    # 6. RTL comic bubble ordering orders right bubble before left bubble on the same horizontal band
    rtl_bubbles = [
        {"id": 1, "text": "حباب چپ", "conf": 92, "x0": 40, "y0": 52, "x1": 180, "y1": 90, "lineH": 38},
        {"id": 2, "text": "حباب راست", "conf": 94, "x0": 320, "y0": 50, "x1": 470, "y1": 88, "lineH": 38},
    ]
    ordered_comic, c_mode = organize_ocr_blocks(rtl_bubbles, page_mode="comic", group_lines=True, page_size=(520, 400))
    assert c_mode == "comic"
    assert [b["text"] for b in ordered_comic] == ["حباب راست", "حباب چپ"]




















