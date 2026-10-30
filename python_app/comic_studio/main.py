from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import APP_NAME, APP_VERSION
from .activity import ActivityLog, reporting
from .exporter import build_images_zip, build_pdf, build_txt, image_payload
from .ocr import ENGINE_INFO, LANGUAGES, EngineRegistry, OcrError, recognize_image
from .paths import STATIC_DIR, project_root
from .schemas import (
    AiConnectionTest, AiSettings, EngineDownloadRequest, EngineTestRequest, ExportRequest, OcrRequest, ProjectCreate,
    SessionRequest, StateUpdate, TextTranslateRequest, TranslateRequest,
)
from .sessions import SessionManager
from .store import ProjectStore
from .translation import (
    TranslationError, TranslationService, combine_translation_texts,
    distribute_translation,
)
from .translation_plan import (
    build_project_plan, build_single_plan, plan_preview, plan_signature,
)


def create_app() -> FastAPI:
    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    store = ProjectStore()
    registry = EngineRegistry()
    translations = TranslationService()
    activity = ActivityLog()
    sessions = SessionManager()
    app.state.activity = activity
    app.state.sessions = sessions
    activity.add("برنامه آماده است")

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

    @app.exception_handler(TranslationError)
    async def translation_error(_: Request, exc: TranslationError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=502)

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
        state = project(project_id)
        engine = registry.get(values.engine)
        if not ENGINE_INFO[values.engine].get("selectable", False):
            raise HTTPException(400, "This model requires its official external runtime and is not a direct comic OCR engine")
        if values.language not in LANGUAGES or values.language not in ENGINE_INFO[values.engine]["languages"]:
            raise HTTPException(400, "This engine does not support the selected language")
        ids = image_ids(state, values.image_ids)
        if not ids:
            raise HTTPException(400, "No images selected")
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
                item["blocks"] = blocks
                item["edited"] = False
                (project_root(project_id) / "images" / f"{item['id']}-edited.png").unlink(missing_ok=True)
                activity.add(f"در «{item['name']}» {len(blocks)} تکه متن پیدا شد", progress=completed / len(ids))
                recognized_lines = [block.get("text", "").strip() for block in blocks if block.get("text", "").strip()]
                if recognized_lines:
                    activity.add(f"متن خوانده‌شده در «{item['name']}»:\n" + "\n".join(recognized_lines))
                else:
                    activity.add(f"در «{item['name']}» متنی پیدا نشد", "warning")
            store.save(state)
        except Exception as exc:
            activity.add(f"خواندن متن ناموفق بود: {exc}", "error")
            raise
        activity.add("OCR تمام شد؛ متن هر تصویر در گزارش بالا آمده است", "success", 1.0)
        return state

    @app.post("/api/projects/{project_id}/translation-preview")
    def translation_preview(project_id: str, values: TranslateRequest) -> dict[str, Any]:
        state = project(project_id)
        ids = image_ids(state, values.image_ids)
        plan = build_project_plan(state, ids, values.provider)
        return plan_preview(plan, values.provider, values.source_language, translations.public_settings())

    @app.post("/api/projects/{project_id}/translate")
    async def run_translation(project_id: str, values: TranslateRequest) -> dict[str, Any]:
        state = project(project_id)
        ids = image_ids(state, values.image_ids)
        plan = build_project_plan(state, ids, values.provider)
        items, blocks = plan["items"], plan["blocks"]
        if not blocks:
            activity.add("در تصاویر انتخاب‌شده متن فعالی برای ترجمه نیست", "warning")
            return state
        if values.confirmation:
            expected = plan_signature(plan, values.provider, values.source_language, translations.public_settings())
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
            activity.add(f"ترجمهٔ AI برای {len(items)} تصویر و {len(blocks)} متن آغاز شد؛ همه در یک درخواست خط‌به‌خط می‌روند")
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
                translated = await run_reported(
                    translations.translate, combined_source, values.source_language, values.provider,
                    pulse_label="ترجمهٔ مشترک همهٔ متن‌های انتخاب‌شده",
                )
                activity.add("پاسخ مشترک AI رسید؛ در حال تقسیم خطوط بر اساس تعداد خطوط هر کادر", progress=0.5)
                translated_blocks = distribute_translation(source_texts, translated)
            for block, text in zip(blocks, translated_blocks):
                block["tr"] = text
                block["richHtml"] = ""
            store.save(state)
        except Exception as exc:
            activity.add(f"ترجمه ناموفق بود: {exc}", "error")
            raise
        if combined_free:
            activity.add(f"همهٔ {len(blocks)} متن OCR با هم و در یک درخواست free ترجمه و در کادرهای خودشان قرار گرفتند", "success", 1.0)
        elif values.provider == "free":
            activity.add(f"هر {len(blocks)} متن جدا ترجمه و در کادرهای خودشان قرار گرفتند", "success", 1.0)
        else:
            activity.add(f"همهٔ {len(blocks)} متن با هم و در یک درخواست AI ترجمه و در کادرها قرار گرفتند", "success", 1.0)
        return state

    @app.post("/api/translate-text/preview")
    def translate_text_preview(values: TextTranslateRequest) -> dict[str, Any]:
        plan = build_single_plan(values.text, values.provider)
        return plan_preview(plan, values.provider, values.source_language, translations.public_settings())

    @app.post("/api/translate-text")
    async def translate_text(values: TextTranslateRequest) -> dict[str, str]:
        if values.confirmation:
            plan = build_single_plan(values.text, values.provider)
            expected = plan_signature(plan, values.provider, values.source_language, translations.public_settings())
            if values.confirmation != expected:
                raise HTTPException(409, "متن یا تنظیمات بعد از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش تازه را بررسی و دوباره تأیید کنید.")
        activity.add("ترجمهٔ دوبارهٔ یک خط آغاز شد")
        try:
            translated = await run_reported(
                translations.translate, values.text, values.source_language, values.provider,
            )
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
