"""Track browser tabs so the normal launcher can stop with its last tab.

Root cause of the "the app stops working while I am away" class of bugs:
a browser tab that is in the background is throttled - and after a few
minutes Chrome even *freezes* it, which stops every timer in the page.  The
old code treated such a silent tab exactly like a closed tab and stopped the
whole local server, so when the user came back to their tab the app was a
dead page and the only way out was to close and launch everything again.

The rules are now:

* a tab that heartbeats is **alive**;
* a tab that stops heartbeating is **silent** - it may be frozen, throttled
  or crashed, so it must never stop the server on its own;
* only an explicit close (the browser beacon) removes a tab for good, and
  the server stops only when no alive *and* no silent tab is left;
* if every tab stays silent, the server waits ``abandon_after`` seconds for
  the browser to come back before it finally stops.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable


class SessionManager:
    def __init__(
        self,
        on_empty: Callable[[], None] | None = None,
        close_grace: float = 2.0,
        stale_after: float = 180.0,
        abandon_after: float = 900.0,
    ) -> None:
        self.on_empty = on_empty
        self.close_grace = close_grace
        self.stale_after = stale_after
        self.abandon_after = abandon_after
        # Alive tabs: client id -> monotonic deadline of the next heartbeat.
        self._clients: dict[str, float] = {}
        # Silent tabs: client id -> monotonic deadline after which the tab is
        # considered gone for good.  They keep the server alive meanwhile.
        self._silent: dict[str, float] = {}
        self._expiry_timer: threading.Timer | None = None
        self._empty_timer: threading.Timer | None = None
        self._abandon_timer: threading.Timer | None = None
        self._lock = threading.RLock()

    @property
    def active_count(self) -> int:
        """Number of tabs that heartbeated recently."""
        with self._lock:
            return len(self._clients)

    @property
    def silent_count(self) -> int:
        """Number of tabs that went quiet (frozen or crashed) but may return."""
        with self._lock:
            return len(self._silent)

    @property
    def known_count(self) -> int:
        with self._lock:
            return len(self._clients) + len(self._silent)

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

    def _cancel_abandon_locked(self) -> None:
        if self._abandon_timer:
            self._abandon_timer.cancel()
            self._abandon_timer = None

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
        if self._clients or self._silent or self._empty_timer or not self.on_empty:
            return
        timer = threading.Timer(self.close_grace, self._shutdown_if_empty)
        timer.daemon = True
        self._empty_timer = timer
        timer.start()

    def _schedule_abandon_locked(self, now: float | None = None) -> None:
        """Wait for a silent tab to wake up before the server gives up."""
        cur = time.monotonic() if now is None else now
        expired = [cid for cid, deadline in self._silent.items() if deadline <= cur]
        for cid in expired:
            self._silent.pop(cid, None)
        if self._clients:
            self._cancel_abandon_locked()
            return
        if not self._silent:
            self._cancel_abandon_locked()
            self._schedule_empty_locked()
            return
        self._cancel_abandon_locked()
        delay = max(0.05, min(self._silent.values()) - cur)
        timer = threading.Timer(delay, self._abandon_if_empty)
        timer.daemon = True
        self._abandon_timer = timer
        timer.start()

    def heartbeat(self, client_id: str) -> int:
        if not client_id:
            raise ValueError("شناسهٔ زبانهٔ مرورگر لازم است.")
        with self._lock:
            self._cancel_empty_locked()
            self._cancel_abandon_locked()
            now = time.monotonic()
            self._clients[client_id] = now + self.stale_after
            # A tab that comes back is alive again - it is no longer silent.
            self._silent.pop(client_id, None)
            self._ensure_expiry_timer_locked(now)
            return len(self._clients)

    def close(self, client_id: str) -> tuple[int, bool]:
        """Forget one tab; return (remaining tabs, whether it was known)."""
        with self._lock:
            known = client_id in self._clients or client_id in self._silent
            if not known:
                # An unknown tab must never be able to stop a running server.
                return len(self._clients), False
            self._clients.pop(client_id, None)
            self._silent.pop(client_id, None)
            if not self._clients:
                self._cancel_expiry_locked()
                if self._silent:
                    self._schedule_abandon_locked()
                else:
                    self._schedule_empty_locked()
            return len(self._clients), True

    def _reap_expired(self) -> None:
        """A silent tab becomes 'possibly alive' instead of stopping the server."""
        with self._lock:
            self._expiry_timer = None
            if not self._clients:
                return
            now = time.monotonic()
            expired = [cid for cid, deadline in self._clients.items() if deadline <= now]
            for cid in expired:
                self._clients.pop(cid, None)
                self._silent[cid] = now + self.abandon_after
            if self._clients:
                self._ensure_expiry_timer_locked(now)
            else:
                self._schedule_abandon_locked(now)

    def _abandon_if_empty(self) -> None:
        with self._lock:
            self._abandon_timer = None
            if self._clients:
                return
            now = time.monotonic()
            expired = [cid for cid, deadline in self._silent.items() if deadline <= now]
            for cid in expired:
                self._silent.pop(cid, None)
            if self._silent:
                self._schedule_abandon_locked(now)
                return
            self._schedule_empty_locked()

    def _shutdown_if_empty(self) -> None:
        with self._lock:
            self._empty_timer = None
            if self._clients or self._silent or not self.on_empty:
                return
            callback = self.on_empty
        callback()

    def stop(self) -> None:
        with self._lock:
            self._cancel_empty_locked()
            self._cancel_expiry_locked()
            self._cancel_abandon_locked()
            self._clients.clear()
            self._silent.clear()
