"""Backend PIL watermark renderer (Persian/English text + transparent logo) for DOCX, PPTX, PDF & ZIP."""
from __future__ import annotations

import base64
import binascii
import contextlib
import functools
import io
import math
import re
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from .paths import PACKAGE_DIR, STATIC_DIR

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")
_ARABIC_RANGE_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]")

# Contextual Presentation Forms: (isolated, final, initial, medial)
# Right-joining only letters have initial=None, medial=None.
_ARABIC_FORMS: dict[str, tuple[str, str, str | None, str | None]] = {
    "\u0621": ("\uFE80", "\uFE80", None, None),
    "\u0622": ("\uFE81", "\uFE82", None, None),
    "\u0623": ("\uFE83", "\uFE84", None, None),
    "\u0624": ("\uFE85", "\uFE86", None, None),
    "\u0625": ("\uFE87", "\uFE88", None, None),
    "\u0626": ("\uFE89", "\uFE8A", "\uFE8B", "\uFE8C"),
    "\u0627": ("\uFE8D", "\uFE8E", None, None),
    "\u0628": ("\uFE8F", "\uFE90", "\uFE91", "\uFE92"),
    "\u067E": ("\uFB56", "\uFB57", "\uFB58", "\uFB59"),  # پ
    "\u0629": ("\uFE93", "\uFE94", None, None),
    "\u062A": ("\uFE95", "\uFE96", "\uFE97", "\uFE98"),
    "\u062B": ("\uFE99", "\uFE9A", "\uFE9B", "\uFE9C"),
    "\u062C": ("\uFE9D", "\uFE9E", "\uFE9F", "\uFEA0"),
    "\u0686": ("\uFB7A", "\uFB7B", "\uFB7C", "\uFB7D"),  # چ
    "\u062D": ("\uFEA1", "\uFEA2", "\uFEA3", "\uFEA4"),
    "\u062E": ("\uFEA5", "\uFEA6", "\uFEA7", "\uFEA8"),
    "\u062F": ("\uFEA9", "\uFEAA", None, None),
    "\u0630": ("\uFEAB", "\uFEAC", None, None),
    "\u0631": ("\uFEAD", "\uFEAE", None, None),
    "\u0632": ("\uFEAF", "\uFEB0", None, None),
    "\u0698": ("\uFB8A", "\uFB8B", None, None),          # ژ
    "\u0633": ("\uFEB1", "\uFEB2", "\uFEB3", "\uFEB4"),
    "\u0634": ("\uFEB5", "\uFEB6", "\uFEB7", "\uFEB8"),
    "\u0635": ("\uFEB9", "\uFEBA", "\uFEBB", "\uFEBC"),
    "\u0636": ("\uFEBD", "\uFEBE", "\uFEBF", "\uFEC0"),
    "\u0637": ("\uFEC1", "\uFEC2", "\uFEC3", "\uFEC4"),
    "\u0638": ("\uFEC5", "\uFEC6", "\uFEC7", "\uFEC8"),
    "\u0639": ("\uFEC9", "\uFECA", "\uFECB", "\uFECC"),
    "\u063A": ("\uFECD", "\uFECE", "\uFECF", "\uFED0"),
    "\u0640": ("\u0640", "\u0640", "\u0640", "\u0640"),  # tatweel
    "\u0641": ("\uFED1", "\uFED2", "\uFED3", "\uFED4"),
    "\u0642": ("\uFED5", "\uFED6", "\uFED7", "\uFED8"),
    "\u06A9": ("\uFB8E", "\uFB8F", "\uFB90", "\uFB91"),  # ک
    "\u0643": ("\uFED9", "\uFEDA", "\uFEDB", "\uFEDC"),
    "\u06AF": ("\uFB92", "\uFB93", "\uFB94", "\uFB95"),  # گ
    "\u0644": ("\uFEDD", "\uFEDE", "\uFEDF", "\uFEE0"),
    "\u0645": ("\uFEE1", "\uFEE2", "\uFEE3", "\uFEE4"),
    "\u0646": ("\uFEE5", "\uFEE6", "\uFEE7", "\uFEE8"),
    "\u0647": ("\uFEE9", "\uFEEA", "\uFEEB", "\uFEEC"),
    "\u06BE": ("\uFBAA", "\uFBAB", "\uFBAC", "\uFBAD"),
    "\u06C0": ("\uFBA4", "\uFBA5", None, None),
    "\u0648": ("\uFEED", "\uFEEE", None, None),
    "\u0649": ("\uFEEF", "\uFEF0", None, None),
    "\u06CC": ("\uFBFC", "\uFBFD", "\uFBFE", "\uFBFF"),  # ی
    "\u064A": ("\uFEF1", "\uFEF2", "\uFEF3", "\uFEF4"),
}

