from __future__ import annotations

import contextlib
import io
import math
import os
import re
import tempfile
import zipfile
from collections import Counter
from collections.abc import Iterator
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

from PIL import Image, ImageDraw

from .activity import check_cancelled, emit
from .license_guard import require_active_license
from .ocr_managed import compute_worker_count, iter_parallel_ordered
from .paths import project_root
from .store import ProjectStore, _replace_with_retry
from .watermark_render import apply_watermark_pil, has_active_watermark

SAFE_PT = 14300.0
HARD_PT = 14400.0
_WINDOWS_RESERVED_NAME_RE = re.compile(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])")


def clean_name(value: str, fallback: str = "comic-translated") -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(value or "")).strip(" .")[:120].rstrip(" .")
    if cleaned and _WINDOWS_RESERVED_NAME_RE.fullmatch(cleaned.split(".")[0]):
        cleaned = f"_{cleaned}"[:120].rstrip(" .")
    if cleaned:
        return cleaned
    if not fallback:
        return ""
    safe_fallback = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(fallback)).strip(" .")[:120].rstrip(" .")
    if safe_fallback and _WINDOWS_RESERVED_NAME_RE.fullmatch(safe_fallback.split(".")[0]):
        safe_fallback = f"_{safe_fallback}"[:120].rstrip(" .")
    return safe_fallback or "comic-translated"


def _export_stem(state: dict[str, Any], request: dict[str, Any]) -> str:
    raw = str(request.get("name") or "").strip()
    if not raw:
        out = (state.get("settings") or {}).get("output") or {}
        if out.get("nameCustomized") and str(out.get("name") or "").strip():
            raw = str(out.get("name") or "").strip()
        else:
            raw = str(state.get("name") or "").strip()
    return clean_name(raw, "comic-translated")


def _fs_path(path: Path) -> str:
    resolved = str(path.resolve() if not path.is_absolute() else path)
    if os.name == "nt" and not resolved.startswith("\\\\?\\") and len(resolved) >= 240:
        if resolved.startswith("\\\\"):
            return "\\\\?\\UNC\\" + resolved[2:]
        return "\\\\?\\" + resolved
    return resolved


@contextlib.contextmanager
def _atomic_export_path(output: Path) -> Iterator[Path]:
    parent = Path(_fs_path(output.parent))
    parent.mkdir(parents=True, exist_ok=True)
    fd, raw_tmp = tempfile.mkstemp(prefix=".exp-", suffix=".tmp", dir=str(parent))
    os.close(fd)
    tmp_path = Path(raw_tmp)
    try:
        yield tmp_path
        tmp_fs = Path(_fs_path(tmp_path))
        if not tmp_fs.is_file() or tmp_fs.stat().st_size <= 0:
            raise ValueError("فایل خروجی روی دیسک خالی ساخته شد؛ فضای خالی درایو و دسترسی پوشه را بررسی کنید.")
        out_fs = Path(_fs_path(output))
        _replace_with_retry(tmp_fs, out_fs)
    finally:
        with contextlib.suppress(OSError):
            Path(_fs_path(tmp_path)).unlink(missing_ok=True)


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


def image_payload(
    store: ProjectStore,
    project_id: str,
    item: dict[str, Any],
    image_format: str = "orig",
    *,
    logos_map: dict[str, Any] | None = None,
    allow_edited: bool = True,
) -> tuple[bytes, str, int, int]:
    """Return final bytes without recompressing an untouched original or uncropped PNG render."""
    edited_path = project_root(project_id) / "images" / f"{item['id']}-edited.png"
    has_edited = bool(
        allow_edited
        and item.get("edited") is not False
        and edited_path.is_file()
        and edited_path.stat().st_size > 0
    )
    source_path = edited_path if has_edited else project_root(project_id) / "images" / item["file"]
    content = source_path.read_bytes()
    crop = crop_box(item)
    needs_backend_wm = (not has_edited) and has_active_watermark(item.get("watermark"))
    target = image_format if image_format in {"png", "jpg"} else "orig"
    original_format = "png" if has_edited else ("jpg" if item["format"] == "JPEG" else "png")
    if not crop and not needs_backend_wm:
        if has_edited and target in {"orig", "png"}:
            with Image.open(io.BytesIO(content)) as opened:
                return content, "png", opened.width, opened.height
        if not has_edited and (
            (item["format"] == "PNG" and target in {"orig", "png"})
            or (item["format"] == "JPEG" and target in {"orig", "jpg"})
        ):
            return content, original_format, item["width"], item["height"]
    resolved_logos = logos_map
    if needs_backend_wm and resolved_logos is None and isinstance(item.get("watermark"), dict) and item["watermark"].get("logoId"):
        with contextlib.suppress(Exception):
            resolved_logos = ((store.get(project_id).get("settings") or {}).get("watermarkLogos") or {})
    with Image.open(io.BytesIO(content)) as opened:
        image = opened.convert("RGB") if target == "jpg" or original_format == "jpg" else opened.convert("RGBA")
    try:
        if crop:
            cropped_img = image.crop(crop)
            image.close()
            image = cropped_img
        if needs_backend_wm:
            watermarked = apply_watermark_pil(image, item.get("watermark"), resolved_logos)
            if watermarked is not image:
                image.close()
                image = watermarked
        output_format = "JPEG" if (target == "jpg" or (target == "orig" and original_format == "jpg")) else "PNG"
        buffer = io.BytesIO()
        if output_format == "JPEG":
            rgb_img = image if image.mode == "RGB" else image.convert("RGB")
            try:
                rgb_img.save(buffer, "JPEG", quality=100, subsampling=0)
            finally:
                if rgb_img is not image:
                    rgb_img.close()
            return buffer.getvalue(), "jpg", image.width, image.height
        image.save(buffer, "PNG")
        return buffer.getvalue(), "png", image.width, image.height
    finally:
        image.close()


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
    # Every member is normalized to the composed page width. Keeping a narrower source width
    # while scaling its height to common_width would stretch it and leave unintended side bars.
    widths = [max(1, round(common_width * scale)) for _ in entries]
    heights = [max(1, round(entry["h"] * (common_width / entry["w"]) * scale)) for entry in entries]
    canvas = Image.new("RGB", (max(1, round(common_width * scale)), sum(heights)), "white")
    try:
        y = 0
        for entry, width, height in zip(entries, widths, heights):
            with Image.open(io.BytesIO(entry["data"])) as opened:
                image = opened.convert("RGB")
            try:
                if image.size != (width, height):
                    resized = image.resize((width, height), Image.Resampling.LANCZOS)
                    image.close()
                    image = resized
                x = (canvas.width - width) // 2
                canvas.paste(image, (x, y))
            finally:
                image.close()
            y += height
        buffer = io.BytesIO()
        canvas.save(buffer, "PNG")
        return {
            "data": buffer.getvalue(), "w": canvas.width, "h": canvas.height,
            "order": min(entry.get("order", 0) for entry in entries), "grouped": True,
        }
    finally:
        canvas.close()


def _plan_pdf_units(images: list[dict[str, Any]], two_per_page: bool) -> list[tuple[list[dict[str, Any]], bool]]:
    """Group page metadata into output PDF units before reading or decoding image bytes."""
    by_group: dict[str, list[dict[str, Any]]] = {}
    for item in images:
        gid = str(item["groupId"]).strip() if item.get("groupId") is not None else ""
        if gid:
            by_group.setdefault(gid, []).append(item)

    grouped_units: list[tuple[list[dict[str, Any]], bool]] = []
    consumed: set[str] = set()
    for item in images:
        gid = str(item["groupId"]).strip() if item.get("groupId") is not None else ""
        members = by_group.get(gid)
        if not gid or not members or len(members) < 2:
            grouped_units.append(([item], False))
            continue
        if gid in consumed:
            continue
        consumed.add(gid)
        grouped_units.append((members, True))

    if not two_per_page:
        return grouped_units

    result: list[tuple[list[dict[str, Any]], bool]] = []
    pending: list[dict[str, Any]] = []

    def flush() -> None:
        for index in range(0, len(pending), 2):
            pair = pending[index:index + 2]
            result.append((pair, len(pair) == 2))
        pending.clear()

    for members, is_grouped in grouped_units:
        if is_grouped:
            flush()
            result.append((members, True))
        else:
            pending.append(members[0])
    flush()
    return result


def _iter_pdf_entries(
    store: ProjectStore, state: dict[str, Any], images: list[dict[str, Any]], two_per_page: bool,
) -> Iterator[tuple[int, int, dict[str, Any]]]:
    units = _plan_pdf_units(images, two_per_page)
    total_units = max(1, len(units))
    workers, _ = compute_worker_count(len(units), per_worker_mb=160, max_cap=8)
    project_id = state["id"]

    def _render_unit(_idx: int, unit: tuple[list[dict[str, Any]], bool]) -> dict[str, Any]:
        members, should_compose = unit
        member_entries: list[dict[str, Any]] = []
        logos_map = ((state.get("settings") or {}).get("watermarkLogos") or {})
        for item in members:
            data, _, width, height = image_payload(store, project_id, item, logos_map=logos_map)
            member_entries.append({
                "data": data,
                "w": width,
                "h": height,
                "order": int(item.get("order", 0)),
                "groupId": item.get("groupId"),
                "grouped": False,
            })
        if should_compose and len(member_entries) > 1:
            composed = compose_images(member_entries)
            for m in member_entries:
                m["data"] = b""
            return composed
        return member_entries[0]

    for idx, _unit, entry in iter_parallel_ordered(units, _render_unit, max_workers=workers):
        step = idx + 1
        emit(f"آماده‌سازی تصویر {step} از {total_units} برای PDF", progress=step / total_units * 0.55)
        yield step, total_units, entry


def prepare_pdf_entries(
    store: ProjectStore, state: dict[str, Any], images: list[dict[str, Any]], two_per_page: bool,
) -> list[dict[str, Any]]:
    return [entry for _, _, entry in _iter_pdf_entries(store, state, images, two_per_page)]


def _page_scale(width: float, height: float) -> float:
    return min(0.75, HARD_PT / max(width, 1), SAFE_PT / max(height, 1))


def _insert(document: Any, width: float, height: float, entries: list[dict[str, Any]], stacked: bool = False) -> None:
    import pymupdf as fitz

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
    import pymupdf as fitz

    require_active_license()
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("برای خروجی هیچ تصویری انتخاب نشده است؛ حداقل یک تصویر را انتخاب کنید.")
    seamless = bool(request.get("seamless"))
    uniform = bool(request.get("uniform_size")) and not seamless
    two_per_page = bool(request.get("two_per_page")) and not seamless
    document = fitz.open()
    try:
        if not seamless and not uniform:
            # Stream prepared pages straight into PyMuPDF and drop image bytes immediately.
            for idx, total_entries, entry in _iter_pdf_entries(store, state, images, two_per_page):
                _insert(document, entry["w"], entry["h"], [entry])
                entry["data"] = b""
                emit(f"چیدمان صفحهٔ {idx} از {total_entries} در PDF", progress=0.55 + idx / max(1, total_entries) * 0.4)
        else:
            entries = prepare_pdf_entries(store, state, images, two_per_page)
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
                    check_cancelled("ساخت خروجی به درخواست کاربر لغو شد.")
                    if pending and (pending_height + entry["h"]) * scale > SAFE_PT:
                        _insert(document, common_width, pending_height, pending, stacked=True)
                        for p in pending:
                            p["data"] = b""
                        pending, pending_height = [], 0.0
                    pending.append(entry)
                    pending_height += entry["h"]
                if pending:
                    _insert(document, common_width, pending_height, pending, stacked=True)
                    for p in pending:
                        p["data"] = b""
            else:
                page_width = max(entry["w"] for entry in entries)
                page_height = max(entry["h"] for entry in entries)
                for idx, entry in enumerate(entries, start=1):
                    _insert(document, page_width, page_height, [entry])
                    entry["data"] = b""
                    emit(f"چیدمان صفحهٔ {idx} از {len(entries)} در PDF", progress=0.55 + idx / max(1, len(entries)) * 0.4)
        if document.page_count < 1:
            raise ValueError("هیچ صفحه‌ای برای ساخت PDF آماده نشد.")
        output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}.pdf"
        emit("در حال ذخیره‌سازی فایل PDF…", progress=0.97)
        with _atomic_export_path(output) as tmp_output:
            tmp_fs = _fs_path(tmp_output)
            with contextlib.suppress(OSError):
                Path(tmp_fs).unlink(missing_ok=True)
            saved_ok = False
            with contextlib.suppress(Exception):
                document.save(tmp_fs, garbage=4, deflate=True)
                saved_ok = Path(tmp_fs).is_file() and Path(tmp_fs).stat().st_size > 0
            if not saved_ok:
                pdf_bytes = document.tobytes(garbage=4, deflate=True)
                Path(tmp_fs).write_bytes(pdf_bytes)
    finally:
        document.close()
    return output


def build_images_zip(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    require_active_license()
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("برای خروجی هیچ تصویری انتخاب نشده است؛ حداقل یک تصویر را انتخاب کنید.")
    output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}-images.zip"
    folder = clean_name(request.get("folder_name", ""), "") if request.get("folder_name") else ""
    prefix = f"{folder}/" if folder else ""
    target_format = request.get("image_format", "orig")
    project_id = state["id"]
    total = max(1, len(images))
    workers, _ = compute_worker_count(len(images), per_worker_mb=130, max_cap=8)

    logos_map = ((state.get("settings") or {}).get("watermarkLogos") or {})

    def _prepare_zip_item(_idx: int, item: dict[str, Any]) -> tuple[bytes, str]:
        data, extension, _, _ = image_payload(store, project_id, item, target_format, logos_map=logos_map)
        return data, extension

    with _atomic_export_path(output) as tmp_output:
        with zipfile.ZipFile(tmp_output, "w", compression=zipfile.ZIP_STORED) as archive:
            for idx, item, (data, extension) in iter_parallel_ordered(images, _prepare_zip_item, max_workers=workers):
                index = idx + 1
                archive.writestr(f"{prefix}{index:03d}-{clean_name(Path(item['name']).stem)}.{extension}", data)
                del data
                emit(f"افزودن تصویر {index} از {total} به بستهٔ ZIP", progress=index / total)
    return output


