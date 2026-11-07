from __future__ import annotations

import io
import json
import math
import os
import shutil
import threading
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .activity import emit
from .ocr_managed import compute_worker_count, iter_parallel_ordered, trim_process_memory
from .paths import data_dir, project_root

Image.MAX_IMAGE_PIXELS = 100_000_000
ALLOWED_IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


class ProjectChangedError(Exception):
    """A long-running operation was based on an outdated project snapshot."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def _replace_with_retry(source: Path, destination: Path, windows: bool | None = None) -> None:
    """Retry transient Windows sharing/AV locks during atomic file replacement."""
    windows = os.name == "nt" if windows is None else windows
    attempts = 7 if windows else 1
    for attempt in range(attempts):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(min(0.05 * (2 ** attempt), 0.8))


def atomic_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        handle = os.fdopen(descriptor, "wb")
        descriptor = -1
        with handle:
            handle.write(content)
        _replace_with_retry(temp, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temp.unlink(missing_ok=True)


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # mkstemp creates a unique file with mode 0600 on POSIX before any
    # sensitive content is written. Keeping it in the destination directory
    # preserves atomic replacement and prevents concurrent writers colliding.
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(name)
    try:
        handle = os.fdopen(descriptor, "w", encoding="utf-8")
        descriptor = -1
        with handle:
            handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        _replace_with_retry(temp, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temp.unlink(missing_ok=True)


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


class ProjectStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._image_meta_cache: tuple[str, int, int, dict[str, dict[str, Any]]] | None = None
        self._list_summary_cache: dict[str, tuple[int, int, dict[str, Any]]] = {}
        (data_dir() / "projects").mkdir(parents=True, exist_ok=True)

    def reset_caches(self) -> None:
        with self._lock:
            self._image_meta_cache = None
            self._list_summary_cache.clear()
            (data_dir() / "projects").mkdir(parents=True, exist_ok=True)

    def create(self, name: str) -> dict[str, Any]:
        project_id = new_id()
        now = utc_now()
        clean_name = (name or "").strip()
        resolved_name = (clean_name or "پروژهٔ کمیک")[:120]
        state = {
            "id": project_id,
            "name": resolved_name,
            "createdAt": now,
            "updatedAt": now,
            "images": [],
            "settings": {
                "ocrEngine": "rapidocr-v6",
                "ocrLanguage": "eng",
                "ocrPageMode": "comic",
                "contrast": True,
                "precise": True,
                "eraseOriginal": True,
                "provider": "free",
                "targetLanguage": "fa",
                "output": {
                    "name": resolved_name,
                    "nameCustomized": False,
                    "seamless": False,
                    "uniformSize": False,
                    "twoPerPage": False,
                    "imageFormat": "orig",
                    "folderName": "",
                    "docxLayout": "visual",
                },
            },
        }
        root = project_root(project_id)
        (root / "images").mkdir(parents=True, exist_ok=True)
        (root / "exports").mkdir(parents=True, exist_ok=True)
        self.save(state)
        return state

    def list(self) -> list[dict[str, Any]]:
        result = []
        active_keys: set[str] = set()
        for path in (data_dir() / "projects").glob("*/project.json"):
            key = str(path)
            active_keys.add(key)
            try:
                st = path.stat()
            except OSError:
                continue
            cached = self._list_summary_cache.get(key)
            if cached is not None and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
                result.append(dict(cached[2]))
                continue
            state = read_json(path, {})
            if state.get("id"):
                summary = {
                    "id": state["id"], "name": state.get("name", "پروژه"),
                    "updatedAt": state.get("updatedAt", ""), "images": len(state.get("images", [])),
                }
                self._list_summary_cache[key] = (st.st_mtime_ns, st.st_size, summary)
                result.append(dict(summary))
        if len(self._list_summary_cache) > len(active_keys) + 8:
            for stale_key in list(self._list_summary_cache):
                if stale_key not in active_keys:
                    self._list_summary_cache.pop(stale_key, None)
        return sorted(result, key=lambda item: item["updatedAt"], reverse=True)

    def get(self, project_id: str) -> dict[str, Any]:
        if not project_id.isascii() or not project_id.isalnum():
            raise KeyError(project_id)
        state = read_json(project_root(project_id) / "project.json", None)
        if not state:
            raise KeyError(project_id)
        return state

    def save(self, state: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            state["updatedAt"] = utc_now()
            path = project_root(state["id"]) / "project.json"
            atomic_json(path, state)
            try:
                st = path.stat()
                meta_map = {
                    str(img["id"]): {k: v for k, v in img.items() if k != "blocks"}
                    for img in state.get("images", [])
                    if isinstance(img, dict) and img.get("id")
                }
                self._image_meta_cache = (str(state["id"]), st.st_mtime_ns, st.st_size, meta_map)
                self._list_summary_cache[str(path)] = (
                    st.st_mtime_ns,
                    st.st_size,
                    {
                        "id": state["id"],
                        "name": state.get("name", "پروژه"),
                        "updatedAt": state.get("updatedAt", ""),
                        "images": len(state.get("images", [])),
                    },
                )
            except OSError:
                self._image_meta_cache = None
            return state

    def save_if_unchanged(self, state: dict[str, Any], expected_updated_at: str) -> dict[str, Any]:
        """Do not overwrite edits made while OCR or translation was running."""
        with self._lock:
            try:
                current = self.get(state["id"])
            except KeyError as exc:
                raise ProjectChangedError("پروژه در حین پردازش حذف شده است؛ نتیجه ذخیره نشد.") from exc
            if current.get("updatedAt") != expected_updated_at:
                raise ProjectChangedError("پروژه در حین پردازش تغییر کرد؛ برای حفظ ویرایش‌ها نتیجه ذخیره نشد. دوباره تلاش کنید.")
            return self.save(state)

    def save_ocr_result(self, state: dict[str, Any], expected_updated_at: str, image_ids: list[str]) -> dict[str, Any]:
        # Keep preview uploads from racing between the version check and cleanup.
        with self._lock:
            self.save_if_unchanged(state, expected_updated_at)
            images_dir = project_root(state["id"]) / "images"
            for item in state["images"]:
                if item["id"] in image_ids:
                    (images_dir / f"{item['id']}-edited.png").unlink(missing_ok=True)
            return state

    def update_state(self, project_id: str, incoming: dict[str, Any]) -> dict[str, Any]:
        """Merge UI state while keeping server-owned file metadata and paths safe."""
        with self._lock:
            current = self.get(project_id)
            current["name"] = str(incoming.get("name", current["name"]))[:120]
            if isinstance(incoming.get("settings"), dict):
                current["settings"] = incoming["settings"]
            existing = {item["id"]: item for item in current.get("images", [])}
            merged = []
            seen = set()
            for candidate in incoming.get("images", []):
                if not isinstance(candidate, dict):
                    continue
                image_id = str(candidate.get("id", ""))
                if image_id not in existing or image_id in seen:
                    continue
                seen.add(image_id)
                old = existing[image_id]
                item = dict(old)
                for key in ("order", "selected", "groupId", "crop", "blocks", "pageMode", "approved", "watermark"):
                    if key in candidate:
                        item[key] = bool(candidate[key]) if key == "approved" else candidate[key]
                item["edited"] = (project_root(project_id) / "images" / f"{image_id}-edited.png").exists()
                merged.append(item)
            # An image omitted by the UI is deliberately removed from the project, not from source files on disk.
            current["images"] = merged
            return self.save(current)

    def _image_meta(self, project_id: str, image_id: str) -> dict[str, Any]:
        if not project_id.isascii() or not project_id.isalnum():
            raise KeyError(project_id)
        proj_json = project_root(project_id) / "project.json"
        try:
            st = proj_json.stat()
        except FileNotFoundError as exc:
            raise KeyError(project_id) from exc
        cached = self._image_meta_cache
        if cached is not None and cached[0] == project_id and cached[1] == st.st_mtime_ns and cached[2] == st.st_size:
            hit = cached[3].get(image_id)
            if hit is not None:
                return dict(hit)
            raise KeyError(image_id)
        state = self.get(project_id)
        meta_map = {
            str(img["id"]): {k: v for k, v in img.items() if k != "blocks"}
            for img in state.get("images", [])
            if isinstance(img, dict) and img.get("id")
        }
        self._image_meta_cache = (project_id, st.st_mtime_ns, st.st_size, meta_map)
        hit = meta_map.get(image_id)
        if hit is not None:
            return dict(hit)
        raise KeyError(image_id)

    def image(self, project_id: str, image_id: str) -> dict[str, Any]:
        for item in self.get(project_id).get("images", []):
            if item["id"] == image_id:
                return item
        raise KeyError(image_id)

    def image_path(self, project_id: str, image_id: str, edited: bool = False) -> Path:
        item = self._image_meta(project_id, image_id)
        path = project_root(project_id) / "images" / (f"{image_id}-edited.png" if edited else item["file"])
        if not path.exists():
            raise FileNotFoundError(path)
        return path

    def save_rendered(self, project_id: str, image_id: str, content: bytes) -> dict[str, Any]:
        if len(content) > 150 * 1024 * 1024:
            raise ValueError("Rendered image is too large")
        with Image.open(io.BytesIO(content)) as im:
            if (im.format or "").upper() != "PNG":
                raise ValueError("Rendered image must be PNG")
            rendered_size = im.size
            im.verify()
        with self._lock:
            state = self.get(project_id)
            target_item = next((item for item in state.get("images", []) if item["id"] == image_id), None)
            if target_item is None:
                raise KeyError(image_id)
            if rendered_size != (target_item["width"], target_item["height"]):
                raise ValueError("Rendered image dimensions do not match the source")
            path = project_root(project_id) / "images" / f"{image_id}-edited.png"
            atomic_bytes(path, content)
            target_item["edited"] = True
            return self.save(state)

    def revert_rendered(self, project_id: str, image_id: str) -> dict[str, Any]:
        with self._lock:
            state = self.get(project_id)
            target_item = next((item for item in state.get("images", []) if item["id"] == image_id), None)
            if target_item is None:
                raise KeyError(image_id)
            (project_root(project_id) / "images" / f"{image_id}-edited.png").unlink(missing_ok=True)
            target_item["edited"] = False
            return self.save(state)

    @staticmethod
    def _normalize_and_validate_image_bytes(filename: str, content: bytes) -> tuple[bytes, str, int, int]:
        if len(content) > 150 * 1024 * 1024:
            raise ValueError(f"Image is too large: {filename}")
        try:
            with Image.open(io.BytesIO(content)) as im:
                raw_format = (im.format or "PNG").upper()
                image_format = "JPEG" if raw_format == "MPO" else raw_format
                width, height = im.size
                if width < 1 or height < 1 or width * height > 100_000_000:
                    raise ValueError(f"Invalid image dimensions: {filename}")
                im.load()
                try:
                    orientation = int(im.getexif().get(0x0112, 1) or 1)
                except Exception:
                    orientation = 1
                if orientation in {2, 3, 4, 5, 6, 7, 8}:
                    transposed = ImageOps.exif_transpose(im)
                    try:
                        width, height = transposed.size
                        if width < 1 or height < 1 or width * height > 100_000_000:
                            raise ValueError(f"Invalid image dimensions: {filename}")
                        out = io.BytesIO()
                        save_fmt = image_format if image_format in {"JPEG", "PNG", "WEBP", "BMP", "GIF"} else "PNG"
                        exif_bytes = transposed.info.get("exif")
                        save_kwargs: dict[str, Any] = {}
                        if exif_bytes:
                            save_kwargs["exif"] = exif_bytes
                        if save_fmt == "JPEG":
                            rgb = transposed if transposed.mode in {"RGB", "L", "CMYK"} else transposed.convert("RGB")
                            try:
                                rgb.save(out, format="JPEG", quality=95, subsampling=0, **save_kwargs)
                            finally:
                                if rgb is not transposed:
                                    rgb.close()
                        elif save_fmt == "WEBP":
                            transposed.save(out, format="WEBP", quality=95, **save_kwargs)
                        else:
                            transposed.save(out, format=save_fmt, **save_kwargs)
                        content = out.getvalue()
                        image_format = save_fmt
                    finally:
                        if transposed is not im:
                            transposed.close()
        except (OSError, Image.DecompressionBombError) as exc:
            raise ValueError(f"Invalid or unsupported image: {filename}") from exc
        if len(content) > 150 * 1024 * 1024:
            raise ValueError(f"Image is too large: {filename}")
        return content, image_format, width, height

    @classmethod
    def _validate_image_bytes(cls, filename: str, content: bytes) -> tuple[str, int, int]:
        _, image_format, width, height = cls._normalize_and_validate_image_bytes(filename, content)
        return image_format, width, height

    def _commit_validated_image(
        self,
        state: dict[str, Any],
        filename: str,
        content: bytes,
        image_format: str,
        width: int,
        height: int,
    ) -> None:
        extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "BMP": ".bmp", "GIF": ".gif"}.get(image_format, ".png")
        known = {item["id"] for item in state["images"]}
        image_id, file_name, image_path = self._allocate_image_slot(state["id"], known, extension)
        try:
            image_path.write_bytes(content)
        except OSError:
            image_path.unlink(missing_ok=True)
            raise
        state["images"].append({
            "id": image_id,
            "name": Path(filename).name,
            "file": file_name,
            "width": width,
            "height": height,
            "format": image_format,
            "bytes": len(content),
            "order": self._next_order(state),
            "selected": True,
            "approved": False,
            "groupId": None,
            "crop": None,
            "blocks": [],
            "edited": False,
        })

    def import_files(self, project_id: str, files: list[tuple[str, bytes]], pdf_scale: float = 2.0) -> dict[str, Any]:
        state = self.get(project_id)
        original_count = len(state["images"])
        try:
            for filename, _ in files:
                suffix = Path(filename).suffix.lower()
                if suffix != ".pdf" and suffix not in ALLOWED_IMAGES:
                    raise ValueError(f"Unsupported file: {filename}")

            total_inputs = max(1, len(files))
            completed_inputs = 0
            image_batch: list[tuple[str, bytes]] = []

            def _flush_image_batch() -> None:
                nonlocal completed_inputs
                if not image_batch:
                    return
                if len(image_batch) == 1:
                    fn, raw = image_batch[0]
                    self._import_image(state, fn, raw)
                    completed_inputs += 1
                    emit(
                        f"آماده‌سازی تصویر {completed_inputs} از {total_inputs}: {Path(fn).name}",
                        progress=round(completed_inputs / total_inputs * 0.96, 4),
                    )
                else:
                    workers, _ = compute_worker_count(len(image_batch), per_worker_mb=120, max_cap=8)
                    for _, (fn, _raw), (norm_bytes, fmt, w, h) in iter_parallel_ordered(
                        image_batch,
                        lambda _i, pair: self._normalize_and_validate_image_bytes(pair[0], pair[1]),
                        max_workers=workers,
                    ):
                        self._commit_validated_image(state, fn, norm_bytes, fmt, w, h)
                        completed_inputs += 1
                        emit(
                            f"آماده‌سازی تصویر {completed_inputs} از {total_inputs}: {Path(fn).name}",
                            progress=round(completed_inputs / total_inputs * 0.96, 4),
                        )
                image_batch.clear()

            for filename, content in files:
                suffix = Path(filename).suffix.lower()
                if suffix == ".pdf":
                    _flush_image_batch()
                    p_lo = completed_inputs / total_inputs * 0.96
                    p_hi = (completed_inputs + 1) / total_inputs * 0.96
                    self._import_pdf(state, filename, content, pdf_scale, progress_span=(p_lo, p_hi))
                    completed_inputs += 1
                else:
                    image_batch.append((filename, content))
            _flush_image_batch()

            # Import adds fresh IDs and never changes existing images. Merge
            # those additions into the latest project under the same lock so
            # unrelated edits do not discard a long PDF import.
            with self._lock:
                try:
                    current = self.get(project_id)
                except KeyError as exc:
                    raise ProjectChangedError("پروژه هنگام ورود فایل حذف شد؛ نتیجه ذخیره نشد.") from exc
                existing = {item['id'] for item in current['images']}
                additions = state['images'][original_count:]
                if any(item['id'] in existing for item in additions):
                    raise ProjectChangedError("شناسهٔ تصویر واردشده تکراری است؛ فایل‌ها افزوده نشدند.")
                for item in additions:
                    item['order'] = self._next_order(current)
                    current['images'].append(item)
                return self.save(current)
        except Exception:
            # A failed batch must not leave orphan images (including PDF pages).
            for item in state["images"][original_count:]:
                (project_root(project_id) / "images" / item["file"]).unlink(missing_ok=True)
            raise

    def _next_order(self, state: dict[str, Any]) -> int:
        return max((int(item.get("order", 0)) for item in state["images"]), default=-1) + 1

    def _allocate_image_slot(self, project_id: str, known: set[str], extension: str) -> tuple[str, str, Path]:
        images_dir = project_root(project_id) / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        for _ in range(100):
            image_id = new_id()
            file_name = f"{image_id}{extension}"
            image_path = images_dir / file_name
            if image_id not in known and not any(images_dir.glob(f"{image_id}.*")):
                known.add(image_id)
                return image_id, file_name, image_path
        raise ValueError("Could not allocate a unique image ID")

    def _import_pdf(
        self,
        state: dict[str, Any],
        filename: str,
        content: bytes,
        scale: float,
        *,
        progress_span: tuple[float, float] = (0.0, 0.96),
    ) -> None:
        if len(content) > 500 * 1024 * 1024:
            raise ValueError("PDF is too large")
        import pymupdf as fitz

        scale = max(1.0, min(4.0, float(scale)))
        with fitz.open(stream=content, filetype="pdf") as check_doc:
            if check_doc.needs_pass:
                raise ValueError("Password-protected PDF is not supported")
            page_count = len(check_doc)
            if page_count > 1000:
                raise ValueError("PDF has too many pages")

        if page_count == 0:
            return

        project_id = state["id"]
        known = {item["id"] for item in state["images"]}
        slots = [self._allocate_image_slot(project_id, known, ".png") for _ in range(page_count)]
        stem = Path(filename).stem
        workers, _ = compute_worker_count(page_count, per_worker_mb=140, max_cap=8)

        tls = threading.local()
        opened_docs: list[fitz.Document] = []
        docs_lock = threading.Lock()

        def _get_thread_doc() -> fitz.Document:
            doc = getattr(tls, "doc", None)
            if doc is None:
                doc = fitz.open(stream=content, filetype="pdf")
                tls.doc = doc
                with docs_lock:
                    opened_docs.append(doc)
            return doc

        def _render_one_page(_idx: int, page_index: int) -> dict[str, Any]:
            image_id, file_name, image_path = slots[page_index]
            doc = _get_thread_doc()
            page = doc[page_index]
            rect = page.rect
            page_scale = min(
                scale, 16000.0 / max(rect.width, 1), 16000.0 / max(rect.height, 1),
                math.sqrt(48_000_000.0 / max(rect.width * rect.height, 1)),
            )
            page_scale = max(0.1, page_scale)
            pix = page.get_pixmap(matrix=fitz.Matrix(page_scale, page_scale), alpha=False)
            width, height = int(pix.width), int(pix.height)
            if width < 1 or height < 1 or width * height > 100_000_000:
                del pix
                raise ValueError(f"Invalid image dimensions: {stem} — صفحهٔ {page_index + 1}.png")
            png = pix.tobytes("png")
            byte_len = len(png)
            del pix
            try:
                image_path.write_bytes(png)
            except OSError:
                image_path.unlink(missing_ok=True)
                raise
            finally:
                del png
            return {
                "id": image_id,
                "name": f"{stem} — صفحهٔ {page_index + 1}.png",
                "file": file_name,
                "width": width,
                "height": height,
                "format": "PNG",
                "bytes": byte_len,
                "selected": True,
                "approved": False,
                "groupId": None,
                "crop": None,
                "blocks": [],
                "edited": False,
            }

        written_paths: list[Path] = []
        p_lo, p_hi = progress_span
        try:
            for step_idx, page_idx, entry in iter_parallel_ordered(list(range(page_count)), _render_one_page, max_workers=workers):
                written_paths.append(slots[page_idx][2])
                entry["order"] = self._next_order(state)
                state["images"].append(entry)
                done_pages = step_idx + 1
                emit(
                    f"تبدیل صفحهٔ {done_pages} از {page_count} فایل PDF ({Path(filename).name})…",
                    progress=round(p_lo + (p_hi - p_lo) * (done_pages / max(1, page_count)), 4),
                )
                if done_pages % 16 == 0:
                    trim_process_memory()
        except Exception:
            for _, _, slot_path in slots:
                slot_path.unlink(missing_ok=True)
            raise
        finally:
            for doc in opened_docs:
                try:
                    doc.close()
                except Exception:
                    pass
            trim_process_memory()

    def _import_image(self, state: dict[str, Any], filename: str, content: bytes) -> None:
        norm_bytes, image_format, width, height = self._normalize_and_validate_image_bytes(filename, content)
        self._commit_validated_image(state, filename, norm_bytes, image_format, width, height)

    def duplicate(self, project_id: str, image_ids: list[str]) -> dict[str, Any]:
        with self._lock:
            state = self.get(project_id)
            originals = {item["id"]: item for item in state["images"]}
            used_ids = set(originals)
            additions: dict[str, dict[str, Any]] = {}
            for image_id in image_ids:
                if image_id not in originals or image_id in additions:
                    continue
                old = originals[image_id]
                new = json.loads(json.dumps(old))
                candidate_id = new_id()
                while candidate_id in used_ids:
                    candidate_id = new_id()
                used_ids.add(candidate_id)
                new["id"] = candidate_id
                new["name"] = f"کپی — {old['name']}"
                new["file"] = f"{new['id']}{Path(old['file']).suffix}"
                # A copy starts independent, rather than silently enlarging the original group.
                new["groupId"] = None
                new["approved"] = False
                shutil.copyfile(project_root(project_id) / "images" / old["file"], project_root(project_id) / "images" / new["file"])
                old_edited = project_root(project_id) / "images" / f"{old['id']}-edited.png"
                has_edited = old_edited.exists()
                if has_edited:
                    shutil.copyfile(old_edited, project_root(project_id) / "images" / f"{new['id']}-edited.png")
                new["edited"] = has_edited
                additions[image_id] = new
            merged = []
            for item in state["images"]:
                merged.append(item)
                if item["id"] in additions:
                    merged.append(additions[item["id"]])
            for index, item in enumerate(merged):
                item["order"] = index
            state["images"] = merged
            return self.save(state)

    def delete(self, project_id: str, image_ids: list[str]) -> dict[str, Any]:
        with self._lock:
            state = self.get(project_id)
            ids = set(image_ids)
            removed = [item for item in state["images"] if item["id"] in ids]
            state["images"] = [item for item in state["images"] if item["id"] not in ids]
            # Commit metadata before deleting files so a failed save leaves the project usable.
            self.save(state)
            # Resolve only actual project members; untrusted IDs must never be glob patterns.
            for item in removed:
                images_dir = project_root(project_id) / "images"
                (images_dir / item["file"]).unlink(missing_ok=True)
                (images_dir / f"{item['id']}-edited.png").unlink(missing_ok=True)
            return state

    def delete_project(self, project_id: str) -> None:
        with self._lock:
            self.get(project_id)  # validates the id and prevents deleting an arbitrary path
            if self._image_meta_cache is not None and self._image_meta_cache[0] == project_id:
                self._image_meta_cache = None
            shutil.rmtree(project_root(project_id))
