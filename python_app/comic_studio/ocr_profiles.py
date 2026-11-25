"""Named OCR presets in the local user's data root, independent of projects."""
from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .document_enhancement import EnhancementSettings
from .paths import data_dir


class OcrProfileSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    engine: str = Field(default='rapidocr-v6', min_length=1, max_length=80)
    language: Literal['eng', 'fas', 'kor', 'jpn', 'chi_sim'] = 'eng'
    page_mode: Literal['comic', 'document'] = 'comic'
    min_confidence: float = Field(default=0.35, ge=0, le=0.95)
    contrast: bool = True
    contrast_strength: float = Field(default=1, ge=0.5, le=3)
    photo_sharpen: bool = False
    precise: bool = True
    persian_preprocess: bool = False
    group_lines: bool = True
    erase_original: bool = True
    only_selected: bool = True
    enhancement: EnhancementSettings = Field(default_factory=EnhancementSettings)


class OcrProfile(BaseModel):
    model_config = ConfigDict(extra='forbid')
    format: Literal['hasaya-ocr-profile'] = 'hasaya-ocr-profile'
    version: Literal[1] = 1
    name: str = Field(min_length=1, max_length=80)
    settings: OcrProfileSettings

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError('نام پروفایل معتبر نیست.')
        return value


_LOCK = threading.RLock()


def _path():
    return data_dir() / 'ocr-profiles.json'


def _read():
    path = _path()
    if not path.exists():
        return {}
    try:
        records = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(records, dict) or len(records) > 100:
            raise ValueError()
        return {key: OcrProfile.model_validate(value).model_dump() for key, value in records.items()}
    except (ValueError, TypeError) as exc:
        raise ValueError('فایل پروفایل‌های OCR معتبر نیست؛ فایل موجود بازنویسی نشد.') from exc


def list_profiles():
    with _LOCK:
        return [{'id': key, **value} for key, value in _read().items()]


def _write(records):
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ocr-profiles-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(records, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_profile(profile: OcrProfile, profile_id: str | None = None):
    with _LOCK:
        records = _read()
        if profile_id is not None and profile_id not in records:
            raise KeyError(profile_id)
        if profile_id is None and len(records) >= 100:
            raise ValueError('حداکثر ۱۰۰ پروفایل قابل ذخیره است.')
        if any(key != profile_id and item['name'].casefold() == profile.name.casefold() for key, item in records.items()):
            raise ValueError('این نام قبلاً ذخیره شده؛ نام دیگری انتخاب یا پروفایل موجود را به‌روزرسانی کنید.')
        profile_id = profile_id or uuid.uuid4().hex
        records[profile_id] = profile.model_dump()
        _write(records)
        return {'id': profile_id, **records[profile_id]}


def delete_profile(profile_id: str):
    with _LOCK:
        records = _read()
        if profile_id not in records:
            raise KeyError(profile_id)
        del records[profile_id]
        _write(records)
