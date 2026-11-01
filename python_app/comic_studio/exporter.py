from __future__ import annotations

import io
import math
import re
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as xml_escape

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
    for item in images:
        data, _, width, height = image_payload(store, state["id"], item)
        source.append({
            "data": data, "w": width, "h": height, "order": int(item.get("order", 0)),
            "groupId": item.get("groupId"), "grouped": False,
        })
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
            for entry in entries:
                _insert(document, page_width, page_height, [entry])
        else:
            for entry in entries:
                _insert(document, entry["w"], entry["h"], [entry])
        output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.pdf"
        output.parent.mkdir(parents=True, exist_ok=True)
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
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\ufeff" + "\n".join(chunks), encoding="utf-8")
    return output


_INVALID_XML_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")

_DOCX_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_DOCX_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOCX_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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
        <w:spacing w:after="100" w:line="300" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>"""


def _xml_text(value: Any) -> str:
    return xml_escape(_INVALID_XML_RE.sub("", str(value or "")).replace("\r\n", "\n").replace("\r", "\n"))


def _docx_runs(text: Any, *, bold: bool = False, rtl: bool = True, size_half_pt: int = 22, color: str | None = None) -> str:
    rpr = [f'<w:sz w:val="{size_half_pt}"/><w:szCs w:val="{size_half_pt}"/>']
    if bold:
        rpr.append("<w:b/><w:bCs/>")
    if rtl:
        rpr.append("<w:rtl/>")
    if color:
        rpr.append(f'<w:color w:val="{color}"/>')
    rpr_xml = f"<w:rPr>{''.join(rpr)}</w:rPr>"
    lines = _INVALID_XML_RE.sub("", str(text or "")).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    parts: list[str] = []
    for idx, line in enumerate(lines):
        if idx > 0:
            parts.append("<w:br/>")
        parts.append(f'<w:t xml:space="preserve">{xml_escape(line)}</w:t>')
    return f"<w:r>{rpr_xml}{''.join(parts)}</w:r>"


def _docx_paragraph(
    text: Any, *, rtl: bool = True, align: str = "right", bold: bool = False,
    size_half_pt: int = 22, color: str | None = None, space_before: int = 0, space_after: int = 100,
    bottom_border: bool = False,
) -> str:
    ppr = [
        f'<w:bidi w:val="{"1" if rtl else "0"}"/>',
        f'<w:jc w:val="{align}"/>',
        f'<w:spacing w:before="{space_before}" w:after="{space_after}" w:line="300" w:lineRule="auto"/>',
    ]
    if bottom_border:
        ppr.append('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="CBD5E1"/></w:pBdr>')
    run = _docx_runs(text, bold=bold, rtl=rtl, size_half_pt=size_half_pt, color=color) if str(text or "") != "" else ""
    return f"<w:p><w:pPr>{''.join(ppr)}</w:pPr>{run}</w:p>"


def _docx_cell(
    text: Any, *, width_dxa: int, rtl: bool = True, align: str = "right",
    bold: bool = False, fill: str | None = None, color: str | None = None,
) -> str:
    tc_pr = [
        f'<w:tcW w:w="{width_dxa}" w:type="dxa"/>',
        '<w:vAlign w:val="top"/>',
    ]
    if fill:
        tc_pr.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>')
    p = _docx_paragraph(text, rtl=rtl, align=align, bold=bold, size_half_pt=21, color=color, space_before=40, space_after=40)
    return f"<w:tc><w:tcPr>{''.join(tc_pr)}</w:tcPr>{p}</w:tc>"


def build_docx(store: ProjectStore, state: dict[str, Any], request: dict[str, Any]) -> Path:
    images = selected_images(state, request.get("image_ids", []))
    if not images:
        raise ValueError("No images selected")
    doc_title = (state.get("name") or request.get("name") or "پروژهٔ کمیک").strip()
    body_parts: list[str] = [
        _docx_paragraph(doc_title, rtl=True, align="right", bold=True, size_half_pt=30, color="1E293B", space_before=0, space_after=200),
    ]
    tbl_borders = (
        '<w:tblBorders>'
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>'
        '<w:left w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>'
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>'
        '<w:right w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>'
        '</w:tblBorders>'
    )
    tbl_cell_mar = (
        '<w:tblCellMar>'
        '<w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>'
        '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/>'
        '</w:tblCellMar>'
    )
    for index, item in enumerate(images, start=1):
        body_parts.append(
            _docx_paragraph(
                f"تصویر {index:03d} — {item['name']}",
                rtl=True, align="right", bold=True, size_half_pt=24, color="334155",
                space_before=220, space_after=100, bottom_border=True,
            )
        )
        blocks = sorted(item.get("blocks", []), key=lambda block: (block.get("y0", 0), block.get("x0", 0)))
        if not blocks:
            body_parts.append(_docx_paragraph("(متنی تشخیص داده نشده است)", rtl=True, color="64748B", space_after=140))
            continue
        rows_xml = [
            "<w:tr><w:trPr><w:tblHeader/></w:trPr>"
            + _docx_cell("کادر", width_dxa=900, rtl=True, align="center", bold=True, fill="EEF2FF", color="1E293B")
            + _docx_cell("ترجمهٔ فارسی", width_dxa=4350, rtl=True, align="right", bold=True, fill="EEF2FF", color="1E293B")
            + _docx_cell("متن اصلی (OCR)", width_dxa=4350, rtl=False, align="left", bold=True, fill="EEF2FF", color="1E293B")
            + "</w:tr>"
        ]
        for row_idx, block in enumerate(blocks):
            indent = " " * max(0, min(40, int(block.get("sourceIndent", 0) or 0)))
            src_text = f"{indent}{block.get('text', '')}".rstrip() or "—"
            tr_text = (block.get("tr") or "").strip() or "(بدون ترجمه)"
            zebra = "F8FAFC" if row_idx % 2 == 1 else None
            rows_xml.append(
                "<w:tr>"
                + _docx_cell(f"[{block.get('id', '-')}]", width_dxa=900, rtl=False, align="center", fill=zebra, color="475569")
                + _docx_cell(tr_text, width_dxa=4350, rtl=True, align="right", fill=zebra, color="0F172A")
                + _docx_cell(src_text, width_dxa=4350, rtl=False, align="left", fill=zebra, color="334155")
                + "</w:tr>"
            )
        body_parts.append(
            "<w:tbl>"
            f"<w:tblPr><w:bidiVisual/><w:tblW w:w=\"9600\" w:type=\"dxa\"/>{tbl_borders}{tbl_cell_mar}</w:tblPr>"
            '<w:tblGrid><w:gridCol w:w="900"/><w:gridCol w:w="4350"/><w:gridCol w:w="4350"/></w:tblGrid>'
            + "".join(rows_xml)
            + "</w:tbl>"
        )
        body_parts.append(_docx_paragraph("", rtl=True, space_before=0, space_after=80))

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
        + "".join(body_parts)
        + '<w:sectPr><w:bidi/><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>'
        "</w:sectPr>"
        "</w:body></w:document>"
    )
    output = project_root(state["id"]) / "exports" / f"{clean_name(request.get('name', ''))}.docx"
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES.encode("utf-8"))
        archive.writestr("_rels/.rels", _DOCX_ROOT_RELS.encode("utf-8"))
        archive.writestr("word/_rels/document.xml.rels", _DOCX_DOC_RELS.encode("utf-8"))
        archive.writestr("word/styles.xml", _DOCX_STYLES.encode("utf-8"))
        archive.writestr("word/document.xml", document_xml.encode("utf-8"))
    return output
