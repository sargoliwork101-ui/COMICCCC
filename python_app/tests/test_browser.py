from __future__ import annotations

import pytest

import comic_studio.browser as browser


def test_prompt_selects_browser_and_new_window():
    answers = iter(["3", "2"])
    printed = []
    selected = browser.ask_preferences(lambda _: next(answers), printed.append)
    assert selected == ("chrome", "new")
    assert any("پنجره" in line for line in printed)


def test_prompt_can_leave_browser_closed():
    selected = browser.ask_preferences(lambda _: "5", lambda _: None)
    assert selected == ("none", "existing")


def test_selected_browser_uses_new_window(monkeypatch):
    calls = []
    class Controller:
        def open(self, url, new):
            calls.append((url, new))
            return True
    monkeypatch.setattr(browser, "browser_command", lambda name: f"{name} %s")
    monkeypatch.setattr(browser.webbrowser, "get", lambda command: Controller())
    browser.open_url("http://127.0.0.1:8765", "edge", "new")
    assert calls == [("http://127.0.0.1:8765", 1)]


def test_existing_browser_uses_new_tab_and_default_is_not_forced(monkeypatch):
    calls = []
    monkeypatch.setattr(browser.webbrowser, "open", lambda url, new: calls.append((url, new)) or True)
    browser.open_url("http://127.0.0.1:8765", "default", "existing")
    assert calls == [("http://127.0.0.1:8765", 2)]


def test_unavailable_selected_browser_is_an_error_not_edge_fallback(monkeypatch):
    monkeypatch.setattr(browser, "browser_command", lambda name: (_ for _ in ()).throw(browser.BrowserError("not installed")))
    with pytest.raises(browser.BrowserError, match="not installed"):
        browser.open_url("http://127.0.0.1:8765", "firefox", "existing")


def test_interactive_launcher_asks_and_passes_both_choices(monkeypatch):
    import comic_studio.__main__ as launcher
    calls = []
    class Tty:
        def isatty(self): return True
    class Timer:
        def __init__(self, delay, callback): self.callback = callback; self.daemon = False
        def start(self): self.callback()
    monkeypatch.setattr(launcher.sys, "stdin", Tty())
    monkeypatch.setattr(launcher.sys, "argv", ["run.py"])
    monkeypatch.setattr(launcher, "ask_preferences", lambda: ("firefox", "new"))
    monkeypatch.setattr(launcher.threading, "Timer", Timer)
    monkeypatch.setattr(launcher, "open_url", lambda url, name, window: calls.append((url, name, window)))
    monkeypatch.setattr(launcher, "run_server", lambda host, port: calls.append("server"))
    launcher.main()
    assert calls[0] == ("http://127.0.0.1:8765", "firefox", "new")
    assert calls[-1] == "server"


def test_no_browser_launch_does_not_ask(monkeypatch):
    import comic_studio.__main__ as launcher
    monkeypatch.setattr(launcher.sys, "argv", ["run.py", "--no-browser"])
    monkeypatch.setattr(launcher, "ask_preferences", lambda: (_ for _ in ()).throw(AssertionError("prompt called")))
    monkeypatch.setattr(launcher, "run_server", lambda host, port: None)
    launcher.main()
