from __future__ import annotations

import io
import math
import re
import zipfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

import pymupdf as fitz
from PIL import Image, ImageDraw

from .activity import emit
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
    """Return final bytes without recompressing an untouched original or uncropped PNG render."""
    edited_path = project_root(project_id) / "images" / f"{item['id']}-edited.png"
    has_edited = edited_path.exists()
    source_path = edited_path if has_edited else project_root(project_id) / "images" / item["file"]
    content = source_path.read_bytes()
    crop = crop_box(item)
    target = image_format if image_format in {"png", "jpg"} else "orig"
    original_format = "png" if has_edited else ("jpg" if item["format"] == "JPEG" else "png")
    if not crop:
        if has_edited and target in {"orig", "png"}:
            with Image.open(io.BytesIO(content)) as opened:
                return content, "png", opened.width, opened.height
        if not has_edited and (
            (item["format"] == "PNG" and target in {"orig", "png"})
            or (item["format"] == "JPEG" and target in {"orig", "jpg"})
        ):
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
    # Every member is normalized to the composed page width. Keeping a narrower source width
    # while scaling its height to common_width would stretch it and leave unintended side bars.
    widths = [max(1, round(common_width * scale)) for _ in entries]
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
    total_src = max(1, len(images))
    for idx, item in enumerate(images, start=1):
        data, _, width, height = image_payload(store, state["id"], item)
        source.append({
            "data": data, "w": width, "h": height, "order": int(item.get("order", 0)),
            "groupId": item.get("groupId"), "grouped": False,
        })
        emit(f"آماده‌سازی تصویر {idx} از {total_src} برای PDF", progress=idx / total_src * 0.55)
    by_group: dict[str, list[dict[str, Any]]] = {}
    for entry in source:
        if entry["groupId"] is not None and str(entry["groupId"]).strip():
            by_group.setdefault(str(entry["groupId"]), []).append(entry)
    grouped: list[dict[str, Any]] = []
    consumed: set[str] = set()
    for entry in source:
        key = str(entry["groupId"]) if entry["groupId"] is not None else ""
        members = by_group.get(key)
        if not key or not members or len(members) < 2:
            grouped.append(entry)
            continue
        if key in consumed:
            continue
        consumed.add(key)
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
    try:
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
            for idx, entry in enumerate(entries, start=1):
                _insert(document, page_width, page_height, [entry])
                emit(f"چیدمان صفحهٔ {idx} از {len(entries)} در PDF", progress=0.55 + idx / max(1, len(entries)) * 0.4)
        else:
            for idx, entry in enumerate(entries, start=1):
                _insert(document, entry["w"], entry["h"], [entry])
                emit(f"چیدمان صفحهٔ {idx} از {len(entries)} در PDF", progress=0.55 + idx / max(1, len(entries)) * 0.4)
        output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.pdf"
        output.parent.mkdir(parents=True, exist_ok=True)
        emit("در حال ذخیره‌سازی فایل PDF…", progress=0.97)
        document.save(output, garbage=4, deflate=True)
    finally:
        document.close()
    return output


def build_images_zip(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}-images.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    folder = clean_name(request.get("folder_name", ""), "") if request.get("folder_name") else ""
    prefix = f"{folder}/" if folder else ""
    total = max(1, len(images))
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for index, item in enumerate(images, start=1):
            data, extension, _, _ = image_payload(store, state["id"], item, request.get("image_format", "orig"))
            archive.writestr(f"{prefix}{index:03d}-{clean_name(Path(item['name']).stem)}.{extension}", data)
            emit(f"افزودن تصویر {index} از {total} به بستهٔ ZIP", progress=index / total)
    return output


def build_txt(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    chunks = []
    total = max(1, len(images))
    for index, item in enumerate(images, start=1):
        chunks.append(f"===== تصویر {index:03d} — {item['name']} =====\n")
        blocks = sorted(item.get("blocks", []), key=lambda block: (block.get("y0", 0), block.get("x0", 0)))
        if not blocks:
            chunks.append("(متنی تشخیص داده نشده است)\n")
        for block in blocks:
            indent = " " * max(0, min(40, int(block.get("sourceIndent", 0) or 0)))
            chunks.append(f"[{block.get('id', '-')}] {indent}{block.get('text', '')}")
            chunks.append(f"    ← {block.get('tr') or '(بدون ترجمه)'}\n")
        emit(f"نوشتن متن تصویر {index} از {total} در فایل TXT", progress=index / total)
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.txt"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\ufeff" + "\n".join(chunks), encoding="utf-8")
    return output


