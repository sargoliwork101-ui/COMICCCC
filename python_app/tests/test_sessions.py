from __future__ import annotations

import time

from comic_studio.sessions import SessionManager


def test_last_tab_close_is_graceful_and_reload_cancels_shutdown():
    calls = []
    sessions = SessionManager(lambda: calls.append("shutdown"), close_grace=0.04, stale_after=10)
    try:
        sessions.heartbeat("tab-one")
        sessions.heartbeat("tab-two")
        assert sessions.close("tab-one") == (1, True)
        assert calls == []
        assert sessions.close("tab-two") == (0, True)
        assert sessions.shutdown_pending
        # A reload reuses the tab id and its first heartbeat cancels the close timer.
        sessions.heartbeat("tab-two")
        assert not sessions.shutdown_pending
        time.sleep(0.07)
        assert calls == []
        sessions.close("tab-two")
        time.sleep(0.09)
        assert calls == ["shutdown"]
    finally:
        sessions.stop()


def test_unknown_or_one_of_several_tabs_cannot_stop_the_server():
    calls = []
    sessions = SessionManager(lambda: calls.append("shutdown"), close_grace=0.01, stale_after=10)
    try:
        assert sessions.close("unknown-tab") == (0, False)
        sessions.heartbeat("tab-one")
        sessions.heartbeat("tab-two")
        sessions.close("tab-one")
        time.sleep(0.04)
        assert calls == []
        assert sessions.active_count == 1
    finally:
        sessions.stop()


def test_stale_tab_expires_and_repeated_heartbeats_reuse_single_timer():
    calls = []
    sessions = SessionManager(
        lambda: calls.append("shutdown"), close_grace=0.02, stale_after=0.06, abandon_after=5.0
    )
    try:
        sessions.heartbeat("tab-1")
        first_timer = sessions._expiry_timer
        assert first_timer is not None
        for _ in range(10):
            sessions.heartbeat("tab-1")
        # Repeated heartbeats update monotonic deadline in O(1) without spawning new Timer threads.
        assert sessions._expiry_timer is first_timer
        time.sleep(0.14)
        # The tab went silent: it is no longer active, but it never asked to leave.
        assert sessions.active_count == 0
        assert sessions.silent_count == 1
        assert calls == []
    finally:
        sessions.stop()


def test_v430_a_frozen_background_tab_never_stops_the_local_server():
    """v4.30 root cause: a tab that the browser freezes in the background is not a closed tab.

    Chrome stops every timer of a background tab after a few minutes.  The old
    code treated such a silent tab exactly like a closed one and stopped the
    whole local server, so the user came back to a dead page and had to close
    and launch the app again.
    """
    calls = []
    sessions = SessionManager(
        lambda: calls.append("shutdown"), close_grace=0.02, stale_after=0.05, abandon_after=30.0
    )
    try:
        sessions.heartbeat("frozen-tab")
        time.sleep(0.12)
        assert sessions.active_count == 0
        assert sessions.silent_count == 1
        # The server is still alive: a silent tab must not stop it.
        time.sleep(0.15)
        assert calls == []
        assert not sessions.shutdown_pending
        # The tab wakes up (the user comes back to the window) and works again.
        sessions.heartbeat("frozen-tab")
        assert sessions.active_count == 1
        assert sessions.silent_count == 0
        assert calls == []
    finally:
        sessions.stop()


def test_v430_an_explicit_close_after_a_silent_period_still_stops_the_server():
    """The browser beacon is the only reliable 'the user left' signal."""
    calls = []
    sessions = SessionManager(
        lambda: calls.append("shutdown"), close_grace=0.02, stale_after=0.05, abandon_after=30.0
    )
    try:
        sessions.heartbeat("tab-1")
        time.sleep(0.12)
        assert sessions.silent_count == 1
        assert sessions.close("tab-1") == (0, True)
        time.sleep(0.08)
        assert calls == ["shutdown"]
    finally:
        sessions.stop()


def test_v430_the_server_gives_up_only_after_the_abandon_grace():
    """A browser that crashed (no beacon at all) must not keep the server forever."""
    calls = []
    sessions = SessionManager(
        lambda: calls.append("shutdown"), close_grace=0.02, stale_after=0.05, abandon_after=0.10
    )
    try:
        sessions.heartbeat("tab-1")
        time.sleep(0.12)
        assert calls == []
        time.sleep(0.16)
        assert calls == ["shutdown"]
    finally:
        sessions.stop()