_LAM_ALEF_LIGATURES: dict[str, tuple[str, str]] = {
    "\u0622": ("\uFEF5", "\uFEF6"),
    "\u0623": ("\uFEF7", "\uFEF8"),
    "\u0625": ("\uFEF9", "\uFEFA"),
    "\u0627": ("\uFEFB", "\uFEFC"),
}

_TRANSPARENT_COMBINING = frozenset(chr(c) for c in range(0x064B, 0x0660)) | {"\u0670"}


def _joins_left(ch: str) -> bool:
    forms = _ARABIC_FORMS.get(ch)
    return bool(forms and forms[2] is not None)


def _joins_right(ch: str) -> bool:
    return ch in _ARABIC_FORMS and ch != "\u0621"


def shape_visual_text(text: str) -> str:
    """Shape Persian/Arabic ligatures & apply Unicode BiDi for non-Raqm Pillow builds."""
    raw = str(text or "")
    if not raw or not _ARABIC_RANGE_RE.search(raw):
        return raw

    lines_out: list[str] = []
    for line in raw.splitlines():
        chars = list(line)
        n = len(chars)
        shaped: list[str] = []
        i = 0
        while i < n:
            ch = chars[i]
            if ch not in _ARABIC_FORMS:
                shaped.append(ch)
                i += 1
                continue

            # Find previous non-combining char
            p_idx = i - 1
            while p_idx >= 0 and chars[p_idx] in _TRANSPARENT_COMBINING:
                p_idx -= 1
            prev_joins = p_idx >= 0 and _joins_left(chars[p_idx])

            # Check Lam + Alef ligature
            if ch == "\u0644":
                nx = i + 1
                while nx < n and chars[nx] in _TRANSPARENT_COMBINING:
                    nx += 1
                if nx < n and chars[nx] in _LAM_ALEF_LIGATURES:
                    iso_lig, fin_lig = _LAM_ALEF_LIGATURES[chars[nx]]
                    shaped.append(fin_lig if prev_joins else iso_lig)
                    # Preserve any combining marks between Lam and Alef
                    for mid in range(i + 1, nx):
                        shaped.append(chars[mid])
                    i = nx + 1
                    continue

            n_idx = i + 1
            while n_idx < n and chars[n_idx] in _TRANSPARENT_COMBINING:
                n_idx += 1
            next_joins = _joins_left(ch) and n_idx < n and _joins_right(chars[n_idx])

            iso, fin, ini, med = _ARABIC_FORMS[ch]
            if prev_joins and next_joins and med:
                shaped.append(med)
            elif prev_joins and fin:
                shaped.append(fin)
            elif next_joins and ini:
                shaped.append(ini)
            else:
                shaped.append(iso)
            i += 1

        joined = "".join(shaped).replace("\u200c", "")
        try:
            from bidi.algorithm import get_display
            lines_out.append(str(get_display(joined)))
        except Exception:
            lines_out.append(joined[::-1])
    return "\n".join(lines_out)


@functools.lru_cache(maxsize=64)
def _load_watermark_font(px_size: int, bold: bool = True) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    clamped = max(8, min(320, int(px_size)))
    for candidate in (
        STATIC_DIR / "assets" / "Vazirmatn.woff2",
        PACKAGE_DIR / "assets" / "Vazirmatn.woff2",
    ):
        if candidate.is_file():
            try:
                font = ImageFont.truetype(str(candidate), clamped)
                with contextlib.suppress(Exception):
                    font.set_variation_by_axes([700 if bold else 400])
                return font
            except Exception:
                pass
    return ImageFont.load_default()


