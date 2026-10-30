from __future__ import annotations

import io
import json
import math
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pymupdf as fitz
from PIL import Image

from .paths import data_dir, project_root

Image.MAX_IMAGE_PIXELS = 100_000_000
ALLOWED_IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


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
        self.image(project_id, image_id)
        (project_root(project_id) / "images" / f"{image_id}-edited.png").unlink(missing_ok=True)
        state = self.get(project_id)
        for item in state["images"]:
            if item["id"] == image_id:
                item["edited"] = False
        return self.save(state)

    def import_files(self, project_id: str, files: list[tuple[str, bytes]], pdf_scale: float = 2.0) -> dict[str, Any]:
        state = self.get(project_id)
        for filename, content in files:
            suffix = Path(filename).suffix.lower()
            if suffix == ".pdf":
                self._import_pdf(state, filename, content, pdf_scale)
            elif suffix in ALLOWED_IMAGES:
                self._import_image(state, filename, content)
            else:
                raise ValueError(f"Unsupported file: {filename}")
        return self.save(state)

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
        with Image.open(io.BytesIO(content)) as im:
            im.load()
            image_format = (im.format or "PNG").upper()
            width, height = im.size
        if width < 1 or height < 1 or width * height > 100_000_000:
            raise ValueError(f"Invalid image dimensions: {filename}")
        image_id = new_id()
        extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "BMP": ".bmp", "GIF": ".gif"}.get(image_format, ".png")
        file_name = f"{image_id}{extension}"
        (project_root(state["id"]) / "images" / file_name).write_bytes(content)
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
        state = self.get(project_id)
        ids = set(image_ids)
        state["images"] = [item for item in state["images"] if item["id"] not in ids]
        for image_id in ids:
            for path in (project_root(project_id) / "images").glob(f"{image_id}*"):
                path.unlink(missing_ok=True)
        return self.save(state)

    def delete_project(self, project_id: str) -> None:
        self.get(project_id)  # validates the id and prevents deleting an arbitrary path
        shutil.rmtree(project_root(project_id))
