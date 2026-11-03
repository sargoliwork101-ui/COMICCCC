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

from .activity import emit
from .ocr_managed import (
    ISOLATED_ENGINE_SPECS,
    IsolatedOcrEngine,
    acknowledge_engine_update,
    check_remote_updates,
    cleanup_superseded_engine_files,
    clear_cached_engine_update,
    compute_engine_update_fields,
    detect_builtin_installed_version,
    engine_meta,
    evaluate_engine_hardware,
    fetch_tessdata_revision,
    inspect_hardware,
    install_tesseract_runtime,
    is_newer_version,
    portable_tesseract_executable,
    process_rss_mb,
    read_manifest,
    read_update_cache,
    sha256_short,
    trim_process_memory,
    update_manifest_entry,
)
from .paths import models_dir

# Optional bright-white-text fallback. The original OCR path always runs first.
EXTRA_PREPROCESS_SCALE = 3
EXTRA_PREPROCESS_THRESHOLD = 200
EXTRA_PREPROCESS_MIN_CONFIDENCE = 0.55
EXTRA_PREPROCESS_MIN_CHARS = 3
EXTRA_PREPROCESS_ENABLED = True
# Optional comic-bubble fallback. These thresholds are intentionally easy to tune.
BUBBLE_PREPROCESS_ENABLED = True
BUBBLE_DARK_THRESHOLD = 110
BUBBLE_MIN_AREA = 8000
BUBBLE_CLOSE_KERNEL = 25
BUBBLE_MASK_ERODE = 15
BUBBLE_BG_MIN_VALUE = 15
BUBBLE_UNIFORM_TOLERANCE = 20
BUBBLE_UNIFORM_MIN_RATIO = 0.55
BUBBLE_INK_RATIO = 0.45
BUBBLE_SCALE = 3
BUBBLE_PADDING = 30
BUBBLE_MIN_REGION_CONFIDENCE = 60.0
# Several tabs may request preparation together; never run two pip processes at once.
_INSTALL_LOCK = threading.Lock()

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


