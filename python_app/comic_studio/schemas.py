from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = "پروژهٔ کمیک"


class OcrRequest(BaseModel):
    image_ids: list[str] = Field(default_factory=list)
    engine: str = "rapidocr-v6"
    language: str = "eng"
    contrast: bool = True
    precise: bool = True
    group_lines: bool = False
    min_confidence: float = Field(default=0.35, ge=0.0, le=1.0)


class TranslateRequest(BaseModel):
    batch_index: int | None = Field(default=None, ge=1)
    batch_total: int | None = Field(default=None, ge=1)
    image_ids: list[str] = Field(default_factory=list)
    provider: str = "free"
    source_language: str = "eng"
    confirmation: str | None = None


class TextTranslateRequest(BaseModel):
    text: str
    source_language: str = "eng"
    provider: str = "free"
    confirmation: str | None = None


class AiSettings(BaseModel):
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


class EngineDownloadRequest(BaseModel):
    language: str = "eng"


class SessionRequest(BaseModel):
    client_id: str = Field(min_length=8, max_length=120)


class ExportRequest(BaseModel):
    kind: Literal["pdf", "images", "txt"]
    image_ids: list[str] = Field(default_factory=list)
    name: str = "comic-translated"
    seamless: bool = False
    uniform_size: bool = False
    two_per_page: bool = False
    image_format: Literal["orig", "png", "jpg"] = "orig"
    folder_name: str = ""


class StateUpdate(BaseModel):
    state: dict[str, Any]
