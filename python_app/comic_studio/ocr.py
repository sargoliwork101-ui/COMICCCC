from __future__ import annotations

import contextlib
import contextvars
import csv
import importlib.util
import io
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from .activity import emit
from .ocr_managed import (
    ISOLATED_ENGINE_SPECS,
    IsolatedOcrEngine,
    _remove_path_safely,
    acknowledge_engine_update,
    check_remote_updates,
    cleanup_superseded_engine_files,
    clear_cached_engine_update,
    compute_engine_download_estimate,
    compute_engine_update_fields,
    compute_worker_count,
    cpu_core_count,
    detect_builtin_installed_version,
    engine_has_uninstallable_files,
    engine_meta,
    evaluate_engine_hardware,
    fetch_tessdata_revision,
    format_download_size_fa,
    inspect_hardware,
    install_tesseract_runtime,
    invalidate_engine_runtime_caches,
    is_newer_version,
    portable_tesseract_executable,
    process_rss_mb,
    read_manifest,
    read_update_cache,
    remove_cached_engine_update,
    remove_manifest_entry,
    sha256_short,
    trim_process_memory,
    update_manifest_entry,
)
from .paths import (
    bundled_models_dir,
    custom_site_packages_dir,
    ensure_custom_site_packages_on_path,
    is_custom_data_dir_active,
    models_dir,
)

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
_ORIG_SUBPROCESS_RUN = subprocess.run
_ORIG_INSTALL_TESSERACT = install_tesseract_runtime
_STANDARD_CANCEL_EVENT = threading.Event()


def _call_install_tesseract_runtime() -> str:
    if install_tesseract_runtime is _ORIG_INSTALL_TESSERACT:
        return install_tesseract_runtime(OcrError, cancel_event=_STANDARD_CANCEL_EVENT)
    return install_tesseract_runtime(OcrError)


def _win_subprocess_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        no_win = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if no_win:
            return {"creationflags": no_win}
    return {}


@contextlib.contextmanager
def _widen_download_timeouts(min_timeout: float = 120.0):
    """Ensure RapidOCR (`requests`) and EasyOCR (`urllib.request.urlretrieve` via socket timeout)
    never hang indefinitely on dead TCP sockets or fail prematurely on 15s timeouts."""
    import socket

    prev_sock_timeout = socket.getdefaulttimeout()
    if prev_sock_timeout is None or prev_sock_timeout < min_timeout:
        socket.setdefaulttimeout(min_timeout)
    orig_req = None
    requests_mod = None
    try:
        import requests as _req_mod
        requests_mod = _req_mod
        orig_req = getattr(_req_mod.Session, "request", None)
        if orig_req is not None and not getattr(orig_req, "_comic_studio_widened", False):
            def _wrapped(self_sess: Any, method: str, url: str, **kwargs: Any) -> Any:
                raw_t = kwargs.get("timeout")
                if raw_t is None or (isinstance(raw_t, (int, float)) and raw_t < min_timeout):
                    kwargs["timeout"] = min_timeout
                return orig_req(self_sess, method, url, **kwargs)
            _wrapped._comic_studio_widened = True  # type: ignore[attr-defined]
            _req_mod.Session.request = _wrapped  # type: ignore[method-assign]
        else:
            orig_req = None
    except Exception:
        orig_req = None
    try:
        yield
    finally:
        socket.setdefaulttimeout(prev_sock_timeout)
        if requests_mod is not None and orig_req is not None:
            with contextlib.suppress(Exception):
                requests_mod.Session.request = orig_req  # type: ignore[method-assign]

LANGUAGES = {
    "eng": {"name": "English", "source": "en"},
    "fas": {"name": "فارسی", "source": "fa"},
    "kor": {"name": "한국어", "source": "ko"},
    "jpn": {"name": "日本語", "source": "ja"},
    "chi_sim": {"name": "中文", "source": "zh-CN"},
}


@dataclass
class OcrLine:
    text: str
    confidence: float
    polygon: list[list[float]]
    bold: bool = False
    italic: bool = False
    role: str | None = None

    @property
    def box(self) -> list[float]:
        xs = [point[0] for point in self.polygon]
        ys = [point[1] for point in self.polygon]
        return [min(xs), min(ys), max(xs), max(ys)]


class OcrError(RuntimeError):
    pass


def _run_standard_pip_streaming(
    cmd: list[str],
    *,
    env: dict[str, str],
    cdir: Path,
    cancel_event: threading.Event,
    stall_timeout: float = 180.0,
    start_p: float = 0.18,
    end_p: float = 0.66,
    progress_cb: Callable[[str, float], None] | None = None,
    label: str = "OCR",
) -> subprocess.CompletedProcess[str]:
    from .ocr_managed import _dir_bytes_fast, _kill_process_tree, _parse_size_to_bytes

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=env,
        **_win_subprocess_kwargs(),
    )
    tail: list[str] = []
    last_activity_at = [time.monotonic()]
    base_bytes = _dir_bytes_fast(cdir)
    last_bytes = [base_bytes]
    stalled = [False]
    done = threading.Event()
    cur_p = [start_p]
    span = max(0.03, end_p - start_p)
    has_torch = any("torch" in str(part).lower() for part in cmd)
    has_ct2 = any("ctranslate2" in str(part).lower() for part in cmd)
    expected_bytes = [float((2550 if has_torch else (45 if has_ct2 else 120)) * (1024 ** 2))]
    announced_bytes = [0.0]
    completed_wheel_bytes = [0.0]
    active_wheel_bytes = [0.0]
    collect_steps = [0]

    def _is_cancelled() -> bool:
        return cancel_event.is_set() or _STANDARD_CANCEL_EVENT.is_set()

    def _emit_std(msg: str, ratio: float) -> None:
        clamped = max(0.0, min(0.98, ratio))
        cur_p[0] = max(cur_p[0], round(start_p + span * clamped, 3))
        emit(msg, progress=cur_p[0])
        if progress_cb is not None:
            progress_cb(msg, cur_p[0])

    def _watchdog() -> None:
        while not done.wait(1.0):
            if _is_cancelled():
                _kill_process_tree(proc)
                return
            now = time.monotonic()
            if now - last_activity_at[0] >= 1.5:
                b_now = _dir_bytes_fast(cdir)
                if b_now > last_bytes[0]:
                    last_bytes[0] = b_now
                    last_activity_at[0] = now
                    gained_b = max(0.0, float(b_now - base_bytes))
                    mb = max(0.1, gained_b / (1024 * 1024))
                    denom = max(expected_bytes[0], announced_bytes[0] * 1.05, gained_b * 1.06)
                    dl_ratio = min(1.0, max(gained_b, completed_wheel_bytes[0]) / max(1.0, denom))
                    _emit_std(f"در حال دریافت بسته‌های {label} ({mb:.1f} مگابایت)…", 0.06 + 0.80 * dl_ratio)
                    continue
            if now - last_activity_at[0] >= stall_timeout:
                stalled[0] = True
                _kill_process_tree(proc)
                return

    watcher = threading.Thread(target=_watchdog, daemon=True)
    watcher.start()
    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            last_activity_at[0] = time.monotonic()
            if _is_cancelled():
                _kill_process_tree(proc)
                return subprocess.CompletedProcess(cmd, 130, "", "Cancelled by user")
            line = raw_line.strip()
            if not line:
                continue
            tail.append(line)
            if len(tail) > 120:
                tail.pop(0)
            low = line.lower()
            if low.startswith("downloading "):
                completed_wheel_bytes[0] += active_wheel_bytes[0]
                size_m = re.search(r"\(([\d.]+\s*[kKmMgG][bB])\)", line)
                active_wheel_bytes[0] = _parse_size_to_bytes(size_m.group(1)) if size_m else 0.0
                announced_bytes[0] += active_wheel_bytes[0]
                expected_bytes[0] = max(expected_bytes[0], announced_bytes[0] * 1.05)
                b_now = _dir_bytes_fast(cdir)
                last_bytes[0] = max(last_bytes[0], b_now)
                gained_b = max(0.0, float(b_now - base_bytes), completed_wheel_bytes[0])
                dl_ratio = min(1.0, gained_b / max(1.0, expected_bytes[0]))
                _emit_std(f"دریافت بسته: {line[:95]}", 0.06 + 0.80 * dl_ratio)
            elif low.startswith("collecting "):
                collect_steps[0] += 1
                _emit_std(f"بررسی بسته: {line[:95]}", min(0.06, collect_steps[0] * 0.008))
            elif low.startswith("installing collected packages"):
                completed_wheel_bytes[0] += active_wheel_bytes[0]
                active_wheel_bytes[0] = 0.0
                _emit_std(f"در حال نصب بسته‌های {label} روی سیستم…", 0.90)
        rc = proc.wait(timeout=30)
    except Exception:
        _kill_process_tree(proc)
        rc = 1
    finally:
        done.set()
        watcher.join(timeout=2.0)

    joined = "\n".join(tail)
    if _is_cancelled():
        return subprocess.CompletedProcess(cmd, 130, "", "Cancelled by user")
    if stalled[0]:
        joined = (joined + f"\nOperation timed out during pip installation (stalled >{int(stall_timeout)}s).").strip()
        return subprocess.CompletedProcess(cmd, 124, "", joined)
    return subprocess.CompletedProcess(cmd, rc, joined if rc == 0 else "", "" if rc == 0 else joined)


