"""Small thread-safe activity feed and context-local progress reporting."""
from __future__ import annotations

import math
import threading
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable, Iterator

Reporter = Callable[[str, str, float | None], None]
_reporter: ContextVar[Reporter | None] = ContextVar("comic_studio_activity_reporter", default=None)
_cancel_signal: ContextVar[threading.Event | None] = ContextVar("comic_studio_cancel_signal", default=None)


class JobCancelledError(RuntimeError):
    """Raised when an active user operation is cooperatively or preemptively cancelled."""


class ActivityLog:
    def __init__(self, limit: int = 160) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=limit)
        self._next_id = 1
        self._lock = threading.RLock()

    def add(self, message: str, kind: str = "info", progress: float | None = None) -> None:
        text = str(message or "").strip()
        if not text:
            return
        progress_val: float | None = None
        if progress is not None:
            raw_progress = float(progress)
            if math.isfinite(raw_progress):
                progress_val = max(0.0, min(1.0, raw_progress))
        with self._lock:
            entry = {
                "id": self._next_id,
                "message": text,
                "kind": kind if kind in {"info", "success", "error", "warning"} else "info",
                "progress": progress_val,
                "time": datetime.now(timezone.utc).isoformat(),
            }
            self._next_id += 1
            self._entries.append(entry)

    def clear(self) -> int:
        """Remove history and return the id at the atomic clear point."""
        with self._lock:
            self._entries.clear()
            return self._next_id - 1

    def since(self, after: int = 0) -> dict[str, Any]:
        with self._lock:
            return {
                "entries": [dict(entry) for entry in self._entries if entry["id"] > after],
                "next": self._next_id - 1,
            }


def is_job_cancelled() -> bool:
    ev = _cancel_signal.get()
    return bool(ev is not None and ev.is_set())


def check_cancelled(message: str = "عملیات توسط کاربر لغو شد.") -> None:
    if is_job_cancelled():
        raise JobCancelledError(message)


def sleep_interruptible(
    seconds: float,
    cancel_event: threading.Event | None = None,
    message: str = "عملیات توسط کاربر لغو شد.",
) -> None:
    delay = max(0.0, float(seconds))
    ctx_ev = _cancel_signal.get()
    if (ctx_ev is not None and ctx_ev.is_set()) or (cancel_event is not None and cancel_event.is_set()):
        raise JobCancelledError(message)
    if delay <= 0.0:
        return
    if cancel_event is not None and ctx_ev is not None and cancel_event is not ctx_ev:
        deadline = threading.Event()
        end_at = datetime.now(timezone.utc).timestamp() + delay
        while True:
            if ctx_ev.is_set() or cancel_event.is_set():
                raise JobCancelledError(message)
            rem = end_at - datetime.now(timezone.utc).timestamp()
            if rem <= 0:
                return
            deadline.wait(timeout=min(0.1, rem))
    active_ev = cancel_event if cancel_event is not None else ctx_ev
    if active_ev is not None:
        if active_ev.wait(timeout=delay):
            raise JobCancelledError(message)
        return
    threading.Event().wait(timeout=delay)


@contextmanager
def cancellation_scope(cancel_event: threading.Event | None) -> Iterator[None]:
    token = _cancel_signal.set(cancel_event)
    try:
        yield
    finally:
        _cancel_signal.reset(token)


def emit(message: str, kind: str = "info", progress: float | None = None) -> None:
    """Report from a worker without changing any OCR/engine public signature."""
    if is_job_cancelled() and kind not in {"warning", "error"}:
        raise JobCancelledError("عملیات توسط کاربر لغو شد.")
    reporter = _reporter.get()
    if reporter:
        reporter(str(message), kind, progress)


@contextmanager
def reporting(reporter: Reporter) -> Iterator[None]:
    token = _reporter.set(reporter)
    try:
        yield
    finally:
        _reporter.reset(token)
