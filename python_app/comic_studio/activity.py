"""Small thread-safe activity feed and context-local progress reporting."""
from __future__ import annotations

import threading
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable, Iterator

Reporter = Callable[[str, str, float | None], None]
_reporter: ContextVar[Reporter | None] = ContextVar("comic_studio_activity_reporter", default=None)


class ActivityLog:
    def __init__(self, limit: int = 160) -> None:
        self._entries: deque[dict[str, Any]] = deque(maxlen=limit)
        self._next_id = 1
        self._lock = threading.RLock()

    def add(self, message: str, kind: str = "info", progress: float | None = None) -> None:
        text = str(message or "").strip()
        if not text:
            return
        with self._lock:
            entry = {
                "id": self._next_id,
                "message": text,
                "kind": kind if kind in {"info", "success", "error", "warning"} else "info",
                "progress": max(0.0, min(1.0, float(progress))) if progress is not None else None,
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


def emit(message: str, kind: str = "info", progress: float | None = None) -> None:
    """Report from a worker without changing any OCR/engine public signature."""
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
