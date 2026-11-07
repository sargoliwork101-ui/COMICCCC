from __future__ import annotations

import argparse
import contextlib
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import urllib.request

import uvicorn

from . import APP_NAME
from .browser import BrowserError, ask_preferences, load_preferences, open_url, save_preferences


def _ensure_std_streams() -> None:
    """Ensure stdout/stderr exist when packaged as a consoleless Windows GUI .exe."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="ignore")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="ignore")


def _probe_connect_host(host: str) -> str:
    raw = host.strip()
    if raw in {"0.0.0.0", ""}:
        return "127.0.0.1"
    if raw in {"::", "[::]"}:
        return "::1"
    if raw.startswith("[") and raw.endswith("]"):
        return raw[1:-1]
    return raw


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


def _probe_port_state(host: str, port: int) -> str:
    """Return 'free', 'studio' (already-running Comic OCR Studio), or 'other'."""
    connect_host = _probe_connect_host(host)
    try:
        with socket.create_connection((connect_host, port), timeout=0.08):
            pass
    except OSError:
        return "free"
    health_url = f"{_format_browser_url(host, port)}/api/health"
    try:
        req = urllib.request.Request(health_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=0.4) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="ignore"))
            if isinstance(payload, dict) and payload.get("name") == APP_NAME:
                return "studio"
    except Exception:
        pass
    return "other"


def _pick_free_port(host: str) -> int:
    bind_host = _probe_connect_host(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((bind_host, 0))
        return int(sock.getsockname()[1])


def _open_browser_when_listening(host: str, port: int, callback) -> None:
    if threading.current_thread() is threading.main_thread():
        callback()
        return
    connect_host = _probe_connect_host(host)
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((connect_host, port), timeout=0.05):
                callback()
                return
        except OSError:
            time.sleep(0.035)
    callback()


def run_server(host: str, port: int) -> None:
    """Run one server whose lifetime can follow the last open app tab."""
    from .main import create_app

    app = create_app()
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
    _ensure_std_streams()
    parser = argparse.ArgumentParser(description="Comic OCR Studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--browser", choices=["default", "edge", "chrome", "firefox", "none"], default=None,
                        help="Browser to open; overrides the saved preference")
    parser.add_argument("--window", choices=["existing", "new"], default=None,
                        help="Open a tab in the running browser or a new window; overrides the saved preference")
    explicit_port = any(arg == "--port" or arg.startswith("--port=") for arg in sys.argv[1:])
    args = parser.parse_args()
    saved = None if args.no_browser else load_preferences()
    browser = args.browser or (saved[0] if saved else None)
    window = args.window or (saved[1] if saved else None)
    has_tty = bool(sys.stdin is not None and getattr(sys.stdin, "isatty", lambda: False)())
    if not args.no_browser and browser != "none" and has_tty and (browser is None or window is None):
        selected_browser, selected_window = ask_preferences()
        browser = browser or selected_browser
        window = window or selected_window
        try:
            save_preferences(browser, window)
        except OSError as exc:
            print(f"Could not save the browser preference: {exc}", flush=True)
    browser = browser or "default"
    window = window or "existing"

    port = args.port
    if not explicit_port:
        state = _probe_port_state(args.host, port)
        if state == "studio":
            url = _format_browser_url(args.host, port)
            if not args.no_browser and browser != "none":
                with contextlib.suppress(BrowserError):
                    open_url(url, browser, window)
            return
        if state == "other":
            with contextlib.suppress(OSError):
                port = _pick_free_port(args.host)

    if not args.no_browser and browser != "none":
        url = _format_browser_url(args.host, port)

        def open_selected_browser() -> None:
            try:
                open_url(url, browser, window)
            except BrowserError as exc:
                print(f"\n{exc}\nThe application is still available at {url}.", flush=True)

        opener = threading.Timer(
            0.05,
            lambda: _open_browser_when_listening(args.host, port, open_selected_browser),
        )
        opener.daemon = True
        opener.start()
    run_server(args.host, port)


if __name__ == "__main__":
    main()
