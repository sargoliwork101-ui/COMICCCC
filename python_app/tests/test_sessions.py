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
