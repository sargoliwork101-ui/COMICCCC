from __future__ import annotations

import atexit
from collections import deque
from collections.abc import Iterator, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
import contextvars
import ctypes
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable, TypeVar
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
    """Return available logical CPU cores (honoring COMIC_STUDIO_FAKE_HARDWARE_JSON when set)."""
    override = os.environ.get("COMIC_STUDIO_FAKE_HARDWARE_JSON")
    if override:
        try:
            parsed = json.loads(override)
            if isinstance(parsed, dict) and parsed.get("cpuCores") is not None:
                return max(1, int(parsed["cpuCores"]))
        except Exception:
            pass
    return max(1, int(os.cpu_count() or 1))


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
    cores = max(1, int(hw.get("cpuCores") or cores))
    ram_gb = float(hw.get("ramGb") or 0.0)
    if ram_gb > 0:
        usable_mb = max(128.0, (ram_gb - 1.2) * 1024.0)
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
            yield idx, item, worker_fn(idx, item)
        return

    inflight: deque[tuple[int, _TItem, Future[_TResult]]] = deque()
    next_idx = 0
    with ThreadPoolExecutor(max_workers=effective_workers, thread_name_prefix="comic-worker") as pool:
        try:
            while next_idx < total and len(inflight) < effective_workers:
                item = items[next_idx]
                ctx = contextvars.copy_context()
                fut = pool.submit(ctx.run, worker_fn, next_idx, item)
                inflight.append((next_idx, item, fut))
                next_idx += 1

            while inflight:
                done_idx, done_item, done_fut = inflight.popleft()
                result = done_fut.result()
                if next_idx < total:
                    item = items[next_idx]
                    ctx = contextvars.copy_context()
                    fut = pool.submit(ctx.run, worker_fn, next_idx, item)
                    inflight.append((next_idx, item, fut))
                    next_idx += 1
                yield done_idx, done_item, result
        finally:
            while inflight:
                _, _, pending_fut = inflight.popleft()
                pending_fut.cancel()


def configure_native_runtime() -> dict[str, Any]:
    """Configure OpenCV, OpenMP/BLAS, and transparent OpenCL GPU acceleration once per process."""
    global _RUNTIME_CONFIGURED
    cores = cpu_core_count()
    for env_key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(env_key, str(cores))
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    cv_threads = cores
    opencl_active = False
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
    """Delete a file or directory tree best-effort and return approximate bytes freed."""
    if not target.exists() and not target.is_symlink():
        return 0
    freed = 0
    try:
        if target.is_symlink() or target.is_file():
            try:
                freed = target.stat().st_size
            except OSError:
                freed = 0
            target.unlink(missing_ok=True)
            return freed
        if target.is_dir():
            for child in target.rglob("*"):
                if child.is_file() and not child.is_symlink():
                    try:
                        freed += child.stat().st_size
                    except OSError:
                        pass
            shutil.rmtree(target, ignore_errors=True)
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

    global _HW_CACHE
    now = time.monotonic()
    with _HW_CACHE_LOCK:
        if not force_refresh and _HW_CACHE is not None and (now - _HW_CACHE[0]) < 60.0:
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


def _is_windows() -> bool:
    return os.name == "nt"


