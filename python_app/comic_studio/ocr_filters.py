"""Optional, geometry-preserving filters for temporary OCR input only."""
from __future__ import annotations

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


def prepare_ocr_photo(
    image: Image.Image, *, sharpen: bool = False, contrast: bool = True,
    contrast_strength: float = 1.0, page_mode: str = "auto",
) -> Image.Image:
    """Return the caller's image for legacy defaults, otherwise an owned RGB copy.

    1.0 preserves the existing engine contrast path. Custom contrast replaces
    that path with autocontrast followed by the requested luminance factor.
    Sharpening improves mild blur; it cannot reconstruct lost photographic detail.
    """
    custom_contrast = contrast and contrast_strength != 1.0
    if not sharpen and not custom_contrast:
        return image
    if not 0.5 <= contrast_strength <= 3.0:
        raise ValueError("contrast_strength must be between 0.5 and 3.0")
    work = image.convert("RGBA")
    try:
        background = Image.new("RGB", image.size, "white")
        try:
            background.paste(work, mask=work.getchannel("A"))
        except BaseException:
            background.close()
            raise
    finally:
        work.close()
    work = background
    try:
        if custom_contrast:
            adjusted = ImageOps.autocontrast(work, cutoff=(0, 1) if page_mode == "document" else 1)
            work.close()
            work = adjusted
            adjusted = ImageEnhance.Contrast(work).enhance(contrast_strength)
            work.close()
            work = adjusted
        if sharpen:
            adjusted = work.filter(ImageFilter.UnsharpMask(radius=1.5, percent=150, threshold=3))
            work.close()
            work = adjusted
        return work
    except BaseException:
        work.close()
        raise
