"""Explicit browser and window selection for the interactive launcher."""
from __future__ import annotations

import os
import shutil
import webbrowser
from pathlib import Path
from typing import Callable


class BrowserError(RuntimeError):
    pass


BROWSER_LABELS = {
    "default": "مرورگر پیش‌فرض سیستم",
    "edge": "Microsoft Edge",
    "chrome": "Google Chrome",
    "firefox": "Mozilla Firefox",
    "none": "بدون بازکردن مرورگر",
}


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
    raise BrowserError(f"{BROWSER_LABELS.get(browser, browser)} پیدا نشد؛ آن را نصب کنید یا مرورگر دیگری انتخاب کنید.")


def open_url(url: str, browser: str = "default", window: str = "existing") -> None:
    if browser == "none":
        return
    if window not in {"existing", "new"}:
        raise BrowserError("نوع پنجرهٔ مرورگر نامعتبر است.")
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
        raise BrowserError(f"بازکردن مرورگر ناموفق بود: {exc}") from exc
    if opened is False:
        raise BrowserError("مرورگر انتخاب‌شده نشانی برنامه را نپذیرفت.")


def ask_preferences(
    input_fn: Callable[[str], str] = input,
    print_fn: Callable[[str], None] = print,
) -> tuple[str, str]:
    print_fn("\nمرورگر برای بازکردن Comic OCR Studio را انتخاب کنید:")
    choices = [("1", "default"), ("2", "edge"), ("3", "chrome"), ("4", "firefox"), ("5", "none")]
    for key, browser in choices:
        print_fn(f"  {key}. {BROWSER_LABELS[browser]}")
    while True:
        answer = input_fn("شمارهٔ مرورگر [1]: ").strip() or "1"
        selected = dict(choices).get(answer)
        if selected:
            break
        print_fn("شماره نامعتبر است؛ یکی از 1 تا 5 را وارد کنید.")
    if selected == "none":
        return selected, "existing"
    print_fn("\nبرنامه کجا باز شود؟")
    print_fn("  1. زبانه‌ای در همان مرورگرِ باز (در صورت اجرا بودن)")
    print_fn("  2. پنجرهٔ جدید")
    while True:
        answer = input_fn("شمارهٔ حالت بازشدن [1]: ").strip() or "1"
        if answer in {"1", "2"}:
            return selected, "new" if answer == "2" else "existing"
        print_fn("شماره نامعتبر است؛ 1 یا 2 را وارد کنید.")
