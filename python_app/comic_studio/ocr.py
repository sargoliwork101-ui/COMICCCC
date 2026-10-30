from __future__ import annotations

import importlib.util
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from .paths import models_dir

LANGUAGES = {
    "eng": {"name": "English", "source": "en"},
    "kor": {"name": "한국어", "source": "ko"},
    "jpn": {"name": "日本語", "source": "ja"},
    "chi_sim": {"name": "中文", "source": "zh-CN"},
}


@dataclass
class OcrLine:
    text: str
    confidence: float
    polygon: list[list[float]]

    @property
    def box(self) -> list[float]:
        xs = [point[0] for point in self.polygon]
        ys = [point[1] for point in self.polygon]
        return [min(xs), min(ys), max(xs), max(ys)]


class OcrError(RuntimeError):
    pass


def install_packages(packages: list[str]) -> None:
    """Install a whitelisted runtime only after an explicit user preparation click."""
    if not packages:
        return
    command = [sys.executable, "-m", "pip", "install", *packages]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=3600, check=False)
    except Exception as exc:
        raise OcrError(f"Could not install the OCR runtime: {exc}") from exc
    if result.returncode:
        details = (result.stderr or result.stdout or "pip failed")[-1800:].strip()
        raise OcrError(f"OCR runtime installation failed: {details}")
    importlib.invalidate_caches()


def _lines_from_rapid(result: Any) -> list[OcrLine]:
    """Accept both RapidOCR's modern output object and its legacy tuple."""
    payload = result[0] if isinstance(result, tuple) else result
    boxes = getattr(payload, "boxes", None)
    texts = getattr(payload, "txts", None)
    scores = getattr(payload, "scores", None)
    if boxes is None and isinstance(payload, list):
        lines = []
        for entry in payload:
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            lines.append(OcrLine(str(entry[1]).strip(), float(entry[2] if len(entry) > 2 else 0), _polygon(entry[0])))
        return [line for line in lines if line.text]
    if boxes is None or texts is None:
        return []
    lines = []
    for index, text in enumerate(texts):
        value = str(text).strip()
        if not value:
            continue
        score = float(scores[index]) if scores is not None and index < len(scores) else 0.0
        lines.append(OcrLine(value, score, _polygon(boxes[index])))
    return lines


def _polygon(box: Any) -> list[list[float]]:
    values = np.asarray(box, dtype=float).reshape(-1, 2)
    return [[float(point[0]), float(point[1])] for point in values]


class RapidEngine:
    def __init__(self, engine_id: str, version: str) -> None:
        self.id = engine_id
        self.version = version
        self._instances: dict[str, Any] = {}
        self._lock = threading.Lock()

    @property
    def runtime_installed(self) -> bool:
        return bool(importlib.util.find_spec("rapidocr")) and bool(importlib.util.find_spec("onnxruntime"))

    @property
    def ready_languages(self) -> list[str]:
        if not self.runtime_installed:
            return []
        try:
            if self.version == "v6":
                root = self._v6_model_dir()
                ready = all((root / name).is_file() for name in self._expected_models("eng"))
                return ["eng", "jpn", "chi_sim"] if ready else []
            return [
                language for language in LANGUAGES
                if all((self._model_dir() / name).is_file() for name in self._expected_models(language))
            ]
        except Exception:
            return []

    @property
    def model_ready(self) -> bool:
        return bool(self.ready_languages)

    def _language_names(self, language: str) -> tuple[str, str]:
        if self.version == "v6":
            name = {"eng": "en", "jpn": "japan", "chi_sim": "ch"}.get(language, "en")
            return name, name
        return "ch", {"kor": "korean", "eng": "latin", "jpn": "ch", "chi_sim": "ch"}.get(language, "ch")

    def _model_dir(self) -> Path:
        return models_dir() / "rapidocr"

    def _v6_model_dir(self) -> Path:
        import rapidocr
        return Path(rapidocr.__file__).parent / "models"

    def _expected_models(self, language: str) -> list[str]:
        if self.version == "v6":
            return ["PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx"]
        _, rec = self._language_names(language)
        return ["ch_PP-OCRv5_det_mobile.onnx", f"{rec}_PP-OCRv5_rec_mobile.onnx"]

    def _create(self, language: str):
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import EngineType, ModelType, OCRVersion

        det_lang, rec_lang = self._language_names(language)
        if self.version == "v6":
            det_version = rec_version = OCRVersion.PPOCRV6
            det_type = rec_type = ModelType.SMALL
        else:
            det_version = rec_version = OCRVersion.PPOCRV5
            det_type = rec_type = ModelType.MOBILE
        params = {
            "Det.ocr_version": det_version, "Rec.ocr_version": rec_version,
            "Det.model_type": det_type, "Rec.model_type": rec_type,
            "Det.lang_type": det_lang, "Rec.lang_type": rec_lang,
            "Det.engine_type": EngineType.ONNXRUNTIME, "Rec.engine_type": EngineType.ONNXRUNTIME,
        }
        if self.version == "v5":
            # Keep user-downloaded models outside the virtual environment.
            params["Global.model_root_dir"] = str(self._model_dir())
        return RapidOCR(params=params)

    def _ensure_runtime(self) -> None:
        if not self.runtime_installed:
            install_packages(["rapidocr>=3.10,<3.11", "onnxruntime>=1.20,<2"])
        if not self.runtime_installed:
            raise OcrError("RapidOCR was installed but cannot be imported. Restart the application and try again.")

    def _get(self, language: str, allow_download: bool = False):
        if not self.runtime_installed:
            raise OcrError("RapidOCR is not installed. Click the explicit preparation button to install it.")
        if not allow_download:
            root = self._model_dir() if self.version == "v5" else self._v6_model_dir()
            missing = [name for name in self._expected_models(language) if not (root / name).is_file()]
            if missing:
                raise OcrError(f"{self.id} model is not ready. Use the explicit model download button first.")
        with self._lock:
            if language not in self._instances:
                try:
                    self._instances[language] = self._create(language)
                except Exception as exc:
                    raise OcrError(f"Could not initialize {self.id}: {exc}") from exc
        return self._instances[language]

    @staticmethod
    def _warm(engine: Any) -> None:
        # RapidOCR loads its ONNX sessions lazily; this explicit warm-up is used only by download().
        sample = Image.new("RGB", (240, 80), "white")
        from PIL import ImageDraw, ImageFont
        ImageDraw.Draw(sample).text((8, 15), "TEST", fill="black", font=ImageFont.load_default(size=32))
        engine(np.asarray(sample), use_cls=False)

    def download(self, language: str = "eng") -> None:
        self._ensure_runtime()
        languages = [language] if self.version == "v5" else ["eng"]
        for selected in languages:
            try:
                self._warm(self._get(selected, allow_download=True))
            except OcrError:
                raise
            except Exception as exc:
                cause = f"; cause: {exc.__cause__}" if exc.__cause__ else ""
                raise OcrError(
                    f"Model download failed for {self.id} ({selected}): {exc}{cause}. "
                    "Check the internet connection and model host access, then try again."
                ) from exc

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        engine = self._get(language)
        try:
            result = engine(np.asarray(image), use_cls=False)
        except TypeError:
            result = engine(np.asarray(image))
        except Exception as exc:
            raise OcrError(f"OCR failed: {exc}") from exc
        return _lines_from_rapid(result)