def _block_within_crop(block: dict[str, Any], crop: tuple[int, int, int, int] | None) -> bool:
    if not crop:
        return True
    cx0, cy0, cx1, cy1 = crop
    bx0 = float(block.get("tx0", block.get("x0", 0)) or 0)
    by0 = float(block.get("ty0", block.get("y0", 0)) or 0)
    bx1 = float(block.get("tx1", block.get("x1", bx0)) or bx0)
    by1 = float(block.get("ty1", block.get("y1", by0)) or by0)
    return (min(bx1, cx1) - max(bx0, cx0) > 1) and (min(by1, cy1) - max(by0, cy0) > 1)


def _ordered_export_blocks(item: dict[str, Any]) -> list[dict[str, Any]]:
    from .ocr_grouping import detect_page_mode, sort_document_reading_order

    crop = crop_box(item)
    enabled = [
        b
        for b in item.get("blocks", [])
        if b.get("enabled", True) is not False and _block_within_crop(b, crop)
    ]
    if len(enabled) < 2:
        return enabled
    w = int(item.get("width") or 0)
    h = int(item.get("height") or 0)
    page_size = (w, h) if w > 0 and h > 0 else None
    mode = item.get("pageMode") or detect_page_mode(enabled, page_size=page_size)
    if mode == "document":
        return sort_document_reading_order(enabled, page_size=page_size)
    return sorted(enabled, key=lambda block: (block.get("y0", 0), block.get("x0", 0)))


def build_txt(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    require_active_license()
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("برای خروجی هیچ تصویری انتخاب نشده است؛ حداقل یک تصویر را انتخاب کنید.")
    chunks = []
    total = max(1, len(images))
    for index, item in enumerate(images, start=1):
        check_cancelled("ساخت خروجی به درخواست کاربر لغو شد.")
        chunks.append(f"===== تصویر {index:03d} — {item['name']} =====\n")
        blocks = _ordered_export_blocks(item)
        if not blocks:
            chunks.append("(متنی تشخیص داده نشده است)\n")
        for b_idx, block in enumerate(blocks):
            role = str(block.get("pageRole") or "paragraph")
            base_indent = " " * (0 if role == "heading" else max(0, min(32, int(block.get("sourceIndent", 0) or 0))))
            first_extra = " " * (round(float(block.get("firstLineIndent") or 0) * 2) if role != "heading" else 0)
            hang_extra = " " * (round(float(block.get("hangingIndent") or 0) * 2) if role != "heading" else 0)
            ocr_text = _strip_inline_markers(_clean_text(block.get("text") or "")).strip("\r\n")
            tr_text = _block_translation_plain(block).strip("\r\n")
            if block.get("manual") is True and not ocr_text and tr_text:
                id_prefix = f"[{block.get('id', '-')}] "
                tr_lines = tr_text.split("\n")
                chunks.append(f"{id_prefix}(متن دستی): {tr_lines[0]}")
                for tln in tr_lines[1:]:
                    chunks.append(f"{' ' * len(id_prefix)}             {tln}")
                chunks[-1] = chunks[-1] + "\n"
                continue

            ocr_lines = ocr_text.split("\n") if ocr_text else [""]
            id_prefix = f"[{block.get('id', '-')}] "
            cont_pad = " " * len(id_prefix)

            if role == "heading":
                if b_idx > 0:
                    chunks.append("")
                first_ocr = f"{id_prefix}■ تیتر: {ocr_lines[0]}"
                ocr_formatted = [first_ocr] + [f"{cont_pad}        {ln}" for ln in ocr_lines[1:]]
                chunks.extend(ocr_formatted)
                rule_len = max(12, min(56, len(ocr_lines[0]) + 8))
                chunks.append(f"{cont_pad}{'─' * rule_len}")
                if tr_text.strip():
                    tr_lines = tr_text.split("\n")
                    chunks.append(f"    ← ■ {tr_lines[0]}")
                    for tln in tr_lines[1:]:
                        chunks.append(f"        {tln}")
                    chunks.append("")
                else:
                    chunks.append("    ← (بدون ترجمه)\n")
            else:
                first_ocr = f"{id_prefix}{base_indent}{first_extra}{ocr_lines[0]}"
                ocr_formatted = [first_ocr] + [f"{cont_pad}{base_indent}{hang_extra}{ln}" for ln in ocr_lines[1:]]
                chunks.extend(ocr_formatted)
                if tr_text.strip():
                    if base_indent or first_extra or hang_extra:
                        tr_lines = tr_text.split("\n")
                        chunks.append(f"    ← {base_indent}{first_extra}{tr_lines[0]}")
                        for tln in tr_lines[1:]:
                            chunks.append(f"      {base_indent}{hang_extra}{tln}")
                        chunks[-1] = chunks[-1] + "\n"
                    else:
                        chunks.append(f"    ← {tr_text}\n")
                else:
                    chunks.append("    ← (بدون ترجمه)\n")
        emit(f"نوشتن متن تصویر {index} از {total} در فایل TXT", progress=index / total)
    output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}.txt"
    with _atomic_export_path(output) as tmp_output:
        tmp_output.write_text("\ufeff" + "\n".join(chunks), encoding="utf-8")
    return output


_INVALID_XML_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
_RTL_CHAR_RE = re.compile(r"[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]")
_HEX_COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")
_RGB_COLOR_RE = re.compile(r"^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})")
_LEGACY_INLINE_MARKERS = (
    (re.compile(r"\*\*([\s\S]+?)\*\*"), r"\1"),
    (re.compile(r"__([\s\S]+?)__"), r"\1"),
    (re.compile(r"\*([^*\n]+?)\*"), r"\1"),
    (re.compile(r"\[size=\d{1,3}\]([\s\S]+?)\[/size\]"), r"\1"),
    (re.compile(r"\[color=#[0-9a-fA-F]{6}\]([\s\S]+?)\[/color\]"), r"\1"),
)

_DOCX_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_DOCX_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOCX_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Vazirmatn" w:eastAsia="Segoe UI"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:lang w:val="en-US" w:bidi="fa-IR"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="0" w:line="280" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>"""


def _clean_text(value: Any) -> str:
    return _INVALID_XML_RE.sub("", str(value or "")).replace("\r\n", "\n").replace("\r", "\n")


def _strip_inline_markers(text: str) -> str:
    cleaned = str(text or "")
    for pattern, repl in _LEGACY_INLINE_MARKERS:
        cleaned = pattern.sub(repl, cleaned)
    return cleaned


class _PlainHtmlExtractor(HTMLParser):
    """Extract clean plain text from bubble richHtml, preserving line breaks."""

    _BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "tr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in ("br", "hr"):
            self.parts.append("\n")
        elif t in self._BLOCK_TAGS and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self._BLOCK_TAGS and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if data:
            self.parts.append(data.replace("\xa0", " "))


def _plain_from_rich_html(html_text: Any) -> str:
    raw = _clean_text(html_text).strip()
    if not raw:
        return ""
    extractor = _PlainHtmlExtractor()
    extractor.feed(raw)
    extractor.close()
    return _strip_inline_markers("".join(extractor.parts)).rstrip("\n")


def _block_translation_plain(block: dict[str, Any]) -> str:
    tr_clean = _strip_inline_markers(_clean_text(block.get("tr") or "")).strip("\n")
    if tr_clean.strip():
        return tr_clean
    return _plain_from_rich_html(block.get("richHtml") or "").strip("\n")


def _effective_docx_block_mode(block: dict[str, Any], docx_mode: str) -> str:
    if bool(block.get("manual")):
        has_tr = bool(_block_translation_plain(block).strip())
        has_ocr = bool(_strip_inline_markers(_clean_text(block.get("text") or "")).strip())
        if docx_mode == "ocr":
            return "ocr" if has_ocr else ("translation" if has_tr else "ocr")
        if str(block.get("textMode") or "").lower() == "ocr":
            return "ocr" if has_ocr else ("translation" if has_tr else "ocr")
        return "translation" if has_tr else ("ocr" if has_ocr else "translation")
    if docx_mode == "ocr":
        return "ocr"
    return "ocr" if str(block.get("textMode") or "").lower() == "ocr" else "translation"


def _xml_attr(value: Any) -> str:
    return xml_escape(_clean_text(value).replace("\n", " "), {'"': "&quot;", "'": "&apos;"})


_ALLOWED_EXPORT_FONTS: dict[str, str] = {
    "vazirmatn": "Vazirmatn",
    "tahoma": "Tahoma",
    "segoe ui": "Segoe UI",
    "arial": "Arial",
    "arial black": "Arial Black",
    "times new roman": "Times New Roman",
    "georgia": "Georgia",
    "impact": "Impact",
    "comic sans ms": "Comic Sans MS",
    "courier new": "Courier New",
    "trebuchet ms": "Trebuchet MS",
    "verdana": "Verdana",
}