_INVALID_XML_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
_RTL_CHAR_RE = re.compile(r"[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]")
_HEX_COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")
_RGB_COLOR_RE = re.compile(r"^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})")

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


def _estimate_fit_px(text: str, bw: float, bh: float) -> float:
    """Estimate auto-fit pixel font size inside (bw, bh) when block['size'] is unset."""
    ix = _box_inset_px(bw)
    iy = _box_inset_px(bh)
    usable_w = max(16.0, bw - 2.0 * ix)
    usable_h = max(14.0, bh - 2.0 * iy)
    raw_lines = [ln for ln in _clean_text(text).split("\n")] or [""]
    for sz in range(min(44, max(8, int(usable_h * 0.72))), 7, -1):
        char_w = sz * 0.54
        chars_per_line = max(1.0, usable_w / max(1.0, char_w))
        wrapped = sum(max(1, math.ceil(len(ln) / chars_per_line)) for ln in raw_lines)
        if wrapped * (sz * 1.52) <= usable_h:
            return float(sz)
    return 8.0


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
        indent = " " * max(0, min(40, int(block.get("sourceIndent", 0) or 0)))
        plain = _clean_text(f"{indent}{block.get('text') or ''}").strip("\n")
        rich_html = ""
        rtl_default = bool(_RTL_CHAR_RE.search(plain))
        align_default = str(block.get("align") or ("right" if rtl_default else "left"))
        bold_default = True
    else:
        plain = _clean_text(block.get("tr") or "").strip("\n")
        rich_html = _clean_text(block.get("richHtml") or "").strip()
        dir_field = str(block.get("dir") or "").lower()
        rtl_default = (dir_field == "rtl") if dir_field in ("rtl", "ltr") else (True if not plain else bool(_RTL_CHAR_RE.search(plain) or not re.search(r"[A-Za-z]", plain)))
        align_default = str(block.get("align") or ("justify" if rtl_default else "left"))
        bold_default = block.get("bold") is not False

    raw_size = block.get("size")
    try:
        base_px = float(raw_size) if raw_size is not None and float(raw_size) > 0 else _estimate_fit_px(plain, bw_px, bh_px)
    except (TypeError, ValueError):
        base_px = _estimate_fit_px(plain, bw_px, bh_px)

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

    p_xml_list: list[str] = []
    for para in paragraphs:
        p_rtl = bool(para["rtl"])
        jc = _word_jc(str(para["align"]), p_rtl)
        ppr = (
            f'<w:bidi w:val="{"1" if p_rtl else "0"}"/>'
            f'<w:jc w:val="{jc}"/>'
            '<w:spacing w:before="0" w:after="20" w:line="276" w:lineRule="auto"/>'
        )
        r_xml_list: list[str] = []
        for run in para["runs"]:
            pt_size = max(5.5, min(72.0, float(run["px_size"]) * scale_pt * 0.78))
            half_pt = max(11, min(144, round(pt_size * 2)))
            rpr = [f'<w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/>']
            if run.get("bold"):
                rpr.append("<w:b/><w:bCs/>")
            if run.get("italic"):
                rpr.append("<w:i/><w:iCs/>")
            if run.get("underline"):
                rpr.append('<w:u w:val="single"/>')
            if run.get("strike"):
                rpr.append("<w:strike/>")
            if run.get("rtl"):
                rpr.append("<w:rtl/>")
            if run.get("color"):
                rpr.append(f'<w:color w:val="{run["color"]}"/>')
            rpr_xml = f"<w:rPr>{''.join(rpr)}</w:rPr>"
            if run.get("br"):
                r_xml_list.append(f"<w:r>{rpr_xml}<w:br/></w:r>")
            else:
                r_xml_list.append(f'<w:r>{rpr_xml}<w:t xml:space="preserve">{xml_escape(str(run.get("text") or ""))}</w:t></w:r>')
        p_xml_list.append(f"<w:p><w:pPr>{ppr}</w:pPr>{''.join(r_xml_list)}</w:p>")
    return "".join(p_xml_list)