def install_packages(packages: list[str], *, upgrade: bool = False) -> None:
    """Install a whitelisted runtime only after an explicit user preparation click."""
    if not packages:
        return
    command = [sys.executable, "-m", "pip", "install", "--no-cache-dir", *(["--upgrade"] if upgrade else []), *packages]
    action_label = "به‌روزرسانی" if upgrade else "نصب"
    emit(f"{action_label} بسته‌های OCR آغاز شد: {', '.join(packages)}", progress=0.18)
    try:
        with _INSTALL_LOCK:
            result = subprocess.run(command, capture_output=True, text=True, timeout=3600, check=False)
    except Exception as exc:
        emit(f"نصب بسته‌های OCR ناموفق بود: {exc}", "error")
        raise OcrError(f"Could not install the OCR runtime: {exc}") from exc
    if result.returncode:
        details = (result.stderr or result.stdout or "pip failed")[-1800:].strip()
        if "WinError 32" in details or "being used by another process" in details:
            details += ("\nComic OCR Studio: a second Python/pip installer or antivirus may be locking the temporary file. "
                        "Close other Python/installer windows, restart Windows if needed, and retry one installation only.")
        if "WinError 5" in details or "Access is denied" in details:
            details += ("\nComic OCR Studio: Windows denied write access. Close the app, start start_windows_admin.bat, "
                        "approve the UAC prompt, and retry the explicit OCR installation.")
        emit(f"نصب بسته‌های OCR ناموفق بود: {details}", "error")
        raise OcrError(f"OCR runtime installation failed: {details}")
    importlib.invalidate_caches()
    emit("نصب بسته‌های OCR تمام شد", "success", progress=0.68)


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

    @property
    def is_loaded_in_ram(self) -> bool:
        with self._lock:
            return bool(self._instances)

    def unload(self) -> None:
        with self._lock:
            self._instances.clear()

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
        try:
            low_mem_params = {
                **params,
                "EngineConfig.onnxruntime.enable_cpu_mem_arena": False,
            }
            return RapidOCR(params=low_mem_params)
        except Exception:
            return RapidOCR(params=params)

    def _ensure_runtime(self) -> None:
        if not self.runtime_installed:
            emit("بستهٔ اجرای RapidOCR موجود نیست؛ نصب آگاهانه آغاز می‌شود")
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
                emit(f"بارگذاری یا دانلود مدل {self.id} برای {language} آغاز شد")
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
        emit(f"شروع آماده‌سازی مدل {self.id}…", progress=0.06)
        self._ensure_runtime()
        languages = [language] if self.version == "v5" else ["eng"]
        try:
            for idx, selected in enumerate(languages):
                try:
                    step_p = 0.72 + (0.20 * idx / max(1, len(languages)))
                    emit(f"آماده‌سازی مدل {self.id} برای {selected}؛ ممکن است دانلود چند دقیقه طول بکشد", progress=round(step_p, 2))
                    self._warm(self._get(selected, allow_download=True))
                    emit(f"مدل {self.id} برای {selected} بارگذاری و آزمایش شد", "success", progress=0.94)
                except OcrError:
                    raise
                except Exception as exc:
                    cause = f"; cause: {exc.__cause__}" if exc.__cause__ else ""
                    raise OcrError(
                        f"Model download failed for {self.id} ({selected}): {exc}{cause}. "
                        "Check the internet connection and model host access, then try again."
                    ) from exc
            cleanup_superseded_engine_files(self.id)
            ver = detect_builtin_installed_version(self.id, self)
            acknowledge_engine_update(self.id, installed_version=ver, ready_languages=self.ready_languages)
        finally:
            self.unload()
            trim_process_memory()

    def update(self, language: str = "eng") -> None:
        emit(f"شروع به‌روزرسانی خودکار {self.id}…", progress=0.06)
        target_langs = list(self.ready_languages) if self.version == "v5" and self.ready_languages else ([language] if self.version == "v5" else ["eng"])
        self.unload()
        try:
            cur_ver = detect_builtin_installed_version(self.id, self)
            cached = (read_update_cache().get("engines") or {}).get(self.id) or {}
            latest_ver = cached.get("latestVersion")
            need_pkg_upgrade = (
                not self.runtime_installed
                or not cur_ver
                or not latest_ver
                or is_newer_version(cur_ver, latest_ver)
            )
            if need_pkg_upgrade:
                # Avoid upgrading onnxruntime when already loaded on Windows (prevents locked .pyd WinError 5/32).
                pkgs = ["rapidocr>=3.10"]
                if not importlib.util.find_spec("onnxruntime"):
                    pkgs.append("onnxruntime>=1.20,<2")
                install_packages(pkgs, upgrade=True)
            else:
                emit(f"بستهٔ اجرایی {self.id} ({cur_ver}) در آخرین نسخه است…", progress=0.68)
            for idx, selected in enumerate(target_langs):
                emit(f"بررسی و آماده‌سازی فایل‌های مدل {self.id} ({selected})…", progress=round(0.74 + 0.18 * (idx / max(1, len(target_langs))), 2))
                self._warm(self._get(selected, allow_download=True))
            cleanup_superseded_engine_files(self.id)
            ver = detect_builtin_installed_version(self.id, self)
            acknowledge_engine_update(self.id, installed_version=ver, ready_languages=self.ready_languages)
            emit(f"مدل {self.id} با موفقیت به نسخهٔ {ver or 'جدید'} به‌روزرسانی شد", "success", progress=1.0)
        finally:
            self.unload()
            trim_process_memory()

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        engine = self._get(language)
        arr = np.asarray(image)
        try:
            result = engine(arr, use_cls=False)
        except TypeError:
            result = engine(arr)
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

    @property
    def is_loaded_in_ram(self) -> bool:
        with self._lock:
            return bool(self._readers)

    def unload(self) -> None:
        with self._lock:
            self._readers.clear()

    def _ensure_runtime(self) -> None:
        if not self.runtime_installed:
            emit("بستهٔ اجرای EasyOCR موجود نیست؛ نصب آگاهانه آغاز می‌شود")
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
                emit(f"بارگذاری یا دانلود مدل EasyOCR برای {language} آغاز شد")
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
        emit(f"شروع آماده‌سازی مدل EasyOCR ({language})…", progress=0.06)
        self._ensure_runtime()
        try:
            emit(f"آماده‌سازی EasyOCR برای {language}؛ فقط مدل همین زبان دریافت می‌شود", progress=0.62)
            self._reader(language, True)
            self._model_dir().mkdir(parents=True, exist_ok=True)
            (self._model_dir() / f".ready-{language}").write_text("downloaded by user request\n", encoding="utf-8")
            cleanup_superseded_engine_files(self.id)
            ver = detect_builtin_installed_version(self.id, self)
            acknowledge_engine_update(self.id, installed_version=ver, ready_languages=self.ready_languages)
            emit(f"مدل EasyOCR برای {language} آماده شد", "success", progress=1.0)
        except OcrError:
            raise
        except Exception as exc:
            raise OcrError(f"EasyOCR model download failed for {language}: {exc}") from exc
        finally:
            self.unload()
            trim_process_memory()

    def update(self, language: str = "eng") -> None:
        emit("شروع به‌روزرسانی خودکار EasyOCR…", progress=0.06)
        target_langs = list(self.ready_languages) or [language]
        self.unload()
        try:
            cur_ver = detect_builtin_installed_version(self.id, self)
            cached = (read_update_cache().get("engines") or {}).get(self.id) or {}
            latest_ver = cached.get("latestVersion")
            need_pkg_upgrade = (
                not self.runtime_installed
                or not cur_ver
                or not latest_ver
                or is_newer_version(cur_ver, latest_ver)
            )
            if need_pkg_upgrade:
                # Avoid upgrading torch when already installed on Windows (prevents locked torch_cpu.dll errors).
                pkgs = ["easyocr>=1.7"]
                if not importlib.util.find_spec("torch"):
                    pkgs.append("torch>=2.2,<3")
                install_packages(pkgs, upgrade=True)
            else:
                emit(f"بستهٔ اجرایی EasyOCR ({cur_ver}) در آخرین نسخه است…", progress=0.68)
            for idx, selected in enumerate(target_langs):
                emit(f"آماده‌سازی وزن‌های EasyOCR برای {selected}…", progress=round(0.72 + 0.20 * (idx / max(1, len(target_langs))), 2))
                self._reader(selected, True)
                self._model_dir().mkdir(parents=True, exist_ok=True)
                (self._model_dir() / f".ready-{selected}").write_text("downloaded by user request\n", encoding="utf-8")
            cleanup_superseded_engine_files(self.id)
            ver = detect_builtin_installed_version(self.id, self)
            acknowledge_engine_update(self.id, installed_version=ver, ready_languages=self.ready_languages)
            emit(f"مدل EasyOCR با موفقیت به نسخهٔ {ver or 'جدید'} به‌روزرسانی شد", "success", progress=1.0)
        finally:
            self.unload()
            trim_process_memory()

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
    portable = portable_tesseract_executable()
    if portable:
        return portable
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

    @property
    def is_loaded_in_ram(self) -> bool:
        return False

    def unload(self) -> None:
        self._system_languages = None

    def _download_language_file(self, language: str) -> Path:
        if language not in LANGUAGES:
            raise OcrError(f"Unsupported Tesseract language: {language}")
        self._model_dir().mkdir(parents=True, exist_ok=True)
        url = f"https://github.com/tesseract-ocr/tessdata_fast/raw/main/{language}.traineddata"
        temporary = self._model_dir() / f".{language}.traineddata.part"
        target = self._model_dir() / f"{language}.traineddata"
        try:
            emit(f"دانلود فایل زبان Tesseract ({language}) از منبع رسمی آغاز شد", progress=0.20)
            request = urllib.request.Request(url, headers={"User-Agent": "Comic-OCR-Studio"})
            with urllib.request.urlopen(request, timeout=180) as response, temporary.open("wb") as output:
                hdrs = getattr(response, "headers", None)
                raw_len = hdrs.get("Content-Length") if hdrs and hasattr(hdrs, "get") else None
                expected_bytes = int(raw_len) if raw_len and str(raw_len).isdigit() else 12 * 1024 * 1024
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    ratio = min(1.0, total / max(1, expected_bytes))
                    emit(
                        f"Tesseract {language}: {total / (1024 * 1024):.1f} مگابایت دریافت شد",
                        progress=round(0.24 + 0.66 * ratio, 3),
                    )
                    if total > 50 * 1024 * 1024:
                        raise OcrError("The selected Tesseract language file is unexpectedly large.")
                    output.write(chunk)
            if temporary.stat().st_size < 1000:
                raise OcrError("The downloaded Tesseract language file is empty or invalid.")
            os.replace(temporary, target)
            emit(f"فایل زبان Tesseract ({language}) ذخیره شد", "success", progress=0.94)
            return target
        except OcrError:
            temporary.unlink(missing_ok=True)
            raise
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise OcrError(f"Tesseract language download failed for {language}: {exc}. The official tessdata_fast host must be reachable.") from exc

    def download(self, language: str = "eng") -> None:
        if language not in LANGUAGES:
            raise OcrError(f"Unsupported Tesseract language: {language}")
        emit(f"شروع آماده‌سازی Tesseract ({language})…", progress=0.06)
        if not self.runtime_installed:
            install_tesseract_runtime(OcrError)
            self._system_languages = None
        target = self._download_language_file(language)
        ver = detect_builtin_installed_version(self.id, self)
        remote_rev = fetch_tessdata_revision([language])
        local_hash = sha256_short(target)
        # Never store an unprefixed local file SHA-256 where check_remote_updates compares Git commit SHAs.
        rev_to_save = remote_rev or (f"sha256:{local_hash}" if local_hash else "ready")
        acknowledge_engine_update(
            self.id,
            installed_version=ver,
            model_revision=rev_to_save,
            ready_languages=self.ready_languages,
        )

    def update(self, language: str = "eng") -> None:
        emit("شروع به‌روزرسانی خودکار Tesseract…", progress=0.06)
        try:
            if os.name == "nt":
                cur_ver = detect_builtin_installed_version(self.id, self)
                cached = (read_update_cache().get("engines") or {}).get(self.id) or {}
                latest_ver = cached.get("latestVersion")
                needs_win_bin = (
                    not self.runtime_installed
                    or bool(cur_ver and latest_ver and is_newer_version(cur_ver, latest_ver))
                )
                if needs_win_bin:
                    install_tesseract_runtime(OcrError)
                    self._system_languages = None
                else:
                    emit(f"فایل اجرایی Tesseract ({cur_ver or 'نصب‌شده'}) در آخرین نسخه است…", progress=0.45)
            elif not self.runtime_installed:
                install_tesseract_runtime(OcrError)
                self._system_languages = None
            local_langs = [lang for lang in LANGUAGES if (self._model_dir() / f"{lang}.traineddata").is_file()]
            target_langs = local_langs or [language if language in LANGUAGES else "eng"]
            last_target: Path | None = None
            for selected in target_langs:
                last_target = self._download_language_file(selected)
            cleanup_superseded_engine_files(self.id)
            ver = detect_builtin_installed_version(self.id, self)
            remote_rev = fetch_tessdata_revision(target_langs)
            local_hash = sha256_short(last_target) if last_target else None
            rev_to_save = remote_rev or (f"sha256:{local_hash}" if local_hash else "ready")
            acknowledge_engine_update(
                self.id,
                installed_version=ver,
                model_revision=rev_to_save,
                ready_languages=self.ready_languages,
            )
            emit(f"مدل Tesseract با موفقیت به نسخهٔ {ver or 'جدید'} به‌روزرسانی شد", "success", progress=1.0)
        finally:
            self.unload()
            trim_process_memory()

    def _recognize_with_psm(self, image: Image.Image, language: str, psm: str) -> list[OcrLine]:
        executable = _tesseract_executable()
        if not executable:
            raise OcrError("Tesseract is not installed. Install the binary and use the explicit language download button.")
        if language not in self.ready_languages:
            raise OcrError(f"Tesseract language {language} is not ready. Use the explicit model download button first.")
        buffer = io.BytesIO(); image.convert("RGB").save(buffer, "PNG")
        command = [executable, "stdin", "stdout", "-l", language, "--psm", psm]
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

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        return self._recognize_with_psm(image, language, "11")

    def recognize_document(self, image: Image.Image, language: str) -> list[OcrLine]:
        return self._recognize_with_psm(image, language, "3")

    def recognize_bubble(self, image: Image.Image, language: str) -> list[OcrLine]:
        return self._recognize_with_psm(image, language, "6")


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


