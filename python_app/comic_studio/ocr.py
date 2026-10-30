from __future__ import annotations

import csv
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from .paths import models_dir

# Optional bright-white-text fallback. The original OCR path always runs first.
EXTRA_PREPROCESS_SCALE = 3
EXTRA_PREPROCESS_THRESHOLD = 200
EXTRA_PREPROCESS_MIN_CONFIDENCE = 0.55
EXTRA_PREPROCESS_MIN_CHARS = 3
EXTRA_PREPROCESS_ENABLED = True

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


def _tesseract_executable() -> str | None:
    executable = shutil.which("tesseract")
    if executable:
        return executable
    if os.name == "nt":
        candidates = [
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Tesseract-OCR" / "tesseract.exe",
            Path(os.environ.get("LocalAppData", str(Path.home() / "AppData" / "Local"))) / "Programs" / "Tesseract-OCR" / "tesseract.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
    return None


def _lines_from_tesseract(payload: str) -> list[OcrLine]:
    """Turn Tesseract TSV words into physical lines and bounding boxes."""
    groups: dict[tuple[str, str, str, str], list[dict[str, str]]] = {}
    reader = csv.DictReader(io.StringIO(payload), delimiter="\t")
    for row in reader:
        if row.get("level") != "5" or not (row.get("text") or "").strip():
            continue
        key = tuple(row.get(key, "") for key in ("page_num", "block_num", "par_num", "line_num"))
        groups.setdefault(key, []).append(row)
    lines = []
    for words in groups.values():
        try:
            boxes = [(float(row["left"]), float(row["top"]), float(row["width"]), float(row["height"])) for row in words]
            x0 = min(box[0] for box in boxes); y0 = min(box[1] for box in boxes)
            x1 = max(box[0] + box[2] for box in boxes); y1 = max(box[1] + box[3] for box in boxes)
            scores = [float(row.get("conf", "-1")) for row in words]
            valid_scores = [score / 100.0 for score in scores if score >= 0]
            confidence = sum(valid_scores) / len(valid_scores) if valid_scores else 0.0
        except (KeyError, TypeError, ValueError):
            continue
        text = " ".join((row.get("text") or "").strip() for row in words).strip()
        if text:
            lines.append(OcrLine(text, confidence, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]))
    return lines


class TesseractEngine:
    id = "tesseract"

    def __init__(self) -> None:
        self._system_languages: set[str] | None = None
        self._lock = threading.Lock()

    @property
    def runtime_installed(self) -> bool:
        return bool(_tesseract_executable())

    def _model_dir(self) -> Path:
        return models_dir() / "tesseract"

    def _expected_models(self, language: str) -> list[str]:
        return [f"{language}.traineddata"]

    def _get_system_languages(self) -> set[str]:
        if self._system_languages is not None:
            return self._system_languages
        executable = _tesseract_executable()
        if not executable:
            return set()
        try:
            result = subprocess.run([executable, "--list-langs"], capture_output=True, text=True, timeout=30, check=False)
            if result.returncode == 0:
                self._system_languages = {line.strip() for line in result.stdout.splitlines()[1:] if line.strip()}
            else:
                self._system_languages = set()
        except Exception:
            self._system_languages = set()
        return self._system_languages

    @property
    def ready_languages(self) -> list[str]:
        if not self.runtime_installed:
            return []
        system = self._get_system_languages()
        return [language for language in LANGUAGES if language in system or all((self._model_dir() / name).is_file() for name in self._expected_models(language))]

    @property
    def model_ready(self) -> bool:
        return bool(self.ready_languages)

    def download(self, language: str = "eng") -> None:
        if not self.runtime_installed:
            raise OcrError("Tesseract executable is not installed. Install it from the official project first; pip alone cannot install the Tesseract binary. https://github.com/tesseract-ocr/tesseract")
        if language not in LANGUAGES:
            raise OcrError(f"Unsupported Tesseract language: {language}")
        self._model_dir().mkdir(parents=True, exist_ok=True)
        url = f"https://github.com/tesseract-ocr/tessdata_fast/raw/main/{language}.traineddata"
        temporary = self._model_dir() / f".{language}.traineddata.part"
        target = self._model_dir() / f"{language}.traineddata"
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Comic-OCR-Studio"})
            with urllib.request.urlopen(request, timeout=180) as response, temporary.open("wb") as output:
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 50 * 1024 * 1024:
                        raise OcrError("The selected Tesseract language file is unexpectedly large.")
                    output.write(chunk)
            if temporary.stat().st_size < 1000:
                raise OcrError("The downloaded Tesseract language file is empty or invalid.")
            os.replace(temporary, target)
        except OcrError:
            temporary.unlink(missing_ok=True)
            raise
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise OcrError(f"Tesseract language download failed for {language}: {exc}. The official tessdata_fast host must be reachable.") from exc

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        executable = _tesseract_executable()
        if not executable:
            raise OcrError("Tesseract is not installed. Install the binary and use the explicit language download button.")
        if language not in self.ready_languages:
            raise OcrError(f"Tesseract language {language} is not ready. Use the explicit model download button first.")
        buffer = io.BytesIO(); image.convert("RGB").save(buffer, "PNG")
        command = [executable, "stdin", "stdout", "-l", language, "--psm", "11"]
        if (self._model_dir() / f"{language}.traineddata").is_file():
            command.extend(["--tessdata-dir", str(self._model_dir())])
        command.append("tsv")
        try:
            result = subprocess.run(command, input=buffer.getvalue(), capture_output=True, timeout=180, check=False)
        except Exception as exc:
            raise OcrError(f"Tesseract failed: {exc}") from exc
        if result.returncode:
            details = (result.stderr or result.stdout or b"Tesseract failed")[-1800:]
            raise OcrError(f"Tesseract failed: {details.decode('utf-8', 'replace') if isinstance(details, bytes) else details}")
        return _lines_from_tesseract(result.stdout.decode("utf-8", "replace") if isinstance(result.stdout, bytes) else result.stdout)


