from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import ipaddress
import os
import re
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
from .backup import BackupError, make_backup, restore_backup
from .exporter import build_images_zip, build_pdf, build_txt, image_payload
from .ocr import ENGINE_INFO, LANGUAGES, EngineRegistry, OcrError, recognize_image
from .ocr_grouping import group_ocr_lines
from .paths import STATIC_DIR
from . import pending_results
from .schemas import (
    AiConnectionTest, AiSettings, BackupRequest, ContextPreviewRequest, ContextStartRequest, ContextStepRequest, ContextTextRequest, EngineDownloadRequest, EngineTestRequest, ExportRequest, OcrRequest, ProjectCreate,
    SessionRequest, StateUpdate, TextTranslateRequest, TranslateRequest,
)
from .sessions import SessionManager
from .store import ProjectChangedError, ProjectStore
from .translation import (
    TranslationError, InvalidContextResponse, TranslationService, combine_translation_texts,
    distribute_translation, normalize_ai_skill, context_uses_json, _redact_diagnostic,
)
from .translation_plan import (
    AI_PAGE_PROGRESS_KEY, AI_PARTS_KEY, AI_REUSE_KEY, build_project_plan, build_single_plan, call_plan, mark_completed_call, mark_reused_translation, part_fingerprint,
    plan_preview, plan_signature, saved_call, effective_ai_limit,
)

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


