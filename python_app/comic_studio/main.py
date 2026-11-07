from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import functools
import hmac
import inspect
import ipaddress
import math
import os
import re
import secrets
import traceback
import copy
import threading
import uuid
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.background import BackgroundTask

from . import APP_NAME, APP_VERSION
from .activity import ActivityLog, reporting
from .backup import BackupError, cleanup_backup_temp, make_backup, restore_backup
from .exporter import build_docx, build_images_zip, build_pdf, build_pptx, build_txt, clean_name, crop_box, image_payload
from .ocr import ENGINE_INFO, LANGUAGES, EngineRegistry, OcrError, _INSTALL_LOCK, recognize_image
from .ocr_grouping import group_ocr_lines, organize_ocr_blocks
from .ocr_managed import (
    _stop_lingering_surya_server,
    configure_native_runtime,
    invalidate_engine_runtime_caches,
    iter_parallel_ordered,
    reset_disk_free_cache,
    trim_process_memory,
)
from .paths import (
    STATIC_DIR,
    apply_storage_directory,
    inspect_storage_status,
    pick_folder_dialog,
    project_root,
)
from . import context_run, pending_results
from .local_nmt import DEFAULT_LOCAL_NMT_MODEL, LOCAL_NMT_MODELS, LocalNmtError
from .schemas import (
    AiConnectionTest, AiSettings, BackupRequest, ContextPreviewRequest, ContextStartRequest, ContextStepRequest, ContextTextRequest, EngineDownloadRequest, EngineTestRequest, EngineUpdateCheckRequest, EngineUpdateRequest, ExportRequest,
    LocalNmtModelActionRequest, LocalNmtTestRequest, OcrRequest, ProjectCreate,
    SessionRequest, StateUpdate, StorageFolderPickRequest, StorageSettingsUpdate, TextTranslateRequest, TranslateRequest,
)
from .sessions import SessionManager
from .store import ProjectChangedError, ProjectStore
from .translation import (
    AI_PROVIDERS, TARGET_LANGUAGES, TranslationError, InvalidContextResponse, TranslationService, combine_translation_texts,
    distribute_translation, normalize_ai_skill, normalize_target_language, context_uses_json, _redact_diagnostic,
)
from .translation_plan import (
    AI_PAGE_PROGRESS_KEY, AI_PARTS_KEY, AI_REUSE_KEY, build_project_plan, build_single_plan, call_plan, mark_completed_call, mark_reused_translation, part_fingerprint,
    plan_preview, plan_signature, saved_call, effective_ai_limit,
)


@functools.lru_cache(maxsize=64)
def _is_loopback_peer(host_str: str) -> bool:
    try:
        peer = ipaddress.ip_address(host_str)
        if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped:
            peer = peer.ipv4_mapped
        return bool(peer.is_loopback)
    except ValueError:
        return False


@functools.lru_cache(maxsize=64)
def _is_loopback_host_header(raw_host: str) -> bool:
    try:
        host = urlsplit("http://" + raw_host)
        hostname = host.hostname or ""
        _ = host.port  # Validate even an unused explicit port.
        if host.username is not None or host.password is not None or host.path or host.query or host.fragment:
            return False
        if hostname.lower() == "localhost":
            return True
        address = ipaddress.ip_address(hostname)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return bool(address.is_loopback)
    except ValueError:
        return False


@functools.lru_cache(maxsize=64)
def _callable_accepts_kwarg(target: Any, kw_name: str) -> bool:
    try:
        params = inspect.signature(target).parameters
    except (TypeError, ValueError):
        return False
    return kw_name in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())


def _supports_kwarg(fn: Any, kw_name: str) -> bool:
    return _callable_accepts_kwarg(getattr(fn, "__func__", fn), kw_name)

from .context_run import RUN_KEY, SUMMARY_KEY, apply_response, build_run_request, create_run, digest, next_request, provider_policy, verify_run


class ResultStorageError(Exception):
    def __init__(self, translated: str, summary: str):
        super().__init__('ذخیرهٔ محلی نتیجه ناموفق بود؛ پیش از بستن برنامه متن دریافتی را کپی کنید. ارسال دوباره ممکن است هزینه داشته باشد.')
        self.translated, self.summary = translated, summary


class PendingResultConflict(Exception):
    def __init__(self, token: str, kind: str):
        super().__init__('نتیجه آماده است اما با تغییرات پروژه تعارض دارد؛ نتیجه حفظ شد و به انتخاب شما نیاز دارد.')
        self.token = token
        self.kind = kind


class _CleanupFileResponse(FileResponse):
    """Stream a temporary file and guarantee deletion even if the client disconnects mid-download."""

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with contextlib.suppress(OSError):
                Path(self.path).unlink(missing_ok=True)