class ManualEngine:
    """Catalog entry for a model whose official pipeline is not a direct line-OCR adapter."""
    def __init__(self, engine_id: str) -> None:
        self.id = engine_id

    @property
    def runtime_installed(self) -> bool:
        return False

    @property
    def ready_languages(self) -> list[str]:
        return []

    @property
    def model_ready(self) -> bool:
        return False

    def download(self, language: str = "eng") -> None:
        raise OcrError("This model needs its official runtime and a separate compatible adapter. Use the official guide linked in the model card; no files were downloaded.")

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        raise OcrError("This model is listed for manual/external setup and is not a direct comic line-OCR engine in this application.")


def _external_info(name: str, family: str, description: str, repository: str, requirements: str, limitations: str) -> dict[str, Any]:
    return {
        "name": name, "family": family, "description": description,
        "languages": [], "selectable": False, "action": "guide",
        "repository": repository, "requirements": requirements, "limitations": limitations,
        "install": "راهنمای رسمی روی کارت مدل",
    }


ENGINE_INFO = {
    "rapidocr-v6": {
        "name": "PP-OCRv6 Small",
        "family": "RapidOCR / ONNX",
        "description": "مدل جدید و سبک برای متن عمومی؛ مناسب انگلیسی، چینی و ژاپنی.",
        "languages": ["eng", "jpn", "chi_sim"],
        "selectable": True, "action": "download",
        "install": "python -m pip install -e \".[ocr]\"",
    },
    "rapidocr-v5": {
        "name": "PP-OCRv5 Multilingual",
        "family": "RapidOCR / ONNX",
        "description": "بستهٔ چندزبانه با مدل اختصاصی کره‌ای و پشتیبانی از زبان‌های فعلی برنامه.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True, "action": "download",
        "install": "python -m pip install -e \".[ocr]\"",
    },
    "easyocr": {
        "name": "EasyOCR",
        "family": "CRAFT + CRNN / ONNX یا PyTorch",
        "description": "گزینهٔ مستقل و سنگین‌تر برای مقایسهٔ دقت در چهار زبان.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True, "action": "download",
        "install": "python -m pip install -e \".[easyocr]\"",
    },
    "tesseract": {
        "name": "Tesseract",
        "family": "Tesseract CLI / TSV",
        "description": "موتور متن‌خوان کلاسیک با خروجی موقعیت‌دار؛ اجرای محلی و بدون ارسال تصویر به اینترنت.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True, "action": "download",
        "repository": "https://github.com/tesseract-ocr/tesseract",
        "requirements": "برنامهٔ اجرایی Tesseract باید جداگانه نصب شود؛ فایل زبان انتخابی با دکمهٔ آماده‌سازی دانلود می‌شود.",
        "limitations": "کیفیت به فونت و چیدمان صفحه وابسته است؛ نصب پایتون به‌تنهایی فایل اجرایی Tesseract را نصب نمی‌کند.",
        "install": "https://github.com/tesseract-ocr/tesseract",
    },
    "paddleocr-vl-1-6": _external_info(
        "PaddleOCR-VL-1.6", "PaddleOCR / VLM",
        "مدل تحلیل سند و تشخیص متن، فرمول و جدول؛ برای اجرای کامل به زیرساخت VLM نیاز دارد.",
        "https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.md",
        "Python/Backend سازگار با PaddleOCR-VL و فضای کافی برای مدل و وابستگی‌ها.",
        "خروجی مستقیم آن خطوط حباب کمیک با مختصات برنامه نیست؛ فعلاً فقط راهنمای رسمی و دانلود دستی ارائه می‌شود.",
    ),
    "mineru-2-5-pro": _external_info(
        "MinerU2.5-Pro", "MinerU / Document pipeline",
        "پایپ‌لاین تبدیل PDF و سند به خروجی ساختاریافته، نه یک جایگزین مستقیم برای OCR حباب کمیک.",
        "https://github.com/opendatalab/MinerU",
        "محیط رسمی MinerU و مدل/Backend متناسب با سخت‌افزار کاربر.",
        "به پردازش سند و خروجی Markdown/JSON تمرکز دارد؛ آداپتور مختصات حباب در برنامه موجود نیست.",
    ),
    "glm-ocr": _external_info(
        "GLM-OCR", "GLM / VLM",
        "مدل چندوجهی OCR و تحلیل سند با گزینهٔ اجرای محلی یا سرویس.",
        "https://github.com/zai-org/GLM-OCR",
        "vLLM/SGLang/Ollama یا سرویس ابری رسمی؛ نیازمند فضای مدل و حافظهٔ مناسب.",
        "استفادهٔ ابری تصویر را از کامپیوتر خارج می‌کند؛ حالت محلی به Backend جدا و آداپتور خروجی نیاز دارد.",
    ),
    "deepseek-ocr-2": _external_info(
        "DeepSeek-OCR-2", "DeepSeek / VLM",
        "مدل پژوهشی بینایی‌ـ‌زبان برای درک سند و OCR.",
        "https://github.com/deepseek-ai/DeepSeek-OCR-2",
        "محیط رسمی CUDA/PyTorch و حافظهٔ GPU مناسب؛ نصب سادهٔ pip کافی نیست.",
        "مدل سنگین است و خروجی آن به‌صورت پیش‌فرض کادرهای خط‌به‌خط برنامه را تولید نمی‌کند.",
    ),
    "got-ocr-2": _external_info(
        "GOT-OCR 2.0", "GOT / VLM",
        "مدل end-to-end برای OCR عمومی و اسناد، با راه‌اندازی رسمی جداگانه.",
        "https://github.com/Ucas-HaoranWei/GOT-OCR2.0",
        "وابستگی‌های رسمی، وزن‌های مدل و حافظهٔ کافی؛ پیش از استفادهٔ تجاری مجوز را بررسی کنید.",
        "خروجی سند/متن با مختصات موردنیاز ویرایشگر کمیک یکسان نیست؛ اجرای مستقیم فعال نیست.",
    ),
    "dots-ocr": _external_info(
        "dots.ocr", "dots / VLM",
        "مدل چندزبانهٔ تحلیل سند و OCR با خروجی ساختاریافته.",
        "https://github.com/studio-dots-ai/dots.ocr",
        "محیط رسمی مدل، Backend مناسب و فضای قابل‌توجه برای وزن‌ها.",
        "به آداپتور تبدیل خروجی به کادرهای حباب نیاز دارد؛ دانلود از طریق لینک رسمی و با انتخاب کاربر انجام می‌شود.",
    ),
    "olmocr": _external_info(
        "olmOCR", "AllenAI / VLM",
        "ابزار/مدل OCR و تبدیل اسناد به متن ساختاریافته با تمرکز بر PDF.",
        "https://github.com/allenai/olmocr",
        "معمولاً GPU و محیط vLLM یا سرور جدا؛ مدل‌ها حجم و حافظهٔ زیادی لازم دارند.",
        "برای تحلیل سند ساخته شده، نه تشخیص مستقیم حباب‌های کمیک با همان مختصات برنامه.",
    ),
    "hunyuan-ocr": _external_info(
        "HunyuanOCR", "Tencent Hunyuan / VLM",
        "مدل OCR بینایی‌ـ‌زبان با گزینه‌های vLLM و اجرای PC-side در پروژهٔ رسمی.",
        "https://github.com/Tencent-Hunyuan/HunyuanOCR",
        "CUDA/Backend رسمی یا llama.cpp و مدل تبدیل‌شده؛ به راهنمای نسخهٔ انتخابی رجوع کنید.",
        "نسخه‌ها و Backendها تفاوت دارند؛ بدون آداپتور خروجی، در OCR داخلی برنامه فعال نیست.",
    ),
    "surya": _external_info(
        "Surya", "Datalab / OCR + Layout",
        "ابزار OCR و تحلیل چیدمان چندزبانه؛ نسخه‌های جدید به Backend استنتاج جدا وابسته‌اند.",
        "https://github.com/datalab-to/surya",
        "surya-ocr و vLLM با GPU یا llama.cpp روی CPU؛ مدل و Backend باید جدا آماده شوند.",
        "مجوز وزن‌ها با مجوز کد متفاوت است و API نسخه‌ها تغییر می‌کند؛ اتصال مستقیم فعلی عمداً غیرفعال است.",
    ),
}