class EasyEngine:
    id = "easyocr"

    def __init__(self) -> None:
        self._readers: dict[str, Any] = {}
        self._lock = threading.Lock()

    @property
    def runtime_installed(self) -> bool:
        return bool(importlib.util.find_spec("easyocr"))

    def _model_dir(self) -> Path:
        return models_dir() / "easyocr"

    def _expected_models(self, language: str) -> list[str]:
        recognition = {"eng": "english_g2.pth", "kor": "korean_g2.pth", "jpn": "japanese_g2.pth", "chi_sim": "zh_sim_g2.pth"}
        return ["craft_mlt_25k.pth", recognition.get(language, "english_g2.pth")]

    @property
    def ready_languages(self) -> list[str]:
        if not self.runtime_installed:
            return []
        return [
            language for language in LANGUAGES
            if all((self._model_dir() / name).is_file() for name in self._expected_models(language))
            or (self._model_dir() / f".ready-{language}").is_file()
        ]

    @property
    def model_ready(self) -> bool:
        return bool(self.ready_languages)

    def _ensure_runtime(self) -> None:
        if not self.runtime_installed:
            install_packages(["easyocr>=1.7,<2", "torch>=2.2,<3"])
        if not self.runtime_installed:
            raise OcrError("EasyOCR was installed but cannot be imported. Restart the application and try again.")

    def _reader(self, language: str, download: bool):
        if not self.runtime_installed:
            raise OcrError("EasyOCR is not installed. Click the explicit preparation button to install it.")
        if not download:
            missing = [name for name in self._expected_models(language) if not (self._model_dir() / name).is_file()]
            if missing and not (self._model_dir() / f".ready-{language}").is_file():
                raise OcrError("EasyOCR model for this language is not ready. Click the explicit preparation button first.")
        lang = {"eng": "en", "kor": "ko", "jpn": "ja", "chi_sim": "ch_sim"}.get(language, "en")
        with self._lock:
            if lang not in self._readers:
                import easyocr
                try:
                    self._readers[lang] = easyocr.Reader(
                        [lang], gpu=False, model_storage_directory=str(self._model_dir()),
                        download_enabled=download, verbose=False,
                    )
                except Exception as exc:
                    raise OcrError(f"Could not initialize EasyOCR: {exc}") from exc
        return self._readers[lang]

    def download(self, language: str = "eng") -> None:
        self._ensure_runtime()
        try:
            self._reader(language, True)
            self._model_dir().mkdir(parents=True, exist_ok=True)
            (self._model_dir() / f".ready-{language}").write_text("downloaded by user request\n", encoding="utf-8")
        except OcrError:
            raise
        except Exception as exc:
            raise OcrError(f"EasyOCR model download failed for {language}: {exc}") from exc

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        reader = self._reader(language, False)
        try:
            result = reader.readtext(np.asarray(image), detail=1, paragraph=False)
        except Exception as exc:
            raise OcrError(f"EasyOCR failed: {exc}") from exc
        lines = []
        for box, text, score in result:
            if str(text).strip():
                lines.append(OcrLine(str(text).strip(), float(score), _polygon(box)))
        return lines


