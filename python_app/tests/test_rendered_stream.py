"""A render replacement must not mix Content-Length and body generations."""
import asyncio
import os

import anyio
import pytest
from comic_studio.main import _RenderedImageResponse


def test_rendered_stream_uses_open_file_size_not_stale_path_stat(tmp_path, monkeypatch):
    path = tmp_path / 'page-edited.png'
    old = b'old'
    new = b'new generation' * 20000
    path.write_bytes(old)
    response = _RenderedImageResponse(path)
    # Replacement after response construction but before its ASGI invocation.
    path.write_bytes(new)
    real_open = anyio.open_file
    reads = []
    closed = []

    async def tracked_open(*args, **kwargs):
        file = await real_open(*args, **kwargs)
        class Tracked:
            def fileno(self):
                return file.fileno()
            async def read(self, size):
                reads.append(size)
                return await file.read(size)
            async def aclose(self):
                await file.aclose()
                closed.append(True)
        return Tracked()

    monkeypatch.setattr(anyio, 'open_file', tracked_open)
    sent = []
    async def send(message):
        sent.append(message)
    async def receive():
        return {'type': 'http.request'}
    asyncio.run(response({'type': 'http', 'method': 'GET', 'asgi': {'spec_version': '2.4'}}, receive, send))
    assert dict(sent[0]['headers'])[b'content-length'] == str(len(new)).encode()
    assert b''.join(m.get('body', b'') for m in sent[1:]) == new
    assert max(reads) <= 65536
    assert closed == [True]


@pytest.mark.skipif(os.name == 'nt', reason='Windows sharing prevents replacing open files')
def test_rendered_stream_keeps_generation_if_replaced_after_open(tmp_path, monkeypatch):
    path = tmp_path / 'page-edited.png'
    original = b'original' * 10000
    path.write_bytes(original)
    real_open = anyio.open_file
    async def replace_after_open(*args, **kwargs):
        file = await real_open(*args, **kwargs)
        replacement = tmp_path / 'replacement.png'
        replacement.write_bytes(b'new')
        os.replace(replacement, path)
        return file
    monkeypatch.setattr(anyio, 'open_file', replace_after_open)
    sent = []
    async def send(message):
        sent.append(message)
    async def receive():
        return {'type': 'http.request'}
    asyncio.run(_RenderedImageResponse(path)({'type': 'http', 'method': 'GET', 'asgi': {'spec_version': '2.4'}}, receive, send))
    assert int(dict(sent[0]['headers'])[b'content-length']) == len(original)
    assert b''.join(m.get('body', b'') for m in sent[1:]) == original
