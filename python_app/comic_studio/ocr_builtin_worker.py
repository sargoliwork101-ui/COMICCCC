"""Crash-isolated persistent worker for built-in OCR engines (`rapidocr-v6`, `rapidocr-v5`, `easyocr`).

Running ONNX Runtime (including Windows DirectML), PyTorch (EasyOCR), and
OpenCV inside a dedicated child process ensures:
1. A native C++/GPU/DirectML driver crash or memory spike never kills the
   main `uvicorn` web server (eliminating sudden ``Failed to fetch`` errors
   mid-batch).
2. Unloading an engine terminates the worker process so 100% of native C++ heap
   and GPU VRAM is immediately reclaimed by the OS.
3. If the worker crashes on GPU/DirectML, the client automatically restarts a
   fresh worker in safe CPU mode (``COMIC_STUDIO_FORCE_CPU=1``) and retries the
   page transparently.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

_SUBPROCESS_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
BUILTIN_ISOLATABLE_ENGINES = frozenset({"rapidocr-v6", "rapidocr-v5", "easyocr"})
BUILTIN_WORKER_MAX_PAGES = 16
BUILTIN_WORKER_MAX_RSS_MB = 2200.0


def _kill_proc_tree(proc: subprocess.Popen[str] | None) -> None:
    if proc is None:
        return
    try:
        if proc.poll() is not None:
            return
    except Exception:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=5,
                check=False,
                creationflags=_SUBPROCESS_NO_WINDOW,
            )
        except Exception:
            pass
    else:
        try:
            import signal

            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass
    with contextlib.suppress(Exception):
        proc.kill()
    with contextlib.suppress(Exception):
        proc.wait(timeout=3)


def _start_parent_watchdog(parent_pid: int) -> None:
    if parent_pid <= 0:
        return

    def _watch() -> None:
        if os.name == "nt":
            try:
                import ctypes
                from ctypes import wintypes

                kernel32 = ctypes.windll.kernel32
                for fn, at, rt in (
                    (kernel32.OpenProcess, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], ctypes.c_void_p),
                    (kernel32.WaitForSingleObject, [ctypes.c_void_p, wintypes.DWORD], wintypes.DWORD),
                    (kernel32.CloseHandle, [ctypes.c_void_p], wintypes.BOOL),
                ):
                    with contextlib.suppress(AttributeError, TypeError):
                        fn.argtypes = at
                        fn.restype = rt

                handle = kernel32.OpenProcess(0x00100000, False, int(parent_pid))
                if handle:
                    try:
                        kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
                    finally:
                        kernel32.CloseHandle(handle)
                    os._exit(0)
            except Exception:
                pass
        while True:
            time.sleep(0.5)
            try:
                if os.getppid() != parent_pid:
                    os._exit(0)
                os.kill(parent_pid, 0)
            except OSError:
                os._exit(0)
            except Exception:
                pass

    t = threading.Thread(target=_watch, daemon=True, name="builtin-ocr-parent-watchdog")
    t.start()


def _worker_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="HaSaYa Studio built-in OCR worker")
    parser.add_argument("--parent-pid", type=int, default=0)
    args, _ = parser.parse_known_args(argv)

    # Keep the original stdout exclusively for structured JSON lines; redirect
    # any incidental library print() calls to stderr so the protocol stays clean.
    proto_out = sys.stdout
    sys.stdout = sys.stderr
    write_lock = threading.Lock()

    def _send(payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with write_lock:
            proto_out.write(line)
            proto_out.flush()

    if args.parent_pid > 0:
        _start_parent_watchdog(args.parent_pid)

    from PIL import Image

    from . import ocr as ocr_mod
    from .activity import JobCancelledError, reporting
    from .ocr_managed import configure_native_runtime, trim_process_memory

    configure_native_runtime(True)
    registry = ocr_mod.EngineRegistry()
    # Inside the child worker itself, always execute the real in-process engines.
    ocr_mod.release_worker_guard = True  # type: ignore[attr-defined]

    def _report_to_parent(message: str, level: str = "info", progress: float | None = None) -> None:
        with contextlib.suppress(Exception):
            _send({"type": "log", "message": str(message), "level": str(level), "progress": progress})

    _send({"type": "ready", "pid": os.getpid()})

    while True:
        raw_line = sys.stdin.readline()
        if not raw_line:
            break
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            req = json.loads(raw_line)
        except Exception as exc:
            _send({"type": "result", "ok": False, "errorType": "ValueError", "error": f"Invalid request JSON: {exc}"})
            continue

        cmd = str(req.get("cmd") or "recognize")
        if cmd == "shutdown":
            with contextlib.suppress(Exception):
                registry.unload_all()
            _send({"type": "bye"})
            break

        if cmd == "unload":
            except_id = req.get("exceptId")
            with contextlib.suppress(Exception):
                registry.unload_all(except_id)
                trim_process_memory(aggressive=(except_id is None))
            _send({"type": "unloaded", "ok": True})
            continue

        if cmd != "recognize":
            _send({"type": "result", "ok": False, "errorType": "ValueError", "error": f"Unknown command: {cmd}"})
            continue

        engine_id = str(req.get("engineId") or "")
        image_path = str(req.get("imagePath") or "")
        language = str(req.get("language") or "eng")
        contrast = bool(req.get("contrast", True))
        precise = bool(req.get("precise", True))
        min_confidence = float(req.get("minConfidence", 0.35))
        page_mode = str(req.get("pageMode") or "auto")
        persian_preprocess = bool(req.get("persianPreprocess", False))

        try:
            engine = registry.get(engine_id)
            with Image.open(image_path) as im:
                image = im.copy()
            try:
                kwargs: dict[str, Any] = {"page_mode": page_mode}
                if persian_preprocess:
                    kwargs["persian_preprocess"] = True
                with reporting(_report_to_parent):
                    blocks = ocr_mod.recognize_image(
                        engine,
                        image,
                        language,
                        contrast,
                        precise,
                        min_confidence,
                        **kwargs,
                    )
            finally:
                image.close()
                trim_process_memory(aggressive=False)
            _send({"type": "result", "ok": True, "blocks": blocks})
        except JobCancelledError as exc:
            _send({"type": "result", "ok": False, "cancelled": True, "error": str(exc)})
        except ocr_mod.OcrError as exc:
            _send({"type": "result", "ok": False, "errorType": "OcrError", "error": str(exc)})
        except Exception as exc:
            from .license_guard import LicenseError

            if isinstance(exc, LicenseError):
                _send({
                    "type": "result",
                    "ok": False,
                    "errorType": "LicenseError",
                    "code": exc.code,
                    "statusCode": exc.status_code,
                    "error": exc.message,
                })
            else:
                _send({"type": "result", "ok": False, "errorType": type(exc).__name__, "error": str(exc)})

    with contextlib.suppress(Exception):
        registry.unload_all()
    return 0


class BuiltinOcrWorkerClient:
    """Supervises one crash-isolated child worker for built-in OCR engines."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc_lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._loaded_engine_id: str | None = None
        self._pages_served: int = 0
        self._force_cpu: bool = False
        self._cancelled = threading.Event()
        self._stderr_tail: deque[str] = deque(maxlen=60)

    @property
    def is_running(self) -> bool:
        with self._proc_lock:
            return self._proc is not None and self._proc.poll() is None

    @property
    def worker_pid(self) -> int | None:
        with self._proc_lock:
            if self._proc is not None and self._proc.poll() is None:
                return int(self._proc.pid)
            return None

    @property
    def loaded_engine_id(self) -> str | None:
        with self._proc_lock:
            if self._proc is not None and self._proc.poll() is None:
                return self._loaded_engine_id
            return None

    def _build_command(self) -> tuple[list[str], str]:
        app_dir = str(Path(__file__).resolve().parent.parent)
        if getattr(sys, "frozen", False):
            return [sys.executable, "--builtin-ocr-worker", "--parent-pid", str(os.getpid())], app_dir
        return [sys.executable, "-m", "comic_studio.ocr_builtin_worker", "--parent-pid", str(os.getpid())], app_dir

    def _worker_env(self) -> dict[str, str]:
        env = os.environ.copy()
        app_dir = str(Path(__file__).resolve().parent.parent)
        cur_py_path = env.get("PYTHONPATH", "")
        if app_dir not in cur_py_path.split(os.pathsep):
            env["PYTHONPATH"] = f"{app_dir}{os.pathsep}{cur_py_path}" if cur_py_path else app_dir
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        # Prevent recursive worker spawning inside the worker itself.
        env["COMIC_STUDIO_BUILTIN_WORKER"] = "0"
        if self._force_cpu:
            env["COMIC_STUDIO_FORCE_CPU"] = "1"
        return env

    def _close_streams_locked(self, proc: subprocess.Popen[str]) -> None:
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                with contextlib.suppress(Exception):
                    stream.close()

    def _spawn_locked(self) -> subprocess.Popen[str]:
        with self._proc_lock:
            if self._proc is not None and self._proc.poll() is None:
                return self._proc
            if self._proc is not None:
                self._close_streams_locked(self._proc)
                self._proc = None
                self._loaded_engine_id = None

        self._stderr_tail.clear()
        cmd, cwd = self._build_command()
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
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
        with self._proc_lock:
            self._proc = proc
            self._pages_served = 0

        stderr_tail = self._stderr_tail

        def _drain_stderr() -> None:
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

        err_thread = threading.Thread(target=_drain_stderr, daemon=True)
        err_thread.start()

        banner = ""
        try:
            while proc.stdout is not None:
                line = proc.stdout.readline().strip()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                if msg.get("type") == "ready":
                    banner = line
                    break
        except Exception:
            banner = ""

        if not banner:
            with self._proc_lock:
                if self._proc is proc:
                    self._proc = None
                    self._loaded_engine_id = None
            _kill_proc_tree(proc)
            err_thread.join(timeout=1.0)
            self._close_streams_locked(proc)
            err_hint = "\n".join(stderr_tail)[-600:]
            raise RuntimeError(f"راه‌اندازی پردازشگر داخلی OCR ناموفق بود: {err_hint}")
        return proc

    def reset_cancel(self) -> None:
        self._cancelled.clear()

    def cancel(self) -> None:
        self._cancelled.set()
        with self._proc_lock:
            proc = self._proc
            self._proc = None
            self._loaded_engine_id = None
            self._pages_served = 0
        if proc is not None:
            _kill_proc_tree(proc)
            self._close_streams_locked(proc)

    def stop(self) -> None:
        with self._proc_lock:
            proc = self._proc
            self._proc = None
            self._loaded_engine_id = None
            self._pages_served = 0
        if proc is None:
            return
        with contextlib.suppress(Exception):
            if proc.poll() is None and proc.stdin is not None:
                proc.stdin.write(json.dumps({"cmd": "shutdown"}) + "\n")
                proc.stdin.flush()
                proc.wait(timeout=2.0)
        _kill_proc_tree(proc)
        self._close_streams_locked(proc)

    def _maybe_recycle_locked(self) -> None:
        with self._proc_lock:
            proc = self._proc
            served = self._pages_served
        if proc is None or proc.poll() is not None:
            return
        should_recycle = served >= BUILTIN_WORKER_MAX_PAGES
        if not should_recycle:
            from .ocr_managed import process_rss_mb

            rss = process_rss_mb(int(proc.pid))
            if rss > 0 and rss >= BUILTIN_WORKER_MAX_RSS_MB:
                should_recycle = True
        if should_recycle:
            self.stop()

    def recognize(
        self,
        engine_id: str,
        image: Any,
        language: str,
        contrast: bool = True,
        precise: bool = True,
        min_confidence: float = 0.35,
        *,
        page_mode: str = "auto",
        persian_preprocess: bool = False,
        image_path: Path | str | None = None,
        emit_fn: Callable[[str, str, float | None], None] | None = None,
        is_cancelled_fn: Callable[[], bool] | None = None,
    ) -> list[dict[str, Any]]:
        from .activity import JobCancelledError, emit as global_emit
        from .license_guard import LicenseError
        from .ocr import OcrError

        forward_emit = emit_fn or global_emit

        def _check_abort() -> None:
            if self._cancelled.is_set() or (is_cancelled_fn is not None and is_cancelled_fn()):
                raise JobCancelledError("عملیات OCR به درخواست شما متوقف شد.")

        _check_abort()
        direct_path = Path(image_path) if image_path else None
        owns_tmp = False
        if direct_path is not None and direct_path.is_file():
            target_path = direct_path
        else:
            if image is None:
                raise OcrError("تصویر ورودی برای خواندن متن موجود نیست.")
            with tempfile.NamedTemporaryFile(prefix=f"comic-builtin-{engine_id}-", suffix=".png", delete=False) as tmp:
                target_path = Path(tmp.name)
            owns_tmp = True
            rgb_img = image if getattr(image, "mode", "RGB") == "RGB" else image.convert("RGB")
            try:
                rgb_img.save(target_path, "PNG", compress_level=1)
            finally:
                if rgb_img is not image:
                    rgb_img.close()

        try:
            with self._lock:
                self._cancelled.clear()
                self._maybe_recycle_locked()
                last_crash_hint = ""
                for attempt in range(2):
                    _check_abort()
                    proc = self._spawn_locked()
                    with self._proc_lock:
                        self._loaded_engine_id = engine_id
                    assert proc.stdin is not None and proc.stdout is not None
                    req = {
                        "cmd": "recognize",
                        "engineId": engine_id,
                        "imagePath": str(target_path),
                        "language": language,
                        "contrast": bool(contrast),
                        "precise": bool(precise),
                        "minConfidence": float(min_confidence),
                        "pageMode": str(page_mode),
                        "persianPreprocess": bool(persian_preprocess),
                    }
                    result_payload: dict[str, Any] | None = None
                    try:
                        proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
                        proc.stdin.flush()
                        while True:
                            raw_resp = proc.stdout.readline()
                            if not raw_resp:
                                break
                            raw_resp = raw_resp.strip()
                            if not raw_resp:
                                continue
                            try:
                                msg = json.loads(raw_resp)
                            except Exception:
                                continue
                            mtype = msg.get("type")
                            if mtype == "log":
                                forward_emit(
                                    str(msg.get("message") or ""),
                                    str(msg.get("level") or "info"),
                                    msg.get("progress"),
                                )
                            elif mtype == "result":
                                result_payload = msg
                                break
                    except Exception:
                        result_payload = None

                    _check_abort()
                    if result_payload is not None:
                        with self._proc_lock:
                            if self._proc is proc:
                                self._pages_served += 1
                        if result_payload.get("ok"):
                            return list(result_payload.get("blocks") or [])
                        if result_payload.get("cancelled"):
                            raise JobCancelledError(str(result_payload.get("error") or "عملیات OCR متوقف شد."))
                        err_type = str(result_payload.get("errorType") or "")
                        err_msg = str(result_payload.get("error") or "خطای نامشخص در پردازشگر OCR")
                        if err_type == "LicenseError":
                            raise LicenseError(
                                str(result_payload.get("code") or "LICENSE_REQUIRED"),
                                err_msg,
                                status_code=int(result_payload.get("statusCode") or 402),
                            )
                        raise OcrError(err_msg)

                    # Worker died unexpectedly (e.g., native DirectML / ONNX / PyTorch crash).
                    with self._proc_lock:
                        if self._proc is proc:
                            self._proc = None
                            self._loaded_engine_id = None
                            self._pages_served = 0
                    _kill_proc_tree(proc)
                    self._close_streams_locked(proc)
                    last_crash_hint = ("\n".join(self._stderr_tail))[-400:]
                    if attempt == 0:
                        self._force_cpu = True
                        forward_emit(
                            f"پردازشگر مدل {engine_id} ناگهانی متوقف شد؛ در حال بازیابی خودکار با حالت پایدار CPU…",
                            "warning",
                            None,
                        )
                        continue
                suffix = f": {last_crash_hint}" if last_crash_hint else ""
                raise OcrError(f"پردازشگر مدل {engine_id} به شکل غیرمنتظره‌ای بسته شد{suffix}")
        finally:
            if owns_tmp:
                target_path.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(_worker_main())
