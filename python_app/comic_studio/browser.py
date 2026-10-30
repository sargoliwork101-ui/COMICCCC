"""Explicit browser and window selection for the interactive launcher."""
from __future__ import annotations

import json
import os
import shutil
import webbrowser
from pathlib import Path
from typing import Callable

from .paths import data_dir


class BrowserError(RuntimeError):
    pass


BROWSER_LABELS = {
    "default": "System default browser",
    "edge": "Microsoft Edge",
    "chrome": "Google Chrome",
    "firefox": "Mozilla Firefox",
    "none": "Do not open a browser",
}
WINDOW_MODES = {"existing", "new"}


def load_preferences() -> tuple[str, str] | None:
    """Return the saved launcher choice, ignoring missing or invalid settings."""
    path = data_dir() / "browser-preferences.json"
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(values, dict):
        return None
    selected = values.get("browser")
    window = values.get("window")
    if selected not in BROWSER_LABELS or window not in WINDOW_MODES:
        return None
    return selected, window


def save_preferences(browser: str, window: str) -> None:
    """Persist one explicit interactive choice for later launches."""
    if browser not in BROWSER_LABELS or window not in WINDOW_MODES:
        raise ValueError("Invalid browser preferences")
    path = data_dir() / "browser-preferences.json"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps({"browser": browser, "window": window}, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _windows_candidates(browser: str) -> list[Path]:
    roots = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")),
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")),
        Path(os.environ.get("LocalAppData", str(Path.home() / "AppData" / "Local"))),
    ]
    relative = {
        "edge": [r"Microsoft\Edge\Application\msedge.exe"],
        "chrome": [r"Google\Chrome\Application\chrome.exe"],
        "firefox": [r"Mozilla Firefox\firefox.exe"],
    }.get(browser, [])
    return [root / name for root in roots for name in relative]


def browser_command(browser: str) -> str:
    """Return a webbrowser command, never silently substituting another browser."""
    if browser == "default":
        return ""
    if os.name == "nt":
        for candidate in _windows_candidates(browser):
            if candidate.is_file():
                return f'"{candidate}" %s'
    aliases = {
        "edge": ["microsoft-edge", "microsoft-edge-stable", "msedge", "edge"],
        "chrome": ["google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"],
        "firefox": ["firefox"],
    }.get(browser, [])
    for alias in aliases:
        executable = shutil.which(alias)
        if executable:
            return f'"{executable}" %s'
    raise BrowserError(f"{BROWSER_LABELS.get(browser, browser)} was not found. Install it or choose another browser.")


def open_url(url: str, browser: str = "default", window: str = "existing") -> None:
    if browser == "none":
        return
    if window not in {"existing", "new"}:
        raise BrowserError("Invalid browser window mode.")
    # new=2 asks the running browser for a tab; new=1 asks for a new window.
    new = 1 if window == "new" else 2
    try:
        if browser == "default":
            opened = webbrowser.open(url, new=new)
        else:
            opened = webbrowser.get(browser_command(browser)).open(url, new=new)
    except BrowserError:
        raise
    except Exception as exc:
        raise BrowserError(f"Could not open the browser: {exc}") from exc
    if opened is False:
        raise BrowserError("The selected browser did not open the application URL.")


def ask_preferences(
    input_fn: Callable[[str], str] = input,
    print_fn: Callable[[str], None] = print,
) -> tuple[str, str]:
    print_fn("\nWhich browser should open Comic OCR Studio?")
    choices = [("1", "default"), ("2", "edge"), ("3", "chrome"), ("4", "firefox"), ("5", "none")]
    for key, browser in choices:
        print_fn(f"  {key}. {BROWSER_LABELS[browser]}")
    print_fn("Your choice will be saved and used on the next launch.")
    while True:
        answer = input_fn("Browser number [1]: ").strip() or "1"
        selected = dict(choices).get(answer)
        if selected:
            break
        print_fn("Invalid choice. Enter a number from 1 to 5.")
    if selected == "none":
        return selected, "existing"
    print_fn("\nWhere should the application open?")
    print_fn("  1. A new tab in the running browser")
    print_fn("  2. A new browser window")
    while True:
        answer = input_fn("Window mode [1]: ").strip() or "1"
        if answer in {"1", "2"}:
            return selected, "new" if answer == "2" else "existing"
        print_fn("Invalid choice. Enter 1 or 2.")