def create_app() -> FastAPI:
    configure_native_runtime()
    cleanup_backup_temp(max_age_seconds=0.0)
    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    store = ProjectStore()
    registry = EngineRegistry()
    translations = TranslationService()
    activity = ActivityLog()
    sessions = SessionManager()
    context_locks: dict[str, asyncio.Lock] = {}
    storage_switch_lock = asyncio.Lock()
    active_jobs_lock = threading.Lock()
    active_jobs_count = 0
    prepared_backups_lock = threading.Lock()
    prepared_backups: dict[str, dict[str, Any]] = {}

    def _clear_prepared_backups(target_project_id: str | None = None, token: str | None = None) -> None:
        with prepared_backups_lock:
            keys = [
                k for k, entry in prepared_backups.items()
                if (token is None or k == token)
                and (target_project_id is None or entry.get("project_id") == target_project_id)
            ]
            paths = [prepared_backups.pop(k)["path"] for k in keys]
        for p in paths:
            with contextlib.suppress(OSError):
                Path(p).unlink(missing_ok=True)
    # Recovery state is short-lived, process-local and never contains the raw response.
    recoveries: dict[str, dict[str, Any]] = {}
    recovery_locks: dict[str, asyncio.Lock] = {}

    def recovery_store(entry: dict[str, Any]) -> str:
        now = time.monotonic()
        for key, value in list(recoveries.items()):
            if now - value['created'] > 1800:
                recoveries.pop(key, None)
                if key in recovery_locks and not recovery_locks[key].locked(): recovery_locks.pop(key, None)
        while len(recoveries) >= 100:
            key = next(iter(recoveries))
            recoveries.pop(key)
            if key in recovery_locks and not recovery_locks[key].locked(): recovery_locks.pop(key, None)
        token = uuid.uuid4().hex
        recoveries[token] = {**entry, 'created': now}
        return token

    def recovery_get(token: str | None, kind: str) -> dict[str, Any]:
        entry = recoveries.get(token or '')
        if not entry or entry['kind'] != kind or time.monotonic() - entry['created'] > 1800:
            raise HTTPException(409, 'فرصت اصلاح پاسخ پایان یافته یا برنامه بازنشانی شده است؛ ترجمه را دوباره شروع کنید.')
        return entry
    app.state.activity = activity
    app.state.sessions = sessions
    activity.add("برنامه آماده است")

    @app.middleware("http")
    async def protect_local_data(request: Request, call_next: Any) -> Response:
        # Loopback is the default trusted use case. LAN clients are denied by
        # default. If configured, Basic authentication protects *all* requests,
        # including those arriving through a loopback reverse proxy.
        password = os.environ.get("COMIC_STUDIO_ACCESS_PASSWORD", "")
        if password:
            if len(password) < 20:
                return JSONResponse({"detail": "COMIC_STUDIO_ACCESS_PASSWORD must contain at least 20 characters."}, status_code=503)
            header = request.headers.get("authorization", "")
            valid = False
            try:
                scheme, encoded = header.split(" ", 1)
                if scheme.lower() == "basic" and len(encoded) <= 8192:
                    decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
                    username, supplied = decoded.split(":", 1)
                    valid = hmac.compare_digest(username.encode("utf-8"), b"comic") and hmac.compare_digest(supplied.encode("utf-8"), password.encode("utf-8"))
            except (ValueError, UnicodeError, binascii.Error):
                pass
            if not valid:
                return JSONResponse({"detail": "Authentication required."}, status_code=401,
                                    headers={"WWW-Authenticate": 'Basic realm="Comic OCR Studio", charset="UTF-8"', "Cache-Control": "no-store"})
        else:
            local = _is_loopback_peer(request.client.host if request.client else "")
            if not local:
                return JSONResponse({"detail": "Remote access is disabled. Configure COMIC_STUDIO_ACCESS_PASSWORD and HTTPS or a trusted VPN."}, status_code=403,
                                    headers={"Cache-Control": "no-store"})
            # Reject arbitrary DNS names on an unauthenticated loopback server;
            # otherwise a malicious site can rebind its hostname to localhost.
            local_host = _is_loopback_host_header(request.headers.get("host", ""))
            if not local_host:
                return JSONResponse({"detail": "Unauthenticated access requires a loopback hostname."}, status_code=403,
                                    headers={"Cache-Control": "no-store"})
        # Browsers normally send Origin on mutations. Reject a foreign origin;
        # clients such as local command-line tools may legitimately omit it.
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and origin:
            try:
                parsed = urlsplit(origin)
                same = (parsed.scheme in {"http", "https"} and parsed.scheme == request.url.scheme
                        and parsed.netloc.lower() == request.headers.get("host", "").lower()
                        and not parsed.path and not parsed.query and not parsed.fragment
                        and parsed.username is None and parsed.password is None)
            except ValueError:
                same = False
            if not same:
                return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
        return await call_next(request)

    @app.middleware("http")
    async def prevent_stale_interface(request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.endswith((".html", ".js", ".css")):
            response.headers["Cache-Control"] = "no-store"
        return response

    async def run_reported(
        function: Any,
        *args: Any,
        pulse_label: str | None = None,
        progress_span: tuple[float, float] | None = None,
        **kwargs: Any,
    ) -> Any:
        nonlocal active_jobs_count
        stop_pulse = threading.Event()
        started = time.monotonic()
        last_state: dict[str, Any] = {"ts": started, "progress": None, "detail": ""}
        pulse = None
        with active_jobs_lock:
            active_jobs_count += 1

        def _map_progress(raw_p: float | None) -> float | None:
            if raw_p is None or not isinstance(raw_p, (int, float)) or not math.isfinite(float(raw_p)):
                return raw_p
            clamped = max(0.0, min(1.0, float(raw_p)))
            if progress_span is not None:
                lo, hi = progress_span
                return round(lo + (hi - lo) * clamped, 4)
            return clamped

        def tracked_report(message: str, kind: str = "info", progress: float | None = None) -> None:
            last_state["ts"] = time.monotonic()
            mapped_p = _map_progress(progress)
            if mapped_p is not None:
                last_state["progress"] = mapped_p
            cleaned_msg = str(message or "").strip().rstrip("….")
            if cleaned_msg and "همچنان در حال انجام است" not in cleaned_msg:
                last_state["detail"] = cleaned_msg[:90]
            activity.add(message, kind, mapped_p)

        if pulse_label:
            def report_alive() -> None:
                while not stop_pulse.wait(5):
                    now = time.monotonic()
                    if now - float(last_state["ts"]) < 4.2:
                        continue
                    cur_p = last_state["progress"]
                    detail = str(last_state.get("detail") or "").strip()
                    detail_part = f" ({detail})" if detail and detail != pulse_label else ""
                    activity.add(
                        f"{pulse_label} همچنان در حال انجام است{detail_part} · {int(now - started)} ثانیه",
                        progress=cur_p if isinstance(cur_p, (int, float)) else None,
                    )
            pulse = threading.Thread(target=report_alive, daemon=True)
            pulse.start()
        try:
            with reporting(tracked_report):
                return await run_in_threadpool(function, *args, **kwargs)
        finally:
            stop_pulse.set()
            if pulse:
                pulse.join(timeout=0.1)
            with active_jobs_lock:
                active_jobs_count = max(0, active_jobs_count - 1)

    def context_progress(run: dict[str, Any]) -> float:
        jobs = run.get('jobs', [])
        total = sum(len(str(job.get('source') or '')) for job in jobs)
        remaining = sum(len(str(job.get('remaining') or '')) for job in jobs)
        if total <= 0:
            return 1.0
        return max(0.0, min(1.0, (total - remaining) / total))

    def project(project_id: str) -> dict[str, Any]:
        try:
            return store.get(project_id)
        except KeyError as exc:
            raise HTTPException(404, "پروژهٔ موردنظر پیدا نشد.") from exc

    def image_ids(state: dict[str, Any], requested: list[str]) -> list[str]:
        if requested:
            valid = {item["id"] for item in state["images"]}
            return [image_id for image_id in requested if image_id in valid]
        return [item["id"] for item in sorted(state["images"], key=lambda item: item.get("order", 0)) if item.get("selected", True)]

    @app.exception_handler(OcrError)
    async def ocr_error(_: Request, exc: OcrError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.exception_handler(InvalidContextResponse)
    async def invalid_context_response(_: Request, exc: InvalidContextResponse) -> JSONResponse:
        return JSONResponse({"detail": str(exc), "kind": "invalid_context_response", "response_text": exc.response_text,
                             "recovery_token": exc.recovery_token, "response_truncated": exc.response_truncated}, status_code=422, headers={"Cache-Control": "no-store"})

    @app.exception_handler(ResultStorageError)
    async def result_storage_error(_: Request, exc: ResultStorageError) -> JSONResponse:
        return JSONResponse({'detail':str(exc), 'kind':'unstored_result', 'translation':exc.translated, 'summary':exc.summary},
                            status_code=507, headers={'Cache-Control':'no-store'})

    @app.exception_handler(PendingResultConflict)
    async def pending_conflict(_: Request, exc: PendingResultConflict) -> JSONResponse:
        return JSONResponse({'detail': str(exc), 'kind':'pending_result', 'pending_id':exc.token, 'pending_kind':exc.kind},
                            status_code=409, headers={'Cache-Control':'no-store'})

    @app.exception_handler(TranslationError)
    async def translation_error(_: Request, exc: TranslationError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(ProjectChangedError)
    async def project_changed(_: Request, exc: ProjectChangedError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        """Redact known credentials; exception messages can still contain private data."""
        reference = uuid.uuid4().hex[:12]
        secrets = [os.environ.get('COMIC_STUDIO_ACCESS_PASSWORD', '')]
        try:
            settings = translations._secret()
            secrets.extend(p['api_key'] for config in settings['providers'].values() for p in config['profiles'] if p.get('api_key'))
        except Exception:
            pass
        detail = _redact_diagnostic(str(exc), secrets)
        detail = re.sub(r'(https?://[^\s?]+)\?[^\s]+', r'\1?[REDACTED]', detail)
        frames = traceback.extract_tb(exc.__traceback__)
        location = f"{Path(frames[-1].filename).name}:{frames[-1].lineno} ({frames[-1].name})" if frames else 'unknown'
        message = f"خطای داخلی {type(exc).__name__}؛ {detail or 'بدون جزئیات'}؛ محل {location}؛ شناسه {reference}."
        activity.add(f"{request.method} {request.url.path}: {message}", 'error')
        return JSONResponse({"detail": message, "error_id": reference}, status_code=500)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"name": APP_NAME, "version": APP_VERSION, "offlineOcr": True, "scraping": False}

    @app.get("/api/activity")
    def activity_feed(after: int = 0) -> dict[str, Any]:
        return activity.since(max(0, after))

    @app.post("/api/activity/clear")
    def clear_activity() -> dict[str, Any]:
        return {"ok": True, "next": activity.clear()}

    @app.post("/api/session/heartbeat")
    def session_heartbeat(values: SessionRequest) -> dict[str, Any]:
        return {"ok": True, "active": sessions.heartbeat(values.client_id)}

    @app.post("/api/session/close")
    def session_close(values: SessionRequest) -> dict[str, Any]:
        active, accepted = sessions.close(values.client_id)
        return {"ok": True, "active": active, "accepted": accepted}

    @app.get("/api/projects")
    def projects() -> list[dict[str, Any]]:
        return store.list()

    @app.post("/api/projects", status_code=201)
    def create_project(values: ProjectCreate | None = None) -> dict[str, Any]:
        return store.create(values.name if values else "پروژهٔ کمیک")

    @app.post("/api/projects/restore", status_code=201)
    async def restore_project(file: UploadFile = File(...)) -> dict[str, Any]:
        activity.add("بازیابی بک‌آپ پروژه آغاز شد")
        try:
            state, drafts = await run_reported(restore_backup, store, file.file, pulse_label="بازیابی بک‌آپ")
        except BackupError as exc:
            activity.add(f"بازیابی بک‌آپ ناموفق بود: {exc}", "error")
            raise HTTPException(400, str(exc)) from exc
        activity.add(f"پروژهٔ «{state['name']}» به‌صورت پروژهٔ جدید بازیابی شد", "success", 1.0)
        return {"project": state, "drafts": drafts}

    @app.post("/api/projects/{project_id}/backup")
    async def backup_project(project_id: str, values: BackupRequest, prepare: bool = False) -> Response:
        proj = project(project_id)
        activity.add("ساخت بک‌آپ پروژه آغاز شد")
        try:
            path = await run_reported(make_backup, store, project_id, values.drafts, values.expected_updated_at, pulse_label="ساخت بک‌آپ")
        except BackupError as exc:
            activity.add(f"ساخت بک‌آپ ناموفق بود: {exc}", "error")
            raise HTTPException(400, str(exc)) from exc
        activity.add("بک‌آپ پروژه آماده است", "success", 1.0)
        download_name = f"{clean_name(str(proj.get('name') or ''), 'comic-studio')}-backup.zip"
        if prepare:
            token = secrets.token_hex(16)
            size = path.stat().st_size
            with prepared_backups_lock:
                stale_paths = [entry["path"] for entry in prepared_backups.values()]
                prepared_backups.clear()
                prepared_backups[token] = {
                    "project_id": project_id,
                    "path": path,
                    "filename": download_name,
                    "created": time.monotonic(),
                }
            for old_path in stale_paths:
                if old_path != path:
                    with contextlib.suppress(OSError):
                        Path(old_path).unlink(missing_ok=True)
            return JSONResponse({"token": token, "filename": download_name, "size": size}, headers={"Cache-Control": "no-store"})
        return _CleanupFileResponse(path, media_type="application/zip", filename="comic-studio-project-backup.zip")

    @app.get("/api/projects/{project_id}/backup/{token}")
    def download_prepared_backup(project_id: str, token: str) -> FileResponse:
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise HTTPException(404, "فایل بک‌آپ آماده پیدا نشد؛ دوباره بک‌آپ بگیرید.")
        with prepared_backups_lock:
            entry = prepared_backups.get(token)
            if not entry or entry.get("project_id") != project_id:
                entry = None
            elif time.monotonic() - float(entry.get("created", 0.0)) > 3600.0:
                prepared_backups.pop(token, None)
                with contextlib.suppress(OSError):
                    Path(entry["path"]).unlink(missing_ok=True)
                entry = None
        if not entry or not Path(entry["path"]).is_file():
            raise HTTPException(404, "فایل بک‌آپ منقضی یا پاک شده است؛ دوباره بک‌آپ بگیرید.")
        return FileResponse(entry["path"], media_type="application/zip", filename=entry["filename"])

    @app.delete("/api/projects/{project_id}/backup/{token}", status_code=204)
    def discard_prepared_backup(project_id: str, token: str) -> Response:
        if re.fullmatch(r"[0-9a-f]{32}", token):
            _clear_prepared_backups(target_project_id=project_id, token=token)
        return Response(status_code=204)

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict[str, Any]:
        return project(project_id)

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: str) -> Response:
        try:
            store.delete_project(project_id)
        except KeyError as exc:
            raise HTTPException(404, "پروژهٔ موردنظر پیدا نشد.") from exc
        _clear_prepared_backups(target_project_id=project_id)
        if project_id in context_locks and not context_locks[project_id].locked():
            context_locks.pop(project_id, None)
        return Response(status_code=204)

    @app.put("/api/projects/{project_id}/state")
    def update_state(project_id: str, update: StateUpdate) -> dict[str, Any]:
        project(project_id)
        return store.update_state(project_id, update.state)

    @app.get("/api/projects/{project_id}/pending")
    def pending_list(project_id: str) -> list[dict[str, Any]]:
        project(project_id)
        return pending_results.list_pending(store, project_id)

    @app.get("/api/projects/{project_id}/pending/{token}")
    def pending_view(project_id: str, token: str) -> Response:
        try:
            with store._lock:
                result = pending_results.inspect(store, project_id, pending_results.load(store, project_id, token))
            return JSONResponse(result, headers={'Cache-Control':'no-store'})
        except KeyError as exc:
            raise HTTPException(404, 'نتیجهٔ منتظر پیدا نشد.') from exc

    @app.post("/api/projects/{project_id}/pending/{token}/resolve")
    def pending_resolve(project_id: str, token: str, values: dict[str, Any] = Body(...)) -> dict[str, Any]:
        revision = values.get('revision'); choices = values.get('choices')
        if not isinstance(revision, str) or not isinstance(choices, dict) or any(not isinstance(k, str) or v not in ('keep', 'apply') for k,v in choices.items()):
            raise HTTPException(400, 'انتخاب‌های رفع تعارض معتبر نیستند.')
        try:
            return pending_results.resolve(store, project_id, token, revision, choices)
        except KeyError as exc:
            raise HTTPException(404, 'نتیجهٔ منتظر پیدا نشد.') from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.delete("/api/projects/{project_id}/pending/{token}", status_code=204)
    def pending_delete(project_id: str, token: str) -> Response:
        try:
            with store._lock: pending_results.remove(store, project_id, token)
        except KeyError as exc:
            raise HTTPException(404, 'نتیجهٔ منتظر پیدا نشد.') from exc
        return Response(status_code=204)

    @app.post("/api/projects/{project_id}/files")
    async def import_files(project_id: str, files: list[UploadFile] = File(...)) -> dict[str, Any]:
        project(project_id)
        payloads = []
        for upload in files:
            content = await upload.read()
            payloads.append((Path(upload.filename or "image.png").name, content))
        if not payloads:
            raise HTTPException(400, "هیچ فایلی انتخاب نشده است.")
        activity.add(f"دریافت و آماده‌سازی {len(payloads)} فایل آغاز شد")
        try:
            result = await run_reported(store.import_files, project_id, payloads, pulse_label="ورود و آماده‌سازی فایل")
            activity.add(f"{len(result.get('images', []))} تصویر در پروژه آماده است", "success", 1.0)
            return result
        except (ValueError, RuntimeError) as exc:
            activity.add(f"ورود فایل ناموفق بود: {exc}", "error")
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            activity.add(f"ورود فایل ناموفق بود: {exc}", "error")
            raise
        finally:
            payloads.clear()
            await run_in_threadpool(trim_process_memory)

    @app.get("/api/projects/{project_id}/images/{image_id}/content")
    def image_content(project_id: str, image_id: str, edited: bool = False, cropped: bool = False) -> Response:
        try:
            if cropped:
                item = store._image_meta(project_id, image_id)
                if crop_box(item) is not None:
                    data, _, _, _ = image_payload(store, project_id, item, "png")
                    return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})
                edited_candidate = project_root(project_id) / "images" / f"{image_id}-edited.png"
                path = edited_candidate if edited_candidate.exists() else store.image_path(project_id, image_id, False)
            else:
                path = store.image_path(project_id, image_id, edited)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "تصویر موردنظر پیدا نشد.") from exc
        return FileResponse(path, headers={"Cache-Control": "no-store"})

    def _save_rendered_and_release(project_id: str, image_id: str, content: bytes) -> dict[str, Any]:
        try:
            return store.save_rendered(project_id, image_id, content)
        finally:
            del content
            trim_process_memory()

    @app.post("/api/projects/{project_id}/images/{image_id}/rendered")
    async def save_rendered(project_id: str, image_id: str, request: Request) -> dict[str, Any]:
        content = await request.body()
        if not content:
            raise HTTPException(400, "تصویر رندرشده خالی است.")
        payload = content
        del content
        try:
            return await run_in_threadpool(_save_rendered_and_release, project_id, image_id, payload)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "تصویر موردنظر پیدا نشد.") from exc
        except PermissionError as exc:
            raise HTTPException(503, "فایل پروژه موقتاً در حال ذخیره‌سازی است؛ چند لحظه بعد دوباره تلاش کنید.") from exc
        except Exception as exc:
            raise HTTPException(400, f"فایل PNG معتبر نیست: {exc}") from exc
        finally:
            payload = b""

    @app.post("/api/projects/{project_id}/images/{image_id}/revert")
    def revert_rendered(project_id: str, image_id: str) -> dict[str, Any]:
        try:
            result = store.revert_rendered(project_id, image_id)
            trim_process_memory()
            return result
        except KeyError as exc:
            raise HTTPException(404, "تصویر موردنظر پیدا نشد.") from exc

    @app.post("/api/projects/{project_id}/duplicate")
    def duplicate(project_id: str, ids: list[str] = Body(...)) -> dict[str, Any]:
        project(project_id)
        return store.duplicate(project_id, ids)

    @app.post("/api/projects/{project_id}/delete")
    def delete(project_id: str, ids: list[str] = Body(...)) -> dict[str, Any]:
        project(project_id)
        return store.delete(project_id, ids)

    @app.get("/api/engines")
    def engines() -> list[dict[str, Any]]:
        return registry.status()

    @app.get("/api/engines/hardware")
    def engines_hardware() -> dict[str, Any]:
        return registry.hardware_summary()

    @app.get("/api/engines/memory")
    def engines_memory() -> dict[str, Any]:
        return registry.memory_status()

    @app.post("/api/engines/unload")
    async def unload_engines_memory() -> dict[str, Any]:
        await run_in_threadpool(translations.local_nmt.unload)
        summary = await run_in_threadpool(registry.unload_all)
        freed = float(summary.get("freedRamMb") or 0.0)
        unloaded_count = len(summary.get("unloadedEngines") or [])
        if unloaded_count > 0 or freed >= 1.0:
            activity.add(
                f"حافظهٔ رم مدل‌های OCR آزاد شد (مصرف فعلی برنامه: {summary.get('totalRamMb', 0):.0f} مگابایت)",
                "success",
            )
        else:
            activity.add(
                f"حافظهٔ رم بهینه شد؛ هیچ مدل فعالی در رم باقی نمانده است ({summary.get('totalRamMb', 0):.0f} مگابایت)",
                "info",
            )
        return {"ok": True, "memory": summary, "engines": registry.status()}

    @app.post("/api/engines/check-updates")
    async def check_engine_updates(values: EngineUpdateCheckRequest | None = None) -> dict[str, Any]:
        force = bool(values.force) if values else False
        report = await run_in_threadpool(registry.check_updates, force)
        count = int(report.get("updatesCount") or 0)
        if count > 0 and force:
            activity.add(f"برای {count} مدل OCR نسخهٔ جدید در دسترس است", "info")
        elif force:
            activity.add("همهٔ مدل‌های نصب‌شدهٔ OCR به‌روز هستند", "success")
        return {**report, "hardware": registry.hardware_summary(), "memory": registry.memory_status()}

    async def _watch_client_cancel(request: Request, engine_id: str, done_event: asyncio.Event) -> None:
        while not done_event.is_set():
            try:
                await asyncio.wait_for(done_event.wait(), timeout=0.6)
                return
            except asyncio.TimeoutError:
                try:
                    if await request.is_disconnected():
                        cancel_fn = getattr(registry, "cancel_install", None)
                        if callable(cancel_fn):
                            cancel_fn(engine_id)
                        return
                except Exception:
                    return

    @app.post("/api/engines/{engine_id}/cancel")
    async def cancel_engine_operation(engine_id: str) -> dict[str, Any]:
        registry.get(engine_id)
        cancel_fn = getattr(registry, "cancel_install", None)
        if callable(cancel_fn):
            cancel_fn(engine_id)
        activity.add(f"درخواست توقف عملیات مدل {engine_id} ثبت شد", "warning")
        return {"ok": True, "engineId": engine_id}

    @app.post("/api/engines/{engine_id}/download", response_model=None)
    async def download_engine(request: Request, engine_id: str, values: EngineDownloadRequest | None = None) -> Response | dict[str, Any]:
        registry.get(engine_id)
        info = ENGINE_INFO[engine_id]
        if info.get("action") == "guide":
            return {"ok": False, "guide": True, "engine": {"id": engine_id, **info}, "engines": registry.status()}
        language = values.language if values else "eng"
        force = bool(values.force) if values else False
        if info.get("isolated") and info["languages"] and language not in info["languages"]:
            language = info["languages"][0]
        if language not in info["languages"]:
            raise HTTPException(400, "این موتور از زبان انتخاب‌شده پشتیبانی نمی‌کند.")
        if not force:
            hw = registry.check_hardware(engine_id)
            if not hw.get("compatible", True):
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": " ".join(hw.get("warnings") or []),
                        "kind": "hardware_warning",
                        "warnings": hw.get("warnings") or [],
                        "hardwareCheck": hw,
                    },
                )
        activity.add(f"آماده‌سازی خودکار {info['name']} برای زبان {language} آغاز شد")
        done_ev = asyncio.Event()
        watch_task = asyncio.create_task(_watch_client_cancel(request, engine_id, done_ev))
        try:
            await run_reported(registry.download, engine_id, language, pulse_label=f"آماده‌سازی {info['name']}")
        except Exception as exc:
            activity.add(f"آماده‌سازی {info['name']} ناموفق بود: {exc}", "error")
            raise
        finally:
            done_ev.set()
            watch_task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await watch_task
        activity.add(f"مدل {info['name']} برای {language} آماده شد", "success", 1.0)
        return {"ok": True, "language": language, "engines": registry.status(), "memory": registry.memory_status()}

    @app.post("/api/engines/{engine_id}/update")
    async def update_engine_route(request: Request, engine_id: str, values: EngineUpdateRequest | None = None) -> dict[str, Any]:
        registry.get(engine_id)
        info = ENGINE_INFO[engine_id]
        language = values.language if values else (info["languages"][0] if info["languages"] else "eng")
        if info["languages"] and language not in info["languages"]:
            language = info["languages"][0]
        activity.add(f"به‌روزرسانی خودکار {info['name']} آغاز شد")
        done_ev = asyncio.Event()
        watch_task = asyncio.create_task(_watch_client_cancel(request, engine_id, done_ev))
        try:
            await run_reported(registry.update, engine_id, language, pulse_label=f"به‌روزرسانی {info['name']}")
        except Exception as exc:
            activity.add(f"به‌روزرسانی {info['name']} ناموفق بود: {exc}", "error")
            raise
        finally:
            done_ev.set()
            watch_task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await watch_task
        activity.add(f"مدل {info['name']} به آخرین نسخه به‌روزرسانی شد", "success", 1.0)
        return {"ok": True, "language": language, "engines": registry.status(), "memory": registry.memory_status()}

    @app.post("/api/engines/{engine_id}/uninstall")
    async def uninstall_engine_route(engine_id: str) -> dict[str, Any]:
        registry.get(engine_id)
        info = ENGINE_INFO[engine_id]
        if info.get("action") == "guide":
            raise HTTPException(400, "این مدل داخل برنامه نصب نشده است.")
        activity.add(f"حذف کامل مدل {info['name']} از روی سیستم آغاز شد")
        try:
            summary = await run_reported(registry.uninstall, engine_id, pulse_label=f"حذف مدل {info['name']}")
        except Exception as exc:
            activity.add(f"حذف مدل {info['name']} ناموفق بود: {exc}", "error")
            raise
        freed_mb = float(summary.get("freedMb") or 0.0)
        if freed_mb >= 1024.0:
            freed_txt = f" ({freed_mb / 1024.0:.2f} گیگابایت فضا آزاد شد)"
        elif freed_mb >= 1.0:
            freed_txt = f" ({freed_mb:.0f} مگابایت فضا آزاد شد)"
        else:
            freed_txt = ""
        activity.add(f"مدل {info['name']} به‌طور کامل از سیستم حذف شد{freed_txt}", "success", 1.0)
        return {
            "ok": True,
            **summary,
            "engines": registry.status(),
            "memory": registry.memory_status(),
        }

    def _invoke_recognize(
        engine: Any,
        image: Any,
        language: str,
        contrast: bool,
        precise: bool,
        min_confidence: float,
        page_mode: str = "auto",
    ) -> list[dict[str, Any]]:
        if _supports_kwarg(recognize_image, "page_mode"):
            return recognize_image(
                engine, image, language, contrast, precise, min_confidence, page_mode=page_mode,
            )
        return recognize_image(engine, image, language, contrast, precise, min_confidence)

    @app.post("/api/engines/{engine_id}/test")
    async def test_engine(engine_id: str, values: EngineTestRequest) -> dict[str, Any]:
        engine = registry.get(engine_id)
        if not ENGINE_INFO[engine_id].get("selectable", False):
            raise HTTPException(400, "این مدل به محیط اجرای جداگانه (external runtime) نیاز دارد و موتور مستقیم OCR نیست.")
        if values.language not in ENGINE_INFO[engine_id]["languages"]:
            raise HTTPException(400, "این موتور از زبان انتخاب‌شده پشتیبانی نمی‌کند.")
        state = project(values.project_id)
        try:
            path = store.image_path(values.project_id, values.image_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "تصویر موردنظر پیدا نشد.") from exc
        from PIL import Image
        await run_in_threadpool(registry.unload_all, engine_id)
        with Image.open(path) as im:
            image = im.copy()
            page_size = image.size
        activity.add(f"آزمایش {ENGINE_INFO[engine_id]['name']} روی {path.name} آغاز شد")
        try:
            raw_blocks = await run_reported(
                _invoke_recognize, engine, image, values.language, True, True, 0.2, values.page_mode,
                pulse_label=f"آزمایش {ENGINE_INFO[engine_id]['name']}",
            )
            blocks, _ = organize_ocr_blocks(
                raw_blocks,
                page_mode=values.page_mode,
                group_lines=True,
                page_size=page_size,
            )
        except Exception as exc:
            activity.add(f"آزمایش موتور ناموفق بود: {exc}", "error")
            raise
        finally:
            image.close()
            await run_in_threadpool(registry.unload_all)
        activity.add(f"آزمایش تمام شد؛ {len(blocks)} تکه متن تشخیص داده شد", "success", 1.0)
        return {"engine": engine_id, "imageId": values.image_id, "blocks": blocks, "memory": registry.memory_status()}

    @app.post("/api/projects/{project_id}/ocr")
    async def run_ocr(project_id: str, values: OcrRequest, http_request: Request) -> dict[str, Any]:
        with store._lock:
            state = project(project_id)
            expected_updated_at = state.get("updatedAt", "")
            baseline = {item['id']: pending_results.ocr_signature(store, state, item['id']) for item in state['images']}
            original_ocr = {item['id']: '\n'.join(str(b.get('text') or '') for b in item.get('blocks', [])) for item in state['images']}
        engine = registry.get(values.engine)
        if not ENGINE_INFO[values.engine].get("selectable", False):
            raise HTTPException(400, "این مدل به محیط اجرای جداگانه (external runtime) نیاز دارد و موتور مستقیم OCR نیست.")
        if values.language not in LANGUAGES or values.language not in ENGINE_INFO[values.engine]["languages"]:
            raise HTTPException(400, "این موتور از زبان انتخاب‌شده پشتیبانی نمی‌کند.")
        ids = image_ids(state, values.image_ids)
        if not ids:
            raise HTTPException(400, "حداقل یک تصویر را انتخاب کنید.")
        for pending in pending_results.list_pending(store, project_id):
            if pending['kind'] == 'ocr':
                entry = pending_results.load(store, project_id, pending['id'])
                if set(ids).intersection(output['id'] for output in entry['outputs']):
                    raise PendingResultConflict(pending['id'], 'ocr')
        await run_in_threadpool(registry.unload_all, values.engine)
        target_items = [item for item in state["images"] if item["id"] in ids]
        total_targets = len(target_items)
        is_ui_paged_batch = values.batch_index is not None and values.batch_total is not None
        ui_batch_total = max(1, int(values.batch_total)) if is_ui_paged_batch else total_targets
        ui_batch_index = min(ui_batch_total, max(1, int(values.batch_index))) if is_ui_paged_batch else 1
        erase_original = bool(state.get("settings", {}).get("eraseOriginal", True))
        if not is_ui_paged_batch or ui_batch_index == 1:
            activity.add(f"خواندن متن در {ui_batch_total} تصویر آغاز شد", progress=0.0 if is_ui_paged_batch else None)

        def _page_progress_bounds(step: int) -> tuple[float, float]:
            if is_ui_paged_batch:
                lo = (ui_batch_index - 1) / ui_batch_total
                hi = (ui_batch_index - 0.20) / ui_batch_total
                return round(lo, 4), round(hi, 4)
            lo = (step - 1) / max(1, total_targets)
            hi = step / max(1, total_targets)
            return round(lo, 4), round(hi, 4)

        def _apply_page_ocr_result(item: dict[str, Any], raw_blocks: list[dict[str, Any]], page_size: tuple[int, int], step: int) -> None:
            for block in raw_blocks:
                block["bg"] = "auto" if erase_original else "none"
            organized, resolved_mode = organize_ocr_blocks(
                raw_blocks,
                page_mode=values.page_mode,
                group_lines=values.group_lines,
                page_size=page_size,
            )
            item["blocks"] = organized
            item["pageMode"] = resolved_mode
            item["ocrCompleted"] = True
            item["edited"] = False
            item["approved"] = False
            mode_label = "کتاب/مقاله" if resolved_mode == "document" else "کمیک/حباب"
            _, done_p = _page_progress_bounds(step)
            activity.add(
                f"در «{item['name']}» {len(organized)} تکه متن ({mode_label}) پیدا شد",
                progress=done_p,
            )
            def _format_ocr_log_entry(blk: dict[str, Any]) -> str:
                raw_txt = str(blk.get("text") or "").strip("\r\n")
                if not raw_txt.strip():
                    return ""
                pad = " " * max(0, min(24, int(blk.get("sourceIndent") or 0)))
                first_extra = "  " if float(blk.get("firstLineIndent") or 0) >= 0.75 else ""
                hang_extra = "  " if float(blk.get("hangingIndent") or 0) >= 0.75 else ""
                sub_lines = [ln for ln in raw_txt.split("\n") if ln.strip()]
                if not sub_lines:
                    return ""
                role_tag = "[تیتر] " if blk.get("pageRole") == "heading" else ""
                formatted = [f"{pad}{first_extra}{role_tag}{sub_lines[0].strip()}"]
                for cont in sub_lines[1:]:
                    formatted.append(f"{pad}{hang_extra}{cont.strip()}")
                return "\n".join(formatted)

            recognized_lines = [line for block in organized if (line := _format_ocr_log_entry(block))]
            if recognized_lines:
                activity.add(f"متن خوانده‌شده در «{item['name']}»:\n" + "\n".join(recognized_lines))
            else:
                activity.add(f"در «{item['name']}» متنی پیدا نشد", "warning")

        batch_ctx = (
            engine.configure_batch(total_targets)
            if hasattr(engine, "configure_batch") and total_targets > 1
            else contextlib.nullcontext(1)
        )
        keep_loaded_ok = False
        try:
            from PIL import Image

            with batch_ctx as batch_workers:
                if int(batch_workers) <= 1:
                    for completed, item in enumerate(target_items, start=1):
                        if await http_request.is_disconnected():
                            activity.add("فرایند OCR با بستن پنجره متوقف شد.", "warning")
                            return store.get(project_id)
                        disp_idx = ui_batch_index if is_ui_paged_batch else completed
                        disp_tot = ui_batch_total if is_ui_paged_batch else total_targets
                        p_lo, p_hi = _page_progress_bounds(completed)
                        start_page_p = round(p_lo + (p_hi - p_lo) * 0.06, 4)
                        activity.add(
                            f"در حال خواندن تصویر {disp_idx} از {disp_tot}: {item['name']}",
                            progress=start_page_p,
                        )
                        path = store.image_path(project_id, item["id"])
                        with Image.open(path) as im:
                            image = im.copy()
                        try:
                            blocks = await run_reported(
                                _invoke_recognize, engine, image, values.language,
                                values.contrast, values.precise, values.min_confidence, values.page_mode,
                                pulse_label=f"در حال خواندن {item['name']}",
                                progress_span=(start_page_p, round(p_lo + (p_hi - p_lo) * 0.92, 4)),
                            )
                            page_size = image.size
                        finally:
                            image.close()
                        _apply_page_ocr_result(item, blocks, page_size, completed)
                        if completed < total_targets:
                            await run_in_threadpool(trim_process_memory)
                else:
                    cancel_event = threading.Event()

                    async def _watch_disconnect() -> None:
                        while not cancel_event.is_set():
                            if await http_request.is_disconnected():
                                cancel_event.set()
                                return
                            await asyncio.sleep(0.15)

                    def _run_parallel_ocr() -> bool:
                        def _ocr_single_page(idx: int, item: dict[str, Any]) -> tuple[list[dict[str, Any]], tuple[int, int]] | None:
                            if cancel_event.is_set():
                                return None
                            activity.add(f"در حال خواندن تصویر {idx + 1} از {total_targets}: {item['name']}")
                            path = store.image_path(project_id, item["id"])
                            with Image.open(path) as im:
                                image = im.copy()
                            try:
                                page_size = image.size
                                blocks = _invoke_recognize(
                                    engine, image, values.language,
                                    values.contrast, values.precise, values.min_confidence, values.page_mode,
                                )
                                return blocks, page_size
                            finally:
                                image.close()
                                trim_process_memory()

                        for idx, item, outcome in iter_parallel_ordered(target_items, _ocr_single_page, max_workers=int(batch_workers)):
                            if cancel_event.is_set() or outcome is None:
                                cancel_event.set()
                                return False
                            raw_blocks, page_size = outcome
                            _apply_page_ocr_result(item, raw_blocks, page_size, idx + 1)
                        return not cancel_event.is_set()

                    watcher = asyncio.create_task(_watch_disconnect())
                    try:
                        finished_ok = await run_reported(
                            _run_parallel_ocr,
                            pulse_label=f"خواندن موازی {total_targets} تصویر",
                        )
                    finally:
                        cancel_event.set()
                        watcher.cancel()
                        try:
                            await watcher
                        except asyncio.CancelledError:
                            pass
                    if not finished_ok:
                        activity.add("فرایند OCR با بستن پنجره متوقف شد.", "warning")
                        return store.get(project_id)
            if await http_request.is_disconnected():
                activity.add("فرایند OCR با بستن پنجره متوقف شد.", "warning")
                return store.get(project_id)
            with store._lock:
                entry = pending_results.stage(store, project_id, 'ocr', {
                    'baseline': {i: baseline[i] for i in ids}, 'originals': {i: original_ocr[i] for i in ids},
                    'overlayMode': state.get('settings', {}).get('overlayMode'),
                    'outputs': [{'id':item['id'], 'name':item.get('name', ''), 'blocks':item['blocks'], 'pageMode':item.get('pageMode')} for item in state['images'] if item['id'] in ids],
                })
                view = pending_results.inspect(store, project_id, entry)
                if any(row['conflict'] for row in view['rows']):
                    raise PendingResultConflict(entry['id'], 'ocr')
                merged = pending_results.resolve(store, project_id, entry['id'], view['revision'], {})
                state = merged['project']
            keep_loaded_ok = bool(values.keep_engine_loaded)
        except Exception as exc:
            activity.add(f"خواندن متن ناموفق بود: {exc}", "error")
            raise
        finally:
            if keep_loaded_ok:
                await run_in_threadpool(trim_process_memory)
            else:
                await run_in_threadpool(registry.unload_all)
        if not is_ui_paged_batch:
            activity.add("OCR تمام شد؛ متن هر تصویر در گزارش بالا آمده است", "success", 1.0)
        elif ui_batch_index >= ui_batch_total:
            activity.add(
                "OCR تمام شد؛ متن هر تصویر در گزارش بالا آمده است",
                "success",
                round((ui_batch_index - 0.18) / ui_batch_total, 4),
            )
        return state

    def translation_settings(provider: str, skill: str | None, target_language: str = "fa") -> dict[str, Any]:
        return {
            **translations.public_settings(),
            "_translation_skill": normalize_ai_skill(skill) if provider not in {"free", "local"} else "",
            "_target_language": normalize_target_language(target_language),
        }

    def _call_with_target_lang(fn: Any, *args: Any, target_language: str = "fa") -> Any:
        tl = normalize_target_language(target_language)
        if tl == "fa":
            return fn(*args)
        if _supports_kwarg(fn, "target_language"):
            return fn(*args, target_language=tl)
        return fn(*args)

    def _direct_mt_limit(provider: str, settings: dict[str, Any], selected_profile_id: str | None = None) -> int:
        if provider == 'free':
            return min(s['source_limit'] for s in settings['free_services'].values())
        if provider == 'local':
            return int(settings.get('local_nmt', {}).get('source_limit', 4000))
        return effective_ai_limit(provider, settings, selected_profile_id)

    def _local_nmt_missing_message(settings: dict[str, Any]) -> str:
        model_id = str(settings.get('local_nmt', {}).get('model') or DEFAULT_LOCAL_NMT_MODEL)
        model_label = LOCAL_NMT_MODELS.get(model_id, LOCAL_NMT_MODELS[DEFAULT_LOCAL_NMT_MODEL])['short_label']
        if not translations.local_nmt.is_ready(model_id):
            return (
                f"مدل آفلاین «{model_label}» هنوز روی سیستم آماده نشده است. "
                "از دکمهٔ «مدیریت ترجمه‌ها…» در همین نوار بالا یک‌بار روی «دانلود و نصب خودکار» کلیک کنید تا پس از آن همیشه بدون اینترنت کار کند."
            )
        return ''

    def context_preparation(state: dict[str, Any], values: ContextPreviewRequest) -> tuple[dict[str, Any], Any, list[dict[str, Any]]]:
        if values.provider not in {'free', 'local', 'openai', 'gemini', 'openrouter', 'avalai'}:
            raise HTTPException(400, "سرویس ترجمه معتبر نیست.")
        if values.provider == 'free' and (values.skill or values.summary):
            raise TranslationError('مترجم رایگان از اسکیل یا خلاصهٔ AI پشتیبانی نمی‌کند.')
        if values.provider == 'local' and (values.skill or values.summary):
            raise TranslationError('مترجم آفلاین داخلی از اسکیل یا خلاصهٔ AI پشتیبانی نمی‌کند.')
        target_lang = normalize_target_language(values.target_language)
        selected_ids = set(image_ids(state, values.image_ids))
        ids = [item['id'] for item in sorted(state['images'], key=lambda item: item.get('order', 0)) if item['id'] in selected_ids]
        if not ids:
            raise HTTPException(400, "حداقل یک تصویر را انتخاب کنید.")
        settings = translations.public_settings()
        selected_profile_id = (values.profile_id or '').strip() if values.provider not in {'free', 'local'} else ''
        if selected_profile_id:
            configured_profiles = settings.get('providers', {}).get(values.provider, {}).get('profiles', [])
            if not any(str(p.get('id') or '') == selected_profile_id and p.get('hasApiKey') for p in configured_profiles):
                raise HTTPException(400, "کلید API انتخاب‌شده در تنظیمات این سرویس ثبت یا فعال نیست.")
        policy = provider_policy(settings, values.provider, selected_profile_id or None)
        is_direct_mt = values.provider in {'free', 'local'}
        if values.resume:
            run = state.get(RUN_KEY)
            if not isinstance(run, dict) or not any(j.get('remaining') for j in run.get('jobs', [])):
                raise HTTPException(409, "ترجمهٔ ناتمامی برای ادامه وجود ندارد.")
            if (run['imageIds'] != ids or run['provider'] != values.provider or (run.get('profileId') or '') != selected_profile_id
                    or (run.get('targetLanguage') or 'fa') != target_lang
                    or run['language'] != values.source_language or run['reuse'] != values.reuse_repeated):
                raise HTTPException(409, "انتخاب یا روش نوبت ناتمام تغییر کرده است؛ تنظیمات قبلی را برگردانید یا نوبت تازه شروع کنید.")
            # Resume previews may explicitly revise guidance, summary, budget,
            # or API policy; source and target snapshots must still match.
            verify_run(state, run, values.skill, None, check_skill=False)
            run = copy.deepcopy(run)
            run['baseResumeRunHash'] = digest(state.get(RUN_KEY))
            run['context'] = values.summary; run['skillHash'] = digest(values.skill); run['policyHash'] = digest(policy)
            run['limit'] = _direct_mt_limit(values.provider, settings, selected_profile_id or None)
            run['contextPercent'] = 0 if is_direct_mt else settings['context_percent']; run['skillPercent'] = 0 if is_direct_mt else settings['skill_percent']
        else:
            previous = state.get(RUN_KEY)
            if isinstance(previous, dict) and any(job.get('remaining') for job in previous.get('jobs', []) if isinstance(job, dict)) and not values.restart_existing:
                raise ProjectChangedError('نوبت ناتمام وجود دارد؛ شروع نوبت تازه را صریحاً تأیید کنید.')
            selected = [item for item in state['images'] if item['id'] in ids]
            legacy = any(item.get(AI_PAGE_PROGRESS_KEY) or any(block.get(AI_PARTS_KEY) for block in item.get('blocks', [])) for item in selected)
            if legacy and not values.restart_legacy:
                raise HTTPException(409, 'پیشرفت ناتمام نسخهٔ قبلی وجود دارد. برای جلوگیری از ارسال تکراری، ادامه را با نسخهٔ قبلی انجام دهید یا صریحاً شروع دوباره را تأیید کنید.')
            run = create_run(state, ids, values.provider, values.source_language, values.skill, values.summary,
                             _direct_mt_limit(values.provider, settings, selected_profile_id or None),
                             0 if is_direct_mt else settings['context_percent'], 0 if is_direct_mt else settings['skill_percent'],
                             values.reuse_repeated, policy, profile_id=selected_profile_id or None, target_language=target_lang)
            run['legacyRestart'] = values.restart_legacy
            run['legacyHash'] = digest([{'imageId': item['id'], 'page': item.get(AI_PAGE_PROGRESS_KEY),
                                         'parts': [block.get(AI_PARTS_KEY) for block in item.get('blocks', [])]}
                                        for item in selected])
        if values.provider == 'local' and not run.get('previewError'):
            missing_msg = _local_nmt_missing_message(settings)
            if missing_msg:
                run['previewError'] = missing_msg
        # A summary changed by another request after preview must not be
        # silently replaced by the stale summary accepted in this tab.
        run['baseSummaryHash'] = digest(state.get(SUMMARY_KEY, ''))
        if not values.resume: run['basePreviousRunHash'] = digest(state.get(RUN_KEY))
        try:
            if run.get('previewError'):
                raise TranslationError(run['previewError'])
            request, chosen = next_request(run, values.skill)
        except TranslationError as exc:
            # A non-fitting paragraph must not hide the preview controls. No
            # request is confirmable until the user changes the budget/text.
            request, chosen = build_run_request(run, values.skill), []
            run['previewError'] = str(exc)
        return run, request, chosen

    def context_view(run: dict[str, Any], request: Any, chosen: list[dict[str, Any]], provider: str) -> dict[str, Any]:
        text = combine_translation_texts([entry['text'] for entry in chosen])
        first = run['jobs'][chosen[0]['job']] if chosen else {}
        selected_profile_id = run.get('profileId') or None
        public_cfg = translations.public_settings()
        policy = provider_policy(public_cfg, provider, selected_profile_id)
        if digest(policy) != run['policyHash']:
            raise ProjectChangedError('تنظیمات API تغییر کرده است؛ پیش‌نمایش تازه بگیرید.')
        target_lang = normalize_target_language(run.get('targetLanguage', 'fa'))
        target_label = TARGET_LANGUAGES.get(target_lang, TARGET_LANGUAGES['fa'])['label']
        if provider == 'free':
            config = policy['services']
            limits = '؛ '.join(f"{name}: انتظار {p['timeout_seconds']}، تکرار {p['retry_count']}، فاصله {p['retry_wait_seconds']} ثانیه، سقف {p['source_limit']} نویسه" for name, p in config.items())
            return {'provider':'free', 'profileId': '', 'targetLanguage': target_lang, 'targetLanguageLabel': target_label,
                    'rollingMode':True, 'contextMode':False, 'skill':'', 'summary':'', 'defaultSkill':'',
                    'blockCount':len(run['jobs']), 'requestCount':1 if chosen else 0, 'systemPrompt':'',
                    'requests':[{'index':1, 'text':text, 'characters':request.character_count(text), 'imageName':first.get('imageName','')}] if chosen else [],
                    'providerLabel':'Google Translate؛ در صورت خطا MyMemory', 'base_url':'https://translate.googleapis.com/translate_a/single',
                    'fallback_url':'https://api.mymemory.translated.net/get', 'model':'',
                    'note':f"زبان مقصد: {target_label}. متن صفحه‌ها جداگانه و ترتیبی ارسال و ذخیره می‌شود؛ تأیید یک‌بار برای کل نوبت است. سقف مؤثر {run['limit']} نویسه و برای MyMemory حداکثر ۵۰۰ بایت UTF-8 است. {sum(len(job['refs']) - 1 for job in run['jobs'])} کادر تکراری. خلاصه و اسکیل AI در حالت رایگان استفاده نمی‌شوند. تنظیمات: {limits}.",
                    'signature':digest(run), 'totalLimit':run['limit'], 'resume':bool(run.get('id'))}
        if provider == 'local':
            model_id = str(policy.get('model') or DEFAULT_LOCAL_NMT_MODEL)
            model_info = LOCAL_NMT_MODELS.get(model_id, LOCAL_NMT_MODELS[DEFAULT_LOCAL_NMT_MODEL])
            return {'provider': 'local', 'profileId': '', 'targetLanguage': target_lang, 'targetLanguageLabel': target_label,
                    'rollingMode': True, 'contextMode': False, 'skill': '', 'summary': '', 'defaultSkill': '',
                    'blockCount': len(run['jobs']), 'requestCount': 1 if chosen else 0, 'systemPrompt': '',
                    'requests': [{'index': 1, 'text': text, 'characters': request.character_count(text), 'imageName': first.get('imageName', '')}] if chosen else [],
                    'providerLabel': f"مترجم آفلاین داخلی — {model_info['short_label']} (بدون اینترنت)",
                    'base_url': '', 'fallback_url': '', 'model': model_id,
                    'note': (
                        f"زبان مقصد: {target_label}. ترجمه ۱۰۰٪ آفلاین و رایگان روی سیستم خودتان با مدل «{model_info['label']}» "
                        f"(دقت جست‌وجو Beam={policy.get('beam_size', 2)}، سقف هر گام {run['limit']} نویسه) انجام می‌شود و هیچ متنی به اینترنت فرستاده نمی‌شود. "
                        f"{sum(len(job['refs']) - 1 for job in run['jobs'])} کادر تکراری."
                    ),
                    'previewError': run.get('previewError', ''),
                    'signature': digest(run), 'totalLimit': run['limit'], 'resume': bool(run.get('id'))}
        active = [profile for profile in policy['profiles'] if profile['hasApiKey']]
        mode_label = 'حالت JSON سرویس' if context_uses_json(provider, policy['base_url'], policy.get('response_mode', 'auto')) else 'متن معمولی'
        policies = '؛ '.join(f"API {index}: زمان انتظار {p['timeout_seconds']}، تکرار {p['retry_count']}، فاصله {p['retry_wait_seconds']} ثانیه، سقف {p['source_limit']}" for index, p in enumerate(active, 1))
        trim_notice = ' پس از تأیید، خلاصهٔ قبلی در یک درخواست جداگانه به AI داده می‌شود تا فقط آن را کوتاه کند و سپس در زمینهٔ نوبت قرار گیرد؛ این درخواست ممکن است هزینه داشته باشد.' if run.get('contextAutoShortened') else ''
        provider_title = AI_PROVIDERS.get(provider, {}).get('label', provider)
        if selected_profile_id:
            matched_profile = next((p for p in public_cfg.get('providers', {}).get(provider, {}).get('profiles', []) if str(p.get('id') or '') == selected_profile_id), None)
            if matched_profile and matched_profile.get('name'):
                provider_title = f"{provider_title} ({matched_profile['name']})"
        return {'provider': provider, 'profileId': selected_profile_id or '', 'targetLanguage': target_lang, 'targetLanguageLabel': target_label,
                'skill': '', 'defaultSkill': '', 'blockCount': len(run['jobs']),
                'requestCount': 1 if chosen else 0, 'systemPrompt': request.system,
                'requests': [{'index': 1, 'text': request.user_message(text), 'characters': request.character_count(text),
                              'imageName': first.get('imageName', '')}] if chosen else [],
                'providerLabel': provider_title, 'model': policy['model'], 'base_url': policy['base_url'],
                'note': f"زبان مقصد: {target_label}. درخواست اول دقیقاً نمایش داده شده؛ درخواست‌های بعدی با خلاصهٔ ساخته‌شده محاسبه می‌شوند و با همین تأیید به ترتیب ارسال خواهند شد. سقف کل {run['limit']}؛ سقف خلاصه {request.context_limit} و اسکیل {request.skill_limit} نویسه است. در هر درخواست مقدار استفاده‌نشده به متن مبدأ می‌رسد. {sum(len(job['refs']) - 1 for job in run['jobs'])} کادر تکراری با نتیجهٔ یکسان اعمال می‌شود. قالب پاسخ: {mode_label}. تکرار یا تلاش کلید دیگر ممکن است هزینه داشته باشد. تنظیمات: {policies or 'کلید فعالی ثبت نشده است'}.{trim_notice}",
                'signature': digest(run), 'rollingMode': True, 'contextMode': True, 'summary': run['context'], 'skillLimit': request.skill_limit,
                'contextLimit': request.context_limit, 'totalLimit': run['limit'], 'contextPercent': run['contextPercent'], 'skillPercent': run['skillPercent'], 'previewError': run.get('previewError', ''), 'resume': bool(run.get('id'))}

    @app.post("/api/projects/{project_id}/context-preview")
    def context_preview(project_id: str, values: ContextPreviewRequest) -> dict[str, Any]:
        run, request, chosen = context_preparation(project(project_id), values)
        result = context_view(run, request, chosen, values.provider)
        result['skill'] = values.skill
        from .translation import DEFAULT_AI_SKILL
        result['defaultSkill'] = DEFAULT_AI_SKILL
        return result

    @app.post("/api/projects/{project_id}/context-start")
    def context_start(project_id: str, values: ContextStartRequest) -> dict[str, Any]:
        for pending in pending_results.list_pending(store, project_id):
            if pending['kind'] == 'translation':
                raise PendingResultConflict(pending['id'], 'translation')
        state = project(project_id); expected = state.get('updatedAt', '')
        run, request, chosen = context_preparation(state, values)
        if values.confirmation != digest(run):
            raise HTTPException(409, "اطلاعات یا تنظیمات پس از پیش‌نمایش تغییر کرده است؛ دوباره بررسی و تأیید کنید.")
        if not chosen:
            raise HTTPException(400, "متنی برای ترجمه وجود ندارد.")
        def merge_latest_if_safe(latest: dict[str, Any]) -> None:
            nonlocal state, expected
            if latest.get('updatedAt', '') == expected:
                return
            policy_now = provider_policy(translations.public_settings(), values.provider, (values.profile_id or '').strip() or None if values.provider not in {'free', 'local'} else None)
            verify_run(latest, run, values.skill, policy_now)
            if digest(latest.get(SUMMARY_KEY, '')) != run.get('baseSummaryHash'):
                raise ProjectChangedError('خلاصهٔ پروژه پس از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی کنید.')
            expected_run_hash = run.get('baseResumeRunHash') if values.resume else run.get('basePreviousRunHash')
            if digest(latest.get(RUN_KEY)) != expected_run_hash:
                raise ProjectChangedError('وضعیت ترجمه پس از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی کنید.')
            selected_ids = set(run['imageIds'])
            current_legacy_hash = digest([{'imageId': item['id'], 'page': item.get(AI_PAGE_PROGRESS_KEY),
                                           'parts': [block.get(AI_PARTS_KEY) for block in item.get('blocks', [])]}
                                          for item in latest['images'] if item['id'] in selected_ids])
            if current_legacy_hash != run.get('legacyHash'):
                raise ProjectChangedError('پیشرفت ترجمهٔ قدیمی پس از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی کنید.')
            state = latest; expected = latest.get('updatedAt', '')
            activity.add('پروژه هنگام آماده‌سازی تغییر کرد؛ پس از بررسی امن، تغییرات هم‌زمان حفظ شدند.', 'warning')

        merge_latest_if_safe(project(project_id))
        if not values.resume:
            run['id'] = uuid.uuid4().hex
            if values.restart_legacy:
                for item in state['images']:
                    if item['id'] in run['imageIds']:
                        item.pop(AI_PAGE_PROGRESS_KEY, None)
                        for block in item.get('blocks', []): block.pop(AI_PARTS_KEY, None)
        state[RUN_KEY] = run
        if run['provider'] not in {'free', 'local'} and run['context']: state[SUMMARY_KEY] = run['context']
        try:
            store.save_if_unchanged(state, expected)
        except ProjectChangedError:
            # A benign autosave may race the final start write. Re-read and
            # merge only if source, targets, summary and run snapshot still match.
            merge_latest_if_safe(project(project_id))
            if not values.resume and values.restart_legacy:
                for item in state['images']:
                    if item['id'] in run['imageIds']:
                        item.pop(AI_PAGE_PROGRESS_KEY, None)
                        for block in item.get('blocks', []): block.pop(AI_PARTS_KEY, None)
            state[RUN_KEY] = run
            if run['provider'] not in {'free', 'local'} and run['context']: state[SUMMARY_KEY] = run['context']
            store.save_if_unchanged(state, expected)
        return {'project': state, 'runId': run['id'], 'completed': run['completed']}

    @app.post("/api/projects/{project_id}/context-step")
    async def context_step(project_id: str, values: ContextStepRequest, http_request: Request) -> dict[str, Any]:
        lock = context_locks.setdefault(project_id, asyncio.Lock())
        async with lock:
            state = project(project_id); expected = state.get('updatedAt', '')
            run = state.get(RUN_KEY)
            if not isinstance(run, dict) or run.get('id') != values.run_id or run.get('completed') != values.completed:
                raise HTTPException(409, "وضعیت این نوبت عوض شده است؛ پیش از ادامه پروژه را دوباره بررسی کنید.")
            for pending in pending_results.list_pending(store, project_id):
                if pending['kind'] == 'translation':
                    raise PendingResultConflict(pending['id'], 'translation')
            settings = translations.public_settings()
            if run['provider'] not in {'free', 'local'} and (settings['context_percent'] != run['contextPercent'] or settings['skill_percent'] != run['skillPercent']):
                raise ProjectChangedError('درصدهای خلاصه یا اسکیل تغییر کرده‌اند؛ نوبت متوقف شد.')
            policy = provider_policy(settings, run['provider'], run.get('profileId') or None)
            verify_run(state, run, values.skill, policy)
            request, chosen = next_request(run, values.skill)
            if run.pop('contextAutoShortened', False):
                context_to_condense = run.pop('contextToCondense', '')
                target_context_length = len(run['context'])
                if context_to_condense and target_context_length > 0:
                    condensed = ''
                    try:
                        condensed = await run_reported(
                            _call_with_target_lang, translations.condense_context, context_to_condense, target_context_length,
                            run['provider'], policy, target_language=run.get('targetLanguage', 'fa'),
                            pulse_label='در حال فشرده‌سازی خلاصهٔ قبلی',
                        )
                    except Exception as exc:
                        activity.add(f"فشرده‌سازی AI انجام نشد؛ برای جلوگیری از توقف از نسخهٔ کوتاه‌شده استفاده می‌شود. {exc}", 'warning')
                    if condensed:
                        run['context'] = condensed
                        state[RUN_KEY] = run; state[SUMMARY_KEY] = condensed
                        state = store.save_if_unchanged(state, expected)
                        expected = state.get('updatedAt', '')
                        activity.add(f"خلاصهٔ قبلی با درخواست جداگانه از AI فشرده شد؛ {len(condensed)} نویسه باقی ماند.", 'success')
                else:
                    activity.add('خلاصهٔ قبلی برای جا دادن جملهٔ بعدی خالی شد؛ درخواست جداگانهٔ فشرده‌سازی لازم نبود.', 'warning')
                request, chosen = next_request(run, values.skill)
            if not chosen:
                return {'project': state, 'done': True, 'affectedImageIds': []}
            source_texts = [entry['text'] for entry in chosen]
            text = combine_translation_texts(source_texts)
            label = f"درخواست {run['completed'] + 1} برای «{run['jobs'][chosen[0]['job']]['imageName']}»؛ {request.character_count(text)} از {run['limit']} نویسه"
            if run['provider'] == 'free':
                label += f"؛ {len(text.encode('utf-8'))} از ۵۰۰ بایت"
            elif run['provider'] == 'local':
                label += "؛ اجرای ۱۰۰٪ آفلاین روی سیستم شما"
            else:
                label += f"؛ خلاصه {len(run['context'])} از {request.context_limit} نویسه"
            cur_cp = context_progress(run)
            step_start_prog = cur_cp if cur_cp > 0 else None
            if values.recovery_token is not None:
                activity.add(f"بررسی محلی پاسخ اصلاح‌شده برای درخواست {run['completed'] + 1}، بدون ارسال مجدد به AI.", progress=step_start_prog)
            else:
                activity.add(label + '.', progress=step_start_prog)
                activity.add(f"متن دقیق درخواست {run['completed'] + 1} (بدون هدر احراز هویت):\nدستور سیستم:\n{request.system}\nپیام کاربر:\n{request.user_message(text)}")
            if (values.recovery_token is None) != (values.corrected_response is None):
                raise HTTPException(400, 'نشانه و متن پاسخ اصلاح‌شده باید همراه هم ارسال شوند.')
            if values.recovery_token is not None:
                entry = recovery_get(values.recovery_token, 'project')
                if run['provider'] in {'free', 'local'} or (entry['project_id'], entry['run_id'], entry['completed'], entry['updated_at']) != (project_id, values.run_id, values.completed, expected):
                    raise ProjectChangedError('پروژه یا نوبت پس از دریافت پاسخ تغییر کرده است؛ اصلاح اعمال نشد.')
                from .context_budget import parse_context_response
                try:
                    translated, summary = parse_context_response(values.corrected_response, source_texts, request.context_limit)
                except TranslationError as exc:
                    error = InvalidContextResponse(str(exc), values.corrected_response)
                    error.recovery_token = values.recovery_token
                    raise error from exc
            elif await http_request.is_disconnected():
                if run['provider'] == 'local' and not settings.get('local_nmt', {}).get('keep_loaded', False):
                    await run_in_threadpool(translations.local_nmt.unload)
                activity.add("ادامهٔ ترجمه با بستن پنجره متوقف شد.", "warning")
                return {'project': state, 'done': False, 'affectedImageIds': [], 'completed': run['completed']}
            elif run['provider'] == 'free':
                translated = await run_reported(
                    _call_with_target_lang, translations.translate_free_batch,
                    request, text, source_texts, run['language'], policy,
                    target_language=run.get('targetLanguage', 'fa'),
                    pulse_label='ترجمهٔ رایگان',
                )
                summary = ''
            elif run['provider'] == 'local':
                try:
                    translated = await run_reported(
                        functools.partial(
                            translations.translate_local_batch,
                            request,
                            text,
                            source_texts,
                            run['language'],
                            policy,
                            target_language=run.get('targetLanguage', 'fa'),
                            keep_loaded_override=True,
                        ),
                        pulse_label='ترجمهٔ آفلاین داخلی',
                    )
                except Exception:
                    if not settings.get('local_nmt', {}).get('keep_loaded', False):
                        await run_in_threadpool(translations.local_nmt.unload)
                    raise
                summary = ''
            else:
                try:
                    translated, summary = await run_reported(translations.translate_context, request, text, source_texts, run['provider'], policy, pulse_label='ترجمه و خلاصه')
                except InvalidContextResponse as exc:
                    exc.recovery_token = recovery_store({'kind':'project', 'project_id': project_id, 'run_id': values.run_id, 'completed': values.completed, 'updated_at': expected})
                    raise
            with store._lock:
                wanted = {(str(ref['imageId']), str(ref['blockId'])) for part in chosen for ref in run['jobs'][part['job']]['refs']}
                originals = {f"{item['id']}:{block.get('id')}": {'text':str(block.get('text') or ''), 'tr':str(block.get('tr') or '')}
                             for item in state['images'] for block in item.get('blocks', []) if (str(item['id']), str(block.get('id'))) in wanted}
                try:
                    entry = pending_results.stage(store, project_id, 'translation', {
                        'run':copy.deepcopy(run), 'runDigest':digest(run), 'chosen':copy.deepcopy(chosen),
                        'translated':translated, 'summary':summary, 'originals':originals,
                        'overlayMode':state.get('settings', {}).get('overlayMode'),
                    })
                except (OSError, KeyError) as exc:
                    raise ResultStorageError(translated, summary) from exc
                view = pending_results.inspect(store, project_id, entry)
                if not view['canApply'] or any(row['conflict'] for row in view['rows']):
                    raise PendingResultConflict(entry['id'], 'translation')
                try:
                    merged = pending_results.resolve(store, project_id, entry['id'], view['revision'], {})
                except OSError as exc:
                    # The AI response is already durable in .pending-results.
                    # If project.json could not be replaced, surface the pending
                    # result instead of making the user resend (and pay for) it.
                    current = store.get(project_id)
                    current_run = current.get(RUN_KEY)
                    if isinstance(current_run, dict) and current_run.get('lastPendingResult') == entry['id']:
                        # The project commit succeeded; only pending-file cleanup
                        # failed. Treat it as committed and let load() clean up later.
                        state = current; run = state[RUN_KEY]
                        affected = sorted({str(ref['imageId']) for part in entry['chosen']
                                           for ref in run['jobs'][part['job']].get('refs', [])})
                        done = not any(job.get('remaining') for job in run.get('jobs', []))
                    else:
                        raise PendingResultConflict(entry['id'], 'translation') from exc
                else:
                    state = merged['project']; run = state[RUN_KEY]; affected = merged['affectedImageIds']; done = merged['done']
            if values.recovery_token: recoveries.pop(values.recovery_token, None)
            activity.add(f"درخواست {run['completed']} ذخیره شد." if run['provider'] in {'free', 'local'} else f"درخواست {run['completed']} و خلاصهٔ {len(summary)} نویسه‌ای ذخیره شد.", 'success', context_progress(run))
            sent_payload = {'system': request.system, 'user': request.user_message(text), 'characters': request.character_count(text)}
            if done and run['provider'] == 'local' and not settings.get('local_nmt', {}).get('keep_loaded', False):
                await run_in_threadpool(translations.local_nmt.unload)
            elif done or affected:
                await run_in_threadpool(trim_process_memory)
            return {'project': state, 'done': done, 'affectedImageIds': affected, 'completed': run['completed'],
                    'sent': sent_payload}

    def prepare_context_text(values: ContextTextRequest) -> tuple[dict[str, Any], dict[str, Any], Any, list[dict[str, Any]]]:
        if values.provider not in {'free', 'local', 'openai', 'gemini', 'openrouter', 'avalai'}:
            raise HTTPException(400, 'سرویس ترجمه معتبر نیست.')
        state = {'images': [{'id': 'single', 'name': 'بازترجمهٔ یک کادر', 'order': 0,
                            'blocks': [{'id': 1, 'text': values.text, 'enabled': True, 'sourceLines': values.source_lines}]}]}
        settings = translations.public_settings()
        is_direct_mt = values.provider in {'free', 'local'}
        selected_profile_id = (values.profile_id or '').strip() if not is_direct_mt else ''
        if selected_profile_id:
            configured_profiles = settings.get('providers', {}).get(values.provider, {}).get('profiles', [])
            if not any(str(p.get('id') or '') == selected_profile_id and p.get('hasApiKey') for p in configured_profiles):
                raise HTTPException(400, 'کلید API انتخاب‌شده در تنظیمات این سرویس ثبت یا فعال نیست.')
        run = create_run(state, ['single'], values.provider, values.source_language, values.skill, values.summary,
                         _direct_mt_limit(values.provider, settings, selected_profile_id or None),
                         0 if is_direct_mt else settings['context_percent'], 0 if is_direct_mt else settings['skill_percent'],
                         False, provider_policy(settings, values.provider, selected_profile_id or None),
                         profile_id=selected_profile_id or None, target_language=values.target_language)
        if values.provider == 'local' and not run.get('previewError'):
            missing_msg = _local_nmt_missing_message(settings)
            if missing_msg:
                run['previewError'] = missing_msg
        if values.provider != 'free':
            try:
                if run.get('previewError'):
                    raise TranslationError(run['previewError'])
                request, chosen = next_request(run, values.skill)
            except TranslationError as exc:
                request, chosen = build_run_request(run, values.skill), []
                run['previewError'] = str(exc)
        else:
            request, chosen = next_request(run, values.skill)
        return state, run, request, chosen

    @app.post('/api/translate-text/context-preview')
    def context_text_preview(values: ContextTextRequest) -> dict[str, Any]:
        state, run, request, chosen = prepare_context_text(values)
        result = context_view(run, request, chosen, values.provider)
        result['skill'] = values.skill; result['singleContext'] = True
        from .translation import DEFAULT_AI_SKILL
        result['defaultSkill'] = DEFAULT_AI_SKILL
        if values.provider not in {'free', 'local'}: result['note'] += ' خلاصهٔ بازترجمهٔ تکی در حافظهٔ اصلی داستان ذخیره نمی‌شود.'
        elif values.provider == 'local': result['note'] += ' ترجمهٔ این تک‌جمله / تک‌کادر مستقیماً روی سیستم شما (آفلاین) انجام می‌شود.'
        else: result['note'] += ' بازترجمهٔ تکی پس از پایان همهٔ بخش‌ها ذخیره می‌شود؛ تکرار پس از خطا از ابتداست.'
        return result

    @app.post('/api/translate-text/context')
    async def context_text_translate(values: ContextTextRequest) -> dict[str, str]:
        if (values.recovery_token is None) != (values.corrected_response is None):
            raise HTTPException(400, 'نشانه و متن پاسخ اصلاح‌شده باید همراه هم ارسال شوند.')
        signature = digest(values.model_dump(exclude={'recovery_token', 'corrected_response'}))

        async def execute(entry: dict[str, Any] | None = None) -> dict[str, str]:
            if entry is None:
                state, run, request, chosen = prepare_context_text(values)
                if not values.confirmation or values.confirmation != digest(run):
                    raise HTTPException(409, 'متن یا تنظیمات پس از پیش‌نمایش تغییر کرده است.')
                if not chosen:
                    raise HTTPException(400, 'متنی برای ترجمه وجود ندارد.')
            else:
                if entry['signature'] != signature:
                    raise HTTPException(409, 'متن یا تنظیمات پاسخ اصلاح‌شده تغییر کرده است.')
                state, run = entry['state'], entry['run']
                request, chosen = next_request(run, values.skill)
            use_repair = entry is not None
            while chosen:
                settings = translations.public_settings()
                policy = provider_policy(settings, values.provider, run.get('profileId') or None)
                verify_run(state, run, values.skill, policy)
                if values.provider not in {'free', 'local'} and (settings['context_percent'] != run['contextPercent'] or settings['skill_percent'] != run['skillPercent']):
                    raise ProjectChangedError('درصدها پس از تأیید تغییر کرده‌اند.')
                sources = [item['text'] for item in chosen]
                text = combine_translation_texts(sources)
                if use_repair:
                    from .context_budget import parse_context_response
                    try:
                        translated, summary = parse_context_response(values.corrected_response, sources, request.context_limit)
                    except TranslationError as exc:
                        error = InvalidContextResponse(str(exc), values.corrected_response)
                        error.recovery_token = values.recovery_token
                        raise error from exc
                else:
                    activity.add(f"متن دقیق بازترجمه (بدون هدر احراز هویت):\nدستور سیستم:\n{request.system}\nپیام کاربر:\n{request.user_message(text)}")
                    if values.provider == 'free':
                        translated = await run_reported(
                            _call_with_target_lang, translations.translate_free_batch,
                            request, text, sources, values.source_language, policy,
                            target_language=values.target_language,
                            pulse_label='بازترجمهٔ رایگان',
                        )
                        summary = ''
                    elif values.provider == 'local':
                        translated = await run_reported(
                            functools.partial(
                                translations.translate_local_batch,
                                request,
                                text,
                                sources,
                                values.source_language,
                                policy,
                                target_language=values.target_language,
                            ),
                            pulse_label='بازترجمهٔ آفلاین داخلی',
                        )
                        summary = ''
                    else:
                        try:
                            translated, summary = await run_reported(translations.translate_context, request, text, sources, values.provider, policy, pulse_label='بازترجمه و خلاصه')
                        except InvalidContextResponse as exc:
                            exc.recovery_token = recovery_store({'kind':'single', 'state':state, 'run':run, 'signature':signature})
                            raise
                apply_response(state, run, chosen, translated, summary)
                if use_repair:
                    recoveries.pop(values.recovery_token, None)
                    use_repair = False
                request, chosen = next_request(run, values.skill)
            return {'text': run['jobs'][0]['accumulated'], 'summary': run['context']}

        if values.recovery_token:
            lock = recovery_locks.setdefault(values.recovery_token, asyncio.Lock())
            async with lock:
                try:
                    return await execute(recovery_get(values.recovery_token, 'single'))
                finally:
                    if values.recovery_token not in recoveries: recovery_locks.pop(values.recovery_token, None)
        return await execute()

    def legacy_direct_context(values: TranslateRequest) -> ContextPreviewRequest:
        return ContextPreviewRequest(
            image_ids=values.image_ids,
            provider=values.provider,
            source_language=values.source_language,
            target_language=values.target_language,
            reuse_repeated=values.reuse_repeated if values.reuse_repeated is not None else translations.public_settings()['reuse_repeated'],
        )

    @app.post("/api/projects/{project_id}/translation-preview")
    def translation_preview(project_id: str, values: TranslateRequest) -> dict[str, Any]:
        if values.provider in {'free', 'local'}:
            return context_preview(project_id, legacy_direct_context(values))
        state = project(project_id)
        ids = image_ids(state, values.image_ids)
        settings = translation_settings(values.provider, values.skill, values.target_language)
        reuse = values.reuse_repeated if values.reuse_repeated is not None else settings.get("reuse_repeated", True)
        plan = build_project_plan(state, ids, values.provider, reuse, values.source_language, settings)
        return plan_preview(plan, values.provider, values.source_language, settings)

    @app.post("/api/projects/{project_id}/translate")
    async def run_translation(project_id: str, values: TranslateRequest, http_request: Request) -> dict[str, Any]:
        if await http_request.is_disconnected():
            raise HTTPException(499, "عملیات ترجمه توسط کاربر لغو شد.")
        if values.provider in {'free', 'local'}:
            options = legacy_direct_context(values)
            run, request, chosen = context_preparation(project(project_id), options)
            if run.get('previewError'):
                raise HTTPException(400, run['previewError'])
            if not chosen:
                return project(project_id)
            signature = digest(run)
            if values.confirmation and values.confirmation != signature:
                raise HTTPException(409, 'متن یا تنظیمات پس از پیش‌نمایش تغییر کرده است.')
            started = context_start(project_id, ContextStartRequest(**options.model_dump(), confirmation=signature))
            completed = started['completed']
            while True:
                result = await context_step(project_id, ContextStepRequest(run_id=started['runId'], completed=completed, skill=''), http_request)
                completed = result['completed']
                if result['done']:
                    return result['project']
        state = project(project_id)
        expected_updated_at = state.get("updatedAt", "")
        ids = image_ids(state, values.image_ids)
        settings = translation_settings(values.provider, values.skill, values.target_language)
        reuse = values.reuse_repeated if values.reuse_repeated is not None else settings.get("reuse_repeated", True)
        plan = build_project_plan(state, ids, values.provider, reuse, values.source_language, settings)
        items, blocks = plan["items"], plan["blocks"]
        if not blocks:
            activity.add("در تصاویر انتخاب‌شده متن فعالی برای ترجمه نیست", "warning")
            return state
        calls_to_run = plan["calls"]
        signed_plan = plan
        if values.call_id is not None:
            if values.provider == "free" or (len(ids) != 1 and not values.call_image_id):
                raise HTTPException(400, "An AI task needs its page ID")
            task_image_id = values.call_image_id or ids[0]
            calls_to_run = [call for call in plan["calls"] if call.get("call_id") == values.call_id and call.get("image_id") == task_image_id]
            if len(calls_to_run) != 1:
                raise HTTPException(409, "بخش انتخاب‌شده تغییر کرده است؛ پیش‌نمایش تازه بگیرید.")
            signed_plan = call_plan(plan, calls_to_run[0])
        if values.confirmation:
            expected = plan_signature(signed_plan, values.provider, values.source_language, translation_settings(values.provider, values.skill, values.target_language))
            if values.confirmation != expected:
                raise HTTPException(409, "متن یا تنظیمات بعد از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی و دوباره تأیید کنید.")
        source_texts = plan["source_texts"]
        combined_free = plan["combined_free"]
        combined_source = combine_translation_texts(source_texts)
        if combined_free:
            activity.add(f"ترجمهٔ رایگان {len(items)} تصویر و {len(blocks)} متن آغاز شد؛ همهٔ متن OCR در یک query جمعی {len(combined_source)} نویسه‌ای ارسال می‌شود")
        elif values.provider == "free":
            activity.add(f"ترجمهٔ رایگان {len(items)} تصویر و {len(blocks)} متن آغاز شد؛ متن جمعی بیش از ۵۰۰ نویسه است و برای جلوگیری از خطای سقف، کادرها جدا و جمله‌ای ارسال می‌شوند")
        else:
            activity.add(f"ترجمهٔ AI برای {len(calls_to_run)} درخواست و {len(blocks)} متن آغاز شد؛ هر درخواست جداگانه ارسال می‌شود")
        completed_ai = 0
        try:
            translated_blocks = [""] * len(blocks)
            if combined_free:
                translated = await run_reported(
                    _call_with_target_lang, translations.translate, combined_source, values.source_language, values.provider,
                    target_language=values.target_language,
                    pulse_label="ترجمهٔ جمعی free همهٔ متن‌های OCR انتخاب‌شده",
                )
                activity.add("پاسخ مشترک free رسید؛ در حال تقسیم دقیق بین کادرهای OCR", progress=0.5)
                translated_blocks = distribute_translation(source_texts, translated)
            elif values.provider == "free":
                for index, call in enumerate(plan["calls"], start=1):
                    activity.add(f"ترجمهٔ رایگان متن {index} از {len(blocks)}", progress=(index - 1) / len(blocks))
                    translated = await run_reported(
                        _call_with_target_lang, translations.translate, call["text"], values.source_language, values.provider,
                        target_language=values.target_language,
                        pulse_label=f"ترجمهٔ رایگان متن {index} از {len(blocks)}",
                    )
                    translated = translated.strip()
                    if not translated:
                        raise TranslationError(f"مترجم برای متن {index} پاسخ خالی برگرداند؛ ترجمه‌ها در کادرها قرار نگرفتند.")
                    translated_blocks[call["indices"][0]] = translated
                    activity.add(f"متن {index} از {len(blocks)} ترجمه و آمادهٔ نشستن در کادر خودش شد", progress=index / len(blocks))
            else:
                # Direct API clients can submit several pages too. Save each
                # validated page atomically before sending the next one.
                for index, call in enumerate(calls_to_run, start=1):
                    current = project(project_id)
                    if current.get("updatedAt", "") != expected_updated_at:
                        raise ProjectChangedError("پروژه در حین ترجمه تغییر کرد؛ صفحهٔ بعد ارسال نشد. صفحه‌های ذخیره‌شده حفظ شده‌اند.")
                    if values.confirmation and values.confirmation != plan_signature(signed_plan, values.provider, values.source_language, translation_settings(values.provider, values.skill, values.target_language)):
                        raise HTTPException(409, "تنظیمات ترجمه تغییر کرده است؛ صفحهٔ بعد ارسال نشد. صفحه‌های ذخیره‌شده حفظ شده‌اند.")
                    settings = translation_settings(values.provider, values.skill, values.target_language)
                    if saved_call(call, plan, values.provider, values.source_language, settings):
                        activity.add(f"درخواست {index} از {len(calls_to_run)} قبلاً ذخیره شده بود", progress=index / len(calls_to_run))
                        continue
                    page_sources = [source_texts[i] for i in call["indices"]] if call.get("combined") else [call["text"]]
                    label = call.get("image_name") or call["image_id"]
                    page_index = values.batch_index if len(calls_to_run) == 1 and values.batch_index and values.batch_total and values.batch_index <= values.batch_total else index
                    page_total = values.batch_total if len(calls_to_run) == 1 and values.batch_index and values.batch_total and values.batch_index <= values.batch_total else len(calls_to_run)
                    activity.add(f"در حال ترجمهٔ درخواست {page_index} از {page_total}: {label}" + (f" · بند {call['paragraph']}، بخش {call.get('part_index', 0) + 1} از {call.get('part_count', 1)}" if call.get("paragraph") else ""))
                    translated = await run_reported(
                        _call_with_target_lang, translations.translate, call["text"], values.source_language, values.provider, page_sources, settings["_translation_skill"],
                        target_language=values.target_language,
                        pulse_label=f"ترجمهٔ درخواست {page_index} از {page_total}",
                    )
                    page_result = distribute_translation(page_sources, translated)
                    completed_block = True
                    if call.get("part_count", 1) > 1:
                        completed_block = False
                        block = blocks[call["indices"][0]]
                        fingerprint = part_fingerprint(call, plan, values.provider, values.source_language, settings)
                        saved = block.get(AI_PARTS_KEY)
                        if not isinstance(saved, dict) or saved.get("fingerprint") != fingerprint or not isinstance(saved.get("parts"), dict):
                            saved = {"fingerprint": fingerprint, "parts": {}}
                        saved["parts"][str(call["part_index"])] = page_result[0]
                        block[AI_PARTS_KEY] = saved
                        if all(str(i) in saved["parts"] for i in range(call["part_count"])):
                            output = saved["parts"]["0"]
                            for i, join in enumerate(call["joins"], start=1):
                                output += join + saved["parts"][str(i)]
                            block["tr"] = output; block["richHtml"] = ""
                            context_run.apply_translated_block_defaults(block, target_language=values.target_language)
                            block.pop(AI_PARTS_KEY, None); block.pop(AI_REUSE_KEY, None)
                            page_result = [output]
                            completed_block = True
                    if completed_block:
                        for block_index, target_indices, text in zip(call["indices"], call.get("targets", [[i] for i in call["indices"]]), page_result):
                            for target_index in target_indices:
                                block = blocks[target_index]
                                block["tr"] = text; block["richHtml"] = ""
                                context_run.apply_translated_block_defaults(block, target_language=values.target_language)
                                block.pop(AI_PARTS_KEY, None); block.pop(AI_REUSE_KEY, None)
                                if target_index != block_index:
                                    mark_reused_translation(block, source_texts[target_index], values.provider, values.source_language, settings)
                    mark_completed_call(call, plan, values.provider, values.source_language, settings, completed_block)
                    try:
                        store.save_if_unchanged(state, expected_updated_at)
                    except OSError as exc:
                        # Unlike context-step, this legacy direct route has no
                        # pending-result record. Return the validated output so
                        # a transient disk lock cannot silently discard it.
                        raise ResultStorageError("\n".join(page_result), "") from exc
                    expected_updated_at = state.get("updatedAt", "")
                    completed_ai += 1
                    activity.add(f"درخواست {page_index} از {page_total} ترجمه و ذخیره شد: {label}", "success", page_index / page_total)
            if values.provider == "free":
                for block, text in zip(blocks, translated_blocks):
                    block["tr"] = text
                    block["richHtml"] = ""
                    context_run.apply_translated_block_defaults(block, target_language=values.target_language)
                try:
                    store.save_if_unchanged(state, expected_updated_at)
                except OSError as exc:
                    raise ResultStorageError("\n".join(translated_blocks), "") from exc
        except Exception as exc:
            if completed_ai:
                message = f"{completed_ai} درخواست ذخیره شد؛ درخواست ناموفق ذخیره نشد و درخواست‌های پس از آن ارسال نشدند. "
                if isinstance(exc, HTTPException):
                    exc.detail = message + str(exc.detail)
                else:
                    exc.args = (message + str(exc),)
            activity.add(f"ترجمه ناموفق بود: {exc}", "error")
            raise
        finally:
            await run_in_threadpool(trim_process_memory)
        if combined_free:
            activity.add(f"همهٔ {len(blocks)} متن OCR با هم و در یک درخواست free ترجمه و در کادرهای خودشان قرار گرفتند", "success", 1.0)
        elif values.provider == "free":
            activity.add(f"هر {len(blocks)} متن جدا ترجمه و در کادرهای خودشان قرار گرفتند", "success", 1.0)
        elif not values.batch_total or values.batch_index == values.batch_total:
            activity.add(f"ترجمهٔ صفحه‌های درخواست‌شده پایان یافت؛ هر صفحه جداگانه ذخیره شد", "success", 1.0)
        return state

    @app.post("/api/translate-text/preview")
    def translate_text_preview(values: TextTranslateRequest) -> dict[str, Any]:
        if values.provider in {'free', 'local'}:
            return context_text_preview(ContextTextRequest(
                text=values.text,
                source_lines=values.source_lines,
                source_language=values.source_language,
                target_language=values.target_language,
                provider=values.provider,
            ))
        settings = translation_settings(values.provider, values.skill, values.target_language)
        plan = build_single_plan(values.text, values.provider, settings, values.source_lines)
        return plan_preview(plan, values.provider, values.source_language, settings)

    @app.post("/api/translate-text")
    async def translate_text(values: TextTranslateRequest) -> dict[str, str]:
        if values.provider in {'free', 'local'}:
            request = ContextTextRequest(
                text=values.text,
                source_lines=values.source_lines,
                source_language=values.source_language,
                target_language=values.target_language,
                provider=values.provider,
            )
            preview = context_text_preview(request)
            if preview.get('previewError'):
                raise HTTPException(400, preview['previewError'])
            if values.confirmation and values.confirmation != preview['signature']:
                raise HTTPException(409, 'متن یا تنظیمات پس از پیش‌نمایش تغییر کرده است.')
            result = await context_text_translate(request.model_copy(update={'confirmation': preview['signature']}))
            return {'text': result['text']}
        settings = translation_settings(values.provider, values.skill, values.target_language)
        if values.confirmation:
            plan = build_single_plan(values.text, values.provider, settings, values.source_lines)
            expected = plan_signature(plan, values.provider, values.source_language, settings)
            if values.confirmation != expected:
                raise HTTPException(409, "متن یا تنظیمات بعد از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی و دوباره تأیید کنید.")
        activity.add("ترجمهٔ دوبارهٔ یک خط آغاز شد")
        plan = build_single_plan(values.text, values.provider, settings, values.source_lines)
        try:
            responses = []
            for call in plan["calls"]:
                if values.provider == "free":
                    translated_part = await run_reported(
                        _call_with_target_lang, translations.translate, call["text"], values.source_language, values.provider,
                        target_language=values.target_language,
                    )
                else:
                    translated_part = await run_reported(
                        _call_with_target_lang, translations.translate, call["text"], values.source_language, values.provider, None, normalize_ai_skill(values.skill),
                        target_language=values.target_language,
                    )
                responses.append(translated_part)
            translated = responses[0] if responses else ""
            if responses:
                for index, join in enumerate(plan["calls"][0].get("joins", []), start=1):
                    translated += join + responses[index]
        except Exception as exc:
            activity.add(f"ترجمهٔ دوباره ناموفق بود: {exc}", "error")
            raise
        activity.add("ترجمهٔ دوبارهٔ خط تمام شد", "success")
        return {"text": translated}

    @app.get("/api/ai-settings")
    def ai_settings() -> dict[str, Any]:
        return translations.public_settings()

    @app.put("/api/ai-settings")
    def save_ai_settings(values: AiSettings) -> dict[str, Any]:
        try:
            return translations.save_settings(values.model_dump(exclude_none=True))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/ai-settings/test")
    async def test_ai_settings(values: AiConnectionTest | None = None) -> dict[str, Any]:
        overrides = values.model_dump(exclude_none=True) if values else {}
        return await run_in_threadpool(translations.test_connection, overrides)

    @app.get("/api/local-nmt/status")
    def local_nmt_status() -> dict[str, Any]:
        cfg = translations.public_settings().get("local_nmt", {})
        return translations.local_nmt.status(cfg.get("model", DEFAULT_LOCAL_NMT_MODEL))

    @app.post("/api/local-nmt/prepare")
    async def prepare_local_nmt(request: Request, values: LocalNmtModelActionRequest | None = None) -> dict[str, Any]:
        model_id = values.model if values else DEFAULT_LOCAL_NMT_MODEL
        done_ev = asyncio.Event()

        async def _watch_nmt_disconnect() -> None:
            while not done_ev.is_set():
                try:
                    await asyncio.wait_for(done_ev.wait(), timeout=0.6)
                    return
                except asyncio.TimeoutError:
                    try:
                        if await request.is_disconnected():
                            translations.local_nmt.cancel_prepare()
                            return
                    except Exception:
                        return

        watch_task = asyncio.create_task(_watch_nmt_disconnect())
        try:
            status_payload = await run_reported(
                translations.local_nmt.prepare,
                model_id,
                pulse_label="دانلود و آماده‌سازی مترجم آفلاین",
            )
            return {"ok": True, "status": status_payload, "memory": registry.memory_status()}
        except LocalNmtError as exc:
            activity.add(f"آماده‌سازی مترجم آفلاین متوقف شد: {exc}", "warning" if "لغو" in str(exc) else "error")
            raise HTTPException(400, str(exc)) from exc
        finally:
            done_ev.set()
            watch_task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await watch_task

    @app.post("/api/local-nmt/cancel")
    def cancel_local_nmt_prepare() -> dict[str, Any]:
        result = translations.local_nmt.cancel_prepare()
        activity.add("درخواست لغو دانلود مترجم آفلاین ثبت شد.", "warning")
        return result

    @app.post("/api/local-nmt/delete")
    async def delete_local_nmt_model(values: LocalNmtModelActionRequest) -> dict[str, Any]:
        try:
            summary = await run_reported(
                translations.local_nmt.delete_model,
                values.model,
                pulse_label="حذف مدل مترجم آفلاین",
            )
            return {**summary, "memory": registry.memory_status()}
        except LocalNmtError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/local-nmt/unload")
    async def unload_local_nmt() -> dict[str, Any]:
        summary = await run_in_threadpool(translations.local_nmt.unload)
        activity.add("مدل مترجم آفلاین از حافظهٔ رم آزاد شد.", "success")
        return {**summary, "status": translations.local_nmt.status(), "memory": registry.memory_status()}

    @app.post("/api/local-nmt/test")
    async def test_local_nmt(values: LocalNmtTestRequest | None = None) -> dict[str, Any]:
        req = values or LocalNmtTestRequest()
        try:
            return await run_reported(
                functools.partial(
                    translations.local_nmt.test_translation,
                    model_id=req.model,
                    source_language=req.source_language,
                    target_language=req.target_language,
                    sample_text=req.sample_text,
                    beam_size=req.beam_size,
                    keep_loaded=req.keep_loaded,
                ),
                pulse_label="تست ترجمهٔ آفلاین یک جمله",
            )
        except LocalNmtError as exc:
            raise HTTPException(400, str(exc)) from exc

    def _require_local_storage_admin(request: Request) -> None:
        peer_host = request.client.host if request.client else ""
        if not (_is_loopback_peer(peer_host) or peer_host == "testclient"):
            raise HTTPException(403, "تغییر مسیر ذخیره‌سازی فقط از روی همین کامپیوتر مجاز است.")

    @app.get("/api/storage-settings")
    def storage_settings() -> dict[str, Any]:
        return inspect_storage_status()

    @app.post("/api/storage-settings/pick-folder")
    async def pick_storage_folder(
        request: Request,
        values: StorageFolderPickRequest | None = None,
    ) -> dict[str, Any]:
        _require_local_storage_admin(request)
        init_dir = (values.initial_dir or "").strip() if values else ""
        try:
            chosen = await run_in_threadpool(pick_folder_dialog, init_dir or None)
        except RuntimeError as exc:
            raise HTTPException(400, str(exc)) from exc
        clean = str(chosen or "").strip()
        return {"cancelled": not bool(clean), "path": clean}

    @app.put("/api/storage-settings")
    async def update_storage_settings(
        request: Request,
        values: StorageSettingsUpdate,
    ) -> dict[str, Any]:
        _require_local_storage_admin(request)
        if storage_switch_lock.locked():
            raise HTTPException(409, "تغییر مسیر ذخیره‌سازی هم‌اکنون در حال انجام است.")
        async with storage_switch_lock:
            with active_jobs_lock:
                jobs_busy = active_jobs_count > 0
            if jobs_busy or _INSTALL_LOCK.locked() or any(lock.locked() for lock in context_locks.values()):
                raise HTTPException(
                    409,
                    "در حال حاضر یک عملیات (دانلود مدل، OCR، ترجمه یا خروجی) فعال است؛ پس از پایان یا لغو آن مسیر ذخیره‌سازی را تغییر دهید.",
                )

            def _perform_switch() -> dict[str, Any]:
                translations.local_nmt.unload()
                registry.unload_all()
                _stop_lingering_surya_server()
                result = apply_storage_directory(
                    values.custom_path,
                    migrate_existing=values.migrate_existing,
                    cleanup_source=values.cleanup_source,
                    progress_cb=lambda msg, prog: activity.add(msg, progress=prog),
                )
                store.reset_caches()
                invalidate_engine_runtime_caches()
                reset_disk_free_cache()
                _clear_prepared_backups()
                cleanup_backup_temp(max_age_seconds=0.0)
                recoveries.clear()
                trim_process_memory()
                return result

            try:
                storage_result = await run_reported(
                    _perform_switch,
                    pulse_label="انتقال و تنظیم مسیر ذخیره‌سازی",
                )
            except ValueError as exc:
                activity.add(f"تغییر مسیر ذخیره‌سازی ناموفق بود: {exc}", "error")
                raise HTTPException(400, str(exc)) from exc
            except OSError as exc:
                activity.add(f"خطا در انتقال یا ذخیرهٔ مسیر جدید: {exc}", "error")
                raise HTTPException(500, f"تغییر مسیر ذخیره‌سازی با خطای فایل مواجه شد: {exc}") from exc

            projects_list = store.list()
            active_project = store.get(projects_list[0]["id"]) if projects_list else store.create("پروژهٔ کمیک")
            if not projects_list:
                projects_list = store.list()
            activity.add(
                f"مسیر ذخیره‌سازی فعال: {storage_result['activePath']}",
                "success",
                1.0,
            )
            return {
                "storage": storage_result,
                "projects": projects_list,
                "activeProject": active_project,
                "engines": registry.status(),
                "ai": translations.public_settings(),
            }

    @app.post("/api/projects/{project_id}/export")
    async def export(project_id: str, values: ExportRequest) -> FileResponse:
        state = project(project_id)
        if not values.image_ids:
            raise HTTPException(400, "حداقل یک تصویر را برای خروجی انتخاب کنید.")
        request = values.model_dump()
        activity.add(f"ساخت خروجی {values.kind.upper()} آغاز شد")
        try:
            if values.kind == "pdf":
                path = await run_reported(build_pdf, store, state, request, pulse_label="ساخت PDF")
            elif values.kind == "images":
                path = await run_reported(build_images_zip, store, state, request, pulse_label="ساخت ZIP")
            elif values.kind == "docx":
                path = await run_reported(build_docx, store, state, request, pulse_label="ساخت فایل Word")
            elif values.kind == "pptx":
                path = await run_reported(build_pptx, store, state, request, pulse_label="ساخت فایل PowerPoint")
            else:
                path = await run_reported(build_txt, store, state, request, pulse_label="ساخت TXT")
        except ValueError as exc:
            activity.add(f"ساخت خروجی ناموفق بود: {exc}", "error")
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            activity.add(f"ساخت خروجی ناموفق بود: {exc}", "error")
            raise
        finally:
            if values.kind in {"pdf", "images", "docx", "pptx"}:
                await run_in_threadpool(trim_process_memory)
        activity.add(f"خروجی {values.kind.upper()} آماده شد", "success", 1.0)
        media_type = {
            "pdf": "application/pdf",
            "images": "application/zip",
            "txt": "text/plain; charset=utf-8",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }[values.kind]
        return FileResponse(path, media_type=media_type, filename=path.name)

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