ENGINE_INFO = {
    "rapidocr-v6": {
        "name": "PP-OCRv6 Small",
        "family": "RapidOCR / ONNX",
        "description": "مدل جدید و سبک برای متن عمومی؛ مناسب انگلیسی، چینی و ژاپنی.",
        "languages": ["eng", "jpn", "chi_sim"],
        "install": "python -m pip install -e \".[ocr]\"",
    },
    "rapidocr-v5": {
        "name": "PP-OCRv5 Multilingual",
        "family": "RapidOCR / ONNX",
        "description": "بستهٔ چندزبانه با مدل اختصاصی کره‌ای و پشتیبانی از زبان‌های فعلی برنامه.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "install": "python -m pip install -e \".[ocr]\"",
    },
    "easyocr": {
        "name": "EasyOCR",
        "family": "CRAFT + CRNN / ONNX یا PyTorch",
        "description": "گزینهٔ مستقل و سنگین‌تر برای مقایسهٔ دقت در چهار زبان.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "install": "python -m pip install -e \".[easyocr]\"",
    },
}


class EngineRegistry:
    def __init__(self) -> None:
        self.engines = {
            "rapidocr-v6": RapidEngine("rapidocr-v6", "v6"),
            "rapidocr-v5": RapidEngine("rapidocr-v5", "v5"),
            "easyocr": EasyEngine(),
        }

    def get(self, engine_id: str):
        if engine_id not in self.engines:
            raise OcrError(f"Unknown OCR engine: {engine_id}")
        return self.engines[engine_id]

    def status(self) -> list[dict[str, Any]]:
        result = []
        for engine_id, info in ENGINE_INFO.items():
            engine = self.get(engine_id)
            result.append({
                "id": engine_id, **info,
                "runtimeInstalled": engine.runtime_installed,
                "modelReady": engine.model_ready,
                "readyLanguages": engine.ready_languages,
            })
        return result

    def download(self, engine_id: str, language: str = "eng") -> None:
        self.get(engine_id).download(language)


def preprocess(image: Image.Image, contrast: bool, precise: bool) -> tuple[Image.Image, float]:
    image = ImageOps.exif_transpose(image).convert("RGB")
    if contrast:
        image = ImageOps.autocontrast(image, cutoff=1)
    scale = 1.0
    if precise and image.width * image.height <= 25_000_000:
        scale = 2.0
        image = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
    return image, scale


def recognize_image(
    engine: Any,
    image: Image.Image,
    language: str,
    contrast: bool = True,
    precise: bool = True,
    min_confidence: float = 0.35,
) -> list[dict[str, Any]]:
    """Run OCR in bounded slices and return ordered physical lines with exact geometry."""
    prepared, scale = preprocess(image, contrast, precise)
    width, height = prepared.size
    slice_height = 3000
    overlap = 100
    lines: list[OcrLine] = []
    for start in range(0, height, slice_height):
        end = min(height, start + slice_height)
        read_y0 = max(0, start - overlap)
        read_y1 = min(height, end + overlap)
        crop = prepared.crop((0, read_y0, width, read_y1))
        for line in engine.recognize(crop, language):
            polygon = [[x, y + read_y0] for x, y in line.polygon]
            adjusted = OcrLine(line.text, line.confidence, polygon)
            center_y = (adjusted.box[1] + adjusted.box[3]) / 2
            if center_y < start or center_y >= end:
                continue
            if adjusted.confidence < min_confidence:
                continue
            lines.append(adjusted)
        if end >= height:
            break
    # Reading order is stable: physical row first, then horizontal position. No text is flattened.
    lines.sort(key=lambda line: (round(((line.box[1] + line.box[3]) / 2) / 12) * 12, line.box[0], line.box[1]))
    blocks = []
    for index, line in enumerate(lines, start=1):
        x0, y0, x1, y1 = [value / scale for value in line.box]
        polygon = [[x / scale, y / scale] for x, y in line.polygon]
        line_h = max(8.0, y1 - y0)
        blocks.append({
            "id": index,
            "text": line.text,
            "tr": "",
            "richHtml": "",
            "conf": round(line.confidence * 100, 2),
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "polygon": polygon,
            "lineH": line_h,
            "sourceIndent": min(40, max(0, round(x0 / max(4.0, line_h * 0.45)))),
            "enabled": True,
            "bg": "auto",
            "dir": "rtl",
            "align": "right",
            "bold": True,
            "italic": False,
            "underline": False,
            "size": None,
            "color": None,
        })
    return blocks
