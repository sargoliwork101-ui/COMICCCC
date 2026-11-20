# PP-OCR execution boundary — 4.58

## Change

The application registry constructs both PP-OCRv5 and PP-OCRv6 with isolation
enabled. Their native detection/recognition calls, including the table-cell
recognizer, execute in a persistent child process. The child constructs the
same RapidEngine without isolation: no recursion, altered model weights,
recognition threshold, detector cap or text postprocessing algorithm.

The existing PIL/OpenCV page preprocessing, page grouping, persistence and
browser rendering remain in their original locations. **This is not whole-page
pipeline isolation** and does not protect the server from a fault in those
other native libraries, machine-wide OOM or OS/driver failure.

## Resource ownership

- One worker per active PP engine; one inference request in flight. Direct API
  batch mode now yields one worker slot instead of creating multiple model
  instances. CPU bulk throughput can be lower than the old multi-model pool;
  the normal page-by-page UI already runs serially.
- Worker starts lazily, retains its model across requests and is terminated on
  explicit unload, cancellation, final batch unload, inactivity release or
  normal parent shutdown. No reload-every-N-pages policy.
- Input is one lossless PNG in a private temporary directory. A JSON line passes
  its path and options; no base64 copies, raw array pickle or network port.
  Parent cleans it after completion/error/cancel. A hard parent/OS kill can
  still leave temporary files, as with ordinary OS temporary storage.
- Results contain only text, geometry and style metadata. Child stdout is
  reserved for JSON protocol; diagnostics go to a bounded stderr tail.
- Existing process RAM reporting picks up worker_pid and includes worker RSS.
  Isolation adds a Python-process baseline and PNG IPC overhead. No claim that
  combined RSS or latency is automatically lower than in-process inference.
- A 900-second watchdog bounds a single inference call. Cancellation interrupts
  the worker without waiting for its request lock, then reaps the process.

## Failure semantics

An unexpected EOF/native exit becomes OcrError and the existing API returns 503.
The failed call is not silently replayed or treated as an empty success. A
subsequent explicit request can create a new worker. Previously committed page
results are not modified by this transport. The application's existing frontend
network retry does not trigger for a returned 503.

On failure the exit code and recent stderr are written to
`<data>/logs/rapid-worker.log`, rotating after 1 MiB to one previous file.
Python faulthandler runs inside the worker for supported native faults. These
logs are evidence, not a Windows native dump or proof of the original cause.

Windowed PyInstaller builds dispatch `--rapid-worker` before the GUI stdio
fallback; inherited Windows pipe handles are restored when Python stdio is
None. The frozen executable is reused, so a separately installed Python is not
required. The dispatch has a regression test, but the packaged executable and
DirectML still require actual Windows validation.

## Validation

`tests/test_rapid_process.py` exercises real subprocess transport:

1. Registry isolation for both PP engines and bounded batch slots.
2. 36 calls use one child PID; line-recognition results also cross the boundary.
3. Child exits deliberately with `os._exit(73)`; parent reports the code and
   stderr, does not replay, and permits a later explicit request.
4. Cancel interrupts a sleeping inference and reaps the worker. A cancellation
   race found in the first run was fixed: a cancellation EOF must not be
   reported as an unexpected native crash.
5. Real HTTP API: first page is saved, child exits on the second page, second
   request fails with 503, health remains 200 and the first saved page is intact.
6. Windowed entry dispatch occurs before the normal GUI stdio fallback.
7. Opt-in **real PP-OCRv6 CPU** inference: 32 synthetic pages return exactly the
   same OcrLine text/confidence/polygon/style data as direct inference, use one
   persistent PID and unload at the end. This test passed on Linux; it does not
   validate PP-OCRv5 weights, DirectML or the user's original document.

Run ordinary tests from the repo root:

```sh
python_app/.venv/bin/python -m pytest python_app/tests/test_rapid_process.py
```

To include the real model test, with local PP-OCRv6 weights installed:

```sh
COMIC_STUDIO_REAL_OCR_MEMORY=1 python_app/.venv/bin/python -m pytest python_app/tests/test_rapid_process.py
```

No claim is made that the original Windows crash has been reproduced or its
cause conclusively repaired. This change isolates the proven vulnerable native
execution boundary and adds crash evidence and failure tests without masking a
failed page.
