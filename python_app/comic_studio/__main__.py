from __future__ import annotations

import argparse
import sys
import threading

import uvicorn

from .browser import BrowserError, ask_preferences, open_url


def main() -> None:
    parser = argparse.ArgumentParser(description="Comic OCR Studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--browser", choices=["default", "edge", "chrome", "firefox", "none"], default=None,
                        help="Browser to open; interactive launch asks when omitted")
    parser.add_argument("--window", choices=["existing", "new"], default=None,
                        help="Open a tab in the running browser or a new window")
    args = parser.parse_args()
    browser = args.browser
    window = args.window
    if not args.no_browser and browser != "none" and sys.stdin.isatty() and (browser is None or window is None):
        selected_browser, selected_window = ask_preferences()
        browser = browser or selected_browser
        window = window or selected_window
    browser = browser or "default"
    window = window or "existing"
    if not args.no_browser and browser != "none":
        display_host = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
        url = f"http://{display_host}:{args.port}"
        def open_selected_browser() -> None:
            try:
                open_url(url, browser, window)
            except BrowserError as exc:
                print(f"\n{exc}\nبرنامه همچنان روی {url} در دسترس است.", flush=True)
        timer = threading.Timer(1.0, open_selected_browser)
        timer.daemon = True
        timer.start()
    uvicorn.run("comic_studio.main:app", host=args.host, port=args.port, reload=False, access_log=False)


if __name__ == "__main__":
    main()