def _isolated_info(
    engine_id: str,
    name: str,
    family: str,
    description: str,
    repository: str,
    requirements: str,
) -> dict[str, Any]:
    spec = ISOLATED_ENGINE_SPECS[engine_id]
    return {
        "name": name,
        "family": family,
        "description": description,
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True,
        "action": "download",
        "isolated": True,
        "category": spec["category"],
        "downloadSizeGb": spec["download_size_gb"],
        "requiresNvidiaGpu": spec["requires_nvidia_gpu"],
        "minVramGb": spec["min_vram_gb"],
        "minDiskGb": spec["min_disk_gb"],
        "repository": repository,
        "requirements": requirements,
        "install": "نصب و دانلود کاملاً خودکار در محیط ایزوله با یک کلیک",
    }


ENGINE_SUITABILITY: dict[str, dict[str, dict[str, str]]] = {
    "rapidocr-v6": {
        "comic": {
            "tier": "best",
            "reason": "تشخیص سریع و دقیق حباب‌های گفتگوی کمیک و مانگا روی هر سیستمی (بدون نیاز به GPU).",
        },
        "document": {
            "tier": "medium",
            "reason": "خط‌خوانی سریع روی CPU؛ برای چیدمان پیچیدهٔ کتاب و مقاله موتورهای سبز (مثل Surya، PaddleOCR-VL یا Tesseract) دقیق‌ترند.",
        },
        "auto": {
            "tier": "best",
            "reason": "سریع‌ترین انتخاب متعادل برای صفحات ترکیبی کمیک و متن روزمره روی همهٔ سیستم‌ها.",
        },
    },
    "rapidocr-v5": {
        "comic": {
            "tier": "best",
            "reason": "عالی برای کمیک، مانگا و به‌ویژه مانهوای کره‌ای با سرعت بالا روی هر سیستمی.",
        },
        "document": {
            "tier": "medium",
            "reason": "سبک و چندزبانه (شامل کره‌ای)، اما روی فونت‌های ریز و متراکم کتاب متوسط است.",
        },
        "auto": {
            "tier": "medium",
            "reason": "گزینهٔ سبک چندزبانه (مناسب کره‌ای)؛ در انگلیسی دقت PP-OCRv6 و مدل‌های چیدمان بالاتر است.",
        },
    },
    "easyocr": {
        "comic": {
            "tier": "best",
            "reason": "تشخیص بسیار خوب حروف و حباب‌های منحنی یا پراکندهٔ کمیک در هر چهار زبان.",
        },
        "document": {
            "tier": "weak",
            "reason": "فاقد تحلیل ساختار پاراگراف و ستون؛ در صفحات پُرمتن کتاب کند است و فاصلهٔ کلمات ریز را گاهی اشتباه می‌گیرد.",
        },
        "auto": {
            "tier": "medium",
            "reason": "مناسب حباب‌های کمیک است اما برای صفحات متراکم کتاب و مقاله توصیه نمی‌شود.",
        },
    },
    "tesseract": {
        "comic": {
            "tier": "weak",
            "reason": "طراحی‌شده برای اسناد مسطح؛ روی فونت‌های فانتزی کمیک، حباب‌های منحنی و پس‌زمینهٔ نقاشی عملکرد ضعیفی دارد.",
        },
        "document": {
            "tier": "best",
            "reason": "عملکرد عالی، سریع و کم‌مصرف برای کتاب، مقاله و جزوه‌های چاپی یا اسکن‌شدهٔ تمیز با صفحه‌بندی خودکار ستون‌ها.",
        },
        "auto": {
            "tier": "medium",
            "reason": "عالی برای صفحات کتاب و مقاله، ولی اگر صفحه کمیک باشد روی حباب‌ها ضعیف عمل می‌کند.",
        },
    },
    "paddleocr-vl-1-6": {
        "comic": {
            "tier": "medium",
            "reason": "دقت خواندن متن بالاست اما بیشتر برای چیدمان اسناد ساخته شده و از موتورهای کمیک سنگین‌تر است.",
        },
        "document": {
            "tier": "best",
            "reason": "فوق‌العاده برای کتاب، مقالات چندستونی، تیترها و جداول با تشخیص هوشمند ساختار صفحه.",
        },
        "auto": {
            "tier": "best",
            "reason": "تشخیص هوشمند چیدمان برای پروژه‌های ترکیبی، کتاب‌های مصور و مقالات.",
        },
    },
    "surya": {
        "comic": {
            "tier": "medium",
            "reason": "حباب‌های ساده را می‌خواند اما برای فونت‌های دفرمه و جلوه‌های صوتی کمیک بهینه نشده است.",
        },
        "document": {
            "tier": "best",
            "reason": "یکی از بهترین موتورها برای کتاب، مقالهٔ علمی، جزوه و تشخیص دقیق ترتیب سطرها و ستون‌ها.",
        },
        "auto": {
            "tier": "best",
            "reason": "عملکرد قوی و چندزبانه روی صفحات کتاب، جزوه و کتاب‌های مصور.",
        },
    },
    "mineru-2-5-pro": {
        "comic": {
            "tier": "weak",
            "reason": "مخصوص مقالات و اسناد علمی است؛ پنل‌های نقاشی کمیک را به‌عنوان تصویر غیرمتنی رد یا ناقص بخش‌بندی می‌کند.",
        },
        "document": {
            "tier": "best",
            "reason": "تخصصی‌ترین موتور برای کتاب‌های درسی، مقالات دانشگاهی چندستونی، جداول و جزوه‌های پیچیده.",
        },
        "auto": {
            "tier": "weak",
            "reason": "تک‌منظوره برای کتاب و مقاله است و روی کمیک ضعیف عمل می‌کند؛ برای کتاب، نوع صفحه را روی «کتاب و مقاله» بگذارید.",
        },
    },
    "got-ocr-2": {
        "comic": {
            "tier": "best",
            "reason": "مدل بینایی دقیق برای خواندن فونت‌های خاص داخل حباب‌های برش‌خوردهٔ کمیک و مانگا.",
        },
        "document": {
            "tier": "medium",
            "reason": "متن پاراگراف‌ها را خوب می‌خواند اما تحلیل مستقیم ستون‌بندی کل صفحه را ندارد و کندتر از Surya است.",
        },
        "auto": {
            "tier": "medium",
            "reason": "دقت خوب روی برش‌های متنی کمیک و پاراگراف‌های کوتاه، با سرعت متوسط روی CPU.",
        },
    },
    "glm-ocr": {
        "comic": {
            "tier": "best",
            "reason": "مدل بینایی‌ـ‌زبان قدرتمند در خواندن دیالوگ‌های کمیک، مانگا و فونت‌های دشوار.",
        },
        "document": {
            "tier": "medium",
            "reason": "کیفیت خوانش خوب روی بلوک‌های متن، ولی در صفحات خیلی پُرمتن کندتر از موتورهای تخصصی چیدمان سند است.",
        },
        "auto": {
            "tier": "best",
            "reason": "انعطاف‌پذیری بالا هم روی حباب‌های کمیک و هم روی پاراگراف‌های کتاب.",
        },
    },
    "dots-ocr": {
        "comic": {
            "tier": "medium",
            "reason": "قادر به خواندن کادرهاست اما نیازمند GPU قوی است و تمرکز اصلی آن روی اسناد است.",
        },
        "document": {
            "tier": "best",
            "reason": "عالی برای تشخیص هم‌زمان مختصات کادرها، ستون‌ها و متن در کتاب و مقاله (نیازمند NVIDIA GPU ≥ 8GB).",
        },
        "auto": {
            "tier": "medium",
            "reason": "دقیق ولی سنگین (نیازمند کارت گرافیک NVIDIA)؛ بیشتر مناسب اسناد و کتاب است.",
        },
    },
    "deepseek-ocr-2": {
        "comic": {
            "tier": "medium",
            "reason": "متن را دقیق می‌خواند ولی برای صفحات کمیک بسیار سنگین است (نیازمند GPU ≥ 12GB).",
        },
        "document": {
            "tier": "best",
            "reason": "دقت بسیار بالا در مکان‌یابی و استخراج متون متراکم کتاب، مقاله و جداول (روی NVIDIA GPU ≥ 12GB).",
        },
        "auto": {
            "tier": "medium",
            "reason": "مدل سنگین مخصوص سیستم‌های دارای GPU قوی؛ در اسناد و کتاب درخشان‌تر از کمیک است.",
        },
    },
    "olmocr": {
        "comic": {
            "tier": "weak",
            "reason": "صرفاً روی مقالات و کتاب‌های PDF آموزش دیده و برای حباب‌های کمیک و مانگا نامناسب و بسیار سنگین است.",
        },
        "document": {
            "tier": "best",
            "reason": "فوق‌العاده برای کتاب‌های اسکن‌شدهٔ قدیمی، مقالات علمی و متون دشوار چاپی (نیازمند NVIDIA GPU ≥ 16GB).",
        },
        "auto": {
            "tier": "weak",
            "reason": "مدل ۷ میلیارد پارامتری مخصوص کتاب و اسناد روی GPU سنگین؛ برای حالت عمومی یا کمیک مناسب نیست.",
        },
    },
    "hunyuan-ocr": {
        "comic": {
            "tier": "medium",
            "reason": "تشخیص متن قوی دارد اما به دلیل نیاز به ۲۴ گیگابایت VRAM برای کمیک بیش‌ازحد سنگین است.",
        },
        "document": {
            "tier": "medium",
            "reason": "خوانش دقیق متن‌های چندزبانه، اما نیازمند کارت گرافیک حرفه‌ای ۲۴ گیگابایتی و کندتر از مدل‌های تخصصی سند است.",
        },
        "auto": {
            "tier": "weak",
            "reason": "صرفاً مناسب ایستگاه‌های کاری دارای GPU حرفه‌ای (24GB VRAM) در موارد خاص.",
        },
    },
}


