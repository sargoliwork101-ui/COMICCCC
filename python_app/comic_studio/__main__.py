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
    """Return 'free', 'studio' (a live Comic OCR Studio), 'studio-dying' or 'other'.

    Root cause of the "the app does not come up on the first launch" report:
    a Studio instance that is shutting down (its last browser tab was closed)
    keeps the port busy for a moment.  The old launcher could hand the browser
    over to that dying instance - or try to bind the same port and die with
    "address already in use" - so the user saw a dead page until they launched
    the app again.  The probe now tells the two cases apart.
    """
    connect_host = _probe_connect_host(host)
    try:
        with socket.create_connection((connect_host, port), timeout=0.08):
            pass
    except OSError:
        return "free"
    health_url = f"{_format_browser_url(host, port)}/api/health"
    try:
        req = urllib.request.Request(health_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=0.6) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="ignore"))
            if isinstance(payload, dict) and payload.get("name") == APP_NAME:
                return "studio-dying" if payload.get("shutdownPending") else "studio"
    except Exception:
        pass
    return "other"


def _pick_free_port(host: str) -> int:
    bind_host = _probe_connect_host(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((bind_host, 0))
        return int(sock.getsockname()[1])


def _show_startup_error(message: str) -> None:
    """Make a failed start visible.

    The packaged Windows `.exe` runs without a console window, so a message on
    `stderr` would be invisible - a small native box tells the user what went
    wrong instead of the app silently doing nothing.
    """
    print(message, file=sys.stderr, flush=True)
    if os.name != "nt":
        return
    with contextlib.suppress(Exception):
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, str(message), "Comic OCR Studio", 0x10)


def _prepare_listen_socket(sock: socket.socket) -> None:
    """Apply the same safe socket options uvicorn uses for its own server socket.

    On Windows `SO_EXCLUSIVEADDRUSE` prevents another program from stealing the
    port, on other systems `SO_REUSEADDR` allows a quick relaunch to reuse a
    port that is still in `TIME_WAIT`.
    """
    with contextlib.suppress(OSError, AttributeError):
        if os.name == "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)


def _port_can_be_bound(host: str, port: int) -> bool:
    """True when the port can be bound right now (no other process owns it)."""
    bind_host = _probe_connect_host(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            _prepare_listen_socket(sock)
            sock.bind((bind_host, port))
        return True
    except OSError:
        return False


def _wait_for_port_release(host: str, port: int, *, timeout: float = 25.0) -> bool:
    """Wait until a previous instance has released the port.

    The Studio server stops a couple of seconds after its last browser tab is
    closed, so a quick relaunch used to collide with the dying instance.
    """
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        if _port_can_be_bound(host, port):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.25)


def _acquire_listening_socket(host: str, port: int, *, timeout: float = 30.0) -> socket.socket | None:
    """Bind and listen on the port ourselves, waiting for a dying instance to let go.

    Owning the socket removes the "address already in use" crash entirely: the
    port is acquired with retries *before* the web server starts, so a quick
    relaunch can never die with a dead page in the browser.
    """
    bind_host = _probe_connect_host(host)
    family = socket.AF_INET6 if ":" in bind_host else socket.AF_INET
    deadline = time.monotonic() + max(0.0, timeout)
    last_error: OSError | None = None
    while True:
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            _prepare_listen_socket(sock)
            sock.bind((bind_host, port))
            sock.listen(128)
            sock.set_inheritable(True)
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
            if time.monotonic() >= deadline:
                break
            time.sleep(0.25)
    if last_error is not None:
        print(
            f"Could not use port {port} ({last_error}); trying another free port.",
            file=sys.stderr,
            flush=True,
        )
    return None


def _app_answers(host: str, port: int, timeout: float = 0.6) -> bool:
    """True when the studio itself answers on the port with its health JSON.

    A TCP connect only proves that the socket is listening - the app may
    still be starting (or may have died while starting).  The browser must
    not be opened before the app really answers, otherwise the user gets a
    dead page and has to launch the app a second time.
    """
    health_url = f"{_format_browser_url(host, port)}/api/health"
    try:
        req = urllib.request.Request(health_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="ignore"))
            return isinstance(payload, dict) and payload.get("name") == APP_NAME
    except Exception:
        return False


def _open_browser_when_listening(host: str, port: int, callback, timeout: float = 20.0) -> None:
    """Open the browser only once the app really answers on the port.

    The old code opened the browser even when the server had died, which showed
    the user an unreachable page instead of the studio.
    """
    if threading.current_thread() is threading.main_thread():
        callback()
        return
    deadline = time.monotonic() + max(0.1, float(timeout))
    while time.monotonic() < deadline:
        if _app_answers(host, port):
            callback()
            return
        time.sleep(0.05)
    print(
        "Comic OCR Studio did not start listening on the expected port; the browser was not opened.",
        file=sys.stderr,
        flush=True,
    )
    _show_startup_error(
        "Comic OCR Studio could not start listening on its local port, so the browser was not opened.\n"
        "Close other Comic OCR Studio windows and start the app again."
    )


def run_server(host: str, port: int, listening_socket: socket.socket | None = None) -> None:
    """Run one server whose lifetime can follow the last open app tab."""
    from .main import create_app

    try:
        app = create_app()
    except Exception as exc:
        # A failure here used to kill the process silently in the consoleless
        # Windows build, so the user only saw "nothing happens".
        _show_startup_error(
            "Comic OCR Studio could not start because of an internal error.\n"
            f"{type(exc).__name__}: {exc}"
        )
        raise SystemExit(1)
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
        if listening_socket is not None:
            server.run(sockets=[listening_socket])
        else:
            server.run()
    except SystemExit:
        raise
    except Exception as exc:
        _show_startup_error(
            "Comic OCR Studio stopped while starting its local server.\n"
            f"{type(exc).__name__}: {exc}"
        )
        raise
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
        if state == "studio-dying":
            # A previous instance is closing down and still owns the port.
            # Wait for it instead of handing the browser over to a dying
            # server (that showed an empty page) or colliding with it
            # ("address already in use" made the new instance quit at once).
            print("Waiting for the previous Comic OCR Studio instance to release the port...", flush=True)
            if not _wait_for_port_release(args.host, port, timeout=25.0):
                with contextlib.suppress(OSError):
                    port = _pick_free_port(args.host)
        elif state == "other":
            with contextlib.suppress(OSError):
                port = _pick_free_port(args.host)

    # Own the port before anything else: a previous instance that is still
    # shutting down must never make this launch die with "address already in
    # use" while the browser already opened a dead page.
    listening_socket = _acquire_listening_socket(args.host, port, timeout=30.0)
    if listening_socket is None:
        if explicit_port:
            _show_startup_error(
                f"Port {port} is still in use by another program. Close it and start Comic OCR Studio again."
            )
            raise SystemExit(1)
        with contextlib.suppress(OSError):
            port = _pick_free_port(args.host)
        listening_socket = _acquire_listening_socket(args.host, port, timeout=10.0)

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
    run_server(args.host, port, listening_socket)


if __name__ == "__main__":
    main()
