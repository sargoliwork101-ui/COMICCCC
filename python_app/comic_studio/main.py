from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import APP_NAME, APP_VERSION
from .exporter import build_images_zip, build_pdf, build_txt
from .ocr import ENGINE_INFO, LANGUAGES, EngineRegistry, OcrError, recognize_image
from .paths import STATIC_DIR, project_root
from .schemas import (
    AiSettings, EngineDownloadRequest, EngineTestRequest, ExportRequest, OcrRequest, ProjectCreate,
    StateUpdate, TextTranslateRequest, TranslateRequest,
)
from .store import ProjectStore
from .translation import TranslationError, TranslationService


def create_app() -> FastAPI:
    app = FastAPI(title=APP_NAME, version=APP_VERSION)
    store = ProjectStore()
    registry = EngineRegistry()
    translations = TranslationService()

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

    @app.get("/api/projects")
    def projects() -> list[dict[str, Any]]:
        return store.list()

    @app.post("/api/projects", status_code=201)
    def create_project(values: ProjectCreate | None = None) -> dict[str, Any]:
        return store.create(values.name if values else "پروژهٔ کمیک")

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict[str, Any]:
        return project(project_id)

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
        try:
            return await run_in_threadpool(store.import_files, project_id, payloads)
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/projects/{project_id}/images/{image_id}/content")
    def image_content(project_id: str, image_id: str, edited: bool = False) -> FileResponse:
        try:
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
        language = values.language if values else "eng"
        if language not in ENGINE_INFO[engine_id]["languages"]:
            raise HTTPException(400, "This engine does not support the selected language")
        await run_in_threadpool(registry.download, engine_id, language)
        return {"ok": True, "language": language, "engines": registry.status()}

    @app.post("/api/engines/{engine_id}/test")
    async def test_engine(engine_id: str, values: EngineTestRequest) -> dict[str, Any]:
        engine = registry.get(engine_id)
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
        blocks = await run_in_threadpool(recognize_image, engine, image, values.language, True, True, 0.2)
        return {"engine": engine_id, "imageId": values.image_id, "blocks": blocks}

    @app.post("/api/projects/{project_id}/ocr")
    async def run_ocr(project_id: str, values: OcrRequest) -> dict[str, Any]:
        state = project(project_id)
        engine = registry.get(values.engine)
        if values.language not in LANGUAGES or values.language not in ENGINE_INFO[values.engine]["languages"]:
            raise HTTPException(400, "This engine does not support the selected language")
        ids = image_ids(state, values.image_ids)
        if not ids:
            raise HTTPException(400, "No images selected")
        for item in state["images"]:
            if item["id"] not in ids:
                continue
            path = store.image_path(project_id, item["id"])
            from PIL import Image
            with Image.open(path) as im:
                image = im.copy()
            blocks = await run_in_threadpool(
                recognize_image, engine, image, values.language,
                values.contrast, values.precise, values.min_confidence,
            )
            for block in blocks:
                block["bg"] = "auto" if state.get("settings", {}).get("eraseOriginal", True) else "none"
            item["blocks"] = blocks
            item["edited"] = False
            (project_root(project_id) / "images" / f"{item['id']}-edited.png").unlink(missing_ok=True)
        store.save(state)
        return state

    @app.post("/api/projects/{project_id}/translate")
    async def run_translation(project_id: str, values: TranslateRequest) -> dict[str, Any]:
        state = project(project_id)
        ids = image_ids(state, values.image_ids)
        for item in state["images"]:
            if item["id"] not in ids:
                continue
            for block in item.get("blocks", []):
                if not block.get("enabled", True) or not block.get("text", "").strip():
                    continue
                translated = await run_in_threadpool(
                    translations.translate, block["text"], values.source_language, values.provider,
                )
                block["tr"] = translated
                block["richHtml"] = ""
        store.save(state)
        return state

    @app.post("/api/translate-text")
    async def translate_text(values: TextTranslateRequest) -> dict[str, str]:
        translated = await run_in_threadpool(
            translations.translate, values.text, values.source_language, values.provider,
        )
        return {"text": translated}

    @app.get("/api/ai-settings")
    def ai_settings() -> dict[str, Any]:
        return translations.public_settings()

    @app.put("/api/ai-settings")
    def save_ai_settings(values: AiSettings) -> dict[str, Any]:
        try:
            return translations.save_settings(values.model_dump())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/ai-settings/test")
    async def test_ai_settings() -> dict[str, Any]:
        return await run_in_threadpool(translations.test_connection)

    @app.post("/api/projects/{project_id}/export")
    async def export(project_id: str, values: ExportRequest) -> FileResponse:
        state = project(project_id)
        if not values.image_ids:
            raise HTTPException(400, "No images selected")
        request = values.model_dump()
        try:
            if values.kind == "pdf":
                path = await run_in_threadpool(build_pdf, store, state, request)
            elif values.kind == "images":
                path = await run_in_threadpool(build_images_zip, store, state, request)
            else:
                path = await run_in_threadpool(build_txt, store, state, request)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        media_type = {"pdf": "application/pdf", "images": "application/zip", "txt": "text/plain; charset=utf-8"}[values.kind]
        return FileResponse(path, media_type=media_type, filename=path.name)

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
