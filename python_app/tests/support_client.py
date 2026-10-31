"""Test clients with explicit peer IPs, compatible with older Starlette."""
from fastapi.testclient import TestClient


def scoped_client(app, *, peer=('127.0.0.1', 50000), base_url='http://127.0.0.1', **options):
    async def with_peer(scope, receive, send):
        if scope['type'] in {'http', 'websocket'}:
            scope = dict(scope)
            scope['client'] = peer
        await app(scope, receive, send)
    client = TestClient(with_peer, base_url=base_url, **options)
    client.app = app  # Keep tests’ access to app.state; transport retains with_peer.
    return client
