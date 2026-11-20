"""Opt-in, measured memory tests; no downloads or fake OCR inference.

COMIC_STUDIO_REAL_OCR_MEMORY=1 python -m pytest tests/test_real_ocr_memory.py -s
Optional COMIC_STUDIO_MEMORY_REPORT_DIR writes the small JSON measurements.
Requires local PP-OCRv6 weights and psutil in the test environment.
"""
from __future__ import annotations

import gc
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import threading
import time

import pytest
from PIL import Image, ImageDraw, ImageFont

pytestmark = [
    pytest.mark.real_ocr,
    pytest.mark.skipif(os.environ.get("COMIC_STUDIO_REAL_OCR_MEMORY") != "1",
                       reason="explicit opt-in required for real-model memory measurements"),
]


def _report(name, data):
    print(name + ": " + json.dumps(data))
    directory = os.environ.get("COMIC_STUDIO_MEMORY_REPORT_DIR")
    if directory:
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        (root / (name + ".json")).write_text(json.dumps(data, indent=2), encoding="utf-8")


def test_real_ppocr_36_pages_reaches_a_memory_plateau():
    psutil = pytest.importorskip("psutil")
    from comic_studio.ocr import RapidEngine, recognize_image

    engine = RapidEngine("rapidocr-v6", "v6")
    if not engine.runtime_installed or not engine.model_ready:
        pytest.skip("the test never downloads missing PP-OCRv6 weights")
    engine._force_cpu = True  # CPU baseline; this does NOT validate Windows/DirectML.
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 26)
    except OSError:
        font = ImageFont.load_default(size=26)
    process = psutil.Process()
    rows = []
    samples = []
    stop = threading.Event()

    def sample():
        while not stop.wait(0.02):
            samples.append(process.memory_info().rss)

    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    try:
        for index in range(36):
            width, height = [(1000, 1400), (1400, 1800), (1800, 2600)][index % 3]
            started = time.monotonic()
            with Image.new("RGB", (width, height), "white") as image:
                draw = ImageDraw.Draw(image)
                for y in range(40, height - 40, 110):
                    draw.text((35, y), f"OCR memory page {index}: Hello world.", font=font, fill="black")
                # Exercise the real preprocessing, slicing, engine adapter and
                # typography pass; no mocks and no model unload between pages.
                blocks = recognize_image(engine, image, "eng", contrast=True, precise=False)
                assert blocks and any("memory" in block["text"].lower() for block in blocks)
            del blocks, draw, image
            gc.collect()
            rows.append({"page": index + 1, "rss_mb": round(process.memory_info().rss / 2**20, 1),
                         "threads": process.num_threads(), "seconds": round(time.monotonic() - started, 2)})
        warm = statistics.median(row["rss_mb"] for row in rows[6:12])
        late = statistics.median(row["rss_mb"] for row in rows[-6:])
        _report("real-ppocr-36-pages", {"platform": platform.platform(), "provider": "CPUExecutionProvider",
                 "pages": rows, "peak_rss_mb": round(max(samples) / 2**20, 1),
                 "warm_median_mb": warm, "late_median_mb": late,
                 "note": "Synthetic English pages on CPU; not a reproduction of the user's Windows crash."})
        # Leave headroom for platform allocator variance; reject page-count-sized
        # retention, not harmless high-water allocator caching.
        assert late - warm < max(128, warm * 0.25)
    finally:
        stop.set()
        sampler.join(timeout=2)
        engine.unload()


_PEAK_WORKER = r'''
import gc, hashlib, json, sys, threading
import cv2, numpy as np, psutil
from PIL import Image, ImageOps
from comic_studio.ocr import _extra_preprocess_image

def reference(image):
    rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
    enlarged = cv2.resize(rgb, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_RGB2GRAY)
    _, bright = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
    inverted = cv2.bitwise_not(bright)
    return Image.fromarray(inverted).convert("RGB")

rng = np.random.default_rng(27)
arr = rng.integers(0, 256, (1800, 2400, 3), dtype=np.uint8)
image = Image.fromarray(arr)
del arr
gc.collect()
p = psutil.Process()
baseline = p.memory_info().rss
samples = [baseline]
stop = threading.Event()
def sample():
    while not stop.wait(.005): samples.append(p.memory_info().rss)
thread = threading.Thread(target=sample)
thread.start()
result = (reference if sys.argv[1] == "reference" else _extra_preprocess_image)(image)
samples.append(p.memory_info().rss)
stop.set()
thread.join()
print(json.dumps({"baseline_mb": baseline / 2**20, "peak_mb": max(samples) / 2**20,
                  "extra_peak_mb": (max(samples) - baseline) / 2**20,
                  "sha256": hashlib.sha256(result.tobytes()).hexdigest()}))
result.close()
image.close()
'''


def test_fallback_peak_is_lower_with_identical_pixels_in_fresh_processes():
    pytest.importorskip("psutil")
    results = {}
    for variant in ("reference", "fixed"):
        completed = subprocess.run([sys.executable, "-c", _PEAK_WORKER, variant],
                                   capture_output=True, text=True, check=True, timeout=120)
        results[variant] = json.loads(completed.stdout.splitlines()[-1])
    _report("fallback-peak", results)
    assert results["reference"]["sha256"] == results["fixed"]["sha256"]
    assert results["fixed"]["extra_peak_mb"] < results["reference"]["extra_peak_mb"] * 0.85
