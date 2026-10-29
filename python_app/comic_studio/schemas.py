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
    min_confidence: float = Field(default=0.35, ge=0.0, le=1.0)


class TranslateRequest(BaseModel):
    image_ids: list[str] = Field(default_factory=list)
    provider: str = "free"
    source_language: str = "eng"


class TextTranslateRequest(BaseModel):
    text: str
    source_language: str = "eng"
    provider: str = "free"


class AiSettings(BaseModel):
    provider: str = "free"
    base_url: str = "https://api.avalai.ir/v1"
    model: str = "gpt-6-luna"
    api_key: str | None = None


class EngineTestRequest(BaseModel):
    project_id: str
    image_id: str
    language: str = "eng"


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
