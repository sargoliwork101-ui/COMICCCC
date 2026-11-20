from __future__ import annotations

import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image
import pytest

from comic_studio.activity import JobCancelledError
from comic_studio.ocr import EngineRegistry, OcrError, RapidEngine
from comic_studio.rapid_process import RapidProcess


FAKE_WORKER = r'''
import json, os, sys, time
from PIL import Image
for line in sys.stdin:
    req = json.loads(line)
    if req['language'] == 'crash' or (os.environ.get('RAPID_TEST_CRASH_FILE') and os.path.exists(os.environ['RAPID_TEST_CRASH_FILE'])):
        print('native crash evidence', file=sys.stderr, flush=True)
        time.sleep(.05)
        os._exit(73)
    if req['language'] == 'hang':
        print('entered inference', file=sys.stderr, flush=True)
        time.sleep(60)
    with Image.open(req['path']) as im:
        assert im.width > 0 and im.height > 0
    result = ['line', .9] if req['method'] == 'line' else [dict(text=str(os.getpid()), confidence=.9, polygon=[[1,2],[3,2],[3,4],[1,4]])]
    print(json.dumps(dict(ok=True, result=result, using_gpu=False)), flush=True)
'''


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('COMIC_STUDIO_DATA', str(tmp_path / 'data'))
    real_popen = subprocess.Popen
    def popen(command, **kwargs):
        return real_popen([sys.executable, '-u', '-c', FAKE_WORKER], **kwargs)
    monkeypatch.setattr('comic_studio.rapid_process.subprocess.Popen', popen)
    worker = RapidProcess('v6')
    try:
        yield worker
    finally:
        worker.close()


def test_registry_isolates_both_pp_models():
    registry = EngineRegistry()
    for name in ('rapidocr-v5', 'rapidocr-v6'):
        engine = registry.get(name)
        assert engine._remote is not None
        with engine.configure_batch(36) as slots:
            assert slots == 1
        assert engine.worker_pid is None


def test_36_pages_one_process_and_line_crop(client):
    with Image.new('RGB', (64, 80), 'white') as image:
        texts = [client.call(image, 'eng')[0].text for _ in range(36)]
        assert len(set(texts)) == 1
        pid = client.pid
        assert int(texts[0]) == pid and pid != os.getpid()
        assert client.call(image, 'eng', method='line') == ('line', .9)
    client.close()
    assert client.pid is None


def test_native_exit_is_reported_without_replay_or_parent_exit(client, tmp_path):
    with Image.new('RGB', (64, 80)) as image:
        completed = client.call(image, 'eng')
        old = client.pid
        with pytest.raises(OcrError, match='73'):
            client.call(image, 'crash')
        assert completed[0].text == str(old)
        assert client.pid is None
        log = (tmp_path / 'data' / 'logs' / 'rapid-worker.log').read_text()
        assert '73' in log and 'native crash evidence' in log
        # A later explicit request starts a new model process; failed request
        # was not silently re-run or turned into an empty successful result.
        assert client.call(image, 'eng')[0].text != str(old)


def test_cancel_interrupts_blocked_inference_and_reaps_process(client):
    with Image.new('RGB', (64, 80)) as image:
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(client.call, image, 'hang')
            deadline = time.monotonic() + 10
            while 'entered inference' not in client.tail:
                assert time.monotonic() < deadline
                time.sleep(.01)
            client.cancel()
            with pytest.raises(JobCancelledError):
                future.result(timeout=5)
        assert client.pid is None


@pytest.mark.real_ocr
@pytest.mark.skipif(os.environ.get('COMIC_STUDIO_REAL_OCR_MEMORY') != '1', reason='real model opt-in')
def test_real_worker_matches_direct_and_survives_32_pages():
    from PIL import ImageDraw
    direct = RapidEngine('rapidocr-v6', 'v6')
    remote = RapidEngine('rapidocr-v6', 'v6', isolated=True)
    direct._force_cpu = remote._force_cpu = True
    try:
        with Image.new('RGB', (640, 320), 'white') as image:
            ImageDraw.Draw(image).text((30, 80), 'Hello world memory test', fill='black', font_size=30)
            expected = direct.recognize(image, 'eng')
            assert expected
            direct.unload()
            initial_pid = None
            for _ in range(32):
                actual = remote.recognize(image, 'eng')
                assert actual == expected
                initial_pid = initial_pid or remote.worker_pid
                assert remote.worker_pid == initial_pid
    finally:
        direct.unload()
        remote.unload()
    assert remote.worker_pid is None


def test_api_native_crash_keeps_server_and_saved_page_alive(client, tmp_path, monkeypatch):
    import io
    from support_client import scoped_client
    from comic_studio.main import create_app
    marker = tmp_path / 'crash-marker'
    monkeypatch.setenv('RAPID_TEST_CRASH_FILE', str(marker))
    buffer = io.BytesIO()
    with Image.new('RGB', (64, 80), 'white') as image:
        image.save(buffer, 'PNG')
    with scoped_client(create_app()) as api:
        project = api.post('/api/projects', json={'name': 'crash survival'}).json()
        project = api.post(f"/api/projects/{project['id']}/files", files=[
            ('files', ('one.png', buffer.getvalue(), 'image/png')),
            ('files', ('two.png', buffer.getvalue(), 'image/png'))]).json()
        url = f"/api/projects/{project['id']}/ocr"
        body = dict(engine='rapidocr-v6', language='eng', contrast=False, precise=False,
                    min_confidence=0, keep_engine_loaded=True)
        result = api.post(url, json=dict(body, image_ids=[project['images'][0]['id']]))
        assert result.status_code == 200, result.text
        saved = api.get(f"/api/projects/{project['id']}").json()
        assert saved['images'][0]['ocrCompleted'] is True
        marker.touch()
        result = api.post(url, json=dict(body, image_ids=[project['images'][1]['id']]))
        assert result.status_code == 503
        assert api.get('/api/health').status_code == 200
        after = api.get(f"/api/projects/{project['id']}").json()
        assert after['images'][0] == saved['images'][0]
        assert not after['images'][1].get('ocrCompleted')


def test_windowed_entry_dispatches_worker_before_gui_stdio_fallback(monkeypatch):
    import runpy
    import comic_studio.rapid_process as module
    calls = []
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr(sys, 'argv', ['HaSaYaStudio.exe', '--rapid-worker', 'v6'])
    monkeypatch.setattr(module, 'restore_worker_stdio', lambda: calls.append('restore'))
    monkeypatch.setattr(module, 'worker_main', lambda version: calls.append(version))
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_path(str(Path(__file__).parents[1] / 'run.py'), run_name='__main__')
    assert exit_info.value.code == 0
    assert calls == ['restore', 'v6']