def _clean_font_family(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    primary = raw.split(",", 1)[0].strip().strip("\"'").strip()
    if not primary:
        return None
    mapped = _ALLOWED_EXPORT_FONTS.get(primary.lower())
    if mapped:
        return mapped
    if re.fullmatch(r"[A-Za-z0-9 \-_.]{1,64}", primary):
        return primary
    return None


_ALLOWED_BOX_SHAPES = frozenset({
    "rect", "ellipse", "pill", "cloud", "thought", "speech",
    "star", "burst", "seal", "diamond", "hexagon", "octagon", "heart", "banner",
})

_CLOUD_CUBIC_SEGMENTS: tuple[tuple[float, float, float, float, float, float], ...] = (
    (0.05, 0.18, 0.16, 0.05, 0.29, 0.14),
    (0.32, 0.01, 0.46, 0.00, 0.50, 0.11),
    (0.54, 0.00, 0.68, 0.01, 0.71, 0.14),
    (0.84, 0.05, 0.95, 0.18, 0.88, 0.34),
    (1.00, 0.39, 1.00, 0.61, 0.88, 0.66),
    (0.95, 0.82, 0.84, 0.95, 0.71, 0.86),
    (0.68, 0.99, 0.54, 1.00, 0.50, 0.89),
    (0.46, 1.00, 0.32, 0.99, 0.29, 0.86),
    (0.16, 0.95, 0.05, 0.82, 0.12, 0.66),
    (0.00, 0.61, 0.00, 0.39, 0.12, 0.34),
)

_HEART_CUBIC_SEGMENTS: tuple[tuple[float, float, float, float, float, float], ...] = (
    (0.58, 0.02, 0.96, 0.02, 0.99, 0.31),
    (0.99, 0.58, 0.74, 0.78, 0.50, 0.98),
    (0.26, 0.78, 0.01, 0.58, 0.01, 0.31),
    (0.04, 0.02, 0.42, 0.02, 0.50, 0.21),
)


def _normalize_box_shape(value: Any) -> str:
    s = str(value or "rect").strip().lower()
    return s if s in _ALLOWED_BOX_SHAPES else "rect"


def _normalize_corner_radius_pct(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n):
        return 0.0
    return max(0.0, min(100.0, n))


def _normalize_angle_deg(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n):
        return 0.0
    wrapped = ((n + 180.0) % 360.0) - 180.0
    return 0.0 if abs(wrapped) < 0.05 else round(wrapped, 2)


def _shape_insets_px(
    bw: float,
    bh: float,
    shape: str = "rect",
    corner_radius_pct: float = 0.0,
) -> tuple[float, float, float]:
    """Return `(pad_x, pad_top, pad_bottom)` in pixels matching `typeset.js:shapeInsets`."""
    base_x = _box_inset_px(bw)
    base_y = _box_inset_px(bh)
    sh = _normalize_box_shape(shape)
    cr = _normalize_corner_radius_pct(corner_radius_pct)
    if sh == "rect":
        if cr <= 0.0:
            return base_x, base_y, base_y
        r_px = (cr / 100.0) * (min(bw, bh) / 2.0)
        diag = r_px * 0.293
        return max(base_x, diag), max(base_y, diag), max(base_y, diag)
    if sh == "pill":
        r_px = min(bw, bh) / 2.0
        py = max(base_y, r_px * 0.16)
        return max(base_x, r_px * 0.32), py, py
    if sh == "ellipse":
        py = max(base_y, bh * 0.12)
        return max(base_x, bw * 0.12), py, py
    if sh == "cloud":
        py = max(base_y, bh * 0.15)
        return max(base_x, bw * 0.14), py, py
    if sh == "thought":
        return max(base_x, bw * 0.14), max(base_y, bh * 0.13), max(base_y, bh * 0.29)
    if sh == "speech":
        return max(base_x, bw * 0.10), max(base_y, bh * 0.10), max(base_y, bh * 0.24)
    if sh == "star":
        py = max(base_y, bh * 0.24)
        return max(base_x, bw * 0.23), py, py
    if sh in ("burst", "seal"):
        py = max(base_y, bh * 0.16)
        return max(base_x, bw * 0.16), py, py
    if sh == "diamond":
        py = max(base_y, bh * 0.18)
        return max(base_x, bw * 0.18), py, py
    if sh == "hexagon":
        py = max(base_y, bh * 0.08)
        return max(base_x, bw * 0.11), py, py
    if sh == "octagon":
        py = max(base_y, bh * 0.11)
        return max(base_x, bw * 0.11), py, py
    if sh == "heart":
        return max(base_x, bw * 0.19), max(base_y, bh * 0.20), max(base_y, bh * 0.27)
    if sh == "banner":
        return max(base_x, bw * 0.12), base_y, base_y
    return base_x, base_y, base_y


def _pptx_prst_geom_xml(shape: str, corner_radius_pct: float) -> str:
    if shape == "pill":
        return '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom>'
    prst_map = {
        "ellipse": "ellipse",
        "cloud": "cloud",
        "thought": "cloudCallout",
        "speech": "wedgeRoundRectCallout",
        "star": "star5",
        "burst": "star12",
        "seal": "star8",
        "diamond": "diamond",
        "hexagon": "hexagon",
        "octagon": "octagon",
        "heart": "heart",
        "banner": "ribbon2",
    }
    if shape in prst_map:
        return f'<a:prstGeom prst="{prst_map[shape]}"><a:avLst/></a:prstGeom>'
    if corner_radius_pct > 0.0:
        adj = max(0, min(50000, int(round(corner_radius_pct * 500.0))))
        return f'<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val {adj}"/></a:avLst></a:prstGeom>'
    return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'


def _star_polygon_points(n_points: int, inner_ratio: float, pw: float, ph: float) -> list[tuple[float, float]]:
    raw: list[tuple[float, float]] = []
    for idx in range(n_points * 2):
        ang = -math.pi / 2.0 + (idx * math.pi) / n_points
        rad = 0.5 if idx % 2 == 0 else 0.5 * inner_ratio
        raw.append((0.5 + rad * math.cos(ang), 0.5 + rad * math.sin(ang)))
    xs = [pt[0] for pt in raw]
    ys = [pt[1] for pt in raw]
    min_x, span_x = min(xs), max(1e-6, max(xs) - min(xs))
    min_y, span_y = min(ys), max(1e-6, max(ys) - min(ys))
    return [
        (((px - min_x) / span_x) * (pw - 1.0), ((py - min_y) / span_y) * (ph - 1.0))
        for px, py in raw
    ]


def _eval_cubic_contour(
    pw: float,
    ph: float,
    start_fx: float,
    start_fy: float,
    segments: tuple[tuple[float, float, float, float, float, float], ...],
    steps_per_seg: int = 12,
) -> list[tuple[float, float]]:
    cur_x = start_fx * (pw - 1.0)
    cur_y = start_fy * (ph - 1.0)
    pts: list[tuple[float, float]] = [(cur_x, cur_y)]
    for cx1, cy1, cx2, cy2, ex, ey in segments:
        p1x, p1y = cx1 * (pw - 1.0), cy1 * (ph - 1.0)
        p2x, p2y = cx2 * (pw - 1.0), cy2 * (ph - 1.0)
        p3x, p3y = ex * (pw - 1.0), ey * (ph - 1.0)
        for step in range(1, steps_per_seg + 1):
            t = step / steps_per_seg
            mt = 1.0 - t
            bx = (mt ** 3) * cur_x + 3.0 * (mt ** 2) * t * p1x + 3.0 * mt * (t ** 2) * p2x + (t ** 3) * p3x
            by = (mt ** 3) * cur_y + 3.0 * (mt ** 2) * t * p1y + 3.0 * mt * (t ** 2) * p2y + (t ** 3) * p3y
            pts.append((bx, by))
        cur_x, cur_y = p3x, p3y
    return pts


def _draw_shaped_box_pil(
    canvas: Image.Image,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    fill_rgb: tuple[int, int, int],
    *,
    shape: str = "rect",
    corner_radius_pct: float = 0.0,
    angle_deg: float = 0.0,
) -> None:
    ix0, iy0 = int(round(x0)), int(round(y0))
    ix1, iy1 = int(round(x1)), int(round(y1))
    bw = max(1, ix1 - ix0)
    bh = max(1, iy1 - iy0)
    if shape == "rect" and corner_radius_pct <= 0.0 and abs(angle_deg) <= 0.05:
        ImageDraw.Draw(canvas).rectangle([ix0, iy0, max(ix0, ix1 - 1), max(iy0, iy1 - 1)], fill=fill_rgb)
        return
    ss = 2
    pw, ph = max(2, bw * ss), max(2, bh * ss)
    mask = Image.new("L", (pw, ph), 0)
    mdraw = ImageDraw.Draw(mask)
    if shape == "ellipse":
        mdraw.ellipse([0, 0, pw - 1, ph - 1], fill=255)
    elif shape == "pill":
        rad = max(1, min(pw, ph) // 2)
        mdraw.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=rad, fill=255)
    elif shape == "star":
        mdraw.polygon(_star_polygon_points(5, 0.52, float(pw), float(ph)), fill=255)
    elif shape == "burst":
        mdraw.polygon(_star_polygon_points(12, 0.76, float(pw), float(ph)), fill=255)
    elif shape == "seal":
        mdraw.polygon(_star_polygon_points(8, 0.74, float(pw), float(ph)), fill=255)
    elif shape == "diamond":
        mdraw.polygon([(pw / 2.0, 0.0), (pw - 1.0, ph / 2.0), (pw / 2.0, ph - 1.0), (0.0, ph / 2.0)], fill=255)
    elif shape == "hexagon":
        cut = pw * 0.18
        mdraw.polygon(
            [(cut, 0.0), (pw - 1.0 - cut, 0.0), (pw - 1.0, ph / 2.0), (pw - 1.0 - cut, ph - 1.0), (cut, ph - 1.0), (0.0, ph / 2.0)],
            fill=255,
        )
    elif shape == "octagon":
        dx, dy = pw * 0.22, ph * 0.22
        mdraw.polygon(
            [
                (dx, 0.0), (pw - 1.0 - dx, 0.0), (pw - 1.0, dy), (pw - 1.0, ph - 1.0 - dy),
                (pw - 1.0 - dx, ph - 1.0), (dx, ph - 1.0), (0.0, ph - 1.0 - dy), (0.0, dy),
            ],
            fill=255,
        )
    elif shape == "banner":
        dx = pw * 0.10
        mdraw.polygon(
            [(0.0, 0.0), (pw - 1.0, 0.0), (pw - 1.0 - dx, ph / 2.0), (pw - 1.0, ph - 1.0), (0.0, ph - 1.0), (dx, ph / 2.0)],
            fill=255,
        )
    elif shape in ("cloud", "thought"):
        body_h = ph * 0.82 if shape == "thought" else float(ph)
        mdraw.polygon(_eval_cubic_contour(float(pw), body_h, 0.12, 0.34, _CLOUD_CUBIC_SEGMENTS), fill=255)
        if shape == "thought":
            b1cx, b1cy, b1rx, b1ry = pw * 0.27, ph * 0.885, max(1.0, pw * 0.055), max(1.0, ph * 0.042)
            mdraw.ellipse([b1cx - b1rx, b1cy - b1ry, b1cx + b1rx, b1cy + b1ry], fill=255)
            b2cx, b2cy, b2rx, b2ry = pw * 0.18, ph * 0.960, max(1.0, pw * 0.034), max(1.0, ph * 0.028)
            mdraw.ellipse([b2cx - b2rx, b2cy - b2ry, b2cx + b2rx, b2cy + b2ry], fill=255)
    elif shape == "speech":
        body_h = max(2, int(round(ph * 0.82)))
        rad = max(1, int(round(min(pw / 2.0, body_h / 2.0, min(pw, body_h) * 0.28))))
        mdraw.rounded_rectangle([0, 0, pw - 1, body_h - 1], radius=rad, fill=255)
        tail_l = max(float(rad), pw * 0.26)
        tail_r = min(float(pw - 1 - rad), max(tail_l + 4.0, pw * 0.42))
        mdraw.polygon(
            [(tail_l, body_h - 2.0), (tail_r, body_h - 2.0), (pw * 0.22, ph * 0.99)],
            fill=255,
        )
    elif shape == "heart":
        mdraw.polygon(_eval_cubic_contour(float(pw), float(ph), 0.50, 0.21, _HEART_CUBIC_SEGMENTS), fill=255)
    else:
        rad = max(0, int(round((corner_radius_pct / 100.0) * (min(pw, ph) / 2.0))))
        if rad > 0:
            mdraw.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=rad, fill=255)
        else:
            mdraw.rectangle([0, 0, pw - 1, ph - 1], fill=255)
    mask_1x = mask.resize((bw, bh), Image.Resampling.LANCZOS)
    mask.close()
    patch = Image.new("RGBA", (bw, bh), (*fill_rgb, 0))
    patch.putalpha(mask_1x)
    mask_1x.close()
    if abs(angle_deg) > 0.05:
        rotated = patch.rotate(-angle_deg, resample=Image.Resampling.BICUBIC, expand=True)
        patch.close()
        patch = rotated
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    px = int(round(cx - patch.width / 2.0))
    py = int(round(cy - patch.height / 2.0))
    rgb_patch = patch.convert("RGB")
    alpha_patch = patch.getchannel("A")
    canvas.paste(rgb_patch, (px, py), alpha_patch)
    rgb_patch.close()
    alpha_patch.close()
    patch.close()


