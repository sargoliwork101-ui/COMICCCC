from __future__ import annotations

import contextlib
import socket
import threading
import time

from comic_studio.__main__ import (
    _acquire_listening_socket,
    _app_answers,
    _open_browser_when_listening,
    _probe_port_state,
    _wait_for_port_release,
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_v429_launcher_waits_for_a_dying_instance_instead_of_dying_with_address_in_use():
    """v4.29: relaunching right after closing the app must not break the new launch.

    Root cause: the server keeps the port for a couple of seconds after its last
    browser tab is closed.  The old launcher either handed the browser over to
    that dying instance (empty page) or tried to bind the same port and quit
    with "address already in use", so the app "did not come up" until the user
    launched it a second time.
    """
    port = _free_port()
    # Simulate the previous instance: it still owns the listening socket.
    dying = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    dying.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    dying.bind(("127.0.0.1", port))
    dying.listen(8)

    acquired: list[socket.socket] = []
    released = threading.Event()

    def release_soon() -> None:
        time.sleep(0.6)
        dying.close()
        released.set()

    threading.Thread(target=release_soon, daemon=True).start()

    try:
        sock = _acquire_listening_socket("127.0.0.1", port, timeout=15.0)
        assert sock is not None, "the launcher must take over the port once the old instance releases it"
        acquired.append(sock)
        assert released.is_set()
        # The new instance really serves on that port.
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass
    finally:
        for sock in acquired:
            sock.close()
        try:
            dying.close()
        except OSError:
            pass


def test_v429_probe_tells_a_dying_studio_instance_apart_from_a_live_one():
    """The launcher must not hand the browser over to an instance that is closing."""
    import json
    import threading

    port = _free_port()
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(8)

    def serve(payload: dict) -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            try:
                body = json.dumps(payload).encode()
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                    + str(len(body)).encode()
                    + b"\r\n\r\n"
                    + body
                )
            except OSError:
                pass
            finally:
                conn.close()

    payload = {"name": "Comic OCR Studio", "version": "4.29", "shutdownPending": True}
    worker = threading.Thread(target=serve, args=(payload,), daemon=True)
    worker.start()
    try:
        state = _probe_port_state("127.0.0.1", port)
        assert state == "studio-dying", f"expected studio-dying, got {state}"
        payload["shutdownPending"] = False
        assert _probe_port_state("127.0.0.1", port) == "studio"
    finally:
        server.close()


def test_v429_wait_for_port_release_returns_when_the_port_is_free():
    port = _free_port()
    assert _wait_for_port_release("127.0.0.1", port, timeout=2.0) is True


def _serve_health(port: int, payload: dict) -> socket.socket:
    """A tiny HTTP server that answers with the given JSON payload."""
    import json

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(8)

    def serve() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            try:
                body = json.dumps(payload).encode()
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                    + str(len(body)).encode()
                    + b"\r\n\r\n"
                    + body
                )
            except OSError:
                pass
            finally:
                conn.close()

    threading.Thread(target=serve, daemon=True).start()
    return server


def test_v430_the_browser_waits_for_the_app_to_answer_not_only_for_the_socket():
    """Root cause: a listening socket is not the same as a working app.

    The launcher used to open the browser as soon as the TCP port accepted a
    connection.  When the app failed while starting, the user still got a dead
    page and had to launch the studio a second time.
    """
    port = _free_port()
    opened = threading.Event()
    # 1) Nothing is listening at all.
    assert _app_answers("127.0.0.1", port) is False

    # 2) A socket listens but never answers - the browser must wait.
    silent = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    silent.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    silent.bind(("127.0.0.1", port))
    silent.listen(8)

    def _hold() -> None:
        while True:
            try:
                conn, _ = silent.accept()
            except OSError:
                return
            with contextlib.suppress(OSError):
                conn.close()

    threading.Thread(target=_hold, daemon=True).start()
    try:
        assert _app_answers("127.0.0.1", port) is False
        worker = threading.Thread(
            target=_open_browser_when_listening,
            args=("127.0.0.1", port, opened.set, 1.0),
            daemon=True,
        )
        worker.start()
        worker.join(timeout=3.0)
        assert not opened.is_set(), "the browser must not open before the app answers"
    finally:
        silent.close()

    # 3) The app answers with its health payload - now the browser may open.
    live_port = _free_port()
    server = _serve_health(live_port, {"name": "Comic OCR Studio", "version": "4.46"})
    try:
        assert _app_answers("127.0.0.1", live_port) is True
        worker = threading.Thread(
            target=_open_browser_when_listening,
            args=("127.0.0.1", live_port, opened.set, 3.0),
            daemon=True,
        )
        worker.start()
        worker.join(timeout=5.0)
        assert opened.is_set(), "the browser must open once the app answers"
    finally:
        server.close()
