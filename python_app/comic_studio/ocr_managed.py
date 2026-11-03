from __future__ import annotations

import atexit
from concurrent.futures import ThreadPoolExecutor, as_completed
import ctypes
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable
import urllib.request
import zipfile

import numpy as np
from PIL import Image

from .activity import emit
from .paths import models_dir

_SUBPROCESS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
_HW_CACHE_LOCK = threading.Lock()
_HW_CACHE: tuple[float, dict[str, Any]] | None = None
_MANIFEST_LOCK = threading.Lock()
_UPDATE_CACHE_LOCK = threading.Lock()
_UPDATE_CACHE_TTL_SECONDS = 1800

DEFAULT_TESSERACT_WIN_TAG = "v5.4.0.20240606"
DEFAULT_TESSERACT_WIN_URL = (
    "https://github.com/UB-Mannheim/tesseract/releases/download/"
    "v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe"
)

BUILTIN_ENGINE_META: dict[str, dict[str, Any]] = {
    "rapidocr-v6": {
        "primary_pkg": "rapidocr",
        "pypi_pkg": "rapidocr",
        "github_repo": "RapidAI/RapidOCR",
        "download_size_gb": 0.06,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 0.4,
        "category": "standard",
    },
    "rapidocr-v5": {
        "primary_pkg": "rapidocr",
        "pypi_pkg": "rapidocr",
        "github_repo": "RapidAI/RapidOCR",
        "download_size_gb": 0.08,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 0.4,
        "category": "standard",
    },
    "easyocr": {
        "primary_pkg": "easyocr",
        "pypi_pkg": "easyocr",
        "github_repo": "JaidedAI/EasyOCR",
        "download_size_gb": 0.65,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 1.8,
        "category": "standard",
    },
    "tesseract": {
        "primary_pkg": None,
        "pypi_pkg": None,
        "github_repo": "UB-Mannheim/tesseract",
        "tessdata_repo": "tesseract-ocr/tessdata_fast",
        "download_size_gb": 0.09,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 0.35,
        "category": "standard",
    },
}

