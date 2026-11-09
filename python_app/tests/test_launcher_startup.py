from __future__ import annotations

import socket
import threading
import time

from comic_studio.__main__ import (
    _acquire_listening_socket,
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
    import urllib.request

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