ENGINE_INFO = {
    "rapidocr-v6": {
        "name": "PP-OCRv6 Small",
        "family": "RapidOCR / ONNX",
        "description": "مدل جدید، سریع و سبک برای متن کمیک، کتاب و مقاله؛ مناسب انگلیسی، چینی و ژاپنی.",
        "languages": ["eng", "jpn", "chi_sim"],
        "selectable": True,
        "action": "download",
        "isolated": False,
        "category": "standard",
        "downloadSizeGb": 0.06,
        "requiresNvidiaGpu": False,
        "minVramGb": 0.0,
        "minDiskGb": 0.4,
        "repository": "https://github.com/RapidAI/RapidOCR",
        "requirements": "سبک و سریع؛ بدون نیاز به کارت گرافیک مجزا روی همهٔ کامپیوترها اجرا می‌شود.",
        "install": "python -m pip install -e \".[ocr]\"",
    },
    "rapidocr-v5": {
        "name": "PP-OCRv5 Multilingual",
        "family": "RapidOCR / ONNX",
        "description": "بستهٔ چندزبانهٔ سبک با مدل اختصاصی کره‌ای و پشتیبانی از هر چهار زبان برنامه.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True,
        "action": "download",
        "isolated": False,
        "category": "standard",
        "downloadSizeGb": 0.08,
        "requiresNvidiaGpu": False,
        "minVramGb": 0.0,
        "minDiskGb": 0.4,
        "repository": "https://github.com/RapidAI/RapidOCR",
        "requirements": "سبک و سریع؛ بدون نیاز به کارت گرافیک مجزا روی همهٔ کامپیوترها اجرا می‌شود.",
        "install": "python -m pip install -e \".[ocr]\"",
    },
    "easyocr": {
        "name": "EasyOCR",
        "family": "CRAFT + CRNN / PyTorch",
        "description": "موتور مستقل و دقیق برای مقایسهٔ کیفیت تشخیص در هر چهار زبان.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True,
        "action": "download",
        "isolated": False,
        "category": "standard",
        "downloadSizeGb": 0.65,
        "requiresNvidiaGpu": False,
        "minVramGb": 0.0,
        "minDiskGb": 1.8,
        "repository": "https://github.com/JaidedAI/EasyOCR",
        "requirements": "قابل اجرا روی پردازندهٔ معمولی (CPU)؛ دانلود اولیه شامل زیرساخت PyTorch و فایل زبان انتخابی است.",
        "install": "python -m pip install -e \".[easyocr]\"",
    },
    "tesseract": {
        "name": "Tesseract",
        "family": "Tesseract OCR / TSV",
        "description": "موتور متن‌خوان کلاسیک با نصب بی‌صدای خودکار در ویندوز و دریافت خودکار فایل زبان.",
        "languages": ["eng", "kor", "jpn", "chi_sim"],
        "selectable": True,
        "action": "download",
        "isolated": False,
        "category": "standard",
        "downloadSizeGb": 0.09,
        "requiresNvidiaGpu": False,
        "minVramGb": 0.0,
        "minDiskGb": 0.35,
        "repository": "https://github.com/tesseract-ocr/tesseract",
        "requirements": "نصب کاملاً خودکار موتور اجرایی و فایل زبان در پوشهٔ اختصاصی برنامه، بدون نیاز به نصب دستی.",
        "install": "https://github.com/tesseract-ocr/tesseract",
    },
    "paddleocr-vl-1-6": _isolated_info(
        "paddleocr-vl-1-6",
        "PaddleOCR-VL-1.6",
        "PaddleOCR / VLM",
        "مدل چندزبانهٔ تشخیص چیدمان و متن با نصب خودکار در پوشهٔ ایزوله و خروجی کادربندی‌شده.",
        "https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.md",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و کارت گرافیک NVIDIA (حجم دانلود حدود ۲٫۴ گیگابایت).",
    ),
    "surya": _isolated_info(
        "surya",
        "Surya",
        "Datalab / OCR + Layout",
        "مدل چندزبانهٔ تشخیص متن و چیدمان با دریافت خودکار پیش‌نیازهای پردازنده یا کارت گرافیک.",
        "https://github.com/datalab-to/surya",
        "نصب خودکار در محیط جدا به همراه موتور کمکی CPU در صورت نبود کارت گرافیک (حجم حدود ۲٫۲ گیگابایت).",
    ),
    "mineru-2-5-pro": _isolated_info(
        "mineru-2-5-pro",
        "MinerU2.5-Pro",
        "MinerU / Document + OCR",
        "موتور ساختاریافتهٔ تشخیص بلوک‌های متن و تصویر با نصب خودکار در محیط مستقل.",
        "https://github.com/opendatalab/MinerU",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و GPU (حجم دانلود حدود ۳ گیگابایت).",
    ),
    "got-ocr-2": _isolated_info(
        "got-ocr-2",
        "GOT-OCR 2.0",
        "GOT / Vision-Language OCR",
        "مدل هوش مصنوعی بینایی برای خواندن دقیق متنِ حباب‌های کمیک در محیط مستقل.",
        "https://github.com/Ucas-HaoranWei/GOT-OCR2.0",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و GPU ولی با کارت گرافیک سریع‌تر است (حدود ۱٫۸ گیگابایت).",
    ),
    "glm-ocr": _isolated_info(
        "glm-ocr",
        "GLM-OCR",
        "GLM / Vision-Language OCR",
        "مدل چندوجهی خواندن متن با تشخیص خودکار نواحی حباب گفتگو و نصب ایزوله.",
        "https://github.com/zai-org/GLM-OCR",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و کارت گرافیک NVIDIA (حجم حدود ۲٫۴ گیگابایت).",
    ),
    "dots-ocr": _isolated_info(
        "dots-ocr",
        "dots.ocr",
        "dots / Vision-Language OCR",
        "مدل سنگین چندزبانهٔ تشخیص چیدمان و متن با خروجی مختصات کادرها.",
        "https://github.com/studio-dots-ai/dots.ocr",
        "مدل سنگین؛ نیازمند کارت گرافیک NVIDIA با حداقل ۸ گیگابایت حافظه و حدود ۴٫۵ گیگابایت دانلود.",
    ),
    "deepseek-ocr-2": _isolated_info(
        "deepseek-ocr-2",
        "DeepSeek-OCR-2",
        "DeepSeek / Vision-Language OCR",
        "مدل بینایی‌ـ‌زبان پیشرفته با قابلیت مکان‌یابی متن روی صفحه در محیط مستقل.",
        "https://github.com/deepseek-ai/DeepSeek-OCR-2",
        "مدل سنگین؛ نیازمند کارت گرافیک NVIDIA با حداقل ۱۲ گیگابایت حافظه و حدود ۷٫۵ گیگابایت دانلود.",
    ),
    "olmocr": _isolated_info(
        "olmocr",
        "olmOCR",
        "AllenAI / 7B VLM OCR",
        "مدل ۷ میلیارد پارامتری خواندن متن‌های دشوار در محیط کاملاً ایزوله.",
        "https://github.com/allenai/olmocr",
        "مدل بسیار سنگین؛ نیازمند کارت گرافیک NVIDIA با حداقل ۱۶ گیگابایت حافظه و حدود ۱۵ گیگابایت دانلود.",
    ),
    "hunyuan-ocr": _isolated_info(
        "hunyuan-ocr",
        "HunyuanOCR",
        "Tencent Hunyuan / VLM OCR",
        "مدل بزرگ بینایی‌ـ‌زبان برای تشخیص متن با نصب خودکار در محیط ایزوله.",
        "https://github.com/Tencent-Hunyuan/HunyuanOCR",
        "مدل بسیار سنگین؛ نیازمند کارت گرافیک حرفه‌ای NVIDIA با حداقل ۲۴ گیگابایت حافظه و حدود ۲۰ گیگابایت دانلود.",
    ),
}


