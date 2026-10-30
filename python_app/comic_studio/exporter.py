from __future__ import annotations

import io
import math
import re
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

import pymupdf as fitz
from PIL import Image

from .paths import project_root
from .store import ProjectStore

SAFE_PT = 14300.0
HARD_PT = 14400.0


def clean_name(value: str, fallback: str = "comic-translated") -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(value or "")).strip(" .")
    return (value or fallback)[:120]


def selected_images(state: dict[str, Any], image_ids: list[str]) -> list[dict[str, Any]]:
    ids = set(image_ids)
    images = [item for item in state.get("images", []) if not ids or item["id"] in ids]
    return sorted(images, key=lambda item: (int(item.get("order", 0)), item["id"]))


def crop_box(item: dict[str, Any]) -> tuple[int, int, int, int] | None:
    crop = item.get("crop")
    if not isinstance(crop, dict):
        return None
    try:
        if "x0" in crop:
            x0, y0, x1, y1 = (float(crop[key]) for key in ("x0", "y0", "x1", "y1"))
        else:
            x = float(crop.get("x", 0)); y = float(crop.get("y", 0))
            x0, y0, x1, y1 = x, y, x + float(crop["w"]), y + float(crop["h"])
        x0 = max(0, min(item["width"] - 1, x0)); y0 = max(0, min(item["height"] - 1, y0))
        x1 = max(x0 + 1, min(item["width"], x1)); y1 = max(y0 + 1, min(item["height"], y1))
        if x1 - x0 < 2 or y1 - y0 < 2:
            return None
        return round(x0), round(y0), round(x1), round(y1)
    except (KeyError, TypeError, ValueError):
        return None


def image_payload(store: ProjectStore, project_id: str, item: dict[str, Any], image_format: str = "orig") -> tuple[bytes, str, int, int]:
    """Return final bytes without recompressing an untouched original image."""
    edited_path = project_root(project_id) / "images" / f"{item['id']}-edited.png"
    source_path = edited_path if edited_path.exists() else project_root(project_id) / "images" / item["file"]
    content = source_path.read_bytes()
    crop = crop_box(item)
    target = image_format if image_format in {"png", "jpg"} else "orig"
    original_format = "png" if edited_path.exists() else ("jpg" if item["format"] == "JPEG" else "png")
    if not crop and target == "orig" and not edited_path.exists() and item["format"] in {"JPEG", "PNG"}:
        return content, original_format, item["width"], item["height"]
    with Image.open(io.BytesIO(content)) as opened:
        image = opened.convert("RGB") if target == "jpg" or original_format == "jpg" else opened.convert("RGBA")
        if crop:
            image = image.crop(crop)
        output_format = "JPEG" if (target == "jpg" or (target == "orig" and original_format == "jpg")) else "PNG"
        buffer = io.BytesIO()
        if output_format == "JPEG":
            image.convert("RGB").save(buffer, "JPEG", quality=100, subsampling=0)
            return buffer.getvalue(), "jpg", image.width, image.height
        image.save(buffer, "PNG")
        return buffer.getvalue(), "png", image.width, image.height