def _explicit_watermark_mode(watermark: dict[str, Any]) -> str | None:
    raw = str(watermark.get("mode") or "").strip().lower()
    return raw if raw in {"text", "image", "both"} else None


def has_active_watermark(watermark: Any) -> bool:
    if not isinstance(watermark, dict) or not watermark.get("enabled"):
        return False
    mode = _explicit_watermark_mode(watermark)
    raw_text = bool(str(watermark.get("text") or "").strip())
    raw_logo = bool(str(watermark.get("logoId") or "").strip() or str(watermark.get("logoDataUrl") or "").strip())
    if mode is not None:
        has_text = mode in {"text", "both"} and raw_text
        has_logo = mode in {"image", "both"} and raw_logo
        return has_text or has_logo
    return raw_text or raw_logo


def _parse_rgb_opt(color: Any) -> tuple[int, int, int] | None:
    m = _HEX_RE.match(str(color or "").strip())
    if m:
        hx = m.group(1)
        return int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
    return None


def _parse_rgb(color: Any) -> tuple[int, int, int]:
    return _parse_rgb_opt(color) or (255, 255, 255)


def _decode_logo_image(watermark: dict[str, Any], logos_map: dict[str, Any] | None) -> Image.Image | None:
    raw = str(watermark.get("logoDataUrl") or "").strip()
    if not raw and watermark.get("logoId") and isinstance(logos_map, dict):
        entry = logos_map.get(str(watermark["logoId"]).strip())
        if isinstance(entry, dict):
            raw = str(entry.get("dataUrl") or entry.get("logoDataUrl") or entry.get("url") or "").strip()
        elif isinstance(entry, str):
            raw = entry.strip()
    if not raw:
        return None
    if raw.startswith("data:"):
        comma = raw.find(",")
        if comma < 0:
            return None
        b64_part = raw[comma + 1:]
    else:
        b64_part = raw
    if len(b64_part) > 8 * 1024 * 1024:
        return None
    try:
        binary = base64.b64decode(b64_part, validate=False)
        with Image.open(io.BytesIO(binary)) as opened:
            return opened.convert("RGBA")
    except (OSError, ValueError, binascii.Error):
        return None


