from __future__ import annotations

import argparse
import sys
import threading

import uvicorn

from .browser import BrowserError, ask_preferences, load_preferences, open_url, save_preferences


def run_server(host: str, port: int) -> None:
    """Run one server whose lifetime can follow the last open app tab."""
    from .main import app

    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, reload=False, access_log=False))
    app.state.sessions.on_empty = lambda: setattr(server, "should_exit", True)
    try:
        server.run()
    finally:
        app.state.sessions.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Comic OCR Studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--browser", choices=["default", "edge", "chrome", "firefox", "none"], default=None,
                        help="Browser to open; overrides the saved preference")
    parser.add_argument("--window", choices=["existing", "new"], default=None,
                        help="Open a tab in the running browser or a new window; overrides the saved preference")
    args = parser.parse_args()
    saved = None if args.no_browser else load_preferences()
    browser = args.browser or (saved[0] if saved else None)
    window = args.window or (saved[1] if saved else None)
    if not args.no_browser and browser != "none" and sys.stdin.isatty() and (browser is None or window is None):
        selected_browser, selected_window = ask_preferences()
        browser = browser or selected_browser
        window = window or selected_window
        try:
            save_preferences(browser, window)
        except OSError as exc:
            print(f"Could not save the browser preference: {exc}", flush=True)
    browser = browser or "default"
    window = window or "existing"
    if not args.no_browser and browser != "none":
        display_host = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
        url = f"http://{display_host}:{args.port}"
        def open_selected_browser() -> None:
            try:
                open_url(url, browser, window)
            except BrowserError as exc:
                print(f"\n{exc}\nThe application is still available at {url}.", flush=True)
        timer = threading.Timer(1.0, open_selected_browser)
        timer.daemon = True
        timer.start()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