def _parse_css_color(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    m_hex = _HEX_COLOR_RE.match(raw)
    if m_hex:
        return m_hex.group(1).upper()
    if re.match(r"^#[0-9a-fA-F]{3}$", raw):
        return "".join(ch * 2 for ch in raw[1:]).upper()
    m_rgb = _RGB_COLOR_RE.match(raw)
    if m_rgb:
        r, g, b = (max(0, min(255, int(part))) for part in m_rgb.groups())
        return f"{r:02X}{g:02X}{b:02X}"
    return None


def _parse_inline_style(style_attr: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk in (style_attr or "").split(";"):
        if ":" not in chunk:
            continue
        k, v = chunk.split(":", 1)
        k = k.strip().lower()
        v = v.strip()
        if k and v:
            out[k] = v
    return out


class _RichHtmlToDocxParser(HTMLParser):
    """Parse sanitized bubble richHtml into Word paragraph & run descriptors."""

    _BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre"}

    def __init__(self, base_style: dict[str, Any]) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base_style
        self.paragraphs: list[dict[str, Any]] = []
        self._stack: list[dict[str, Any]] = [dict(base_style)]
        self._cur_para: dict[str, Any] | None = None

    def _ensure_para(self, align: str | None = None, rtl: bool | None = None) -> dict[str, Any]:
        if self._cur_para is None:
            top = self._stack[-1]
            self._cur_para = {
                "align": align or top["align"],
                "rtl": top["rtl"] if rtl is None else rtl,
                "runs": [],
            }
            self.paragraphs.append(self._cur_para)
        else:
            if align:
                self._cur_para["align"] = align
            if rtl is not None:
                self._cur_para["rtl"] = rtl
        return self._cur_para

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t == "br":
            para = self._ensure_para()
            para["runs"].append({"br": True, **self._stack[-1]})
            return
        if t == "hr":
            self._cur_para = None
            return
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        css = _parse_inline_style(attr_map.get("style", ""))
        cur = dict(self._stack[-1])
        if t in ("b", "strong") or css.get("font-weight", "") in ("bold", "700", "800", "900"):
            cur["bold"] = True
        elif css.get("font-weight", "") in ("normal", "400"):
            cur["bold"] = False
        if t in ("i", "em") or css.get("font-style") == "italic":
            cur["italic"] = True
        elif css.get("font-style") == "normal":
            cur["italic"] = False
        deco = css.get("text-decoration", "") + " " + css.get("text-decoration-line", "")
        if t == "u" or "underline" in deco:
            cur["underline"] = True
        if t in ("s", "strike", "del") or "line-through" in deco:
            cur["strike"] = True
        col = _parse_css_color(css.get("color") or attr_map.get("color"))
        if col:
            cur["color"] = col
        ff = _clean_font_family(css.get("font-family") or attr_map.get("data-font") or attr_map.get("face"))
        if ff:
            cur["font_family"] = ff
        fs_match = re.match(r"^(\d+(?:\.\d+)?)px$", css.get("font-size", ""))
        if fs_match:
            cur["px_size"] = max(8.0, min(160.0, float(fs_match.group(1))))
        dir_val = (css.get("direction") or attr_map.get("dir") or "").lower()
        if dir_val in ("rtl", "ltr"):
            cur["rtl"] = dir_val == "rtl"
        align_val = (css.get("text-align") or attr_map.get("align") or "").lower()
        if align_val in ("right", "left", "center", "justify"):
            cur["align"] = align_val
        self._stack.append(cur)
        if t in self._BLOCK_TAGS:
            if self._cur_para is not None and self._cur_para["runs"]:
                self._cur_para = None
            self._ensure_para(align=cur["align"], rtl=cur["rtl"])

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if len(self._stack) > 1:
            self._stack.pop()
        if t in self._BLOCK_TAGS:
            self._cur_para = None

    def handle_data(self, data: str) -> None:
        cleaned = _clean_text(data)
        if not cleaned:
            return
        parts = cleaned.split("\n")
        for idx, part in enumerate(parts):
            if idx > 0:
                self._ensure_para()["runs"].append({"br": True, **self._stack[-1]})
            if part:
                self._ensure_para()["runs"].append({"text": part, **self._stack[-1]})


def _word_jc(align: str, rtl: bool) -> str:
    if align == "justify":
        return "both"
    if align in ("left", "center", "right"):
        return align
    return "right" if rtl else "left"


def _sample_box_bg(image: Image.Image, x0: int, y0: int, x1: int, y1: int) -> tuple[int, int, int]:
    """Sample bubble border pixels to match Typeset.sampleBg clean background fill."""
    w, h = image.size
    bx0, by0 = max(0, min(w - 1, x0)), max(0, min(h - 1, y0))
    bx1, by1 = max(bx0 + 1, min(w, x1)), max(by0 + 1, min(h, y1))
    samples: list[tuple[int, int, int]] = []
    ring = max(1, min(4, (bx1 - bx0) // 6, (by1 - by0) // 6))
    px = image.load()
    step_x = max(1, (bx1 - bx0) // 24)
    step_y = max(1, (by1 - by0) // 24)
    for x in range(bx0, bx1, step_x):
        for dy in range(ring):
            if by0 + dy < h:
                samples.append(px[x, by0 + dy][:3])
            if by1 - 1 - dy >= 0:
                samples.append(px[x, by1 - 1 - dy][:3])
    for y in range(by0, by1, step_y):
        for dx in range(ring):
            if bx0 + dx < w:
                samples.append(px[bx0 + dx, y][:3])
            if bx1 - 1 - dx >= 0:
                samples.append(px[bx1 - 1 - dx, y][:3])
    if not samples:
        return (255, 255, 255)
    rs = sorted(c[0] for c in samples)
    gs = sorted(c[1] for c in samples)
    bs = sorted(c[2] for c in samples)
    mid = len(samples) // 2
    return (rs[mid], gs[mid], bs[mid])


def _box_inset_px(dim: float) -> float:
    return min(4.0, max(0.0, float(dim) * 0.02))


def _estimate_fit_px(text: str, bw: float, bh: float, line_h: float | None = None) -> float:
    """Estimate auto-fit pixel font size inside (bw, bh) when block['size'] is unset."""
    ix = _box_inset_px(bw)
    iy = _box_inset_px(bh)
    usable_w = max(16.0, bw - 2.0 * ix)
    usable_h = max(14.0, bh - 2.0 * iy)
    raw_lines = [ln for ln in _clean_text(text).split("\n")] or [""]
    lh_cap = max(12, min(64, round(float(line_h) * 1.1))) if line_h and float(line_h) > 0 else 44
    top_sz = min(lh_cap, 44, max(8, int(usable_h * 0.72)))
    for sz in range(top_sz, 6, -1):
        char_w = sz * 0.54
        chars_per_line = max(1.0, usable_w / max(1.0, char_w))
        wrapped = sum(max(1, math.ceil(len(ln) / chars_per_line)) for ln in raw_lines)
        if wrapped * (sz * 1.52) <= usable_h:
            return float(sz)
    return 7.0


def _block_box(block: dict[str, Any], offset_x: float, offset_y: float, scale: float, max_w: int, max_h: int) -> tuple[float, float, float, float]:
    rx0 = float(block.get("tx0", block.get("x0", 0)) or 0) - offset_x
    ry0 = float(block.get("ty0", block.get("y0", 0)) or 0) - offset_y
    rx1 = float(block.get("tx1", block.get("x1", rx0 + 20)) or 0) - offset_x
    ry1 = float(block.get("ty1", block.get("y1", ry0 + 20)) or 0) - offset_y
    x0 = max(0.0, min(float(max_w), min(rx0, rx1) * scale))
    y0 = max(0.0, min(float(max_h), min(ry0, ry1) * scale))
    x1 = max(x0, min(float(max_w), max(rx0, rx1) * scale))
    y1 = max(y0, min(float(max_h), max(ry0, ry1) * scale))
    return x0, y0, x1, y1


def _build_textbox_paragraphs_xml(
    block: dict[str, Any], *, docx_mode: str, bw_px: float, bh_px: float,
    scale_pt: float, bg_rgb: tuple[int, int, int] | None,
) -> str:
    if docx_mode == "ocr":
        plain = _strip_inline_markers(_clean_text(block.get("text") or "")).strip("\n")
        rich_html = ""
        rtl_default = bool(_RTL_CHAR_RE.search(plain))
        raw_align = str(block.get("align") or "")
        if not rtl_default and raw_align == "right" and str(block.get("textMode") or "").lower() == "ocr":
            align_default = "left"
        else:
            align_default = raw_align or ("right" if rtl_default else "left")
        bold_default = True if block.get("pageRole") == "heading" else (block.get("bold") is not False)
    else:
        plain = _block_translation_plain(block)
        rich_html = _clean_text(block.get("richHtml") or "").strip()
        dir_field = str(block.get("dir") or "").lower()
        rtl_default = (dir_field == "rtl") if dir_field in ("rtl", "ltr") else (True if not plain else bool(_RTL_CHAR_RE.search(plain) or not re.search(r"[A-Za-z]", plain)))
        align_default = str(block.get("align") or ("justify" if rtl_default else "left"))
        bold_default = True if block.get("pageRole") == "heading" else (block.get("bold") is not False)

    raw_line_h = block.get("lineH")
    line_h_val: float | None = None
    try:
        if raw_line_h is not None and float(raw_line_h) > 0:
            line_h_val = float(raw_line_h)
    except (TypeError, ValueError):
        line_h_val = None

    raw_size = block.get("size")
    try:
        base_px = float(raw_size) if raw_size is not None and float(raw_size) > 0 else _estimate_fit_px(plain, bw_px, bh_px, line_h=line_h_val)
    except (TypeError, ValueError):
        base_px = _estimate_fit_px(plain, bw_px, bh_px, line_h=line_h_val)

    explicit_color = _parse_css_color(block.get("color"))
    if explicit_color:
        default_color = explicit_color
    elif bg_rgb is not None and (0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]) < 115:
        default_color = "FFFFFF"
    else:
        default_color = "141414"

    base_style = {
        "bold": bold_default,
        "italic": bool(block.get("italic")),
        "underline": bool(block.get("underline")),
        "strike": False,
        "color": default_color,
        "font_family": _clean_font_family(block.get("fontFamily")),
        "px_size": base_px,
        "rtl": rtl_default,
        "align": align_default,
    }

    if rich_html and docx_mode != "ocr":
        parser = _RichHtmlToDocxParser(base_style)
        parser.feed(rich_html)
        parser.close()
        paragraphs = [p for p in parser.paragraphs if p["runs"]]
    else:
        paragraphs = []

    if not paragraphs:
        lines = plain.split("\n") if plain else [""]
        paragraphs = [{
            "align": align_default,
            "rtl": rtl_default,
            "runs": [
                entry
                for idx, line in enumerate(lines)
                for entry in (([{"br": True, **base_style}] if idx > 0 else []) + ([{"text": line, **base_style}] if line else []))
            ],
        }]

    first_ind_em = float(block.get("firstLineIndent") or 0.0) if block.get("pageRole") != "heading" else 0.0
    hang_ind_em = float(block.get("hangingIndent") or 0.0) if block.get("pageRole") != "heading" else 0.0
    box_ind_xml = ""
    if hang_ind_em >= 0.5:
        h_dxa = max(140, min(1080, round(hang_ind_em * 200)))
        box_ind_xml = f'<w:ind w:left="{h_dxa}" w:hanging="{h_dxa}"/>'
    elif first_ind_em >= 0.5:
        f_dxa = max(140, min(1080, round(first_ind_em * 200)))
        box_ind_xml = f'<w:ind w:firstLine="{f_dxa}"/>'

    p_xml_list: list[str] = []
    for para in paragraphs:
        p_rtl = bool(para["rtl"])
        jc = _word_jc(str(para["align"]), p_rtl)
        ppr = (
            f'<w:bidi w:val="{"1" if p_rtl else "0"}"/>'
            f'<w:jc w:val="{jc}"/>'
            f"{box_ind_xml}"
            '<w:spacing w:before="0" w:after="20" w:line="276" w:lineRule="auto"/>'
        )
        r_xml_list: list[str] = []
        for run in para["runs"]:
            pt_size = max(5.5, min(72.0, float(run["px_size"]) * scale_pt * 0.78))
            half_pt = max(11, min(144, round(pt_size * 2)))
            rpr: list[str] = []
            run_ff = _clean_font_family(run.get("font_family"))
            if run_ff:
                safe_ff = _xml_attr(run_ff)
                rpr.append(f'<w:rFonts w:ascii="{safe_ff}" w:hAnsi="{safe_ff}" w:cs="{safe_ff}" w:eastAsia="{safe_ff}"/>')
            if run.get("bold"):
                rpr.append("<w:b/><w:bCs/>")
            if run.get("italic"):
                rpr.append("<w:i/><w:iCs/>")
            if run.get("strike"):
                rpr.append("<w:strike/>")
            if run.get("color"):
                rpr.append(f'<w:color w:val="{run["color"]}"/>')
            rpr.append(f'<w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/>')
            if run.get("underline"):
                rpr.append('<w:u w:val="single"/>')
            if run.get("rtl"):
                rpr.append("<w:rtl/>")
            rpr_xml = f"<w:rPr>{''.join(rpr)}</w:rPr>"
            if run.get("br"):
                r_xml_list.append(f"<w:r>{rpr_xml}<w:br/></w:r>")
            else:
                r_xml_list.append(f'<w:r>{rpr_xml}<w:t xml:space="preserve">{xml_escape(str(run.get("text") or ""))}</w:t></w:r>')
        p_xml_list.append(f"<w:p><w:pPr>{ppr}</w:pPr>{''.join(r_xml_list)}</w:p>")
    return "".join(p_xml_list)


def _prepare_docx_pages(
    store: ProjectStore,
    project_id: str,
    images: list[dict[str, Any]],
    docx_mode: str,
    *,
    target_label: str = "فایل Word",
    spool_dir: Path | None = None,
    project_settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build per-page cleaned background images and scaled block specs (supporting page groups).

    Groups metadata BEFORE decoding bitmaps and processes units across CPU cores with bounded
    concurrency. When `spool_dir` is given, rendered PNGs are spooled to disk instead of held
    simultaneously in RAM.
    """
    by_group: dict[str, list[dict[str, Any]]] = {}
    for item in images:
        gid = str(item["groupId"]).strip() if item.get("groupId") is not None else ""
        if gid:
            by_group.setdefault(gid, []).append(item)

    grouped_units: list[list[dict[str, Any]]] = []
    consumed: set[str] = set()
    for item in images:
        gid = str(item["groupId"]).strip() if item.get("groupId") is not None else ""
        members = by_group.get(gid)
        if not gid or not members or len(members) < 2:
            grouped_units.append([item])
            continue
        if gid in consumed:
            continue
        consumed.add(gid)
        grouped_units.append(members)

    total_units = max(1, len(grouped_units))
    workers, _ = compute_worker_count(len(grouped_units), per_worker_mb=180, max_cap=8)
    settings_dict = project_settings if isinstance(project_settings, dict) else {}
    erase_original = settings_dict.get("eraseOriginal", True) is not False
    watermark_logos = settings_dict.get("watermarkLogos") if isinstance(settings_dict.get("watermarkLogos"), dict) else {}

    def _render_unit(unit_zero_idx: int, item_members: list[dict[str, Any]]) -> dict[str, Any]:
        page_idx = unit_zero_idx + 1
        loaded_members: list[dict[str, Any]] = []
        canvas: Image.Image | None = None
        try:
            for item in item_members:
                source_path = project_root(project_id) / "images" / item["file"]
                with Image.open(source_path) as opened:
                    im = opened.convert("RGB")
                crop = crop_box(item)
                off_x, off_y = (float(crop[0]), float(crop[1])) if crop else (0.0, 0.0)
                if crop:
                    cropped = im.crop(crop)
                    im.close()
                    im = cropped
                if has_active_watermark(item.get("watermark")):
                    wm_im = apply_watermark_pil(im, item.get("watermark"), watermark_logos)
                    if wm_im is not im:
                        im.close()
                        im = wm_im
                loaded_members.append({
                    "image": im,
                    "w": im.width,
                    "h": im.height,
                    "item": item,
                    "off_x": off_x,
                    "off_y": off_y,
                })

            common_w = max(m["w"] for m in loaded_members)
            raw_h = sum(m["h"] * common_w / max(1, m["w"]) for m in loaded_members)
            comp_scale = min(
                1.0,
                16000.0 / max(common_w, 1),
                16000.0 / max(raw_h, 1),
                math.sqrt(180_000_000.0 / max(common_w * raw_h, 1)),
            )
            canvas_w = max(1, round(common_w * comp_scale))
            member_heights = [max(1, round(m["h"] * (common_w / max(1, m["w"])) * comp_scale)) for m in loaded_members]
            canvas = Image.new("RGB", (canvas_w, sum(member_heights)), "white")
            page_blocks: list[dict[str, Any]] = []
            source_erase_rects: list[tuple[int, int, int, int]] = []
            y_cursor = 0
            for m, mh in zip(loaded_members, member_heights):
                m_scale = (common_w / max(1, m["w"])) * comp_scale
                part = m["image"]
                if part.size != (canvas_w, mh):
                    resized = part.resize((canvas_w, mh), Image.Resampling.LANCZOS)
                    try:
                        canvas.paste(resized, (0, y_cursor))
                    finally:
                        resized.close()
                else:
                    canvas.paste(part, (0, y_cursor))
                part.close()
                m["image"] = None
                sorted_blocks = sorted(
                    m["item"].get("blocks", []),
                    key=lambda b: (b.get("ty0", b.get("y0", 0)), b.get("tx0", b.get("x0", 0))),
                )
                for blk in sorted_blocks:
                    if blk.get("enabled", True) is False:
                        continue
                    eff_mode = _effective_docx_block_mode(blk, docx_mode)
                    if eff_mode == "ocr":
                        has_text = bool(_strip_inline_markers(_clean_text(blk.get("text") or "")).strip())
                    else:
                        has_text = bool(_block_translation_plain(blk).strip())
                    blk_shape = _normalize_box_shape(blk.get("shape"))
                    blk_radius_pct = _normalize_corner_radius_pct(blk.get("cornerRadius"))
                    blk_angle_deg = _normalize_angle_deg(blk.get("angle"))
                    blk_bg_raw = str(blk.get("bg") or "")
                    has_manual_shape_bg = bool(
                        blk.get("manual")
                        and blk_bg_raw
                        and blk_bg_raw != "none"
                        and (blk_shape != "rect" or blk_radius_pct > 0.0)
                    )
                    if not has_text and not has_manual_shape_bg:
                        continue
                    bx0, by0, bx1, by1 = _block_box(blk, m["off_x"], m["off_y"], m_scale, canvas_w, mh)
                    if bx1 - bx0 < 2 or by1 - by0 < 2:
                        continue
                    needs_uncovered_erase = (
                        blk_shape != "rect" or blk_radius_pct > 0.0 or abs(blk_angle_deg) > 0.05
                    )
                    if erase_original and not blk.get("manual") and str(blk.get("bg") or "auto") != "none":
                        srx0 = float(blk.get("x0", 0) or 0) - m["off_x"]
                        sry0 = float(blk.get("y0", 0) or 0) - m["off_y"]
                        srx1 = float(blk.get("x1", 0) or 0) - m["off_x"]
                        sry1 = float(blk.get("y1", 0) or 0) - m["off_y"]
                        sx0 = max(0.0, min(float(canvas_w), min(srx0, srx1) * m_scale))
                        sy0 = max(0.0, min(float(mh), min(sry0, sry1) * m_scale))
                        sx1 = max(sx0, min(float(canvas_w), max(srx0, srx1) * m_scale))
                        sy1 = max(sy0, min(float(mh), max(sry0, sry1) * m_scale))
                        if sx1 - sx0 >= 2 and sy1 - sy0 >= 2 and (
                            needs_uncovered_erase
                            or abs(sx0 - bx0) > 1.0
                            or abs(sy0 - by0) > 1.0
                            or abs(sx1 - bx1) > 1.0
                            or abs(sy1 - by1) > 1.0
                        ):
                            source_erase_rects.append((
                                int(round(sx0)),
                                int(round(sy0 + y_cursor)),
                                int(round(sx1)),
                                int(round(sy1 + y_cursor)),
                            ))
                    page_blocks.append({
                        "block": blk,
                        "x0": bx0,
                        "y0": by0 + y_cursor,
                        "x1": bx1,
                        "y1": by1 + y_cursor,
                    })
                y_cursor += mh

            # Erase/fill bubble backgrounds first (matching Typeset.render source + targetFills) without baking raster text.
            draw = ImageDraw.Draw(canvas)
            for sx0_i, sy0_i, sx1_i, sy1_i in source_erase_rects:
                src_fill = _sample_box_bg(canvas, sx0_i, sy0_i, sx1_i, sy1_i)
                draw.rectangle([sx0_i, sy0_i, max(sx0_i, sx1_i - 1), max(sy0_i, sy1_i - 1)], fill=src_fill)
            for spec in page_blocks:
                blk_spec = spec["block"]
                bg_mode = str(blk_spec.get("bg") or "auto")
                ix0, iy0 = int(round(spec["x0"])), int(round(spec["y0"]))
                ix1, iy1 = int(round(spec["x1"])), int(round(spec["y1"]))
                if bg_mode == "none" or (not erase_original and bg_mode in {"", "auto"}):
                    spec["bg_rgb"] = _sample_box_bg(canvas, ix0, iy0, ix1, iy1)
                    continue
                custom_bg_hex = _parse_css_color(bg_mode) if bg_mode not in {"", "auto", "white", "black"} else None
                if bg_mode == "white":
                    fill_rgb = (255, 255, 255)
                elif bg_mode == "black":
                    fill_rgb = (16, 16, 16)
                elif custom_bg_hex:
                    fill_rgb = (
                        int(custom_bg_hex[0:2], 16),
                        int(custom_bg_hex[2:4], 16),
                        int(custom_bg_hex[4:6], 16),
                    )
                else:
                    fill_rgb = _sample_box_bg(canvas, ix0, iy0, ix1, iy1)
                spec["bg_rgb"] = fill_rgb
                _draw_shaped_box_pil(
                    canvas,
                    spec["x0"],
                    spec["y0"],
                    spec["x1"],
                    spec["y1"],
                    fill_rgb,
                    shape=_normalize_box_shape(blk_spec.get("shape")),
                    corner_radius_pct=_normalize_corner_radius_pct(blk_spec.get("cornerRadius")),
                    angle_deg=_normalize_angle_deg(blk_spec.get("angle")),
                )

            canvas_w_final, canvas_h_final = canvas.width, canvas.height
            if spool_dir is not None:
                png_path = spool_dir / f"page_{page_idx:04d}.png"
                canvas.save(png_path, "PNG")
                return {
                    "png_path": png_path,
                    "w": canvas_w_final,
                    "h": canvas_h_final,
                    "blocks": page_blocks,
                    "name": item_members[0].get("name", f"page-{page_idx}"),
                }
            buf = io.BytesIO()
            canvas.save(buf, "PNG")
            return {
                "png": buf.getvalue(),
                "w": canvas_w_final,
                "h": canvas_h_final,
                "blocks": page_blocks,
                "name": item_members[0].get("name", f"page-{page_idx}"),
            }
        finally:
            if canvas is not None:
                canvas.close()
            for m in loaded_members:
                if m.get("image") is not None:
                    m["image"].close()

    pages: list[dict[str, Any]] = []
    for idx, _members, page_dict in iter_parallel_ordered(grouped_units, _render_unit, max_workers=workers):
        page_idx = idx + 1
        pages.append(page_dict)
        emit(f"آماده‌سازی صفحهٔ {page_idx} از {total_units} برای {target_label}", progress=page_idx / total_units * 0.85)
    return pages


def _build_flowing_paragraphs_xml(block: dict[str, Any], *, docx_mode: str) -> str:
    role = str(block.get("pageRole") or "paragraph")
    if docx_mode == "ocr":
        plain = _strip_inline_markers(_clean_text(block.get("text") or "")).strip("\n")
        rich_html = ""
        rtl_default = bool(_RTL_CHAR_RE.search(plain))
        align_default = "justify" if role == "paragraph" and len(plain) >= 60 else ("right" if rtl_default else "left")
        bold_default = True if role == "heading" else (block.get("bold") is True)
    else:
        plain = _block_translation_plain(block)
        rich_html = _clean_text(block.get("richHtml") or "").strip()
        dir_field = str(block.get("dir") or "").lower()
        rtl_default = (dir_field == "rtl") if dir_field in ("rtl", "ltr") else (True if not plain else bool(_RTL_CHAR_RE.search(plain) or not re.search(r"[A-Za-z]", plain)))
        raw_align = str(block.get("align") or "")
        align_default = raw_align if raw_align in ("left", "right", "center", "justify") else ("right" if role == "heading" and rtl_default else ("left" if role == "heading" else "justify"))
        bold_default = True if role == "heading" else (block.get("bold") is True)

    raw_sz = float(block.get("size") or 0.0)
    raw_lh = float(block.get("lineH") or 0.0)
    if role == "heading":
        if raw_sz > 12.0:
            base_pt = max(14.5, min(28.0, round(raw_sz * 0.95, 1)))
        elif raw_lh > 0.0:
            base_pt = max(14.5, min(24.0, round(raw_lh * 0.62, 1)))
        else:
            base_pt = 15.5
    else:
        base_pt = max(9.0, min(32.0, raw_sz)) if (raw_sz > 0.0 and raw_sz != 12.0) else 12.0
    explicit_color = _parse_css_color(block.get("color")) or "141414"
    base_style = {
        "bold": bold_default,
        "italic": bool(block.get("italic")),
        "underline": bool(block.get("underline")),
        "strike": False,
        "color": explicit_color,
        "font_family": _clean_font_family(block.get("fontFamily")),
        "px_size": base_pt,
        "rtl": rtl_default,
        "align": align_default,
    }

    if rich_html and docx_mode != "ocr":
        parser = _RichHtmlToDocxParser(base_style)
        parser.feed(rich_html)
        parser.close()
        paragraphs = [p for p in parser.paragraphs if p["runs"]]
    else:
        paragraphs = []

    if not paragraphs:
        lines = plain.split("\n") if plain else [""]
        paragraphs = [{
            "align": align_default,
            "rtl": rtl_default,
            "runs": [
                entry
                for idx, line in enumerate(lines)
                for entry in (([{"br": True, **base_style}] if idx > 0 else []) + ([{"text": line, **base_style}] if line else []))
            ],
        }]

    block_ind_em = float(block.get("blockIndent") or 0.0)
    if block_ind_em <= 0.0 and role != "heading" and int(block.get("sourceIndent") or 0) > 0:
        block_ind_em = min(4.5, round(int(block.get("sourceIndent") or 0) * 0.35, 2))
    first_ind_em = float(block.get("firstLineIndent") or 0.0) if role != "heading" else 0.0
    hang_ind_em = float(block.get("hangingIndent") or 0.0) if role != "heading" else 0.0
    base_dxa = 360 if role == "list" else (max(0, min(2160, round(block_ind_em * 240))) if role != "heading" else 0)
    if hang_ind_em >= 0.5:
        hang_dxa = max(180, min(1440, round(hang_ind_em * 240)))
        ind_xml = f'<w:ind w:left="{base_dxa + hang_dxa}" w:hanging="{hang_dxa}"/>'
    elif first_ind_em >= 0.5:
        first_dxa = max(180, min(1440, round(first_ind_em * 240)))
        ind_xml = f'<w:ind w:left="{base_dxa}" w:firstLine="{first_dxa}"/>'
    elif role == "list":
        ind_xml = '<w:ind w:left="360" w:right="360"/>'
    elif base_dxa > 0:
        ind_xml = f'<w:ind w:left="{base_dxa}"/>'
    else:
        ind_xml = ""

    p_xml_list: list[str] = []
    for para in paragraphs:
        p_rtl = bool(para["rtl"])
        jc = _word_jc(str(para["align"]), p_rtl)
        before_dxa = "220" if role == "heading" else "0"
        after_dxa = "100" if role == "heading" else ("60" if role == "list" else "120")
        line_dxa = "280" if role == "heading" else "320"
        keep_next = "<w:keepNext/>" if role == "heading" else ""
        ppr = (
            f'<w:bidi w:val="{"1" if p_rtl else "0"}"/>'
            f'<w:jc w:val="{jc}"/>'
            f"{keep_next}{ind_xml}"
            f'<w:spacing w:before="{before_dxa}" w:after="{after_dxa}" w:line="{line_dxa}" w:lineRule="auto"/>'
        )
        r_xml_list: list[str] = []
        for run in para["runs"]:
            raw_run_sz = float(run.get("px_size") or base_pt)
            pt_size = max(8.0, min(48.0, raw_run_sz))
            half_pt = max(16, min(96, round(pt_size * 2)))
            rpr: list[str] = []
            run_ff = _clean_font_family(run.get("font_family"))
            if run_ff:
                safe_ff = _xml_attr(run_ff)
                rpr.append(f'<w:rFonts w:ascii="{safe_ff}" w:hAnsi="{safe_ff}" w:cs="{safe_ff}" w:eastAsia="{safe_ff}"/>')
            if run.get("bold"):
                rpr.append("<w:b/><w:bCs/>")
            if run.get("italic"):
                rpr.append("<w:i/><w:iCs/>")
            if run.get("strike"):
                rpr.append("<w:strike/>")
            if run.get("color"):
                rpr.append(f'<w:color w:val="{run["color"]}"/>')
            rpr.append(f'<w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/>')
            if run.get("underline"):
                rpr.append('<w:u w:val="single"/>')
            if run.get("rtl"):
                rpr.append("<w:rtl/>")
            rpr_xml = f"<w:rPr>{''.join(rpr)}</w:rPr>"
            if run.get("br"):
                r_xml_list.append(f"<w:r>{rpr_xml}<w:br/></w:r>")
            else:
                r_xml_list.append(f'<w:r>{rpr_xml}<w:t xml:space="preserve">{xml_escape(str(run.get("text") or ""))}</w:t></w:r>')
        p_xml_list.append(f"<w:p><w:pPr>{ppr}</w:pPr>{''.join(r_xml_list)}</w:p>")
    return "".join(p_xml_list)


def _build_flowing_docx(
    store: ProjectStore,
    state: dict[str, Any],
    images: list[dict[str, Any]],
    request: dict[str, Any],
    docx_mode: str,
) -> Path:
    """Build a clean, reflowable book/article Word (.docx) document without background images."""
    by_group: dict[str, list[dict[str, Any]]] = {}
    for item in images:
        gid = str(item.get("groupId") or "").strip()
        if gid:
            by_group.setdefault(gid, []).append(item)

    units: list[list[dict[str, Any]]] = []
    consumed: set[str] = set()
    for item in images:
        gid = str(item.get("groupId") or "").strip()
        members = by_group.get(gid)
        if not gid or not members or len(members) < 2:
            units.append([item])
            continue
        if gid in consumed:
            continue
        consumed.add(gid)
        units.append(members)

    seamless = bool(request.get("seamless"))
    page_xml_chunks: list[str] = []
    doc_has_rtl = False
    total_units = max(1, len(units))

    for unit_idx, members in enumerate(units, start=1):
        unit_paras: list[str] = []
        for item in members:
            crop = crop_box(item)
            ordered_blocks = _ordered_export_blocks(item)
            for blk in ordered_blocks:
                if crop:
                    cx0, cy0, cx1, cy1 = crop
                    bx0 = float(blk.get("tx0", blk.get("x0", 0)) or 0)
                    by0 = float(blk.get("ty0", blk.get("y0", 0)) or 0)
                    bx1 = float(blk.get("tx1", blk.get("x1", bx0)) or bx0)
                    by1 = float(blk.get("ty1", blk.get("y1", by0)) or by0)
                    if min(bx1, cx1) - max(bx0, cx0) <= 1 or min(by1, cy1) - max(by0, cy0) <= 1:
                        continue
                eff_mode = _effective_docx_block_mode(blk, docx_mode)
                if eff_mode == "ocr":
                    sample = _strip_inline_markers(_clean_text(blk.get("text") or "")).strip()
                else:
                    sample = _block_translation_plain(blk).strip()
                if not sample:
                    continue
                if _RTL_CHAR_RE.search(sample):
                    doc_has_rtl = True
                unit_paras.append(_build_flowing_paragraphs_xml(blk, docx_mode=eff_mode))
        if unit_paras:
            page_xml_chunks.append("".join(unit_paras))
        emit(
            f"چیدمان متن صفحهٔ {unit_idx} از {total_units} در سند Word کتابی",
            progress=unit_idx / total_units * 0.9,
        )

    if not page_xml_chunks:
        body_xml = "<w:p/>"
    elif seamless:
        body_xml = "".join(page_xml_chunks)
    else:
        page_break_xml = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
        body_xml = page_break_xml.join(page_xml_chunks)

    bidi_sect = "<w:bidi/>" if (doc_has_rtl or docx_mode == "translation") else ""
    sect_pr = (
        f"<w:sectPr>{bidi_sect}"
        '<w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
        "</w:sectPr>"
    )
    doc_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n'
        "</Relationships>"
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body_xml}{sect_pr}</w:body></w:document>"
    )
    emit("در حال بسته‌بندی فایل Word کتابی…", progress=0.96)
    output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}.docx"
    with _atomic_export_path(output) as tmp_output:
        with zipfile.ZipFile(tmp_output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES.encode("utf-8"))
            archive.writestr("_rels/.rels", _DOCX_ROOT_RELS.encode("utf-8"))
            archive.writestr("word/_rels/document.xml.rels", doc_rels_xml.encode("utf-8"))
            archive.writestr("word/styles.xml", _DOCX_STYLES.encode("utf-8"))
            archive.writestr("word/document.xml", document_xml.encode("utf-8"))
    return output


def build_docx(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    require_active_license()
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("برای خروجی هیچ تصویری انتخاب نشده است؛ حداقل یک تصویر را انتخاب کنید.")
    docx_mode = "ocr" if request.get("docx_mode") == "ocr" else "translation"
    if request.get("docx_layout") == "flowing":
        return _build_flowing_docx(store, state, images, request, docx_mode)
    with tempfile.TemporaryDirectory(prefix="comic-docx-") as spool_raw:
        pages = _prepare_docx_pages(
            store,
            state["id"],
            images,
            docx_mode,
            spool_dir=Path(spool_raw),
            project_settings=state.get("settings") or {},
        )
        return _finalize_visual_docx(state, request, docx_mode, pages)


def _finalize_visual_docx(
    state: dict[str, Any],
    request: dict[str, Any],
    docx_mode: str,
    pages: list[dict[str, Any]],
) -> Path:
    rel_entries = [
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    ]
    body_parts: list[str] = []
    final_sect_pr = ""
    shape_serial = 1

    for page_idx, page in enumerate(pages, start=1):
        check_cancelled("ساخت خروجی به درخواست کاربر لغو شد.")
        rel_id = f"rIdImg{page_idx}"
        media_name = f"media/page_{page_idx:03d}.png"
        rel_entries.append(
            f'  <Relationship Id="{rel_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{media_name}"/>'
        )
        img_w, img_h = max(1, page["w"]), max(1, page["h"])
        scale_pt = min(540.0 / img_w, 1500.0 / img_h)
        raw_w_pt = max(72.0, img_w * scale_pt)
        raw_h_pt = max(72.0, img_h * scale_pt)
        w_dxa = max(1440, min(31680, round(raw_w_pt * 20)))
        h_dxa = max(1440, min(31680, round(raw_h_pt * 20)))
        page_w_pt = w_dxa / 20.0
        page_h_pt = h_dxa / 20.0
        cx_emu = max(914400, round(page_w_pt * 12700))
        cy_emu = max(914400, round(page_h_pt * 12700))
        scale_x_pt = page_w_pt / img_w
        scale_y_pt = page_h_pt / img_h
        font_scale_pt = min(scale_x_pt, scale_y_pt)

        sect_pr = (
            f'<w:sectPr><w:bidi/>'
            f'<w:pgSz w:w="{w_dxa}" w:h="{h_dxa}"/>'
            '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>'
            "</w:sectPr>"
        )
        if page_idx == len(pages):
            final_sect_pr = sect_pr

        safe_page_name = _xml_attr(page.get("name") or f"page-{page_idx}")
        bg_drawing = (
            "<w:r><w:drawing>"
            '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" '
            'behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">'
            '<wp:simplePos x="0" y="0"/>'
            '<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>'
            '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>'
            f'<wp:extent cx="{cx_emu}" cy="{cy_emu}"/>'
            '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
            "<wp:wrapNone/>"
            f'<wp:docPr id="{page_idx}" name="{safe_page_name}"/>'
            "<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>"
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            "<pic:pic>"
            f'<pic:nvPicPr><pic:cNvPr id="{page_idx}" name="{safe_page_name}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx_emu}" cy="{cy_emu}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            "</pic:pic></a:graphicData></a:graphic>"
            "</wp:anchor></w:drawing></w:r>"
        )

        box_runs: list[str] = []
        for spec in page["blocks"]:
            blk = spec["block"]
            eff_mode = _effective_docx_block_mode(blk, docx_mode)
            bw_px = max(2.0, spec["x1"] - spec["x0"])
            bh_px = max(2.0, spec["y1"] - spec["y0"])
            left_pt = spec["x0"] * scale_x_pt
            top_pt = spec["y0"] * scale_y_pt
            bw_pt = max(8.0, bw_px * scale_x_pt)
            bh_pt = max(8.0, bh_px * scale_y_pt)
            blk_shape = _normalize_box_shape(blk.get("shape"))
            blk_radius_pct = _normalize_corner_radius_pct(blk.get("cornerRadius"))
            pad_x_px, pad_top_px, pad_bot_px = _shape_insets_px(bw_px, bh_px, blk_shape, blk_radius_pct)
            inset_x = pad_x_px * scale_x_pt
            inset_top = pad_top_px * scale_y_pt
            inset_bot = pad_bot_px * scale_y_pt
            eff_bw_px = max(2.0, (bw_pt - 2.0 * inset_x + 2.0 * _box_inset_px(bw_px) * scale_x_pt) / max(1e-6, font_scale_pt))
            eff_bh_px = max(2.0, (bh_pt - inset_top - inset_bot + 2.0 * _box_inset_px(bh_px) * scale_y_pt) / max(1e-6, font_scale_pt))
            valign = str(blk.get("verticalAlign") or ("middle" if eff_mode == "ocr" else "top"))
            v_anchor = valign if valign in ("top", "middle", "bottom") else ("middle" if eff_mode == "ocr" else "top")
            txbx_p = _build_textbox_paragraphs_xml(
                blk, docx_mode=eff_mode, bw_px=eff_bw_px, bh_px=eff_bh_px,
                scale_pt=font_scale_pt, bg_rgb=spec.get("bg_rgb"),
            )
            angle_deg = _normalize_angle_deg(blk.get("angle"))
            rot_css = f"rotation:{angle_deg:.2f};" if abs(angle_deg) > 0.05 else ""
            shape_style = (
                f"position:absolute;margin-left:{left_pt:.2f}pt;margin-top:{top_pt:.2f}pt;"
                f"width:{bw_pt:.2f}pt;height:{bh_pt:.2f}pt;{rot_css}z-index:{shape_serial + 10};"
                f"v-text-anchor:{v_anchor};mso-position-horizontal-relative:page;mso-position-vertical-relative:page"
            )
            inset_str = f"{inset_x:.2f}pt,{inset_top:.2f}pt,{inset_x:.2f}pt,{inset_bot:.2f}pt"
            box_runs.append(
                "<w:r><w:pict>"
                f'<v:shape id="comicbox_{shape_serial}" style="{shape_style}" filled="f" stroked="f">'
                f'<v:textbox inset="{inset_str}" style="mso-fit-shape-to-text:f">'
                f"<w:txbxContent>{txbx_p}</w:txbxContent>"
                "</v:textbox></v:shape>"
                "</w:pict></w:r>"
            )
            shape_serial += 1

        p_sect = sect_pr if page_idx < len(pages) else ""
        body_parts.append(
            f'<w:p><w:pPr><w:bidi/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>{p_sect}</w:pPr>'
            f"{bg_drawing}{''.join(box_runs)}</w:p>"
        )

    doc_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        + "\n".join(rel_entries)
        + "\n</Relationships>"
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document '
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
        'xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:o="urn:schemas-microsoft-com:office:office">'
        "<w:body>"
        + "".join(body_parts)
        + final_sect_pr
        + "</w:body></w:document>"
    )
    emit("در حال بسته‌بندی فایل Word…", progress=0.95)
    output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}.docx"
    with _atomic_export_path(output) as tmp_output:
        with zipfile.ZipFile(tmp_output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES.encode("utf-8"))
            archive.writestr("_rels/.rels", _DOCX_ROOT_RELS.encode("utf-8"))
            archive.writestr("word/_rels/document.xml.rels", doc_rels_xml.encode("utf-8"))
            archive.writestr("word/styles.xml", _DOCX_STYLES.encode("utf-8"))
            for page_idx, page in enumerate(pages, start=1):
                arc_media = f"word/media/page_{page_idx:03d}.png"
                if page.get("png_path"):
                    archive.write(page["png_path"], arc_media, compress_type=zipfile.ZIP_STORED)
                else:
                    archive.writestr(arc_media, page["png"], compress_type=zipfile.ZIP_STORED)
            archive.writestr("word/document.xml", document_xml.encode("utf-8"))
    return output


# ==================== PowerPoint (PPTX / PresentationML) Export ====================

_PPTX_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

_PPTX_PRES_PROPS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>"""

_PPTX_VIEW_PROPS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>
  <p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:cSldViewPr></p:slideViewPr>
</p:viewPr>"""

_PPTX_TABLE_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>"""

_PPTX_THEME = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Comic OCR Studio Theme">
  <a:themeElements>
    <a:clrScheme name="Studio">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1E293B"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="4F46E5"/></a:accent1>
      <a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
      <a:accent5><a:srgbClr val="EC4899"/></a:accent5>
      <a:accent6><a:srgbClr val="8B5CF6"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="StudioFonts">
      <a:majorFont>
        <a:latin typeface="Segoe UI"/>
        <a:ea typeface="Segoe UI"/>
        <a:cs typeface="Vazirmatn"/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Segoe UI"/>
        <a:ea typeface="Segoe UI"/>
        <a:cs typeface="Vazirmatn"/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="StudioFmt">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="28575" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>"""

_PPTX_SLIDE_MASTER = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="r"><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr algn="r"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr><a:defRPr sz="1400"/></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>"""

_PPTX_SLIDE_MASTER_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"""

_PPTX_SLIDE_LAYOUT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"""

_PPTX_SLIDE_LAYOUT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"""


def _pptx_algn(align: str, rtl: bool) -> str:
    if align == "justify":
        return "just"
    if align == "center":
        return "ctr"
    if align == "left":
        return "l"
    if align == "right":
        return "r"
    return "r" if rtl else "l"


def _pptx_anchor(valign: str) -> str:
    if valign == "middle":
        return "ctr"
    if valign == "bottom":
        return "b"
    return "t"


def _pptx_rpr_xml(run: dict[str, Any], pt_size: float) -> str:
    hundredths_pt = max(500, min(9600, round(pt_size * 100)))
    lang = "fa-IR" if run.get("rtl") else "en-US"
    attrs = [f'lang="{lang}"', f'sz="{hundredths_pt}"', 'dirty="0"']
    if run.get("bold"):
        attrs.append('b="1"')
    if run.get("italic"):
        attrs.append('i="1"')
    if run.get("underline"):
        attrs.append('u="sng"')
    if run.get("strike"):
        attrs.append('strike="sngStrike"')
    color = str(run.get("color") or "141414").upper()
    if not re.fullmatch(r"[0-9A-F]{6}", color):
        color = "141414"
    run_ff = _clean_font_family(run.get("font_family"))
    latin_ff = _xml_attr(run_ff) if run_ff else "Segoe UI"
    cs_ff = _xml_attr(run_ff) if run_ff else "Vazirmatn"
    # Strictly follow ECMA-376 CT_TextCharacterProperties sequence: fill BEFORE font elements!
    return (
        f'<a:rPr {" ".join(attrs)}>'
        f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
        f'<a:latin typeface="{latin_ff}"/>'
        f'<a:ea typeface="{latin_ff}"/>'
        f'<a:cs typeface="{cs_ff}"/>'
        "</a:rPr>"
    )


def _build_pptx_textbox_paragraphs_xml(
    block: dict[str, Any],
    *,
    pptx_mode: str,
    bw_px: float,
    bh_px: float,
    scale_pt: float,
    bg_rgb: tuple[int, int, int] | None,
) -> tuple[str, bool]:
    """Return DrawingML `<a:p>...` XML and whether RTL column layout applies."""
    if pptx_mode == "ocr":
        plain = _strip_inline_markers(_clean_text(block.get("text") or "")).strip("\n")
        rich_html = ""
        rtl_default = bool(_RTL_CHAR_RE.search(plain))
        raw_align = str(block.get("align") or "")
        if not rtl_default and raw_align == "right" and str(block.get("textMode") or "").lower() == "ocr":
            align_default = "left"
        else:
            align_default = raw_align or ("right" if rtl_default else "left")
        bold_default = True if block.get("pageRole") == "heading" else (block.get("bold") is not False)
    else:
        plain = _block_translation_plain(block)
        rich_html = _clean_text(block.get("richHtml") or "").strip()
        dir_field = str(block.get("dir") or "").lower()
        rtl_default = (dir_field == "rtl") if dir_field in ("rtl", "ltr") else (
            True if not plain else bool(_RTL_CHAR_RE.search(plain) or not re.search(r"[A-Za-z]", plain))
        )
        align_default = str(block.get("align") or ("justify" if rtl_default else "left"))
        bold_default = True if block.get("pageRole") == "heading" else (block.get("bold") is not False)

    raw_line_h = block.get("lineH")
    line_h_val: float | None = None
    try:
        if raw_line_h is not None and float(raw_line_h) > 0:
            line_h_val = float(raw_line_h)
    except (TypeError, ValueError):
        line_h_val = None

    raw_size = block.get("size")
    try:
        base_px = float(raw_size) if raw_size is not None and float(raw_size) > 0 else _estimate_fit_px(plain, bw_px, bh_px, line_h=line_h_val)
    except (TypeError, ValueError):
        base_px = _estimate_fit_px(plain, bw_px, bh_px, line_h=line_h_val)

    explicit_color = _parse_css_color(block.get("color"))
    if explicit_color:
        default_color = explicit_color
    elif bg_rgb is not None and (0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]) < 115:
        default_color = "FFFFFF"
    else:
        default_color = "141414"

    base_style = {
        "bold": bold_default,
        "italic": bool(block.get("italic")),
        "underline": bool(block.get("underline")),
        "strike": False,
        "color": default_color,
        "font_family": _clean_font_family(block.get("fontFamily")),
        "px_size": base_px,
        "rtl": rtl_default,
        "align": align_default,
    }

    if rich_html and pptx_mode != "ocr":
        parser = _RichHtmlToDocxParser(base_style)
        parser.feed(rich_html)
        parser.close()
        paragraphs = [p for p in parser.paragraphs if p["runs"]]
    else:
        paragraphs = []

    if not paragraphs:
        lines = plain.split("\n") if plain else [""]
        paragraphs = [{
            "align": align_default,
            "rtl": rtl_default,
            "runs": [
                entry
                for idx, line in enumerate(lines)
                for entry in (([{"br": True, **base_style}] if idx > 0 else []) + ([{"text": line, **base_style}] if line else []))
            ],
        }]

    first_ind_em = float(block.get("firstLineIndent") or 0.0) if block.get("pageRole") != "heading" else 0.0
    hang_ind_em = float(block.get("hangingIndent") or 0.0) if block.get("pageRole") != "heading" else 0.0
    box_mar_attr = ""
    if hang_ind_em >= 0.5:
        h_emu = max(91440, min(685800, round(hang_ind_em * 152400)))
        box_mar_attr = f' marL="{h_emu}" indent="-{h_emu}"'
    elif first_ind_em >= 0.5:
        f_emu = max(91440, min(685800, round(first_ind_em * 152400)))
        box_mar_attr = f' indent="{f_emu}"'

    p_xml_list: list[str] = []
    any_rtl = rtl_default
    for para in paragraphs:
        p_rtl = bool(para["rtl"])
        if p_rtl:
            any_rtl = True
        algn = _pptx_algn(str(para["align"]), p_rtl)
        ppr = (
            f'<a:pPr algn="{algn}" rtl="{"1" if p_rtl else "0"}"{box_mar_attr}>'
            '<a:lnSpc><a:spcPct val="115000"/></a:lnSpc>'
            '<a:spcAft><a:spcPts val="100"/></a:spcAft>'
            "</a:pPr>"
        )
        r_xml_list: list[str] = []
        for run in para["runs"]:
            pt_size = max(5.5, min(72.0, float(run["px_size"]) * scale_pt * 0.78))
            rpr_xml = _pptx_rpr_xml(run, pt_size)
            if run.get("br"):
                r_xml_list.append(f"<a:br>{rpr_xml}</a:br>")
            else:
                r_xml_list.append(f"<a:r>{rpr_xml}<a:t>{xml_escape(str(run.get('text') or ''))}</a:t></a:r>")
        if not r_xml_list:
            lang = "fa-IR" if p_rtl else "en-US"
            r_xml_list.append(f'<a:endParaRPr lang="{lang}" sz="1100" dirty="0"/>')
        p_xml_list.append(f"<a:p>{ppr}{''.join(r_xml_list)}</a:p>")
    return "".join(p_xml_list), any_rtl


def _write_pptx_package(
    output: Path,
    slide_cx_emu: int,
    slide_cy_emu: int,
    slides: list[dict[str, Any]],
    deck_title: str,
) -> Path:
    """Write a complete, ECMA-376 valid `.pptx` archive atomically."""
    content_type_overrides = [
        '  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        '  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>',
        '  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>',
        '  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>',
        '  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
        '  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
        '  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
        '  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    pres_rels = [
        '  <Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
        '  <Relationship Id="rIdPresProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>',
        '  <Relationship Id="rIdViewProps" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>',
        '  <Relationship Id="rIdTableStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>',
        '  <Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>',
    ]
    sld_ids = []
    for idx in range(1, len(slides) + 1):
        content_type_overrides.append(
            f'  <Override PartName="/ppt/slides/slide{idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        )
        pres_rels.append(
            f'  <Relationship Id="rIdSlide{idx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{idx}.xml"/>'
        )
        sld_ids.append(f'    <p:sldId id="{255 + idx}" r:id="rIdSlide{idx}"/>')

    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        '  <Default Extension="png" ContentType="image/png"/>\n'
        + "\n".join(content_type_overrides)
        + "\n</Types>"
    )
    pres_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        + "\n".join(pres_rels)
        + "\n</Relationships>"
    )
    presentation_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">\n'
        '  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>\n'
        "  <p:sldIdLst>\n"
        + "\n".join(sld_ids)
        + "\n  </p:sldIdLst>\n"
        f'  <p:sldSz cx="{slide_cx_emu}" cy="{slide_cy_emu}"/>\n'
        '  <p:notesSz cx="6858000" cy="9144000"/>\n'
        "  <p:defaultTextStyle>\n"
        '    <a:defPPr><a:defRPr lang="fa-IR"/></a:defPPr>\n'
        '    <a:lvl1pPr algn="r" rtl="1"><a:defRPr sz="1600"><a:latin typeface="Segoe UI"/><a:ea typeface="Segoe UI"/><a:cs typeface="Vazirmatn"/></a:defRPr></a:lvl1pPr>\n'
        "  </p:defaultTextStyle>\n"
        "</p:presentation>"
    )
    safe_title = xml_escape(_clean_text(deck_title or "Comic OCR Studio"))
    core_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        f"  <dc:title>{safe_title}</dc:title>\n"
        "  <dc:creator>Comic OCR Studio</dc:creator>\n"
        "</cp:coreProperties>"
    )
    app_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\n'
        "  <Application>Comic OCR Studio</Application>\n"
        f"  <Slides>{len(slides)}</Slides>\n"
        "  <Notes>0</Notes>\n"
        "  <HiddenSlides>0</HiddenSlides>\n"
        "</Properties>"
    )

    with _atomic_export_path(output) as tmp_output:
        with zipfile.ZipFile(tmp_output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", content_types_xml.encode("utf-8"))
            archive.writestr("_rels/.rels", _PPTX_ROOT_RELS.encode("utf-8"))
            archive.writestr("docProps/core.xml", core_xml.encode("utf-8"))
            archive.writestr("docProps/app.xml", app_xml.encode("utf-8"))
            archive.writestr("ppt/presentation.xml", presentation_xml.encode("utf-8"))
            archive.writestr("ppt/_rels/presentation.xml.rels", pres_rels_xml.encode("utf-8"))
            archive.writestr("ppt/presProps.xml", _PPTX_PRES_PROPS.encode("utf-8"))
            archive.writestr("ppt/viewProps.xml", _PPTX_VIEW_PROPS.encode("utf-8"))
            archive.writestr("ppt/tableStyles.xml", _PPTX_TABLE_STYLES.encode("utf-8"))
            archive.writestr("ppt/theme/theme1.xml", _PPTX_THEME.encode("utf-8"))
            archive.writestr("ppt/slideMasters/slideMaster1.xml", _PPTX_SLIDE_MASTER.encode("utf-8"))
            archive.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", _PPTX_SLIDE_MASTER_RELS.encode("utf-8"))
            archive.writestr("ppt/slideLayouts/slideLayout1.xml", _PPTX_SLIDE_LAYOUT.encode("utf-8"))
            archive.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", _PPTX_SLIDE_LAYOUT_RELS.encode("utf-8"))
            for idx, slide in enumerate(slides, start=1):
                archive.writestr(f"ppt/slides/slide{idx}.xml", slide["xml"].encode("utf-8"))
                archive.writestr(f"ppt/slides/_rels/slide{idx}.xml.rels", slide["rels"].encode("utf-8"))
                if slide.get("media_name"):
                    arc_media = f"ppt/media/{slide['media_name']}"
                    if slide.get("media_path"):
                        archive.write(slide["media_path"], arc_media, compress_type=zipfile.ZIP_STORED)
                    elif slide.get("media_bytes"):
                        archive.writestr(arc_media, slide["media_bytes"], compress_type=zipfile.ZIP_STORED)
    return output


def _build_flowing_pptx(
    state: dict[str, Any],
    images: list[dict[str, Any]],
    request: dict[str, Any],
    pptx_mode: str,
) -> Path:
    """Build clean 16:9 Widescreen presentation slides without background images."""
    slide_cx = 12_192_000  # 13.333 in (960 pt)
    slide_cy = 6_858_000   # 7.500 in (540 pt)
    margin_x = 685_800     # 0.75 in
    top_y = 640_080        # 0.70 in
    body_w = slide_cx - 2 * margin_x
    body_h = slide_cy - top_y - 685_800

    by_group: dict[str, list[dict[str, Any]]] = {}
    for item in images:
        gid = str(item.get("groupId") or "").strip()
        if gid:
            by_group.setdefault(gid, []).append(item)

    units: list[list[dict[str, Any]]] = []
    consumed: set[str] = set()
    for item in images:
        gid = str(item.get("groupId") or "").strip()
        members = by_group.get(gid)
        if not gid or not members or len(members) < 2:
            units.append([item])
            continue
        if gid in consumed:
            continue
        consumed.add(gid)
        units.append(members)

    slides: list[dict[str, Any]] = []
    slide_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\n'
        "</Relationships>"
    )
    total_units = max(1, len(units))

    for unit_idx, members in enumerate(units, start=1):
        unit_title = _clean_text(members[0].get("name") or f"صفحهٔ {unit_idx}")
        para_chunks: list[tuple[str, int, bool]] = []  # (p_xml, est_visual_lines, is_rtl)

        for item in members:
            crop = crop_box(item)
            ordered_blocks = _ordered_export_blocks(item)
            for blk in ordered_blocks:
                if crop:
                    cx0, cy0, cx1, cy1 = crop
                    bx0 = float(blk.get("tx0", blk.get("x0", 0)) or 0)
                    by0 = float(blk.get("ty0", blk.get("y0", 0)) or 0)
                    bx1 = float(blk.get("tx1", blk.get("x1", bx0)) or bx0)
                    by1 = float(blk.get("ty1", blk.get("y1", by0)) or by0)
                    if min(bx1, cx1) - max(bx0, cx0) <= 1 or min(by1, cy1) - max(by0, cy0) <= 1:
                        continue
                eff_mode = _effective_docx_block_mode(blk, pptx_mode)
                role = str(blk.get("pageRole") or "paragraph")
                if eff_mode == "ocr":
                    plain = _strip_inline_markers(_clean_text(blk.get("text") or "")).strip()
                    rich_html = ""
                    rtl_default = bool(_RTL_CHAR_RE.search(plain))
                else:
                    plain = _block_translation_plain(blk).strip()
                    rich_html = _clean_text(blk.get("richHtml") or "").strip()
                    dir_field = str(blk.get("dir") or "").lower()
                    rtl_default = (dir_field == "rtl") if dir_field in ("rtl", "ltr") else (
                        True if not plain else bool(_RTL_CHAR_RE.search(plain) or not re.search(r"[A-Za-z]", plain))
                    )
                if not plain:
                    continue

                raw_sz = float(blk.get("size") or 0.0)
                raw_lh = float(blk.get("lineH") or 0.0)
                if role == "heading":
                    base_pt = max(19.0, min(32.0, raw_sz * 1.15 if raw_sz > 12.0 else (raw_lh * 0.85 if raw_lh > 0.0 else 22.0)))
                else:
                    base_pt = max(11.0, min(28.0, raw_sz)) if (raw_sz > 0.0 and raw_sz != 12.0) else 15.5
                default_color = _parse_css_color(blk.get("color")) or ("1E1B4B" if role == "heading" else "1E293B")
                raw_align = str(blk.get("align") or "")
                align_default = raw_align if raw_align in ("left", "right", "center", "justify") else ("right" if rtl_default else "left")
                bold_default = True if role == "heading" else (blk.get("bold") is True)
                base_style = {
                    "bold": bold_default,
                    "italic": bool(blk.get("italic")),
                    "underline": bool(blk.get("underline")),
                    "strike": False,
                    "color": default_color,
                    "font_family": _clean_font_family(blk.get("fontFamily")),
                    "px_size": base_pt,
                    "rtl": rtl_default,
                    "align": align_default,
                }
                if rich_html and eff_mode != "ocr":
                    parser = _RichHtmlToDocxParser(base_style)
                    parser.feed(rich_html)
                    parser.close()
                    paragraphs = [p for p in parser.paragraphs if p["runs"]]
                else:
                    paragraphs = []
                if not paragraphs:
                    lines = plain.split("\n")
                    paragraphs = [{
                        "align": align_default,
                        "rtl": rtl_default,
                        "runs": [
                            entry
                            for idx, line in enumerate(lines)
                            for entry in (([{"br": True, **base_style}] if idx > 0 else []) + ([{"text": line, **base_style}] if line else []))
                        ],
                    }]

                block_ind_em = float(blk.get("blockIndent") or 0.0) if role != "heading" else 0.0
                if block_ind_em <= 0.0 and role != "heading" and int(blk.get("sourceIndent") or 0) > 0:
                    block_ind_em = min(4.0, round(int(blk.get("sourceIndent") or 0) * 0.35, 2))
                first_ind_em = float(blk.get("firstLineIndent") or 0.0) if role != "heading" else 0.0
                hang_ind_em = float(blk.get("hangingIndent") or 0.0) if role != "heading" else 0.0
                base_emu = 274320 if role == "list" else max(0, min(1097280, round(block_ind_em * 182880)))
                if hang_ind_em >= 0.5:
                    h_emu = max(137160, min(822960, round(hang_ind_em * 182880)))
                    mar_attr = f' marL="{base_emu + h_emu}" indent="-{h_emu}"'
                elif first_ind_em >= 0.5:
                    f_emu = max(137160, min(822960, round(first_ind_em * 182880)))
                    mar_attr = f' marL="{base_emu}" indent="{f_emu}"' if base_emu > 0 else f' indent="{f_emu}"'
                elif role == "list":
                    mar_attr = ' marL="274320" marR="274320"'
                elif base_emu > 0:
                    mar_attr = f' marL="{base_emu}"'
                else:
                    mar_attr = ""

                for para in paragraphs:
                    p_rtl = bool(para["rtl"])
                    algn = _pptx_algn(str(para["align"]), p_rtl)
                    spc_bef = "800" if role == "heading" else "200"
                    spc_aft = "450" if role == "heading" else "450"
                    bu_xml = '<a:buChar char="•"/>' if role == "list" else "<a:buNone/>"
                    ppr = (
                        f'<a:pPr algn="{algn}" rtl="{"1" if p_rtl else "0"}"{mar_attr}>'
                        '<a:lnSpc><a:spcPct val="125000"/></a:lnSpc>'
                        f'<a:spcBef><a:spcPts val="{spc_bef}"/></a:spcBef>'
                        f'<a:spcAft><a:spcPts val="{spc_aft}"/></a:spcAft>'
                        f"{bu_xml}"
                        "</a:pPr>"
                    )
                    r_xml_list: list[str] = []
                    char_count = 0
                    line_breaks = 0
                    for run in para["runs"]:
                        pt_sz = max(10.0, min(40.0, float(run.get("px_size") or base_pt)))
                        rpr_xml = _pptx_rpr_xml(run, pt_sz)
                        if run.get("br"):
                            r_xml_list.append(f"<a:br>{rpr_xml}</a:br>")
                            line_breaks += 1
                        else:
                            txt = str(run.get("text") or "")
                            char_count += len(txt)
                            r_xml_list.append(f"<a:r>{rpr_xml}<a:t>{xml_escape(txt)}</a:t></a:r>")
                    if not r_xml_list:
                        continue
                    est_lines = max(1, line_breaks + math.ceil(char_count / (62.0 if role == "heading" else 88.0))) + (1 if role == "heading" else 0)
                    para_chunks.append((f"<a:p>{ppr}{''.join(r_xml_list)}</a:p>", est_lines, p_rtl))

        # Paginate into comfortable 16:9 slides (up to ~14 estimated lines per slide)
        batches: list[list[tuple[str, int, bool]]] = []
        cur_batch: list[tuple[str, int, bool]] = []
        cur_lines = 0
        for chunk in para_chunks:
            if cur_batch and cur_lines + chunk[1] > 14:
                batches.append(cur_batch)
                cur_batch = [chunk]
                cur_lines = chunk[1]
            else:
                cur_batch.append(chunk)
                cur_lines += chunk[1]
        if cur_batch or not batches:
            batches.append(cur_batch)

        for part_idx, batch in enumerate(batches, start=1):
            slide_rtl = any(c[2] for c in batch) or pptx_mode == "translation"
            if batch:
                body_p_xml = "".join(c[0] for c in batch)
            else:
                lang = "fa-IR" if slide_rtl else "en-US"
                body_p_xml = f'<a:p><a:pPr algn="{"r" if slide_rtl else "l"}" rtl="{"1" if slide_rtl else "0"}"/><a:endParaRPr lang="{lang}" sz="1400" dirty="0"/></a:p>'
            footer_label = (
                f"{unit_title} — بخش {part_idx}" if len(batches) > 1 else unit_title
            )
            footer_rpr = _pptx_rpr_xml({"color": "64748B", "rtl": slide_rtl, "bold": False}, 10.5)
            slide_xml = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n'
                "  <p:cSld>\n"
                '    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\n'
                "    <p:spTree>\n"
                '      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n'
                '      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>\n'
                "      <p:sp>\n"
                '        <p:nvSpPr><p:cNvPr id="2" name="Slide Content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>\n'
                f'        <p:spPr><a:xfrm><a:off x="{margin_x}" y="{top_y}"/><a:ext cx="{body_w}" cy="{body_h}"/></a:xfrm>'
                '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 3500"/></a:avLst></a:prstGeom>'
                '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'
                '<a:ln w="9525"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></p:spPr>\n'
                "        <p:txBody>\n"
                f'          <a:bodyPr wrap="square" rtlCol="{"1" if slide_rtl else "0"}" lIns="320040" tIns="274320" rIns="320040" bIns="274320" anchor="t"><a:normAutofit/></a:bodyPr>\n'
                "          <a:lstStyle/>\n"
                f"          {body_p_xml}\n"
                "        </p:txBody>\n"
                "      </p:sp>\n"
                "      <p:sp>\n"
                '        <p:nvSpPr><p:cNvPr id="3" name="Slide Footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>\n'
                f'        <p:spPr><a:xfrm><a:off x="{margin_x}" y="{slide_cy - 520000}"/><a:ext cx="{body_w}" cy="360000"/></a:xfrm>'
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>\n'
                "        <p:txBody>\n"
                f'          <a:bodyPr wrap="square" rtlCol="{"1" if slide_rtl else "0"}" lIns="45720" tIns="0" rIns="45720" bIns="0" anchor="ctr"/>\n'
                "          <a:lstStyle/>\n"
                f'          <a:p><a:pPr algn="{"r" if slide_rtl else "l"}" rtl="{"1" if slide_rtl else "0"}"/><a:r>{footer_rpr}<a:t>{xml_escape(footer_label)}</a:t></a:r></a:p>\n'
                "        </p:txBody>\n"
                "      </p:sp>\n"
                "    </p:spTree>\n"
                "  </p:cSld>\n"
                "  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n"
                "</p:sld>"
            )
            slides.append({"xml": slide_xml, "rels": slide_rels})
        emit(
            f"چیدمان اسلاید متنی {unit_idx} از {total_units} در PowerPoint",
            progress=unit_idx / total_units * 0.9,
        )

    emit("در حال بسته‌بندی فایل PowerPoint…", progress=0.96)
    output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}.pptx"
    return _write_pptx_package(output, slide_cx, slide_cy, slides, state.get("name") or "Presentation")


def build_pptx(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    """Build an editable PowerPoint (.pptx) presentation in either visual-comic or flowing-slide mode."""
    require_active_license()
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("برای خروجی هیچ تصویری انتخاب نشده است؛ حداقل یک تصویر را انتخاب کنید.")
    raw_mode = request.get("pptx_mode") or request.get("docx_mode") or "translation"
    raw_layout = request.get("pptx_layout") or request.get("docx_layout") or "visual"
    pptx_mode = "ocr" if raw_mode == "ocr" else "translation"
    if raw_layout == "flowing":
        return _build_flowing_pptx(state, images, request, pptx_mode)

    with tempfile.TemporaryDirectory(prefix="comic-pptx-") as spool_raw:
        pages = _prepare_docx_pages(
            store,
            state["id"],
            images,
            pptx_mode,
            target_label="فایل PowerPoint",
            spool_dir=Path(spool_raw),
            project_settings=state.get("settings") or {},
        )
        return _finalize_visual_pptx(state, request, pptx_mode, pages)


def _finalize_visual_pptx(
    state: dict[str, Any],
    request: dict[str, Any],
    pptx_mode: str,
    pages: list[dict[str, Any]],
) -> Path:
    # Choose deck slide dimensions matching the median page aspect ratio within PowerPoint's 1"–56" limits
    aspects = sorted(max(0.15, min(6.5, p["h"] / max(1, p["w"]))) for p in pages)
    median_aspect = aspects[len(aspects) // 2]
    base_w_pt = 720.0
    base_h_pt = base_w_pt * median_aspect
    if base_h_pt > 3600.0:
        scale_down = 3600.0 / base_h_pt
        base_w_pt *= scale_down
        base_h_pt = 3600.0
    slide_cx = max(914_400, min(51_206_400, round(base_w_pt * 12700)))
    slide_cy = max(914_400, min(51_206_400, round(base_h_pt * 12700)))

    slides: list[dict[str, Any]] = []
    for page_idx, page in enumerate(pages, start=1):
        check_cancelled("ساخت خروجی به درخواست کاربر لغو شد.")
        img_w, img_h = max(1, page["w"]), max(1, page["h"])
        fit_scale_emu = min(slide_cx / img_w, slide_cy / img_h)
        draw_cx = max(12700, round(img_w * fit_scale_emu))
        draw_cy = max(12700, round(img_h * fit_scale_emu))
        off_x = max(0, (slide_cx - draw_cx) // 2)
        off_y = max(0, (slide_cy - draw_cy) // 2)
        font_scale_pt = fit_scale_emu / 12700.0

        media_name = f"slide_bg_{page_idx:03d}.png"
        safe_page_name = _xml_attr(page.get("name") or f"slide-{page_idx}")
        shapes_xml = [
            "      <p:pic>\n"
            f'        <p:nvPicPr><p:cNvPr id="2" name="{safe_page_name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>\n'
            '        <p:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\n'
            f'        <p:spPr><a:xfrm><a:off x="{off_x}" y="{off_y}"/><a:ext cx="{draw_cx}" cy="{draw_cy}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>\n'
            "      </p:pic>"
        ]

        next_shape_id = 3
        for spec in page["blocks"]:
            blk = spec["block"]
            eff_mode = _effective_docx_block_mode(blk, pptx_mode)
            bw_px = max(2.0, spec["x1"] - spec["x0"])
            bh_px = max(2.0, spec["y1"] - spec["y0"])
            bx_emu = off_x + max(0, round(spec["x0"] * fit_scale_emu))
            by_emu = off_y + max(0, round(spec["y0"] * fit_scale_emu))
            bcx_emu = max(101_600, round(bw_px * fit_scale_emu))
            bcy_emu = max(101_600, round(bh_px * fit_scale_emu))
            blk_shape = _normalize_box_shape(blk.get("shape"))
            blk_radius_pct = _normalize_corner_radius_pct(blk.get("cornerRadius"))
            blk_angle_deg = _normalize_angle_deg(blk.get("angle"))
            pad_x_px, pad_top_px, pad_bot_px = _shape_insets_px(bw_px, bh_px, blk_shape, blk_radius_pct)
            ins_x = max(0, round(pad_x_px * fit_scale_emu))
            ins_top = max(0, round(pad_top_px * fit_scale_emu))
            ins_bot = max(0, round(pad_bot_px * fit_scale_emu))
            eff_bw_px = max(2.0, ((bcx_emu - 2 * ins_x) / 12700.0) / max(1e-6, font_scale_pt) + 2.0 * _box_inset_px(bw_px))
            eff_bh_px = max(2.0, ((bcy_emu - ins_top - ins_bot) / 12700.0) / max(1e-6, font_scale_pt) + 2.0 * _box_inset_px(bh_px))
            valign = str(blk.get("verticalAlign") or ("middle" if eff_mode == "ocr" else "top"))
            anchor = _pptx_anchor(valign if valign in ("top", "middle", "bottom") else ("middle" if eff_mode == "ocr" else "top"))
            tx_p_xml, is_rtl = _build_pptx_textbox_paragraphs_xml(
                blk,
                pptx_mode=eff_mode,
                bw_px=eff_bw_px,
                bh_px=eff_bh_px,
                scale_pt=font_scale_pt,
                bg_rgb=spec.get("bg_rgb"),
            )
            rot_emu_attr = ""
            if abs(blk_angle_deg) > 0.05:
                rot_units = int(round((blk_angle_deg % 360.0) * 60000.0)) % 21_600_000
                rot_emu_attr = f' rot="{rot_units}"'
            prst_geom_xml = _pptx_prst_geom_xml(blk_shape, blk_radius_pct)
            shapes_xml.append(
                "      <p:sp>\n"
                f'        <p:nvSpPr><p:cNvPr id="{next_shape_id}" name="TextBox {next_shape_id - 2}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>\n'
                f'        <p:spPr><a:xfrm{rot_emu_attr}><a:off x="{bx_emu}" y="{by_emu}"/><a:ext cx="{bcx_emu}" cy="{bcy_emu}"/></a:xfrm>'
                f'{prst_geom_xml}<a:noFill/></p:spPr>\n'
                "        <p:txBody>\n"
                f'          <a:bodyPr wrap="square" rtlCol="{"1" if is_rtl else "0"}" lIns="{ins_x}" tIns="{ins_top}" rIns="{ins_x}" bIns="{ins_bot}" anchor="{anchor}"><a:normAutofit/></a:bodyPr>\n'
                "          <a:lstStyle/>\n"
                f"          {tx_p_xml}\n"
                "        </p:txBody>\n"
                "      </p:sp>"
            )
            next_shape_id += 1

        slide_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">\n'
            "  <p:cSld>\n"
            '    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\n'
            "    <p:spTree>\n"
            '      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\n'
            '      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>\n'
            + "\n".join(shapes_xml)
            + "\n    </p:spTree>\n"
            "  </p:cSld>\n"
            "  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\n"
            "</p:sld>"
        )
        slide_rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            '  <Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\n'
            f'  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{media_name}"/>\n'
            "</Relationships>"
        )
        slides.append({
            "xml": slide_xml,
            "rels": slide_rels,
            "media_name": media_name,
            "media_path": page.get("png_path"),
            "media_bytes": page.get("png"),
        })

    emit("در حال بسته‌بندی فایل PowerPoint…", progress=0.95)
    output = project_root(state["id"]) / "exports" / f"{_export_stem(state, request)}.pptx"
    return _write_pptx_package(output, slide_cx, slide_cy, slides, state.get("name") or "Comic Presentation")

