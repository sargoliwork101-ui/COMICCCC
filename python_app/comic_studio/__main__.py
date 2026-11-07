from __future__ import annotations

import argparse
import ipaddress
import os
import sys
import threading

import uvicorn

from .browser import BrowserError, ask_preferences, load_preferences, open_url, save_preferences


def _format_browser_url(host: str, port: int) -> str:
    raw = host.strip()
    if raw == "0.0.0.0":
        display_host = "127.0.0.1"
    elif raw in {"::", "[::]"}:
        display_host = "[::1]"
    elif ":" in raw and not raw.startswith("["):
        display_host = f"[{raw}]"
    else:
        display_host = raw
    return f"http://{display_host}:{port}"


def run_server(host: str, port: int) -> None:
    """Run one server whose lifetime can follow the last open app tab."""
    from .main import app

    stripped_host = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        local_bind = stripped_host.lower() == "localhost" or ipaddress.ip_address(stripped_host).is_loopback
    except ValueError:
        local_bind = False
    if not local_bind:
        if os.environ.get("COMIC_STUDIO_ACCESS_PASSWORD"):
            print("Network access requires HTTP Basic authentication. Use HTTPS or a trusted VPN; plain HTTP exposes the password.", file=sys.stderr, flush=True)
        else:
            print("Remote clients are denied by default. Set COMIC_STUDIO_ACCESS_PASSWORD (20+ characters) to enable authenticated access; use HTTPS or a trusted VPN.", file=sys.stderr, flush=True)
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
        url = _format_browser_url(args.host, args.port)
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
