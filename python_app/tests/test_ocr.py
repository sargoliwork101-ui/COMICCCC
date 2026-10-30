from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from comic_studio.ocr import (
    ENGINE_INFO, EasyEngine, OcrError, OcrLine, RapidEngine, TesseractEngine,
    _extra_preprocess_image, _lines_from_rapid, _lines_from_tesseract, install_packages, recognize_image,
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


def test_requested_model_catalog_marks_external_models_honestly():
    expected = {"paddleocr-vl-1-6", "mineru-2-5-pro", "glm-ocr", "deepseek-ocr-2", "got-ocr-2", "dots-ocr", "olmocr", "hunyuan-ocr", "surya"}
    assert expected <= set(ENGINE_INFO)
    assert all(ENGINE_INFO[engine_id]["selectable"] is False for engine_id in expected)
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
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert engine.sizes == [(40, 20)]
    assert blocks[0]["text"] == "GOOD TEXT"


def test_fallback_preprocess_failure_returns_primary(monkeypatch):
    engine = ConditionalFallbackEngine([line("abc", 0.54)], [])
    monkeypatch.setattr("comic_studio.ocr._extra_preprocess_image", lambda image: (_ for _ in ()).throw(RuntimeError("no cv2")))
    blocks = recognize_image(engine, Image.new("RGB", (40, 20), "black"), "eng", contrast=False, precise=False)
    assert blocks[0]["text"] == "abc"