def _resolve_pip_python_executable(*, match_current_minor: bool = False) -> str:
    """Return a real Python interpreter for `-m pip` / `-m venv`, avoiding PyInstaller `.exe` self-recursion."""
    if not getattr(sys, "frozen", False):
        return sys.executable
    frozen_exe = os.path.abspath(sys.executable)
    cur_major, cur_minor = sys.version_info[:2]
    candidates: list[str] = []
    for name in (f"python{cur_major}.{cur_minor}", "python", "python3"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("ProgramFiles", "")
        ordered_vers = [f"Python{cur_major}{cur_minor}", "Python313", "Python312", "Python311"]
        for base in (local_app, prog_files):
            if not base:
                continue
            for ver in dict.fromkeys(ordered_vers):
                candidates.append(os.path.join(base, "Programs", "Python", ver, "python.exe"))
                candidates.append(os.path.join(base, ver, "python.exe"))
    check_expr = (
        f"import sys; raise SystemExit(0 if sys.version_info[:2] == ({cur_major}, {cur_minor}) else 1)"
        if match_current_minor
        else "import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 14) else 1)"
    )
    seen: set[str] = set()
    for cand in candidates:
        if not cand or "windowsapps" in cand.lower():
            continue
        abs_cand = os.path.abspath(cand)
        key = abs_cand.lower() if os.name == "nt" else abs_cand
        if key in seen or abs_cand == frozen_exe or not os.path.isfile(abs_cand):
            continue
        seen.add(key)
        try:
            probe = _ORIG_SUBPROCESS_RUN(
                [abs_cand, "-c", check_expr],
                capture_output=True, text=True, timeout=10, check=False, **_win_subprocess_kwargs(),
            )
            if probe.returncode == 0:
                return abs_cand
        except Exception:
            continue
    ver_hint = f"Python {cur_major}.{cur_minor}" if match_current_minor else "Python 3.11 تا 3.13"
    raise OcrError(
        f"در نسخهٔ نصبی آفلاین (.exe)، برای نصب بسته‌های پایتونی جدید نیاز به نصب بودن {ver_hint} روی ویندوز یا استفاده از پوشهٔ start_windows.bat است."
    )


def install_packages(
    packages: list[str],
    *,
    upgrade: bool = False,
    cancel_event: threading.Event | None = None,
    progress_cb: Callable[[str, float], None] | None = None,
    start_p: float = 0.18,
    end_p: float = 0.66,
    label: str = "OCR",
) -> None:
    """Install a whitelisted runtime only after an explicit user preparation click."""
    if not packages:
        return
    eff_cancel = cancel_event if cancel_event is not None else _STANDARD_CANCEL_EVENT
    if eff_cancel.is_set() or _STANDARD_CANCEL_EVENT.is_set():
        raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
    from .ocr_managed import (
        PYPI_FALLBACK_MIRRORS,
        clean_pip_env,
        is_pip_network_or_index_error,
        pip_cache_dir,
        sync_local_wheelhouse,
    )

    py_exe = _resolve_pip_python_executable(match_current_minor=True)
    cdir = pip_cache_dir()
    wh = sync_local_wheelhouse()
    target_site: Path | None = None
    if is_custom_data_dir_active() or getattr(sys, "frozen", False):
        target_site = custom_site_packages_dir()
        with contextlib.suppress(OSError):
            target_site.mkdir(parents=True, exist_ok=True)
    has_custom_index = bool(os.environ.get("PIP_INDEX_URL")) or ("--index-url" in packages) or ("-i" in packages)

    def _build_cmd(mirror_url: str | None = None) -> list[str]:
        cmd = [
            py_exe, "-m", "pip", "install",
            "--timeout", "120",
            "--retries", "10",
            "--prefer-binary",
            "--cache-dir", str(cdir),
        ]
        try:
            if wh.is_dir() and any(wh.glob("*.whl")):
                cmd.extend(["--find-links", str(wh)])
        except OSError:
            pass
        if mirror_url:
            cmd.extend(["--index-url", mirror_url])
        if target_site is not None:
            cmd.extend(["--target", str(target_site), "--upgrade"])
        elif upgrade:
            cmd.append("--upgrade")
        cmd.extend(packages)
        return cmd

    action_label = "به‌روزرسانی" if upgrade else "نصب"
    start_msg = f"{action_label} بسته‌های {label} آغاز شد: {', '.join(packages)}"
    emit(start_msg, progress=start_p)
    if progress_cb is not None:
        progress_cb(start_msg, start_p)
    attempts: list[tuple[str | None, str | None]] = [
        (None, None),
        (None, f"تلاش مجدد برای دریافت بسته‌های {label} از کش محلی…"),
    ]
    if not has_custom_index:
        for mirror_name, mirror_url in PYPI_FALLBACK_MIRRORS:
            attempts.append((mirror_url, f"ادامهٔ نصب بسته‌های {label} از میرور جایگزین ({mirror_name})…"))

    result: subprocess.CompletedProcess[str] | None = None
    try:
        with _INSTALL_LOCK:
            for idx, (mirror_url, notice) in enumerate(attempts):
                if eff_cancel.is_set() or _STANDARD_CANCEL_EVENT.is_set():
                    raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
                if idx > 0:
                    if notice:
                        retry_p = round(start_p + (end_p - start_p) * 0.15, 3)
                        emit(notice, "warning", progress=retry_p)
                        if progress_cb is not None:
                            progress_cb(notice, retry_p)
                    time.sleep(1.0)
                    wh = sync_local_wheelhouse()
                built_cmd = _build_cmd(mirror_url)
                if subprocess.run is not _ORIG_SUBPROCESS_RUN:
                    result = subprocess.run(
                        built_cmd,
                        capture_output=True, text=True, timeout=3600, check=False, env=clean_pip_env(), **_win_subprocess_kwargs(),
                    )
                else:
                    result = _run_standard_pip_streaming(
                        built_cmd,
                        env=clean_pip_env(),
                        cdir=cdir,
                        cancel_event=eff_cancel,
                        start_p=start_p,
                        end_p=end_p,
                        progress_cb=progress_cb,
                        label=label,
                    )
                if eff_cancel.is_set() or _STANDARD_CANCEL_EVENT.is_set() or (result is not None and result.returncode == 130):
                    raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
                if result.returncode == 0:
                    if target_site is not None:
                        ensure_custom_site_packages_on_path()
                    importlib.invalidate_caches()
                    sync_local_wheelhouse()
                    break
                combined_err = f"{result.stderr or ''}\n{result.stdout or ''}"
                if not is_pip_network_or_index_error(combined_err):
                    break
    except OcrError:
        raise
    except Exception as exc:
        emit(f"نصب بسته‌های {label} ناموفق بود: {exc}", "error")
        raise OcrError(f"Could not install the OCR runtime: {exc}") from exc
    assert result is not None
    if result.returncode:
        details = (result.stderr or result.stdout or "pip failed")[-1800:].strip()
        if "WinError 32" in details or "being used by another process" in details:
            details += ("\nComic OCR Studio: a second Python/pip installer or antivirus may be locking the temporary file. "
                        "Close other Python/installer windows, restart Windows if needed, and retry one installation only.")
        if "WinError 5" in details or "Access is denied" in details:
            details += ("\nComic OCR Studio: Windows denied write access. Close the app, start start_windows_admin.bat, "
                        "approve the UAC prompt, and retry the explicit OCR installation.")
        emit(f"نصب بسته‌های {label} ناموفق بود: {details}", "error")
        raise OcrError(f"OCR runtime installation failed: {details}")
    importlib.invalidate_caches()
    done_p = round(min(0.99, end_p + 0.02), 3)
    emit(f"نصب بسته‌های {label} تمام شد", "success", progress=done_p)
    if progress_cb is not None:
        progress_cb(f"نصب بسته‌های {label} تمام شد", done_p)


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


def _detect_onnx_acceleration() -> dict[str, Any]:
    """Detect available ONNX Runtime GPU execution providers (CUDA, Windows DirectML, macOS CoreML)."""
    try:
        import onnxruntime as ort
        providers = list(ort.get_available_providers())
        ort_device = str(ort.get_device()).upper() if hasattr(ort, "get_device") else "CPU"
    except Exception:
        return {"mode": "cpu", "gpu": False, "params": {}}

    if "CUDAExecutionProvider" in providers and ort_device == "GPU":
        return {
            "mode": "cuda",
            "gpu": True,
            "params": {
                "EngineConfig.onnxruntime.use_cuda": True,
                "EngineConfig.onnxruntime.cuda_ep_cfg": {
                    "device_id": 0,
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "HEURISTIC",
                    "do_copy_in_default_stream": True,
                },
            },
        }
    if "DmlExecutionProvider" in providers:
        hw = inspect_hardware()
        if hw.get("hasGpu", True) or "DmlExecutionProvider" in providers:
            return {
                "mode": "directml",
                "gpu": True,
                "params": {
                    "EngineConfig.onnxruntime.use_dml": True,
                    "EngineConfig.onnxruntime.dml_ep_cfg": {
                        "performance_preference": "high_performance",
                        "device_filter": "gpu",
                    },
                },
            }
    if "CoreMLExecutionProvider" in providers and sys.platform == "darwin":
        return {
            "mode": "coreml",
            "gpu": True,
            "params": {
                "EngineConfig.onnxruntime.use_coreml": True,
            },
        }
    return {"mode": "cpu", "gpu": False, "params": {}}


def _install_fallback_bidi_shim() -> None:
    """Provide a pure-Python visual-to-logical RTL `bidi.algorithm.get_display` fallback
    only if `python-bidi` could not be imported (e.g. offline/air-gapped runtime), so
    `rapidocr`'s `validate_rtl_dependency()` never aborts Persian (`fas` -> `arabic`) OCR."""
    import types
    import unicodedata

    try:
        from bidi.algorithm import get_display as _gd  # noqa: F401
        return
    except Exception:
        pass
    try:
        from bidi import get_display as _top_gd  # type: ignore[import-not-found]
        alg_mod = types.ModuleType("bidi.algorithm")
        alg_mod.get_display = _top_gd  # type: ignore[attr-defined]
        sys.modules["bidi.algorithm"] = alg_mod
        return
    except Exception:
        pass

    _MIRROR = str.maketrans("()[]{}<>«»", ")(][}{><»«")

    def _fallback_get_display(text_or_bytes: str | bytes, *args: Any, **kwargs: Any) -> str | bytes:
        is_bytes = isinstance(text_or_bytes, bytes)
        encoding = str(kwargs.get("encoding", "utf-8"))
        text = text_or_bytes.decode(encoding, errors="replace") if is_bytes else str(text_or_bytes)
        if not text:
            return b"" if is_bytes else ""
        has_rtl = any(unicodedata.bidirectional(ch) in {"R", "AL", "AN"} for ch in text)
        if not has_rtl:
            return text.encode(encoding) if is_bytes else text
        # Reverse visual-order RTL line while keeping contiguous LTR/digit runs forward.
        tokens: list[tuple[bool, str]] = []
        for ch in text:
            bd = unicodedata.bidirectional(ch)
            is_ltr_tok = bd in {"L", "EN", "ES", "ET"} or ch.isascii() and ch.isalnum()
            if tokens and tokens[-1][0] == is_ltr_tok:
                tokens[-1] = (is_ltr_tok, tokens[-1][1] + ch)
            else:
                tokens.append((is_ltr_tok, ch))
        rebuilt: list[str] = []
        for is_ltr_tok, seg in reversed(tokens):
            rebuilt.append(seg if is_ltr_tok else seg[::-1].translate(_MIRROR))
        out = "".join(rebuilt)
        return out.encode(encoding) if is_bytes else out

    bidi_pkg = sys.modules.get("bidi") or types.ModuleType("bidi")
    alg_mod = types.ModuleType("bidi.algorithm")
    bidi_pkg.get_display = _fallback_get_display  # type: ignore[attr-defined]
    alg_mod.get_display = _fallback_get_display  # type: ignore[attr-defined]
    bidi_pkg.algorithm = alg_mod  # type: ignore[attr-defined]
    sys.modules["bidi"] = bidi_pkg
    sys.modules["bidi.algorithm"] = alg_mod


def _stream_download_with_mirrors(
    urls: list[tuple[str, dict[str, str]]],
    dest_path: Path,
    *,
    label: str,
    min_bytes: int = 1024,
    max_bytes: int = 300 * 1024 * 1024,
    start_p: float = 0.72,
    span_p: float = 0.18,
) -> Path:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    part_path = dest_path.parent / f".{dest_path.name}.part"
    last_exc: Exception | None = None
    for idx, (url, extra_headers) in enumerate(urls):
        if _STANDARD_CANCEL_EVENT.is_set():
            part_path.unlink(missing_ok=True)
            raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
        if idx > 0:
            emit(f"ادامهٔ دریافت {label} از سرور جایگزین ({idx + 1}/{len(urls)})…", "warning", progress=round(start_p, 3))
        headers = {"User-Agent": "Comic-OCR-Studio", **extra_headers}
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=180) as resp, part_path.open("wb") as out:
                hdrs = getattr(resp, "headers", None)
                raw_len = hdrs.get("Content-Length") if hdrs and hasattr(hdrs, "get") else None
                expected = int(raw_len) if raw_len and str(raw_len).isdigit() else 12 * 1024 * 1024
                total = 0
                while True:
                    if _STANDARD_CANCEL_EVENT.is_set():
                        raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
                    chunk = resp.read(512 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise OcrError(f"Downloaded file {dest_path.name} exceeded safe size limit.")
                    out.write(chunk)
                    ratio = min(1.0, total / max(1, expected))
                    emit(
                        f"دانلود {label}: {total / (1024 * 1024):.1f} مگابایت دریافت شد",
                        progress=round(start_p + span_p * ratio, 3),
                    )
            if part_path.stat().st_size < min_bytes:
                raise OcrError(f"Downloaded file {dest_path.name} is incomplete or empty.")
            os.replace(part_path, dest_path)
            return dest_path
        except OcrError:
            part_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            part_path.unlink(missing_ok=True)
            last_exc = exc
            continue
    raise OcrError(f"Download failed for {label}: {last_exc}") from last_exc


class RapidEngine:
    def __init__(self, engine_id: str, version: str) -> None:
        self.id = engine_id
        self.version = version
        self._instances: dict[str, Any] = {}
        self._idle_pool: dict[str, list[Any]] = {}
        self._created_counts: dict[str, int] = {}
        self._lock = threading.Lock()
        self._pool_cond = threading.Condition(self._lock)
        self._gpu_infer_lock = threading.Lock()
        self._using_gpu: bool = False
        self._force_cpu: bool = False
        self._batch_slots: int = 1
        self._batch_threads: int | None = None

    @property
    def runtime_installed(self) -> bool:
        return bool(importlib.util.find_spec("rapidocr")) and bool(importlib.util.find_spec("onnxruntime"))

    @property
    def using_gpu(self) -> bool:
        return bool(self._using_gpu and not self._force_cpu)

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
                if any(
                    all((cand / name).is_file() for name in self._expected_models(language))
                    for cand in self._candidate_v5_dirs()
                )
            ]
        except Exception:
            return []

    @property
    def model_ready(self) -> bool:
        return bool(self.ready_languages)

    @property
    def is_loaded_in_ram(self) -> bool:
        with self._lock:
            return bool(self._instances or any(self._idle_pool.values()) or any(self._created_counts.values()))

    def unload(self) -> None:
        with self._pool_cond:
            self._instances.clear()
            self._idle_pool.clear()
            self._created_counts.clear()
            self._pool_cond.notify_all()

    def uninstall(self) -> int:
        if self.version == "v6":
            raise OcrError("موتور پایهٔ پیش‌فرض برنامه (PP-OCRv6 Small) همراه محیط اصلی است و نیازی به حذف ندارد.")
        self.cancel_install()
        self.unload()
        with _INSTALL_LOCK:
            freed = _remove_path_safely(self._model_dir())
            remove_manifest_entry(self.id)
            remove_cached_engine_update(self.id)
            invalidate_engine_runtime_caches()
        trim_process_memory()
        return freed

    @contextlib.contextmanager
    def configure_batch(self, total_pages: int, threads_per_worker: int | None = None):
        if threads_per_worker is None:
            accel = _detect_onnx_acceleration()
            if accel.get("gpu") and not self._force_cpu:
                worker_slots, computed_threads = 1, max(1, cpu_core_count())
            else:
                worker_slots, computed_threads = compute_worker_count(total_pages, per_worker_mb=420, max_cap=3)
        else:
            worker_slots = max(1, int(total_pages))
            computed_threads = max(1, int(threads_per_worker))
        with self._pool_cond:
            prev_slots, prev_threads = self._batch_slots, self._batch_threads
            self._batch_slots = max(1, int(worker_slots))
            self._batch_threads = max(1, int(computed_threads))
        try:
            yield self._batch_slots
        finally:
            with self._pool_cond:
                self._batch_slots = prev_slots
                self._batch_threads = prev_threads
                self._pool_cond.notify_all()

    def _language_names(self, language: str) -> tuple[str, str]:
        if self.version == "v6":
            name = {"eng": "en", "jpn": "japan", "chi_sim": "ch"}.get(language, "en")
            return name, name
        return "ch", {"kor": "korean", "fas": "arabic", "eng": "latin", "jpn": "ch", "chi_sim": "ch"}.get(language, "ch")

    def _model_dir(self) -> Path:
        return models_dir() / "rapidocr"

    def _candidate_v5_dirs(self) -> list[Path]:
        dirs = [self._model_dir()]
        bundled = bundled_models_dir()
        if bundled is not None:
            b_dir = bundled / "rapidocr"
            if b_dir.is_dir():
                dirs.append(b_dir)
        return dirs

    def _effective_v5_dir(self, language: str) -> Path:
        expected = self._expected_models(language)
        cands = self._candidate_v5_dirs()
        for cand in cands:
            if all((cand / name).is_file() and (cand / name).stat().st_size > 0 for name in expected):
                return cand
        for cand in cands:
            if all((cand / name).is_file() for name in expected):
                return cand
        return self._model_dir()

    def _v6_model_dir(self) -> Path:
        bundled = bundled_models_dir()
        if bundled is not None:
            b_v6 = bundled / "rapidocr-v6"
            if all((b_v6 / name).is_file() and (b_v6 / name).stat().st_size > 0 for name in ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx")):
                return b_v6
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

        # Disable ONNX Runtime Eigen threadpool busy-spinning AND unbounded variable-shape memory patterns
        # so threads sleep at 0% CPU between pages and intermediate buffers release immediately after each page.
        with contextlib.suppress(Exception):
            from rapidocr.inference_engine.onnxruntime.main import OrtInferSession
            orig_opts = OrtInferSession._init_sess_opts
            if not getattr(orig_opts, "_comic_no_spin", False):
                def _patched_sess_opts(cfg: Any):
                    so = orig_opts(cfg)
                    with contextlib.suppress(Exception):
                        so.enable_cpu_mem_arena = False
                        so.enable_mem_pattern = False
                    with contextlib.suppress(Exception):
                        so.add_session_config_entry("session.intra_op.allow_spinning", "0")
                        so.add_session_config_entry("session.inter_op.allow_spinning", "0")
                    return so

                _patched_sess_opts._comic_no_spin = True  # type: ignore[attr-defined]
                OrtInferSession._init_sess_opts = staticmethod(_patched_sess_opts)  # type: ignore[assignment]

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
        if language == "fas":
            # Disable 0°/180° orientation classifier (trained on CJK/Latin) so cursive RTL Persian lines
            # are never flipped upside-down, and widen DBNet polygon unclip so upper/lower dots stay inside.
            params["Global.use_cls"] = False
            params["Det.unclip_ratio"] = 2.0
            params["Det.box_thresh"] = 0.45
        if self.version == "v5":
            # Keep user-downloaded models outside the virtual environment (or use bundled offline models).
            params["Global.model_root_dir"] = str(self._effective_v5_dir(language))

        cores = cpu_core_count()
        intra = max(1, min(cores, int(self._batch_threads))) if self._batch_threads else cores
        inter = min(4, max(1, intra // 2))
        cpu_params = {
            **params,
            "EngineConfig.onnxruntime.enable_cpu_mem_arena": False,
            "EngineConfig.onnxruntime.intra_op_num_threads": intra,
            "EngineConfig.onnxruntime.inter_op_num_threads": inter,
        }
        if not self._force_cpu:
            accel = _detect_onnx_acceleration()
            if accel.get("gpu"):
                try:
                    gpu_params = {**cpu_params, **accel["params"]}
                    instance = RapidOCR(params=gpu_params)
                    self._using_gpu = True
                    return instance
                except Exception:
                    self._using_gpu = False
        self._using_gpu = False
        try:
            return RapidOCR(params=cpu_params)
        except Exception:
            return RapidOCR(params=params)

    def _ensure_rtl_bidi(self, language: str, *, allow_install: bool) -> None:
        if language != "fas":
            return
        try:
            from bidi.algorithm import get_display as _gd  # noqa: F401
            return
        except Exception:
            pass
        if allow_install and importlib.util.find_spec("bidi") is None:
            emit("نصب بستهٔ پشتیبانی راست‌به‌چپ فارسی (python-bidi) برای RapidOCR…", progress=0.68)
            with contextlib.suppress(OcrError):
                install_packages(["python-bidi>=0.4.2,<1"])
        _install_fallback_bidi_shim()

    def _download_v5_models_from_mirrors(self, language: str) -> None:
        if self.version != "v5":
            return
        root = self._model_dir()
        root.mkdir(parents=True, exist_ok=True)
        # Copy bundled orientation classifier from installed rapidocr package if present so
        # RapidOCR never needs a network fetch for `ch_ppocr_mobile_v2.0_cls_mobile.onnx`.
        with contextlib.suppress(Exception):
            bundled_cls = self._v6_model_dir() / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
            dest_cls = root / bundled_cls.name
            if bundled_cls.is_file() and not dest_cls.is_file():
                shutil.copy2(bundled_cls, dest_cls)
        for fname in self._expected_models(language):
            target = root / fname
            if target.is_file() and target.stat().st_size >= 10_000:
                continue
            if target.is_file():
                target.unlink(missing_ok=True)
            sub = "det" if "_det_" in fname else "rec"
            rel = f"onnx/PP-OCRv5/{sub}/{fname}"
            urls = [
                (f"https://huggingface.co/RapidAI/RapidOCR/resolve/v3.10.0/{rel}", {}),
                (f"https://hf-mirror.com/RapidAI/RapidOCR/resolve/v3.10.0/{rel}", {}),
                (f"https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/{rel}", {}),
            ]
            _stream_download_with_mirrors(
                urls,
                target,
                label=f"{self.id} ({fname})",
                min_bytes=10_000,
                start_p=0.74,
                span_p=0.16,
            )

    def _ensure_runtime(self) -> None:
        if not self.runtime_installed:
            emit("بستهٔ اجرای RapidOCR موجود نیست؛ نصب آگاهانه آغاز می‌شود")
            hw = inspect_hardware()
            installed_gpu = False
            if os.name == "nt" and hw.get("hasGpu"):
                try:
                    install_packages(["rapidocr>=3.10,<3.11", "onnxruntime-directml>=1.20,<2", "python-bidi>=0.4.2,<1"])
                    installed_gpu = self.runtime_installed
                except OcrError:
                    installed_gpu = False
            elif sys.platform.startswith("linux") and hw.get("hasNvidiaGpu"):
                try:
                    install_packages(["rapidocr>=3.10,<3.11", "onnxruntime-gpu>=1.20,<2", "python-bidi>=0.4.2,<1"])
                    installed_gpu = self.runtime_installed
                except OcrError:
                    installed_gpu = False
            if not installed_gpu and not self.runtime_installed:
                install_packages(["rapidocr>=3.10,<3.11", "onnxruntime>=1.20,<2", "python-bidi>=0.4.2,<1"])
        if not self.runtime_installed:
            raise OcrError("RapidOCR was installed but cannot be imported. Restart the application and try again.")

    def _validate_ready(self, language: str, allow_download: bool = False) -> None:
        if language not in ENGINE_INFO.get(self.id, {}).get("languages", LANGUAGES):
            raise OcrError(f"Unsupported {self.id} language: {language}")
        if not self.runtime_installed:
            raise OcrError("RapidOCR is not installed. Click the explicit preparation button to install it.")
        if not allow_download:
            root = self._effective_v5_dir(language) if self.version == "v5" else self._v6_model_dir()
            missing = [name for name in self._expected_models(language) if not (root / name).is_file() or (root / name).stat().st_size == 0]
            if missing:
                raise OcrError(f"{self.id} model is not ready. Use the explicit model download button first.")

    def _get(self, language: str, allow_download: bool = False):
        self._validate_ready(language, allow_download)
        with self._lock:
            if language not in self._instances:
                emit(f"بارگذاری یا دانلود مدل {self.id} برای {language} آغاز شد")
                self._ensure_rtl_bidi(language, allow_install=allow_download)
                if allow_download and self.version == "v5":
                    root = self._model_dir()
                    for fname in self._expected_models(language):
                        cand = root / fname
                        if cand.is_file() and cand.stat().st_size < 10_000:
                            cand.unlink(missing_ok=True)
                try:
                    inst = self._create(language)
                except Exception as exc:
                    is_dl_fail = (
                        allow_download
                        and self.version == "v5"
                        and (
                            "download" in type(exc).__name__.lower()
                            or "failed to download" in str(exc).lower()
                            or "modelscope" in str(exc).lower()
                        )
                    )
                    if is_dl_fail:
                        try:
                            self._download_v5_models_from_mirrors(language)
                            inst = self._create(language)
                        except OcrError:
                            raise
                        except Exception as mirror_exc:
                            raise OcrError(f"Could not initialize {self.id}: {mirror_exc}") from mirror_exc
                    else:
                        raise OcrError(f"Could not initialize {self.id}: {exc}") from exc
                self._instances[language] = inst
                self._idle_pool.setdefault(language, []).append(inst)
                self._created_counts[language] = max(1, self._created_counts.get(language, 0))
        return self._instances[language]

    @contextlib.contextmanager
    def _checkout(self, language: str):
        # Ensure primary instance is initialized (honoring any test monkeypatch on `_get`).
        primary = self._get(language)
        if self._batch_slots <= 1 or self.using_gpu:
            yield primary
            return
        with self._pool_cond:
            pool = self._idle_pool.setdefault(language, [])
            if not pool and self._created_counts.get(language, 0) == 0:
                pool.append(primary)
                self._created_counts[language] = 1
            while not pool and self._created_counts.get(language, 0) >= self._batch_slots:
                self._pool_cond.wait(timeout=2.0)
                if not self._instances and self._created_counts.get(language, 0) == 0:
                    break
            if pool:
                chosen = pool.pop()
            else:
                self._created_counts[language] = self._created_counts.get(language, 0) + 1
                chosen = None
        if chosen is None:
            try:
                chosen = self._create(language)
            except Exception as exc:
                with self._pool_cond:
                    self._created_counts[language] = max(0, self._created_counts.get(language, 1) - 1)
                    self._pool_cond.notify_all()
                raise OcrError(f"Could not initialize {self.id} worker: {exc}") from exc
        try:
            yield chosen
        finally:
            with self._pool_cond:
                if language in self._instances:
                    self._idle_pool.setdefault(language, []).append(chosen)
                self._pool_cond.notify()

    @staticmethod
    def _warm(engine: Any) -> None:
        # RapidOCR loads its ONNX sessions lazily; this explicit warm-up is used only by download().
        sample = Image.new("RGB", (240, 80), "white")
        try:
            from PIL import ImageDraw, ImageFont
            ImageDraw.Draw(sample).text((8, 15), "TEST", fill="black", font=ImageFont.load_default(size=32))
            engine(np.asarray(sample), use_cls=False)
        finally:
            sample.close()

    def cancel_install(self) -> None:
        _STANDARD_CANCEL_EVENT.set()

    def download(self, language: str = "eng") -> None:
        _STANDARD_CANCEL_EVENT.clear()
        dl_est = compute_engine_download_estimate(
            self.id,
            runtime_installed=self.runtime_installed,
            model_ready=self.model_ready,
        )
        dl_label = format_download_size_fa(dl_est["totalDownloadGb"])
        emit(f"شروع آماده‌سازی مدل {self.id} (کل حجم دانلود: {dl_label})…", progress=0.06)
        self._ensure_runtime()
        languages = [language] if self.version == "v5" else ["eng"]
        try:
            with _widen_download_timeouts():
                for idx, selected in enumerate(languages):
                    if _STANDARD_CANCEL_EVENT.is_set():
                        raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
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
        _STANDARD_CANCEL_EVENT.clear()
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
            with _widen_download_timeouts():
                for idx, selected in enumerate(target_langs):
                    if _STANDARD_CANCEL_EVENT.is_set():
                        raise OcrError("عملیات به‌روزرسانی مدل لغو شد.")
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
        rgb = _to_white_backed_rgb(image) if getattr(image, "mode", "RGB") != "RGB" else image
        try:
            arr = np.asarray(rgb)
        finally:
            if rgb is not image:
                rgb.close()
        need_cpu_retry = False
        force_cpu_before = self._force_cpu
        with self._checkout(language) as engine:
            used_gpu_engine = self.using_gpu or (not force_cpu_before and self._force_cpu)
            infer_ctx = self._gpu_infer_lock if used_gpu_engine else contextlib.nullcontext()
            try:
                with infer_ctx:
                    if used_gpu_engine and self._force_cpu:
                        need_cpu_retry = True
                    else:
                        try:
                            result = engine(arr, use_cls=False)
                        except TypeError:
                            result = engine(arr)
            except Exception as exc:
                if used_gpu_engine:
                    # Automatic fallback to multi-core CPU if GPU provider fails at runtime (e.g. VRAM limit)
                    with self._gpu_infer_lock:
                        if not self._force_cpu:
                            self._force_cpu = True
                            self.unload()
                    need_cpu_retry = True
                else:
                    raise OcrError(f"OCR failed: {exc}") from exc
        if need_cpu_retry:
            with self._checkout(language) as cpu_engine:
                try:
                    result = cpu_engine(arr, use_cls=False)
                except TypeError:
                    result = cpu_engine(arr)
                except Exception as cpu_exc:
                    raise OcrError(f"OCR failed: {cpu_exc}") from cpu_exc
        lines = _lines_from_rapid(result)
        if language == "fas":
            lines = [
                OcrLine(
                    normalize_persian_ocr_text(line.text),
                    line.confidence,
                    line.polygon,
                    bold=bool(getattr(line, "bold", False)),
                    italic=bool(getattr(line, "italic", False)),
                    role=getattr(line, "role", None),
                )
                for line in lines
                if normalize_persian_ocr_text(line.text)
            ]
        return lines


class EasyEngine:
    id = "easyocr"

    def __init__(self) -> None:
        self._readers: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._using_gpu: bool = False
        self._force_cpu: bool = False

    @property
    def runtime_installed(self) -> bool:
        ensure_custom_site_packages_on_path()
        return bool(importlib.util.find_spec("easyocr"))

    def _model_dir(self) -> Path:
        return models_dir() / "easyocr"

    def _expected_models(self, language: str) -> list[str]:
        recognition = {
            "eng": "english_g2.pth",
            "fas": "arabic.pth",
            "kor": "korean_g2.pth",
            "jpn": "japanese_g2.pth",
            "chi_sim": "zh_sim_g2.pth",
        }
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

    def cancel_install(self) -> None:
        _STANDARD_CANCEL_EVENT.set()

    def unload(self) -> None:
        with self._lock:
            self._readers.clear()

    def uninstall(self) -> int:
        self.cancel_install()
        self.unload()
        freed = 0
        with _INSTALL_LOCK:
            freed += _remove_path_safely(self._model_dir())
            custom_site = models_dir() / "site-packages"
            removed_from_custom_site = False
            if custom_site.is_dir():
                freed += _remove_path_safely(custom_site)
                ensure_custom_site_packages_on_path()
                removed_from_custom_site = True
            try:
                spec = importlib.util.find_spec("easyocr")
                origin = getattr(spec, "origin", None) if spec is not None else None
                if origin and Path(origin).is_file() and not removed_from_custom_site:
                    pkg_dir = Path(origin).parent
                    try:
                        for child in pkg_dir.rglob("*"):
                            if child.is_file() and not child.is_symlink():
                                freed += child.stat().st_size
                    except OSError:
                        pass
                    if subprocess.run is _ORIG_SUBPROCESS_RUN:
                        subprocess.run(
                            [sys.executable, "-m", "pip", "uninstall", "-y", "easyocr"],
                            capture_output=True,
                            text=True,
                            timeout=180,
                            check=False,
                            **_win_subprocess_kwargs(),
                        )
                for mod_name in [m for m in list(sys.modules) if m == "easyocr" or m.startswith("easyocr.")]:
                    sys.modules.pop(mod_name, None)
                importlib.invalidate_caches()
            except Exception:
                pass
            remove_manifest_entry(self.id)
            remove_cached_engine_update(self.id)
            invalidate_engine_runtime_caches()
        trim_process_memory()
        return freed

    def _ensure_runtime(self) -> None:
        if not self.runtime_installed:
            emit("بستهٔ اجرای EasyOCR موجود نیست؛ نصب آگاهانه آغاز می‌شود")
            installed_cuda = False
            if os.name == "nt" and inspect_hardware().get("hasNvidiaGpu") and not importlib.util.find_spec("torch"):
                for cuda_idx in ("https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126"):
                    try:
                        install_packages([
                            "--index-url", cuda_idx,
                            "torch>=2.3.0,<3", "torchvision>=0.18.0,<1",
                        ])
                        install_packages(["easyocr>=1.7,<2"])
                        installed_cuda = True
                        break
                    except OcrError:
                        if _STANDARD_CANCEL_EVENT.is_set():
                            raise
                        installed_cuda = False
            if not installed_cuda:
                install_packages(["easyocr>=1.7,<2", "torch>=2.2,<3"])
        if not self.runtime_installed:
            raise OcrError("EasyOCR was installed but cannot be imported. Restart the application and try again.")

    def _download_easyocr_models_from_mirrors(self, language: str) -> None:
        import zipfile

        root = self._model_dir()
        root.mkdir(parents=True, exist_ok=True)
        zip_map = {
            "craft_mlt_25k.pth": "craft_mlt_25k.zip",
            "english_g2.pth": "english_g2.zip",
            "arabic.pth": "arabic.zip",
            "korean_g2.pth": "korean_g2.zip",
            "japanese_g2.pth": "japanese_g2.zip",
            "zh_sim_g2.pth": "zh_sim_g2.zip",
        }
        for pth_name in self._expected_models(language):
            target_pth = root / pth_name
            if target_pth.is_file() and target_pth.stat().st_size >= 100_000:
                continue
            zip_name = zip_map.get(pth_name)
            if not zip_name:
                continue
            tmp_zip = root / f".{zip_name}.dl"
            urls = [
                (f"https://huggingface.co/xiaoyao9184/easyocr/resolve/main/{pth_name}", {}),
                (f"https://hf-mirror.com/xiaoyao9184/easyocr/resolve/main/{pth_name}", {}),
                (f"https://github.com/JaidedAI/EasyOCR/releases/download/pre-v1.1.6/{zip_name}", {}),
            ]
            last_err: Exception | None = None
            for url, hdrs in urls:
                try:
                    if url.endswith(".zip"):
                        _stream_download_with_mirrors([(url, hdrs)], tmp_zip, label=f"EasyOCR ({pth_name})", min_bytes=50_000)
                        with zipfile.ZipFile(tmp_zip) as zf:
                            for member in zf.namelist():
                                if Path(member).name == pth_name:
                                    part_pth = root / f".{pth_name}.part"
                                    with zf.open(member) as src, part_pth.open("wb") as dst:
                                        shutil.copyfileobj(src, dst)
                                    os.replace(part_pth, target_pth)
                                    break
                        tmp_zip.unlink(missing_ok=True)
                    else:
                        _stream_download_with_mirrors([(url, hdrs)], target_pth, label=f"EasyOCR ({pth_name})", min_bytes=100_000)
                    if target_pth.is_file() and target_pth.stat().st_size >= 100_000:
                        last_err = None
                        break
                except OcrError as oe:
                    tmp_zip.unlink(missing_ok=True)
                    if _STANDARD_CANCEL_EVENT.is_set():
                        raise
                    last_err = oe
                except Exception as exc:
                    tmp_zip.unlink(missing_ok=True)
                    last_err = exc
            if last_err is not None and not target_pth.is_file():
                raise OcrError(f"Could not download EasyOCR model {pth_name}: {last_err}") from last_err

    def _reader(self, language: str, download: bool):
        if not self.runtime_installed:
            raise OcrError("EasyOCR is not installed. Click the explicit preparation button to install it.")
        if not download:
            missing = [name for name in self._expected_models(language) if not (self._model_dir() / name).is_file()]
            if missing and not (self._model_dir() / f".ready-{language}").is_file():
                raise OcrError("EasyOCR model for this language is not ready. Click the explicit preparation button first.")
        lang = {"eng": "en", "fas": "fa", "kor": "ko", "jpn": "ja", "chi_sim": "ch_sim"}.get(language, "en")
        reader_langs = ["fa", "en"] if lang == "fa" else [lang]
        with self._lock:
            if lang not in self._readers:
                emit(f"بارگذاری یا دانلود مدل EasyOCR برای {language} آغاز شد")
                if download:
                    # Clean any leftover temp.zip from an interrupted earlier urlretrieve
                    with contextlib.suppress(OSError):
                        (self._model_dir() / "temp.zip").unlink(missing_ok=True)
                import easyocr
                use_gpu = False
                try:
                    import torch
                    try:
                        torch.set_num_threads(cpu_core_count())
                    except Exception:
                        pass
                    use_gpu = bool(
                        not self._force_cpu
                        and (
                            (hasattr(torch, "cuda") and torch.cuda.is_available())
                            or (hasattr(torch, "backends") and hasattr(torch.backends, "mps") and torch.backends.mps.is_available())
                        )
                    )
                except Exception:
                    use_gpu = False
                dl_ctx = _widen_download_timeouts() if download else contextlib.nullcontext()
                with dl_ctx:
                    try:
                        self._readers[lang] = easyocr.Reader(
                            reader_langs, gpu=use_gpu, model_storage_directory=str(self._model_dir()),
                            download_enabled=download, verbose=False,
                        )
                        self._using_gpu = use_gpu
                    except Exception as exc:
                        init_err: Exception = exc
                        if use_gpu:
                            try:
                                self._readers[lang] = easyocr.Reader(
                                    reader_langs, gpu=False, model_storage_directory=str(self._model_dir()),
                                    download_enabled=download, verbose=False,
                                )
                                self._using_gpu = False
                                return self._readers[lang]
                            except Exception as cpu_exc:
                                init_err = cpu_exc
                        missing_after = [name for name in self._expected_models(language) if not (self._model_dir() / name).is_file()]
                        if download and missing_after:
                            try:
                                self._download_easyocr_models_from_mirrors(language)
                                self._readers[lang] = easyocr.Reader(
                                    reader_langs, gpu=False, model_storage_directory=str(self._model_dir()),
                                    download_enabled=False, verbose=False,
                                )
                                self._using_gpu = False
                                return self._readers[lang]
                            except OcrError:
                                raise
                            except Exception as mirror_exc:
                                raise OcrError(f"Could not initialize EasyOCR: {mirror_exc}") from mirror_exc
                        raise OcrError(f"Could not initialize EasyOCR: {init_err}") from init_err
        return self._readers[lang]

    def download(self, language: str = "eng") -> None:
        _STANDARD_CANCEL_EVENT.clear()
        had_runtime = self.runtime_installed
        dl_est = compute_engine_download_estimate(
            self.id,
            runtime_installed=had_runtime,
            model_ready=self.model_ready,
        )
        dl_label = format_download_size_fa(dl_est["totalDownloadGb"])
        emit(f"شروع آماده‌سازی مدل EasyOCR ({language} — کل حجم دانلود: {dl_label})…", progress=0.05)
        self._ensure_runtime()
        try:
            if _STANDARD_CANCEL_EVENT.is_set():
                raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
            wt_start_p = 0.12 if had_runtime else 0.70
            emit(f"آماده‌سازی EasyOCR برای {language}؛ فقط مدل همین زبان دریافت می‌شود", progress=wt_start_p)
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
        _STANDARD_CANCEL_EVENT.clear()
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
        rgb = _to_white_backed_rgb(image) if getattr(image, "mode", "RGB") != "RGB" else image
        try:
            arr = np.asarray(rgb)
        finally:
            if rgb is not image:
                rgb.close()
        reader = self._reader(language, False)
        batch_sz = 8 if self._using_gpu else 4
        grad_ctx: Any = contextlib.nullcontext
        try:
            import torch
            grad_ctx = torch.inference_mode if hasattr(torch, "inference_mode") else torch.no_grad
        except Exception:
            pass
        extra_fa_kwargs: dict[str, Any] = (
            {"add_margin": 0.18, "width_ths": 0.75, "text_threshold": 0.6, "low_text": 0.32}
            if language == "fas"
            else {}
        )
        try:
            with self._infer_lock, grad_ctx():
                try:
                    result = reader.readtext(arr, detail=1, paragraph=False, batch_size=batch_sz, **extra_fa_kwargs)
                except TypeError:
                    try:
                        result = reader.readtext(arr, detail=1, paragraph=False, batch_size=batch_sz)
                    except TypeError:
                        result = reader.readtext(arr, detail=1, paragraph=False)
        except Exception as exc:
            if self._using_gpu and not self._force_cpu:
                self._force_cpu = True
                self._using_gpu = False
                self.unload()
                cpu_reader = self._reader(language, False)
                try:
                    with self._infer_lock, grad_ctx():
                        try:
                            result = cpu_reader.readtext(arr, detail=1, paragraph=False, batch_size=4, **extra_fa_kwargs)
                        except TypeError:
                            try:
                                result = cpu_reader.readtext(arr, detail=1, paragraph=False, batch_size=4)
                            except TypeError:
                                result = cpu_reader.readtext(arr, detail=1, paragraph=False)
                except Exception as cpu_exc:
                    raise OcrError(f"EasyOCR failed: {cpu_exc}") from cpu_exc
            else:
                raise OcrError(f"EasyOCR failed: {exc}") from exc
        finally:
            del arr
        lines = []
        for box, text, score in result:
            cleaned = normalize_persian_ocr_text(str(text)) if language == "fas" else str(text).strip()
            if cleaned:
                lines.append(OcrLine(cleaned, float(score), _polygon(box)))
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


def _lines_from_tesseract(payload: str, language: str = "eng") -> list[OcrLine]:
    """Turn Tesseract TSV words into physical lines and bounding boxes."""
    groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
    reader = csv.DictReader(
        io.StringIO(payload),
        delimiter="\t",
        quoting=csv.QUOTE_NONE,
        restkey="_extra",
    )
    for row in reader:
        raw_text = row.get("text") or ""
        extra = row.get("_extra")
        if isinstance(extra, list) and extra:
            raw_text = "\t".join([raw_text, *(str(part) for part in extra)])
        if row.get("level") != "5" or not raw_text.strip():
            continue
        row["text"] = raw_text
        key = tuple(str(row.get(k, "")) for k in ("page_num", "block_num", "par_num", "line_num"))
        groups.setdefault(key, []).append(row)
    lines = []
    is_persian = language == "fas"
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
        ordered_words = words
        if is_persian and len(words) >= 2:
            # If Tesseract emitted Persian words in visual left-to-right coordinate order, sort right-to-left.
            first_cx = boxes[0][0] + boxes[0][2] * 0.5
            last_cx = boxes[-1][0] + boxes[-1][2] * 0.5
            has_rtl_chars = any(
                "\u0600" <= ch <= "\u06ff" or "\ufb50" <= ch <= "\ufefc"
                for row in words for ch in (row.get("text") or "")
            )
            if has_rtl_chars and first_cx + 4.0 < last_cx:
                paired = sorted(zip(boxes, words), key=lambda pair: -(pair[0][0] + pair[0][2]))
                ordered_words = [w for _, w in paired]
        text = " ".join((row.get("text") or "").strip() for row in ordered_words).strip()
        if is_persian and text:
            text = normalize_persian_ocr_text(text)
        if text:
            lines.append(OcrLine(text, confidence, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]))
    return lines


class TesseractEngine:
    id = "tesseract"

    def __init__(self) -> None:
        self._system_languages: set[str] | None = None
        self._system_languages_exe: str | None = None
        self._lock = threading.Lock()
        self._omp_threads_var: contextvars.ContextVar[int | None] = contextvars.ContextVar(
            f"tesseract_omp_threads_{id(self)}", default=None,
        )

    @property
    def _omp_threads(self) -> int | None:
        return self._omp_threads_var.get()

    @_omp_threads.setter
    def _omp_threads(self, value: int | None) -> None:
        self._omp_threads_var.set(value)

    @contextlib.contextmanager
    def configure_batch(self, total_pages: int, threads_per_worker: int | None = None):
        if threads_per_worker is None:
            workers, computed_threads = compute_worker_count(total_pages, per_worker_mb=180, max_cap=8)
        else:
            workers = max(1, int(total_pages))
            computed_threads = int(threads_per_worker)
        token = self._omp_threads_var.set(max(1, min(4, int(computed_threads))))
        try:
            yield workers
        finally:
            self._omp_threads_var.reset(token)

    @property
    def runtime_installed(self) -> bool:
        return bool(_tesseract_executable())

    def _model_dir(self) -> Path:
        return models_dir() / "tesseract"

    def _ensure_tsv_config(self) -> None:
        configs_dir = self._model_dir() / "configs"
        tsv_cfg = configs_dir / "tsv"
        if not tsv_cfg.is_file():
            try:
                configs_dir.mkdir(parents=True, exist_ok=True)
                tsv_cfg.write_text("tessedit_create_tsv 1\n", encoding="utf-8")
            except OSError:
                pass

    def _expected_models(self, language: str) -> list[str]:
        return [f"{language}.traineddata"]

    def _get_system_languages(self) -> set[str]:
        if self._system_languages is not None and self._system_languages_exe is None:
            return self._system_languages
        executable = _tesseract_executable()
        if not executable:
            return set()
        if self._system_languages is not None and self._system_languages_exe == executable:
            return self._system_languages
        try:
            result = subprocess.run([executable, "--list-langs"], capture_output=True, text=True, timeout=30, check=False, **_win_subprocess_kwargs())
            if result.returncode == 0:
                self._system_languages = {line.strip() for line in result.stdout.splitlines()[1:] if line.strip()}
            else:
                self._system_languages = set()
        except Exception:
            self._system_languages = set()
        self._system_languages_exe = executable
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

    def cancel_install(self) -> None:
        _STANDARD_CANCEL_EVENT.set()

    def unload(self) -> None:
        # Tesseract runs out-of-process per page and holds no resident model weights in RAM;
        # keep cached _system_languages so status checks do not respawn `tesseract --list-langs`.
        return None

    def uninstall(self) -> int:
        self.cancel_install()
        self.unload()
        with _INSTALL_LOCK:
            freed = 0
            freed += _remove_path_safely(self._model_dir())
            freed += _remove_path_safely(models_dir() / "tesseract-bin")
            freed += _remove_path_safely(models_dir() / "tesseract-bin.old-ver")
            self._system_languages = None
            self._system_languages_exe = None
            remove_manifest_entry(self.id)
            remove_cached_engine_update(self.id)
            invalidate_engine_runtime_caches(clear_portable_tess=True)
        trim_process_memory()
        return freed

    def _download_language_file(self, language: str) -> Path:
        if language not in LANGUAGES:
            raise OcrError(f"Unsupported Tesseract language: {language}")
        if _STANDARD_CANCEL_EVENT.is_set():
            raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
        self._model_dir().mkdir(parents=True, exist_ok=True)
        sources: list[tuple[str, dict[str, str]]] = [
            (f"https://github.com/tesseract-ocr/tessdata_fast/raw/main/{language}.traineddata", {}),
            (
                f"https://api.github.com/repos/tesseract-ocr/tessdata_fast/contents/{language}.traineddata",
                {"Accept": "application/vnd.github.raw"},
            ),
            (f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{language}.traineddata", {}),
            (f"https://hf-mirror.com/datasets/tesseract-ocr/tessdata_fast/resolve/main/{language}.traineddata", {}),
            (f"https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main/{language}.traineddata", {}),
        ]
        temporary = self._model_dir() / f".{language}.traineddata.part"
        target = self._model_dir() / f"{language}.traineddata"
        emit(f"دانلود فایل زبان Tesseract ({language}) از منبع رسمی آغاز شد", progress=0.20)
        last_exc: Exception | None = None
        for attempt_idx, (url, extra_headers) in enumerate(sources):
            if _STANDARD_CANCEL_EVENT.is_set():
                temporary.unlink(missing_ok=True)
                raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
            if attempt_idx > 0:
                emit(f"ادامهٔ دانلود فایل زبان Tesseract ({language}) از میرور جایگزین…", "warning", progress=0.22)
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "Comic-OCR-Studio", **extra_headers})
                with urllib.request.urlopen(request, timeout=180) as response, temporary.open("wb") as output:
                    hdrs = getattr(response, "headers", None)
                    raw_len = hdrs.get("Content-Length") if hdrs and hasattr(hdrs, "get") else None
                    expected_bytes = int(raw_len) if raw_len and str(raw_len).isdigit() else 12 * 1024 * 1024
                    total = 0
                    while True:
                        if _STANDARD_CANCEL_EVENT.is_set():
                            raise OcrError("عملیات آماده‌سازی مدل لغو شد.")
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
                self._ensure_tsv_config()
                emit(f"فایل زبان Tesseract ({language}) ذخیره شد", "success", progress=0.94)
                return target
            except OcrError:
                temporary.unlink(missing_ok=True)
                raise
            except Exception as exc:
                temporary.unlink(missing_ok=True)
                last_exc = exc
                continue
        raise OcrError(
            f"Tesseract language download failed for {language}: {last_exc}. The official tessdata_fast host must be reachable."
        ) from last_exc

    def download(self, language: str = "eng") -> None:
        if language not in LANGUAGES:
            raise OcrError(f"Unsupported Tesseract language: {language}")
        _STANDARD_CANCEL_EVENT.clear()
        dl_est = compute_engine_download_estimate(
            self.id,
            runtime_installed=self.runtime_installed,
            model_ready=self.model_ready,
        )
        dl_label = format_download_size_fa(dl_est["totalDownloadGb"])
        emit(f"شروع آماده‌سازی Tesseract ({language} — کل حجم دانلود: {dl_label})…", progress=0.06)
        if not self.runtime_installed:
            _call_install_tesseract_runtime()
            self._system_languages = None
            self._system_languages_exe = None
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
        _STANDARD_CANCEL_EVENT.clear()
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
                    _call_install_tesseract_runtime()
                    self._system_languages = None
                    self._system_languages_exe = None
                else:
                    emit(f"فایل اجرایی Tesseract ({cur_ver or 'نصب‌شده'}) در آخرین نسخه است…", progress=0.45)
            elif not self.runtime_installed:
                _call_install_tesseract_runtime()
                self._system_languages = None
                self._system_languages_exe = None
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
        buffer = io.BytesIO()
        rgb = _to_white_backed_rgb(image)
        try:
            rgb.save(buffer, "PNG", dpi=(300, 300), compress_level=1)
        finally:
            if rgb is not image:
                rgb.close()
        command = [
            executable, "stdin", "stdout",
            "-l", language,
            "--psm", psm,
            "--dpi", "300",
            "-c", "tessedit_create_tsv=1",
        ]
        if language == "fas":
            command.extend(["--oem", "1", "-c", "preserve_interword_spaces=1"])
        local_traineddata = (self._model_dir() / f"{language}.traineddata").is_file()
        if local_traineddata:
            self._ensure_tsv_config()
            command.extend(["--tessdata-dir", str(self._model_dir())])
        command.append("tsv")
        tess_env = dict(os.environ)
        if local_traineddata:
            tess_env["TESSDATA_PREFIX"] = str(self._model_dir())
        omp_limit = self._omp_threads if self._omp_threads is not None else min(4, cpu_core_count())
        tess_env["OMP_THREAD_LIMIT"] = str(max(1, omp_limit))
        try:
            result = subprocess.run(command, input=buffer.getvalue(), env=tess_env, capture_output=True, timeout=180, check=False, **_win_subprocess_kwargs())
        except Exception as exc:
            raise OcrError(f"Tesseract failed: {exc}") from exc
        if result.returncode:
            details = (result.stderr or result.stdout or b"Tesseract failed")[-1800:]
            raise OcrError(f"Tesseract failed: {details.decode('utf-8', 'replace') if isinstance(details, bytes) else details}")
        return _lines_from_tesseract(
            result.stdout.decode("utf-8", "replace") if isinstance(result.stdout, bytes) else result.stdout,
            language=language,
        )

    def recognize(self, image: Image.Image, language: str) -> list[OcrLine]:
        if language == "fas":
            # Tesseract's sparse-text mode (--psm 11) drops or shatters cursive RTL Persian lines;
            # use block/line segmentation (--psm 6 / 7) on crops and RTL page segmentation (--psm 3) on pages.
            is_crop = image.height < 260 or image.width < 520
            primary_psm = "6" if is_crop else "3"
            lines = self._recognize_with_psm(image, language, primary_psm)
            if lines:
                return lines
            fallback_psms = ("7", "11") if (image.height < 110 and image.width > image.height * 2) else ("6", "11")
            for alt_psm in fallback_psms:
                if alt_psm == primary_psm:
                    continue
                lines = self._recognize_with_psm(image, language, alt_psm)
                if lines:
                    return lines
            return []
        return self._recognize_with_psm(image, language, "11")

    def recognize_document(self, image: Image.Image, language: str) -> list[OcrLine]:
        lines = self._recognize_with_psm(image, language, "3")
        if not lines and language == "fas":
            return self._recognize_with_psm(image, language, "6")
        return lines

    def recognize_bubble(self, image: Image.Image, language: str) -> list[OcrLine]:
        lines = self._recognize_with_psm(image, language, "6")
        if not lines and language == "fas" and image.height < 120:
            return self._recognize_with_psm(image, language, "7")
        return lines


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
    *,
    languages: list[str] | None = None,
) -> dict[str, Any]:
    spec = ISOLATED_ENGINE_SPECS[engine_id]
    return {
        "name": name,
        "family": family,
        "description": description,
        "languages": list(languages) if languages is not None else ["eng", "kor", "jpn", "chi_sim"],
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
            "reason": "سبک و چندزبانه (شامل کره‌ای و فارسی)، اما روی فونت‌های ریز و متراکم کتاب متوسط است.",
        },
        "auto": {
            "tier": "medium",
            "reason": "گزینهٔ سبک چندزبانه؛ در انگلیسی دقت PP-OCRv6 و مدل‌های چیدمان بالاتر است.",
        },
    },
    "easyocr": {
        "comic": {
            "tier": "best",
            "reason": "تشخیص بسیار خوب حروف و حباب‌های منحنی یا پراکندهٔ کمیک در زبان‌های مختلف (شامل فارسی).",
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
    "hezar-ocr": {
        "comic": {
            "tier": "weak",
            "reason": "مدل بومی تخصصی زبان فارسی است؛ برای زبان فارسی در هر دو حالت کمیک و کتاب عالی (سبز) است اما برای انگلیسی و سایر زبان‌ها کاربرد ندارد.",
        },
        "document": {
            "tier": "weak",
            "reason": "مدل بومی تخصصی زبان فارسی است؛ زبان را روی «فارسی» قرار دهید تا با بالاترین دقت اجرا شود.",
        },
        "auto": {
            "tier": "weak",
            "reason": "مخصوص متون فارسی (CRAFT + CRNN-fa-v2)؛ فقط برای زبان فارسی طراحی شده است.",
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
            "reason": "مدل بینایی دقیق برای خواندن فونت‌های خاص داخل حباب‌های برش‌خوردهٔ کمیک انگلیسی و چینی.",
        },
        "document": {
            "tier": "medium",
            "reason": "متن پاراگراف‌ها را خوب می‌خواند اما تحلیل مستقیم ستون‌بندی کل صفحه را ندارد و کندتر از Surya است.",
        },
        "auto": {
            "tier": "medium",
            "reason": "دقت خوب روی برش‌های متنی کمیک و پاراگراف‌های کوتاه انگلیسی و چینی.",
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


# Language × Page-Mode suitability overrides on top of ENGINE_SUITABILITY (which acts as the English baseline).
_LANGUAGE_SUITABILITY_OVERRIDES: dict[str, dict[str, dict[str, dict[str, str]]]] = {
    "fas": {
        "hezar-ocr": {
            "comic": {
                "tier": "best",
                "reason": "مدل بومی آموزش‌دیده روی فونت‌های فارسی؛ عالی و سبک برای حباب‌های کمیک و متون فارسی روی CPU و GPU.",
            },
            "document": {
                "tier": "best",
                "reason": "تشخیص بسیار دقیق حروف و کلمات چاپی فارسی (فونت‌های وزیر، نازنین، میترا، یکان و کتاب) با مصرف کم حافظه.",
            },
            "auto": {
                "tier": "best",
                "reason": "بهترین انتخاب تخصصی و سبک برای صفحات فارسی (هم کمیک و هم کتاب و جزوه).",
            },
        },
        "rapidocr-v6": {
            "comic": {"tier": "weak", "reason": "این مدل از الفبای فارسی پشتیبانی نمی‌کند (فقط انگلیسی، چینی و ژاپنی)."},
            "document": {"tier": "weak", "reason": "این مدل از الفبای فارسی پشتیبانی نمی‌کند (فقط انگلیسی، چینی و ژاپنی)."},
            "auto": {"tier": "weak", "reason": "عدم پشتیبانی از زبان فارسی؛ از Hezar، Tesseract، EasyOCR یا Surya استفاده کنید."},
        },
        "rapidocr-v5": {
            "comic": {
                "tier": "medium",
                "reason": "حروف فارسی (شامل پ، چ، ژ، گ، ک، ی) را سریع می‌خواند، ولی مدل مشترک عربی‌ـ‌فارسی آن روی فونت فانتزی کمیک دقت متوسط دارد؛ Hezar و EasyOCR دقیق‌ترند.",
            },
            "document": {
                "tier": "medium",
                "reason": "سبک و سریع برای متون سادهٔ فارسی، اما در کتاب‌ها و مقالات متراکم فارسی دقت Hezar، Tesseract و Surya بالاتر است.",
            },
            "auto": {
                "tier": "medium",
                "reason": "گزینهٔ سبک کمکی برای فارسی روی سیستم‌های ضعیف؛ برای دقت بالاتر Hezar یا Tesseract پیشنهاد می‌شود.",
            },
        },
        "easyocr": {
            "comic": {
                "tier": "best",
                "reason": "پشتیبانی بومی هم‌زمان از فارسی و انگلیسی؛ بسیار مناسب دیالوگ‌های کمیک و کلمات پراکندهٔ فارسی.",
            },
            "document": {
                "tier": "weak",
                "reason": "در صفحات پُرمتن کتاب فارسی کند است، ستون‌بندی ندارد و گاهی اتصال حروف ریز پاراگراف‌ها را اشتباه می‌گیرد.",
            },
            "auto": {
                "tier": "medium",
                "reason": "عالی برای حباب‌های کمیک فارسی، اما برای کتاب و مقالهٔ متراکم فارسی مناسب نیست.",
            },
        },
        "tesseract": {
            "comic": {
                "tier": "weak",
                "reason": "مخصوص سطرهای صاف چاپی است و روی حباب‌های منحنی، پس‌زمینهٔ رنگی و فونت‌های فانتزی کمیک فارسی ضعیف عمل می‌کند.",
            },
            "document": {
                "tier": "best",
                "reason": "فایل رسمی fas.traineddata روی کتاب‌ها، مقالات و جزوه‌های چاپی فارسی بسیار سریع، دقیق و کم‌مصرف است.",
            },
            "auto": {
                "tier": "medium",
                "reason": "فوق‌العاده برای کتاب و مقالهٔ چاپی فارسی، ولی روی کمیک فارسی ضعیف است.",
            },
        },
        "surya": {
            "comic": {
                "tier": "medium",
                "reason": "خط فارسی را می‌شناسد اما برای فونت‌های فانتزی حباب کمیک ساخته نشده است.",
            },
            "document": {
                "tier": "best",
                "reason": "پشتیبانی رسمی از فارسی و چیدمان راست‌به‌چپ (RTL)؛ عالی برای مقالات چندستونی، کتاب و جزوه‌های فارسی.",
            },
            "auto": {
                "tier": "best",
                "reason": "تشخیص قدرتمند خط فارسی و ترتیب ستون‌های راست‌به‌چپ در کتاب و اسناد.",
            },
        },
        "paddleocr-vl-1-6": {
            "comic": {
                "tier": "medium",
                "reason": "پشتیبانی رسمی از فارسی در میان ۱۰۹ زبان، اما سنگین‌تر از Hezar و EasyOCR برای کمیک است.",
            },
            "document": {
                "tier": "best",
                "reason": "تشخیص دقیق چیدمان صفحه، تیترها، جداول و پاراگراف‌های فارسی در کتاب و مقاله.",
            },
            "auto": {
                "tier": "best",
                "reason": "مدل چندزبانهٔ قوی برای استخراج ساختاریافتهٔ کتاب و مقالهٔ فارسی.",
            },
        },
        "mineru-2-5-pro": {
            "comic": {"tier": "weak", "reason": "از خط فارسی و صفحات کمیک پشتیبانی نمی‌کند."},
            "document": {"tier": "weak", "reason": "موتور OCR پیش‌فرض MinerU برای انگلیسی و چینی بهینه شده و از خط فارسی پشتیبانی مستقیم ندارد."},
            "auto": {"tier": "weak", "reason": "عدم پشتیبانی مستقیم از خط فارسی؛ برای کتاب فارسی از Hezar، Tesseract یا Surya استفاده کنید."},
        },
        "got-ocr-2": {
            "comic": {"tier": "weak", "reason": "فقط روی انگلیسی و چینی آموزش دیده و قادر به خواندن خط فارسی نیست."},
            "document": {"tier": "weak", "reason": "فقط روی انگلیسی و چینی آموزش دیده و قادر به خواندن خط فارسی نیست."},
            "auto": {"tier": "weak", "reason": "عدم پشتیبانی از الفبای فارسی."},
        },
        "glm-ocr": {
            "comic": {
                "tier": "medium",
                "reason": "مدل چندزبانه است و فارسی را تا حدی می‌خواند، اما روی فونت‌های کمیک فارسی به دقت Hezar و EasyOCR نمی‌رسد.",
            },
            "document": {
                "tier": "medium",
                "reason": "خوانش قابل‌قبول متن فارسی، ولی کندتر و کم‌دقت‌تر از Hezar، Surya و Tesseract روی کتاب فارسی است.",
            },
            "auto": {
                "tier": "medium",
                "reason": "عملکرد متوسط روی متن فارسی در مقایسه با موتورهای تخصصی فارسی.",
            },
        },
        "dots-ocr": {
            "comic": {
                "tier": "medium",
                "reason": "از فارسی پشتیبانی می‌کند اما نیازمند GPU قوی است و تمرکز آن روی اسناد است.",
            },
            "document": {
                "tier": "best",
                "reason": "مدل ۱۰۰ زبانه با تشخیص هم‌زمان کادر و متن فارسی در کتاب و مقاله (نیازمند NVIDIA GPU ≥ 8GB).",
            },
            "auto": {
                "tier": "medium",
                "reason": "دقیق برای اسناد فارسی روی سیستم‌های دارای کارت گرافیک NVIDIA.",
            },
        },
        "deepseek-ocr-2": {
            "comic": {
                "tier": "weak",
                "reason": "بسیار سنگین (نیازمند GPU ≥ 12GB) و برای حباب‌های کمیک فارسی بهینه نشده است.",
            },
            "document": {
                "tier": "medium",
                "reason": "از خط فارسی پشتیبانی می‌کند اما بیشترین دقت آن روی اسناد انگلیسی و چینی است و به GPU قوی نیاز دارد.",
            },
            "auto": {
                "tier": "weak",
                "reason": "برای متن فارسی گزینه‌های سبک‌تر و دقیق‌تری مثل Hezar، Surya و Tesseract وجود دارد.",
            },
        },
        "olmocr": {
            "comic": {
                "tier": "weak",
                "reason": "مخصوص مقالات PDF است و برای کمیک فارسی کاربردی ندارد.",
            },
            "document": {
                "tier": "medium",
                "reason": "هستهٔ Qwen2.5-VL آن متن چاپی فارسی را می‌خواند، ولی عمدتاً روی مقالات انگلیسی تنظیم شده و نیازمند GPU ≥ 16GB است.",
            },
            "auto": {
                "tier": "weak",
                "reason": "مدل بسیار سنگین ویژهٔ اسناد روی GPU قوی؛ برای فارسی اولویت با Hezar و Surya است.",
            },
        },
    },
    "kor": {
        "rapidocr-v6": {
            "comic": {"tier": "weak", "reason": "مدل PP-OCRv6 Small از زبان کره‌ای پشتیبانی نمی‌کند؛ از PP-OCRv5، EasyOCR یا GLM-OCR استفاده کنید."},
            "document": {"tier": "weak", "reason": "مدل PP-OCRv6 Small از زبان کره‌ای پشتیبانی نمی‌کند."},
            "auto": {"tier": "weak", "reason": "عدم پشتیبانی از زبان کره‌ای (فقط انگلیسی، چینی و ژاپنی)."},
        },
        "rapidocr-v5": {
            "comic": {
                "tier": "best",
                "reason": "دارای مدل اختصاصی کره‌ای (korean_PP-OCRv5)؛ سریع‌ترین و دقیق‌ترین موتور سبک برای مانهوا و وبتون کره‌ای.",
            },
            "document": {
                "tier": "best",
                "reason": "تشخیص دقیق و سبک خط هانگول کره‌ای روی CPU و GPU برای جزوه و کتاب کره‌ای.",
            },
            "auto": {
                "tier": "best",
                "reason": "بهترین انتخاب سریع و سبک برای تمام صفحات کره‌ای روی هر سیستمی.",
            },
        },
        "tesseract": {
            "comic": {"tier": "weak", "reason": "روی فونت‌های وبتون و مانهوای کره‌ای و پس‌زمینهٔ رنگی عملکرد ضعیفی دارد."},
            "document": {
                "tier": "medium",
                "reason": "متن چاپی کره‌ای را می‌خواند اما در تشخیص فاصلهٔ بین هجاهای هانگول ضعیف‌تر از Surya، PaddleOCR-VL و PP-OCRv5 است.",
            },
            "auto": {"tier": "weak", "reason": "برای زبان کره‌ای موتورهای PP-OCRv5، EasyOCR و Surya بسیار دقیق‌ترند."},
        },
        "got-ocr-2": {
            "comic": {"tier": "weak", "reason": "این مدل فقط روی انگلیسی و چینی آموزش دیده و حروف هانگول کره‌ای را به‌خوبی نمی‌شناسد."},
            "document": {"tier": "weak", "reason": "این مدل فقط روی انگلیسی و چینی آموزش دیده و برای متون کره‌ای مناسب نیست."},
            "auto": {"tier": "weak", "reason": "فاقد آموزش کافی روی خط کره‌ای."},
        },
        "olmocr": {
            "comic": {"tier": "weak", "reason": "برای مانهوا و کمیک کره‌ای نامناسب و بسیار سنگین است."},
            "document": {"tier": "medium", "reason": "عمدتاً روی مقالات انگلیسی آموزش دیده؛ برای اسناد کره‌ای Surya و PaddleOCR-VL دقیق‌ترند."},
            "auto": {"tier": "weak", "reason": "سنگین و غیربهینه برای متون کره‌ای."},
        },
    },
    "jpn": {
        "rapidocr-v5": {
            "comic": {
                "tier": "medium",
                "reason": "در نسخهٔ v5 از مدل مشترک چینی برای ژاپنی استفاده می‌شود؛ برای مانگای ژاپنی PP-OCRv6، EasyOCR یا GLM-OCR دقیق‌ترند.",
            },
            "document": {
                "tier": "medium",
                "reason": "برخی حروف هیراگانا و کاتاکانای ریز را با کانجی اشتباه می‌گیرد؛ از Surya، PaddleOCR-VL یا PP-OCRv6 استفاده کنید.",
            },
            "auto": {"tier": "medium", "reason": "عملکرد متوسط در ژاپنی؛ PP-OCRv6 مدل اختصاصی ژاپنی بهتری دارد."},
        },
        "tesseract": {
            "comic": {"tier": "weak", "reason": "روی مانگای ژاپنی، متن‌های عمودی و حباب‌های منحنی عملکرد ضعیفی دارد."},
            "document": {
                "tier": "medium",
                "reason": "متن افقی کتاب ژاپنی را می‌خواند اما در متون عمودی و فوریگانا ضعیف‌تر از PaddleOCR-VL، Surya و MinerU است.",
            },
            "auto": {"tier": "weak", "reason": "برای مانگا و کتاب ژاپنی مدل‌های PP-OCRv6، EasyOCR و PaddleOCR-VL توصیه می‌شوند."},
        },
        "got-ocr-2": {
            "comic": {"tier": "weak", "reason": "عمدتاً روی انگلیسی و چینی آموزش دیده و حروف هیراگانا/کاتاکانای مانگا را ناقص می‌خواند."},
            "document": {"tier": "weak", "reason": "برای مقالات و کتاب‌های ژاپنی دقت کافی روی حروف کانا ندارد."},
            "auto": {"tier": "weak", "reason": "برای ژاپنی مناسب نیست؛ از PP-OCRv6 یا GLM-OCR استفاده کنید."},
        },
        "olmocr": {
            "comic": {"tier": "weak", "reason": "مخصوص مقالات علمی انگلیسی است و برای مانگای ژاپنی نامناسب است."},
            "document": {"tier": "medium", "reason": "روی متون ژاپنی دقت کمتری نسبت به PaddleOCR-VL، MinerU و Surya دارد و نیازمند GPU سنگین است."},
            "auto": {"tier": "weak", "reason": "سنگین و غیرتخصصی برای ژاپنی."},
        },
    },
    "chi_sim": {
        "tesseract": {
            "comic": {"tier": "weak", "reason": "روی مانهوای چینی و فونت‌های گرافیکی حباب‌ها عملکرد ضعیفی دارد."},
            "document": {
                "tier": "medium",
                "reason": "در تشخیص نویسه‌های متراکم چینی ضعیف‌تر از موتورهای بومی چینی (PP-OCRv6، PaddleOCR-VL، MinerU و DeepSeek) است.",
            },
            "auto": {"tier": "weak", "reason": "برای زبان چینی، موتورهای خانوادهٔ PP-OCR، GOT-OCR و GLM-OCR بسیار دقیق‌ترند."},
        },
        "got-ocr-2": {
            "comic": {
                "tier": "best",
                "reason": "آموزش‌دیده به‌طور تخصصی روی چینی و انگلیسی؛ فوق‌العاده دقیق برای مانهوا و کمیک چینی.",
            },
            "document": {
                "tier": "best",
                "reason": "تشخیص بسیار دقیق نویسه‌های چاپی چینی و انگلیسی در پاراگراف‌ها و جداول.",
            },
            "auto": {
                "tier": "best",
                "reason": "عملکرد عالی روی هر دو حالت کمیک و کتاب به زبان چینی.",
            },
        },
        "glm-ocr": {
            "comic": {
                "tier": "best",
                "reason": "مدل بومی چینی‌ـ‌انگلیسی با دقت عالی روی دیالوگ‌ها و فونت‌های دشوار مانهوا.",
            },
            "document": {
                "tier": "best",
                "reason": "عملکرد بسیار دقیق در خواندن متون چاپی و علمی چینی.",
            },
            "auto": {
                "tier": "best",
                "reason": "انتخاب درجهٔ یک برای صفحات چینی در کمیک و کتاب.",
            },
        },
        "rapidocr-v5": {
            "comic": {"tier": "best", "reason": "بسیار سریع و دقیق برای مانهوا و کمیک چینی روی هر سیستمی."},
            "document": {"tier": "best", "reason": "مدل پایهٔ چینی PP-OCRv5 با دقت و سرعت بالا روی اسناد و کتاب‌های چینی."},
            "auto": {"tier": "best", "reason": "عملکرد عالی و سبک برای متون چینی."},
        },
        "olmocr": {
            "comic": {"tier": "weak", "reason": "برای مانهوا و کمیک چینی نامناسب و بسیار سنگین است."},
            "document": {"tier": "medium", "reason": "تنظیم‌شده عمدتاً روی مقالات انگلیسی؛ در اسناد چینی MinerU، PaddleOCR-VL و DeepSeek برترند."},
            "auto": {"tier": "weak", "reason": "برای زبان چینی مدل‌های تخصصی بسیار بهتری در برنامه وجود دارد."},
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
        "description": "بستهٔ چندزبانهٔ سبک با مدل اختصاصی کره‌ای و پشتیبانی از انگلیسی، فارسی، کره‌ای، ژاپنی و چینی.",
        "languages": ["eng", "fas", "kor", "jpn", "chi_sim"],
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
        "description": "موتور مستقل و دقیق با پشتیبانی بومی از هر پنج زبان برنامه (شامل فارسی و انگلیسی هم‌زمان).",
        "languages": ["eng", "fas", "kor", "jpn", "chi_sim"],
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
        "description": "موتور متن‌خوان کلاسیک با نصب خودکار و پشتیبانی عالی از کتاب و مقاله در هر پنج زبان (شامل fas.traineddata فارسی).",
        "languages": ["eng", "fas", "kor", "jpn", "chi_sim"],
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
    "hezar-ocr": _isolated_info(
        "hezar-ocr",
        "Hezar Persian OCR",
        "Hezar / CRAFT + CRNN-fa-v2",
        "مدل بومی و تخصصی زبان فارسی (تشخیص CRAFT + خوانش CRNN-fa-v2)؛ آموزش‌دیده مستقیماً روی فونت‌ها و متون چاپی فارسی.",
        "https://github.com/hezarai/hezar",
        "نصب خودکار در محیط جدا؛ بسیار سبک و قابل اجرا روی CPU معمولی و کارت گرافیک (حجم وزن‌ها حدود ۲۵۰ مگابایت).",
        languages=["fas"],
    ),
    "paddleocr-vl-1-6": _isolated_info(
        "paddleocr-vl-1-6",
        "PaddleOCR-VL-1.6",
        "PaddleOCR / VLM",
        "مدل ۱۰۹ زبانهٔ تشخیص چیدمان و متن (شامل فارسی) با نصب خودکار در پوشهٔ ایزوله و خروجی کادربندی‌شده.",
        "https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.md",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و کارت گرافیک NVIDIA (حجم دانلود حدود ۲٫۴ گیگابایت).",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
    "surya": _isolated_info(
        "surya",
        "Surya",
        "Datalab / OCR + Layout",
        "مدل ۹۰+ زبانهٔ تشخیص متن و چیدمان راست‌به‌چپ/چپ‌به‌راست (شامل فارسی) با پیش‌نیازهای خودکار پردازنده یا کارت گرافیک.",
        "https://github.com/datalab-to/surya",
        "نصب خودکار در محیط جدا به همراه موتور کمکی CPU در صورت نبود کارت گرافیک (حجم حدود ۲٫۲ گیگابایت).",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
    "mineru-2-5-pro": _isolated_info(
        "mineru-2-5-pro",
        "MinerU2.5-Pro",
        "MinerU / Document + OCR",
        "موتور ساختاریافتهٔ تشخیص بلوک‌های متن و تصویر برای مقالات انگلیسی و شرق آسیا در محیط مستقل.",
        "https://github.com/opendatalab/MinerU",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و GPU (حجم دانلود حدود ۳ گیگابایت).",
        languages=["eng", "kor", "jpn", "chi_sim"],
    ),
    "got-ocr-2": _isolated_info(
        "got-ocr-2",
        "GOT-OCR 2.0",
        "GOT / Vision-Language OCR",
        "مدل هوش مصنوعی بینایی برای خواندن دقیق متنِ حباب‌های کمیک انگلیسی و چینی در محیط مستقل.",
        "https://github.com/Ucas-HaoranWei/GOT-OCR2.0",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و GPU ولی با کارت گرافیک سریع‌تر است (حدود ۱٫۸ گیگابایت).",
        languages=["eng", "kor", "jpn", "chi_sim"],
    ),
    "glm-ocr": _isolated_info(
        "glm-ocr",
        "GLM-OCR",
        "GLM / Vision-Language OCR",
        "مدل چندوجهی و چندزبانهٔ خواندن متن با تشخیص خودکار نواحی حباب گفتگو و نصب ایزوله.",
        "https://github.com/zai-org/GLM-OCR",
        "نصب خودکار در محیط جدا؛ قابل اجرا روی CPU و کارت گرافیک NVIDIA (حجم حدود ۲٫۴ گیگابایت).",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
    "dots-ocr": _isolated_info(
        "dots-ocr",
        "dots.ocr",
        "dots / Vision-Language OCR",
        "مدل سنگین ۱۰۰ زبانهٔ تشخیص چیدمان و متن (شامل فارسی) با خروجی مختصات کادرها.",
        "https://github.com/rednote-hilab/dots.ocr",
        "مدل سنگین؛ نیازمند کارت گرافیک NVIDIA با حداقل ۸ گیگابایت حافظه و حدود ۴٫۵ گیگابایت دانلود.",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
    "deepseek-ocr-2": _isolated_info(
        "deepseek-ocr-2",
        "DeepSeek-OCR-2",
        "DeepSeek / Vision-Language OCR",
        "مدل بینایی‌ـ‌زبان پیشرفته با قابلیت مکان‌یابی متن روی صفحه در محیط مستقل.",
        "https://github.com/deepseek-ai/DeepSeek-OCR-2",
        "مدل سنگین؛ نیازمند کارت گرافیک NVIDIA با حداقل ۱۲ گیگابایت حافظه و حدود ۷٫۵ گیگابایت دانلود.",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
    "olmocr": _isolated_info(
        "olmocr",
        "olmOCR",
        "AllenAI / 7B VLM OCR",
        "مدل ۷ میلیارد پارامتری خواندن متون چاپی دشوار در محیط کاملاً ایزوله.",
        "https://github.com/allenai/olmocr",
        "مدل بسیار سنگین؛ نیازمند کارت گرافیک NVIDIA با حداقل ۱۶ گیگابایت حافظه و حدود ۱۵ گیگابایت دانلود.",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
    "hunyuan-ocr": _isolated_info(
        "hunyuan-ocr",
        "HunyuanOCR",
        "Tencent Hunyuan / VLM OCR",
        "مدل بزرگ ۱۰۰ زبانهٔ بینایی‌ـ‌زبان برای تشخیص متن با نصب خودکار در محیط ایزوله.",
        "https://github.com/Tencent-Hunyuan/HunyuanOCR",
        "مدل بسیار سنگین؛ نیازمند کارت گرافیک حرفه‌ای NVIDIA با حداقل ۲۴ گیگابایت حافظه و حدود ۲۰ گیگابایت دانلود.",
        languages=["eng", "fas", "kor", "jpn", "chi_sim"],
    ),
}


def resolve_engine_suitability(engine_id: str, page_mode: str = "comic", language: str = "eng") -> dict[str, str]:
    """Return {tier, reason} jointly determined by BOTH OCR language and page/text mode."""
    norm_mode = page_mode if page_mode in {"comic", "document", "auto"} else "comic"
    norm_lang = language if language in LANGUAGES else "eng"
    info = ENGINE_INFO.get(engine_id) or {}
    supported_langs = info.get("languages") or []
    lang_override = (_LANGUAGE_SUITABILITY_OVERRIDES.get(norm_lang) or {}).get(engine_id) or {}
    if norm_mode in lang_override:
        return dict(lang_override[norm_mode])
    if supported_langs and norm_lang not in supported_langs:
        lang_label = LANGUAGES.get(norm_lang, {}).get("name", norm_lang)
        return {
            "tier": "weak",
            "reason": f"این مدل از زبان «{lang_label}» پشتیبانی نمی‌کند؛ موتور دیگری را برای این زبان انتخاب کنید.",
        }
    base = ENGINE_SUITABILITY.get(engine_id) or {}
    if norm_mode in base:
        return dict(base[norm_mode])
    return {"tier": "medium", "reason": "عملکرد عمومی متوسط برای این ترکیب زبان و نوع صفحه."}


ENGINE_SUITABILITY_BY_LANGUAGE: dict[str, dict[str, dict[str, dict[str, str]]]] = {
    _eid: {
        _lang: {
            _mode: resolve_engine_suitability(_eid, _mode, _lang)
            for _mode in ("comic", "document", "auto")
        }
        for _lang in LANGUAGES
    }
    for _eid in ENGINE_INFO
}

for _eng_id, _eng_meta in ENGINE_INFO.items():
    _eng_meta["suitability"] = ENGINE_SUITABILITY.get(_eng_id, {})
    _eng_meta["suitabilityByLanguage"] = ENGINE_SUITABILITY_BY_LANGUAGE.get(_eng_id, {})
    _eng_meta.setdefault("executionMode", "local")
    _eng_meta.setdefault("requiresInternetForOcr", False)
    _eng_meta.setdefault("requiresInternetForSetup", True)


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
            rt_installed = engine.runtime_installed
            m_ready = bool(ready_languages)
            download_fields = compute_engine_download_estimate(
                engine_id,
                runtime_installed=rt_installed,
                model_ready=m_ready,
                nominal_size_gb=float(info.get("downloadSizeGb") or 0.0),
                hw=hw,
            )
            result.append({
                "id": engine_id,
                **info,
                "runtimeInstalled": rt_installed,
                "modelReady": m_ready,
                "readyLanguages": ready_languages,
                "isLoadedInRam": bool(getattr(engine, "is_loaded_in_ram", False)),
                "canUninstall": engine_has_uninstallable_files(engine_id, engine),
                "isBuiltinBase": engine_id == "rapidocr-v6",
                **download_fields,
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

    def cancel_install(self, engine_id: str) -> None:
        try:
            engine = self.get(engine_id)
        except Exception:
            return
        canceller = getattr(engine, "cancel_install", None)
        if callable(canceller):
            canceller()

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

    def uninstall(self, engine_id: str) -> dict[str, Any]:
        engine = self.get(engine_id)
        uninstaller = getattr(engine, "uninstall", None)
        if not callable(uninstaller):
            raise OcrError(f"Engine {engine_id} cannot be uninstalled from within the application.")
        emit(f"آزادسازی حافظهٔ رم و حذف فایل‌های مدل {engine_id} از روی دیسک…", progress=0.25)
        freed_bytes = int(uninstaller() or 0)
        trim_process_memory()
        hw = inspect_hardware(force_refresh=True)
        emit(f"فایل‌های مدل {engine_id} به‌طور کامل حذف شدند.", "success", progress=1.0)
        return {
            "engineId": engine_id,
            "freedBytes": freed_bytes,
            "freedMb": round(freed_bytes / (1024 * 1024), 1),
            "hardware": hw,
        }

    def check_updates(self, force: bool = False) -> dict[str, Any]:
        return check_remote_updates(self, force=force)


PRECISE_UPSCALE_MAX_PIXELS = 4_000_000
DOCUMENT_FALLBACK_SCALE = 2


def _to_white_backed_rgb(image: Image.Image) -> Image.Image:
    """Flatten transparent pixels onto white paper so dark ink never turns black-on-black."""
    oriented = ImageOps.exif_transpose(image)
    if oriented.mode in {"RGBA", "LA"} or (oriented.mode == "P" and "transparency" in oriented.info):
        rgba = oriented.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        composited = Image.alpha_composite(white, rgba).convert("RGB")
        rgba.close()
        white.close()
        if oriented is not image:
            oriented.close()
        return composited
    rgb = oriented.convert("RGB")
    if oriented is not image and oriented is not rgb:
        oriented.close()
    return rgb


PERSIAN_PREPROCESS_BORDER_PAD = 18
_PERSIAN_BIDI_MARKS_RE = re.compile(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
_PERSIAN_CHAR_MAP = str.maketrans({
    "\u064a": "\u06cc",  # Arabic Yeh ي -> Persian Yeh ی
    "\u0649": "\u06cc",  # Alef Maksura ى -> Persian Yeh ی
    "\u0643": "\u06a9",  # Arabic Kaf ك -> Persian Keheh ک
})
_PERSIAN_CONTEXTUAL_COMMA_RE = re.compile(r"(?<=[\u0600-\u06ff])\s*,\s*(?=[\u0600-\u06ff0-9۰-۹])")


def normalize_persian_ocr_text(text: str) -> str:
    """Clean bidi control marks, Arabic presentation forms, and Yeh/Kaf variants while preserving ZWNJ (نیم‌فاصله)."""
    import unicodedata

    if not text:
        return ""
    cleaned_chars: list[str] = []
    for ch in str(text):
        code = ord(ch)
        if (0xFB50 <= code <= 0xFDFF) or (0xFE70 <= code <= 0xFEFC):
            cleaned_chars.append(unicodedata.normalize("NFKC", ch))
        else:
            cleaned_chars.append(ch)
    out = "".join(cleaned_chars)
    out = _PERSIAN_BIDI_MARKS_RE.sub("", out)
    out = out.translate(_PERSIAN_CHAR_MAP)
    out = _PERSIAN_CONTEXTUAL_COMMA_RE.sub("، ", out)
    # Collapse repeated spaces on each line while preserving explicit newlines and ZWNJ (\u200c).
    if "\n" in out:
        return "\n".join(re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in out.splitlines() if ln.strip())
    return re.sub(r"[ \t\r\f\v]+", " ", out).strip()


def persian_preprocess_image(
    image: Image.Image,
    *,
    precise: bool = True,
    page_mode: str = "comic",
    scale_override: float | None = None,
    border_pad: int = PERSIAN_PREPROCESS_BORDER_PAD,
) -> tuple[Image.Image, float, int]:
    """Dot-preserving Persian OCR preprocessing:
    1. Auto-inverts white/light Persian text on dark backgrounds or night caption boxes.
    2. Uses clean rational upscaling (2.0x or 1.5x, width-aware so tall webtoon strips still upscale)
       BEFORE spatial filtering so tiny 1.5px Persian dots (نقطه) are never erased as speckle noise.
    3. Preserves natural anti-aliasing on clean uniform backgrounds, and applies bilateral edge-preserving
       denoising + morphological/Gaussian illumination division (cv2.divide) + paper-white floor + mild
       unsharp mask on shadowed, colored, or noisy scans.
    4. Adds a clean white quiet-zone border so edge glyphs (آ / ک / گ) never touch crop boundaries.
    """
    base = _to_white_backed_rgb(image)
    try:
        orig_w, orig_h = base.size
        gray_pil = base.convert("L")
        gray_in = np.asarray(gray_pil, dtype=np.uint8)
        gray_pil.close()
    finally:
        if base is not image:
            base.close()

    h, w = gray_in.shape[:2]
    if scale_override is not None:
        scale = float(scale_override)
    elif not precise:
        scale = 1.0
    elif w <= 950 or min(h, w) < 90:
        scale = 2.0
    elif w <= 1700:
        scale = 1.5
    else:
        scale = 1.0
    if w * scale > 4800:
        scale = 1.0

    pad = max(0, int(border_pad))
    work = gray_in.copy()
    if h >= 4 and w >= 4:
        border_vals = np.concatenate([work[0, :], work[-1, :], work[:, 0], work[:, -1]])
        border_med = float(np.median(border_vals))
        med = float(np.median(work))
        if med < 110.0 and border_med < 120.0 and float(np.percentile(work, 99.4)) > med + 55.0:
            work = (255 - work).astype(np.uint8)

    try:
        import cv2
    except Exception:
        pil_clean = ImageOps.autocontrast(Image.fromarray(work, mode="L"), cutoff=0)
        if scale != 1.0:
            pil_clean = pil_clean.resize(
                (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                Image.Resampling.LANCZOS,
            )
        if pad > 0:
            pil_clean = ImageOps.expand(pil_clean, border=pad, fill=255)
        out_rgb = pil_clean.convert("RGB")
        pil_clean.close()
        return out_rgb, scale, pad

    p2, p50, p90 = [float(np.percentile(work, q)) for q in (2.0, 50.0, 90.0)]
    bg_pixels = work[work >= p50]
    bg_std = float(np.std(bg_pixels)) if bg_pixels.size > 20 else 0.0
    contrast_span = p90 - p2

    if bg_std < 7.5 and contrast_span > 135.0 and page_mode != "document":
        # Clean uniform background: keep natural grayscale anti-aliasing around Persian dots & connectors.
        pil_g = ImageOps.autocontrast(Image.fromarray(work, mode="L"), cutoff=0)
        if scale != 1.0:
            pil_g = pil_g.resize(
                (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                Image.Resampling.LANCZOS,
            )
        arr = np.asarray(pil_g, dtype=np.uint8)
        pil_g.close()
        arr = cv2.bilateralFilter(arr, d=5, sigmaColor=14, sigmaSpace=14)
        padded = cv2.copyMakeBorder(arr, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255) if pad > 0 else arr
        return Image.fromarray(padded, mode="L").convert("RGB"), scale, pad

    if scale != 1.0:
        work = cv2.resize(
            work,
            (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
            interpolation=cv2.INTER_CUBIC,
        )
    denoised = cv2.bilateralFilter(work, d=5, sigmaColor=24, sigmaSpace=24)
    m_pad = 36
    work_pad = cv2.copyMakeBorder(denoised, m_pad, m_pad, m_pad, m_pad, cv2.BORDER_REPLICATE)
    bg_est = cv2.morphologyEx(
        work_pad,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (71, 71)),
    )
    bg_est = cv2.GaussianBlur(bg_est, (0, 0), sigmaX=24.0)[m_pad:-m_pad, m_pad:-m_pad]
    norm = cv2.divide(denoised, np.maximum(bg_est, 48), scale=255)
    p_ink = float(np.percentile(norm, 0.8))
    lo = min(135.0, max(0.0, p_ink * 0.82)) if p_ink > 42.0 else 0.0
    hi = 236.0
    cleaned = np.clip((norm.astype(np.float32) - lo) * (255.0 / max(30.0, hi - lo)), 0, 255).astype(np.uint8)
    blur_u = cv2.GaussianBlur(cleaned, (0, 0), sigmaX=0.9)
    sharp = cv2.addWeighted(cleaned, 1.32, blur_u, -0.32, 0)
    padded = cv2.copyMakeBorder(sharp, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255) if pad > 0 else sharp
    return Image.fromarray(padded, mode="L").convert("RGB"), scale, pad


def preprocess(
    image: Image.Image,
    contrast: bool,
    precise: bool,
    *,
    page_mode: str = "comic",
) -> tuple[Image.Image, float]:
    image = _to_white_backed_rgb(image)
    if contrast:
        # In document/article mode, keep dark ink strokes unclipped (cutoff_low=0) while brightening off-white paper.
        cutoff = (0, 1) if page_mode == "document" else 1
        image = ImageOps.autocontrast(image, cutoff=cutoff)
    scale = 1.0
    if precise and image.width * image.height <= PRECISE_UPSCALE_MAX_PIXELS:
        scale = 2.0
        resized = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
        image.close()
        image = resized
    return image, scale


def _blocks_from_lines(
    lines: list[OcrLine],
    coordinate_scale: float = 1.0,
    *,
    coordinate_pad: float = 0.0,
    bounds: tuple[int, int] | None = None,
) -> list[dict[str, Any]]:
    """Build the unchanged public block schema from positioned OCR lines."""
    blocks = []
    max_w = float(bounds[0]) if bounds else None
    max_h = float(bounds[1]) if bounds else None
    for index, line in enumerate(lines, start=1):
        raw_x0, raw_y0, raw_x1, raw_y1 = line.box
        x0 = (raw_x0 - coordinate_pad) / coordinate_scale
        y0 = (raw_y0 - coordinate_pad) / coordinate_scale
        x1 = (raw_x1 - coordinate_pad) / coordinate_scale
        y1 = (raw_y1 - coordinate_pad) / coordinate_scale
        if max_w is not None and max_h is not None:
            x0 = max(0.0, min(max_w, x0))
            x1 = max(x0 + 1.0, min(max_w, x1))
            y0 = max(0.0, min(max_h, y0))
            y1 = max(y0 + 1.0, min(max_h, y1))
        polygon = []
        for px, py in line.polygon:
            ux = (px - coordinate_pad) / coordinate_scale
            uy = (py - coordinate_pad) / coordinate_scale
            if max_w is not None and max_h is not None:
                ux = max(0.0, min(max_w, ux))
                uy = max(0.0, min(max_h, uy))
            polygon.append([ux, uy])
        line_h = max(8.0, y1 - y0)
        is_bold = bool(getattr(line, "bold", False))
        is_italic = bool(getattr(line, "italic", False))
        role = getattr(line, "role", None)
        entry: dict[str, Any] = {
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
            "bold": is_bold,
            "italic": is_italic,
            "underline": False,
            "size": None,
            "color": None,
        }
        if is_bold:
            entry["_detectedBold"] = True
            entry["_explicitBold"] = True
        if is_italic:
            entry["_detectedItalic"] = True
        if role in {"heading", "list", "paragraph"}:
            entry["pageRole"] = role
        blocks.append(entry)
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
            lines = doc_rec(crop, language)
        elif isinstance(engine, IsolatedOcrEngine):
            lines = engine.recognize(crop, language, page_mode=page_mode)
        else:
            lines = engine.recognize(crop, language)
    elif isinstance(engine, IsolatedOcrEngine):
        lines = engine.recognize(crop, language, page_mode=page_mode)
    else:
        lines = engine.recognize(crop, language)
    if language == "fas" and lines:
        normalized_lines: list[OcrLine] = []
        for ln in lines:
            cleaned = normalize_persian_ocr_text(ln.text)
            if cleaned:
                normalized_lines.append(
                    OcrLine(
                        cleaned,
                        ln.confidence,
                        ln.polygon,
                        bold=bool(getattr(ln, "bold", False)),
                        italic=bool(getattr(ln, "italic", False)),
                        role=getattr(ln, "role", None),
                    )
                )
        return normalized_lines
    return lines


def _sort_ocr_lines_reading_order(lines: list[OcrLine], *, is_rtl_lang: bool) -> None:
    if len(lines) < 2:
        return
    heights = sorted(max(8.0, float(ln.box[3] - ln.box[1])) for ln in lines)
    med_h = heights[len(heights) // 2]
    row_bucket = max(12.0, round(med_h * 0.55))
    lines.sort(
        key=lambda line: (
            round(((line.box[1] + line.box[3]) / 2.0) / row_bucket) * row_bucket,
            -line.box[2] if is_rtl_lang else line.box[0],
            line.box[1],
        )
    )


def _recognize_image_primary(
    engine: Any,
    image: Image.Image,
    language: str,
    contrast: bool = True,
    precise: bool = True,
    min_confidence: float = 0.35,
    input_scale: float = 1.0,
    page_mode: str = "auto",
    *,
    persian_preprocess: bool = False,
) -> list[dict[str, Any]]:
    """The established OCR path; input_scale only restores fallback geometry."""
    from .ocr_grouping import detect_page_mode, sort_document_reading_order

    is_isolated = isinstance(engine, IsolatedOcrEngine)
    border_pad = 0
    if persian_preprocess:
        # Heavy isolated VLM/layout engines manage their own high-res vision encoders, whereas lightweight
        # Hezar CRAFT+CRNN benefits from upscaling small crops (<900px) while keeping RAM bounded.
        is_light_isolated = is_isolated and getattr(engine, "id", "") == "hezar-ocr" and max(image.size) <= 950
        effective_precise = precise if (not is_isolated or is_light_isolated) else False
        prepared, scale, border_pad = persian_preprocess_image(
            image, precise=effective_precise, page_mode=page_mode,
        )
    else:
        # Isolated VLM/layout engines handle their own vision scaling; skipping 2x Lanczos prevents multi-GB RAM spikes.
        effective_precise = False if is_isolated else precise
        prepared, scale = preprocess(image, contrast, effective_precise, page_mode=page_mode)
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
                    adjusted = OcrLine(
                        line.text,
                        line.confidence,
                        polygon,
                        bold=bool(getattr(line, "bold", False)),
                        italic=bool(getattr(line, "italic", False)),
                        role=getattr(line, "role", None),
                    )
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
    # Reading order is stable: physical row first, then horizontal position (right-to-left for Persian/RTL).
    is_rtl_lang = language in {"fas", "ara"}
    _sort_ocr_lines_reading_order(lines, is_rtl_lang=is_rtl_lang)
    orig_bounds = (
        (max(1, int(round(image.width / input_scale))), max(1, int(round(image.height / input_scale))))
        if border_pad > 0
        else None
    )
    blocks = _blocks_from_lines(
        lines,
        scale * input_scale,
        coordinate_pad=float(border_pad),
        bounds=orig_bounds,
    )
    effective_mode = detect_page_mode(blocks, page_size=image.size) if page_mode == "auto" else page_mode
    if effective_mode == "document" and len(blocks) >= 2:
        blocks = sort_document_reading_order(blocks, page_size=image.size, rtl_columns=is_rtl_lang)
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
        try:
            lines = [line for line in _recognize_bubble_lines(engine, prepared, language) if line.text.strip()]
        finally:
            prepared.close()
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
        is_rtl_lang = language in {"fas", "ara"}
        restored.sort(key=lambda line: (
            round(((line.box[1] + line.box[3]) / 2) / 12) * 12,
            -line.box[2] if is_rtl_lang else line.box[0],
            line.box[1],
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


def _document_preprocess_image(image: Image.Image) -> tuple[Image.Image, float]:
    """Normalize uneven paper shading/scans into crisp dark-ink-on-white for articles and books."""
    import cv2

    base = _to_white_backed_rgb(image)
    try:
        rgb = np.asarray(base)
    finally:
        if base is not image:
            base.close()
    scale = float(DOCUMENT_FALLBACK_SCALE) if rgb.shape[0] * rgb.shape[1] <= PRECISE_UPSCALE_MAX_PIXELS else 1.0
    if scale > 1.0:
        rgb = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    background = cv2.GaussianBlur(gray, (0, 0), sigmaX=25, sigmaY=25)
    background = np.maximum(background, 1)
    normalized = cv2.divide(gray, background, scale=255)
    out = ImageOps.autocontrast(Image.fromarray(normalized, mode="L"), cutoff=(0, 1)).convert("RGB")
    return out, scale


def analyze_blocks_typography(
    image: Image.Image,
    blocks: list[dict[str, Any]],
    *,
    page_mode: str = "auto",
) -> None:
    """Measure stroke weight (bold) and shear slant (italic) directly from image pixels."""
    if not blocks:
        return
    oriented = ImageOps.exif_transpose(image)
    gray_img = oriented.convert("L")
    try:
        gray = np.asarray(gray_img)
    finally:
        if gray_img is not image:
            gray_img.close()
        if oriented is not image and oriented is not gray_img:
            oriented.close()
    if gray.ndim != 2 or gray.shape[0] < 10 or gray.shape[1] < 10:
        return

    img_h, img_w = gray.shape
    slant_angles = (-4.0, 0.0, 4.0, 8.0, 10.0, 12.0, 14.0, 16.0)
    slant_tans = [float(np.tan(np.deg2rad(a))) for a in slant_angles]
    measured: list[tuple[dict[str, Any], float, float]] = []

    for blk in blocks:
        txt = str(blk.get("text") or "").strip()
        if len(txt) < 2:
            continue
        ix0 = max(0, min(img_w - 2, int(round(float(blk.get("x0", 0)))) - 2))
        iy0 = max(0, min(img_h - 2, int(round(float(blk.get("y0", 0)))) - 2))
        ix1 = max(ix0 + 2, min(img_w, int(round(float(blk.get("x1", 0)))) + 2))
        iy1 = max(iy0 + 2, min(img_h, int(round(float(blk.get("y1", 0)))) + 2))
        if (iy1 - iy0) < 8 or (ix1 - ix0) < 12:
            continue
        crop = gray[iy0:iy1, ix0:ix1]
        pcts = np.percentile(crop, (1.0, 99.0))
        p1, p99 = float(pcts[0]), float(pcts[1])
        if p99 - p1 < 28.0:
            continue
        border = np.concatenate([crop[0, :], crop[-1, :], crop[:, 0], crop[:, -1]])
        bg = float(np.median(border))
        if abs(bg - p1) >= abs(bg - p99):
            denom = max(24.0, bg - p1)
            cov = np.clip((bg - crop.astype(np.float32)) / denom, 0.0, 1.0)
        else:
            denom = max(24.0, p99 - bg)
            cov = np.clip((crop.astype(np.float32) - bg) / denom, 0.0, 1.0)

        ys, xs = np.nonzero(cov >= 0.42)
        if len(ys) < 18:
            continue
        sub = cov[int(ys.min()):int(ys.max()) + 1, int(xs.min()):int(xs.max()) + 1]
        sh, sw = sub.shape
        if sh < 6 or sw < 10:
            continue

        total_mass = float(sub.sum())
        h_edges = float(np.abs(np.diff(sub, axis=1, prepend=0.0, append=0.0)).sum()) * 0.5
        v_edges = float(np.abs(np.diff(sub, axis=0, prepend=0.0, append=0.0)).sum()) * 0.5
        rx = total_mass / max(1.0, h_edges)
        ry = total_mass / max(1.0, v_edges)
        stroke_w = (2.0 * rx * ry) / max(0.1, rx + ry)
        active_cols = max(1, int(np.count_nonzero(sub.max(axis=0) >= 0.35)))
        col_fill = total_mass / float(sh * active_cols)

        has_lower = any("a" <= ch <= "z" for ch in txt)
        has_tall = any(("A" <= ch <= "Z") or ("0" <= ch <= "9") or ch in "bdfhkltgjpqy" for ch in txt)
        eff_h = float(sh) / 0.76 if (has_lower and not has_tall) else float(sh)
        sw_ratio = stroke_w / max(6.0, eff_h)
        measured.append((blk, sw_ratio, col_fill))

        # Italic / oblique detection on single-row alphabetic lines
        alpha_count = sum(ch.isalpha() for ch in txt)
        if alpha_count >= 4 and "\n" not in txt and sh >= 9 and sw >= 16 and not blk.get("italic"):
            edge = np.abs(np.diff((sub >= 0.42).astype(np.float32), axis=1))
            eh, ew = edge.shape
            er, ec = np.nonzero(edge > 0.0)
            if ew >= 8 and er.size >= 8:
                yc = np.arange(eh, dtype=np.float32) - (eh - 1) * 0.5
                er_yc = yc[er]
                ec_i32 = ec.astype(np.int32, copy=False)
                scores: list[float] = []
                for tan_a in slant_tans:
                    pad = int(np.ceil(abs(tan_a) * eh)) + 2
                    acc_len = ew + 2 * pad
                    shifts = tan_a * er_yc
                    s_floor = np.floor(shifts).astype(np.int32)
                    frac = shifts - s_floor
                    idx0 = pad + s_floor + ec_i32
                    acc = (
                        np.bincount(idx0, weights=1.0 - frac, minlength=acc_len)
                        + np.bincount(idx0 + 1, weights=frac, minlength=acc_len)
                    )
                    scores.append(float(np.dot(acc, acc)))
                best_idx = int(np.argmax(scores))
                best_deg = slant_angles[best_idx]
                zero_score = scores[1]  # angle 0.0°
                slant_gain = scores[best_idx] / max(1e-6, zero_score)
                if best_deg >= 8.0 and slant_gain >= 1.08:
                    blk["italic"] = True
                    blk["_detectedItalic"] = True

    if not measured:
        return
    sw_vals = [item[1] for item in measured]
    fill_vals = [item[2] for item in measured]
    has_weight_contrast = len(measured) >= 3 and (max(sw_vals) >= min(sw_vals) * 1.18)
    if has_weight_contrast:
        base_sw = float(np.percentile(sw_vals, 38.0))
        base_fill = float(np.percentile(fill_vals, 38.0))
        for blk, sw_r, fill_r in measured:
            if sw_r >= base_sw * 1.20 and fill_r >= base_fill * 1.10:
                blk["bold"] = True
                blk["_detectedBold"] = True
                blk["_explicitBold"] = True
    elif page_mode == "document":
        for blk, sw_r, fill_r in measured:
            if sw_r >= 0.265 and fill_r >= 0.40:
                blk["bold"] = True
                blk["_detectedBold"] = True
                blk["_explicitBold"] = True


def _persian_container_regions(image: Image.Image) -> list[tuple[Image.Image, int, int, int, int]]:
    """Detect uniform-background comic speech bubbles and caption boxes (light, colored, AND dark)
    and return isolated grayscale-filled crops `(clean_pil_rgb, x, y, bw, bh)` so rounded/colored
    borders never confuse Persian line segmentation."""
    import cv2

    base = _to_white_backed_rgb(image)
    try:
        rgb = np.asarray(base, dtype=np.uint8)
    finally:
        if base is not image:
            base.close()
    h, w = rgb.shape[:2]
    if h < 80 or w < 100:
        return []
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    k3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    grad_rgb = np.max([cv2.morphologyEx(rgb[:, :, c], cv2.MORPH_GRADIENT, k3) for c in range(3)], axis=0)
    _, wall = cv2.threshold(grad_rgb, 24, 255, cv2.THRESH_BINARY)
    interior = cv2.bitwise_not(cv2.morphologyEx(wall, cv2.MORPH_CLOSE, k3))
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(interior, connectivity=4)
    regions: list[tuple[Image.Image, int, int, int, int]] = []
    for lbl in range(1, num_labels):
        area = int(stats[lbl, cv2.CC_STAT_AREA])
        if area < 1400 or area > h * w * 0.78:
            continue
        x = int(stats[lbl, cv2.CC_STAT_LEFT])
        y = int(stats[lbl, cv2.CC_STAT_TOP])
        bw = int(stats[lbl, cv2.CC_STAT_WIDTH])
        bh = int(stats[lbl, cv2.CC_STAT_HEIGHT])
        if bw < 45 or bh < 24 or (area / float(bw * bh)) < 0.35:
            continue
        if bw * bh > h * w * 0.72 or (bw >= w * 0.94 and bh >= h * 0.94):
            continue
        comp_mask = labels[y:y + bh, x:x + bw] == lbl
        vals = gray[y:y + bh, x:x + bw][comp_mask]
        if vals.size < 350:
            continue
        med = float(np.median(vals))
        if float(np.mean(np.abs(vals.astype(np.float32) - med) <= 20.0)) < 0.62:
            continue
        comp_u8 = (comp_mask.astype(np.uint8)) * 255
        cnts, _ = cv2.findContours(comp_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        filled = np.zeros_like(comp_u8)
        cv2.drawContours(filled, cnts, -1, 255, thickness=cv2.FILLED)
        filled = cv2.erode(filled, np.ones((4, 4), np.uint8))
        crop_g = gray[y:y + bh, x:x + bw]
        in_px = crop_g[filled > 0]
        if in_px.size < 250:
            continue
        contrast_px = float(np.mean(in_px < med - 32.0)) if med >= 105.0 else float(np.mean(in_px > med + 38.0))
        if not (0.006 <= contrast_px <= 0.48):
            continue
        clean_crop = np.full((bh, bw), int(round(med)), dtype=np.uint8)
        clean_crop[filled > 0] = crop_g[filled > 0]
        regions.append((Image.fromarray(clean_crop, mode="L").convert("RGB"), x, y, bw, bh))
    regions.sort(key=lambda r: (round((r[2] + r[4] * 0.5) / 24.0) * 24, -r[1]))
    return regions


def _blocks_overlap_strongly(a: dict[str, Any], b: dict[str, Any]) -> bool:
    ax0, ay0, ax1, ay1 = float(a["x0"]), float(a["y0"]), float(a["x1"]), float(a["y1"])
    bx0, by0, bx1, by1 = float(b["x0"]), float(b["y0"]), float(b["x1"]), float(b["y1"])
    ix = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0.0, min(ay1, by1) - max(ay0, by0))
    if ix <= 0.0 or iy <= 0.0:
        return False
    inter = ix * iy
    area_a = max(1.0, (ax1 - ax0) * (ay1 - ay0))
    area_b = max(1.0, (bx1 - bx0) * (by1 - by0))
    if inter / min(area_a, area_b) >= 0.42:
        return True
    v_ov = iy / max(1.0, min(ay1 - ay0, by1 - by0))
    h_ov = ix / max(1.0, min(ax1 - ax0, bx1 - bx0))
    return v_ov >= 0.55 and h_ov >= 0.45


def _merge_non_overlapping_blocks(
    primary: list[dict[str, Any]],
    extra: list[dict[str, Any]],
    *,
    is_rtl_lang: bool = True,
) -> list[dict[str, Any]]:
    """Keep primary blocks and append newly discovered container blocks (or replace lower-quality overlaps)."""
    if not extra:
        return primary
    if not primary:
        merged = list(extra)
    else:
        merged = [dict(b) for b in primary]
        for cand in extra:
            cand_txt = str(cand.get("text") or "").strip()
            if not cand_txt:
                continue
            overlapping_idxs = [i for i, cur in enumerate(merged) if _blocks_overlap_strongly(cur, cand)]
            if not overlapping_idxs:
                merged.append(dict(cand))
                continue
            if len(overlapping_idxs) == 1:
                idx = overlapping_idxs[0]
                cur = merged[idx]
                cur_chars = sum(ch.isalnum() for ch in str(cur.get("text") or ""))
                cand_chars = sum(ch.isalnum() for ch in cand_txt)
                cur_conf = float(cur.get("conf", 0.0))
                cand_conf = float(cand.get("conf", 0.0))
                if (cand_chars >= cur_chars + 3 and cand_conf >= cur_conf - 6.0) or (
                    cand_chars >= cur_chars and cand_conf > cur_conf + 8.0
                ):
                    merged[idx] = dict(cand)
    if len(merged) >= 2:
        heights = sorted(max(8.0, float(b["y1"]) - float(b["y0"])) for b in merged)
        row_bucket = max(12.0, round(heights[len(heights) // 2] * 0.55))
        merged.sort(
            key=lambda b: (
                round(((float(b["y0"]) + float(b["y1"])) / 2.0) / row_bucket) * row_bucket,
                -float(b["x1"]) if is_rtl_lang else float(b["x0"]),
                float(b["y0"]),
            )
        )
    for idx, blk in enumerate(merged, start=1):
        blk["id"] = idx
    return merged


def _recognize_persian_containers(
    engine: Any,
    image: Image.Image,
    language: str,
    min_confidence: float,
    existing_blocks: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Run dot-preserving Persian preprocessing on isolated comic speech bubbles and dark/colored boxes."""
    regions = _persian_container_regions(image)
    if not regions:
        return []
    existing = existing_blocks or []
    discovered: list[dict[str, Any]] = []
    is_rtl_lang = language in {"fas", "ara"}
    page_w, page_h = image.size
    for crop_rgb, ox, oy, bw, bh in regions:
        try:
            # Skip containers already well-covered by high-confidence primary OCR blocks.
            inside_existing = [
                b for b in existing
                if float(b["x0"]) >= ox - 12 and float(b["x1"]) <= ox + bw + 12
                and float(b["y0"]) >= oy - 12 and float(b["y1"]) <= oy + bh + 12
            ]
            ex_chars, ex_conf = _result_metrics(inside_existing)
            if ex_chars >= 18 and ex_conf >= 0.80:
                continue

            best_lines: list[OcrLine] = []
            best_scale = 1.5
            best_pad = PERSIAN_PREPROCESS_BORDER_PAD
            for sc in (1.5, 2.0):
                prep_img, used_scale, used_pad = persian_preprocess_image(
                    crop_rgb, precise=True, page_mode="comic", scale_override=sc,
                )
                try:
                    raw_lines = [
                        ln for ln in _recognize_bubble_lines(engine, prep_img, language)
                        if ln.text.strip()
                    ]
                finally:
                    prep_img.close()
                if language == "fas":
                    raw_lines = [
                        OcrLine(normalize_persian_ocr_text(ln.text), ln.confidence, ln.polygon)
                        for ln in raw_lines
                        if normalize_persian_ocr_text(ln.text)
                    ]
                if len(raw_lines) > len(best_lines) or (
                    len(raw_lines) == len(best_lines)
                    and _bubble_region_confidence(raw_lines) > _bubble_region_confidence(best_lines) + 2.0
                ):
                    best_lines = raw_lines
                    best_scale = used_scale
                    best_pad = used_pad
                if len(best_lines) >= 2 and _bubble_region_confidence(best_lines) >= 78.0:
                    break

            if not best_lines or _bubble_region_confidence(best_lines) < 42.0:
                continue
            restored: list[OcrLine] = []
            for ln in best_lines:
                if ln.confidence < min_confidence:
                    continue
                poly = [
                    [
                        max(0.0, min(float(page_w), (px - best_pad) / best_scale + ox)),
                        max(0.0, min(float(page_h), (py - best_pad) / best_scale + oy)),
                    ]
                    for px, py in ln.polygon
                ]
                restored.append(OcrLine(ln.text, ln.confidence, poly))
            _sort_ocr_lines_reading_order(restored, is_rtl_lang=is_rtl_lang)
            discovered.extend(_blocks_from_lines(restored))
        finally:
            crop_rgb.close()
    for idx, blk in enumerate(discovered, start=1):
        blk["id"] = idx
    return discovered


def recognize_image(
    engine: Any,
    image: Image.Image,
    language: str,
    contrast: bool = True,
    precise: bool = True,
    min_confidence: float = 0.35,
    *,
    page_mode: str = "auto",
    persian_preprocess: bool = False,
) -> list[dict[str, Any]]:
    """Run the established OCR first; optional fallbacks only compete after a weak result."""
    from .license_guard import require_module_license

    require_module_license("ocr")
    primary = _recognize_image_primary(
        engine,
        image,
        language,
        contrast,
        precise,
        min_confidence,
        page_mode=page_mode,
        persian_preprocess=persian_preprocess,
    )
    if isinstance(engine, IsolatedOcrEngine):
        analyze_blocks_typography(image, primary, page_mode=page_mode)
        return primary
    best = primary
    if (
        persian_preprocess
        and BUBBLE_PREPROCESS_ENABLED
        and page_mode != "document"
        and image.width >= 200
        and image.height >= 140
    ):
        try:
            container_blocks = _recognize_persian_containers(
                engine, image, language, min_confidence, existing_blocks=best,
            )
        except Exception:
            container_blocks = []
        if container_blocks:
            best = _merge_non_overlapping_blocks(
                best, container_blocks, is_rtl_lang=(language in {"fas", "ara"}),
            )
    if not _needs_extra_preprocess(best):
        analyze_blocks_typography(image, best, page_mode=page_mode)
        return best
    if page_mode == "document":
        emit("نتیجهٔ اولیهٔ مقاله/کتاب ضعیف بود؛ پیش‌پردازش تخصصی شفاف‌سازی کاغذ و متن اجرا می‌شود")
        try:
            if persian_preprocess:
                doc_image, doc_scale, doc_pad = persian_preprocess_image(
                    image, precise=True, page_mode="document", scale_override=2.0,
                )
            else:
                doc_image, doc_scale = _document_preprocess_image(image)
                doc_pad = 0
            try:
                doc_fallback = _recognize_image_primary(
                    engine, doc_image, language, False, False, min_confidence,
                    input_scale=doc_scale, page_mode=page_mode, persian_preprocess=False,
                )
                if doc_pad > 0 and doc_scale > 0:
                    shift = doc_pad / doc_scale
                    for blk in doc_fallback:
                        blk["x0"] = max(0.0, float(blk["x0"]) - shift)
                        blk["y0"] = max(0.0, float(blk["y0"]) - shift)
                        blk["x1"] = min(float(image.width), max(blk["x0"] + 1.0, float(blk["x1"]) - shift))
                        blk["y1"] = min(float(image.height), max(blk["y0"] + 1.0, float(blk["y1"]) - shift))
                        blk["polygon"] = [
                            [max(0.0, px - shift), max(0.0, py - shift)]
                            for px, py in blk.get("polygon", [])
                        ]
            finally:
                doc_image.close()
        except Exception:
            emit("پیش‌پردازش تخصصی مقاله ممکن نبود؛ نتیجهٔ اولیه حفظ شد", "warning")
        else:
            if _better_fallback(doc_fallback, best):
                emit("نتیجهٔ پیش‌پردازش تخصصی مقاله بهتر بود و انتخاب شد", "success")
                best = doc_fallback
                if not _needs_extra_preprocess(best):
                    analyze_blocks_typography(image, best, page_mode=page_mode)
                    return best
    if EXTRA_PREPROCESS_ENABLED:
        emit("نتیجهٔ OCR اصلی ضعیف یا کوتاه است؛ پیش‌پردازش تکمیلی متن روشن اجرا می‌شود")
        try:
            if persian_preprocess:
                # Avoid destructive binary >200 threshold that erases anti-aliased Persian dots (نقطه).
                inv_rgb = ImageOps.invert(_to_white_backed_rgb(image))
                try:
                    fallback_image, fb_scale, fb_pad = persian_preprocess_image(
                        inv_rgb, precise=True, page_mode=page_mode, scale_override=2.0,
                    )
                finally:
                    inv_rgb.close()
            else:
                fallback_image = _extra_preprocess_image(image)
                fb_scale = float(EXTRA_PREPROCESS_SCALE)
                fb_pad = 0
            try:
                fallback = _recognize_image_primary(
                    engine, fallback_image, language, False, False, min_confidence,
                    input_scale=fb_scale, page_mode=page_mode, persian_preprocess=False,
                )
                if fb_pad > 0 and fb_scale > 0:
                    shift = fb_pad / fb_scale
                    for blk in fallback:
                        blk["x0"] = max(0.0, float(blk["x0"]) - shift)
                        blk["y0"] = max(0.0, float(blk["y0"]) - shift)
                        blk["x1"] = min(float(image.width), max(blk["x0"] + 1.0, float(blk["x1"]) - shift))
                        blk["y1"] = min(float(image.height), max(blk["y0"] + 1.0, float(blk["y1"]) - shift))
                        blk["polygon"] = [
                            [max(0.0, px - shift), max(0.0, py - shift)]
                            for px, py in blk.get("polygon", [])
                        ]
            finally:
                fallback_image.close()
        except Exception:
            # An optional preprocessing backend must never break the established OCR result.
            emit("پیش‌پردازش تکمیلی ممکن نبود؛ نتیجهٔ OCR اصلی حفظ شد", "warning")
        else:
            if _better_fallback(fallback, best):
                emit("نتیجهٔ پیش‌پردازش تکمیلی بهتر بود و انتخاب شد", "success")
                best = fallback
            else:
                emit("نتیجهٔ OCR اصلی بهتر بود و حفظ شد")
    if BUBBLE_PREPROCESS_ENABLED and page_mode != "document" and not persian_preprocess:
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
    analyze_blocks_typography(image, best, page_mode=page_mode)
    return best
