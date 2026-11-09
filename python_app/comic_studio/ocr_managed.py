from __future__ import annotations

import atexit
from collections import deque
from collections.abc import Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
import contextlib
import contextvars
import copy
import ctypes
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from typing import Any, Callable, TypeVar
import urllib.request
import zipfile

# Prevent OpenMP / Intel MKL / libiomp / libgomp worker threads from spin-waiting at 100% CPU after inference.
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
os.environ.setdefault("KMP_BLOCKTIME", "0")

import numpy as np
from PIL import Image

from .activity import JobCancelledError, check_cancelled, emit, is_job_cancelled
from .paths import bundled_models_dir, is_custom_data_dir_active, models_dir
from . import resources

_SUBPROCESS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
_HW_CACHE_LOCK = threading.Lock()
_HW_CACHE: tuple[float, dict[str, Any]] | None = None
_DISK_FREE_CACHE: tuple[str, float, float] | None = None
_MANIFEST_LOCK = threading.Lock()
_MANIFEST_MEM_CACHE: tuple[str, int, int, dict[str, dict[str, Any]]] | None = None
_UPDATE_CACHE_LOCK = threading.Lock()
_UPDATE_MEM_CACHE: tuple[str, int, int, dict[str, Any]] | None = None
_PORTABLE_TESS_CACHE: tuple[str, int, str | None] | None = None
_TESS_VER_CACHE: dict[tuple[str, int, int, int], str | None] = {}
_VENV_DIST_VER_CACHE: dict[tuple[str, int, str], str | None] = {}
_UPDATE_CACHE_TTL_SECONDS = 1800
_WORKER_IDLE_TIMEOUT_SECONDS = 180.0

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
        "pip_packages_cpu": ["paddlepaddle>=3.3.0", "paddleocr[doc-parser]>=3.7.0", "pillow>=10.3"],
        "pip_packages_gpu": ["paddlepaddle>=3.3.0", "paddleocr[doc-parser]>=3.7.0", "pillow>=10.3"],
        "pip_packages_fallback": ["paddlepaddle>=3.2.1", "paddleocr[doc-parser]>=3.4.0", "pillow>=10.3"],
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
        "pip_packages_cpu": ["glmocr>=0.1.0", "transformers>=5.3.0", "sentencepiece>=0.2.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=12.1.0"],
        "pip_packages_gpu": ["glmocr>=0.1.0", "transformers>=5.3.0", "sentencepiece>=0.2.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=12.1.0"],
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
        "github_repo": "rednote-hilab/dots.ocr",
        "hf_repo": "rednote-hilab/dots.mocr",
        "pip_packages_cpu": ["transformers>=4.51.0,<5.0.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "pip_packages_gpu": ["transformers>=4.51.0,<5.0.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
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
        "pip_packages_cpu": ["transformers>=4.46.3,<5.0.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3", "einops", "addict", "easydict"],
        "pip_packages_gpu": ["transformers>=4.46.3,<5.0.0", "accelerate>=0.34.0", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3", "einops", "addict", "easydict"],
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
        "pip_packages_cpu": ["olmocr>=0.4.0", "transformers>=4.51.0,<5.0.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
        "pip_packages_gpu": ["olmocr>=0.4.0", "transformers>=4.51.0,<5.0.0", "accelerate>=0.34.0", "qwen-vl-utils", "huggingface-hub>=0.26.0", "safetensors", "pillow>=10.3"],
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
    "hezar-ocr": {
        "primary_pkg": "hezar",
        "dist_name": "hezar",
        "pypi_pkg": "hezar",
        "github_repo": "hezarai/hezar",
        "hf_repo": "hezarai/crnn-base-fa-v2",
        "pip_packages_cpu": [
            "hezar>=1.0.0",
            "transformers>=4.38.0,<5.0.0",
            "omegaconf>=2.3.0",
            "huggingface-hub>=0.26.0,<1.0.0",
            "opencv-python-headless>=4.8.0",
            "pillow>=10.3",
        ],
        "pip_packages_gpu": [
            "hezar>=1.0.0",
            "transformers>=4.38.0,<5.0.0",
            "omegaconf>=2.3.0",
            "huggingface-hub>=0.26.0,<1.0.0",
            "opencv-python-headless>=4.8.0",
            "pillow>=10.3",
        ],
        "pip_packages_fallback": [
            "hezar>=0.44.0",
            "torchvision>=0.18.0",
            "transformers>=4.38.0,<5.0.0",
            "omegaconf>=2.3.0",
            "huggingface-hub>=0.26.0,<1.0.0",
            "opencv-python-headless>=4.8.0",
            "pillow>=10.3",
        ],
        "needs_torch": True,
        "needs_regions": False,
        "download_size_gb": 0.25,
        "requires_nvidia_gpu": False,
        "min_vram_gb": 0.0,
        "min_disk_gb": 1.2,
        "category": "advanced",
    },
}


PYPI_FALLBACK_MIRRORS: tuple[tuple[str, str], ...] = (
    ("Aliyun PyPI", "https://mirrors.aliyun.com/pypi/simple/"),
    ("Tsinghua TUNA", "https://pypi.tuna.tsinghua.edu.cn/simple"),
)

_PIP_NETWORK_ERROR_MARKERS: tuple[str, ...] = (
    "readtimeouterror",
    "connecttimeouterror",
    "read timed out",
    "connection timed out",
    "connection broken",
    "connectionreseterror",
    "connectionabortederror",
    "newconnectionerror",
    "max retries exceeded",
    "network is unreachable",
    "temporary failure in name resolution",
    "getaddrinfo failed",
    "name or service not known",
    "sslerror",
    "eof occurred in violation of protocol",
    "chunkedencodingerror",
    "incompleteread",
    "retrying (retry(total=",
    "operation timed out during pip installation",
)


def pip_cache_dir() -> Path:
    cdir = models_dir() / "pip-cache"
    try:
        cdir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return cdir


def sync_local_wheelhouse() -> Path:
    """Link/copy any cached `.whl` files from OS and Studio pip caches into a flat wheelhouse folder."""
    wheelhouse = models_dir() / "wheelhouse"
    try:
        wheelhouse.mkdir(parents=True, exist_ok=True)
    except OSError:
        return wheelhouse

    roots: list[Path] = [pip_cache_dir() / "wheels"]
    if _is_windows():
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            roots.append(Path(local_app) / "pip" / "Cache" / "wheels")
    else:
        roots.append(Path.home() / ".cache" / "pip" / "wheels")
        roots.append(Path.home() / "Library" / "Caches" / "pip" / "wheels")

    seen_roots: set[Path] = set()
    for root in roots:
        try:
            if not root.is_dir():
                continue
            resolved = root.resolve()
            if resolved in seen_roots:
                continue
            seen_roots.add(resolved)
            for whl in root.rglob("*.whl"):
                if not whl.is_file():
                    continue
                dest = wheelhouse / whl.name
                if dest.exists():
                    continue
                try:
                    os.link(whl, dest)
                except OSError:
                    try:
                        shutil.copy2(whl, dest)
                    except OSError:
                        pass
        except OSError:
            continue
    return wheelhouse


def clean_pip_env() -> dict[str, str]:
    """Build a sanitized environment for pip subprocesses so launcher vars like PIP_RETRIES=1 or PIP_TIMEOUT=15 never throttle model installs,
    and route pip cache + temporary wheel unpack folders into `models_dir()` so multi-GB installs never fill Drive C."""
    env = dict(os.environ)
    for blocked in ("PIP_NO_CACHE_DIR",):
        env.pop(blocked, None)
    env["PIP_TIMEOUT"] = "120"
    env["PIP_RETRIES"] = "10"
    env["PIP_PREFER_BINARY"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    with contextlib.suppress(OSError):
        if is_custom_data_dir_active() or bool((os.environ.get("COMIC_STUDIO_DATA") or "").strip()):
            m_root = models_dir()
            cdir = m_root / "pip-cache"
            tdir = m_root / "tmp"
            xdg_dir = m_root / "cache"
            for directory in (cdir, tdir, xdg_dir):
                directory.mkdir(parents=True, exist_ok=True)
            env["PIP_CACHE_DIR"] = str(cdir)
            env["TMPDIR"] = str(tdir)
            env["TEMP"] = str(tdir)
            env["TMP"] = str(tdir)
            env["XDG_CACHE_HOME"] = str(xdg_dir)
    return env


def is_pip_network_or_index_error(output: str) -> bool:
    lower = str(output or "").lower()
    if not lower:
        return False
    if "winerror 32" in lower or "being used by another process" in lower:
        return False
    if "winerror 5" in lower or "access is denied" in lower:
        return False
    if any(marker in lower for marker in _PIP_NETWORK_ERROR_MARKERS):
        return True
    if "(from versions: none)" in lower:
        return True
    return False


def _parse_size_to_bytes(text: str) -> float:
    """Parse human size token such as '245.3 MB', '2.65G', or '512 kB' into bytes."""
    m = re.search(r"([\d.]+)\s*([kKmMgGtT])i?[bB]?", str(text or ""))
    if not m:
        return 0.0
    try:
        val = float(m.group(1))
    except ValueError:
        return 0.0
    mult = {"k": 1024.0, "m": 1024.0 ** 2, "g": 1024.0 ** 3, "t": 1024.0 ** 4}.get(m.group(2).lower(), 1.0)
    return max(0.0, val * mult)


def _dir_bytes_fast(root: Path, max_files: int = 8000) -> int:
    """Fast non-throwing byte sum of files under `root` for live download progress & stall detection."""
    total = 0
    seen = 0
    try:
        if not root.exists():
            return 0
        for dirpath, _dirnames, filenames in os.walk(root):
            for fname in filenames:
                seen += 1
                if seen > max_files:
                    return total
                try:
                    st = os.stat(os.path.join(dirpath, fname), follow_symlinks=False)
                    total += int(st.st_size)
                except OSError:
                    continue
    except OSError:
        pass
    return total


def _pick_llama_cpp_asset(
    releases: Sequence[dict[str, Any]],
    *,
    has_gpu: bool,
    is_win: bool,
    plat: str,
    machine: str,
) -> tuple[str, str]:
    """Select the best `(asset_name, browser_download_url)` across recent llama.cpp GitHub releases.
    Skips tag-only/meta releases like `v0.9.0` (`nightly-tag.txt`) that carry no binary archives."""
    arch = (machine or "").lower()
    is_arm = arch in {"arm64", "aarch64"}

    def _is_archive(n: str) -> bool:
        return n.endswith(".zip") or n.endswith(".tar.gz")

    for rel in releases:
        if not isinstance(rel, dict):
            continue
        assets = rel.get("assets") or []
        parsed: list[tuple[str, str]] = []
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            nm = str(asset.get("name") or "")
            dl = str(asset.get("browser_download_url") or "")
            if nm and dl and _is_archive(nm.lower()) and not nm.lower().startswith("cudart-"):
                parsed.append((nm, dl))
        if not parsed:
            continue

        if is_win:
            arch_tok = "arm64" if is_arm else "x64"
            if has_gpu:
                for nm, dl in parsed:
                    low = nm.lower()
                    if "win" in low and "vulkan" in low and arch_tok in low and low.endswith(".zip"):
                        return nm, dl
            for nm, dl in parsed:
                low = nm.lower()
                if "win" in low and "cpu" in low and arch_tok in low and low.endswith(".zip"):
                    return nm, dl
        elif plat.startswith("linux"):
            if is_arm:
                for nm, dl in parsed:
                    low = nm.lower()
                    if "ubuntu" in low and "arm64" in low and not any(x in low for x in ("cuda", "rocm", "vulkan", "sycl", "openvino")):
                        return nm, dl
            else:
                if has_gpu:
                    for nm, dl in parsed:
                        low = nm.lower()
                        if "ubuntu" in low and "vulkan" in low and "x64" in low:
                            return nm, dl
                for nm, dl in parsed:
                    low = nm.lower()
                    if "ubuntu" in low and "x64" in low and not any(x in low for x in ("cuda", "rocm", "vulkan", "sycl", "openvino", "s390x", "zdnn")):
                        return nm, dl
        elif plat == "darwin":
            arch_tok = "arm64" if is_arm else "x64"
            for nm, dl in parsed:
                low = nm.lower()
                if "macos" in low and arch_tok in low:
                    return nm, dl
    return "", ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run_Subprocess(command: list[str] | str, **kwargs: Any) -> subprocess.CompletedProcess[Any]:
    if os.name == "nt" and "creationflags" not in kwargs:
        kwargs["creationflags"] = _SUBPROCESS_NO_WINDOW
    return subprocess.run(command, **kwargs)


def _kill_process_tree(proc: subprocess.Popen[Any]) -> None:
    """Terminate `proc` and any child processes cleanly across Windows and POSIX."""
    if proc.poll() is not None:
        return
    pid = proc.pid
    if os.name == "nt" and pid:
        try:
            _run_Subprocess(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except Exception:
            pass
    elif pid and hasattr(os, "killpg") and hasattr(os, "getpgid"):
        try:
            import signal as _sig

            pgid = os.getpgid(pid)
            if pgid > 0 and pgid != os.getpgid(0):
                os.killpg(pgid, _sig.SIGKILL)
        except Exception:
            pass
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)
    except Exception:
        pass


def process_rss_mb(pid: int | None = None) -> float:
    """Return Resident Set Size / Working Set in MB for `pid` (defaults to current process)."""
    target_pid = os.getpid() if pid is None else int(pid)
    if target_pid <= 0:
        return 0.0
    try:
        if os.name == "nt":
            class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_ulong),
                    ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = _PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
            if target_pid == os.getpid():
                handle = ctypes.windll.kernel32.GetCurrentProcess()
                close_after = False
            else:
                # PROCESS_QUERY_LIMITED_INFORMATION (0x1000) | PROCESS_VM_READ (0x0010)
                handle = ctypes.windll.kernel32.OpenProcess(0x1010, False, target_pid)
                close_after = bool(handle)
            if handle:
                try:
                    ok = ctypes.windll.psapi.GetProcessMemoryInfo(
                        handle, ctypes.byref(counters), counters.cb
                    )
                    if ok:
                        return round(counters.WorkingSetSize / (1024 * 1024), 1)
                finally:
                    if close_after:
                        ctypes.windll.kernel32.CloseHandle(handle)
        else:
            status_file = Path(f"/proc/{target_pid}/status")
            if status_file.is_file():
                for line in status_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                    if line.startswith("VmRSS:"):
                        kb = int(line.split()[1])
                        return round(kb / 1024.0, 1)
    except Exception:
        pass
    return 0.0


def trim_process_memory() -> None:
    """Run Python GC, flush optional GPU caches if already loaded, and return unused heap/working-set pages to OS."""
    import gc
    gc.collect()
    gc.collect()
    torch_mod = sys.modules.get("torch")
    if torch_mod is not None:
        try:
            if hasattr(torch_mod, "cuda") and torch_mod.cuda.is_available():
                torch_mod.cuda.empty_cache()
                if hasattr(torch_mod.cuda, "ipc_collect"):
                    torch_mod.cuda.ipc_collect()
        except Exception:
            pass
        try:
            if hasattr(torch_mod, "mps") and hasattr(torch_mod.mps, "empty_cache"):
                if hasattr(torch_mod, "backends") and hasattr(torch_mod.backends, "mps") and torch_mod.backends.mps.is_available():
                    torch_mod.mps.empty_cache()
        except Exception:
            pass
    paddle_mod = sys.modules.get("paddle")
    if paddle_mod is not None:
        try:
            if hasattr(paddle_mod, "device") and hasattr(paddle_mod.device, "cuda"):
                if paddle_mod.device.is_compiled_with_cuda() and paddle_mod.device.cuda.device_count() > 0:
                    paddle_mod.device.cuda.empty_cache()
        except Exception:
            pass
    try:
        if os.name == "nt":
            try:
                msvcrt = getattr(ctypes, "cdll", None)
                if msvcrt is not None and hasattr(msvcrt, "msvcrt") and hasattr(msvcrt.msvcrt, "_heapmin"):
                    msvcrt.msvcrt._heapmin()
            except Exception:
                pass
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            try:
                ctypes.windll.psapi.EmptyWorkingSet(handle)
            except Exception:
                ctypes.windll.kernel32.SetProcessWorkingSetSize(
                    handle, ctypes.c_size_t(-1), ctypes.c_size_t(-1)
                )
        elif sys.platform.startswith("linux"):
            libc = ctypes.CDLL("libc.so.6")
            if hasattr(libc, "malloc_trim"):
                libc.malloc_trim(0)
    except Exception:
        pass


_TItem = TypeVar("_TItem")
_TResult = TypeVar("_TResult")
_RUNTIME_CONFIGURED = False
_RUNTIME_LOCK = threading.Lock()


def cpu_core_count() -> int:
    """Return the CPU cores the app may use (honoring the user's budget and the test override)."""
    override = os.environ.get("COMIC_STUDIO_FAKE_HARDWARE_JSON")
    if override:
        try:
            parsed = json.loads(override)
            if isinstance(parsed, dict) and parsed.get("cpuCores") is not None:
                return resources.effective_cpu_cores(max(1, int(parsed["cpuCores"])))
        except Exception:
            pass
    return resources.effective_cpu_cores(max(1, int(os.cpu_count() or 1)))


def compute_worker_count(
    task_count: int,
    *,
    per_worker_mb: int = 180,
    max_cap: int = 8,
) -> tuple[int, int]:
    """Compute `(worker_count, threads_per_worker)` to saturate multi-core CPUs without oversubscribing RAM or threads."""
    cores = cpu_core_count()
    if task_count <= 1 or cores <= 1:
        return 1, cores
    hw = inspect_hardware()
    ram_gb = float(hw.get("ramGb") or 0.0)
    if ram_gb > 0:
        # The user's RAM share decides how much memory may be used in parallel.
        usable_mb = max(128.0, resources.usable_ram_mb(ram_gb))
        ram_cap = max(1, int(usable_mb // max(32, per_worker_mb)))
    else:
        ram_cap = max_cap
    workers = max(1, min(int(task_count), cores, max(1, int(max_cap)), ram_cap))
    threads_per_worker = max(1, cores // workers)
    return workers, threads_per_worker


def iter_parallel_ordered(
    items: Sequence[_TItem],
    worker_fn: Callable[[int, _TItem], _TResult],
    *,
    max_workers: int,
) -> Iterator[tuple[int, _TItem, _TResult]]:
    """Execute `worker_fn(index, item)` across a bounded sliding-window thread pool, preserving ContextVars and strict order."""
    total = len(items)
    if total == 0:
        return
    effective_workers = max(1, min(int(max_workers), total))
    if effective_workers <= 1:
        for idx, item in enumerate(items):
            check_cancelled()
            yield idx, item, worker_fn(idx, item)
        return

    inflight: deque[tuple[int, _TItem, Future[_TResult]]] = deque()
    next_idx = 0
    pool = ThreadPoolExecutor(max_workers=effective_workers, thread_name_prefix="comic-worker")
    aborted = False
    try:
        while next_idx < total and len(inflight) < effective_workers:
            check_cancelled()
            item = items[next_idx]
            ctx = contextvars.copy_context()
            fut = pool.submit(ctx.run, worker_fn, next_idx, item)
            inflight.append((next_idx, item, fut))
            next_idx += 1

        while inflight:
            check_cancelled()
            done_idx, done_item, done_fut = inflight.popleft()
            result = done_fut.result()
            check_cancelled()
            if next_idx < total:
                item = items[next_idx]
                ctx = contextvars.copy_context()
                fut = pool.submit(ctx.run, worker_fn, next_idx, item)
                inflight.append((next_idx, item, fut))
                next_idx += 1
            yield done_idx, done_item, result
    except BaseException:
        aborted = True
        raise
    finally:
        while inflight:
            _, _, pending_fut = inflight.popleft()
            pending_fut.cancel()
        pool.shutdown(wait=not aborted, cancel_futures=aborted)


def configure_native_runtime(eager_cv2: bool = True) -> dict[str, Any]:
    """Configure OpenCV, OpenMP/BLAS, and transparent OpenCL GPU acceleration once per process."""
    global _RUNTIME_CONFIGURED
    cores = cpu_core_count()
    for env_key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(env_key, str(cores))
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
    os.environ.setdefault("KMP_BLOCKTIME", "0")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    cv_threads = cores
    opencl_active = False
    if eager_cv2:
        with _RUNTIME_LOCK:
            already_configured = _RUNTIME_CONFIGURED
        if not already_configured:
            try:
                import cv2
                cv2.setUseOptimized(True)
                cv2.setNumThreads(cores)
                cv_threads = int(cv2.getNumThreads())
                if hasattr(cv2, "ocl") and cv2.ocl.haveOpenCL():
                    hw = inspect_hardware()
                    if hw.get("hasGpu"):
                        cv2.ocl.setUseOpenCL(True)
                        opencl_active = bool(cv2.ocl.useOpenCL())
            except Exception:
                pass
            with _RUNTIME_LOCK:
                _RUNTIME_CONFIGURED = True
    return {"cpuCores": cores, "cvThreads": cv_threads, "openclActive": opencl_active}


def _remove_path_safely(target: Path) -> int:
    """Delete a file or directory tree best-effort (clearing Windows read-only flags) and return approximate bytes freed."""
    if not target.exists() and not target.is_symlink():
        return 0
    freed = 0

    def _on_rm_error(func: Any, path_str: str, _exc_info: Any) -> None:
        try:
            import stat as _stat
            os.chmod(path_str, _stat.S_IWRITE)
            func(path_str)
        except Exception:
            pass

    try:
        if target.is_symlink() or target.is_file():
            try:
                freed = target.stat().st_size
            except OSError:
                freed = 0
            try:
                target.unlink(missing_ok=True)
            except OSError:
                _on_rm_error(os.unlink, str(target), None)
            return freed
        if target.is_dir():
            for child in target.rglob("*"):
                if child.is_file() and not child.is_symlink():
                    try:
                        freed += child.stat().st_size
                    except OSError:
                        pass
            shutil.rmtree(target, onerror=_on_rm_error)
            return freed
    except Exception:
        pass
    return freed


def cleanup_superseded_engine_files(engine_id: str) -> int:
    """Remove ONLY superseded old versions, orphaned snapshot blobs, and leftover download/pip temp files.
    Never removes active installed models."""
    freed = 0
    root = models_dir()
    if not root.is_dir():
        return 0

    # 1. Clean incomplete/temporary download remnants across models_dir
    for pattern in ("*.part", "*.tmp", "*.incomplete", "*.bak"):
        for leftover in root.rglob(pattern):
            if leftover.is_file():
                freed += _remove_path_safely(leftover)

    # 2. Isolated venv cleanup: remove broken `~pkg` remnants from Windows upgrades & duplicate older .dist-info
    spec = ISOLATED_ENGINE_SPECS.get(engine_id)
    if spec:
        env_dir = root / "envs" / engine_id
        if env_dir.is_dir():
            site_dirs = (
                [env_dir / "Lib" / "site-packages"]
                if os.name == "nt"
                else list((env_dir / "lib").glob("python*/site-packages"))
            )
            for sp in site_dirs:
                if not sp.is_dir():
                    continue
                for broken in sp.glob("~*"):
                    freed += _remove_path_safely(broken)
                by_pkg: dict[str, list[tuple[str, Path]]] = {}
                for dist_dir in sp.glob("*.dist-info"):
                    m = re.match(r"^([A-Za-z0-9_.-]+)-(\d[A-Za-z0-9_.-]*)\.dist-info$", dist_dir.name)
                    if not m:
                        continue
                    norm_name = re.sub(r"[-_.]+", "_", m.group(1)).lower()
                    by_pkg.setdefault(norm_name, []).append((m.group(2), dist_dir))
                for versions in by_pkg.values():
                    if len(versions) <= 1:
                        continue
                    newest_ver = versions[0][0]
                    for cand_ver, _ in versions[1:]:
                        if is_newer_version(newest_ver, cand_ver):
                            newest_ver = cand_ver
                    for cand_ver, dist_path in versions:
                        if cand_ver != newest_ver:
                            freed += _remove_path_safely(dist_path)

        # 3. HuggingFace superseded snapshots & legacy dotted duplicate folder
        hf_repo = spec.get("hf_repo")
        if hf_repo:
            safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", hf_repo.replace("/", "__"))
            legacy_name = hf_repo.replace("/", "__")
            safe_dir = root / "hf-repos" / safe_name
            legacy_dir = root / "hf-repos" / legacy_name
            if safe_name != legacy_name and safe_dir.is_dir() and any(safe_dir.iterdir()) and legacy_dir.is_dir():
                freed += _remove_path_safely(legacy_dir)
            # Clean local_dir `.cache/huggingface/download` temp chunks
            for dl_cache in (safe_dir / ".cache", legacy_dir / ".cache"):
                if dl_cache.is_dir():
                    freed += _remove_path_safely(dl_cache)

            hub_repo_dir = root / "hf" / "hub" / f"models--{hf_repo.replace('/', '--')}"
            snapshots_dir = hub_repo_dir / "snapshots"
            ref_main = hub_repo_dir / "refs" / "main"
            if snapshots_dir.is_dir() and ref_main.is_file():
                active_rev = ref_main.read_text(encoding="utf-8", errors="ignore").strip()
                if active_rev and (snapshots_dir / active_rev).is_dir():
                    for snap in snapshots_dir.iterdir():
                        if snap.is_dir() and snap.name != active_rev:
                            freed += _remove_path_safely(snap)
                    # Prune unreferenced blobs in hub_repo_dir/blobs
                    blobs_dir = hub_repo_dir / "blobs"
                    if blobs_dir.is_dir():
                        referenced_blobs: set[str] = set()
                        for link in (snapshots_dir / active_rev).rglob("*"):
                            if link.is_symlink():
                                try:
                                    referenced_blobs.add(Path(os.readlink(link)).name)
                                except OSError:
                                    pass
                        if referenced_blobs:
                            for blob in blobs_dir.iterdir():
                                if blob.is_file() and blob.name not in referenced_blobs:
                                    freed += _remove_path_safely(blob)

    # 4. PaddleX superseded sub-models & archive remnants
    if engine_id == "paddleocr-vl-1-6":
        paddlex_dir = root / "paddlex"
        if paddlex_dir.is_dir():
            for archive in paddlex_dir.rglob("*.tar*"):
                if archive.is_file():
                    freed += _remove_path_safely(archive)
            official = paddlex_dir / "official_models"
            if official.is_dir():
                has_newer_vl = any(
                    (official / name).is_dir()
                    for name in ("PaddleOCR-VL-1.5-0.9B", "PaddleOCR-VL-1.6-0.9B")
                )
                old_v1 = official / "PaddleOCR-VL-0.9B"
                if has_newer_vl and old_v1.is_dir():
                    freed += _remove_path_safely(old_v1)

    # 5. MinerU temporary download chunks & Hunyuan legacy excluded subfolders
    if engine_id == "mineru-2-5-pro":
        mineru_dir = root / "mineru"
        if mineru_dir.is_dir():
            for tmp_dir_name in ("._____temp", ".cache"):
                for cand_tmp in mineru_dir.rglob(tmp_dir_name):
                    if cand_tmp.is_dir():
                        freed += _remove_path_safely(cand_tmp)
    elif engine_id == "hunyuan-ocr":
        hy_dir = root / "hf-repos" / "tencent__HunyuanOCR"
        for unused_sub in ("v1.0", "dflash"):
            sub_path = hy_dir / unused_sub
            if sub_path.is_dir():
                freed += _remove_path_safely(sub_path)

    return freed


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


def _detect_other_gpu() -> tuple[bool, str, float, str, str]:
    """Detect non-NVIDIA hardware GPUs (Windows DirectML AMD/Intel/Qualcomm, macOS Apple Metal, Linux ROCm/DRM)."""
    if sys.platform == "darwin":
        arch = platform.machine().lower()
        if arch in {"arm64", "aarch64"}:
            return True, "Apple Silicon GPU", 0.0, "apple", "mps"
        return False, "", 0.0, "", ""

    if os.name == "nt":
        virtual_tokens = (
            "microsoft basic",
            "remote",
            "hyper-v",
            "parsec",
            "indirect",
            "virtual",
            "vmware",
            "vbox",
            "citrix",
        )
        # Fast in-process Windows Registry display-adapter lookup (<1 ms vs 2-4 s cold PowerShell CIM).
        try:
            import winreg  # type: ignore[import-not-found]

            reg_path = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
            best_name = ""
            best_vram_gb = 0.0
            best_vendor = ""
            best_score = -1
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, reg_path) as class_key:
                for sub_idx in range(32):
                    try:
                        sub_name = winreg.EnumKey(class_key, sub_idx)
                    except OSError:
                        break
                    if not (len(sub_name) == 4 and sub_name.isdigit()):
                        continue
                    try:
                        with winreg.OpenKey(class_key, sub_name) as dev_key:
                            desc_val, _ = winreg.QueryValueEx(dev_key, "DriverDesc")
                            name = str(desc_val or "").strip()
                            lower = name.lower()
                            if not name or any(tok in lower for tok in virtual_tokens):
                                continue
                            ram_bytes = 0
                            for mem_key in ("HardwareInformation.qwMemorySize", "HardwareInformation.MemorySize"):
                                try:
                                    raw_mem, _ = winreg.QueryValueEx(dev_key, mem_key)
                                    if isinstance(raw_mem, int):
                                        ram_bytes = raw_mem
                                    elif isinstance(raw_mem, (bytes, bytearray)) and raw_mem:
                                        ram_bytes = int.from_bytes(raw_mem, "little", signed=False)
                                    if ram_bytes > 0:
                                        break
                                except OSError:
                                    continue
                            vram_gb = round(max(0, ram_bytes) / (1024 ** 3), 1) if ram_bytes > 0 else 0.0
                            if "nvidia" in lower or "geforce" in lower or "rtx" in lower or "quadro" in lower:
                                vendor, score = "nvidia", 3
                            elif "amd" in lower or "radeon" in lower:
                                vendor, score = "amd", 2
                            elif "intel" in lower or "arc" in lower or "iris" in lower:
                                vendor, score = "intel", 1
                            else:
                                vendor, score = "other", 1
                            if score > best_score or (score == best_score and vram_gb >= best_vram_gb):
                                best_name = name
                                best_vram_gb = vram_gb
                                best_vendor = vendor
                                best_score = score
                    except OSError:
                        continue
            if best_name:
                return True, best_name, best_vram_gb, best_vendor, "directml"
        except Exception:
            pass

        ps = shutil.which("powershell.exe") or shutil.which("powershell")
        if ps:
            try:
                proc = _run_Subprocess(
                    [
                        ps,
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-Command",
                        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    raw = json.loads(proc.stdout.strip())
                    adapters = raw if isinstance(raw, list) else ([raw] if isinstance(raw, dict) else [])
                    best_name = ""
                    best_vram_gb = 0.0
                    best_vendor = ""
                    best_score = -1
                    for entry in adapters:
                        if not isinstance(entry, dict):
                            continue
                        name = str(entry.get("Name") or "").strip()
                        lower = name.lower()
                        if not name or any(tok in lower for tok in virtual_tokens):
                            continue
                        ram_bytes = 0
                        try:
                            ram_bytes = int(entry.get("AdapterRAM") or 0)
                        except (TypeError, ValueError):
                            ram_bytes = 0
                        vram_gb = round(max(0, ram_bytes) / (1024 ** 3), 1) if ram_bytes > 0 else 0.0
                        if "nvidia" in lower or "geforce" in lower or "rtx" in lower or "quadro" in lower:
                            vendor, score = "nvidia", 3
                        elif "amd" in lower or "radeon" in lower:
                            vendor, score = "amd", 2
                        elif "intel" in lower or "arc" in lower or "iris" in lower:
                            vendor, score = "intel", 1
                        else:
                            vendor, score = "other", 1
                        if score > best_score or (score == best_score and vram_gb >= best_vram_gb):
                            best_name = name
                            best_vram_gb = vram_gb
                            best_vendor = vendor
                            best_score = score
                    if best_name:
                        return True, best_name, best_vram_gb, best_vendor, "directml"
            except Exception:
                pass
        return False, "", 0.0, "", ""

    if sys.platform.startswith("linux"):
        rocm_smi = shutil.which("rocm-smi")
        if rocm_smi:
            try:
                proc = _run_Subprocess([rocm_smi, "--showproductname"], capture_output=True, text=True, timeout=4, check=False)
                if proc.returncode == 0 and proc.stdout.strip():
                    return True, "AMD ROCm GPU", 0.0, "amd", "rocm"
            except Exception:
                pass
        dri_dir = Path("/dev/dri")
        drm_dir = Path("/sys/class/drm")
        if dri_dir.is_dir() and any(dri_dir.glob("renderD*")) and drm_dir.is_dir():
            vendor_map = {
                "0x10de": ("NVIDIA GPU", "nvidia", "cuda", 3),
                "0x1002": ("AMD Radeon GPU", "amd", "opencl", 2),
                "0x8086": ("Intel Integrated/Arc GPU", "intel", "opencl", 1),
            }
            best: tuple[str, str, str, int] | None = None
            for vendor_file in drm_dir.glob("card*/device/vendor"):
                try:
                    vid = vendor_file.read_text(encoding="utf-8", errors="ignore").strip().lower()
                except OSError:
                    continue
                cand = vendor_map.get(vid)
                if cand and (best is None or cand[3] > best[3]):
                    best = cand
            if best is not None:
                return True, best[0], 0.0, best[1], best[2]

    return False, "", 0.0, "", ""


def inspect_hardware(force_refresh: bool = False) -> dict[str, Any]:
    cores = cpu_core_count()
    override = os.environ.get("COMIC_STUDIO_FAKE_HARDWARE_JSON")
    if override:
        try:
            parsed = json.loads(override)
            if isinstance(parsed, dict):
                disk_val = parsed.get("freeDiskGb", parsed.get("diskFreeGb", 100.0))
                gpu_name = str(parsed.get("gpuName") or ((parsed.get("gpuNames") or [""])[0] if isinstance(parsed.get("gpuNames"), list) else ""))
                has_nvidia = bool(parsed.get("hasNvidiaGpu", False))
                has_any_gpu = bool(parsed.get("hasGpu", has_nvidia or bool(gpu_name)))
                default_vendor = "nvidia" if has_nvidia else ("other" if has_any_gpu else "")
                default_backend = "cuda" if has_nvidia else (("directml" if os.name == "nt" else "mps" if sys.platform == "darwin" else "opencl") if has_any_gpu else "")
                return {
                    "hasNvidiaGpu": has_nvidia,
                    "hasGpu": has_any_gpu,
                    "gpuVendor": str(parsed.get("gpuVendor", default_vendor)),
                    "gpuBackend": str(parsed.get("gpuBackend", default_backend)),
                    "gpuName": gpu_name,
                    "vramGb": float(parsed.get("vramGb", 0.0)),
                    "ramGb": float(parsed.get("ramGb", 16.0)),
                    "cpuCores": max(1, int(parsed.get("cpuCores", cores))),
                    "freeDiskGb": float(disk_val),
                }
        except Exception:
            pass

    global _HW_CACHE, _DISK_FREE_CACHE
    now = time.monotonic()
    with _HW_CACHE_LOCK:
        # Static CPU/RAM/GPU hardware does not change while the process is running;
        # caching it for process lifetime avoids repeatedly spawning PowerShell/nvidia-smi/system_profiler.
        if not force_refresh and _HW_CACHE is not None:
            base = dict(_HW_CACHE[1])
        else:
            has_nvidia, gpu_name, vram_gb = _detect_nvidia_gpu()
            if has_nvidia:
                has_any_gpu = True
                gpu_vendor = "nvidia"
                gpu_backend = "cuda"
            else:
                has_any_gpu, other_name, other_vram, gpu_vendor, gpu_backend = _detect_other_gpu()
                if has_any_gpu:
                    gpu_name = other_name
                    vram_gb = other_vram
            ram_gb = _detect_system_ram_gb()
            base = {
                "hasNvidiaGpu": has_nvidia,
                "hasGpu": has_any_gpu,
                "gpuVendor": gpu_vendor,
                "gpuBackend": gpu_backend,
                "gpuName": gpu_name,
                "vramGb": vram_gb,
                "ramGb": ram_gb,
                "cpuCores": cores,
            }
            _HW_CACHE = (now, dict(base))
        base["cpuCores"] = cores
        target_dir = models_dir()
        probe = target_dir if target_dir.exists() else (target_dir.parent if target_dir.parent.exists() else Path.home())
        probe_key = str(probe)
        if not force_refresh and _DISK_FREE_CACHE is not None and _DISK_FREE_CACHE[0] == probe_key and (now - _DISK_FREE_CACHE[1]) < 10.0:
            free_disk_gb = _DISK_FREE_CACHE[2]
        else:
            try:
                free_disk_gb = round(shutil.disk_usage(probe).free / (1024 ** 3), 1)
            except Exception:
                free_disk_gb = 0.0
            _DISK_FREE_CACHE = (probe_key, now, free_disk_gb)
    base["freeDiskGb"] = free_disk_gb
    return base


def reset_disk_free_cache() -> None:
    global _DISK_FREE_CACHE
    with _HW_CACHE_LOCK:
        _DISK_FREE_CACHE = None


def engine_meta(engine_id: str) -> dict[str, Any]:
    return ISOLATED_ENGINE_SPECS.get(engine_id) or BUILTIN_ENGINE_META.get(engine_id, {})


# Realistic component download sizes (GB) so every auto-install/download button can
# announce the exact total download footprint on the user's current OS/GPU & install state:
#   (weights_gb, runtime_cpu_gb, runtime_nvidia_gb, per_extra_language_gb)
_ENGINE_DOWNLOAD_COMPONENTS_GB: dict[str, tuple[float, float, float, float]] = {
    "rapidocr-v6": (0.015, 0.070, 0.090, 0.0),
    "rapidocr-v5": (0.020, 0.070, 0.090, 0.018),
    "easyocr": (0.150, 0.500, 2.700, 0.070),
    "tesseract": (0.015, 0.075, 0.075, 0.015),
    "hezar-ocr": (0.250, 0.500, 2.750, 0.0),
    "paddleocr-vl-1-6": (1.900, 0.550, 1.850, 0.0),
    "surya": (1.950, 0.650, 0.750, 0.0),
    "mineru-2-5-pro": (1.350, 0.550, 0.550, 0.0),
    "got-ocr-2": (1.450, 0.550, 2.800, 0.0),
    "glm-ocr": (1.900, 0.600, 2.850, 0.0),
    "dots-ocr": (6.200, 0.600, 2.850, 0.0),
    "deepseek-ocr-2": (6.800, 0.600, 2.850, 0.0),
    "olmocr": (15.500, 0.600, 2.850, 0.0),
    "hunyuan-ocr": (2.200, 0.600, 2.850, 0.0),
}


def format_download_size_fa(size_gb: float) -> str:
    val = max(0.0, float(size_gb or 0.0))
    if val <= 0.001:
        return "کمتر از ۵ مگابایت"
    if val < 1.0:
        mb = max(5, int(round(val * 1024 / 5.0) * 5))
        return f"~{mb} مگابایت"
    rounded = round(val, 2 if val < 2.0 else 1)
    text = f"{rounded:g}"
    return f"~{text} گیگابایت"


def compute_engine_download_estimate(
    engine_id: str,
    *,
    runtime_installed: bool = False,
    model_ready: bool = False,
    nominal_size_gb: float = 0.0,
    hw: dict[str, Any] | None = None,
) -> dict[str, Any]:
    hw_info = hw or inspect_hardware()
    has_nvidia = bool(hw_info.get("hasNvidiaGpu"))
    has_gpu = bool(hw_info.get("hasGpu", has_nvidia))
    comp = _ENGINE_DOWNLOAD_COMPONENTS_GB.get(engine_id)
    if comp is not None:
        weights_gb, rt_cpu_gb, rt_nv_gb, per_lang_gb = comp
    else:
        meta = engine_meta(engine_id)
        weights_gb = max(0.02, float(nominal_size_gb or meta.get("download_size_gb") or 0.1))
        needs_torch = bool(meta.get("needs_torch"))
        rt_cpu_gb = 0.55 if needs_torch else 0.10
        rt_nv_gb = 2.80 if needs_torch else rt_cpu_gb
        per_lang_gb = 0.0

    runtime_gb = rt_nv_gb if has_nvidia else rt_cpu_gb
    if engine_id in ("rapidocr-v6", "rapidocr-v5") and has_nvidia and sys.platform.startswith("linux"):
        runtime_gb = 0.220
    elif engine_id in ("rapidocr-v6", "rapidocr-v5") and has_gpu and os.name == "nt":
        runtime_gb = 0.090
    elif engine_id == "easyocr" and not runtime_installed:
        try:
            import importlib.util as _ilu
            if _ilu.find_spec("torch") is not None:
                runtime_gb = 0.180
        except Exception:
            pass
    elif engine_id == "tesseract" and os.name != "nt":
        runtime_gb = 0.050

    full_gb = round(runtime_gb + weights_gb, 3)
    if not runtime_installed:
        remaining_gb = full_gb
    elif not model_ready:
        remaining_gb = round(weights_gb, 3)
    else:
        remaining_gb = round(per_lang_gb, 3)

    return {
        "weightsDownloadGb": round(weights_gb, 3),
        "runtimeDownloadGb": round(runtime_gb, 3),
        "perLanguageDownloadGb": round(per_lang_gb, 3),
        "fullDownloadSizeGb": full_gb,
        "totalDownloadGb": remaining_gb if remaining_gb > 0 else full_gb,
        "remainingDownloadGb": remaining_gb,
    }


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
        "hasGpu": bool(hw_info.get("hasGpu", hw_info.get("hasNvidiaGpu", False))),
        "gpuVendor": str(hw_info.get("gpuVendor") or ""),
        "gpuBackend": str(hw_info.get("gpuBackend") or ""),
        "gpuName": str(hw_info.get("gpuName") or ""),
        "vramGb": float(hw_info.get("vramGb") or 0.0),
        "ramGb": float(hw_info.get("ramGb") or 0.0),
        "cpuCores": int(hw_info.get("cpuCores") or cpu_core_count()),
        "freeDiskGb": free_disk,
    }


def _manifest_path() -> Path:
    return models_dir() / "manifest.json"


def read_manifest() -> dict[str, dict[str, Any]]:
    global _MANIFEST_MEM_CACHE
    path = _manifest_path()
    try:
        st = path.stat()
    except OSError:
        return {}
    path_key = str(path)
    cached = _MANIFEST_MEM_CACHE
    if cached is not None and cached[0] == path_key and cached[1] == st.st_mtime_ns and cached[2] == st.st_size:
        return copy.deepcopy(cached[3])
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            _MANIFEST_MEM_CACHE = (path_key, st.st_mtime_ns, st.st_size, copy.deepcopy(payload))
            return payload
        return {}
    except Exception:
        return {}


def update_manifest_entry(engine_id: str, **fields: Any) -> dict[str, Any]:
    global _MANIFEST_MEM_CACHE
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
        with contextlib.suppress(OSError):
            st = path.stat()
            _MANIFEST_MEM_CACHE = (str(path), st.st_mtime_ns, st.st_size, copy.deepcopy(data))
        return current


def remove_manifest_entry(engine_id: str) -> bool:
    global _MANIFEST_MEM_CACHE
    with _MANIFEST_LOCK:
        data = read_manifest()
        if engine_id not in data:
            return False
        data.pop(engine_id, None)
        path = _manifest_path()
        if path.parent.exists():
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
            with contextlib.suppress(OSError):
                st = path.stat()
                _MANIFEST_MEM_CACHE = (str(path), st.st_mtime_ns, st.st_size, copy.deepcopy(data))
        else:
            _MANIFEST_MEM_CACHE = None
        return True


def invalidate_engine_runtime_caches(*, clear_portable_tess: bool = False) -> None:
    global _DISK_FREE_CACHE, _PORTABLE_TESS_CACHE
    with _HW_CACHE_LOCK:
        _DISK_FREE_CACHE = None
    _VENV_DIST_VER_CACHE.clear()
    if clear_portable_tess:
        _PORTABLE_TESS_CACHE = None
        _TESS_VER_CACHE.clear()


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


def _is_windows() -> bool:
    return os.name == "nt"


def portable_tesseract_executable() -> str | None:
    global _PORTABLE_TESS_CACHE
    base = models_dir() / "tesseract-bin"
    try:
        st = base.stat()
    except OSError:
        return None
    if not base.is_dir():
        return None
    base_key = str(base)
    cached = _PORTABLE_TESS_CACHE
    if cached is not None and cached[0] == base_key and cached[1] == st.st_mtime_ns:
        if cached[2] is None or Path(cached[2]).is_file():
            return cached[2]
    candidates = (
        [base / "tesseract.exe", base / "Tesseract-OCR" / "tesseract.exe", base / "bin" / "tesseract.exe"]
        if _is_windows()
        else [base / "bin" / "tesseract", base / "tesseract"]
    )
    resolved: str | None = None
    for candidate in candidates:
        if candidate.is_file():
            resolved = str(candidate)
            break
    if resolved is None and _is_windows():
        for found in base.rglob("tesseract.exe"):
            if found.is_file():
                resolved = str(found)
                break
    if resolved is not None:
        _PORTABLE_TESS_CACHE = (base_key, st.st_mtime_ns, resolved)
    return resolved


def detect_tesseract_version(executable: str | None) -> str | None:
    if not executable:
        return None
    cache_key: tuple[str, int, int, int] | None = None
    try:
        st = Path(executable).stat()
        if Path(executable).is_file():
            cache_key = (str(executable), st.st_mtime_ns, st.st_size, id(subprocess.run))
    except OSError:
        cache_key = None
    if cache_key is not None and cache_key in _TESS_VER_CACHE:
        return _TESS_VER_CACHE[cache_key]
    detected: str | None = None
    try:
        proc = _run_Subprocess([executable, "--version"], capture_output=True, text=True, timeout=10, check=False)
        first_line = (proc.stdout or proc.stderr or "").splitlines()[0] if (proc.stdout or proc.stderr) else ""
        match = re.search(r"tesseract\s+v?([0-9][0-9A-Za-z._-]*)", first_line, flags=re.IGNORECASE)
        if match:
            detected = match.group(1)
    except Exception:
        detected = None
    if cache_key is not None:
        if len(_TESS_VER_CACHE) > 32:
            _TESS_VER_CACHE.clear()
        _TESS_VER_CACHE[cache_key] = detected
    return detected


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
    candidates: list[dict[str, Any]] = []
    try:
        rel = _fetch_json("https://api.github.com/repos/UB-Mannheim/tesseract/releases/latest", timeout=10.0)
        if isinstance(rel, dict):
            candidates.append(rel)
    except Exception:
        pass
    try:
        if not any(
            str(a.get("browser_download_url") or "") and "w64" in str(a.get("name") or "").lower() and str(a.get("name") or "").lower().endswith(".exe")
            for r in candidates for a in (r.get("assets") or [])
        ):
            rels = _fetch_json("https://api.github.com/repos/UB-Mannheim/tesseract/releases?per_page=5", timeout=10.0)
            if isinstance(rels, list):
                candidates.extend(r for r in rels if isinstance(r, dict))
    except Exception:
        pass
    for rel in candidates:
        tag = str(rel.get("tag_name") or DEFAULT_TESSERACT_WIN_TAG).lstrip("vV")
        for asset in rel.get("assets") or []:
            name = str(asset.get("name") or "").lower()
            dl_url = str(asset.get("browser_download_url") or "")
            if dl_url and "w64" in name and name.endswith(".exe"):
                return tag, dl_url
    return DEFAULT_TESSERACT_WIN_TAG.lstrip("vV"), DEFAULT_TESSERACT_WIN_URL


def _find_windows_7zip() -> str | None:
    for cmd in ("7z", "7za"):
        found = shutil.which(cmd)
        if found:
            return found
    for env_key, default_root in (
        ("ProgramFiles", r"C:\Program Files"),
        ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    ):
        cand = Path(os.environ.get(env_key, default_root)) / "7-Zip" / "7z.exe"
        if cand.is_file():
            return str(cand)
    return None


def install_tesseract_runtime(error_cls: type[Exception], cancel_event: threading.Event | None = None) -> str:
    if cancel_event is not None and cancel_event.is_set():
        raise error_cls("عملیات آماده‌سازی مدل لغو شد.")
    target_dir = models_dir() / "tesseract-bin"
    backup_dir = models_dir() / "tesseract-bin.old-ver"
    if backup_dir.exists():
        shutil.rmtree(backup_dir, ignore_errors=True)
    if _is_windows():
        had_existing_portable = portable_tesseract_executable() is not None and target_dir.is_dir()
        if had_existing_portable:
            try:
                os.replace(target_dir, backup_dir)
            except OSError:
                shutil.rmtree(backup_dir, ignore_errors=True)
        target_dir.mkdir(parents=True, exist_ok=True)
        version_tag, installer_url = _latest_tesseract_windows_installer()
        # Avoid "setup"/"install"/"update" in filename so Windows Heuristic Installer Detection never forces UAC elevation (WinError 740).
        installer_path = target_dir / f"tesseract-runtime-{version_tag}.exe"
        part_path = target_dir / f".tesseract-runtime-{version_tag}.exe.part"
        elevation_err: OSError | None = None
        try:
            emit(f"دریافت خودکار موتور اجرایی Tesseract ({version_tag}) برای ویندوز آغاز شد", progress=0.10)
            req = urllib.request.Request(installer_url, headers={"User-Agent": "Comic-OCR-Studio"})
            with urllib.request.urlopen(req, timeout=300) as resp, part_path.open("wb") as out:
                hdrs = getattr(resp, "headers", None)
                raw_len = hdrs.get("Content-Length") if hdrs and hasattr(hdrs, "get") else None
                expected_bytes = int(raw_len) if raw_len and str(raw_len).isdigit() else 55 * 1024 * 1024
                total = 0
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        raise error_cls("عملیات آماده‌سازی مدل لغو شد.")
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    out.write(chunk)
                    ratio = min(1.0, total / max(1, expected_bytes))
                    emit(
                        f"دانلود موتور Tesseract: {total / (1024 * 1024):.1f} مگابایت دریافت شد",
                        progress=round(0.12 + 0.50 * ratio, 3),
                    )
                    if total > 220 * 1024 * 1024:
                        raise error_cls("Downloaded Tesseract installer exceeded safe size limit.")
            if part_path.stat().st_size < 1_000_000:
                raise error_cls("Downloaded Tesseract installer is incomplete or invalid.")
            os.replace(part_path, installer_path)
            emit("نصب بی‌صدای Tesseract بدون نیاز به دسترسی ادمین در پوشهٔ برنامه آغاز شد…", progress=0.68)
            # 1) Non-elevated user-mode NSIS install (__COMPAT_LAYER=RunAsInvoker + /CurrentUser avoids WinError 740 on UB-Mannheim MultiUser.nsh).
            invoker_env = dict(os.environ)
            invoker_env["__COMPAT_LAYER"] = "RunAsInvoker"
            cmdline = f'"{installer_path}" /CurrentUser /S /D={target_dir}'
            try:
                _run_Subprocess(cmdline, shell=False, env=invoker_env, capture_output=True, text=True, timeout=600, check=False)
            except OSError as os_exc:
                elevation_err = os_exc

            # 2) Direct portable archive extraction via 7-Zip if corporate GPO blocked RunAsInvoker.
            if not portable_tesseract_executable():
                seven_zip = _find_windows_7zip()
                if seven_zip:
                    emit("استخراج مستقیم فایل‌های اجرایی Tesseract در پوشهٔ برنامه…", progress=0.73)
                    try:
                        _run_Subprocess(
                            [seven_zip, "x", "-y", f"-o{target_dir}", str(installer_path)],
                            capture_output=True, text=True, timeout=300, check=False,
                        )
                        shutil.rmtree(target_dir / "$PLUGINSDIR", ignore_errors=True)
                    except OSError:
                        pass

            # 3) Winget user-scope non-admin fallback.
            if not portable_tesseract_executable():
                winget = shutil.which("winget")
                if winget:
                    emit("تلاش جایگزین برای نصب کاربری Tesseract از طریق Winget…", progress=0.76)
                    try:
                        _run_Subprocess(
                            [
                                winget, "install", "--id", "UB-Mannheim.TesseractOCR",
                                "--silent", "--accept-package-agreements", "--accept-source-agreements",
                                "--scope", "user",
                            ],
                            capture_output=True, text=True, timeout=600, check=False,
                        )
                    except OSError:
                        pass

            # 4) Standard Windows UAC prompt via ShellExecute (PowerShell Start-Process -Verb RunAs) if policy strictly requires elevation.
            if not (portable_tesseract_executable() or shutil.which("tesseract")):
                pwsh = shutil.which("powershell") or shutil.which("pwsh")
                if pwsh and installer_path.is_file():
                    emit("درخواست تأیید استاندارد ویندوز (UAC) برای تکمیل نصب Tesseract…", progress=0.79)
                    ps_exe = str(installer_path).replace("'", "''")
                    ps_dir = str(target_dir).replace("'", "''")
                    ps_cmd = (
                        f"Start-Process -FilePath '{ps_exe}' "
                        f"-ArgumentList '/CurrentUser','/S','/D={ps_dir}' -Verb RunAs -Wait"
                    )
                    try:
                        _run_Subprocess(
                            [pwsh, "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                            capture_output=True, text=True, timeout=600, check=False,
                        )
                    except OSError:
                        pass
        except error_cls:
            if backup_dir.is_dir() and not portable_tesseract_executable():
                shutil.rmtree(target_dir, ignore_errors=True)
                try:
                    os.replace(backup_dir, target_dir)
                except OSError:
                    pass
            raise
        except Exception as exc:
            if backup_dir.is_dir() and not portable_tesseract_executable():
                shutil.rmtree(target_dir, ignore_errors=True)
                try:
                    os.replace(backup_dir, target_dir)
                except OSError:
                    pass
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
            if backup_dir.is_dir():
                shutil.rmtree(target_dir, ignore_errors=True)
                try:
                    os.replace(backup_dir, target_dir)
                except OSError:
                    pass
            extra_hint = (
                "؛ اگر سیاست امنیتی ویندوز اجرای نصاب کاربری را مسدود کرده است، برنامه را یک‌بار با start_windows_admin.bat باز کنید."
                if elevation_err is not None
                else "؛ دسترسی پوشهٔ برنامه را بررسی کنید."
            )
            raise error_cls(f"فایل اجرایی Tesseract پس از نصب خودکار پیدا نشد{extra_hint}")
        if backup_dir.is_dir():
            shutil.rmtree(backup_dir, ignore_errors=True)
        for old_installer in (*target_dir.glob("*tesseract-setup*.exe*"), *target_dir.glob("*tesseract-runtime*.exe*")):
            old_installer.unlink(missing_ok=True)
        update_manifest_entry("tesseract", installedTag=version_tag)
        emit("موتور اجرایی Tesseract با موفقیت آماده شد", "success", progress=0.82)
        return exe
    target_dir.mkdir(parents=True, exist_ok=True)

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
        try:
            st = sp.stat()
        except OSError:
            continue
        if not sp.is_dir():
            continue
        cache_key = (str(sp), st.st_mtime_ns, normalized)
        if cache_key in _VENV_DIST_VER_CACHE:
            cached_ver = _VENV_DIST_VER_CACHE[cache_key]
            if cached_ver is not None:
                return cached_ver
            continue
        found_ver: str | None = None
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
                            found_ver = line.split(":", 1)[1].strip()
                            break
                except Exception:
                    pass
            if found_ver:
                break
        if len(_VENV_DIST_VER_CACHE) > 256:
            _VENV_DIST_VER_CACHE.clear()
        _VENV_DIST_VER_CACHE[cache_key] = found_ver
        if found_ver:
            return found_ver
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
        self._worker_stderr_tail: deque[str] = deque(maxlen=40)
        self._idle_timer_lock = threading.Lock()
        self._idle_timer: threading.Timer | None = None
        self._last_used_mono: float = 0.0
        self._idle_timeout_sec: float = _WORKER_IDLE_TIMEOUT_SECONDS
        self._cancel_install = threading.Event()
        self._cancel_ocr = threading.Event()
        self._proc_ref_lock = threading.Lock()
        self._active_procs_lock = threading.Lock()
        self._active_install_procs: set[subprocess.Popen[Any]] = set()
        atexit.register(self.close)

    def _register_install_proc(self, proc: subprocess.Popen[Any]) -> None:
        with self._active_procs_lock:
            self._active_install_procs.add(proc)

    def _unregister_install_proc(self, proc: subprocess.Popen[Any]) -> None:
        with self._active_procs_lock:
            self._active_install_procs.discard(proc)

    def _kill_proc_tree(self, proc: subprocess.Popen[Any]) -> None:
        _kill_process_tree(proc)

    def cancel_install(self) -> None:
        self._cancel_install.set()
        with self._active_procs_lock:
            procs = list(self._active_install_procs)
        for proc in procs:
            self._kill_proc_tree(proc)

    def cancel_ocr(self) -> None:
        """Preemptively abort any in-flight or booting OCR worker without deadlocking on `_worker_lock`."""
        self._cancel_ocr.set()
        self._cancel_idle_timer()
        with self._proc_ref_lock:
            proc = self._worker_proc
            self._worker_proc = None
        if proc is not None:
            self._kill_proc_tree(proc)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None:
                    with contextlib.suppress(Exception):
                        stream.close()
        if self.id == "surya":
            _stop_lingering_surya_server()

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

    @property
    def is_loaded_in_ram(self) -> bool:
        return self._worker_proc is not None and self._worker_proc.poll() is None

    @property
    def worker_pid(self) -> int | None:
        proc = self._worker_proc
        if proc is not None and proc.poll() is None:
            return proc.pid
        return None

    def _cancel_idle_timer(self) -> None:
        with self._idle_timer_lock:
            timer = self._idle_timer
            self._idle_timer = None
        if timer is not None:
            timer.cancel()

    def _arm_idle_timer(self) -> None:
        self._last_used_mono = time.monotonic()
        with self._idle_timer_lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            if not self.is_loaded_in_ram or self._idle_timeout_sec <= 0:
                return
            timer = threading.Timer(self._idle_timeout_sec, self._reap_if_idle)
            timer.daemon = True
            self._idle_timer = timer
            timer.start()

    def _reap_if_idle(self) -> None:
        with self._idle_timer_lock:
            self._idle_timer = None
        if not self._worker_lock.acquire(blocking=False):
            return
        reaped = False
        try:
            if self._worker_proc is None or self._worker_proc.poll() is not None:
                self._worker_proc = None
                return
            elapsed = time.monotonic() - self._last_used_mono
            if elapsed + 0.05 < self._idle_timeout_sec:
                return
            self._terminate_worker_locked()
            reaped = True
        finally:
            self._worker_lock.release()
        if reaped:
            trim_process_memory()

    def _terminate_worker_locked(self) -> None:
        with self._proc_ref_lock:
            proc = self._worker_proc
            self._worker_proc = None
        if proc is None:
            if self.id == "surya":
                _stop_lingering_surya_server()
            return
        if proc.poll() is None:
            try:
                if proc.stdin:
                    proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                    proc.stdin.flush()
                proc.wait(timeout=2)
            except Exception:
                pass
            if proc.poll() is None:
                _kill_process_tree(proc)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass
        if self.id == "surya":
            _stop_lingering_surya_server()

    def unload(self) -> None:
        self.close()

    def close(self) -> None:
        self._cancel_idle_timer()
        acquired = self._worker_lock.acquire(blocking=False)
        if not acquired:
            # Break any in-flight `readline()` immediately so `close()` never deadlocks.
            self.cancel_ocr()
            acquired = self._worker_lock.acquire(timeout=2.5)
        if acquired:
            try:
                self._terminate_worker_locked()
            finally:
                self._worker_lock.release()

    def uninstall(self) -> int:
        self.cancel_install()
        self.close()
        with self._install_lock:
            self.close()
            freed = uninstall_isolated_engine_files(self.id)
        trim_process_memory()
        return freed

    def _worker_env(self) -> dict[str, str]:
        env = dict(os.environ)
        llama_bin = self._env_dir() / "llama-bin"
        scripts_dir = self._env_python().parent
        extra_paths = [str(scripts_dir)]
        exe_name = "llama-server.exe" if _is_windows() else "llama-server"
        if llama_bin.is_dir():
            extra_paths.insert(0, str(llama_bin))
            if sys.platform.startswith("linux"):
                ld_prev = env.get("LD_LIBRARY_PATH", "")
                env["LD_LIBRARY_PATH"] = os.pathsep.join([p for p in (str(llama_bin), ld_prev) if p])
            for candidate_exe in llama_bin.rglob(exe_name):
                if candidate_exe.is_file():
                    env.setdefault("LLAMA_CPP_BINARY", str(candidate_exe))
                    break
        env["PATH"] = os.pathsep.join([*extra_paths, env.get("PATH", "")])
        env["PYTHONIOENCODING"] = "utf-8"
        cores_str = str(cpu_core_count())
        for thread_var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            env.setdefault(thread_var, cores_str)
        env.setdefault("OMP_WAIT_POLICY", "PASSIVE")
        env.setdefault("KMP_BLOCKTIME", "0")
        env.setdefault("TOKENIZERS_PARALLELISM", "true")
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        if self.id == "paddleocr-vl-1-6":
            # PaddlePaddle 3.3.x PIR -> oneDNN converter throws UnimplementedError on
            # pir::ArrayAttribute<pir::DoubleAttribute> (onednn_instruction.cc:118)
            # inside PaddleOCRVL's CPU 'cv' worker unless MKLDNN/oneDNN is disabled.
            env["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] = "False"
            env["FLAGS_use_mkldnn"] = "0"
        else:
            env.setdefault("FLAGS_use_mkldnn", "1")
        env.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
        env.setdefault("HF_HUB_ETAG_TIMEOUT", "60")
        env.setdefault("HF_HUB_DISABLE_XET", "1")
        env.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
        env.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
        m_root = models_dir()
        for sub_name in ("hf", "paddlex", "torch", "cache", "tmp"):
            with contextlib.suppress(OSError):
                (m_root / sub_name).mkdir(parents=True, exist_ok=True)
        env["HF_HOME"] = str(m_root / "hf")
        env["HUGGINGFACE_HUB_CACHE"] = str(m_root / "hf" / "hub")
        env["PADDLE_PDX_CACHE_HOME"] = str(m_root / "paddlex")
        env["TORCH_HOME"] = str(m_root / "torch")
        env["XDG_CACHE_HOME"] = str(m_root / "cache")
        env["TMPDIR"] = str(m_root / "tmp")
        env["TEMP"] = str(m_root / "tmp")
        env["TMP"] = str(m_root / "tmp")
        if self.id == "mineru-2-5-pro":
            mineru_home = m_root / "mineru"
            with contextlib.suppress(OSError):
                mineru_home.mkdir(parents=True, exist_ok=True)
            env["MINERU_HOME"] = str(mineru_home)
        if self.id == "hezar-ocr":
            hezar_home = m_root / "hezar"
            with contextlib.suppress(OSError):
                hezar_home.mkdir(parents=True, exist_ok=True)
            env["HEZAR_CACHE_DIR"] = str(hezar_home)
        if self.id == "surya":
            hw = inspect_hardware()
            surya_cache = m_root / "surya"
            try:
                surya_cache.mkdir(parents=True, exist_ok=True)
            except OSError:
                pass
            env["MODEL_CACHE_DIR"] = str(surya_cache)
            # Always use native llama.cpp rather than Surya 2.5's Docker-only vLLM backend.
            # Context size 24576 + max_tokens 4096 prevents llama-server HTTP 400 context
            # overflow when scale_to_fit produces ~8k visual tokens on high-res book pages,
            # and disabling logprobs avoids 152k-vocab softmax overhead on every token.
            env.setdefault("SURYA_INFERENCE_BACKEND", "llamacpp")
            env.setdefault("SURYA_INFERENCE_PARALLEL", "1")
            env.setdefault("SURYA_INFERENCE_CTX_SIZE", "24576")
            env.setdefault("SURYA_MAX_TOKENS_FULL_PAGE", "4096")
            env.setdefault("SURYA_INFERENCE_LOGPROBS", "false")
            env.setdefault("SURYA_INFERENCE_KEEP_ALIVE", "false")
            vram_gb = float(hw.get("vramGb") or 0.0)
            has_vulkan_bin = False
            if llama_bin.is_dir():
                with contextlib.suppress(OSError):
                    has_vulkan_bin = any("vulkan" in p.name.lower() for p in llama_bin.rglob("*vulkan*"))
            use_gpu_layers = (
                sys.platform == "darwin"
                or (bool(hw.get("hasNvidiaGpu")) and (vram_gb <= 0.0 or vram_gb >= 4.5))
            )
            ngl_str = "99" if use_gpu_layers else "0"
            env.setdefault("LLAMA_CPP_NGL", ngl_str)
            # Root-cause fix for `failed to process mtmd chunk, res = -1`:
            # 1) llama-server defaults `mmproj_use_gpu = true` EVEN when `-ngl 0`! On Vulkan builds
            #    (and Intel/AMD/low-VRAM GPUs), Surya 2.5's CLIP vision graph (`head_dim = 72`) lacks
            #    Vulkan FlashAttention (`FLASH_ATTN_EXT`), falling back to multi-GB dense attention
            #    buffers that exceed Vulkan's maxStorageBufferRange / VRAM (`ErrorOutOfDeviceMemory` /
            #    `ErrorDeviceLost` -> `failed to process mtmd chunk, res = -1`).
            # 2) Passing `--no-mmproj-offload` keeps the vision projector safe on multi-core CPU while
            #    allowing NVIDIA GPUs to keep `-ngl 99` for fast 2B LLM decoding; `-b 2048 -ub 2048`
            #    raises the physical micro-batch above the 512 default so large vision chunks decode cleanly.
            no_mmproj_gpu = (
                ngl_str == "0"
                or has_vulkan_bin
                or (sys.platform != "darwin" and 0.0 < vram_gb < 7.5)
            )
            env.setdefault("LLAMA_CPP_NO_MMPROJ_OFFLOAD", "true" if no_mmproj_gpu else "false")
            if ngl_str == "0":
                extra_args = "-b 2048 -ub 2048 --flash-attn off --device none"
            elif has_vulkan_bin:
                extra_args = "-b 2048 -ub 2048 --flash-attn off"
            else:
                extra_args = "-b 2048 -ub 2048"
            env.setdefault("LLAMA_CPP_EXTRA_ARGS", extra_args)
        return env

    def _ensure_llama_cpp_for_surya(self) -> None:
        if not self._spec.get("needs_llama_cpp_cpu"):
            return
        if self._cancel_install.is_set():
            raise self._error_cls("عملیات آماده‌سازی مدل لغو شد.")
        llama_dir = self._env_dir() / "llama-bin"
        exe_name = "llama-server.exe" if _is_windows() else "llama-server"
        if any(llama_dir.rglob(exe_name)) or shutil.which("llama-server"):
            return
        hw = inspect_hardware()
        mode_hint = "شتاب‌دهندهٔ گرافیکی (Vulkan)" if hw.get("hasGpu") else "پردازنده (CPU)"
        emit(f"دریافت خودکار موتور اجرایی llama-server ({mode_hint}) برای Surya…", progress=0.72)

        releases: list[dict[str, Any]] = []
        try:
            raw_rels = _fetch_json("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8", timeout=20.0)
            if isinstance(raw_rels, list):
                releases = [r for r in raw_rels if isinstance(r, dict)]
        except Exception:
            pass
        if not releases:
            try:
                latest_rel = _fetch_json("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", timeout=15.0)
                if isinstance(latest_rel, dict):
                    releases = [latest_rel]
            except Exception:
                pass

        asset_name, wanted_url = _pick_llama_cpp_asset(
            releases,
            has_gpu=bool(hw.get("hasGpu")),
            is_win=_is_windows(),
            plat=sys.platform,
            machine=platform.machine(),
        )
        if not wanted_url:
            raise self._error_cls(
                "فایل اجرایی llama-server برای سیستم‌عامل شما در انتشارهای رسمی llama.cpp پیدا نشد. اتصال اینترنت به GitHub را بررسی کنید."
            )

        llama_dir.mkdir(parents=True, exist_ok=True)
        suffix = ".tar.gz" if asset_name.lower().endswith(".tar.gz") else ".zip"
        arc_tmp = llama_dir / f".llama-bin{suffix}.part"
        try:
            req = urllib.request.Request(wanted_url, headers={"User-Agent": "Comic-OCR-Studio"})
            with urllib.request.urlopen(req, timeout=30) as resp, arc_tmp.open("wb") as out:
                hdrs = getattr(resp, "headers", None)
                raw_len = hdrs.get("Content-Length") if hdrs and hasattr(hdrs, "get") else None
                expected_bytes = int(raw_len) if raw_len and str(raw_len).isdigit() else 35 * 1024 * 1024
                total = 0
                last_emit_total = 0
                while True:
                    if self._cancel_install.is_set() or is_job_cancelled():
                        raise self._error_cls("عملیات آماده‌سازی مدل لغو شد.")
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    out.write(chunk)
                    if total - last_emit_total >= 256 * 1024 or total >= expected_bytes:
                        last_emit_total = total
                        ratio = min(1.0, total / max(1, expected_bytes))
                        emit(
                            f"دانلود موتور اجرایی llama-server برای Surya: {total / (1024 * 1024):.1f} از {expected_bytes / (1024 * 1024):.1f} مگابایت",
                            progress=round(0.73 + 0.06 * ratio, 3),
                        )
            resolved_llama_dir = llama_dir.resolve()
            if suffix == ".zip":
                with zipfile.ZipFile(arc_tmp) as archive:
                    for member in archive.infolist():
                        member_path = (llama_dir / member.filename).resolve()
                        if not member_path.is_relative_to(resolved_llama_dir):
                            continue
                        archive.extract(member, llama_dir)
            else:
                with tarfile.open(arc_tmp, "r:*") as tar_arc:
                    for tmember in tar_arc.getmembers():
                        member_path = (llama_dir / tmember.name).resolve()
                        if not member_path.is_relative_to(resolved_llama_dir):
                            continue
                        if tmember.issym() or tmember.islnk():
                            link_target = (member_path.parent / tmember.linkname).resolve()
                            if not link_target.is_relative_to(resolved_llama_dir):
                                continue
                        try:
                            tar_arc.extract(tmember, llama_dir, filter="data")
                        except TypeError:
                            tar_arc.extract(tmember, llama_dir)
            for found in llama_dir.rglob(exe_name):
                if found.parent != llama_dir:
                    for item in list(found.parent.iterdir()):
                        dest = llama_dir / item.name
                        if not dest.exists():
                            shutil.move(str(item), str(dest))
                if not _is_windows():
                    target_exe = llama_dir / exe_name
                    if target_exe.exists():
                        target_exe.chmod(0o755)
                break
        finally:
            arc_tmp.unlink(missing_ok=True)

    def _run_pip_streaming(
        self,
        pip_cmd: list[str],
        *,
        start_p: float,
        end_p: float,
        label_prefix: str,
        timeout: int = 3600,
        stall_timeout: int = 180,
    ) -> tuple[int, str]:
        if self._cancel_install.is_set():
            return 130, "عملیات آماده‌سازی مدل لغو شد."
        full_cmd = [*pip_cmd, "--progress-bar", "off"]
        tail_lines: list[str] = []
        started = time.monotonic()
        last_activity_ts = started
        current_pkg_label = ""
        cdir = pip_cache_dir()
        env_dir = self._env_dir()
        initial_bytes = _dir_bytes_fast(cdir) + _dir_bytes_fast(env_dir)
        last_bytes = initial_bytes
        prof_rt_gb = float(compute_engine_download_estimate(self.id).get("runtimeDownloadGb") or 0.5)
        span_p = max(0.02, end_p - start_p)
        expected_bytes = max(35 * (1024 ** 2), prof_rt_gb * (1024 ** 3) * min(1.0, span_p / 0.50))
        announced_bytes = 0.0
        completed_wheel_bytes = 0.0
        active_wheel_bytes = 0.0
        collect_steps = 0
        best_p = start_p

        def _emit_bounded(msg: str, ratio: float) -> None:
            nonlocal best_p
            clamped = max(0.0, min(0.98, ratio))
            best_p = max(best_p, round(start_p + span_p * clamped, 3))
            emit(msg, progress=best_p)

        proc = subprocess.Popen(
            full_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=clean_pip_env(),
            creationflags=_SUBPROCESS_NO_WINDOW if os.name == "nt" else 0,
        )
        self._register_install_proc(proc)
        line_q: queue.Queue[str | None] = queue.Queue()

        def _reader() -> None:
            try:
                if proc.stdout is not None:
                    for rline in proc.stdout:
                        line_q.put(rline)
            except Exception:
                pass
            finally:
                line_q.put(None)

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()
        try:
            while True:
                if self._cancel_install.is_set():
                    self._kill_proc_tree(proc)
                    return 130, "عملیات آماده‌سازی مدل لغو شد."
                now_m = time.monotonic()
                if now_m - started > timeout:
                    self._kill_proc_tree(proc)
                    return 1, "Operation timed out during pip installation."
                try:
                    raw_line = line_q.get(timeout=2.0)
                except queue.Empty:
                    if proc.poll() is not None and line_q.empty():
                        break
                    now_bytes = _dir_bytes_fast(cdir) + _dir_bytes_fast(env_dir)
                    if now_bytes > last_bytes:
                        last_bytes = now_bytes
                        last_activity_ts = time.monotonic()
                        gained_bytes = max(0.0, float(now_bytes - initial_bytes))
                        gained_mb = gained_bytes / (1024 * 1024)
                        if gained_mb >= 0.8:
                            denom = max(expected_bytes, announced_bytes * 1.04, gained_bytes * 1.06)
                            dl_ratio = min(1.0, max(gained_bytes, completed_wheel_bytes) / max(1.0, denom))
                            pkg_note = f" ({current_pkg_label})" if current_pkg_label else ""
                            _emit_bounded(
                                f"{label_prefix}: در حال دانلود{pkg_note} — {gained_mb:.1f} مگابایت دریافت شد…",
                                0.08 + 0.78 * dl_ratio,
                            )
                    elif time.monotonic() - last_activity_ts > stall_timeout:
                        self._kill_proc_tree(proc)
                        return 1, (
                            f"ReadTimeoutError: Operation timed out during pip installation "
                            f"(no network bytes received for {stall_timeout}s).\n" + "\n".join(tail_lines)
                        )
                    continue

                if raw_line is None:
                    break
                last_activity_ts = time.monotonic()
                line = raw_line.strip()
                if not line:
                    continue
                tail_lines.append(line)
                if len(tail_lines) > 80:
                    tail_lines.pop(0)
                lower = line.lower()
                if lower.startswith("downloading "):
                    completed_wheel_bytes += active_wheel_bytes
                    wheel_part = line.split("/")[-1].split(" ")[0][:48]
                    size_m = re.search(r"\(([\d.]+\s*[kKmMgG][bB])\)", line)
                    size_str = size_m.group(1) if size_m else ""
                    active_wheel_bytes = _parse_size_to_bytes(size_str)
                    announced_bytes += active_wheel_bytes
                    expected_bytes = max(expected_bytes, announced_bytes * 1.05)
                    current_pkg_label = f"{wheel_part} · {size_str}" if size_str else wheel_part
                    now_bytes = _dir_bytes_fast(cdir) + _dir_bytes_fast(env_dir)
                    last_bytes = max(last_bytes, now_bytes)
                    gained_bytes = max(0.0, float(now_bytes - initial_bytes), completed_wheel_bytes)
                    dl_ratio = min(1.0, gained_bytes / max(1.0, expected_bytes))
                    size_suffix = f" ({size_str})" if size_str else ""
                    _emit_bounded(
                        f"{label_prefix}: دانلود بستهٔ {wheel_part}{size_suffix}…",
                        0.08 + 0.78 * dl_ratio,
                    )
                elif lower.startswith("using cached "):
                    completed_wheel_bytes += active_wheel_bytes
                    active_wheel_bytes = 0.0
                    wheel_part = line.split("/")[-1].split(" ")[0][:44]
                    dl_ratio = min(1.0, completed_wheel_bytes / max(1.0, expected_bytes))
                    _emit_bounded(
                        f"{label_prefix}: استفاده از فایل کش‌شدهٔ {wheel_part}…",
                        0.08 + 0.78 * dl_ratio,
                    )
                elif lower.startswith("collecting "):
                    collect_steps += 1
                    pkg_part = line[11:].split()[0][:40]
                    current_pkg_label = pkg_part
                    _emit_bounded(
                        f"{label_prefix}: بررسی بستهٔ {pkg_part}…",
                        min(0.08, collect_steps * 0.008),
                    )
                elif lower.startswith("installing collected packages"):
                    completed_wheel_bytes += active_wheel_bytes
                    active_wheel_bytes = 0.0
                    current_pkg_label = "ثبت بسته‌ها روی دیسک"
                    _emit_bounded(
                        f"{label_prefix}: در حال بازگشایی و ثبت بسته‌ها روی دیسک…",
                        0.90,
                    )
            rc = proc.wait(timeout=120)
            if self._cancel_install.is_set():
                return 130, "عملیات آماده‌سازی مدل لغو شد."
            return rc, "\n".join(tail_lines)
        except Exception as exc:
            self._kill_proc_tree(proc)
            return 1, f"{exc}\n" + "\n".join(tail_lines)
        finally:
            self._unregister_install_proc(proc)
            if proc.stdout is not None:
                try:
                    proc.stdout.close()
                except Exception:
                    pass
            if proc.poll() is None:
                self._kill_proc_tree(proc)

    def _clean_broken_venv_artifacts(self) -> None:
        env_dir = self._env_dir()
        if not env_dir.is_dir():
            return
        site_dirs = (
            [env_dir / "Lib" / "site-packages"]
            if _is_windows()
            else list((env_dir / "lib").glob("python*/site-packages"))
        )
        for sp in site_dirs:
            if not sp.is_dir():
                continue
            for broken in sp.glob("~*"):
                _remove_path_safely(broken)

    def _run_pip_resilient(
        self,
        py: Path,
        packages_and_flags: list[str],
        *,
        upgrade: bool,
        start_p: float,
        end_p: float,
        label_prefix: str,
        timeout: int = 3600,
    ) -> tuple[int, str]:
        cdir = pip_cache_dir()
        wheelhouse = sync_local_wheelhouse()
        has_custom_index = bool(os.environ.get("PIP_INDEX_URL")) or ("--index-url" in packages_and_flags) or ("-i" in packages_and_flags)

        attempts: list[tuple[str | None, str | None]] = [
            (None, None),
            (None, "اختلال موقت شبکه در دریافت بسته؛ تلاش مجدد با ادامه از فایل‌های کش‌شده…"),
        ]
        if not has_custom_index:
            for mirror_name, mirror_url in PYPI_FALLBACK_MIRRORS:
                attempts.append((
                    mirror_url,
                    f"سرور اصلی PyPI پاسخ نداد یا دچار کندی شدید است؛ ادامهٔ نصب از مسیر جایگزین ({mirror_name})…",
                ))

        last_rc, last_out = 1, "pip failed"
        for idx, (mirror_url, retry_notice) in enumerate(attempts):
            if self._cancel_install.is_set():
                return 130, "عملیات آماده‌سازی مدل لغو شد."
            if idx > 0:
                if retry_notice:
                    emit(retry_notice, "warning", progress=start_p)
                time.sleep(1.5)
                wheelhouse = sync_local_wheelhouse()
            self._clean_broken_venv_artifacts()

            cmd = [
                str(py), "-m", "pip", "install",
                "--timeout", "120",
                "--retries", "10",
                "--prefer-binary",
                "--cache-dir", str(cdir),
            ]
            try:
                if wheelhouse.is_dir() and any(wheelhouse.glob("*.whl")):
                    cmd.extend(["--find-links", str(wheelhouse)])
            except OSError:
                pass
            if mirror_url:
                cmd.extend(["--index-url", mirror_url])
            if upgrade:
                cmd.append("--upgrade")
            cmd.extend(packages_and_flags)

            rc, out = self._run_pip_streaming(
                cmd,
                start_p=start_p,
                end_p=end_p,
                label_prefix=label_prefix,
                timeout=timeout,
            )
            last_rc, last_out = rc, out
            if rc == 0:
                sync_local_wheelhouse()
                return 0, out
            if self._cancel_install.is_set() or rc == 130:
                return rc, out
            if not is_pip_network_or_index_error(out):
                return rc, out
        return last_rc, last_out

    def _ensure_isolated_venv(self, upgrade: bool = False) -> None:
        env_dir = self._env_dir()
        py = self._env_python()
        hw = inspect_hardware()
        with self._install_lock:
            cdir = pip_cache_dir()
            wheelhouse = sync_local_wheelhouse()
            find_links_args: list[str] = []
            try:
                if wheelhouse.is_dir() and any(wheelhouse.glob("*.whl")):
                    find_links_args = ["--find-links", str(wheelhouse)]
            except OSError:
                pass

            if getattr(sys, "frozen", False):
                from .ocr import _resolve_pip_python_executable
                try:
                    base_py = _resolve_pip_python_executable(match_current_minor=False)
                except Exception as exc:
                    raise self._error_cls(str(exc)) from exc
            else:
                base_py = getattr(sys, "_base_executable", None) or sys.executable
                if not base_py or not os.path.isfile(base_py):
                    base_py = sys.executable

            rt_pair = getattr(self, "_active_rt_span", None) or (0.06, 0.72)
            r_lo, r_hi = float(rt_pair[0]), float(rt_pair[1])
            r_span = max(0.04, r_hi - r_lo)
            rp = lambda frac: round(r_lo + r_span * max(0.0, min(1.0, frac)), 3)

            if not py.is_file():
                emit(f"ساخت پوشه و محیط مستقل برای مدل {self.id}…", progress=rp(0.03))
                env_dir.parent.mkdir(parents=True, exist_ok=True)
                res = _run_Subprocess([str(base_py), "-m", "venv", str(env_dir)], capture_output=True, text=True, timeout=300, check=False)
                if res.returncode != 0 or not py.is_file():
                    raise self._error_cls(f"ساخت محیط مستقل برای {self.id} ناموفق بود: {(res.stderr or res.stdout)[-800:]}")
                emit(f"آماده‌سازی ابزار نصب در محیط مستقل {self.id}…", progress=rp(0.10))
                _run_Subprocess([str(py), "-m", "ensurepip", "--upgrade"], capture_output=True, text=True, timeout=300, check=False)
                _run_Subprocess(
                    [str(py), "-m", "pip", "install", "--timeout", "90", "--retries", "5", "--prefer-binary", "--cache-dir", str(cdir), *find_links_args, "--upgrade", "pip", "setuptools", "wheel"],
                    capture_output=True, text=True, timeout=600, check=False, env=clean_pip_env(),
                )
            else:
                self._clean_broken_venv_artifacts()
                py_probe = _run_Subprocess([str(py), "-c", "import sys"], capture_output=True, text=True, timeout=30, check=False)
                if py_probe.returncode != 0:
                    _run_Subprocess([str(base_py), "-m", "venv", "--upgrade", str(env_dir)], capture_output=True, text=True, timeout=180, check=False)
                pip_probe = _run_Subprocess([str(py), "-m", "pip", "--version"], capture_output=True, text=True, timeout=60, check=False)
                if pip_probe.returncode != 0:
                    _run_Subprocess([str(py), "-m", "ensurepip", "--upgrade"], capture_output=True, text=True, timeout=300, check=False)

            if self._spec.get("needs_torch"):
                existing_torch_ver = _read_dist_version_in_venv(env_dir, "torch")
                existing_tv_ver = _read_dist_version_in_venv(env_dir, "torchvision")
                repair_cpu_torch_on_nvidia = bool(
                    upgrade
                    and _is_windows()
                    and hw.get("hasNvidiaGpu")
                    and existing_torch_ver
                    and "+cu" not in existing_torch_ver.lower()
                )
                torch_ready = (
                    existing_torch_ver is not None
                    and existing_tv_ver is not None
                    and not repair_cpu_torch_on_nvidia
                )
                if not torch_ready:
                    if repair_cpu_torch_on_nvidia:
                        emit(f"جایگزینی نسخهٔ CPU زیرساخت PyTorch با نسخهٔ شتاب‌دهندهٔ NVIDIA برای {self.id}…", progress=rp(0.18))
                        _run_Subprocess(
                            [str(py), "-m", "pip", "uninstall", "-y", "torch", "torchvision"],
                            capture_output=True, text=True, timeout=180, check=False, env=clean_pip_env(),
                        )
                    base_torch_pkgs = ["torch>=2.3.0", "torchvision>=0.18.0"]
                    torch_candidates: list[list[str]] = []
                    if hw.get("hasNvidiaGpu"):
                        # Dedicated --index-url ensures pip installs genuine CUDA wheels (+cu128/+cu126)
                        # instead of shadowing them with a higher-numbered CPU-only wheel from pypi.org.
                        torch_candidates.append([*base_torch_pkgs, "--index-url", "https://download.pytorch.org/whl/cu128"])
                        torch_candidates.append([*base_torch_pkgs, "--index-url", "https://download.pytorch.org/whl/cu126"])
                        torch_candidates.append(list(base_torch_pkgs))
                    elif sys.platform.startswith("linux") and not _is_windows():
                        # Avoid pulling >4 GB of Linux CUDA 13 libraries on CPU-only Linux machines.
                        torch_candidates.append([*base_torch_pkgs, "--index-url", "https://download.pytorch.org/whl/cpu"])
                        torch_candidates.append(list(base_torch_pkgs))
                    else:
                        torch_candidates.append(list(base_torch_pkgs))

                    emit(f"نصب زیرساخت PyTorch برای {self.id}…", progress=rp(0.20))
                    t_rc, t_out = 1, ""
                    for cand_args in torch_candidates:
                        t_rc, t_out = self._run_pip_resilient(
                            py, cand_args, upgrade=False, start_p=rp(0.20), end_p=rp(0.68), label_prefix=f"زیرساخت {self.id}"
                        )
                        if t_rc == 0 or self._cancel_install.is_set() or t_rc == 130:
                            break
                    if t_rc != 0:
                        raise self._error_cls(f"نصب PyTorch برای {self.id} ناموفق بود: {t_out[-1200:]}")
            elif (
                self.id == "surya"
                and sys.platform.startswith("linux")
                and not _is_windows()
                and not hw.get("hasNvidiaGpu")
                and _read_dist_version_in_venv(env_dir, "torch") is None
            ):
                # Pre-install lightweight CPU PyTorch on Linux CPU machines so surya-ocr's layout detector
                # does not pull 4.5 GB of Linux CUDA 13 packages from default PyPI.
                emit("نصب نسخهٔ سبک پردازنده (CPU) زیرساخت Surya…", progress=rp(0.16))
                self._run_pip_resilient(
                    py,
                    ["torch>=2.7.0,<3", "torchvision>=0.20.0,<1", "--index-url", "https://download.pytorch.org/whl/cpu"],
                    upgrade=False,
                    start_p=rp(0.16),
                    end_p=rp(0.46),
                    label_prefix="زیرساخت سبک Surya",
                )

            packages = list(self._spec["pip_packages_gpu"] if hw.get("hasNvidiaGpu") else self._spec["pip_packages_cpu"])
            extra_flags: list[str] = []
            # Neither Surya 2.5 (native llama-server) nor MinerU 4.x (ONNX DirectML + llama-cpp) uses PyTorch CUDA wheels.
            action_word = "به‌روزرسانی" if upgrade else "نصب"
            p_start = rp(0.69) if self._spec.get("needs_torch") else rp(0.16)
            p_end = rp(0.96)
            emit(f"{action_word} بسته‌های اختصاصی مدل {self.id} آغاز شد…", progress=p_start)
            if self.id == "paddleocr-vl-1-6" and hw.get("hasNvidiaGpu") and sys.platform.startswith("linux"):
                gpu_paddle_pkgs = [
                    "paddlepaddle-gpu>=3.2.0" if pkg.startswith("paddlepaddle>=") else pkg
                    for pkg in packages
                ]
                p_rc, p_out = self._run_pip_resilient(
                    py, [*extra_flags, *gpu_paddle_pkgs],
                    upgrade=upgrade,
                    start_p=p_start,
                    end_p=p_end,
                    label_prefix=f"{action_word} GPU {self.id}",
                )
                if p_rc != 0:
                    p_rc, p_out = self._run_pip_resilient(
                        py, [*extra_flags, *packages],
                        upgrade=upgrade,
                        start_p=p_start,
                        end_p=p_end,
                        label_prefix=f"{action_word} {self.id}",
                    )
            else:
                p_rc, p_out = self._run_pip_resilient(
                    py, [*extra_flags, *packages],
                    upgrade=upgrade,
                    start_p=p_start,
                    end_p=p_end,
                    label_prefix=f"{action_word} {self.id}",
                )
            fallback_pkgs = self._spec.get("pip_packages_fallback")
            if p_rc != 0 and fallback_pkgs:
                mid_p = round((p_start + p_end) / 2, 3)
                emit(f"تنظیم نسخهٔ سازگار بسته‌های {self.id} برای سیستم شما…", progress=mid_p)
                p_rc, p_out = self._run_pip_resilient(
                    py, [*extra_flags, *fallback_pkgs],
                    upgrade=upgrade,
                    start_p=mid_p,
                    end_p=p_end,
                    label_prefix=f"{action_word} سازگار {self.id}",
                )
            if p_rc != 0:
                details = (p_out or "pip failed")[-1500:].strip()
                raise self._error_cls(f"نصب بسته‌های مدل {self.id} ناموفق بود: {details}")

            emit(f"بسته‌های اجرایی مدل {self.id} آماده شد", progress=rp(0.98))
            self._ensure_llama_cpp_for_surya()
            (env_dir / ".runtime-ready").write_text(_now_iso(), encoding="utf-8")

    def _prepare_weights(self, language: str) -> str:
        if self._cancel_install.is_set():
            raise self._error_cls("عملیات آماده‌سازی مدل لغو شد.")
        worker_script = _worker_script_path()
        m_root = models_dir()
        def _tracked_weight_bytes() -> int:
            return (
                _dir_bytes_fast(m_root / "hf")
                + _dir_bytes_fast(m_root / "hf-repos")
                + _dir_bytes_fast(m_root / "paddlex")
                + _dir_bytes_fast(m_root / "surya")
                + _dir_bytes_fast(m_root / "mineru")
                + _dir_bytes_fast(m_root / "hezar")
                + _dir_bytes_fast(m_root / "torch")
            )

        base_weight_bytes = _tracked_weight_bytes()
        last_weight_bytes = base_weight_bytes
        wt_span_pair = getattr(self, "_active_wt_span", None) or (0.74, 0.96)
        w_lo, w_hi = float(wt_span_pair[0]), float(wt_span_pair[1])
        w_span = max(0.02, w_hi - w_lo)
        prof_wt_gb = float(compute_engine_download_estimate(self.id).get("weightsDownloadGb") or 0.5)
        expected_wt_bytes = max(15 * (1024 ** 2), prof_wt_gb * (1024 ** 3))
        best_wt_p = [round(w_lo, 3)]
        emit(f"دریافت و آماده‌سازی فایل‌های مدل {self.id}…", progress=best_wt_p[0])
        proc = subprocess.Popen(
            [
                str(self._env_python()),
                str(worker_script),
                "--engine", self.id,
                "--models-root", str(m_root),
                "--prepare",
                "--language", language,
            ],
            env=self._worker_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_SUBPROCESS_NO_WINDOW if os.name == "nt" else 0,
        )
        self._register_install_proc(proc)
        stderr_tail: list[str] = []
        stdout_chunks: list[str] = []
        last_activity_at = [time.monotonic()]
        stderr_byte_ratio = [0.0]

        def _emit_weight_progress(msg: str, ratio: float) -> None:
            clamped = max(0.0, min(0.98, ratio))
            cand_p = round(w_lo + w_span * clamped, 3)
            if cand_p > best_wt_p[0]:
                best_wt_p[0] = cand_p
            emit(msg, progress=best_wt_p[0])

        def _drain_stderr() -> None:
            if proc.stderr is None:
                return
            last_emit_at = 0.0
            try:
                for raw in proc.stderr:
                    last_activity_at[0] = time.monotonic()
                    cleaned = raw.replace("\r", "\n")
                    for part in cleaned.splitlines():
                        s = part.strip()
                        if not s:
                            continue
                        stderr_tail.append(s)
                        if len(stderr_tail) > 60:
                            stderr_tail.pop(0)
                        now_t = time.monotonic()
                        if now_t - last_emit_at >= 1.2:
                            cur_b = _tracked_weight_bytes()
                            dl_b = max(0.0, float(cur_b - base_weight_bytes))
                            frac_match = re.search(
                                r"([\d.]+\s*[kKmMgGtT]i?[bB]?)\s*/\s*([\d.]+\s*[kKmMgGtT]i?[bB]?)",
                                s,
                            )
                            if frac_match:
                                done_f = _parse_size_to_bytes(frac_match.group(1))
                                tot_f = _parse_size_to_bytes(frac_match.group(2))
                                if tot_f > 0:
                                    denom = max(expected_wt_bytes, tot_f)
                                    stderr_byte_ratio[0] = max(stderr_byte_ratio[0], min(0.97, max(dl_b, done_f) / denom))
                            disk_ratio = min(0.97, dl_b / max(1.0, expected_wt_bytes))
                            ratio = max(disk_ratio, stderr_byte_ratio[0])
                            pct_match = re.search(r"(\d{1,3})%", s)
                            if pct_match:
                                sub_pct = min(100, max(0, int(pct_match.group(1))))
                                if expected_wt_bytes <= 250 * (1024 ** 2):
                                    ratio = max(ratio, (sub_pct / 100.0) * 0.96)
                                _emit_weight_progress(
                                    f"دانلود فایل‌های مدل {self.id} ({sub_pct}٪ از فایل جاری)…",
                                    ratio,
                                )
                            else:
                                _emit_weight_progress(f"در حال آماده‌سازی وزن‌های مدل {self.id}…", ratio)
                            last_emit_at = now_t
            except Exception:
                pass

        def _drain_stdout() -> None:
            if proc.stdout is None:
                return
            try:
                for out_line in proc.stdout:
                    last_activity_at[0] = time.monotonic()
                    stdout_chunks.append(out_line)
            except Exception:
                pass

        err_thread = threading.Thread(target=_drain_stderr, daemon=True)
        out_thread = threading.Thread(target=_drain_stdout, daemon=True)
        err_thread.start()
        out_thread.start()
        started_w = time.monotonic()
        last_disk_emit_at = started_w
        try:
            while proc.poll() is None:
                if self._cancel_install.is_set():
                    self._kill_proc_tree(proc)
                    raise self._error_cls("عملیات آماده‌سازی مدل لغو شد.")
                if time.monotonic() - started_w > 3600:
                    self._kill_proc_tree(proc)
                    raise self._error_cls(f"مهلت آماده‌سازی فایل‌های مدل {self.id} به پایان رسید.")
                time.sleep(0.5)
                now_loop = time.monotonic()
                if now_loop - last_disk_emit_at >= 1.2:
                    cur_bytes = _tracked_weight_bytes()
                    if cur_bytes > last_weight_bytes:
                        last_weight_bytes = cur_bytes
                        last_activity_at[0] = now_loop
                        last_disk_emit_at = now_loop
                        dl_bytes = max(0.0, float(cur_bytes - base_weight_bytes))
                        dl_mb = dl_bytes / (1024 * 1024)
                        if dl_mb >= 1.0:
                            denom = max(expected_wt_bytes, dl_bytes * 1.04)
                            ratio = max(stderr_byte_ratio[0], min(0.97, dl_bytes / denom))
                            _emit_weight_progress(
                                f"دانلود وزن‌های مدل {self.id} — {dl_mb:.1f} مگابایت ذخیره شد…",
                                ratio,
                            )
        except Exception:
            self._kill_proc_tree(proc)
            raise
        finally:
            self._unregister_install_proc(proc)
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass
            err_thread.join(timeout=2.0)
            out_thread.join(timeout=2.0)

        stdout_text = "".join(stdout_chunks)
        last_json: dict[str, Any] = {}
        for line in reversed((stdout_text or "").splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    last_json = json.loads(line)
                    break
                except Exception:
                    continue
        if proc.returncode != 0 or not last_json.get("ok"):
            err = last_json.get("error") or ("\n".join(stderr_tail) or stdout_text or "weight download failed")[-1200:]
            raise self._error_cls(f"آماده‌سازی فایل‌های مدل {self.id} ناموفق بود: {err}")
        state = self._state_dir()
        state.mkdir(parents=True, exist_ok=True)
        (state / ".ready-all").write_text(_now_iso(), encoding="utf-8")
        (state / f".ready-{language}").write_text(_now_iso(), encoding="utf-8")
        emit(f"فایل‌های مدل {self.id} ذخیره و تایید شد", progress=round(w_hi, 3))
        return str(last_json.get("modelRevision") or "ready")

    def download(self, language: str = "eng") -> None:
        self._cancel_install.clear()
        self.close()
        try:
            rt_already = self.runtime_installed
            wt_already = self.model_ready
            dl_est = compute_engine_download_estimate(
                self.id,
                runtime_installed=rt_already,
                model_ready=wt_already,
            )
            dl_label = format_download_size_fa(dl_est["totalDownloadGb"])
            rt_gb = float(dl_est["runtimeDownloadGb"])
            wt_gb = float(dl_est["weightsDownloadGb"])
            if not rt_already and not wt_already:
                tot_gb = max(0.05, rt_gb + wt_gb)
                rt_share = max(0.14, min(0.84, rt_gb / tot_gb))
                rt_end = round(0.04 + 0.92 * rt_share, 3)
                self._active_rt_span = (0.04, rt_end)
                self._active_wt_span = (rt_end, 0.96)
            elif not rt_already:
                self._active_rt_span = (0.04, 0.92)
                self._active_wt_span = (0.92, 0.96)
            else:
                self._active_rt_span = (0.04, 0.08)
                self._active_wt_span = (0.08, 0.96)

            emit(f"شروع آماده‌سازی خودکار مدل {self.id} (کل حجم دانلود: {dl_label})…", progress=0.04)
            if not rt_already:
                self._ensure_isolated_venv(upgrade=False)
            else:
                emit(f"محیط اجرایی {self.id} از قبل آماده است؛ بررسی ابزارها و فایل‌های مدل…", progress=0.08)
                self._ensure_llama_cpp_for_surya()
            revision = self._prepare_weights(language)
            hf_repo = self._spec.get("hf_repo")
            if revision == "ready" and hf_repo:
                remote_rev = fetch_hf_repo_revision(hf_repo) or fetch_remote_repo_revision(self._spec.get("github_repo"))
                if remote_rev:
                    revision = remote_rev
            cleanup_superseded_engine_files(self.id)
            ver = self.installed_version or "installed"
            acknowledge_engine_update(
                self.id,
                installed_version=ver,
                model_revision=revision,
                ready_languages=self.ready_languages,
            )
            emit(f"مدل {self.id} آماده و قابل استفاده است", "success", progress=1.0)
        finally:
            self._active_rt_span = None
            self._active_wt_span = None
            self.close()
            trim_process_memory()

    def update(self, language: str = "eng") -> None:
        self._cancel_install.clear()
        self.close()
        try:
            emit(f"شروع به‌روزرسانی خودکار مدل {self.id}…", progress=0.06)
            cached = (read_update_cache().get("engines") or {}).get(self.id) or {}
            manifest_entry = read_manifest().get(self.id) or {}
            cur_ver = self.installed_version
            latest_ver = cached.get("latestVersion")
            cur_rev = str(manifest_entry.get("modelRevision") or "")
            latest_rev = str(cached.get("latestRevision") or "")

            need_pkg_upgrade = (
                not self.runtime_installed
                or not cur_ver
                or not latest_ver
                or is_newer_version(cur_ver, latest_ver)
            )
            if need_pkg_upgrade:
                self._ensure_isolated_venv(upgrade=True)
            else:
                emit(f"بستهٔ اجرایی {self.id} ({cur_ver}) در آخرین نسخه است…", progress=0.72)
                self._ensure_llama_cpp_for_surya()

            need_weights_refresh = (
                not self.model_ready
                or need_pkg_upgrade
                or (bool(latest_rev) and cur_rev != latest_rev)
            )
            if need_weights_refresh:
                revision = self._prepare_weights(language)
            else:
                revision = cur_rev or "ready"

            freed_bytes = cleanup_superseded_engine_files(self.id)
            if freed_bytes >= 1024 * 1024:
                emit(
                    f"نسخه‌ها و فایل‌های قدیمی {self.id} پاک‌سازی شد ({freed_bytes / (1024 * 1024):.1f} مگابایت آزاد شد)",
                    progress=0.98,
                )

            ver = self.installed_version or "installed"
            hf_repo = self._spec.get("hf_repo")
            final_rev = revision
            if hf_repo and (not final_rev or final_rev == "ready"):
                final_rev = fetch_hf_repo_revision(hf_repo) or fetch_remote_repo_revision(self._spec.get("github_repo")) or "ready"
            acknowledge_engine_update(
                self.id,
                installed_version=ver,
                model_revision=final_rev,
                ready_languages=self.ready_languages,
            )
            emit(f"مدل {self.id} با موفقیت به نسخهٔ {ver} به‌روزرسانی شد", "success", progress=1.0)
        finally:
            self.close()
            trim_process_memory()

    def _ensure_worker(self) -> subprocess.Popen[str]:
        if self._worker_proc is not None and self._worker_proc.poll() is None:
            return self._worker_proc
        if self._worker_proc is not None:
            for stale_stream in (self._worker_proc.stdin, self._worker_proc.stdout, self._worker_proc.stderr):
                if stale_stream is not None:
                    try:
                        stale_stream.close()
                    except Exception:
                        pass
            self._worker_proc = None
        self._worker_stderr_tail.clear()
        if self.id == "surya":
            _stop_lingering_surya_server()
        if self._spec.get("needs_llama_cpp_cpu"):
            self._ensure_llama_cpp_for_surya()
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
            errors="replace",
            bufsize=1,
            env=self._worker_env(),
            creationflags=_SUBPROCESS_NO_WINDOW if os.name == "nt" else 0,
            start_new_session=(os.name != "nt"),
        )
        with self._proc_ref_lock:
            self._worker_proc = proc
        stderr_tail = self._worker_stderr_tail

        def _drain_worker_stderr() -> None:
            stream = proc.stderr
            if stream is None:
                return
            try:
                for raw in stream:
                    for part in raw.replace("\r", "\n").splitlines():
                        cleaned = part.strip()
                        if cleaned:
                            stderr_tail.append(cleaned)
            except Exception:
                pass

        err_thread = threading.Thread(target=_drain_worker_stderr, daemon=True)
        err_thread.start()
        try:
            banner = proc.stdout.readline().strip() if proc.stdout else ""
        except Exception:
            banner = ""
        if self._cancel_ocr.is_set() or is_job_cancelled():
            with self._proc_ref_lock:
                if self._worker_proc is proc:
                    self._worker_proc = None
            _kill_process_tree(proc)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None:
                    with contextlib.suppress(Exception):
                        stream.close()
            if self.id == "surya":
                _stop_lingering_surya_server()
            raise JobCancelledError("عملیات OCR به درخواست کاربر لغو شد.")
        if not banner:
            with self._proc_ref_lock:
                if self._worker_proc is proc:
                    self._worker_proc = None
            _kill_process_tree(proc)
            err_thread.join(timeout=1.0)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass
            err_tail = "\n".join(stderr_tail)[-800:]
            raise self._error_cls(f"راه‌اندازی پردازشگر مدل {self.id} ناموفق بود: {err_tail}")
        return proc

    def recognize(self, image: Image.Image, language: str, *, page_mode: str = "auto") -> list[Any]:
        check_cancelled("عملیات OCR به درخواست کاربر لغو شد.")
        self._cancel_ocr.clear()
        if not self.runtime_installed or not self.model_ready:
            raise self._error_cls(
                f"مدل {self.id} آماده نیست. در پنجرهٔ «مدیریت مدل‌های OCR» "
                "روی «آماده‌سازی / دانلود خودکار» این مدل بزنید (برای دانلود اینترنت لازم است)."
            )
        regions = detect_comic_text_regions(image, page_mode=page_mode) if self._spec.get("needs_regions") else None
        check_cancelled("عملیات OCR به درخواست کاربر لغو شد.")
        with tempfile.NamedTemporaryFile(prefix=f"comic-{self.id}-", suffix=".png", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            rgb_img = image if image.mode == "RGB" else image.convert("RGB")
            try:
                rgb_img.save(tmp_path, "PNG", compress_level=1)
            finally:
                if rgb_img is not image:
                    rgb_img.close()
            self._cancel_idle_timer()
            with self._worker_lock:
                if self._cancel_ocr.is_set() or is_job_cancelled():
                    raise JobCancelledError("عملیات OCR به درخواست کاربر لغو شد.")
                proc = self._ensure_worker()
                assert proc.stdin is not None and proc.stdout is not None
                req = {"imagePath": str(tmp_path), "language": language, "regions": regions, "pageMode": page_mode}
                try:
                    proc.stdin.write(json.dumps(req) + "\n")
                    proc.stdin.flush()
                    raw_resp = proc.stdout.readline().strip()
                except Exception:
                    raw_resp = ""
                if self._cancel_ocr.is_set() or is_job_cancelled():
                    with self._proc_ref_lock:
                        if self._worker_proc is proc:
                            self._worker_proc = None
                    _kill_process_tree(proc)
                    for stream in (proc.stdin, proc.stdout, proc.stderr):
                        if stream is not None:
                            with contextlib.suppress(Exception):
                                stream.close()
                    if self.id == "surya":
                        _stop_lingering_surya_server()
                    raise JobCancelledError("عملیات OCR به درخواست کاربر لغو شد.")
                if not raw_resp:
                    _kill_process_tree(proc)
                    for stream in (proc.stdin, proc.stdout, proc.stderr):
                        if stream is not None:
                            try:
                                stream.close()
                            except Exception:
                                pass
                    with self._proc_ref_lock:
                        if self._worker_proc is proc:
                            self._worker_proc = None
                    if self.id == "surya":
                        _stop_lingering_surya_server()
                    err_hint = ("\n".join(self._worker_stderr_tail))[-600:]
                    suffix = f": {err_hint}" if err_hint else ""
                    raise self._error_cls(f"پردازشگر مدل {self.id} به شکل غیرمنتظره‌ای بسته شد.{suffix}")
                payload = json.loads(raw_resp)
                if not payload.get("ok"):
                    raise self._error_cls(f"OCR failed ({self.id}): {payload.get('error')}")
                persian_norm = None
                if language == "fas":
                    with contextlib.suppress(Exception):
                        from .ocr import normalize_persian_ocr_text as _pnorm
                        persian_norm = _pnorm
                out_lines: list[Any] = []
                for entry in payload.get("lines") or []:
                    raw_txt = str(entry.get("text", "")).strip("\r\n")
                    if persian_norm is not None:
                        raw_txt = persian_norm(raw_txt)
                    if not raw_txt.strip() or not entry.get("polygon"):
                        continue
                    poly = [[float(pt[0]), float(pt[1])] for pt in entry["polygon"]]
                    conf = float(entry.get("confidence", 0.9))
                    extra = {
                        k: entry[k]
                        for k in ("bold", "italic", "role")
                        if k in entry and entry[k] is not None
                    }
                    if extra:
                        try:
                            out_lines.append(self._line_factory(raw_txt, conf, poly, **extra))
                            continue
                        except TypeError:
                            pass
                    out_lines.append(self._line_factory(raw_txt, conf, poly))
                return out_lines
        finally:
            tmp_path.unlink(missing_ok=True)
            if self.is_loaded_in_ram:
                self._arm_idle_timer()


def _update_cache_path() -> Path:
    return models_dir() / "update_cache.json"


def read_update_cache() -> dict[str, Any]:
    global _UPDATE_MEM_CACHE
    path = _update_cache_path()
    try:
        st = path.stat()
    except OSError:
        return {}
    path_key = str(path)
    cached = _UPDATE_MEM_CACHE
    if cached is not None and cached[0] == path_key and cached[1] == st.st_mtime_ns and cached[2] == st.st_size:
        return copy.deepcopy(cached[3])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _UPDATE_MEM_CACHE = (path_key, st.st_mtime_ns, st.st_size, copy.deepcopy(data))
            return data
        return {}
    except Exception:
        return {}


def write_update_cache(payload: dict[str, Any]) -> None:
    global _UPDATE_MEM_CACHE
    with _UPDATE_CACHE_LOCK:
        path = _update_cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
        with contextlib.suppress(OSError):
            st = path.stat()
            _UPDATE_MEM_CACHE = (str(path), st.st_mtime_ns, st.st_size, copy.deepcopy(payload))


def _shared_package_siblings(engine_id: str) -> list[str]:
    meta = engine_meta(engine_id)
    pypi_pkg = meta.get("pypi_pkg")
    if not pypi_pkg or engine_id in ISOLATED_ENGINE_SPECS:
        return [engine_id]
    return [eid for eid, m in BUILTIN_ENGINE_META.items() if m.get("pypi_pkg") == pypi_pkg]


def clear_cached_engine_update(engine_id: str, new_version: str | None, new_revision: str | None = None) -> None:
    cache = read_update_cache()
    entries = cache.get("engines")
    if not isinstance(entries, dict):
        return
    changed = False
    for target_id in _shared_package_siblings(engine_id):
        if target_id in entries:
            entry = dict(entries[target_id] or {})
            if new_version:
                entry["latestVersion"] = new_version
            if new_revision:
                entry["latestRevision"] = new_revision
            entries[target_id] = entry
            changed = True
    if changed:
        write_update_cache(cache)


def remove_cached_engine_update(engine_id: str) -> None:
    cache = read_update_cache()
    entries = cache.get("engines")
    if not isinstance(entries, dict) or engine_id not in entries:
        return
    entries.pop(engine_id, None)
    write_update_cache(cache)


_ISOLATED_DEDICATED_DIRS: dict[str, str] = {
    "paddleocr-vl-1-6": "paddlex",
    "surya": "surya",
    "mineru-2-5-pro": "mineru",
    "hezar-ocr": "hezar",
}

_ISOLATED_HF_REPOS: dict[str, tuple[str, ...]] = {
    "paddleocr-vl-1-6": ("PaddlePaddle/PaddleOCR-VL", "PaddlePaddle/PaddleOCR-VL-1.5"),
    "surya": ("datalab-to/surya-ocr-2.5", "datalab-to/surya-ocr-2.5-gguf", "datalab-to/surya_layout2"),
    "mineru-2-5-pro": ("opendatalab/PDF-Extract-Kit-1.0", "opendatalab/MinerU2.5-2509-1.2B"),
    "got-ocr-2": ("stepfun-ai/GOT-OCR-2.0-hf",),
    "glm-ocr": ("zai-org/GLM-OCR",),
    "dots-ocr": ("rednote-hilab/dots.mocr", "rednote-hilab/dots.ocr"),
    "deepseek-ocr-2": ("deepseek-ai/DeepSeek-OCR-2",),
    "olmocr": ("allenai/olmOCR-2-7B-1025", "allenai/olmOCR-7B-0225-preview"),
    "hunyuan-ocr": ("tencent/HunyuanOCR",),
    "hezar-ocr": ("hezarai/crnn-base-fa-v2", "hezarai/CRAFT"),
}


def _isolated_engine_owned_paths(engine_id: str, root: Path | None = None) -> list[Path]:
    base = root if root is not None else models_dir()
    paths: list[Path] = [
        base / "envs" / engine_id,
        base / "isolated" / engine_id,
    ]
    dedicated = _ISOLATED_DEDICATED_DIRS.get(engine_id)
    if dedicated:
        paths.append(base / dedicated)
    spec = ISOLATED_ENGINE_SPECS.get(engine_id) or {}
    repos = list(_ISOLATED_HF_REPOS.get(engine_id) or ())
    spec_repo = spec.get("hf_repo")
    if spec_repo and spec_repo not in repos:
        repos.append(str(spec_repo))
    for repo in repos:
        raw_name = repo.replace("/", "__")
        safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", raw_name)
        underscore_name = re.sub(r"[^A-Za-z0-9_]+", "_", raw_name)
        for cand_name in dict.fromkeys((safe_name, underscore_name, raw_name)):
            paths.append(base / "hf-repos" / cand_name)
        paths.append(base / "hf" / "hub" / f"models--{repo.replace('/', '--')}")
    return paths


def _dir_has_any_entry(target: Path) -> bool:
    try:
        return target.is_dir() and next(target.iterdir(), None) is not None
    except OSError:
        return False


def engine_has_uninstallable_files(engine_id: str, engine: Any = None) -> bool:
    """Fast O(1) check returning True when an engine has user-downloaded runtime/weights on disk."""
    if engine_id == "rapidocr-v6":
        return False
    root = models_dir()
    if engine_id in ISOLATED_ENGINE_SPECS:
        if engine is not None and (
            bool(getattr(engine, "runtime_installed", False))
            or bool(getattr(engine, "model_ready", False))
        ):
            return True
        return any(
            _dir_has_any_entry(cand) if cand.is_dir() else cand.exists()
            for cand in _isolated_engine_owned_paths(engine_id, root)
        )
    if engine_id == "rapidocr-v5":
        if bundled_models_dir() is not None:
            return _dir_has_any_entry(root / "rapidocr")
        if engine is not None and bool(getattr(engine, "model_ready", False)):
            return True
        return _dir_has_any_entry(root / "rapidocr")
    if engine_id == "easyocr":
        if _dir_has_any_entry(root / "easyocr") or _dir_has_any_entry(root / "site-packages"):
            return True
        if engine is not None and bool(getattr(engine, "model_ready", False)):
            return True
        try:
            import importlib.util as _ilu
            spec = _ilu.find_spec("easyocr")
            return bool(spec is not None and getattr(spec, "origin", None) and Path(spec.origin).is_file())
        except Exception:
            return False
    if engine_id == "tesseract":
        if _dir_has_any_entry(root / "tesseract-bin"):
            return True
        tess_dir = root / "tesseract"
        try:
            if tess_dir.is_dir() and any(child.suffix == ".traineddata" for child in tess_dir.iterdir()):
                return True
        except OSError:
            pass
        return False
    return False


def _stop_lingering_surya_server() -> None:
    cache_roots: list[Path] = [
        models_dir() / "cache",
        Path(os.path.expanduser("~/.cache")),
    ]
    for env_key in ("XDG_CACHE_HOME", "USERPROFILE"):
        raw = (os.environ.get(env_key) or "").strip()
        if raw:
            cache_roots.append(Path(raw) / ".cache" if env_key == "USERPROFILE" else Path(raw))
    seen: set[str] = set()
    killed_pids: set[int] = set()
    for root in cache_roots:
        state_json = root / "datalab" / "surya" / "llamacpp_server.json"
        norm_key = os.path.normcase(str(state_json))
        if norm_key in seen or not state_json.is_file():
            continue
        seen.add(norm_key)
        server_pid: int | None = None
        with contextlib.suppress(Exception):
            meta = json.loads(state_json.read_text(encoding="utf-8"))
            if isinstance(meta, dict) and meta.get("pid"):
                server_pid = int(meta["pid"])
        with contextlib.suppress(OSError):
            state_json.unlink()
        if server_pid and server_pid > 0 and server_pid != os.getpid() and server_pid not in killed_pids:
            killed_pids.add(server_pid)
            with contextlib.suppress(Exception):
                if os.name == "nt":
                    _run_Subprocess(["taskkill", "/F", "/T", "/PID", str(server_pid)], capture_output=True, timeout=4, check=False)
                else:
                    import signal as _sig
                    os.kill(server_pid, _sig.SIGTERM)


def uninstall_isolated_engine_files(engine_id: str) -> int:
    """Completely remove an isolated engine's venv, state markers, and downloaded model weights."""
    if engine_id == "surya":
        _stop_lingering_surya_server()
    root = models_dir()
    freed = 0
    seen: set[str] = set()
    for path in _isolated_engine_owned_paths(engine_id, root):
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        freed += _remove_path_safely(path)
    # Also remove wildcard HF org folders for multi-repo engines (surya / mineru / hezar)
    org_prefixes: dict[str, tuple[str, ...]] = {
        "surya": ("datalab-to", "datalab_to"),
        "mineru-2-5-pro": ("opendatalab",),
        "hezar-ocr": ("hezarai",),
    }
    for prefix in org_prefixes.get(engine_id, ()):
        hf_repos_dir = root / "hf-repos"
        if hf_repos_dir.is_dir():
            for child in list(hf_repos_dir.iterdir()):
                if child.name.startswith(f"{prefix}__"):
                    freed += _remove_path_safely(child)
        hf_hub_dir = root / "hf" / "hub"
        if hf_hub_dir.is_dir():
            for child in list(hf_hub_dir.iterdir()):
                if child.name.startswith(f"models--{prefix}--"):
                    freed += _remove_path_safely(child)
    remove_manifest_entry(engine_id)
    remove_cached_engine_update(engine_id)
    invalidate_engine_runtime_caches()
    return freed


def acknowledge_engine_update(
    engine_id: str,
    installed_version: str | None,
    model_revision: str | None = None,
    ready_languages: list[str] | None = None,
    installed_tag: str | None = None,
) -> None:
    """Persist installed state AND acknowledge the current upstream version/revision so
    environment-ceiling upgrades (e.g. Python/OS wheel constraints or system binaries)
    never re-trigger an infinite 'update available' loop for the same upstream release."""
    cache = read_update_cache()
    entries = cache.get("engines") if isinstance(cache.get("engines"), dict) else {}
    siblings = _shared_package_siblings(engine_id)

    cached_latest_ver: str | None = None
    cached_latest_rev: str | None = None
    for sid in siblings:
        item = entries.get(sid) or {}
        if not cached_latest_ver and item.get("latestVersion"):
            cached_latest_ver = str(item["latestVersion"])
        if not cached_latest_rev and item.get("latestRevision"):
            cached_latest_rev = str(item["latestRevision"])

    ack_ver = installed_version
    if cached_latest_ver and (not installed_version or is_newer_version(installed_version, cached_latest_ver)):
        ack_ver = cached_latest_ver

    clean_rev = model_revision if (model_revision and "__" not in model_revision) else None
    ack_rev = cached_latest_rev or clean_rev

    for sid in siblings:
        extra: dict[str, Any] = {
            "installedVersion": installed_version,
            "acknowledgedVersion": ack_ver,
        }
        if sid == engine_id:
            if clean_rev:
                extra["modelRevision"] = clean_rev
            if ack_rev:
                extra["acknowledgedRevision"] = ack_rev
            if ready_languages is not None:
                extra["readyLanguages"] = ready_languages
            if installed_tag:
                extra["installedTag"] = installed_tag
        update_manifest_entry(sid, **extra)

    clear_cached_engine_update(engine_id, installed_version or ack_ver, clean_rev or ack_rev)


def fetch_pypi_latest_version(pkg_name: str, timeout: float = 6.0) -> str | None:
    data = _fetch_json(f"https://pypi.org/pypi/{pkg_name}/json", timeout=timeout)
    ver = str((data.get("info") or {}).get("version") or "").strip()
    return ver or None


def _engine_pypi_specifier(engine_id: str, pypi_pkg: str | None) -> str | None:
    if not pypi_pkg:
        return None
    spec = ISOLATED_ENGINE_SPECS.get(engine_id)
    if not spec:
        return None
    norm_target = re.sub(r"[-_.]+", "_", pypi_pkg.lower())
    for raw_req in spec.get("pip_packages_cpu") or []:
        m = re.match(r"^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$", str(raw_req).strip())
        if not m:
            continue
        pkg_part, spec_part = m.group(1), m.group(2).strip()
        if re.sub(r"[-_.]+", "_", pkg_part.lower()) == norm_target and spec_part:
            return spec_part
    return None


def _satisfies_specifier(version_str: str | None, spec_str: str | None) -> bool:
    if not version_str or not spec_str:
        return True
    try:
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version
        return Version(str(version_str).strip().lstrip("vV")) in SpecifierSet(spec_str)
    except Exception:
        return True


def _resolve_compatible_pypi_version(
    engine_id: str,
    pypi_pkg: str,
    raw_latest: str | None,
    installed_ver: str | None = None,
    timeout: float = 6.0,
) -> str | None:
    if not raw_latest:
        return None
    spec_str = _engine_pypi_specifier(engine_id, pypi_pkg)
    if not spec_str or _satisfies_specifier(raw_latest, spec_str):
        return raw_latest
    try:
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version

        spec_set = SpecifierSet(spec_str)
        data = _fetch_json(f"https://pypi.org/pypi/{pypi_pkg}/json", timeout=timeout)
        releases = data.get("releases") or {}
        compatible: list[Version] = []
        raw_by_ver: dict[Version, str] = {}
        for ver_key, files in releases.items():
            if not files or not isinstance(files, list):
                continue
            if all(bool(f.get("yanked")) for f in files if isinstance(f, dict)):
                continue
            try:
                parsed = Version(str(ver_key))
            except Exception:
                continue
            if parsed.is_prerelease or parsed.is_devrelease:
                continue
            if parsed in spec_set:
                compatible.append(parsed)
                raw_by_ver[parsed] = str(ver_key)
        if compatible:
            best = max(compatible)
            return raw_by_ver[best]
    except Exception:
        pass
    return installed_ver


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
    return None


def fetch_hf_repo_revision(hf_repo: str | None, timeout: float = 6.0) -> str | None:
    if not hf_repo:
        return None
    endpoints = ("https://huggingface.co", "https://hf-mirror.com")
    for base in endpoints:
        try:
            info = _fetch_json(f"{base}/api/models/{hf_repo}", timeout=timeout)
            sha = str((info or {}).get("sha") or "").strip()
            if len(sha) >= 12:
                return f"hf:{sha[:12]}"
        except Exception:
            continue
    return None


def fetch_tessdata_revision(languages: list[str], timeout: float = 6.0) -> str | None:
    lang = "fas" if "fas" in (languages or []) and len(languages) == 1 else (languages[0] if languages else "eng")
    repo = "tesseract-ocr/tessdata_best" if lang == "fas" else "tesseract-ocr/tessdata_fast"
    try:
        commits = _fetch_json(
            f"https://api.github.com/repos/{repo}/commits?path={lang}.traineddata&per_page=1",
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
    entry = read_manifest().get(engine_id) or {}
    if engine_id in {"rapidocr-v6", "rapidocr-v5"}:
        disk_ver = _read_dist_version_in_venv(Path(sys.prefix), "rapidocr")
        if disk_ver:
            return disk_ver
        try:
            return importlib.metadata.version("rapidocr")
        except Exception:
            pass
    elif engine_id == "easyocr":
        disk_ver = _read_dist_version_in_venv(Path(sys.prefix), "easyocr")
        if disk_ver:
            return disk_ver
        try:
            return importlib.metadata.version("easyocr")
        except Exception:
            pass
    elif engine_id == "tesseract":
        from .ocr import _tesseract_executable
        exe = _tesseract_executable()
        ver = detect_tesseract_version(exe)
        installed_tag = str(entry.get("installedTag") or "").strip().lstrip("vV")
        if ver and installed_tag and portable_tesseract_executable() == exe:
            # UB-Mannheim binaries often print 3-part '5.4.0' while the release tag is '5.4.0.20240606'.
            if installed_tag == ver or installed_tag.startswith(f"{ver}."):
                return installed_tag
        if ver:
            return ver
    return entry.get("installedVersion")


def _is_valid_comparable_revision(rev: Any) -> bool:
    if not rev or not isinstance(rev, str):
        return False
    cleaned = rev.strip()
    if not cleaned or cleaned == "ready" or "__" in cleaned or cleaned.startswith("sha256:"):
        return False
    return True


def _revisions_same_namespace(rev_a: Any, rev_b: Any) -> bool:
    if not (_is_valid_comparable_revision(rev_a) and _is_valid_comparable_revision(rev_b)):
        return False
    a = str(rev_a).strip()
    b = str(rev_b).strip()
    prefix_a = a.split(":", 1)[0] if ":" in a else ""
    prefix_b = b.split(":", 1)[0] if ":" in b else ""
    return prefix_a == prefix_b


def compute_engine_update_fields(
    engine_id: str,
    engine_name: str,
    engine: Any,
    installed_version: str | None,
    manifest_entry: dict[str, Any] | None,
    cached_remote: dict[str, Any] | None,
) -> dict[str, Any]:
    remote = cached_remote or {}
    manifest = manifest_entry or {}
    latest_version = remote.get("latestVersion")
    latest_revision = remote.get("latestRevision")
    meta = engine_meta(engine_id)
    spec_str = _engine_pypi_specifier(engine_id, meta.get("pypi_pkg"))
    if latest_version and spec_str and not _satisfies_specifier(str(latest_version), spec_str):
        latest_version = installed_version
    # For shared-runtime engines like rapidocr-v5, only notify if its own model was actually prepared.
    if engine_id == "rapidocr-v5":
        installed_ready = bool(engine.runtime_installed and engine.model_ready)
    else:
        installed_ready = bool(engine.runtime_installed and (engine.model_ready or installed_version))
    update_available = False
    summary = ""

    if installed_ready:
        ack_ver = manifest.get("acknowledgedVersion")
        manifest_inst_ver = manifest.get("installedVersion")
        # Only honor acknowledgedVersion when the currently installed binary/package hasn't been downgraded.
        baseline_ver = installed_version
        if ack_ver and installed_version and (not manifest_inst_ver or manifest_inst_ver == installed_version):
            if is_newer_version(installed_version, ack_ver):
                baseline_ver = ack_ver

        # UB-Mannheim Tesseract binary often prints '5.4.0' for release tag '5.4.0.20240606'.
        same_tesseract_base = (
            engine_id == "tesseract"
            and bool(baseline_ver)
            and bool(latest_version)
            and str(latest_version).lstrip("vV").startswith(f"{str(baseline_ver).lstrip('vV')}.")
            and len(_version_tuple(baseline_ver)) <= 3
        )

        if baseline_ver and latest_version and not same_tesseract_base and is_newer_version(baseline_ver, latest_version):
            update_available = True
            summary = f"نسخهٔ جدید {latest_version} برای مدل «{engine_name}» آمادهٔ نصب است (نسخهٔ فعلی: {installed_version})"
        else:
            local_rev = manifest.get("modelRevision")
            ack_rev = manifest.get("acknowledgedRevision")
            if (
                _revisions_same_namespace(local_rev, latest_revision)
                and local_rev != latest_revision
                and ack_rev != latest_revision
            ):
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
        manifest_snapshot = read_manifest()

        def _probe_one(eid: str) -> tuple[str, dict[str, Any], bool]:
            meta = engine_meta(eid)
            engine = registry.get(eid)
            inst_ver = (
                engine.installed_version
                if hasattr(engine, "installed_version")
                else detect_builtin_installed_version(eid, engine)
            )
            latest_ver: str | None = None
            latest_rev: str | None = None
            ok = False
            pypi_pkg = meta.get("pypi_pkg")
            if pypi_pkg:
                try:
                    raw_ver = fetch_pypi_latest_version(pypi_pkg)
                    if raw_ver:
                        latest_ver = _resolve_compatible_pypi_version(eid, pypi_pkg, raw_ver, installed_ver=inst_ver)
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
                hf_repo = ISOLATED_ENGINE_SPECS[eid].get("hf_repo")
                stored_rev = str((manifest_snapshot.get(eid) or {}).get("modelRevision") or "")
                if stored_rev.startswith("hf:"):
                    rev = fetch_hf_repo_revision(hf_repo)
                else:
                    rev = fetch_remote_repo_revision(meta.get("github_repo")) or fetch_hf_repo_revision(hf_repo)
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