def _prepare_docx_pages(
    store: ProjectStore, project_id: str, images: list[dict[str, Any]], docx_mode: str,
) -> list[dict[str, Any]]:
    """Build per-page cleaned background images and scaled block specs (supporting page groups)."""
    raw_entries: list[dict[str, Any]] = []
    for item in images:
        source_path = project_root(project_id) / "images" / item["file"]
        with Image.open(source_path) as opened:
            im = opened.convert("RGB")
        crop = crop_box(item)
        off_x, off_y = (float(crop[0]), float(crop[1])) if crop else (0.0, 0.0)
        if crop:
            im = im.crop(crop)
        raw_entries.append({
            "image": im,
            "w": im.width,
            "h": im.height,
            "item": item,
            "off_x": off_x,
            "off_y": off_y,
            "groupId": item.get("groupId"),
        })

    by_group: dict[str, list[dict[str, Any]]] = {}
    for entry in raw_entries:
        gid = str(entry["groupId"]).strip() if entry["groupId"] is not None else ""
        if gid:
            by_group.setdefault(gid, []).append(entry)

    grouped_units: list[list[dict[str, Any]]] = []
    consumed: set[str] = set()
    for entry in raw_entries:
        gid = str(entry["groupId"]).strip() if entry["groupId"] is not None else ""
        members = by_group.get(gid)
        if not gid or not members or len(members) < 2:
            grouped_units.append([entry])
            continue
        if gid in consumed:
            continue
        consumed.add(gid)
        grouped_units.append(members)

    pages: list[dict[str, Any]] = []
    total_units = max(1, len(grouped_units))
    for page_idx, members in enumerate(grouped_units, start=1):
        common_w = max(m["w"] for m in members)
        raw_h = sum(m["h"] * common_w / max(1, m["w"]) for m in members)
        comp_scale = min(
            1.0,
            16000.0 / max(common_w, 1),
            16000.0 / max(raw_h, 1),
            math.sqrt(180_000_000.0 / max(common_w * raw_h, 1)),
        )
        canvas_w = max(1, round(common_w * comp_scale))
        member_heights = [max(1, round(m["h"] * (common_w / max(1, m["w"])) * comp_scale)) for m in members]
        canvas = Image.new("RGB", (canvas_w, sum(member_heights)), "white")
        page_blocks: list[dict[str, Any]] = []
        y_cursor = 0
        for m, mh in zip(members, member_heights):
            m_scale = (common_w / max(1, m["w"])) * comp_scale
            part = m["image"]
            if part.size != (canvas_w, mh):
                part = part.resize((canvas_w, mh), Image.Resampling.LANCZOS)
            canvas.paste(part, (0, y_cursor))
            sorted_blocks = sorted(m["item"].get("blocks", []), key=lambda b: (b.get("ty0", b.get("y0", 0)), b.get("tx0", b.get("x0", 0))))
            for blk in sorted_blocks:
                if blk.get("enabled", True) is False:
                    continue
                if docx_mode == "ocr":
                    has_text = bool(_clean_text(blk.get("text") or "").strip())
                else:
                    has_text = bool(_clean_text(blk.get("tr") or "").strip() or _clean_text(blk.get("richHtml") or "").strip())
                if not has_text:
                    continue
                bx0, by0, bx1, by1 = _block_box(blk, m["off_x"], m["off_y"], m_scale, canvas_w, mh)
                if bx1 - bx0 < 2 or by1 - by0 < 2:
                    continue
                page_blocks.append({
                    "block": blk,
                    "x0": bx0,
                    "y0": by0 + y_cursor,
                    "x1": bx1,
                    "y1": by1 + y_cursor,
                })
            y_cursor += mh

        # Erase/fill bubble backgrounds first (matching Typeset.render targetFills) without baking raster text.
        draw = ImageDraw.Draw(canvas)
        for spec in page_blocks:
            bg_mode = str(spec["block"].get("bg") or "auto")
            ix0, iy0 = int(round(spec["x0"])), int(round(spec["y0"]))
            ix1, iy1 = int(round(spec["x1"])), int(round(spec["y1"]))
            if bg_mode == "none":
                spec["bg_rgb"] = _sample_box_bg(canvas, ix0, iy0, ix1, iy1)
                continue
            if bg_mode == "white":
                fill_rgb = (255, 255, 255)
            elif bg_mode == "black":
                fill_rgb = (16, 16, 16)
            else:
                fill_rgb = _sample_box_bg(canvas, ix0, iy0, ix1, iy1)
            spec["bg_rgb"] = fill_rgb
            draw.rectangle([ix0, iy0, max(ix0, ix1 - 1), max(iy0, iy1 - 1)], fill=fill_rgb)

        buf = io.BytesIO()
        canvas.save(buf, "PNG")
        pages.append({
            "png": buf.getvalue(),
            "w": canvas.width,
            "h": canvas.height,
            "blocks": page_blocks,
            "name": members[0]["item"].get("name", f"page-{page_idx}"),
        })
        emit(f"آماده‌سازی صفحهٔ {page_idx} از {total_units} برای فایل Word", progress=page_idx / total_units * 0.85)
    return pages