def compose_images(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Join grouped pages vertically, like the extension, using lossless PNG."""
    if len(entries) == 1:
        return entries[0]
    common_width = max(entry["w"] for entry in entries)
    raw_height = sum(entry["h"] * common_width / entry["w"] for entry in entries)
    scale = min(
        1.0,
        16000.0 / max(common_width, 1),
        16000.0 / max(raw_height, 1),
        math.sqrt(180_000_000.0 / max(common_width * raw_height, 1)),
    )
    widths = [max(1, round(entry["w"] * scale)) for entry in entries]
    heights = [max(1, round(entry["h"] * (common_width / entry["w"]) * scale)) for entry in entries]
    canvas = Image.new("RGB", (max(1, round(common_width * scale)), sum(heights)), "white")
    y = 0
    for entry, width, height in zip(entries, widths, heights):
        with Image.open(io.BytesIO(entry["data"])) as opened:
            image = opened.convert("RGB")
            if image.size != (width, height):
                image = image.resize((width, height), Image.Resampling.LANCZOS)
            x = (canvas.width - width) // 2
            canvas.paste(image, (x, y))
        y += height
    buffer = io.BytesIO()
    canvas.save(buffer, "PNG")
    return {
        "data": buffer.getvalue(), "w": canvas.width, "h": canvas.height,
        "order": min(entry.get("order", 0) for entry in entries), "grouped": True,
    }


def prepare_pdf_entries(
    store: ProjectStore, state: dict[str, Any], images: list[dict[str, Any]], two_per_page: bool,
) -> list[dict[str, Any]]:
    source = []
    for item in images:
        data, _, width, height = image_payload(store, state["id"], item)
        source.append({
            "data": data, "w": width, "h": height, "order": int(item.get("order", 0)),
            "groupId": item.get("groupId"), "grouped": False,
        })
    counts: Counter[str] = Counter(
        str(entry["groupId"]) for entry in source
        if entry["groupId"] is not None and str(entry["groupId"]).strip()
    )
    grouped: list[dict[str, Any]] = []
    consumed: set[str] = set()
    for entry in source:
        key = str(entry["groupId"]) if entry["groupId"] is not None else ""
        if not key or counts[key] < 2:
            grouped.append(entry)
            continue
        if key in consumed:
            continue
        consumed.add(key)
        members = [candidate for candidate in source if str(candidate["groupId"]) == key]
        grouped.append(compose_images(members))
    if not two_per_page:
        return grouped

    # Groups always keep their own composed page; only adjacent ungrouped pages are paired.
    result: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []

    def flush() -> None:
        for index in range(0, len(pending), 2):
            pair = pending[index:index + 2]
            result.append(compose_images(pair) if len(pair) == 2 else pair[0])
        pending.clear()

    for entry in grouped:
        if entry.get("grouped"):
            flush()
            result.append(entry)
        else:
            pending.append(entry)
    flush()
    return result


def _page_scale(width: float, height: float) -> float:
    return min(0.75, HARD_PT / max(width, 1), SAFE_PT / max(height, 1))


def _insert(document: fitz.Document, width: float, height: float, entries: list[dict[str, Any]], stacked: bool = False) -> None:
    scale = _page_scale(width, height)
    page = document.new_page(width=width * scale, height=height * scale)
    if not stacked:
        entry = entries[0]
        ratio = min(1.0, width / entry["w"], height / entry["h"])
        w, h = entry["w"] * ratio * scale, entry["h"] * ratio * scale
        x, y = (page.rect.width - w) / 2, (page.rect.height - h) / 2
        page.insert_image(fitz.Rect(x, y, x + w, y + h), stream=entry["data"])
        return
    y = 0.0
    for entry in entries:
        w, h = entry["w"] * scale, entry["h"] * scale
        x = (page.rect.width - w) / 2
        page.insert_image(fitz.Rect(x, y, x + w, y + h), stream=entry["data"])
        y += h


def build_pdf(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    seamless = bool(request.get("seamless"))
    uniform = bool(request.get("uniform_size")) and not seamless
    two_per_page = bool(request.get("two_per_page")) and not seamless
    entries = prepare_pdf_entries(store, state, images, two_per_page)
    document = fitz.open()
    if seamless:
        common_width = Counter(entry["w"] for entry in entries).most_common(1)[0][0]
        scaled = []
        for entry in entries:
            ratio = common_width / entry["w"]
            scaled.append({**entry, "w": common_width, "h": entry["h"] * ratio})
        total_height = sum(entry["h"] for entry in scaled)
        scale = _page_scale(common_width, total_height)
        # One long page whenever possible; split only at image boundaries above PDF's safe limit.
        pending: list[dict[str, Any]] = []
        pending_height = 0.0
        for entry in scaled:
            if pending and (pending_height + entry["h"]) * scale > SAFE_PT:
                _insert(document, common_width, pending_height, pending, stacked=True)
                pending, pending_height = [], 0.0
            pending.append(entry)
            pending_height += entry["h"]
        if pending:
            _insert(document, common_width, pending_height, pending, stacked=True)
    elif uniform:
        page_width = max(entry["w"] for entry in entries)
        page_height = max(entry["h"] for entry in entries)
        for entry in entries:
            _insert(document, page_width, page_height, [entry])
    else:
        for entry in entries:
            _insert(document, entry["w"], entry["h"], [entry])
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.pdf"
    output.parent.mkdir(parents=True, exist_ok=True)
    document.save(output, garbage=4, deflate=True)
    document.close()
    return output


def build_images_zip(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}-images.zip"
    folder = clean_name(request.get("folder_name", ""), "") if request.get("folder_name") else ""
    prefix = f"{folder}/" if folder else ""
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for index, item in enumerate(images, start=1):
            data, extension, _, _ = image_payload(store, state["id"], item, request.get("image_format", "orig"))
            archive.writestr(f"{prefix}{index:03d}-{clean_name(Path(item['name']).stem)}.{extension}", data)
    return output


def build_txt(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    chunks = []
    for index, item in enumerate(images, start=1):
        chunks.append(f"===== تصویر {index:03d} — {item['name']} =====\n")
        blocks = sorted(item.get("blocks", []), key=lambda block: (block.get("y0", 0), block.get("x0", 0)))
        if not blocks:
            chunks.append("(متنی تشخیص داده نشده است)\n")
        for block in blocks:
            indent = " " * max(0, min(40, int(block.get("sourceIndent", 0) or 0)))
            chunks.append(f"[{block.get('id', '-')}] {indent}{block.get('text', '')}")
            chunks.append(f"    ← {block.get('tr') or '(بدون ترجمه)'}\n")
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.txt"
    output.write_text("\ufeff" + "\n".join(chunks), encoding="utf-8")
    return output
