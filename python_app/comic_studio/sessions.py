"""Track browser tabs so the normal launcher can stop with its last tab."""
from __future__ import annotations

import threading
import time
from collections.abc import Callable


class SessionManager:
    def __init__(
        self,
        on_empty: Callable[[], None] | None = None,
        close_grace: float = 2.0,
        stale_after: float = 120.0,
    ) -> None:
        self.on_empty = on_empty
        self.close_grace = close_grace
        self.stale_after = stale_after
        self._clients: dict[str, float] = {}
        self._expiry_timer: threading.Timer | None = None
        self._empty_timer: threading.Timer | None = None
        self._lock = threading.RLock()

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._clients)

    @property
    def shutdown_pending(self) -> bool:
        with self._lock:
            return self._empty_timer is not None

    def _cancel_empty_locked(self) -> None:
        if self._empty_timer:
            self._empty_timer.cancel()
            self._empty_timer = None

    def _cancel_expiry_locked(self) -> None:
        if self._expiry_timer:
            self._expiry_timer.cancel()
            self._expiry_timer = None

    def _ensure_expiry_timer_locked(self, now: float | None = None) -> None:
        if not self._clients:
            self._cancel_expiry_locked()
            return
        if self._expiry_timer is not None:
            return
        cur = time.monotonic() if now is None else now
        next_deadline = min(self._clients.values())
        delay = max(0.001, next_deadline - cur)
        timer = threading.Timer(delay, self._reap_expired)
        timer.daemon = True
        self._expiry_timer = timer
        timer.start()

    def _schedule_empty_locked(self) -> None:
        if self._clients or self._empty_timer or not self.on_empty:
            return
        timer = threading.Timer(self.close_grace, self._shutdown_if_empty)
        timer.daemon = True
        self._empty_timer = timer
        timer.start()

    def heartbeat(self, client_id: str) -> int:
        if not client_id:
            raise ValueError("A browser tab id is required")
        with self._lock:
            self._cancel_empty_locked()
            now = time.monotonic()
            self._clients[client_id] = now + self.stale_after
            self._ensure_expiry_timer_locked(now)
            return len(self._clients)

    def close(self, client_id: str) -> tuple[int, bool]:
        """Forget one tab; return (remaining tabs, whether it was known)."""
        with self._lock:
            if client_id not in self._clients:
                return len(self._clients), False
            self._clients.pop(client_id, None)
            if not self._clients:
                self._cancel_expiry_locked()
                self._schedule_empty_locked()
            return len(self._clients), True

    def _reap_expired(self) -> None:
        with self._lock:
            self._expiry_timer = None
            if not self._clients:
                return
            now = time.monotonic()
            expired = [cid for cid, deadline in self._clients.items() if deadline <= now]
            for cid in expired:
                self._clients.pop(cid, None)
            if self._clients:
                self._ensure_expiry_timer_locked(now)
            elif expired:
                self._schedule_empty_locked()

    def _shutdown_if_empty(self) -> None:
        with self._lock:
            self._empty_timer = None
            if self._clients or not self.on_empty:
                return
            callback = self.on_empty
        callback()

    def stop(self) -> None:
        with self._lock:
            self._cancel_empty_locked()
            self._cancel_expiry_locked()
            self._clients.clear()