class EngineRegistry:
    def __init__(self) -> None:
        self.engines = {
            "rapidocr-v6": RapidEngine("rapidocr-v6", "v6"),
            "rapidocr-v5": RapidEngine("rapidocr-v5", "v5"),
            "easyocr": EasyEngine(),
            "tesseract": TesseractEngine(),
        }
        for engine_id, info in ENGINE_INFO.items():
            if info.get("action") == "guide":
                self.engines[engine_id] = ManualEngine(engine_id)

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


def _recognize_image_primary(
    engine: Any,
    image: Image.Image,
    language: str,
    contrast: bool = True,
    precise: bool = True,
    min_confidence: float = 0.35,
    input_scale: float = 1.0,
) -> list[dict[str, Any]]:
    """The established OCR path; input_scale only restores fallback geometry."""
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
        coordinate_scale = scale * input_scale
        x0, y0, x1, y1 = [value / coordinate_scale for value in line.box]
        polygon = [[x / coordinate_scale, y / coordinate_scale] for x, y in line.polygon]
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


def _extra_preprocess_image(image: Image.Image) -> Image.Image:
    """Isolate very bright letter fills, then make them dark on white."""
    import cv2

    rgb = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
    enlarged = cv2.resize(
        rgb, None, fx=EXTRA_PREPROCESS_SCALE, fy=EXTRA_PREPROCESS_SCALE,
        interpolation=cv2.INTER_CUBIC,
    )
    gray = cv2.cvtColor(enlarged, cv2.COLOR_RGB2GRAY)
    _, bright = cv2.threshold(gray, EXTRA_PREPROCESS_THRESHOLD, 255, cv2.THRESH_BINARY)
    inverted = cv2.bitwise_not(bright)
    return Image.fromarray(inverted, mode="L").convert("RGB")