def apply_watermark_pil(
    image: Image.Image,
    watermark: Any,
    logos_map: dict[str, Any] | None = None,
) -> Image.Image:
    """Return a new image (preserving image.mode) with `watermark` composited if active."""
    if not has_active_watermark(watermark):
        return image
    wm: dict[str, Any] = watermark
    W, H = image.size
    if W < 4 or H < 4:
        return image

    mode = _explicit_watermark_mode(wm)
    allow_text = mode in {None, "text", "both"}
    allow_logo = mode in {None, "image", "both"}
    raw_text = str(wm.get("text") or "").strip() if allow_text else ""
    logo_rgba = _decode_logo_image(wm, logos_map) if allow_logo else None
    if not raw_text and logo_rgba is None:
        return image

    try:
        try:
            raw_opacity = float(wm.get("opacity", 55))
        except (TypeError, ValueError):
            raw_opacity = 55.0
        if raw_opacity > 1.0:
            raw_opacity /= 100.0
        opacity = max(0.05, min(1.0, raw_opacity))

        min_dim = max(200.0, float(min(W, H)))
        if wm.get("sizePct") is not None:
            try:
                scale_pct = max(1.0, min(25.0, float(wm.get("sizePct") or 3.5)))
            except (TypeError, ValueError):
                scale_pct = 3.5
            font_px = max(12, round(min_dim * (scale_pct / 100.0)))
        else:
            logical_size = max(10.0, min(140.0, float(wm.get("size", 28))))
            ref_dim = max(480.0, min(1800.0, float(min(W, H))))
            font_px = max(12, round(logical_size * (ref_dim / 1000.0)))
            scale_pct = max(1.0, min(25.0, (font_px / min_dim) * 100.0))

        position = str(wm.get("position") or "bottom-left")
        default_angle = -30.0 if position in {"diagonal", "tile"} else 0.0
        raw_angle_val = wm.get("angle")
        try:
            raw_angle = float(raw_angle_val) if raw_angle_val is not None and raw_angle_val != "" else default_angle
        except (TypeError, ValueError):
            raw_angle = default_angle
        angle_deg = max(-90.0, min(90.0, raw_angle))

        bold = wm.get("bold", True) is not False
        rgb = _parse_rgb(wm.get("color") or "#ffffff")
        lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
        contrast_rgb = (12, 16, 24) if lum > 140 else (250, 250, 252)
        outline = wm.get("outline", True) is not False
        outline_rgb = _parse_rgb_opt(wm.get("outlineColor")) or contrast_rgb
        bg_pill = bool(wm.get("bgPill", False))
        bg_rgb = _parse_rgb_opt(wm.get("bgColor")) or contrast_rgb

        font = _load_watermark_font(font_px, bold=bold)
        is_rtl = bool(_ARABIC_RANGE_RE.search(raw_text))
        shaped_text = shape_visual_text(raw_text) if raw_text else ""
        text_w = text_h = 0
        text_bbox = (0, 0, 0, 0)
        if shaped_text:
            dummy_img = Image.new("RGBA", (4, 4))
            try:
                dummy = ImageDraw.Draw(dummy_img)
                text_bbox = dummy.multiline_textbbox((0, 0), shaped_text, font=font, align="center", spacing=max(2, font_px // 5))
            finally:
                dummy_img.close()
            text_w = max(1, int(math.ceil(text_bbox[2] - text_bbox[0])))
            text_h = max(1, int(math.ceil(text_bbox[3] - text_bbox[1])))

        scaled_logo: Image.Image | None = None
        logo_w = logo_h = 0
        if logo_rgba is not None:
            if wm.get("logoScalePct") is not None:
                try:
                    logo_scale_pct = max(2.0, min(45.0, float(wm.get("logoScalePct") or max(6.0, scale_pct * 2.2))))
                except (TypeError, ValueError):
                    logo_scale_pct = max(6.0, scale_pct * 2.2)
                target_max = max(20, round(min_dim * (logo_scale_pct / 100.0)))
                ratio = min(target_max / max(1, logo_rgba.width), target_max / max(1, logo_rgba.height))
            else:
                target_logo_h = max(18, round(font_px * (1.85 if shaped_text else 2.6)))
                ratio = min(target_logo_h / max(1, logo_rgba.height), (W * 0.45) / max(1, logo_rgba.width))
            logo_w = max(8, round(logo_rgba.width * ratio))
            logo_h = max(8, round(logo_rgba.height * ratio))
            scaled_logo = logo_rgba.resize((logo_w, logo_h), Image.Resampling.LANCZOS)

        gap = max(6, round(font_px * 0.42)) if (scaled_logo is not None and shaped_text) else 0
        pad_x = max(10, round(font_px * 0.58)) if bg_pill else max(4, round(font_px * 0.25))
        pad_y = max(6, round(font_px * 0.36)) if bg_pill else max(4, round(font_px * 0.22))
        content_w = logo_w + gap + text_w
        content_h = max(logo_h, text_h, 1)
        stamp_w = max(8, content_w + pad_x * 2)
        stamp_h = max(8, content_h + pad_y * 2)

        stamp = Image.new("RGBA", (stamp_w, stamp_h), (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(stamp)

        if bg_pill:
            pill_alpha = max(18, min(230, round(255 * opacity * 0.58)))
            radius = max(6, min(stamp_h // 2, round(font_px * 0.42)))
            sdraw.rounded_rectangle(
                [1, 1, stamp_w - 2, stamp_h - 2],
                radius=radius,
                fill=(*bg_rgb, pill_alpha),
            )

        # Match Typeset.drawWatermarkStamp: in RTL place logo on the right of text; in LTR on the left.
        if is_rtl and scaled_logo is not None and shaped_text:
            text_left = pad_x
            logo_left = pad_x + text_w + gap
        else:
            logo_left = pad_x
            text_left = pad_x + (logo_w + gap if scaled_logo is not None else 0)

        if scaled_logo is not None:
            if opacity < 0.999:
                r_ch, g_ch, b_ch, a_ch = scaled_logo.split()
                a_ch = a_ch.point(lambda p: round(p * opacity))
                logo_to_paste = Image.merge("RGBA", (r_ch, g_ch, b_ch, a_ch))
            else:
                logo_to_paste = scaled_logo
            ly = (stamp_h - logo_h) // 2
            stamp.alpha_composite(logo_to_paste, (logo_left, ly))
            if logo_to_paste is not scaled_logo:
                logo_to_paste.close()

        if shaped_text:
            tx = text_left - int(text_bbox[0])
            ty = (stamp_h - text_h) // 2 - int(text_bbox[1])
            txt_alpha = max(12, min(255, round(255 * opacity)))
            stroke_w = max(1, round(font_px / 13)) if outline else 0
            stroke_fill = (*outline_rgb, max(12, min(245, round(215 * opacity)))) if outline else None
            sdraw.multiline_text(
                (tx, ty),
                shaped_text,
                font=font,
                fill=(*rgb, txt_alpha),
                align="center",
                spacing=max(2, font_px // 5),
                stroke_width=stroke_w,
                stroke_fill=stroke_fill,
            )

        if scaled_logo is not None:
            scaled_logo.close()

        effective_angle = angle_deg
        if abs(effective_angle) > 0.25:
            # PIL rotates counter-clockwise for positive degrees; CSS/Canvas rotates clockwise for positive degrees.
            rotated = stamp.rotate(-effective_angle, resample=Image.Resampling.BICUBIC, expand=True)
            stamp.close()
            stamp = rotated

        base_rgba = image.convert("RGBA")
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sw, sh = stamp.size
        try:
            margin_pct = max(0.5, min(20.0, float(wm.get("marginPct") if wm.get("marginPct") is not None else 2.5)))
        except (TypeError, ValueError):
            margin_pct = 2.5
        margin = max(8, round(min_dim * (margin_pct / 100.0)))

        if position == "tile":
            try:
                tile_gap_pct = max(6.0, min(60.0, float(wm.get("tileGapPct") or 22.0)))
            except (TypeError, ValueError):
                tile_gap_pct = 22.0
            step_x = max(sw + 28, round(W * (tile_gap_pct / 100.0)) + round(sw * 0.55))
            step_y = max(sh + 24, round(H * (tile_gap_pct / 100.0) * 0.85) + round(sh * 0.55))
            row = 0
            for cy in range(-sh // 2, H + sh, step_y):
                row_shift = (step_x // 2) if (row % 2 == 1) else 0
                for cx in range(-sw // 2 + row_shift, W + sw, step_x):
                    px, py = cx - sw // 2, cy - sh // 2
                    if px + sw > 0 and py + sh > 0 and px < W and py < H:
                        overlay.alpha_composite(stamp, (px, py))
                row += 1
        else:
            if position == "top-left":
                px, py = margin, margin
            elif position == "top-right":
                px, py = W - sw - margin, margin
            elif position == "bottom-right":
                px, py = W - sw - margin, H - sh - margin
            elif position in {"center", "diagonal"}:
                px, py = (W - sw) // 2, (H - sh) // 2
            else:  # bottom-left default
                px, py = margin, H - sh - margin
            px = max(-sw + 4, min(W - 4, px))
            py = max(-sh + 4, min(H - 4, py))
            overlay.alpha_composite(stamp, (px, py))

        stamp.close()
        composited = Image.alpha_composite(base_rgba, overlay)
        base_rgba.close()
        overlay.close()
        if image.mode == "RGBA":
            return composited
        converted = composited.convert(image.mode if image.mode in {"RGB", "L"} else "RGB")
        composited.close()
        return converted
    finally:
        if logo_rgba is not None:
            logo_rgba.close()