for _eng_id, _eng_meta in ENGINE_INFO.items():
    _eng_meta["suitability"] = ENGINE_SUITABILITY.get(_eng_id, {})


class EngineRegistry:
    def __init__(self) -> None:
        self.engines: dict[str, Any] = {
            "rapidocr-v6": RapidEngine("rapidocr-v6", "v6"),
            "rapidocr-v5": RapidEngine("rapidocr-v5", "v5"),
            "easyocr": EasyEngine(),
            "tesseract": TesseractEngine(),
        }
        for engine_id, info in ENGINE_INFO.items():
            if engine_id in self.engines:
                continue
            if info.get("isolated"):
                self.engines[engine_id] = IsolatedOcrEngine(
                    engine_id=engine_id,
                    languages=info["languages"],
                    install_lock=_INSTALL_LOCK,
                    line_factory=OcrLine,
                    error_cls=OcrError,
                )
            elif info.get("action") == "guide":
                self.engines[engine_id] = ManualEngine(engine_id)

    def get(self, engine_id: str):
        if engine_id not in self.engines:
            raise OcrError(f"Unknown OCR engine: {engine_id}")
        return self.engines[engine_id]

    def hardware_summary(self) -> dict[str, Any]:
        return inspect_hardware()

    def check_hardware(self, engine_id: str) -> dict[str, Any]:
        self.get(engine_id)
        return evaluate_engine_hardware(engine_id)

    def status(self) -> list[dict[str, Any]]:
        hw = inspect_hardware()
        manifest = read_manifest()
        cached_updates = (read_update_cache().get("engines") or {})
        result = []
        for engine_id, info in ENGINE_INFO.items():
            engine = self.get(engine_id)
            ready_languages = engine.ready_languages
            installed_ver = (
                engine.installed_version
                if hasattr(engine, "installed_version")
                else detect_builtin_installed_version(engine_id, engine)
            )
            update_fields = compute_engine_update_fields(
                engine_id=engine_id,
                engine_name=info["name"],
                engine=engine,
                installed_version=installed_ver,
                manifest_entry=manifest.get(engine_id),
                cached_remote=cached_updates.get(engine_id),
            )
            result.append({
                "id": engine_id,
                **info,
                "runtimeInstalled": engine.runtime_installed,
                "modelReady": bool(ready_languages),
                "readyLanguages": ready_languages,
                "isLoadedInRam": bool(getattr(engine, "is_loaded_in_ram", False)),
                **update_fields,
                "hardwareCheck": evaluate_engine_hardware(engine_id, hw),
            })
        return result

    def memory_status(self) -> dict[str, Any]:
        app_ram_mb = process_rss_mb()
        worker_ram_mb = 0.0
        loaded_engines: list[dict[str, str]] = []
        for engine_id, info in ENGINE_INFO.items():
            engine = self.engines.get(engine_id)
            if engine is None:
                continue
            if bool(getattr(engine, "is_loaded_in_ram", False)):
                loaded_engines.append({"id": engine_id, "name": str(info.get("name") or engine_id)})
                w_pid = getattr(engine, "worker_pid", None)
                if w_pid:
                    worker_ram_mb += process_rss_mb(int(w_pid))
        total_mb = round(app_ram_mb + worker_ram_mb, 1)
        return {
            "processRamMb": app_ram_mb,
            "workerRamMb": round(worker_ram_mb, 1),
            "totalRamMb": total_mb,
            "loadedEngines": loaded_engines,
            "loadedCount": len(loaded_engines),
        }

    def unload_all(self, except_id: str | None = None) -> dict[str, Any]:
        before = self.memory_status()
        unloaded: list[str] = []
        for engine_id, engine in self.engines.items():
            if except_id and engine_id == except_id:
                continue
            was_loaded = bool(getattr(engine, "is_loaded_in_ram", False))
            unloader = getattr(engine, "unload", None) or getattr(engine, "close", None)
            if callable(unloader):
                try:
                    unloader()
                except Exception:
                    pass
            if was_loaded:
                unloaded.append(engine_id)
        trim_process_memory()
        after = self.memory_status()
        freed_mb = round(max(0.0, float(before["totalRamMb"]) - float(after["totalRamMb"])), 1)
        return {
            **after,
            "unloadedEngines": unloaded,
            "freedRamMb": freed_mb,
        }

    def download(self, engine_id: str, language: str = "eng") -> None:
        self.unload_all(except_id=engine_id)
        try:
            self.get(engine_id).download(language)
        finally:
            self.unload_all()

    def update(self, engine_id: str, language: str = "eng") -> None:
        self.unload_all(except_id=engine_id)
        engine = self.get(engine_id)
        updater = getattr(engine, "update", None)
        try:
            if callable(updater):
                updater(language)
            else:
                engine.download(language)
        finally:
            self.unload_all()

    def check_updates(self, force: bool = False) -> dict[str, Any]:
        return check_remote_updates(self, force=force)