def _result_metrics(blocks: list[dict[str, Any]]) -> tuple[int, float]:
    """Return valid character count and character-weighted confidence."""
    texts = [str(block.get("text", "")) for block in blocks]
    counts = [sum(char.isalnum() for char in text) for text in texts]
    total = sum(counts)
    if not total:
        return 0, 0.0
    weighted = sum(
        max(0.0, min(1.0, float(block.get("conf", 0.0)) / 100.0)) * count
        for block, count in zip(blocks, counts)
    )
    return total, weighted / total


def _needs_extra_preprocess(blocks: list[dict[str, Any]]) -> bool:
    if not blocks:
        return True
    chars, confidence = _result_metrics(blocks)
    return chars < EXTRA_PREPROCESS_MIN_CHARS or confidence < EXTRA_PREPROCESS_MIN_CONFIDENCE


def _better_fallback(candidate: list[dict[str, Any]], primary: list[dict[str, Any]]) -> bool:
    candidate_chars, candidate_confidence = _result_metrics(candidate)
    primary_chars, primary_confidence = _result_metrics(primary)
    if not candidate_chars:
        return False
    if not primary_chars:
        return True
    # More text must not come with a substantial confidence regression.
    if candidate_chars > primary_chars:
        return candidate_confidence >= primary_confidence - 0.05
    if candidate_chars == primary_chars:
        return candidate_confidence > primary_confidence + 0.005
    return False


def recognize_image(
    engine: Any,
    image: Image.Image,
    language: str,
    contrast: bool = True,
    precise: bool = True,
    min_confidence: float = 0.35,
) -> list[dict[str, Any]]:
    """Run the established OCR first, using bright-text preprocessing only as fallback."""
    primary = _recognize_image_primary(engine, image, language, contrast, precise, min_confidence)
    if not EXTRA_PREPROCESS_ENABLED or not _needs_extra_preprocess(primary):
        return primary
    try:
        fallback_image = _extra_preprocess_image(image)
        fallback = _recognize_image_primary(
            engine, fallback_image, language, False, False, min_confidence,
            input_scale=EXTRA_PREPROCESS_SCALE,
        )
    except Exception:
        # An optional preprocessing backend must never break the established OCR result.
        return primary
    return fallback if _better_fallback(fallback, primary) else primary