def portable_tesseract_executable() -> str | None:
    base = models_dir() / "tesseract-bin"
    if not base.is_dir():
        return None
    candidates = (
        [base / "tesseract.exe", base / "Tesseract-OCR" / "tesseract.exe", base / "bin" / "tesseract.exe"]
        if _is_windows()
        else [base / "bin" / "tesseract", base / "tesseract"]
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    if _is_windows():
        for found in base.rglob("tesseract.exe"):
            if found.is_file():
                return str(found)
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


def install_tesseract_runtime(error_cls: type[Exception]) -> str:
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

    @property
    def is_loaded_in_ram(self) -> bool:
        return self._worker_proc is not None and self._worker_proc.poll() is None

    @property
    def worker_pid(self) -> int | None:
        proc = self._worker_proc
        if proc is not None and proc.poll() is None:
            return proc.pid
        return None

    def unload(self) -> None:
        self.close()

    def close(self) -> None:
        with self._worker_lock:
            proc = self._worker_proc
            self._worker_proc = None
            if proc is not None and proc.poll() is None:
                pid = proc.pid
                try:
                    if proc.stdin:
                        proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                        proc.stdin.flush()
                    proc.wait(timeout=2)
                except Exception:
                    pass
                if proc.poll() is None:
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
                    try:
                        proc.kill()
                        proc.wait(timeout=2)
                    except Exception:
                        pass
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except Exception:
                            pass

    def _worker_env(self) -> dict[str, str]:
        env = dict(os.environ)
        llama_bin = self._env_dir() / "llama-bin"
        scripts_dir = self._env_python().parent
        extra_paths = [str(scripts_dir)]
        if llama_bin.is_dir():
            extra_paths.insert(0, str(llama_bin))
        env["PATH"] = os.pathsep.join([*extra_paths, env.get("PATH", "")])
        env["PYTHONIOENCODING"] = "utf-8"
        cores_str = str(cpu_core_count())
        for thread_var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
            env.setdefault(thread_var, cores_str)
        env.setdefault("TOKENIZERS_PARALLELISM", "true")
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        env.setdefault("FLAGS_use_mkldnn", "1")
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
        emit("دریافت خودکار موتور کمکی llama-server برای اجرای Surya روی پردازنده (CPU)…", progress=0.72)
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
                hdrs = getattr(resp, "headers", None)
                raw_len = hdrs.get("Content-Length") if hdrs and hasattr(hdrs, "get") else None
                expected_bytes = int(raw_len) if raw_len and str(raw_len).isdigit() else 35 * 1024 * 1024
                total = 0
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    out.write(chunk)
                    ratio = min(1.0, total / max(1, expected_bytes))
                    emit(
                        f"دانلود موتور کمکی CPU برای Surya: {total / (1024 * 1024):.1f} مگابایت",
                        progress=round(0.73 + 0.08 * ratio, 3),
                    )
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

    def _run_pip_streaming(
        self,
        pip_cmd: list[str],
        *,
        start_p: float,
        end_p: float,
        label_prefix: str,
        timeout: int = 3600,
    ) -> tuple[int, str]:
        full_cmd = [*pip_cmd, "--progress-bar", "off"]
        tail_lines: list[str] = []
        started = time.monotonic()
        step_count = 0
        proc = subprocess.Popen(
            full_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=_SUBPROCESS_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                if time.monotonic() - started > timeout:
                    proc.kill()
                    return 1, "Operation timed out during pip installation."
                line = raw_line.strip()
                if not line:
                    continue
                tail_lines.append(line)
                if len(tail_lines) > 80:
                    tail_lines.pop(0)
                lower = line.lower()
                if lower.startswith("downloading "):
                    step_count += 1
                    ratio = min(0.82, 1.0 - (1.0 / (1.0 + step_count * 0.14)))
                    cur_p = round(start_p + (end_p - start_p) * ratio, 3)
                    wheel_part = line.split("/")[-1].split(" ")[0][:48]
                    emit(f"{label_prefix}: دانلود بستهٔ {wheel_part}…", progress=cur_p)
                elif lower.startswith("collecting "):
                    step_count += 1
                    ratio = min(0.75, 1.0 - (1.0 / (1.0 + step_count * 0.10)))
                    cur_p = round(start_p + (end_p - start_p) * ratio, 3)
                    pkg_part = line[11:].split()[0][:40]
                    emit(f"{label_prefix}: آماده‌سازی بستهٔ {pkg_part}…", progress=cur_p)
                elif lower.startswith("installing collected packages"):
                    cur_p = round(start_p + (end_p - start_p) * 0.88, 3)
                    emit(f"{label_prefix}: در حال ثبت و نصب بسته‌ها روی دیسک…", progress=cur_p)
            rc = proc.wait(timeout=120)
            return rc, "\n".join(tail_lines)
        except Exception as exc:
            proc.kill()
            return 1, f"{exc}\n" + "\n".join(tail_lines)

    def _ensure_isolated_venv(self, upgrade: bool = False) -> None:
        env_dir = self._env_dir()
        py = self._env_python()
        hw = inspect_hardware()
        with self._install_lock:
            if not py.is_file():
                emit(f"ساخت پوشه و محیط مستقل برای مدل {self.id}…", progress=0.08)
                env_dir.parent.mkdir(parents=True, exist_ok=True)
                res = _run_Subprocess([sys.executable, "-m", "venv", str(env_dir)], capture_output=True, text=True, timeout=300, check=False)
                if res.returncode != 0 or not py.is_file():
                    raise self._error_cls(f"ساخت محیط مستقل برای {self.id} ناموفق بود: {(res.stderr or res.stdout)[-800:]}")
                emit(f"آماده‌سازی ابزار نصب در محیط مستقل {self.id}…", progress=0.14)
                _run_Subprocess([str(py), "-m", "ensurepip", "--upgrade"], capture_output=True, text=True, timeout=300, check=False)
                _run_Subprocess([str(py), "-m", "pip", "install", "--no-cache-dir", "--upgrade", "pip", "setuptools", "wheel"], capture_output=True, text=True, timeout=600, check=False)

            if self._spec.get("needs_torch"):
                torch_ready = _read_dist_version_in_venv(env_dir, "torch") is not None
                if not torch_ready:
                    torch_cmd = [str(py), "-m", "pip", "install", "--no-cache-dir", "torch>=2.3.0", "torchvision>=0.18.0"]
                    if os.name == "nt" and hw.get("hasNvidiaGpu"):
                        torch_cmd.extend(["--extra-index-url", "https://download.pytorch.org/whl/cu126"])
                    emit(f"نصب زیرساخت PyTorch برای {self.id}…", progress=0.20)
                    t_rc, t_out = self._run_pip_streaming(
                        torch_cmd, start_p=0.20, end_p=0.45, label_prefix=f"زیرساخت {self.id}"
                    )
                    if t_rc != 0:
                        raise self._error_cls(f"نصب PyTorch برای {self.id} ناموفق بود: {t_out[-1200:]}")

            packages = list(self._spec["pip_packages_gpu"] if hw.get("hasNvidiaGpu") else self._spec["pip_packages_cpu"])
            pip_base = [str(py), "-m", "pip", "install", "--no-cache-dir"]
            if os.name == "nt" and hw.get("hasNvidiaGpu") and self.id in {"surya", "mineru-2-5-pro"}:
                pip_base.extend(["--extra-index-url", "https://download.pytorch.org/whl/cu126"])
            if upgrade:
                pip_base.append("--upgrade")
            action_word = "به‌روزرسانی" if upgrade else "نصب"
            p_start = 0.46 if self._spec.get("needs_torch") else 0.18
            emit(f"{action_word} بسته‌های اختصاصی مدل {self.id} آغاز شد…", progress=p_start)
            if self.id == "paddleocr-vl-1-6" and hw.get("hasNvidiaGpu") and sys.platform.startswith("linux"):
                gpu_paddle_pkgs = [
                    "paddlepaddle-gpu>=3.2.0" if pkg.startswith("paddlepaddle>=") else pkg
                    for pkg in packages
                ]
                p_rc, p_out = self._run_pip_streaming(
                    [*pip_base, *gpu_paddle_pkgs],
                    start_p=p_start,
                    end_p=0.70,
                    label_prefix=f"{action_word} GPU {self.id}",
                )
                if p_rc != 0:
                    p_rc, p_out = self._run_pip_streaming(
                        [*pip_base, *packages],
                        start_p=p_start,
                        end_p=0.70,
                        label_prefix=f"{action_word} {self.id}",
                    )
            else:
                p_rc, p_out = self._run_pip_streaming(
                    [*pip_base, *packages],
                    start_p=p_start,
                    end_p=0.70,
                    label_prefix=f"{action_word} {self.id}",
                )
            fallback_pkgs = self._spec.get("pip_packages_fallback")
            if p_rc != 0 and fallback_pkgs:
                emit(f"تنظیم نسخهٔ سازگار بسته‌های {self.id} برای سیستم شما…", progress=round((p_start + 0.70) / 2, 2))
                p_rc, p_out = self._run_pip_streaming(
                    [*pip_base, *fallback_pkgs],
                    start_p=round((p_start + 0.70) / 2, 2),
                    end_p=0.70,
                    label_prefix=f"{action_word} سازگار {self.id}",
                )
            if p_rc != 0:
                details = (p_out or "pip failed")[-1500:].strip()
                raise self._error_cls(f"نصب بسته‌های مدل {self.id} ناموفق بود: {details}")

            emit(f"بسته‌های اجرایی مدل {self.id} آماده شد", progress=0.72)
            self._ensure_llama_cpp_for_surya()
            (env_dir / ".runtime-ready").write_text(_now_iso(), encoding="utf-8")

    def _prepare_weights(self, language: str) -> str:
        worker_script = _worker_script_path()
        emit(f"دریافت و آماده‌سازی فایل‌های مدل {self.id}…", progress=0.80)
        proc = subprocess.Popen(
            [
                str(self._env_python()),
                str(worker_script),
                "--engine", self.id,
                "--models-root", str(models_dir()),
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
        stderr_tail: list[str] = []
        weight_steps = [0]

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            last_emit_at = 0.0
            for raw in proc.stderr:
                cleaned = raw.replace("\r", "\n")
                for part in cleaned.splitlines():
                    s = part.strip()
                    if not s:
                        continue
                    stderr_tail.append(s)
                    if len(stderr_tail) > 60:
                        stderr_tail.pop(0)
                    now_t = time.monotonic()
                    if now_t - last_emit_at >= 1.5:
                        weight_steps[0] += 1
                        ratio = min(0.92, 1.0 - (1.0 / (1.0 + weight_steps[0] * 0.18)))
                        cur_p = round(0.80 + 0.14 * ratio, 3)
                        pct_match = re.search(r"(\d{1,3})%", s)
                        if pct_match:
                            sub_pct = min(100, max(0, int(pct_match.group(1))))
                            emit(
                                f"دانلود فایل‌های مدل {self.id} ({sub_pct}٪ از فایل جاری)…",
                                progress=cur_p,
                            )
                        else:
                            emit(f"در حال آماده‌سازی وزن‌های مدل {self.id}…", progress=cur_p)
                        last_emit_at = now_t

        err_thread = threading.Thread(target=_drain_stderr, daemon=True)
        err_thread.start()
        stdout_text = ""
        try:
            assert proc.stdout is not None
            stdout_text = proc.stdout.read()
            proc.wait(timeout=3600)
        except Exception:
            proc.kill()
            raise
        finally:
            err_thread.join(timeout=2.0)

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
        emit(f"فایل‌های مدل {self.id} ذخیره و تایید شد", progress=0.96)
        return str(last_json.get("modelRevision") or "ready")

    def download(self, language: str = "eng") -> None:
        self.close()
        try:
            emit(f"شروع آماده‌سازی خودکار مدل {self.id}…", progress=0.05)
            if not self.runtime_installed:
                self._ensure_isolated_venv(upgrade=False)
            else:
                emit(f"محیط اجرایی {self.id} از قبل آماده است؛ بررسی فایل‌های مدل…", progress=0.65)
            revision = self._prepare_weights(language)
            if revision == "ready" and self._spec.get("hf_repo"):
                remote_rev = fetch_remote_repo_revision(self._spec.get("github_repo"))
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
            self.close()
            trim_process_memory()

    def update(self, language: str = "eng") -> None:
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
            remote_rev = fetch_remote_repo_revision(self._spec.get("github_repo"))
            final_rev = remote_rev or revision
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
                _is_valid_comparable_revision(local_rev)
                and _is_valid_comparable_revision(latest_revision)
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
