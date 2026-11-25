"""Optional, geometry-preserving filters for temporary OCR input only."""
from __future__ import annotations

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


def _binarize_document(image: Image.Image, strength: float = 1.0) -> Image.Image:
    """Local thresholding for dark text on light paper, without resizing/erosion."""
    import cv2
    import numpy as np

    with ImageOps.grayscale(image) as gray:
        with ImageOps.autocontrast(gray, cutoff=0) as normalized:
            with ImageEnhance.Contrast(normalized).enhance(strength) as enhanced:
                pixels = np.asarray(enhanced)
                # An odd local window follows uneven paper illumination. Small
                # crops need a smaller window; tiny images use a global fallback.
                side = min(51, min(image.size))
                side -= 1 - side % 2
                if side >= 3:
                    binary = cv2.adaptiveThreshold(
                        pixels, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                        cv2.THRESH_BINARY, side, 7,
                    )
                else:
                    _, binary = cv2.threshold(pixels, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    with Image.fromarray(binary) as output:
        return output.convert("RGB")


def prepare_ocr_photo(
    image: Image.Image, *, sharpen: bool = False, contrast: bool = True,
    contrast_strength: float = 1.0, page_mode: str = "auto",
    document_binarize: bool = False,
) -> Image.Image:
    """Return the caller's image for legacy defaults, otherwise an owned RGB copy.

    1.0 preserves the existing engine contrast path. Custom contrast replaces
    that path with autocontrast followed by the requested luminance factor.
    Optional document binarization runs after sharpening and replaces the
    engine contrast pass. Sharpening improves mild blur; it cannot reconstruct lost photographic detail.
    """
    custom_contrast = contrast and contrast_strength != 1.0
    if not sharpen and not custom_contrast and not document_binarize:
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
        if custom_contrast and not document_binarize:
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
        if document_binarize:
            adjusted = _binarize_document(work, contrast_strength if contrast else 1.0)
            work.close()
            work = adjusted
        return work
    except BaseException:
        work.close()
        raise