def create_app() -> FastAPI:
    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    store = ProjectStore()
    registry = EngineRegistry()
    translations = TranslationService()
    activity = ActivityLog()
    sessions = SessionManager()
    context_locks: dict[str, asyncio.Lock] = {}
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
            try:
                peer = ipaddress.ip_address(request.client.host if request.client else "")
                if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped:
                    peer = peer.ipv4_mapped
                local = peer.is_loopback
            except ValueError:
                local = False
            if not local:
                return JSONResponse({"detail": "Remote access is disabled. Configure COMIC_STUDIO_ACCESS_PASSWORD and HTTPS or a trusted VPN."}, status_code=403,
                                    headers={"Cache-Control": "no-store"})
            # Reject arbitrary DNS names on an unauthenticated loopback server;
            # otherwise a malicious site can rebind its hostname to localhost.
            try:
                host = urlsplit("http://" + request.headers.get("host", ""))
                hostname = host.hostname or ""
                _ = host.port  # Validate even an unused explicit port.
                if host.username is not None or host.password is not None or host.path or host.query or host.fragment:
                    local_host = False
                elif hostname.lower() == "localhost":
                    local_host = True
                else:
                    address = ipaddress.ip_address(hostname)
                    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                        address = address.ipv4_mapped
                    local_host = address.is_loopback
            except ValueError:
                local_host = False
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

    async def run_reported(function: Any, *args: Any, pulse_label: str | None = None) -> Any:
        stop_pulse = threading.Event()
        started = time.monotonic()
        pulse = None
        if pulse_label:
            def report_alive() -> None:
                while not stop_pulse.wait(5):
                    activity.add(f"{pulse_label} همچنان در حال انجام است · {int(time.monotonic() - started)} ثانیه")
            pulse = threading.Thread(target=report_alive, daemon=True)
            pulse.start()
        try:
            with reporting(activity.add):
                return await run_in_threadpool(function, *args)
        finally:
            stop_pulse.set()
            if pulse:
                pulse.join(timeout=0.1)

    def project(project_id: str) -> dict[str, Any]:
        try:
            return store.get(project_id)
        except KeyError as exc:
            raise HTTPException(404, "Project not found") from exc

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
    async def backup_project(project_id: str, values: BackupRequest) -> FileResponse:
        project(project_id)
        activity.add("ساخت بک‌آپ پروژه آغاز شد")
        try:
            path = await run_reported(make_backup, store, project_id, values.drafts, values.expected_updated_at, pulse_label="ساخت بک‌آپ")
        except BackupError as exc:
            activity.add(f"ساخت بک‌آپ ناموفق بود: {exc}", "error")
            raise HTTPException(400, str(exc)) from exc
        activity.add("بک‌آپ پروژه آماده است", "success", 1.0)
        return FileResponse(path, media_type="application/zip", filename="comic-studio-project-backup.zip", background=BackgroundTask(path.unlink, missing_ok=True))

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict[str, Any]:
        return project(project_id)

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: str) -> Response:
        try:
            store.delete_project(project_id)
        except KeyError as exc:
            raise HTTPException(404, "Project not found") from exc
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
            raise HTTPException(400, "No files supplied")
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

    @app.get("/api/projects/{project_id}/images/{image_id}/content")
    def image_content(project_id: str, image_id: str, edited: bool = False, cropped: bool = False) -> Response:
        try:
            if cropped:
                item = store.image(project_id, image_id)
                data, _, _, _ = image_payload(store, project_id, item, "png")
                return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})
            path = store.image_path(project_id, image_id, edited)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "Image not found") from exc
        return FileResponse(path, headers={"Cache-Control": "no-store"})

    @app.post("/api/projects/{project_id}/images/{image_id}/rendered")
    async def save_rendered(project_id: str, image_id: str, request: Request) -> dict[str, Any]:
        content = await request.body()
        if not content:
            raise HTTPException(400, "Empty rendered image")
        try:
            return await run_in_threadpool(store.save_rendered, project_id, image_id, content)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "Image not found") from exc
        except Exception as exc:
            raise HTTPException(400, f"Invalid PNG: {exc}") from exc

    @app.post("/api/projects/{project_id}/images/{image_id}/revert")
    def revert_rendered(project_id: str, image_id: str) -> dict[str, Any]:
        try:
            return store.revert_rendered(project_id, image_id)
        except KeyError as exc:
            raise HTTPException(404, "Image not found") from exc

    @app.post("/api/projects/{project_id}/duplicate")
    def duplicate(project_id: str, ids: list[str] = Body(...)) -> dict[str, Any]:
        return store.duplicate(project_id, ids)

    @app.post("/api/projects/{project_id}/delete")
    def delete(project_id: str, ids: list[str] = Body(...)) -> dict[str, Any]:
        return store.delete(project_id, ids)

    @app.get("/api/engines")
    def engines() -> list[dict[str, Any]]:
        return registry.status()

    @app.post("/api/engines/{engine_id}/download")
    async def download_engine(engine_id: str, values: EngineDownloadRequest | None = None) -> dict[str, Any]:
        registry.get(engine_id)
        info = ENGINE_INFO[engine_id]
        if info.get("action") == "guide":
            return {"ok": False, "guide": True, "engine": {"id": engine_id, **info}, "engines": registry.status()}
        language = values.language if values else "eng"
        if language not in info["languages"]:
            raise HTTPException(400, "This engine does not support the selected language")
        activity.add(f"آماده‌سازی {info['name']} برای زبان {language} آغاز شد؛ دانلود فقط با درخواست شما انجام می‌شود")
        try:
            await run_reported(registry.download, engine_id, language, pulse_label=f"آماده‌سازی {info['name']}")
        except Exception as exc:
            activity.add(f"آماده‌سازی {info['name']} ناموفق بود: {exc}", "error")
            raise
        activity.add(f"مدل {info['name']} برای {language} آماده شد", "success", 1.0)
        return {"ok": True, "language": language, "engines": registry.status()}

    @app.post("/api/engines/{engine_id}/test")
    async def test_engine(engine_id: str, values: EngineTestRequest) -> dict[str, Any]:
        engine = registry.get(engine_id)
        if not ENGINE_INFO[engine_id].get("selectable", False):
            raise HTTPException(400, "This model requires its official external runtime and is not a direct comic OCR engine")
        if values.language not in ENGINE_INFO[engine_id]["languages"]:
            raise HTTPException(400, "This engine does not support the selected language")
        state = project(values.project_id)
        try:
            path = store.image_path(values.project_id, values.image_id)
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(404, "Image not found") from exc
        from PIL import Image
        with Image.open(path) as im:
            image = im.copy()
        activity.add(f"آزمایش {ENGINE_INFO[engine_id]['name']} روی {path.name} آغاز شد")
        try:
            blocks = await run_reported(recognize_image, engine, image, values.language, True, True, 0.2, pulse_label=f"آزمایش {ENGINE_INFO[engine_id]['name']}")
        except Exception as exc:
            activity.add(f"آزمایش موتور ناموفق بود: {exc}", "error")
            raise
        activity.add(f"آزمایش تمام شد؛ {len(blocks)} خط تشخیص داده شد", "success", 1.0)
        return {"engine": engine_id, "imageId": values.image_id, "blocks": blocks}

    @app.post("/api/projects/{project_id}/ocr")
    async def run_ocr(project_id: str, values: OcrRequest) -> dict[str, Any]:
        with store._lock:
            state = project(project_id)
            expected_updated_at = state.get("updatedAt", "")
            baseline = {item['id']: pending_results.ocr_signature(store, state, item['id']) for item in state['images']}
            original_ocr = {item['id']: '\n'.join(str(b.get('text') or '') for b in item.get('blocks', [])) for item in state['images']}
        engine = registry.get(values.engine)
        if not ENGINE_INFO[values.engine].get("selectable", False):
            raise HTTPException(400, "This model requires its official external runtime and is not a direct comic OCR engine")
        if values.language not in LANGUAGES or values.language not in ENGINE_INFO[values.engine]["languages"]:
            raise HTTPException(400, "This engine does not support the selected language")
        ids = image_ids(state, values.image_ids)
        if not ids:
            raise HTTPException(400, "No images selected")
        for pending in pending_results.list_pending(store, project_id):
            if pending['kind'] == 'ocr':
                entry = pending_results.load(store, project_id, pending['id'])
                if set(ids).intersection(output['id'] for output in entry['outputs']):
                    raise PendingResultConflict(pending['id'], 'ocr')
        activity.add(f"خواندن متن در {len(ids)} تصویر آغاز شد")
        completed = 0
        try:
            for item in state["images"]:
                if item["id"] not in ids:
                    continue
                completed += 1
                activity.add(f"در حال خواندن تصویر {completed} از {len(ids)}: {item['name']}", progress=(completed - 1) / len(ids))
                path = store.image_path(project_id, item["id"])
                from PIL import Image
                with Image.open(path) as im:
                    image = im.copy()
                blocks = await run_reported(
                    recognize_image, engine, image, values.language,
                    values.contrast, values.precise, values.min_confidence,
                    pulse_label=f"در حال خواندن {item['name']}",
                )
                for block in blocks:
                    block["bg"] = "auto" if state.get("settings", {}).get("eraseOriginal", True) else "none"
                if values.group_lines:
                    blocks = group_ocr_lines(blocks)
                item["blocks"] = blocks
                item["ocrCompleted"] = True
                item["edited"] = False
                activity.add(f"در «{item['name']}» {len(blocks)} تکه متن پیدا شد", progress=completed / len(ids))
                recognized_lines = [block.get("text", "").strip() for block in blocks if block.get("text", "").strip()]
                if recognized_lines:
                    activity.add(f"متن خوانده‌شده در «{item['name']}»:\n" + "\n".join(recognized_lines))
                else:
                    activity.add(f"در «{item['name']}» متنی پیدا نشد", "warning")
            with store._lock:
                entry = pending_results.stage(store, project_id, 'ocr', {
                    'baseline': {i: baseline[i] for i in ids}, 'originals': {i: original_ocr[i] for i in ids},
                    'overlayMode': state.get('settings', {}).get('overlayMode'),
                    'outputs': [{'id':item['id'], 'name':item.get('name', ''), 'blocks':item['blocks']} for item in state['images'] if item['id'] in ids],
                })
                view = pending_results.inspect(store, project_id, entry)
                if any(row['conflict'] for row in view['rows']):
                    raise PendingResultConflict(entry['id'], 'ocr')
                merged = pending_results.resolve(store, project_id, entry['id'], view['revision'], {})
                state = merged['project']
        except Exception as exc:
            activity.add(f"خواندن متن ناموفق بود: {exc}", "error")
            raise
        activity.add("OCR تمام شد؛ متن هر تصویر در گزارش بالا آمده است", "success", 1.0)
        return state

    def translation_settings(provider: str, skill: str | None) -> dict[str, Any]:
        return {**translations.public_settings(), "_translation_skill": normalize_ai_skill(skill) if provider != "free" else ""}

    def context_preparation(state: dict[str, Any], values: ContextPreviewRequest) -> tuple[dict[str, Any], Any, list[dict[str, Any]]]:
        if values.provider not in {'free', 'openai', 'gemini', 'openrouter', 'avalai'}:
            raise HTTPException(400, "سرویس ترجمه معتبر نیست.")
        if values.provider == 'free' and (values.skill or values.summary):
            raise TranslationError('مترجم رایگان از اسکیل یا خلاصهٔ AI پشتیبانی نمی‌کند.')
        selected_ids = set(image_ids(state, values.image_ids))
        ids = [item['id'] for item in sorted(state['images'], key=lambda item: item.get('order', 0)) if item['id'] in selected_ids]
        if not ids:
            raise HTTPException(400, "حداقل یک تصویر را انتخاب کنید.")
        settings = translations.public_settings()
        policy = provider_policy(settings, values.provider)
        if values.resume:
            run = state.get(RUN_KEY)
            if not isinstance(run, dict) or not any(j.get('remaining') for j in run.get('jobs', [])):
                raise HTTPException(409, "ترجمهٔ ناتمامی برای ادامه وجود ندارد.")
            if (run['imageIds'] != ids or run['provider'] != values.provider or run['language'] != values.source_language
                    or run['reuse'] != values.reuse_repeated):
                raise HTTPException(409, "انتخاب یا روش نوبت ناتمام تغییر کرده است؛ تنظیمات قبلی را برگردانید یا نوبت تازه شروع کنید.")
            # Resume previews may explicitly revise guidance, summary, budget,
            # or API policy; source and target snapshots must still match.
            verify_run(state, run, values.skill, None, check_skill=False)
            run = copy.deepcopy(run)
            run['context'] = values.summary; run['skillHash'] = digest(values.skill); run['policyHash'] = digest(policy)
            run['limit'] = min(s['source_limit'] for s in settings['free_services'].values()) if values.provider == 'free' else effective_ai_limit(values.provider, settings)
            run['contextPercent'] = 0 if values.provider == 'free' else settings['context_percent']; run['skillPercent'] = 0 if values.provider == 'free' else settings['skill_percent']
        else:
            previous = state.get(RUN_KEY)
            if isinstance(previous, dict) and any(job.get('remaining') for job in previous.get('jobs', []) if isinstance(job, dict)) and not values.restart_existing:
                raise ProjectChangedError('نوبت ناتمام وجود دارد؛ شروع نوبت تازه را صریحاً تأیید کنید.')
            selected = [item for item in state['images'] if item['id'] in ids]
            legacy = any(item.get(AI_PAGE_PROGRESS_KEY) or any(block.get(AI_PARTS_KEY) for block in item.get('blocks', [])) for item in selected)
            if legacy and not values.restart_legacy:
                raise HTTPException(409, 'پیشرفت ناتمام نسخهٔ قبلی وجود دارد. برای جلوگیری از ارسال تکراری، ادامه را با نسخهٔ قبلی انجام دهید یا صریحاً شروع دوباره را تأیید کنید.')
            run = create_run(state, ids, values.provider, values.source_language, values.skill, values.summary,
                             min(s['source_limit'] for s in settings['free_services'].values()) if values.provider == 'free' else effective_ai_limit(values.provider, settings),
                             0 if values.provider == 'free' else settings['context_percent'], 0 if values.provider == 'free' else settings['skill_percent'],
                             values.reuse_repeated, policy)
            run['legacyRestart'] = values.restart_legacy
            run['legacyHash'] = digest([{'imageId': item['id'], 'page': item.get(AI_PAGE_PROGRESS_KEY),
                                         'parts': [block.get(AI_PARTS_KEY) for block in item.get('blocks', [])]}
                                        for item in selected])
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
        policy = provider_policy(translations.public_settings(), provider)
        if digest(policy) != run['policyHash']:
            raise ProjectChangedError('تنظیمات API تغییر کرده است؛ پیش‌نمایش تازه بگیرید.')
        if provider == 'free':
            config = policy['services']
            limits = '؛ '.join(f"{name}: انتظار {p['timeout_seconds']}، تکرار {p['retry_count']}، فاصله {p['retry_wait_seconds']} ثانیه، سقف {p['source_limit']} نویسه" for name, p in config.items())
            return {'provider':'free', 'rollingMode':True, 'contextMode':False, 'skill':'', 'summary':'', 'defaultSkill':'',
                    'blockCount':len(run['jobs']), 'requestCount':1 if chosen else 0, 'systemPrompt':'',
                    'requests':[{'index':1, 'text':text, 'characters':request.character_count(text), 'imageName':first.get('imageName','')}] if chosen else [],
                    'providerLabel':'Google Translate؛ در صورت خطا MyMemory', 'base_url':'https://translate.googleapis.com/translate_a/single',
                    'fallback_url':'https://api.mymemory.translated.net/get', 'model':'',
                    'note':f"متن صفحه‌ها جداگانه و ترتیبی ارسال و ذخیره می‌شود؛ تأیید یک‌بار برای کل نوبت است. سقف مؤثر {run['limit']} نویسه و برای MyMemory حداکثر ۵۰۰ بایت UTF-8 است. {sum(len(job['refs']) - 1 for job in run['jobs'])} کادر تکراری. خلاصه و اسکیل AI در حالت رایگان استفاده نمی‌شوند. تنظیمات: {limits}.",
                    'signature':digest(run), 'totalLimit':run['limit'], 'resume':bool(run.get('id'))}
        active = [profile for profile in policy['profiles'] if profile['hasApiKey']]
        mode_label = 'حالت JSON سرویس' if context_uses_json(provider, policy['base_url'], policy.get('response_mode', 'auto')) else 'متن معمولی'
        policies = '؛ '.join(f"API {index}: زمان انتظار {p['timeout_seconds']}، تکرار {p['retry_count']}، فاصله {p['retry_wait_seconds']} ثانیه، سقف {p['source_limit']}" for index, p in enumerate(active, 1))
        return {'provider': provider, 'skill': '', 'defaultSkill': '', 'blockCount': len(run['jobs']),
                'requestCount': 1 if chosen else 0, 'systemPrompt': request.system,
                'requests': [{'index': 1, 'text': request.user_message(text), 'characters': request.character_count(text),
                              'imageName': first.get('imageName', '')}] if chosen else [],
                'providerLabel': provider, 'model': policy['model'], 'base_url': policy['base_url'],
                'note': f"درخواست اول دقیقاً نمایش داده شده؛ درخواست‌های بعدی با خلاصهٔ ساخته‌شده محاسبه می‌شوند و با همین تأیید به ترتیب ارسال خواهند شد. سقف کل {run['limit']}؛ سقف خلاصه {request.context_limit} و اسکیل {request.skill_limit} نویسه است. در هر درخواست مقدار استفاده‌نشده به متن مبدأ می‌رسد. {sum(len(job['refs']) - 1 for job in run['jobs'])} کادر تکراری با نتیجهٔ یکسان اعمال می‌شود. قالب پاسخ: {mode_label}. تکرار یا تلاش کلید دیگر ممکن است هزینه داشته باشد. تنظیمات: {policies or 'کلید فعالی ثبت نشده است'}.",
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
        if not values.resume:
            run['id'] = uuid.uuid4().hex
            if values.restart_legacy:
                for item in state['images']:
                    if item['id'] in run['imageIds']:
                        item.pop(AI_PAGE_PROGRESS_KEY, None)
                        for block in item.get('blocks', []): block.pop(AI_PARTS_KEY, None)
        state[RUN_KEY] = run
        if run['provider'] != 'free' and run['context']: state[SUMMARY_KEY] = run['context']
        store.save_if_unchanged(state, expected)
        return {'project': state, 'runId': run['id'], 'completed': run['completed']}

    @app.post("/api/projects/{project_id}/context-step")
    async def context_step(project_id: str, values: ContextStepRequest) -> dict[str, Any]:
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
            if run['provider'] != 'free' and (settings['context_percent'] != run['contextPercent'] or settings['skill_percent'] != run['skillPercent']):
                raise ProjectChangedError('درصدهای خلاصه یا اسکیل تغییر کرده‌اند؛ نوبت متوقف شد.')
            policy = provider_policy(settings, run['provider'])
            verify_run(state, run, values.skill, policy)
            request, chosen = next_request(run, values.skill)
            if not chosen:
                return {'project': state, 'done': True, 'affectedImageIds': []}
            source_texts = [entry['text'] for entry in chosen]
            text = combine_translation_texts(source_texts)
            label = f"درخواست {run['completed'] + 1} برای «{run['jobs'][chosen[0]['job']]['imageName']}»؛ {request.character_count(text)} از {run['limit']} نویسه"
            label += f"؛ {len(text.encode('utf-8'))} از ۵۰۰ بایت" if run['provider'] == 'free' else f"؛ خلاصه {len(run['context'])} از {request.context_limit} نویسه"
            if values.recovery_token is not None:
                activity.add(f"بررسی محلی پاسخ اصلاح‌شده برای درخواست {run['completed'] + 1}، بدون ارسال مجدد به AI.")
            else:
                activity.add(label + '.')
                activity.add(f"متن دقیق درخواست {run['completed'] + 1} (بدون هدر احراز هویت):\nدستور سیستم:\n{request.system}\nپیام کاربر:\n{request.user_message(text)}")
            if (values.recovery_token is None) != (values.corrected_response is None):
                raise HTTPException(400, 'نشانه و متن پاسخ اصلاح‌شده باید همراه هم ارسال شوند.')
            if values.recovery_token is not None:
                entry = recovery_get(values.recovery_token, 'project')
                if run['provider'] == 'free' or (entry['project_id'], entry['run_id'], entry['completed'], entry['updated_at']) != (project_id, values.run_id, values.completed, expected):
                    raise ProjectChangedError('پروژه یا نوبت پس از دریافت پاسخ تغییر کرده است؛ اصلاح اعمال نشد.')
                from .context_budget import parse_context_response
                try:
                    translated, summary = parse_context_response(values.corrected_response, source_texts, request.context_limit)
                except TranslationError as exc:
                    error = InvalidContextResponse(str(exc), values.corrected_response)
                    error.recovery_token = values.recovery_token
                    raise error from exc
            elif run['provider'] == 'free':
                translated = await run_reported(translations.translate_free_batch, request, text, source_texts, run['language'], policy, pulse_label='ترجمهٔ رایگان')
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
                merged = pending_results.resolve(store, project_id, entry['id'], view['revision'], {})
                state = merged['project']; run = state[RUN_KEY]; affected = merged['affectedImageIds']; done = merged['done']
            if values.recovery_token: recoveries.pop(values.recovery_token, None)
            activity.add(f"درخواست {run['completed']} ذخیره شد." if run['provider'] == 'free' else f"درخواست {run['completed']} و خلاصهٔ {len(summary)} نویسه‌ای ذخیره شد.", 'success')
            return {'project': state, 'done': done, 'affectedImageIds': affected, 'completed': run['completed'],
                    'sent': {'system': request.system, 'user': request.user_message(text), 'characters': request.character_count(text)}}

    def prepare_context_text(values: ContextTextRequest) -> tuple[dict[str, Any], dict[str, Any], Any, list[dict[str, Any]]]:
        if values.provider not in {'free', 'openai', 'gemini', 'openrouter', 'avalai'}:
            raise HTTPException(400, 'سرویس ترجمه معتبر نیست.')
        state = {'images': [{'id': 'single', 'name': 'بازترجمهٔ یک کادر', 'order': 0,
                            'blocks': [{'id': 1, 'text': values.text, 'enabled': True, 'sourceLines': values.source_lines}]}]}
        settings = translations.public_settings()
        run = create_run(state, ['single'], values.provider, values.source_language, values.skill, values.summary,
                         min(s['source_limit'] for s in settings['free_services'].values()) if values.provider == 'free' else effective_ai_limit(values.provider, settings),
                         0 if values.provider == 'free' else settings['context_percent'], 0 if values.provider == 'free' else settings['skill_percent'],
                         False, provider_policy(settings, values.provider))
        request, chosen = next_request(run, values.skill)
        return state, run, request, chosen

    @app.post('/api/translate-text/context-preview')
    def context_text_preview(values: ContextTextRequest) -> dict[str, Any]:
        state, run, request, chosen = prepare_context_text(values)
        result = context_view(run, request, chosen, values.provider)
        result['skill'] = values.skill; result['singleContext'] = True
        from .translation import DEFAULT_AI_SKILL
        result['defaultSkill'] = DEFAULT_AI_SKILL
        if values.provider != 'free': result['note'] += ' خلاصهٔ بازترجمهٔ تکی در حافظهٔ اصلی داستان ذخیره نمی‌شود.'
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
                policy = provider_policy(settings, values.provider)
                verify_run(state, run, values.skill, policy)
                if values.provider != 'free' and (settings['context_percent'] != run['contextPercent'] or settings['skill_percent'] != run['skillPercent']):
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
                        translated = await run_reported(translations.translate_free_batch, request, text, sources, values.source_language, policy, pulse_label='بازترجمهٔ رایگان')
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

    def legacy_free_context(values: TranslateRequest) -> ContextPreviewRequest:
        return ContextPreviewRequest(image_ids=values.image_ids, provider='free', source_language=values.source_language,
                                     reuse_repeated=values.reuse_repeated if values.reuse_repeated is not None else translations.public_settings()['reuse_repeated'])

    @app.post("/api/projects/{project_id}/translation-preview")
    def translation_preview(project_id: str, values: TranslateRequest) -> dict[str, Any]:
        if values.provider == 'free':
            return context_preview(project_id, legacy_free_context(values))
        state = project(project_id)
        ids = image_ids(state, values.image_ids)
        settings = translation_settings(values.provider, values.skill)
        reuse = values.reuse_repeated if values.reuse_repeated is not None else settings.get("reuse_repeated", True)
        plan = build_project_plan(state, ids, values.provider, reuse, values.source_language, settings)
        return plan_preview(plan, values.provider, values.source_language, settings)

    @app.post("/api/projects/{project_id}/translate")
    async def run_translation(project_id: str, values: TranslateRequest) -> dict[str, Any]:
        if values.provider == 'free':
            options = legacy_free_context(values)
            run, request, chosen = context_preparation(project(project_id), options)
            if not chosen:
                return project(project_id)
            signature = digest(run)
            if values.confirmation and values.confirmation != signature:
                raise HTTPException(409, 'متن یا تنظیمات پس از پیش‌نمایش تغییر کرده است.')
            started = context_start(project_id, ContextStartRequest(**options.model_dump(), confirmation=signature))
            completed = started['completed']
            while True:
                result = await context_step(project_id, ContextStepRequest(run_id=started['runId'], completed=completed, skill=''))
                completed = result['completed']
                if result['done']:
                    return result['project']
        state = project(project_id)
        expected_updated_at = state.get("updatedAt", "")
        ids = image_ids(state, values.image_ids)
        settings = translation_settings(values.provider, values.skill)
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
            expected = plan_signature(signed_plan, values.provider, values.source_language, translation_settings(values.provider, values.skill))
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
                    translations.translate, combined_source, values.source_language, values.provider,
                    pulse_label="ترجمهٔ جمعی free همهٔ متن‌های OCR انتخاب‌شده",
                )
                activity.add("پاسخ مشترک free رسید؛ در حال تقسیم دقیق بین کادرهای OCR", progress=0.5)
                translated_blocks = distribute_translation(source_texts, translated)
            elif values.provider == "free":
                for index, call in enumerate(plan["calls"], start=1):
                    activity.add(f"ترجمهٔ رایگان متن {index} از {len(blocks)}", progress=(index - 1) / len(blocks))
                    translated = await run_reported(
                        translations.translate, call["text"], values.source_language, values.provider,
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
                    if values.confirmation and values.confirmation != plan_signature(signed_plan, values.provider, values.source_language, translation_settings(values.provider, values.skill)):
                        raise HTTPException(409, "تنظیمات ترجمه تغییر کرده است؛ صفحهٔ بعد ارسال نشد. صفحه‌های ذخیره‌شده حفظ شده‌اند.")
                    settings = translation_settings(values.provider, values.skill)
                    if saved_call(call, plan, values.provider, values.source_language, settings):
                        continue
                    page_sources = [source_texts[i] for i in call["indices"]] if call.get("combined") else [call["text"]]
                    label = call.get("image_name") or call["image_id"]
                    page_index = values.batch_index if len(calls_to_run) == 1 and values.batch_index and values.batch_total and values.batch_index <= values.batch_total else index
                    page_total = values.batch_total if len(calls_to_run) == 1 and values.batch_index and values.batch_total and values.batch_index <= values.batch_total else len(calls_to_run)
                    activity.add(f"در حال ترجمهٔ درخواست {page_index} از {page_total}: {label}" + (f" · بند {call['paragraph']}، بخش {call.get('part_index', 0) + 1} از {call.get('part_count', 1)}" if call.get("paragraph") else ""), progress=(page_index - 1) / page_total)
                    translated = await run_reported(
                        translations.translate, call["text"], values.source_language, values.provider, page_sources, settings["_translation_skill"],
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
                            block["tr"] = output; block["richHtml"] = ""; block.pop(AI_PARTS_KEY, None); block.pop(AI_REUSE_KEY, None)
                            page_result = [output]
                            completed_block = True
                    if completed_block:
                        for block_index, target_indices, text in zip(call["indices"], call.get("targets", [[i] for i in call["indices"]]), page_result):
                            for target_index in target_indices:
                                block = blocks[target_index]
                                block["tr"] = text; block["richHtml"] = ""
                                block.pop(AI_PARTS_KEY, None); block.pop(AI_REUSE_KEY, None)
                                if target_index != block_index:
                                    mark_reused_translation(block, source_texts[target_index], values.provider, values.source_language, settings)
                    mark_completed_call(call, plan, values.provider, values.source_language, settings, completed_block)
                    store.save_if_unchanged(state, expected_updated_at)
                    expected_updated_at = state.get("updatedAt", "")
                    completed_ai += 1
                    activity.add(f"درخواست {page_index} از {page_total} ترجمه و ذخیره شد: {label}", "success", page_index / page_total)
            if values.provider == "free":
                for block, text in zip(blocks, translated_blocks):
                    block["tr"] = text
                    block["richHtml"] = ""
                store.save_if_unchanged(state, expected_updated_at)
        except Exception as exc:
            if completed_ai:
                message = f"{completed_ai} درخواست ذخیره شد؛ درخواست ناموفق ذخیره نشد و درخواست‌های پس از آن ارسال نشدند. "
                if isinstance(exc, HTTPException):
                    exc.detail = message + str(exc.detail)
                else:
                    exc.args = (message + str(exc),)
            activity.add(f"ترجمه ناموفق بود: {exc}", "error")
            raise
        if combined_free:
            activity.add(f"همهٔ {len(blocks)} متن OCR با هم و در یک درخواست free ترجمه و در کادرهای خودشان قرار گرفتند", "success", 1.0)
        elif values.provider == "free":
            activity.add(f"هر {len(blocks)} متن جدا ترجمه و در کادرهای خودشان قرار گرفتند", "success", 1.0)
        elif not values.batch_total or values.batch_index == values.batch_total:
            activity.add(f"ترجمهٔ صفحه‌های درخواست‌شده پایان یافت؛ هر صفحه جداگانه ذخیره شد", "success", 1.0)
        return state

    @app.post("/api/translate-text/preview")
    def translate_text_preview(values: TextTranslateRequest) -> dict[str, Any]:
        if values.provider == 'free':
            return context_text_preview(ContextTextRequest(text=values.text, source_lines=values.source_lines, source_language=values.source_language, provider='free'))
        plan = build_single_plan(values.text, values.provider, translation_settings(values.provider, values.skill), values.source_lines)
        return plan_preview(plan, values.provider, values.source_language, translation_settings(values.provider, values.skill))

    @app.post("/api/translate-text")
    async def translate_text(values: TextTranslateRequest) -> dict[str, str]:
        if values.provider == 'free':
            request = ContextTextRequest(text=values.text, source_lines=values.source_lines, source_language=values.source_language, provider='free')
            preview = context_text_preview(request)
            if values.confirmation and values.confirmation != preview['signature']:
                raise HTTPException(409, 'متن یا تنظیمات پس از پیش‌نمایش تغییر کرده است.')
            result = await context_text_translate(request.model_copy(update={'confirmation': preview['signature']}))
            return {'text': result['text']}
        if values.confirmation:
            plan = build_single_plan(values.text, values.provider, translation_settings(values.provider, values.skill), values.source_lines)
            expected = plan_signature(plan, values.provider, values.source_language, translation_settings(values.provider, values.skill))
            if values.confirmation != expected:
                raise HTTPException(409, "متن یا تنظیمات بعد از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی و دوباره تأیید کنید.")
        activity.add("ترجمهٔ دوبارهٔ یک خط آغاز شد")
        plan = build_single_plan(values.text, values.provider, translation_settings(values.provider, values.skill), values.source_lines)
        try:
            responses = []
            for call in plan["calls"]:
                if values.provider == "free":
                    translated_part = await run_reported(translations.translate, call["text"], values.source_language, values.provider)
                else:
                    translated_part = await run_reported(translations.translate, call["text"], values.source_language, values.provider, None, normalize_ai_skill(values.skill))
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

    @app.post("/api/projects/{project_id}/export")
    async def export(project_id: str, values: ExportRequest) -> FileResponse:
        state = project(project_id)
        if not values.image_ids:
            raise HTTPException(400, "No images selected")
        request = values.model_dump()
        activity.add(f"ساخت خروجی {values.kind.upper()} آغاز شد")
        try:
            if values.kind == "pdf":
                path = await run_reported(build_pdf, store, state, request, pulse_label="ساخت PDF")
            elif values.kind == "images":
                path = await run_reported(build_images_zip, store, state, request, pulse_label="ساخت ZIP")
            else:
                path = await run_reported(build_txt, store, state, request, pulse_label="ساخت TXT")
        except ValueError as exc:
            activity.add(f"ساخت خروجی ناموفق بود: {exc}", "error")
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            activity.add(f"ساخت خروجی ناموفق بود: {exc}", "error")
            raise
        activity.add(f"خروجی {values.kind.upper()} آماده شد", "success", 1.0)
        media_type = {"pdf": "application/pdf", "images": "application/zip", "txt": "text/plain; charset=utf-8"}[values.kind]
        return FileResponse(path, media_type=media_type, filename=path.name)

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
