from __future__ import annotations

import io
import json
import math
import os
import shutil
import threading
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pymupdf as fitz
from PIL import Image

from .paths import data_dir, project_root

Image.MAX_IMAGE_PIXELS = 100_000_000
ALLOWED_IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


class ProjectChangedError(Exception):
    """A long-running operation was based on an outdated project snapshot."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:16]


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
            handle.write(json.dumps(value, ensure_ascii=False, indent=2))
        os.replace(temp, path)
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
        (data_dir() / "projects").mkdir(parents=True, exist_ok=True)

    def create(self, name: str) -> dict[str, Any]:
        project_id = new_id()
        now = utc_now()
        state = {
            "id": project_id,
            "name": (name or "پروژهٔ کمیک")[:120],
            "createdAt": now,
            "updatedAt": now,
            "images": [],
            "settings": {
                "ocrEngine": "rapidocr-v6",
                "ocrLanguage": "eng",
                "contrast": True,
                "precise": True,
                "eraseOriginal": True,
                "provider": "free",
                "output": {
                    "name": "comic-translated",
                    "seamless": False,
                    "uniformSize": False,
                    "twoPerPage": False,
                    "imageFormat": "orig",
                    "folderName": "",
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
        for path in (data_dir() / "projects").glob("*/project.json"):
            state = read_json(path, {})
            if state.get("id"):
                result.append({
                    "id": state["id"], "name": state.get("name", "پروژه"),
                    "updatedAt": state.get("updatedAt", ""), "images": len(state.get("images", [])),
                })
        return sorted(result, key=lambda item: item["updatedAt"], reverse=True)

    def get(self, project_id: str) -> dict[str, Any]:
        if not project_id.isalnum():
            raise KeyError(project_id)
        state = read_json(project_root(project_id) / "project.json", None)
        if not state:
            raise KeyError(project_id)
        return state

    def save(self, state: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            state["updatedAt"] = utc_now()
            atomic_json(project_root(state["id"]) / "project.json", state)
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
                for key in ("order", "selected", "groupId", "crop", "blocks"):
                    if key in candidate:
                        item[key] = candidate[key]
                item["edited"] = (project_root(project_id) / "images" / f"{image_id}-edited.png").exists()
                merged.append(item)
            # An image omitted by the UI is deliberately removed from the project, not from source files on disk.
            current["images"] = merged
            return self.save(current)

    def image(self, project_id: str, image_id: str) -> dict[str, Any]:
        for item in self.get(project_id).get("images", []):
            if item["id"] == image_id:
                return item
        raise KeyError(image_id)

    def image_path(self, project_id: str, image_id: str, edited: bool = False) -> Path:
        item = self.image(project_id, image_id)
        path = project_root(project_id) / "images" / (f"{image_id}-edited.png" if edited else item["file"])
        if not path.exists():
            raise FileNotFoundError(path)
        return path

    def save_rendered(self, project_id: str, image_id: str, content: bytes) -> dict[str, Any]:
        with self._lock:
            item = self.image(project_id, image_id)
            if len(content) > 100 * 1024 * 1024:
                raise ValueError("Rendered image is too large")
            with Image.open(io.BytesIO(content)) as im:
                if (im.format or "").upper() != "PNG":
                    raise ValueError("Rendered image must be PNG")
                if im.size != (item["width"], item["height"]):
                    raise ValueError("Rendered image dimensions do not match the source")
                im.verify()
            path = project_root(project_id) / "images" / f"{image_id}-edited.png"
            path.write_bytes(content)
            state = self.get(project_id)
            for item in state["images"]:
                if item["id"] == image_id:
                    item["edited"] = True
            return self.save(state)

    def revert_rendered(self, project_id: str, image_id: str) -> dict[str, Any]:
        with self._lock:
            self.image(project_id, image_id)
            (project_root(project_id) / "images" / f"{image_id}-edited.png").unlink(missing_ok=True)
            state = self.get(project_id)
            for item in state["images"]:
                if item["id"] == image_id:
                    item["edited"] = False
            return self.save(state)

    def import_files(self, project_id: str, files: list[tuple[str, bytes]], pdf_scale: float = 2.0) -> dict[str, Any]:
        state = self.get(project_id)
        original_count = len(state["images"])
        try:
            for filename, content in files:
                suffix = Path(filename).suffix.lower()
                if suffix == ".pdf":
                    self._import_pdf(state, filename, content, pdf_scale)
                elif suffix in ALLOWED_IMAGES:
                    self._import_image(state, filename, content)
                else:
                    raise ValueError(f"Unsupported file: {filename}")
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

    def _import_pdf(self, state: dict[str, Any], filename: str, content: bytes, scale: float) -> None:
        if len(content) > 500 * 1024 * 1024:
            raise ValueError("PDF is too large")
        scale = max(1.0, min(4.0, float(scale)))
        with fitz.open(stream=content, filetype="pdf") as document:
            if document.needs_pass:
                raise ValueError("Password-protected PDF is not supported")
            if len(document) > 1000:
                raise ValueError("PDF has too many pages")
            for index, page in enumerate(document):
                # Keep the extension's 2x default, but cap extreme page sizes before rasterization.
                rect = page.rect
                page_scale = min(
                    scale, 16000.0 / max(rect.width, 1), 16000.0 / max(rect.height, 1),
                    math.sqrt(48_000_000.0 / max(rect.width * rect.height, 1)),
                )
                page_scale = max(0.1, page_scale)
                pix = page.get_pixmap(matrix=fitz.Matrix(page_scale, page_scale), alpha=False)
                png = pix.tobytes("png")
                self._import_image(state, f"{Path(filename).stem} — صفحهٔ {index + 1}.png", png)

    def _import_image(self, state: dict[str, Any], filename: str, content: bytes) -> None:
        if len(content) > 150 * 1024 * 1024:
            raise ValueError(f"Image is too large: {filename}")
        try:
            with Image.open(io.BytesIO(content)) as im:
                image_format = (im.format or "PNG").upper()
                width, height = im.size
                if width < 1 or height < 1 or width * height > 100_000_000:
                    raise ValueError(f"Invalid image dimensions: {filename}")
                im.load()
        except (OSError, Image.DecompressionBombError) as exc:
            raise ValueError(f"Invalid or unsupported image: {filename}") from exc
        extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "BMP": ".bmp", "GIF": ".gif"}.get(image_format, ".png")
        # Never overwrite an existing page even if ID generation collides.
        known = {item['id'] for item in state['images']}
        for _ in range(100):
            image_id = new_id()
            file_name = f"{image_id}{extension}"
            image_path = project_root(state["id"]) / "images" / file_name
            if image_id not in known and not any(image_path.parent.glob(f"{image_id}.*")):
                break
        else:
            raise ValueError("Could not allocate a unique image ID")
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
            "groupId": None,
            "crop": None,
            "blocks": [],
            "edited": False,
        })

    def duplicate(self, project_id: str, image_ids: list[str]) -> dict[str, Any]:
        with self._lock:
            state = self.get(project_id)
            originals = {item["id"]: item for item in state["images"]}
            additions: dict[str, dict[str, Any]] = {}
            for image_id in image_ids:
                if image_id not in originals or image_id in additions:
                    continue
                old = originals[image_id]
                new = json.loads(json.dumps(old))
                new["id"] = new_id()
                new["name"] = f"کپی — {old['name']}"
                new["file"] = f"{new['id']}{Path(old['file']).suffix}"
                # A copy starts independent, rather than silently enlarging the original group.
                new["groupId"] = None
                shutil.copyfile(project_root(project_id) / "images" / old["file"], project_root(project_id) / "images" / new["file"])
                old_edited = project_root(project_id) / "images" / f"{old['id']}-edited.png"
                if old_edited.exists():
                    shutil.copyfile(old_edited, project_root(project_id) / "images" / f"{new['id']}-edited.png")
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
            shutil.rmtree(project_root(project_id))
