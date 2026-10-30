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
        self._generations: dict[str, int] = {}
        self._stale_timers: dict[str, threading.Timer] = {}
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
            previous = self._stale_timers.pop(client_id, None)
            if previous:
                previous.cancel()
            generation = self._generations.get(client_id, 0) + 1
            self._generations[client_id] = generation
            self._clients[client_id] = time.monotonic()
            timer = threading.Timer(self.stale_after, self._expire, (client_id, generation))
            timer.daemon = True
            self._stale_timers[client_id] = timer
            timer.start()
            return len(self._clients)

    def close(self, client_id: str) -> tuple[int, bool]:
        """Forget one tab; return (remaining tabs, whether it was known)."""
        with self._lock:
            if client_id not in self._clients:
                return len(self._clients), False
            self._clients.pop(client_id, None)
            self._generations.pop(client_id, None)
            timer = self._stale_timers.pop(client_id, None)
            if timer:
                timer.cancel()
            self._schedule_empty_locked()
            return len(self._clients), True

    def _expire(self, client_id: str, generation: int) -> None:
        with self._lock:
            if self._generations.get(client_id) != generation:
                return
            self._generations.pop(client_id, None)
            self._clients.pop(client_id, None)
            self._stale_timers.pop(client_id, None)
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
            for timer in self._stale_timers.values():
                timer.cancel()
            self._stale_timers.clear()
            self._clients.clear()
            self._generations.clear()
