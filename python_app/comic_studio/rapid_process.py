"""Persistent, serial PP-OCR inference process. No model or pixel IPC via pickle."""
from __future__ import annotations

import atexit
from collections import deque
from dataclasses import asdict
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import weakref

_CLIENTS = weakref.WeakSet()


def _close_clients():
    for client in list(_CLIENTS):
        client.close()


atexit.register(_close_clients)


class RapidProcess:
    def __init__(self, version):
        self.version = version
        self.proc = None
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.tail = deque(maxlen=40)
        _CLIENTS.add(self)

    @property
    def pid(self):
        proc = self.proc
        return proc.pid if proc is not None and proc.poll() is None else None

    def close(self):
        # Never wait for the request lock: cancellation must interrupt inference.
        proc, self.proc = self.proc, None
        if proc is None:
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream:
                stream.close()

    def cancel(self):
        self.cancelled.set()
        self.close()

    def _start(self):
        command = ([sys.executable, '--rapid-worker', self.version] if getattr(sys, 'frozen', False)
                   else [sys.executable, '-m', 'comic_studio.rapid_process', self.version])
        env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8')
        # Source checkouts as well as editable/installed packages work from any cwd.
        root = str(Path(__file__).resolve().parent.parent)
        env['PYTHONPATH'] = root + os.pathsep + env.get('PYTHONPATH', '')
        self.tail.clear()
        messages = queue.Queue()
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding='utf-8',
                                errors='replace', env=env,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.proc = proc
        self.messages = messages

        def read_output():
            try:
                for line in proc.stdout:
                    messages.put(line)
            except (OSError, ValueError):
                pass
            finally:
                messages.put(None)

        def read_errors():
            try:
                for line in proc.stderr:
                    self.tail.append(line[-2000:].rstrip())
            except (OSError, ValueError):
                pass

        threading.Thread(target=read_output, daemon=True).start()
        threading.Thread(target=read_errors, daemon=True).start()
        return proc

    def call(self, image, language, *, method='recognize', det_max_side=None, force_cpu=False):
        from .activity import JobCancelledError, emit, is_job_cancelled
        from .ocr import OcrError, OcrLine
        with self.lock:
            self.cancelled.clear()
            if is_job_cancelled():
                raise JobCancelledError('OCR cancelled')
            if not self.pid:
                self.close()
                self._start()
            proc = self.proc
            # One page/crop in flight. Lossless PNG, no base64 copies or raw
            # arbitrary Python objects. Private directory removed on every exit.
            with tempfile.TemporaryDirectory(prefix='hasaya-rapid-') as directory:
                path = Path(directory) / 'input.png'
                image.save(path, format='PNG')
                request = dict(path=str(path), language=language, method=method,
                               det_max_side=det_max_side, force_cpu=force_cpu)
                try:
                    proc.stdin.write(json.dumps(request) + '\n')
                    proc.stdin.flush()
                    deadline = time.monotonic() + 900
                    while True:
                        if self.cancelled.is_set() or is_job_cancelled():
                            raise JobCancelledError('OCR cancelled')
                        if time.monotonic() > deadline:
                            raise TimeoutError('PP-OCR worker exceeded 900 seconds')
                        try:
                            line = self.messages.get(timeout=0.1)
                        except queue.Empty:
                            continue
                        if line is None:
                            proc.wait(timeout=3)
                            raise RuntimeError(f'PP-OCR worker exited: {proc.returncode}')
                        result = json.loads(line)
                        if not result['ok']:
                            raise OcrError(result['error'])
                        self.using_gpu = result['using_gpu']
                        if method == 'line':
                            return tuple(result['result'])
                        return [OcrLine(**item) for item in result['result']]
                except JobCancelledError:
                    self.close()
                    raise
                except Exception as exc:
                    if self.cancelled.is_set() or is_job_cancelled():
                        self.close()
                        raise JobCancelledError('OCR cancelled') from exc
                    detail = f'{exc}\n' + '\n'.join(self.tail)
                    # Activity reporting is visible to the user; persist the
                    # evidence as well, since a native exit is not a Python error.
                    from .paths import data_dir
                    try:
                        log = data_dir() / 'logs' / 'rapid-worker.log'
                        log.parent.mkdir(parents=True, exist_ok=True)
                        if log.exists() and log.stat().st_size > 1024 * 1024:
                            log.replace(log.with_suffix('.previous.log'))
                        with log.open('a', encoding='utf-8') as handle:
                            handle.write(f'\n{time.strftime("%Y-%m-%d %H:%M:%S")} {detail}\n')
                    except OSError:
                        pass
                    emit(f'موتور PP-OCR متوقف شد؛ برنامه باز مانده است. {exc}', 'error')
                    self.close()
                    raise OcrError(f'خطای فرایند مستقل PP-OCR: {exc}') from exc


def restore_worker_stdio():
    """Windowed PyInstaller drops Python stdio even with inherited pipe handles."""
    if os.name != 'nt':
        return
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    for name, number, mode, flags in (
        ('stdin', -10, 'r', os.O_RDONLY),
        ('stdout', -11, 'w', os.O_WRONLY),
        ('stderr', -12, 'w', os.O_WRONLY),
    ):
        if getattr(sys, name) is None:
            handle = kernel.GetStdHandle(number & 0xffffffff)
            if not handle or handle == ctypes.c_void_p(-1).value:
                raise OSError('PP-OCR worker requires inherited standard pipes')
            descriptor = msvcrt.open_osfhandle(handle, flags | os.O_BINARY)
            setattr(sys, name, os.fdopen(descriptor, mode, encoding='utf-8', buffering=1))


def worker_main(version):
    import contextlib
    import faulthandler
    from PIL import Image
    from .paths import ensure_custom_site_packages_on_path
    ensure_custom_site_packages_on_path()
    protocol = sys.stdout
    # Native/model diagnostics must never become a protocol response.
    sys.stdout = sys.stderr
    faulthandler.enable()
    from .ocr import RapidEngine
    from .ocr_managed import configure_native_runtime
    configure_native_runtime(True)
    engine = RapidEngine('rapidocr-' + version, version)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            engine._force_cpu = bool(request['force_cpu']) or engine._force_cpu
            with Image.open(request['path']) as source:
                with contextlib.ExitStack() as resources:
                    image = resources.enter_context(source.copy())
                    if request['method'] == 'line':
                        result = engine.recognize_line_text(image, request['language'])
                    else:
                        result = [asdict(item) for item in engine.recognize(
                            image, request['language'], det_max_side=request['det_max_side'])]
            response = dict(ok=True, result=result, using_gpu=engine.using_gpu)
            del result
        except Exception as exc:
            import traceback
            traceback.print_exc(file=sys.stderr)
            response = dict(ok=False, error=str(exc))
        protocol.write(json.dumps(response, ensure_ascii=False) + '\n')
        protocol.flush()
        del response
    engine.unload()


if __name__ == '__main__':
    worker_main(sys.argv[1])