PRECISE_UPSCALE_MAX_PIXELS = 4_000_000


def preprocess(image: Image.Image, contrast: bool, precise: bool) -> tuple[Image.Image, float]:
    image = ImageOps.exif_transpose(image).convert("RGB")
    if contrast:
        image = ImageOps.autocontrast(image, cutoff=1)
    scale = 1.0
    if precise and image.width * image.height <= PRECISE_UPSCALE_MAX_PIXELS:
        scale = 2.0
        resized = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
        image.close()
        image = resized
    return image, scale


def _blocks_from_lines(lines: list[OcrLine], coordinate_scale: float = 1.0) -> list[dict[str, Any]]:
    """Build the unchanged public block schema from positioned OCR lines."""
    blocks = []
    for index, line in enumerate(lines, start=1):
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


def _recognize_crop_lines(
    engine: Any,
    crop: Image.Image,
    language: str,
    page_mode: str = "auto",
) -> list[OcrLine]:
    if page_mode == "document":
        doc_rec = getattr(engine, "recognize_document", None)
        if callable(doc_rec):
            return doc_rec(crop, language)
    if isinstance(engine, IsolatedOcrEngine):
        return engine.recognize(crop, language, page_mode=page_mode)
    return engine.recognize(crop, language)


def _recognize_image_primary(
    engine: Any,
    image: Image.Image,
    language: str,
    contrast: bool = True,
    precise: bool = True,
    min_confidence: float = 0.35,
    input_scale: float = 1.0,
    page_mode: str = "auto",
) -> list[dict[str, Any]]:
    """The established OCR path; input_scale only restores fallback geometry."""
    from .ocr_grouping import detect_page_mode, sort_document_reading_order

    # Isolated VLM/layout engines handle their own vision scaling; skipping 2x Lanczos prevents multi-GB RAM spikes.
    effective_precise = False if isinstance(engine, IsolatedOcrEngine) else precise
    prepared, scale = preprocess(image, contrast, effective_precise)
    width, height = prepared.size
    slice_height = 3000
    overlap = 100
    lines: list[OcrLine] = []
    try:
        for start in range(0, height, slice_height):
            end = min(height, start + slice_height)
            read_y0 = max(0, start - overlap)
            read_y1 = min(height, end + overlap)
            is_full = read_y0 == 0 and read_y1 == height
            crop = prepared if is_full else prepared.crop((0, read_y0, width, read_y1))
            try:
                for line in _recognize_crop_lines(engine, crop, language, page_mode=page_mode):
                    polygon = [[x, y + read_y0] for x, y in line.polygon]
                    adjusted = OcrLine(line.text, line.confidence, polygon)
                    center_y = (adjusted.box[1] + adjusted.box[3]) / 2
                    if center_y < start or center_y >= end:
                        continue
                    if adjusted.confidence < min_confidence:
                        continue
                    lines.append(adjusted)
            finally:
                if not is_full:
                    crop.close()
            if end >= height:
                break
    finally:
        if prepared is not image:
            prepared.close()
    # Reading order is stable: physical row first, then horizontal position. No text is flattened.
    lines.sort(key=lambda line: (round(((line.box[1] + line.box[3]) / 2) / 12) * 12, line.box[0], line.box[1]))
    blocks = _blocks_from_lines(lines, scale * input_scale)
    effective_mode = detect_page_mode(blocks, page_size=image.size) if page_mode == "auto" else page_mode
    if effective_mode == "document" and len(blocks) >= 2:
        blocks = sort_document_reading_order(blocks, page_size=image.size)
        for index, blk in enumerate(blocks, start=1):
            blk["id"] = index
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


