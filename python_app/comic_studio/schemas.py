from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class BackupRequest(BaseModel):
    expected_updated_at: str | None = None
    drafts: list[dict[str, Any]] = Field(default_factory=list)


class ProjectCreate(BaseModel):
    name: str = "پروژهٔ کمیک"


class OcrRequest(BaseModel):
    image_ids: list[str] = Field(default_factory=list)
    engine: str = "rapidocr-v6"
    language: str = "eng"
    contrast: bool = True
    precise: bool = True
    group_lines: bool = False
    page_mode: Literal["auto", "comic", "document"] = "auto"
    min_confidence: float = Field(default=0.35, ge=0.0, le=1.0)
    keep_engine_loaded: bool = False
    batch_index: int | None = Field(default=None, ge=1)
    batch_total: int | None = Field(default=None, ge=1)


class TranslateRequest(BaseModel):
    skill: str | None = Field(default=None, max_length=4000)
    call_id: str | None = None
    call_image_id: str | None = None
    reuse_repeated: bool | None = None
    batch_index: int | None = Field(default=None, ge=1)
    batch_total: int | None = Field(default=None, ge=1)
    image_ids: list[str] = Field(default_factory=list)
    provider: str = "free"
    source_language: str = "eng"
    target_language: str = "fa"
    confirmation: str | None = None


class TextTranslateRequest(BaseModel):
    skill: str | None = Field(default=None, max_length=4000)
    text: str
    source_lines: list[dict[str, Any]] | None = None
    source_language: str = "eng"
    target_language: str = "fa"
    provider: str = "free"
    confirmation: str | None = None


class LocalNmtSettingsPayload(BaseModel):
    model: str = Field(default="nllb-600m", max_length=60)
    beam_size: int = Field(default=2, ge=1, le=4)
    source_limit: int = Field(default=4000, ge=200, le=20_000)
    keep_loaded: bool = False


class LocalNmtModelActionRequest(BaseModel):
    model: str = Field(default="nllb-600m", min_length=1, max_length=60)


class LocalNmtTestRequest(BaseModel):
    model: str = Field(default="nllb-600m", max_length=60)
    source_language: str = Field(default="eng", max_length=20)
    target_language: str = Field(default="fa", max_length=16)
    sample_text: str = Field(default="", max_length=2000)
    beam_size: int = Field(default=2, ge=1, le=4)
    keep_loaded: bool = False


class AiSettings(BaseModel):
    free_services: dict[str, dict[str, Any]] | None = None
    local_nmt: LocalNmtSettingsPayload | None = None
    context_percent: int | None = Field(default=None, ge=0, le=100)
    skill_percent: int | None = Field(default=None, ge=0, le=100)
    reuse_repeated: bool | None = None
    target_language: str | None = None
    provider: str = "free"
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None
    providers: dict[str, dict[str, Any]] = Field(default_factory=dict)


class AiConnectionTest(BaseModel):
    provider: str | None = None
    profile_id: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


class EngineTestRequest(BaseModel):
    project_id: str
    image_id: str
    language: str = "eng"
    page_mode: Literal["auto", "comic", "document"] = "auto"


class EngineDownloadRequest(BaseModel):
    language: str = "eng"
    force: bool = False


class EngineUpdateRequest(BaseModel):
    language: str = "eng"


class EngineUpdateCheckRequest(BaseModel):
    force: bool = False


class SessionRequest(BaseModel):
    client_id: str = Field(min_length=8, max_length=120)


class ExportRequest(BaseModel):
    kind: Literal["pdf", "images", "txt", "docx", "pptx"]
    image_ids: list[str] = Field(default_factory=list)
    name: str = ""
    seamless: bool = False
    uniform_size: bool = False
    two_per_page: bool = False
    image_format: Literal["orig", "png", "jpg"] = "orig"
    folder_name: str = ""
    docx_mode: Literal["translation", "ocr"] = "translation"
    docx_layout: Literal["visual", "flowing"] = "visual"
    pptx_mode: Literal["translation", "ocr"] | None = None
    pptx_layout: Literal["visual", "flowing"] | None = None


class StateUpdate(BaseModel):
    state: dict[str, Any]


class ContextPreviewRequest(BaseModel):
    resume: bool = False
    restart_legacy: bool = False
    restart_existing: bool = False
    image_ids: list[str] = Field(default_factory=list)
    provider: str
    profile_id: str | None = Field(default=None, max_length=120)
    source_language: str = "eng"
    target_language: str = "fa"
    skill: str = Field(default="", max_length=100000)
    summary: str = Field(default="", max_length=100000)
    reuse_repeated: bool = True


class ContextStartRequest(ContextPreviewRequest):
    confirmation: str


class ContextStepRequest(BaseModel):
    recovery_token: str | None = Field(default=None, max_length=100)
    corrected_response: str | None = Field(default=None, max_length=200000)
    run_id: str
    completed: int = Field(ge=0)
    skill: str = Field(default="", max_length=100000)


class ContextTextRequest(BaseModel):
    recovery_token: str | None = Field(default=None, max_length=100)
    corrected_response: str | None = Field(default=None, max_length=200000)
    text: str
    source_lines: list[dict[str, Any]] | None = None
    source_language: str = 'eng'
    target_language: str = 'fa'
    provider: str
    profile_id: str | None = Field(default=None, max_length=120)
    skill: str = Field(default='', max_length=100000)
    summary: str = Field(default='', max_length=100000)
    confirmation: str | None = None


class StorageSettingsUpdate(BaseModel):
    custom_path: str = Field(default="", max_length=2048)
    migrate_existing: bool = True
    cleanup_source: bool = True


class StorageFolderPickRequest(BaseModel):
    initial_dir: str | None = Field(default=None, max_length=2048)