ISOLATED_ENGINE_SPECS: dict[str, dict[str, Any]] = {
    "paddleocr-vl-1-6": {
        "primary_pkg": "paddleocr",
        "dist_name": "paddleocr",
        "pypi_pkg": "paddleocr",
        "github_repo": "PaddlePaddle/PaddleOCR",
        "hf_repo": None,
        "pip_packages_cpu": ["paddlepaddle>=3.2.1", "paddleocr[doc-parser]>=3.3.0", "pillow>=10.3"],
        "pip_packages_gpu": ["paddlepaddle>=3.2.1", "paddleocr[doc-parser]>=3.3.0", "pillow>=10.3"],
        "needs_torch": False,
        "needs_regions": False,
        "download_size_gb": 2.4,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 4.5,
        "category": "advanced",
    },
    "surya": {
        "primary_pkg": "surya-ocr",
        "dist_name": "surya_ocr",
        "pypi_pkg": "surya-ocr",
        "github_repo": "datalab-to/surya",
        "hf_repo": None,
        "pip_packages_cpu": ["surya-ocr>=0.14.0", "huggingface-hub>=0.25.0"],
        "pip_packages_gpu": ["surya-ocr>=0.14.0", "huggingface-hub>=0.25.0"],
        "needs_torch": False,
        "needs_llama_cpp_cpu": True,
        "needs_regions": False,
        "download_size_gb": 2.2,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 4.0,
        "category": "advanced",
    },
    "mineru-2-5-pro": {
        "primary_pkg": "mineru",
        "dist_name": "mineru",
        "pypi_pkg": "mineru",
        "github_repo": "opendatalab/MinerU",
        "hf_repo": None,
        "pip_packages_cpu": ["mineru>=2.0.0", "pillow>=11.0.0"],
        "pip_packages_gpu": ["mineru>=2.0.0", "pillow>=11.0.0"],
        "needs_torch": False,
        "needs_regions": False,
        "download_size_gb": 3.0,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 5.5,
        "category": "advanced",
    },
    "got-ocr-2": {
        "primary_pkg": "transformers",
        "dist_name": "transformers",
        "pypi_pkg": "transformers",
        "github_repo": "Ucas-HaoranWei/GOT-OCR2.0",
        "hf_repo": "stepfun-ai/GOT-OCR-2.0-hf",
        "pip_packages_cpu": ["transformers>=4.49.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3", "tiktoken", "verovio"],
        "pip_packages_gpu": ["transformers>=4.49.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3", "tiktoken", "verovio"],
        "needs_torch": True,
        "needs_regions": True,
        "download_size_gb": 1.8,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 3.8,
        "category": "advanced",
    },
    "glm-ocr": {
        "primary_pkg": "glmocr",
        "dist_name": "glmocr",
        "pypi_pkg": "glmocr",
        "github_repo": "zai-org/GLM-OCR",
        "hf_repo": "zai-org/GLM-OCR",
        "pip_packages_cpu": ["glmocr>=0.1.0", "transformers>=5.0.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=12.1.0"],
        "pip_packages_gpu": ["glmocr>=0.1.0", "transformers>=5.0.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=12.1.0"],
        "needs_torch": True,
        "needs_regions": True,
        "download_size_gb": 2.4,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 4.8,
        "category": "advanced",
    },
    "dots-ocr": {
        "primary_pkg": "transformers",
        "dist_name": "transformers",
        "pypi_pkg": "transformers",
        "github_repo": "studio-dots-ai/dots.ocr",
        "hf_repo": "rednote-hilab/dots.mocr",
        "pip_packages_cpu": ["transformers>=4.51.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "pip_packages_gpu": ["transformers>=4.51.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "needs_torch": True,
        "needs_regions": True,
        "download_size_gb": 4.5,
        "requires_nvidia_gpu": True,
        "min_vram_gb": 8.0,
        "min_disk_gb": 8.0,
        "category": "advanced",
    },
    "deepseek-ocr-2": {
        "primary_pkg": "transformers",
        "dist_name": "transformers",
        "pypi_pkg": "transformers",
        "github_repo": "deepseek-ai/DeepSeek-OCR-2",
        "hf_repo": "deepseek-ai/DeepSeek-OCR-2",
        "pip_packages_cpu": ["transformers>=4.51.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3", "einops", "addict", "easydict"],
        "pip_packages_gpu": ["transformers>=4.51.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3", "einops", "addict", "easydict"],
        "needs_torch": True,
        "needs_regions": True,
        "download_size_gb": 7.5,
        "requires_nvidia_gpu": True,
        "min_vram_gb": 12.0,
        "min_disk_gb": 13.0,
        "category": "advanced",
    },
    "olmocr": {
        "primary_pkg": "olmocr",
        "dist_name": "olmocr",
        "pypi_pkg": "olmocr",
        "github_repo": "allenai/olmocr",
        "hf_repo": "allenai/olmOCR-2-7B-1025",
        "pip_packages_cpu": ["olmocr>=0.4.0", "transformers>=4.51.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "pip_packages_gpu": ["olmocr>=0.4.0", "transformers>=4.51.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "needs_torch": True,
        "needs_regions": True,
        "download_size_gb": 15.0,
        "requires_nvidia_gpu": True,
        "min_vram_gb": 16.0,
        "min_disk_gb": 24.0,
        "category": "advanced",
    },
    "hunyuan-ocr": {
        "primary_pkg": "transformers",
        "dist_name": "transformers",
        "pypi_pkg": "transformers",
        "github_repo": "Tencent-Hunyuan/HunyuanOCR",
        "hf_repo": "tencent/HunyuanOCR",
        "pip_packages_cpu": ["transformers>=5.13.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "pip_packages_gpu": ["transformers>=5.13.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "needs_torch": True,
        "needs_regions": True,
        "download_size_gb": 20.0,
        "requires_nvidia_gpu": True,
        "min_vram_gb": 24.0,
        "min_disk_gb": 32.0,
        "category": "advanced",
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_Subprocess(command: list[str] | str, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    if os.name == "nt" and "creationflags" not in kwargs:
        kwargs["creationflags"] = _SUBPROCESS_NO_WINDOW
    return subprocess.run(command, **kwargs)


def _detect_system_ram_gb() -> float:
    try:
        if os.name == "nt":
            class _MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MemoryStatusEx()
            stat.dwLength = ctypes.sizeof(_MemoryStatusEx)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return round(stat.ullTotalPhys / (1024 ** 3), 1)
        elif hasattr(os, "sysconf") and "SC_PAGE_SIZE" in os.sysconf_names and "SC_PHYS_PAGES" in os.sysconf_names:
            total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
            if total > 0:
                return round(total / (1024 ** 3), 1)
    except Exception:
        pass
    return 0.0


def _detect_nvidia_gpu() -> tuple[bool, str, float]:
    smi = shutil.which("nvidia-smi")
    if not smi and os.name == "nt":
        win_smi = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "NVIDIA Corporation" / "NVSMI" / "nvidia-smi.exe"
        sys_smi = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe"
        for candidate in (sys_smi, win_smi):
            if candidate.is_file():
                smi = str(candidate)
                break
    if not smi:
        return False, "", 0.0
    try:
        proc = _run_Subprocess(
            [smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return False, "", 0.0
        best_name = ""
        best_vram_mb = 0.0
        for line in proc.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if not parts or not parts[0]:
                continue
            vram_mb = 0.0
            if len(parts) > 1:
                try:
                    vram_mb = float(parts[1])
                except ValueError:
                    vram_mb = 0.0
            if not best_name or vram_mb >= best_vram_mb:
                best_name = parts[0]
                best_vram_mb = vram_mb
        if best_name:
            return True, best_name, round(best_vram_mb / 1024.0, 1)
    except Exception:
        pass
    return False, "", 0.0


def inspect_hardware(force_refresh: bool = False) -> dict[str, Any]:
    override = os.environ.get("COMIC_STUDIO_FAKE_HARDWARE_JSON")
    if override:
        try:
            parsed = json.loads(override)
            if isinstance(parsed, dict):
                disk_val = parsed.get("freeDiskGb", parsed.get("diskFreeGb", 100.0))
                gpu_name = str(parsed.get("gpuName") or ((parsed.get("gpuNames") or [""])[0] if isinstance(parsed.get("gpuNames"), list) else ""))
                return {
                    "hasNvidiaGpu": bool(parsed.get("hasNvidiaGpu", False)),
                    "gpuName": gpu_name,
                    "vramGb": float(parsed.get("vramGb", 0.0)),
                    "ramGb": float(parsed.get("ramGb", 16.0)),
                    "freeDiskGb": float(disk_val),
                }
        except Exception:
            pass

    global _HW_CACHE
    now = time.monotonic()
    with _HW_CACHE_LOCK:
        if not force_refresh and _HW_CACHE is not None and (now - _HW_CACHE[0]) < 60.0:
            base = dict(_HW_CACHE[1])
        else:
            has_gpu, gpu_name, vram_gb = _detect_nvidia_gpu()
            ram_gb = _detect_system_ram_gb()
            base = {
                "hasNvidiaGpu": has_gpu,
                "gpuName": gpu_name,
                "vramGb": vram_gb,
                "ramGb": ram_gb,
            }
            _HW_CACHE = (now, dict(base))
    target_dir = models_dir()
    probe = target_dir if target_dir.exists() else (target_dir.parent if target_dir.parent.exists() else Path.home())
    try:
        free_disk_gb = round(shutil.disk_usage(probe).free / (1024 ** 3), 1)
    except Exception:
        free_disk_gb = 0.0
    base["freeDiskGb"] = free_disk_gb
    return base


def engine_meta(engine_id: str) -> dict[str, Any]:
    return ISOLATED_ENGINE_SPECS.get(engine_id) or BUILTIN_ENGINE_META.get(engine_id, {})


def evaluate_engine_hardware(engine_id: str, hw: dict[str, Any] | None = None) -> dict[str, Any]:
    hw_info = hw or inspect_hardware()
    meta = engine_meta(engine_id)
    requires_gpu = bool(meta.get("requires_nvidia_gpu", False))
    min_vram = float(meta.get("min_vram_gb", 0.0) or 0.0)
    min_disk = float(meta.get("min_disk_gb", 0.0) or 0.0)
    warnings: list[str] = []

    if requires_gpu and not hw_info.get("hasNvidiaGpu"):
        vram_note = f" با حداقل {min_vram:g} گیگابایت حافظهٔ گرافیکی" if min_vram > 0 else ""
        warnings.append(
            f"این مدل برای اجرا به کارت گرافیک NVIDIA{vram_note} نیاز دارد، اما کارت گرافیک NVIDIA روی این سیستم شناسایی نشد."
        )
    elif min_vram > 0 and hw_info.get("hasNvidiaGpu") and float(hw_info.get("vramGb", 0.0)) > 0:
        actual_vram = float(hw_info["vramGb"])
        if actual_vram + 0.5 < min_vram:
            warnings.append(
                f"حافظهٔ کارت گرافیک شما ({actual_vram:g} گیگابایت) کمتر از حداقل پیشنهادی این مدل ({min_vram:g} گیگابایت) است و ممکن است هنگام اجرا با کمبود حافظه مواجه شود."
            )

    free_disk = float(hw_info.get("freeDiskGb", hw_info.get("diskFreeGb", 0.0)) or 0.0)
    if min_disk > 0 and free_disk > 0 and free_disk < min_disk:
        warnings.append(
            f"فضای خالی دیسک ({free_disk:.1f} گیگابایت) کمتر از فضای پیشنهادی نصب این مدل (حدود {min_disk:g} گیگابایت) است."
        )

    return {
        "compatible": len(warnings) == 0,
        "warnings": warnings,
        "hasNvidiaGpu": bool(hw_info.get("hasNvidiaGpu")),
        "gpuName": str(hw_info.get("gpuName") or ""),
        "vramGb": float(hw_info.get("vramGb") or 0.0),
        "ramGb": float(hw_info.get("ramGb") or 0.0),
        "freeDiskGb": free_disk,
    }


def _manifest_path() -> Path:
    return models_dir() / "manifest.json"


def read_manifest() -> dict[str, dict[str, Any]]:
    path = _manifest_path()
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def update_manifest_entry(engine_id: str, **fields: Any) -> dict[str, Any]:
    with _MANIFEST_LOCK:
        data = read_manifest()
        current = dict(data.get(engine_id) or {})
        current.update({k: v for k, v in fields.items() if v is not None})
        current.setdefault("installedAt", _now_iso())
        current["updatedAt"] = _now_iso()
        data[engine_id] = current
        path = _manifest_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
        return current


def _version_tuple(raw: str | None) -> tuple[int, ...]:
    if not raw:
        return ()
    cleaned = str(raw).strip().lstrip("vV")
    nums = [int(part) for part in re.findall(r"\d+", cleaned)]
    while len(nums) > 1 and nums[-1] == 0:
        nums.pop()
    return tuple(nums)


def is_newer_version(installed: str | None, latest: str | None) -> bool:
    if not installed or not latest:
        return False
    a = str(installed).strip().lstrip("vV")
    b = str(latest).strip().lstrip("vV")
    if a == b:
        return False
    try:
        from packaging.version import Version
        return Version(b) > Version(a)
    except Exception:
        ta, tb = _version_tuple(a), _version_tuple(b)
        return bool(ta and tb and tb > ta)


def portable_tesseract_executable() -> str | None:
    base = models_dir() / "tesseract-bin"
    candidates = (
        [base / "tesseract.exe", base / "Tesseract-OCR" / "tesseract.exe"]
        if os.name == "nt"
        else [base / "bin" / "tesseract", base / "tesseract"]
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def detect_tesseract_version(executable: str | None) -> str | None:
    if not executable:
        return None
    try:
        proc = _run_Subprocess([executable, "--version"], capture_output=True, text=True, timeout=10, check=False)
        first_line = (proc.stdout or proc.stderr or "").splitlines()[0] if (proc.stdout or proc.stderr) else ""
        match = re.search(r"tesseract\s+v?([0-9][0-9A-Za-z._-]*)", first_line, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    except Exception:
        pass
    return None


def _fetch_json(url: str, timeout: float = 8.0) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Comic-OCR-Studio",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _latest_tesseract_windows_installer() -> tuple[str, str]:
    try:
        rel = _fetch_json("https://api.github.com/repos/UB-Mannheim/tesseract/releases/latest", timeout=10.0)
        tag = str(rel.get("tag_name") or DEFAULT_TESSERACT_WIN_TAG).lstrip("vV")
        for asset in rel.get("assets") or []:
            name = str(asset.get("name") or "").lower()
            dl_url = str(asset.get("browser_download_url") or "")
            if dl_url and "w64" in name and name.endswith(".exe"):
                return tag, dl_url
    except Exception:
        pass
    return DEFAULT_TESSERACT_WIN_TAG.lstrip("vV"), DEFAULT_TESSERACT_WIN_URL


def install_tesseract_runtime(error_cls: type[Exception]) -> str:
    target_dir = models_dir() / "tesseract-bin"
    target_dir.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        version_tag, installer_url = _latest_tesseract_windows_installer()
        installer_path = target_dir / f"tesseract-setup-{version_tag}.exe"
        part_path = target_dir / f".tesseract-setup-{version_tag}.exe.part"
        try:
            emit(f"دریافت خودکار موتور اجرایی Tesseract ({version_tag}) برای ویندوز آغاز شد")
            req = urllib.request.Request(installer_url, headers={"User-Agent": "Comic-OCR-Studio"})
            with urllib.request.urlopen(req, timeout=300) as resp, part_path.open("wb") as out:
                total = 0
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    out.write(chunk)
                    emit(f"دانلود موتور Tesseract: {total / (1024 * 1024):.1f} مگابایت دریافت شد")
                    if total > 220 * 1024 * 1024:
                        raise error_cls("Downloaded Tesseract installer exceeded safe size limit.")
            if part_path.stat().st_size < 1_000_000:
                raise error_cls("Downloaded Tesseract installer is incomplete or invalid.")
            os.replace(part_path, installer_path)
            emit("نصب بی‌صدای Tesseract در پوشهٔ اختصاصی برنامه در حال انجام است…")
            # NSIS requires /D=... unquoted as the final argument on the command line.
            cmdline = f'"{installer_path}" /S /D={target_dir}'
            proc = _run_Subprocess(cmdline, shell=True, capture_output=True, text=True, timeout=600, check=False)
            exe = portable_tesseract_executable()
            if proc.returncode != 0 or not exe:
                winget = shutil.which("winget")
                if winget:
                    emit("تلاش جایگزین برای نصب خودکار Tesseract از طریق Winget…")
                    _run_Subprocess(
                        [
                            winget, "install", "--id", "UB-Mannheim.TesseractOCR",
                            "--silent", "--accept-package-agreements", "--accept-source-agreements",
                            "--scope", "user",
                        ],
                        capture_output=True, text=True, timeout=600, check=False,
                    )
        except error_cls:
            raise
        except Exception as exc:
            raise error_cls(f"نصب خودکار موتور اجرایی Tesseract ناموفق بود: {exc}") from exc
        finally:
            part_path.unlink(missing_ok=True)
            installer_path.unlink(missing_ok=True)
        exe = portable_tesseract_executable() or shutil.which("tesseract")
        if not exe:
            for candidate in (
                Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe",
                Path(os.environ.get("LocalAppData", str(Path.home() / "AppData" / "Local"))) / "Programs" / "Tesseract-OCR" / "tesseract.exe",
            ):
                if candidate.is_file():
                    exe = str(candidate)
                    break
        if not exe:
            raise error_cls("فایل اجرایی Tesseract پس از نصب خودکار پیدا نشد؛ دسترسی پوشهٔ برنامه را بررسی کنید.")
        emit("موتور اجرایی Tesseract با موفقیت آماده شد", "success")
        return exe

    if sys.platform.startswith("linux"):
        apt = shutil.which("apt-get")
        can_root = hasattr(os, "geteuid") and os.geteuid() == 0
        can_sudo = False
        if not can_root and shutil.which("sudo"):
            probe = _run_Subprocess(["sudo", "-n", "true"], capture_output=True, timeout=5, check=False)
            can_sudo = proc_ok(probe)
        if apt and (can_root or can_sudo):
            prefix = [] if can_root else ["sudo", "-n"]
            emit("نصب خودکار بستهٔ سیستمی tesseract-ocr آغاز شد…")
            _run_Subprocess([*prefix, apt, "update"], capture_output=True, timeout=180, check=False)
            install_proc = _run_Subprocess([*prefix, apt, "install", "-y", "tesseract-ocr"], capture_output=True, text=True, timeout=300, check=False)
            exe = shutil.which("tesseract")
            if proc_ok(install_proc) and exe:
                emit("موتور اجرایی Tesseract با موفقیت نصب شد", "success")
                return exe
    raise error_cls(
        "نصب خودکار فایل اجرایی Tesseract در ویندوز پشتیبانی می‌شود؛ در این سیستم لینوکس بستهٔ tesseract-ocr را یک‌بار نصب کنید یا از مدل‌های دیگر استفاده کنید."
    )


def proc_ok(proc: subprocess.CompletedProcess[Any]) -> bool:
    return proc.returncode == 0


def _split_tall_book_region(
    bw_grad: np.ndarray,
    box: list[float],
    page_w: int,
    page_h: int,
) -> list[list[float]]:
    """Split a tall book/article text block along clean horizontal paragraph gaps."""
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    bh = y1 - y0
    bw = x1 - x0
    if bh < max(260, int(page_h * 0.42)) or bw < max(120, int(page_w * 0.25)):
        return [box]
    sub = bw_grad[max(0, y0):min(page_h, y1), max(0, x0):min(page_w, x1)]
    if sub.size == 0:
        return [box]
    row_ink = np.count_nonzero(sub > 0, axis=1)
    quiet_thresh = max(1, int(bw * 0.008))
    min_gap = max(6, bh // 90)
    spans: list[tuple[int, int]] = []
    in_text = False
    seg_start = 0
    quiet_run = 0
    for r, count in enumerate(row_ink):
        if count > quiet_thresh:
            if not in_text:
                seg_start = r
                in_text = True
            quiet_run = 0
        elif in_text:
            quiet_run += 1
            if quiet_run >= min_gap:
                seg_end = r - quiet_run + 1
                if seg_end - seg_start >= 10:
                    spans.append((seg_start, seg_end))
                in_text = False
                quiet_run = 0
    if in_text and len(row_ink) - seg_start >= 10:
        spans.append((seg_start, len(row_ink)))
    if len(spans) <= 1:
        return [box]

    target_h = max(160, int(page_h * 0.26))
    chunks: list[list[int]] = []
    for s0, s1 in spans:
        if not chunks:
            chunks.append([s0, s1])
            continue
        prev_h = chunks[-1][1] - chunks[-1][0]
        gap = s0 - chunks[-1][1]
        if prev_h + (s1 - chunks[-1][0]) <= target_h and gap <= max(18, min_gap * 2):
            chunks[-1][1] = s1
        else:
            chunks.append([s0, s1])
    if len(chunks) <= 1:
        return [box]

    out: list[list[float]] = []
    for c0, c1 in chunks:
        cy0 = max(0, y0 + c0 - 4)
        cy1 = min(page_h, y0 + c1 + 4)
        if cy1 - cy0 >= 10:
            out.append([float(x0), float(cy0), float(x1), float(cy1)])
    return out or [box]


def detect_comic_text_regions(
    image: Image.Image,
    *,
    page_mode: str = "auto",
) -> list[list[float]]:
    """Detect candidate comic bubble, paragraph, and column regions for crop-based VLM recognizers."""
    import cv2
    from .ocr_grouping import sort_document_reading_order

    rgb = np.asarray(image.convert("RGB"))
    height, width = rgb.shape[:2]
    if width < 24 or height < 24:
        return [[0.0, 0.0, float(width), float(height)]]

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    grad_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    grad = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, grad_kernel)
    _, bw = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    connect_w = max(9, min(35, width // 36))
    connect_h = max(4, min(15 if page_mode == "document" else 21, height // (75 if page_mode == "document" else 60)))
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (connect_w, connect_h))
    connected = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, close_kernel)
    contours, _ = cv2.findContours(connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = max(140, int(width * height * 0.00025))
    max_area = int(width * height * 0.985)

    def _collect_boxes(contour_list: Any) -> list[list[float]]:
        collected: list[list[float]] = []
        for contour in contour_list:
            x, y, w, h = cv2.boundingRect(contour)
            area = w * h
            if area < min_area or area > max_area or w < 14 or h < 10:
                continue
            pad_x = min(12, max(4, w // 12))
            pad_y = min(10, max(4, h // 10))
            collected.append([
                float(max(0, x - pad_x)),
                float(max(0, y - pad_y)),
                float(min(width, x + w + pad_x)),
                float(min(height, y + h + pad_y)),
            ])
        return collected

    raw_boxes = _collect_boxes(contours)
    if not raw_boxes:
        all_contours, _ = cv2.findContours(connected, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        raw_boxes = _collect_boxes(all_contours)

    if not raw_boxes:
        return [[0.0, 0.0, float(width), float(height)]]

    merged = _merge_overlapping_boxes(raw_boxes)
    if page_mode != "comic":
        refined: list[list[float]] = []
        for box in merged:
            refined.extend(_split_tall_book_region(bw, box, width, height))
        merged = refined

    if page_mode == "comic":
        merged.sort(key=lambda b: (round(((b[1] + b[3]) * 0.5) / 24.0) * 24.0, b[0], b[1]))
    else:
        pseudo_blocks = [
            {"x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3], "lineH": max(12.0, min(32.0, (b[3] - b[1]) * 0.25))}
            for b in merged
        ]
        ordered_pseudo = sort_document_reading_order(pseudo_blocks, page_size=(width, height))
        merged = [[float(p["x0"]), float(p["y0"]), float(p["x1"]), float(p["y1"])] for p in ordered_pseudo]

    return merged[:160]


detect_text_regions = detect_comic_text_regions


def _merge_overlapping_boxes(boxes: list[list[float]]) -> list[list[float]]:
    result = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        next_boxes: list[list[float]] = []
        used = [False] * len(result)
        for i in range(len(result)):
            if used[i]:
                continue
            ax0, ay0, ax1, ay1 = result[i]
            for j in range(i + 1, len(result)):
                if used[j]:
                    continue
                bx0, by0, bx1, by1 = result[j]
                ix0, iy0 = max(ax0, bx0), max(ay0, by0)
                ix1, iy1 = min(ax1, bx1), min(ay1, by1)
                if ix1 >= ix0 - 6 and iy1 >= iy0 - 6:
                    ax0, ay0 = min(ax0, bx0), min(ay0, by0)
                    ax1, ay1 = max(ax1, bx1), max(ay1, by1)
                    used[j] = True
                    changed = True
            next_boxes.append([ax0, ay0, ax1, ay1])
        result = next_boxes
    return result


def _read_dist_version_in_venv(env_dir: Path, dist_name: str) -> str | None:
    candidates: list[Path] = []
    if os.name == "nt":
        candidates.append(env_dir / "Lib" / "site-packages")
    else:
        lib_dir = env_dir / "lib"
        if lib_dir.is_dir():
            candidates.extend(sorted(lib_dir.glob("python*/site-packages")))
    normalized = re.sub(r"[-_.]+", "_", dist_name.lower())
    for sp in candidates:
        if not sp.is_dir():
            continue
        for dist_info in sp.glob("*.dist-info"):
            stem = dist_info.name[:-10]
            pkg_part = stem.rsplit("-", 1)[0] if "-" in stem else stem
            if re.sub(r"[-_.]+", "_", pkg_part.lower()) != normalized:
                continue
            meta_file = dist_info / "METADATA"
            if meta_file.is_file():
                try:
                    for line in meta_file.read_text(encoding="utf-8", errors="replace").splitlines():
                        if line.lower().startswith("version:"):
                            return line.split(":", 1)[1].strip()
                except Exception:
                    pass
    return None


def _worker_script_path() -> Path:
    return Path(__file__).with_name("ocr_worker.py")


class IsolatedOcrEngine:
    """Self-managed OCR / VLM engine isolated in its own per-model virtual environment."""

    def __init__(
        self,
        engine_id: str,
        languages: list[str],
        install_lock: threading.Lock,
        line_factory: Callable[[str, float, list[list[float]]], Any],
        error_cls: type[Exception],
    ) -> None:
        self.id = engine_id
        self._languages = list(languages)
        self._install_lock = install_lock
        self._line_factory = line_factory
        self._error_cls = error_cls
        self._spec = ISOLATED_ENGINE_SPECS[engine_id]
        self._worker_lock = threading.Lock()
        self._worker_proc: subprocess.Popen[str] | None = None
        atexit.register(self.close)

    def _env_dir(self) -> Path:
        return models_dir() / "envs" / self.id

    def _env_python(self) -> Path:
        if os.name == "nt":
            return self._env_dir() / "Scripts" / "python.exe"
        return self._env_dir() / "bin" / "python"

    def _state_dir(self) -> Path:
        return models_dir() / "isolated" / self.id

    @property
    def runtime_installed(self) -> bool:
        return self._env_python().is_file() and (self._env_dir() / ".runtime-ready").is_file()

    @property
    def ready_languages(self) -> list[str]:
        if not self.runtime_installed:
            return []
        state = self._state_dir()
        if (state / ".ready-all").is_file():
            return list(self._languages)
        return [lang for lang in self._languages if (state / f".ready-{lang}").is_file()]

    @property
    def model_ready(self) -> bool:
        return bool(self.ready_languages)

    @property
    def installed_version(self) -> str | None:
        if not self.runtime_installed:
            return None
        ver = _read_dist_version_in_venv(self._env_dir(), self._spec["dist_name"])
        if ver:
            return ver
        entry = read_manifest().get(self.id) or {}
        return entry.get("installedVersion")

    def close(self) -> None:
        with self._worker_lock:
            proc = self._worker_proc
            self._worker_proc = None
            if proc is not None and proc.poll() is None:
                try:
                    if proc.stdin:
                        proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                        proc.stdin.flush()
                    proc.wait(timeout=3)
                except Exception:
                    proc.kill()

    def _worker_env(self) -> dict[str, str]:
        env = dict(os.environ)
        llama_bin = self._env_dir() / "llama-bin"
        scripts_dir = self._env_python().parent
        extra_paths = [str(scripts_dir)]
        if llama_bin.is_dir():
            extra_paths.insert(0, str(llama_bin))
        env["PATH"] = os.pathsep.join([*extra_paths, env.get("PATH", "")])
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def _ensure_llama_cpp_for_surya(self) -> None:
        if not self._spec.get("needs_llama_cpp_cpu"):
            return
        hw = inspect_hardware()
        if hw.get("hasNvidiaGpu") or shutil.which("llama-server"):
            return
        llama_dir = self._env_dir() / "llama-bin"
        exe_name = "llama-server.exe" if os.name == "nt" else "llama-server"
        if any(llama_dir.rglob(exe_name)):
            return
        emit("دریافت خودکار موتور کمکی llama-server برای اجرای Surya روی پردازنده (CPU)…")
        rel = _fetch_json("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", timeout=15.0)
        wanted_url = ""
        for asset in rel.get("assets") or []:
            name = str(asset.get("name") or "").lower()
            dl = str(asset.get("browser_download_url") or "")
            if os.name == "nt" and "win" in name and "cpu" in name and "x64" in name and name.endswith(".zip"):
                wanted_url = dl
                break
            if sys.platform.startswith("linux") and "ubuntu" in name and "x64" in name and name.endswith(".zip"):
                wanted_url = dl
                break
        if not wanted_url:
            return
        llama_dir.mkdir(parents=True, exist_ok=True)
        zip_tmp = llama_dir / ".llama-bin.zip.part"
        try:
            req = urllib.request.Request(wanted_url, headers={"User-Agent": "Comic-OCR-Studio"})
            with urllib.request.urlopen(req, timeout=300) as resp, zip_tmp.open("wb") as out:
                total = 0
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    out.write(chunk)
                    emit(f"دانلود موتور کمکی CPU برای Surya: {total / (1024 * 1024):.1f} مگابایت")
            with zipfile.ZipFile(zip_tmp) as archive:
                for member in archive.infolist():
                    member_path = (llama_dir / member.filename).resolve()
                    if not str(member_path).startswith(str(llama_dir.resolve())):
                        continue
                    archive.extract(member, llama_dir)
            for found in llama_dir.rglob(exe_name):
                if found.parent != llama_dir:
                    for item in found.parent.iterdir():
                        dest = llama_dir / item.name
                        if not dest.exists():
                            shutil.move(str(item), str(dest))
                if os.name != "nt":
                    (llama_dir / exe_name).chmod(0o755)
                break
        finally:
            zip_tmp.unlink(missing_ok=True)

    def _ensure_isolated_venv(self, upgrade: bool = False) -> None:
        env_dir = self._env_dir()
        py = self._env_python()
        hw = inspect_hardware()
        with self._install_lock:
            if not py.is_file():
                emit(f"ساخت پوشه و محیط مستقل برای مدل {self.id}…")
                env_dir.parent.mkdir(parents=True, exist_ok=True)
                res = _run_Subprocess([sys.executable, "-m", "venv", str(env_dir)], capture_output=True, text=True, timeout=300, check=False)
                if res.returncode != 0 or not py.is_file():
                    raise self._error_cls(f"ساخت محیط مستقل برای {self.id} ناموفق بود: {(res.stderr or res.stdout)[-800:]}")
                _run_Subprocess([str(py), "-m", "ensurepip", "--upgrade"], capture_output=True, text=True, timeout=300, check=False)
                _run_Subprocess([str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], capture_output=True, text=True, timeout=600, check=False)

            if self._spec.get("needs_torch"):
                torch_cmd = [str(py), "-m", "pip", "install"]
                if upgrade:
                    torch_cmd.append("--upgrade")
                torch_cmd.extend(["torch>=2.3.0", "torchvision>=0.18.0"])
                if os.name == "nt" and hw.get("hasNvidiaGpu"):
                    torch_cmd.extend(["--extra-index-url", "https://download.pytorch.org/whl/cu126"])
                emit(f"نصب زیرساخت پردازش تصویر برای {self.id} (ممکن است چند دقیقه طول بکشد)…")
                t_res = _run_Subprocess(torch_cmd, capture_output=True, text=True, timeout=3600, check=False)
                if t_res.returncode != 0:
                    raise self._error_cls(f"نصب PyTorch برای {self.id} ناموفق بود: {(t_res.stderr or t_res.stdout)[-1200:]}")

            packages = self._spec["pip_packages_gpu"] if hw.get("hasNvidiaGpu") else self._spec["pip_packages_cpu"]
            pip_cmd = [str(py), "-m", "pip", "install"]
            if upgrade:
                pip_cmd.append("--upgrade")
            pip_cmd.extend(packages)
            emit(f"{'به‌روزرسانی' if upgrade else 'نصب'} بسته‌های اختصاصی مدل {self.id} آغاز شد…")
            p_res = _run_Subprocess(pip_cmd, capture_output=True, text=True, timeout=3600, check=False)
            if p_res.returncode != 0:
                details = (p_res.stderr or p_res.stdout or "pip failed")[-1500:].strip()
                raise self._error_cls(f"نصب بسته‌های مدل {self.id} ناموفق بود: {details}")

            self._ensure_llama_cpp_for_surya()
            (env_dir / ".runtime-ready").write_text(_now_iso(), encoding="utf-8")

    def _prepare_weights(self, language: str) -> str:
        worker_script = _worker_script_path()
        emit(f"دریافت و آماده‌سازی فایل‌های مدل {self.id}…")
        proc = _run_Subprocess(
            [
                str(self._env_python()),
                str(worker_script),
                "--engine", self.id,
                "--models-root", str(models_dir()),
                "--prepare",
                "--language", language,
            ],
            env=self._worker_env(),
            capture_output=True,
            text=True,
            timeout=3600,
            check=False,
        )
        last_json: dict[str, Any] = {}
        for line in reversed((proc.stdout or "").splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    last_json = json.loads(line)
                    break
                except Exception:
                    continue
        if proc.returncode != 0 or not last_json.get("ok"):
            err = last_json.get("error") or (proc.stderr or proc.stdout or "weight download failed")[-1200:]
            raise self._error_cls(f"آماده‌سازی فایل‌های مدل {self.id} ناموفق بود: {err}")
        state = self._state_dir()
        state.mkdir(parents=True, exist_ok=True)
        (state / ".ready-all").write_text(_now_iso(), encoding="utf-8")
        (state / f".ready-{language}").write_text(_now_iso(), encoding="utf-8")
        return str(last_json.get("modelRevision") or "ready")

    def download(self, language: str = "eng") -> None:
        self.close()
        if not self.runtime_installed:
            self._ensure_isolated_venv(upgrade=False)
        revision = self._prepare_weights(language)
        ver = self.installed_version or "installed"
        update_manifest_entry(
            self.id,
            installedVersion=ver,
            modelRevision=revision,
            readyLanguages=self.ready_languages,
        )
        emit(f"مدل {self.id} آماده و قابل استفاده است", "success")

    def update(self, language: str = "eng") -> None:
        self.close()
        self._ensure_isolated_venv(upgrade=True)
        revision = self._prepare_weights(language)
        ver = self.installed_version or "installed"
        remote_rev = fetch_remote_repo_revision(self._spec.get("github_repo"))
        update_manifest_entry(
            self.id,
            installedVersion=ver,
            modelRevision=remote_rev or revision,
            readyLanguages=self.ready_languages,
        )
        clear_cached_engine_update(self.id, ver, remote_rev or revision)
        emit(f"مدل {self.id} با موفقیت به نسخهٔ {ver} به‌روزرسانی شد", "success")

    def _ensure_worker(self) -> subprocess.Popen[str]:
        if self._worker_proc is not None and self._worker_proc.poll() is None:
            return self._worker_proc
        worker_script = _worker_script_path()
        proc = subprocess.Popen(
            [
                str(self._env_python()),
                str(worker_script),
                "--engine", self.id,
                "--models-root", str(models_dir()),
                "--serve",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=self._worker_env(),
            creationflags=_SUBPROCESS_NO_WINDOW if os.name == "nt" else 0,
        )
        banner = proc.stdout.readline().strip() if proc.stdout else ""
        if not banner:
            err_tail = proc.stderr.read()[-800:] if proc.stderr else ""
            proc.kill()
            raise self._error_cls(f"راه‌اندازی پردازشگر مدل {self.id} ناموفق بود: {err_tail}")
        self._worker_proc = proc
        return proc

    def recognize(self, image: Image.Image, language: str, *, page_mode: str = "auto") -> list[Any]:
        if not self.runtime_installed or not self.model_ready:
            raise self._error_cls(f"{self.id} is not ready. Click the explicit preparation button first.")
        regions = detect_comic_text_regions(image, page_mode=page_mode) if self._spec.get("needs_regions") else None
        with tempfile.NamedTemporaryFile(prefix=f"comic-{self.id}-", suffix=".png", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            image.convert("RGB").save(tmp_path, "PNG")
            with self._worker_lock:
                proc = self._ensure_worker()
                assert proc.stdin is not None and proc.stdout is not None
                req = {"imagePath": str(tmp_path), "language": language, "regions": regions, "pageMode": page_mode}
                proc.stdin.write(json.dumps(req) + "\n")
                proc.stdin.flush()
                raw_resp = proc.stdout.readline().strip()
                if not raw_resp:
                    self._worker_proc = None
                    raise self._error_cls(f"پردازشگر مدل {self.id} به شکل غیرمنتظره‌ای بسته شد.")
                payload = json.loads(raw_resp)
                if not payload.get("ok"):
                    raise self._error_cls(f"OCR failed ({self.id}): {payload.get('error')}")
                return [
                    self._line_factory(
                        str(entry["text"]).strip(),
                        float(entry.get("confidence", 0.9)),
                        [[float(pt[0]), float(pt[1])] for pt in entry["polygon"]],
                    )
                    for entry in payload.get("lines") or []
                    if str(entry.get("text", "")).strip() and entry.get("polygon")
                ]
        finally:
            tmp_path.unlink(missing_ok=True)


def _update_cache_path() -> Path:
    return models_dir() / "update_cache.json"


def read_update_cache() -> dict[str, Any]:
    path = _update_cache_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_update_cache(payload: dict[str, Any]) -> None:
    with _UPDATE_CACHE_LOCK:
        path = _update_cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)


def clear_cached_engine_update(engine_id: str, new_version: str | None, new_revision: str | None = None) -> None:
    cache = read_update_cache()
    entries = cache.get("engines")
    if isinstance(entries, dict) and engine_id in entries:
        entry = dict(entries[engine_id] or {})
        if new_version:
            entry["latestVersion"] = new_version
        if new_revision:
            entry["latestRevision"] = new_revision
        entries[engine_id] = entry
        write_update_cache(cache)


def fetch_pypi_latest_version(pkg_name: str, timeout: float = 6.0) -> str | None:
    data = _fetch_json(f"https://pypi.org/pypi/{pkg_name}/json", timeout=timeout)
    ver = str((data.get("info") or {}).get("version") or "").strip()
    return ver or None


def fetch_remote_repo_revision(github_repo: str | None, timeout: float = 6.0) -> str | None:
    if not github_repo:
        return None
    try:
        rel = _fetch_json(f"https://api.github.com/repos/{github_repo}/releases/latest", timeout=timeout)
        tag = str(rel.get("tag_name") or "").strip()
        if tag:
            return tag.lstrip("vV")
    except Exception:
        pass
    try:
        commits = _fetch_json(f"https://api.github.com/repos/{github_repo}/commits?per_page=1", timeout=timeout)
        if isinstance(commits, list) and commits:
            sha = str(commits[0].get("sha") or "").strip()
            if sha:
                return sha[:12]
    except Exception:
        pass
    return None


def fetch_tessdata_revision(languages: list[str], timeout: float = 6.0) -> str | None:
    lang = languages[0] if languages else "eng"
    try:
        commits = _fetch_json(
            f"https://api.github.com/repos/tesseract-ocr/tessdata_fast/commits?path={lang}.traineddata&per_page=1",
            timeout=timeout,
        )
        if isinstance(commits, list) and commits:
            sha = str(commits[0].get("sha") or "").strip()
            if sha:
                return sha[:12]
    except Exception:
        pass
    return None


def sha256_short(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(256 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()[:12]


def detect_builtin_installed_version(engine_id: str, engine: Any) -> str | None:
    if not engine.runtime_installed:
        return None
    if engine_id in {"rapidocr-v6", "rapidocr-v5"}:
        try:
            return importlib.metadata.version("rapidocr")
        except Exception:
            pass
    elif engine_id == "easyocr":
        try:
            return importlib.metadata.version("easyocr")
        except Exception:
            pass
    elif engine_id == "tesseract":
        from .ocr import _tesseract_executable
        ver = detect_tesseract_version(_tesseract_executable())
        if ver:
            return ver
    entry = read_manifest().get(engine_id) or {}
    return entry.get("installedVersion")


def compute_engine_update_fields(
    engine_id: str,
    engine_name: str,
    engine: Any,
    installed_version: str | None,
    manifest_entry: dict[str, Any] | None,
    cached_remote: dict[str, Any] | None,
) -> dict[str, Any]:
    remote = cached_remote or {}
    latest_version = remote.get("latestVersion")
    latest_revision = remote.get("latestRevision")
    installed_ready = bool(engine.runtime_installed and (engine.model_ready or installed_version))
    update_available = False
    summary = ""

    if installed_ready:
        if installed_version and latest_version and is_newer_version(installed_version, latest_version):
            update_available = True
            summary = f"نسخهٔ جدید {latest_version} برای مدل «{engine_name}» آمادهٔ نصب است (نسخهٔ فعلی: {installed_version})"
        else:
            local_rev = (manifest_entry or {}).get("modelRevision")
            if local_rev and latest_revision and local_rev != latest_revision and local_rev != "ready":
                update_available = True
                summary = f"فایل‌های مدل «{engine_name}» در منبع رسمی به‌روز شده است"

    return {
        "installedVersion": installed_version,
        "latestVersion": latest_version,
        "updateAvailable": update_available,
        "updateSummary": summary,
    }


def check_remote_updates(registry: Any, force: bool = False) -> dict[str, Any]:
    cache = read_update_cache()
    now_epoch = time.time()
    cached_engines: dict[str, Any] = dict(cache.get("engines") or {})

    installed_ids = [
        engine_id
        for engine_id in registry.engines
        if registry.get(engine_id).runtime_installed
    ]

    if not installed_ids:
        return {
            "checked": True,
            "online": True,
            "updatesCount": 0,
            "updatableIds": [],
            "engines": registry.status(),
            "message": "هنوز هیچ مدل OCR روی این سیستم نصب نشده است؛ ابتدا مدل موردنظر را با دکمهٔ «آماده‌سازی / دانلود خودکار» نصب کنید.",
        }

    use_cache = (
        not force
        and bool(cache.get("checkedAtEpoch"))
        and (now_epoch - float(cache.get("checkedAtEpoch", 0))) < _UPDATE_CACHE_TTL_SECONDS
        and all(eid in cached_engines for eid in installed_ids)
    )

    any_network_ok = use_cache
    if not use_cache:
        def _probe_one(eid: str) -> tuple[str, dict[str, Any], bool]:
            meta = engine_meta(eid)
            engine = registry.get(eid)
            latest_ver: str | None = None
            latest_rev: str | None = None
            ok = False
            pypi_pkg = meta.get("pypi_pkg")
            if pypi_pkg:
                try:
                    latest_ver = fetch_pypi_latest_version(pypi_pkg)
                    if latest_ver:
                        ok = True
                except Exception:
                    pass
            if eid == "tesseract":
                if os.name == "nt":
                    try:
                        tag, _ = _latest_tesseract_windows_installer()
                        if tag:
                            latest_ver = tag
                            ok = True
                    except Exception:
                        pass
                rev = fetch_tessdata_revision(engine.ready_languages or ["eng"])
                if rev:
                    latest_rev = rev
                    ok = True
            elif eid in ISOLATED_ENGINE_SPECS and ISOLATED_ENGINE_SPECS[eid].get("hf_repo"):
                rev = fetch_remote_repo_revision(meta.get("github_repo"))
                if rev:
                    latest_rev = rev
                    ok = True
            return eid, {"latestVersion": latest_ver, "latestRevision": latest_rev, "checkedAt": _now_iso()}, ok

        with ThreadPoolExecutor(max_workers=min(6, max(1, len(installed_ids)))) as pool:
            futures = [pool.submit(_probe_one, eid) for eid in installed_ids]
            for fut in as_completed(futures):
                eid, result, ok = fut.result()
                if ok:
                    cached_engines[eid] = result
                    any_network_ok = True

        if any_network_ok:
            write_update_cache({
                "checkedAtEpoch": now_epoch,
                "checkedAt": _now_iso(),
                "engines": cached_engines,
            })

    statuses = registry.status()
    updatable = [entry for entry in statuses if entry.get("updateAvailable")]
    updatable_ids = [entry["id"] for entry in updatable]
    if updatable:
        if len(updatable) == 1:
            one = updatable[0]
            ver_part = (
                f" ({one['installedVersion']} ← {one['latestVersion']})"
                if one.get("installedVersion") and one.get("latestVersion") and one["installedVersion"] != one["latestVersion"]
                else ""
            )
            message = f"نسخهٔ جدیدی برای مدل «{one['name']}» منتشر شده است{ver_part}. با زدن دکمهٔ «به‌روزرسانی» به‌راحتی آپدیت می‌شود."
        else:
            names = "، ".join(item["name"] for item in updatable)
            message = f"برای {len(updatable)} مدل نصب‌شده نسخهٔ جدید منتشر شده است ({names}). با یک کلیک می‌توانید آن‌ها را به‌روزرسانی کنید."
    elif not any_network_ok:
        message = "بررسی آنلاین نسخه‌های جدید در حال حاضر در دسترس نبود؛ مدل‌های نصب‌شده بدون مشکل به‌صورت آفلاین کار می‌کنند."
    else:
        message = "همهٔ مدل‌های OCR نصب‌شده به آخرین نسخه به‌روز هستند."

    return {
        "checked": any_network_ok,
        "online": any_network_ok,
        "updatesCount": len(updatable),
        "updatableIds": updatable_ids,
        "engines": statuses,
        "message": message,
    }
