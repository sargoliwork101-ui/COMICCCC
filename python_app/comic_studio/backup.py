"""Portable, bounded project backups. No global settings or API keys are included."""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from PIL import Image, UnidentifiedImageError

from . import APP_VERSION
from .activity import emit
from .paths import data_dir, project_root
from .store import ALLOWED_IMAGES, ProjectChangedError, ProjectStore, atomic_json, new_id, utc_now

FORMAT = 'comic-ocr-studio-project'
VERSION = 1
MAX_FILES = 10000
MAX_TOTAL = 10 * 1024**3
MAX_ZIP = 5 * 1024**3
MAX_JSON = 256 * 1024**2
MAX_DRAFTS = 10 * 1024**2
MAX_IMAGE = 150 * 1024**2
MAX_EDITED = 150 * 1024**2
MAX_EXPORT = 2 * 1024**3
ID_RE = re.compile(r'^[A-Za-z0-9]{1,64}$')
EXPORT_SUFFIXES = {'.pdf', '.zip', '.txt', '.docx', '.pptx'}
STORED_ARCHIVE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.zip', '.pdf', '.docx', '.pptx'}


class BackupError(ValueError):
    pass


def _name(name: Any) -> str:
    if (not isinstance(name, str) or not name or len(name) > 240 or name in {'.', '..'}
            or name.rstrip(' .') != name or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
            or re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', name.split('.')[0])):
        raise BackupError('نام فایل در پروژه یا بک‌آپ معتبر نیست.')
    return name


def _validate_state(state: Any) -> dict[str, Any]:
    if not isinstance(state, dict) or not isinstance(state.get('name'), str) or not isinstance(state.get('images'), list) or not isinstance(state.get('settings'), dict):
        raise BackupError('اطلاعات پروژه در بک‌آپ معتبر نیست.')
    if len(state['images']) > 4000:
        raise BackupError('تعداد تصاویر بک‌آپ بیش از حد مجاز است.')
    seen = set(); names = set()
    for item in state['images']:
        if not isinstance(item, dict):
            raise BackupError('اطلاعات یکی از تصاویر معتبر نیست.')
        image_id = item.get('id'); name = _name(item.get('file'))
        if not isinstance(image_id, str) or not ID_RE.fullmatch(image_id) or image_id in seen:
            raise BackupError('شناسهٔ تصویر در بک‌آپ معتبر یا یکتا نیست.')
        if name != image_id + Path(name).suffix or Path(name).suffix.lower() not in ALLOWED_IMAGES or name in names:
            raise BackupError('نام تصویر در بک‌آپ معتبر یا یکتا نیست.')
        width, height = item.get('width'), item.get('height')
        if not isinstance(width, int) or isinstance(width, bool) or not isinstance(height, int) or isinstance(height, bool) or width < 1 or height < 1 or width * height > 100_000_000:
            raise BackupError('اندازهٔ تصویر در بک‌آپ معتبر نیست.')
        blocks = item.get('blocks', [])
        if not isinstance(blocks, list) or any(not isinstance(block, dict) for block in blocks):
            raise BackupError('متن‌های تصویر در بک‌آپ معتبر نیستند.')
        wm = item.get('watermark')
        if wm is not None and not isinstance(wm, dict):
            raise BackupError('اطلاعات واترمارک تصویر در بک‌آپ معتبر نیست.')
        seen.add(image_id); names.add(name)
    return state


def _drafts(value: Any, state: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 10000:
        raise BackupError('فهرست پیش‌نویس‌های مرورگر معتبر نیست.')
    valid = {(str(item['id']), str(block.get('id'))) for item in state['images'] for block in item.get('blocks', []) if isinstance(block, dict) and 'id' in block}
    seen = set()
    for draft in value:
        if not isinstance(draft, dict) or not isinstance(draft.get('imageId'), str) or not isinstance(draft.get('blockId'), str) or draft.get('mode') not in {'ocr', 'translation'}:
            raise BackupError('پیش‌نویس مرورگر معتبر نیست.')
        key = (draft['imageId'], draft['blockId'], draft['mode'])
        content = draft.get('value')
        if key[:2] not in valid or key in seen or not isinstance(content, dict) or not isinstance(content.get('html'), str):
            raise BackupError('پیش‌نویس به کادر معتبر و یکتای پروژه مربوط نیست.')
        seen.add(key)
    return value


def _json(value: Any, limit: int) -> bytes:
    try:
        result = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, RecursionError) as exc:
        raise BackupError('اطلاعات پروژه قابل ذخیره نیست.') from exc
    if len(result) > limit:
        raise BackupError('اطلاعات پروژه یا پیش‌نویس‌ها بیش از حد بزرگ است.')
    return result


def _check_regular(path: Path, limit: int) -> None:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise BackupError(f'فایل پروژه موجود نیست یا بیش از حد بزرگ است: {path.name}')


def cleanup_backup_temp(max_age_seconds: float = 3600.0, *, protected: set[Path] | None = None) -> None:
    """Remove stale temporary backup archives and interrupted restore staging folders."""
    now = time.time()
    keep = {p.resolve() for p in (protected or set())}
    for folder_name in ('backup-temp', 'restore-staging'):
        folder = data_dir() / folder_name
        if not folder.exists() or folder.is_symlink() or not folder.is_dir():
            continue
        try:
            entries = list(folder.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if keep and entry.resolve() in keep:
                    continue
                if max_age_seconds > 0:
                    st = entry.lstat()
                    if (now - st.st_mtime) < max_age_seconds:
                        continue
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink(missing_ok=True)
            except OSError:
                continue


def make_backup(store: ProjectStore, project_id: str, drafts: Any, expected_updated_at: str | None = None) -> Path:
    cleanup_backup_temp(max_age_seconds=3600.0)
    tmpdir = data_dir() / 'backup-temp'; tmpdir.mkdir(parents=True, exist_ok=True)
    fd, filename = tempfile.mkstemp(prefix='project-', suffix='.zip', dir=tmpdir); os.close(fd)
    target = Path(filename)
    try:
        # A single lock ensures metadata and images represent the same revision.
        with store._lock:
            state = _validate_state(store.get(project_id))
            if expected_updated_at is not None and state.get('updatedAt') != expected_updated_at:
                raise ProjectChangedError('پروژه پیش از ساخت بک‌آپ تغییر کرده است؛ دوباره تلاش کنید.')
            drafts = _drafts(drafts, state)
            root = project_root(project_id); files: list[tuple[Path, str, int]] = []
            for item in state['images']:
                original = root / 'images' / item['file']; _check_regular(original, MAX_IMAGE); _verify_image(original, item, False)
                files.append((original, f"images/{item['file']}", MAX_IMAGE))
                edited = root / 'images' / f"{item['id']}-edited.png"
                if edited.exists() or edited.is_symlink():
                    _check_regular(edited, MAX_EDITED); _verify_image(edited, item, True); files.append((edited, f'images/{edited.name}', MAX_EDITED)); item['edited'] = True
                elif item.get('edited'):
                    raise BackupError(f"تصویر ویرایش‌شدهٔ {item.get('name', item['id'])} پیدا نشد؛ ابتدا پیش‌نمایش را بازسازی کنید.")
            exports = root / 'exports'
            if exports.exists():
                if exports.is_symlink() or not exports.is_dir():
                    raise BackupError('پوشهٔ خروجی پروژه معتبر نیست.')
                for path in sorted(exports.iterdir()):
                    if path.name.startswith(('~$', '.')) or (path.is_dir() and not path.is_symlink()):
                        continue
                    if path.suffix.lower() in EXPORT_SUFFIXES:
                        _name(path.name); _check_regular(path, MAX_EXPORT); files.append((path, f'exports/{path.name}', MAX_EXPORT))
            manifest = {'format': FORMAT, 'version': VERSION, 'appVersion': APP_VERSION, 'createdAt': utc_now(), 'apiKeysIncluded': False}
            manifest_data = _json(manifest, 4096); project_data = _json(state, MAX_JSON); draft_data = _json(drafts, MAX_DRAFTS)
            if len(files) + 3 > MAX_FILES or sum(path.stat().st_size for path, _, _ in files) + len(manifest_data) + len(project_data) + len(draft_data) > MAX_TOTAL:
                raise BackupError('حجم یا تعداد فایل‌های پروژه برای بک‌آپ بیش از حد مجاز است.')
            total_backup_bytes = max(1, sum(path.stat().st_size for path, _, _ in files))
            written_backup_bytes = 0
            with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as archive:
                archive.writestr('manifest.json', manifest_data)
                archive.writestr('project.json', project_data)
                archive.writestr('browser-drafts.json', draft_data)
                total_files_count = max(1, len(files))
                for f_idx, (path, name, _) in enumerate(files, start=1):
                    before = path.stat()
                    compress_type = zipfile.ZIP_STORED if path.suffix.lower() in STORED_ARCHIVE_SUFFIXES else zipfile.ZIP_DEFLATED
                    archive.write(path, name, compress_type=compress_type)
                    after = path.stat()
                    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                        raise BackupError(f'فایل {path.name} هنگام ساخت بک‌آپ تغییر کرد؛ دوباره تلاش کنید.')
                    written_backup_bytes += before.st_size
                    emit(
                        f"افزودن فایل {f_idx} از {total_files_count} به بستهٔ بک‌آپ…",
                        progress=round(min(0.96, written_backup_bytes / total_backup_bytes * 0.96), 4),
                    )
        if target.stat().st_size > MAX_ZIP:
            raise BackupError('حجم ZIP بیش از حد مجاز است.')
        return target
    except Exception:
        target.unlink(missing_ok=True)
        raise


def _read_bounded_bytes(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int, remaining_total: int) -> bytes:
    if info.file_size > limit or info.file_size > remaining_total:
        raise BackupError('اطلاعات بک‌آپ بیش از حد بزرگ است.')
    cap = min(limit, remaining_total)
    chunks: list[bytes] = []
    total = 0
    with archive.open(info) as source:
        while True:
            chunk = source.read(min(1024 * 1024, cap - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise BackupError('اطلاعات بک‌آپ بیش از حد بزرگ است.')
            chunks.append(chunk)
    return b''.join(chunks)


def _read_json(archive: zipfile.ZipFile, name: str, limit: int, remaining_total: int = MAX_TOTAL) -> tuple[Any, int]:
    info = archive.getinfo(name)
    raw = _read_bounded_bytes(archive, info, limit, remaining_total)
    try:
        return json.loads(raw.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid number'))), len(raw)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise BackupError('فایل اطلاعات بک‌آپ خراب است.') from exc


def _verify_image(path: Path, item: dict[str, Any], edited: bool) -> None:
    try:
        with Image.open(path) as image:
            actual_format = (image.format or '').upper()
            if actual_format == 'MPO':
                actual_format = 'JPEG'
            expected_format = str(item.get('format', '')).upper()
            if expected_format == 'MPO':
                expected_format = 'JPEG'
            if image.size != (item['width'], item['height']) or (edited and actual_format != 'PNG'):
                raise BackupError('اندازه یا قالب تصویر با اطلاعات پروژه مطابقت ندارد.')
            if not edited and actual_format != expected_format:
                raise BackupError('قالب تصویر اصلی با اطلاعات پروژه مطابقت ندارد.')
            image.verify()
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError, ValueError) as exc:
        if isinstance(exc, BackupError):
            raise
        raise BackupError('تصویر داخل بک‌آپ خراب یا نامعتبر است.') from exc


def restore_backup(store: ProjectStore, upload: BinaryIO) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    staging_root = data_dir() / 'restore-staging'; staging_root.mkdir(parents=True, exist_ok=True)
    stage: Path | None = None
    try:
        upload.seek(0, os.SEEK_END)
        if upload.tell() > MAX_ZIP:
            raise BackupError('حجم فایل ZIP بیش از حد مجاز است.')
        upload.seek(0)
        with zipfile.ZipFile(upload, 'r') as archive:
            infos = archive.infolist()
            if len(infos) > MAX_FILES or sum(info.file_size for info in infos) > MAX_TOTAL:
                raise BackupError('حجم یا تعداد فایل‌های بک‌آپ بیش از حد مجاز است.')
            names = set(); folded_names = set()
            for info in infos:
                name = info.filename; p = PurePosixPath(name)
                if not name or '\\' in name or '\x00' in name or p.is_absolute() or any(part in {'.', '..'} for part in p.parts) or name != str(p) or name in names or info.is_dir() or info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16):
                    raise BackupError('ساختار ZIP نامعتبر یا خطرناک است.')
                folded = unicodedata.normalize('NFC', name).casefold()
                if folded in folded_names:
                    raise BackupError('نام فایل‌های ZIP در سیستم مقصد یکسان است.')
                folded_names.add(folded); names.add(name)
            if not {'manifest.json', 'project.json', 'browser-drafts.json'}.issubset(names):
                raise BackupError('این فایل بک‌آپ پروژهٔ Comic OCR Studio نیست.')
            total_extracted = 0
            manifest, used = _read_json(archive, 'manifest.json', 4096, MAX_TOTAL - total_extracted)
            total_extracted += used
            if not isinstance(manifest, dict) or manifest.get('format') != FORMAT or manifest.get('version') != VERSION:
                raise BackupError('نسخه یا نوع فایل بک‌آپ پشتیبانی نمی‌شود.')
            raw_state, used = _read_json(archive, 'project.json', MAX_JSON, MAX_TOTAL - total_extracted)
            total_extracted += used
            state = _validate_state(raw_state)
            raw_drafts, used = _read_json(archive, 'browser-drafts.json', MAX_DRAFTS, MAX_TOTAL - total_extracted)
            total_extracted += used
            drafts = _drafts(raw_drafts, state)
            wanted = {'manifest.json', 'project.json', 'browser-drafts.json'}
            for item in state['images']:
                original = f"images/{item['file']}"; edited = f"images/{item['id']}-edited.png"
                if original not in names or (item.get('edited') and edited not in names):
                    raise BackupError('یکی از تصاویر موردنیاز در بک‌آپ وجود ندارد.')
                wanted.add(original)
                if edited in names: wanted.add(edited)
            for name in names - wanted:
                p = PurePosixPath(name)
                if len(p.parts) != 2 or p.parts[0] != 'exports' or Path(_name(p.name)).suffix.lower() not in EXPORT_SUFFIXES:
                    raise BackupError('بک‌آپ شامل فایل غیرمجاز است.')
            stage = Path(tempfile.mkdtemp(prefix='project-', dir=staging_root))
            (stage / 'images').mkdir(); (stage / 'exports').mkdir()
            payload_names = sorted(names - {'manifest.json', 'project.json', 'browser-drafts.json'})
            total_payload_bytes = max(1, sum(archive.getinfo(n).file_size for n in payload_names))
            extracted_payload_bytes = 0
            for f_idx, name in enumerate(payload_names, start=1):
                info = archive.getinfo(name)
                limit = MAX_EXPORT if name.startswith('exports/') else (MAX_EDITED if name.endswith('-edited.png') else MAX_IMAGE)
                if info.file_size > limit or info.file_size > MAX_TOTAL - total_extracted:
                    raise BackupError('یکی از فایل‌های بک‌آپ بیش از حد بزرگ است.')
                cap = min(limit, MAX_TOTAL - total_extracted)
                written = 0
                with archive.open(info) as source, (stage / name).open('xb') as destination:
                    while True:
                        chunk = source.read(min(1024 * 1024, cap - written + 1))
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > cap:
                            raise BackupError('یکی از فایل‌های بک‌آپ بیش از حد بزرگ است.')
                        destination.write(chunk)
                total_extracted += written
                extracted_payload_bytes += written
                emit(
                    f"بازیابی فایل {f_idx} از {max(1, len(payload_names))} از بستهٔ بک‌آپ…",
                    progress=round(min(0.95, extracted_payload_bytes / total_payload_bytes * 0.95), 4),
                )
            for item in state['images']:
                _verify_image(stage / 'images' / item['file'], item, False)
                edited = stage / 'images' / f"{item['id']}-edited.png"
                if edited.exists(): _verify_image(edited, item, True)
                item['edited'] = edited.exists()
            with store._lock:
                project_id = new_id()
                dest = project_root(project_id)
                dest.parent.mkdir(parents=True, exist_ok=True)
                while dest.exists():
                    project_id = new_id()
                    dest = project_root(project_id)
                state['id'] = project_id; state['updatedAt'] = utc_now()
                atomic_json(stage / 'project.json', state)
                os.replace(stage, dest); stage = None
            return state, drafts
    except BackupError:
        raise
    except (zipfile.BadZipFile, KeyError, EOFError, OSError, RuntimeError, ValueError) as exc:
        raise BackupError('خواندن یا بازیابی بک‌آپ ممکن نبود؛ فایل خراب یا فضای ذخیره‌سازی ناکافی است.') from exc
    finally:
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
