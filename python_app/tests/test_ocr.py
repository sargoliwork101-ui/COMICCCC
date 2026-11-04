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
    assert len(ENGINE_INFO) == 13
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