def _bubble_preprocess_regions(image: Image.Image) -> list[tuple[Image.Image, int, int]]:
    """Return scaled, padded binary bubble crops with their original x/y offsets."""
    import cv2

    gray = np.asarray(ImageOps.exif_transpose(image).convert("L"))
    dark = np.where(gray < BUBBLE_DARK_THRESHOLD, 255, 0).astype(np.uint8)
    close_kernel = np.ones((BUBBLE_CLOSE_KERNEL, BUBBLE_CLOSE_KERNEL), dtype=np.uint8)
    closed = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, close_kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    erode_kernel = np.ones((BUBBLE_MASK_ERODE, BUBBLE_MASK_ERODE), dtype=np.uint8)
    regions: list[tuple[Image.Image, int, int]] = []
    for contour in contours:
        if cv2.contourArea(contour) < BUBBLE_MIN_AREA:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        local_contour = contour - np.array([[[x, y]]], dtype=np.int32)
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.drawContours(mask, [local_contour], -1, 255, thickness=cv2.FILLED)
        mask = cv2.erode(mask, erode_kernel)
        gray_crop = gray[y:y + height, x:x + width]
        inside = gray_crop[mask > 0]
        if not inside.size:
            continue
        background_pixels = inside[inside > BUBBLE_BG_MIN_VALUE]
        if not background_pixels.size:
            continue
        background = float(np.median(background_pixels))
        uniform = np.abs(inside.astype(np.float32) - background) <= BUBBLE_UNIFORM_TOLERANCE
        if np.count_nonzero(uniform) / inside.size < BUBBLE_UNIFORM_MIN_RATIO:
            continue
        ink = (gray_crop < background * BUBBLE_INK_RATIO) & (mask > 0)
        binary = np.full(gray_crop.shape, 255, dtype=np.uint8)
        binary[ink] = 0
        enlarged = cv2.resize(
            binary, None, fx=BUBBLE_SCALE, fy=BUBBLE_SCALE,
            interpolation=cv2.INTER_CUBIC,
        )
        padded = cv2.copyMakeBorder(
            enlarged, BUBBLE_PADDING, BUBBLE_PADDING, BUBBLE_PADDING, BUBBLE_PADDING,
            cv2.BORDER_CONSTANT, value=255,
        )
        regions.append((Image.fromarray(padded).convert("RGB"), x, y))
    regions.sort(key=lambda region: (region[2], region[1]))
    return regions


