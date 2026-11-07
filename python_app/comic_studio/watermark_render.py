"""Backend PIL watermark renderer (Persian/English text + transparent logo) for DOCX, PPTX, PDF & ZIP."""
from __future__ import annotations

import base64
import binascii
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


@functools.lru_cache(maxsize=32)
def _load_watermark_font(px_size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    clamped = max(8, min(320, int(px_size)))
    for candidate in (
        STATIC_DIR / "assets" / "Vazirmatn.woff2",
        PACKAGE_DIR / "assets" / "Vazirmatn.woff2",
    ):
        if candidate.is_file():
            try:
                return ImageFont.truetype(str(candidate), clamped)
            except Exception:
                pass
    return ImageFont.load_default()


def has_active_watermark(watermark: Any) -> bool:
    if not isinstance(watermark, dict) or not watermark.get("enabled"):
        return False
    mode = str(watermark.get("mode") or "text")
    has_text = mode in {"text", "both"} and bool(str(watermark.get("text") or "").strip())
    has_logo = mode in {"image", "both"} and bool(watermark.get("logoId") or watermark.get("logoDataUrl"))
    return has_text or has_logo


def _parse_rgb(color: Any) -> tuple[int, int, int]:
    m = _HEX_RE.match(str(color or "").strip())
    if m:
        hx = m.group(1)
        return int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
    return 255, 255, 255


def _decode_logo_image(watermark: dict[str, Any], logos_map: dict[str, Any] | None) -> Image.Image | None:
    raw = str(watermark.get("logoDataUrl") or "").strip()
    if not raw and watermark.get("logoId") and isinstance(logos_map, dict):
        raw = str(logos_map.get(str(watermark["logoId"])) or "").strip()
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

    mode = str(wm.get("mode") or "text")
    raw_text = str(wm.get("text") or "").strip() if mode in {"text", "both"} else ""
    logo_rgba = _decode_logo_image(wm, logos_map) if mode in {"image", "both"} else None
    if not raw_text and logo_rgba is None:
        return image

    try:
        opacity = max(0.05, min(1.0, float(wm.get("opacity", 0.45))))
        logical_size = max(10.0, min(140.0, float(wm.get("size", 28))))
        position = str(wm.get("position") or "bottom-left")
        raw_angle = float(wm.get("angle", -30.0 if position in {"diagonal", "tile"} else 0.0))
        angle_deg = max(-90.0, min(90.0, raw_angle))
        rgb = _parse_rgb(wm.get("color") or "#ffffff")
        outline = wm.get("outline", True) is not False
        bg_pill = bool(wm.get("bgPill", False))

        ref_dim = max(480.0, min(1800.0, float(min(W, H))))
        scale_factor = ref_dim / 1000.0
        font_px = max(12, round(logical_size * scale_factor))
        font = _load_watermark_font(font_px)

        shaped_text = shape_visual_text(raw_text) if raw_text else ""
        dummy = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
        text_w = text_h = 0
        text_bbox = (0, 0, 0, 0)
        if shaped_text:
            text_bbox = dummy.multiline_textbbox((0, 0), shaped_text, font=font, align="center", spacing=max(2, font_px // 5))
            text_w = max(1, int(math.ceil(text_bbox[2] - text_bbox[0])))
            text_h = max(1, int(math.ceil(text_bbox[3] - text_bbox[1])))

        scaled_logo: Image.Image | None = None
        logo_w = logo_h = 0
        if logo_rgba is not None:
            target_logo_h = max(18, round(font_px * (1.85 if shaped_text else 2.6)))
            ratio = min(target_logo_h / max(1, logo_rgba.height), (W * 0.45) / max(1, logo_rgba.width))
            logo_w = max(8, round(logo_rgba.width * ratio))
            logo_h = max(8, round(logo_rgba.height * ratio))
            scaled_logo = logo_rgba.resize((logo_w, logo_h), Image.Resampling.LANCZOS)

        gap = round(font_px * 0.4) if (scaled_logo is not None and shaped_text) else 0
        pad_x = round(font_px * (0.65 if bg_pill else 0.35))
        pad_y = round(font_px * (0.42 if bg_pill else 0.28))
        content_w = logo_w + gap + text_w
        content_h = max(logo_h, text_h)
        stamp_w = max(8, content_w + pad_x * 2)
        stamp_h = max(8, content_h + pad_y * 2)

        stamp = Image.new("RGBA", (stamp_w, stamp_h), (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(stamp)

        lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
        contrast_rgb = (12, 16, 24) if lum > 140 else (250, 250, 252)

        if bg_pill:
            pill_alpha = max(18, min(230, round(155 * opacity)))
            radius = max(6, min(stamp_h // 2, round(font_px * 0.45)))
            sdraw.rounded_rectangle(
                [1, 1, stamp_w - 2, stamp_h - 2],
                radius=radius,
                fill=(*contrast_rgb, pill_alpha),
            )

        cur_x = pad_x
        if scaled_logo is not None:
            if opacity < 0.999:
                r_ch, g_ch, b_ch, a_ch = scaled_logo.split()
                a_ch = a_ch.point(lambda p: round(p * opacity))
                logo_to_paste = Image.merge("RGBA", (r_ch, g_ch, b_ch, a_ch))
            else:
                logo_to_paste = scaled_logo
            ly = (stamp_h - logo_h) // 2
            stamp.alpha_composite(logo_to_paste, (cur_x, ly))
            if logo_to_paste is not scaled_logo:
                logo_to_paste.close()
            cur_x += logo_w + gap

        if shaped_text:
            tx = cur_x - int(text_bbox[0])
            ty = (stamp_h - text_h) // 2 - int(text_bbox[1])
            txt_alpha = max(12, min(255, round(255 * opacity)))
            stroke_w = max(1, round(font_px / 13)) if outline else 0
            stroke_fill = (*contrast_rgb, max(12, min(245, round(215 * opacity)))) if outline else None
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
        margin = max(12, round(min(W, H) * 0.028))

        if position == "tile":
            step_x = max(sw + round(font_px * 2.2), round(W * 0.34))
            step_y = max(sh + round(font_px * 2.0), round(H * 0.24))
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