def build_docx(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    docx_mode = "ocr" if request.get("docx_mode") == "ocr" else "translation"
    pages = _prepare_docx_pages(store, state["id"], images, docx_mode)

    rel_entries = [
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    ]
    body_parts: list[str] = []
    final_sect_pr = ""
    shape_serial = 1

    for page_idx, page in enumerate(pages, start=1):
        rel_id = f"rIdImg{page_idx}"
        media_name = f"media/page_{page_idx:03d}.png"
        rel_entries.append(
            f'  <Relationship Id="{rel_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{media_name}"/>'
        )
        img_w, img_h = max(1, page["w"]), max(1, page["h"])
        scale_pt = min(540.0 / img_w, 1500.0 / img_h)
        w_pt = max(72.0, img_w * scale_pt)
        h_pt = max(72.0, img_h * scale_pt)
        w_dxa = max(1440, min(31680, round(w_pt * 20)))
        h_dxa = max(1440, min(31680, round(h_pt * 20)))
        cx_emu = max(914400, round(w_pt * 12700))
        cy_emu = max(914400, round(h_pt * 12700))

        sect_pr = (
            f'<w:sectPr><w:bidi/>'
            f'<w:pgSz w:w="{w_dxa}" w:h="{h_dxa}"/>'
            '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>'
            "</w:sectPr>"
        )
        if page_idx == len(pages):
            final_sect_pr = sect_pr

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
            f'<wp:docPr id="{page_idx}" name="{xml_escape(str(page["name"]))}"/>'
            "<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>"
            '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            "<pic:pic>"
            f'<pic:nvPicPr><pic:cNvPr id="{page_idx}" name="{xml_escape(str(page["name"]))}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx_emu}" cy="{cy_emu}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            "</pic:pic></a:graphicData></a:graphic>"
            "</wp:anchor></w:drawing></w:r>"
        )

        box_runs: list[str] = []
        for spec in page["blocks"]:
            blk = spec["block"]
            bw_px = max(2.0, spec["x1"] - spec["x0"])
            bh_px = max(2.0, spec["y1"] - spec["y0"])
            left_pt = spec["x0"] * scale_pt
            top_pt = spec["y0"] * scale_pt
            bw_pt = max(8.0, bw_px * scale_pt)
            bh_pt = max(8.0, bh_px * scale_pt)
            inset_x = _box_inset_px(bw_px) * scale_pt
            inset_y = _box_inset_px(bh_px) * scale_pt
            valign = str(blk.get("verticalAlign") or ("middle" if docx_mode == "ocr" else "top"))
            v_anchor = valign if valign in ("top", "middle", "bottom") else ("middle" if docx_mode == "ocr" else "top")
            txbx_p = _build_textbox_paragraphs_xml(
                blk, docx_mode=docx_mode, bw_px=bw_px, bh_px=bh_px,
                scale_pt=scale_pt, bg_rgb=spec.get("bg_rgb"),
            )
            shape_style = (
                f"position:absolute;margin-left:{left_pt:.2f}pt;margin-top:{top_pt:.2f}pt;"
                f"width:{bw_pt:.2f}pt;height:{bh_pt:.2f}pt;z-index:{shape_serial + 10};"
                f"v-text-anchor:{v_anchor};mso-position-horizontal-relative:page;mso-position-vertical-relative:page"
            )
            inset_str = f"{inset_x:.2f}pt,{inset_y:.2f}pt,{inset_x:.2f}pt,{inset_y:.2f}pt"
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
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.docx"
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES.encode("utf-8"))
        archive.writestr("_rels/.rels", _DOCX_ROOT_RELS.encode("utf-8"))
        archive.writestr("word/_rels/document.xml.rels", doc_rels_xml.encode("utf-8"))
        archive.writestr("word/styles.xml", _DOCX_STYLES.encode("utf-8"))
        for page_idx, page in enumerate(pages, start=1):
            archive.writestr(f"word/media/page_{page_idx:03d}.png", page["png"])
        archive.writestr("word/document.xml", document_xml.encode("utf-8"))
    return output