def _bubble_region_confidence(lines: list[OcrLine]) -> float:
    """Approximate the region's word mean; Tesseract lines already contain word means."""
    weighted = []
    for line in lines:
        if not line.text.strip():
            continue
        words = max(1, len(line.text.split()))
        confidence = max(0.0, min(1.0, float(line.confidence)))
        weighted.append((words, confidence))
    total = sum(words for words, _ in weighted)
    if not total:
        return 0.0
    return 100.0 * sum(words * confidence for words, confidence in weighted) / total


def _recognize_bubble_lines(engine: Any, image: Image.Image, language: str) -> list[OcrLine]:
    # Only Tesseract needs a different page-segmentation mode for a single bubble.
    recognizer = getattr(engine, "recognize_bubble", None)
    return recognizer(image, language) if callable(recognizer) else engine.recognize(image, language)


def _recognize_bubble(
    engine: Any,
    image: Image.Image,
    language: str,
    min_confidence: float,
) -> list[dict[str, Any]]:
    regions = _bubble_preprocess_regions(image)
    blocks: list[dict[str, Any]] = []
    for prepared, offset_x, offset_y in sorted(regions, key=lambda region: (region[2], region[1])):
        lines = [line for line in _recognize_bubble_lines(engine, prepared, language) if line.text.strip()]
        if not lines or _bubble_region_confidence(lines) < BUBBLE_MIN_REGION_CONFIDENCE:
            continue
        restored = []
        for line in lines:
            if line.confidence < min_confidence:
                continue
            polygon = [[
                (x - BUBBLE_PADDING) / BUBBLE_SCALE + offset_x,
                (y - BUBBLE_PADDING) / BUBBLE_SCALE + offset_y,
            ] for x, y in line.polygon]
            restored.append(OcrLine(line.text, line.confidence, polygon))
        restored.sort(key=lambda line: (
            round(((line.box[1] + line.box[3]) / 2) / 12) * 12,
            line.box[0], line.box[1],
        ))
        blocks.extend(_blocks_from_lines(restored))
    for index, block in enumerate(blocks, start=1):
        block["id"] = index
    return blocks


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
    *,
    page_mode: str = "auto",
) -> list[dict[str, Any]]:
    """Run the established OCR first; optional fallbacks only compete after a weak result."""
    primary = _recognize_image_primary(
        engine, image, language, contrast, precise, min_confidence, page_mode=page_mode,
    )
    if isinstance(engine, IsolatedOcrEngine) and primary:
        return primary
    if not _needs_extra_preprocess(primary):
        return primary
    best = primary
    if EXTRA_PREPROCESS_ENABLED:
        emit("نتیجهٔ OCR اصلی ضعیف یا کوتاه است؛ پیش‌پردازش تکمیلی متن روشن اجرا می‌شود")
        try:
            fallback_image = _extra_preprocess_image(image)
            fallback = _recognize_image_primary(
                engine, fallback_image, language, False, False, min_confidence,
                input_scale=EXTRA_PREPROCESS_SCALE, page_mode=page_mode,
            )
        except Exception:
            # An optional preprocessing backend must never break the established OCR result.
            emit("پیش‌پردازش تکمیلی ممکن نبود؛ نتیجهٔ OCR اصلی حفظ شد", "warning")
        else:
            if _better_fallback(fallback, best):
                emit("نتیجهٔ پیش‌پردازش تکمیلی بهتر بود و انتخاب شد", "success")
                best = fallback
            else:
                emit("نتیجهٔ OCR اصلی بهتر بود و حفظ شد")
    if BUBBLE_PREPROCESS_ENABLED and page_mode != "document":
        emit("پیش‌پردازش حباب کمیک برای مقایسه اجرا می‌شود")
        try:
            bubble = _recognize_bubble(engine, image, language, min_confidence)
        except Exception:
            emit("پیش‌پردازش حباب ممکن نبود؛ بهترین نتیجهٔ فعلی حفظ شد", "warning")
        else:
            if _better_fallback(bubble, best):
                emit("نتیجهٔ پیش‌پردازش حباب بهتر بود و انتخاب شد", "success")
                best = bubble
            else:
                emit("نتیجهٔ حباب بهتر نبود؛ بهترین نتیجهٔ فعلی حفظ شد")
    return best
