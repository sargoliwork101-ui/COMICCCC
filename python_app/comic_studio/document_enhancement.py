"""Opt-in Books & Articles preprocessing; no model-based image synthesis."""
from __future__ import annotations

import copy
from typing import Literal, Callable, Any

from PIL import Image, ImageFilter
from pydantic import BaseModel, ConfigDict, Field, model_validator

Stage = Literal['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'threshold']
STAGES = ['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'threshold']
MAX_PIXELS = 16_000_000


class EnhancementError(ValueError):
    """Safe, actionable message; never include paths or native diagnostics."""


def check_size(size: tuple[int, int], factor: int = 1) -> None:
    width, height = size
    target_w, target_h = width * factor, height * factor
    if target_w * target_h > MAX_PIXELS:
        action = ('ضریب بزرگ‌نمایی را کمتر یا فیلتر بزرگ‌نمایی را خاموش کنید.'
                  if factor > 1 else 'برای این صفحه، نسخه‌ای کوچک‌تر یا یک برش از متن وارد کنید.')
        raise EnhancementError(
            f'اندازهٔ صفحه {width} × {height} پیکسل است؛ '
            f'خروجی {target_w} × {target_h} ({target_w * target_h / 1_000_000:.1f} مگاپیکسل) '
            f'از سقف ۱۶ مگاپیکسل بیشتر است. {action} تصویر خودکار کوچک نشده است.'
        )


class FilterSettings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra='forbid')
    enabled: bool = False


class Upscale(FilterSettings):
    factor: Literal[2, 3] = 2


class Clahe(FilterSettings):
    clip_limit: float = Field(default=2, ge=0.5, le=8)
    tile_grid: int = Field(default=8, ge=2, le=32)


class Denoise(FilterSettings):
    diameter: int = Field(default=5, ge=3, le=9)
    sigma_color: float = Field(default=25, ge=1, le=100)
    sigma_space: float = Field(default=25, ge=1, le=100)


class Unsharp(FilterSettings):
    amount: float = Field(default=1, ge=0, le=3)
    radius: float = Field(default=1, ge=0.3, le=4)


class Threshold(FilterSettings):
    method: Literal['sauvola', 'adaptive_otsu'] = 'sauvola'
    window: int = Field(default=51, ge=3, le=201)
    k: float = Field(default=0.2, ge=0.01, le=0.5)
    r: float = Field(default=128, ge=32, le=255)

    @model_validator(mode='after')
    def odd_window(self):
        if self.window % 2 == 0:
            raise ValueError('Threshold window must be odd')
        return self


class EnhancementSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = False
    order: list[Stage] = Field(default_factory=lambda: list(STAGES))
    upscale: Upscale = Field(default_factory=Upscale)
    grayscale: FilterSettings = Field(default_factory=FilterSettings)
    clahe: Clahe = Field(default_factory=Clahe)
    denoise: Denoise = Field(default_factory=Denoise)
    unsharp: Unsharp = Field(default_factory=Unsharp)
    threshold: Threshold = Field(default_factory=Threshold)

    @model_validator(mode='after')
    def valid_order(self):
        if len(self.order) != len(STAGES) or set(self.order) != set(STAGES):
            raise ValueError('Each filter must occur exactly once in the order')
        return self

    def active(self, page_mode: str) -> bool:
        return page_mode == 'document' and self.enabled and any(getattr(self, name).enabled for name in self.order)


def _array(image):
    import numpy as np
    return np.asarray(image)


def _upscale(image, settings):
    size = (image.width * settings.factor, image.height * settings.factor)
    # Size policy is enforced once by prepare_document, not by filters.
    return image.resize(size, Image.Resampling.LANCZOS)


def _grayscale(image, _settings):
    return image.convert('L')


def _clahe(image, settings):
    import cv2
    import numpy as np
    op = cv2.createCLAHE(clipLimit=settings.clip_limit, tileGridSize=(settings.tile_grid, settings.tile_grid))
    if image.mode == 'L':
        return Image.fromarray(op.apply(_array(image)))
    lab = cv2.cvtColor(_array(image), cv2.COLOR_RGB2LAB)
    lab[:, :, 0] = op.apply(np.ascontiguousarray(lab[:, :, 0]))
    return Image.fromarray(cv2.cvtColor(lab, cv2.COLOR_LAB2RGB))


def _denoise(image, settings):
    import cv2
    return Image.fromarray(cv2.bilateralFilter(_array(image), settings.diameter, settings.sigma_color, settings.sigma_space))


def _unsharp(image, settings):
    return image.filter(ImageFilter.UnsharpMask(radius=settings.radius, percent=round(settings.amount * 100), threshold=2))


def _threshold(image, settings):
    import cv2
    import numpy as np
    with image.convert('L') as gray_image:
        gray = np.array(gray_image)
    if settings.method == 'sauvola':
        pixels = gray.astype(np.float32)
        mean = cv2.boxFilter(pixels, -1, (settings.window, settings.window), borderType=cv2.BORDER_REPLICATE)
        variance = cv2.sqrBoxFilter(pixels, -1, (settings.window, settings.window), borderType=cv2.BORDER_REPLICATE)
        variance -= mean * mean
        np.maximum(variance, 0, out=variance)
        np.sqrt(variance, out=variance)
        threshold = mean * (1 + settings.k * (variance / settings.r - 1))
    else:
        # Otsu on overlapping local neighbourhoods, with interpolated thresholds
        # to avoid the hard seams of independently binarized tiles.
        h, w = gray.shape
        step = settings.window
        thresholds = np.empty(((h + step - 1) // step, (w + step - 1) // step), np.float32)
        for iy, y in enumerate(range(0, h, step)):
            for ix, x in enumerate(range(0, w, step)):
                region = gray[max(0, y - step // 2):min(h, y + step + step // 2), max(0, x - step // 2):min(w, x + step + step // 2)]
                thresholds[iy, ix], _ = cv2.threshold(region, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        threshold = cv2.resize(thresholds, (w, h), interpolation=cv2.INTER_LINEAR)
    return Image.fromarray(np.where(gray > threshold, 255, 0).astype(np.uint8))


FILTERS = dict(zip(STAGES, [_upscale, _grayscale, _clahe, _denoise, _unsharp, _threshold]))


def prepare_document(image: Image.Image, settings: EnhancementSettings, *, enforce_size_limit: bool = True) -> Image.Image:
    """Owned temporary image; caller closes it. A failed stage discards all work."""
    if enforce_size_limit:
        check_size(image.size)
        if settings.upscale.enabled:
            check_size(image.size, settings.upscale.factor)
    if image.mode in ('RGB', 'L'):
        work = image.copy()
    else:
        with image.convert('RGBA') as rgba:
            work = Image.new('RGB', image.size, 'white')
            with rgba.getchannel('A') as alpha:
                work.paste(rgba, mask=alpha)
    try:
        for name in settings.order:
            options = getattr(settings, name)
            if options.enabled:
                try:
                    updated = FILTERS[name](work, options)
                except (EnhancementError, MemoryError):
                    raise
                except Exception as exc:
                    from .activity import JobCancelledError
                    if isinstance(exc, JobCancelledError):
                        raise
                    raise EnhancementError(
                        f'فیلتر {name} اجرا نشد ({type(exc).__name__}). '
                        'این فیلتر را خاموش کنید و دوباره پیش‌نمایش بگیرید.'
                    ) from exc
                work.close()
                work = updated
        return work
    except Exception:
        work.close()
        raise


def restore_coordinates(blocks: list[dict], sx: float, sy: float) -> list[dict]:
    """Map geometry (including reversible source lines) to original pixels."""
    result = copy.deepcopy(blocks)
    def restore(block):
        for key in ('x0', 'x1', 'tx0', 'tx1'):
            if isinstance(block.get(key), (int, float)):
                block[key] /= sx
        for key in ('y0', 'y1', 'ty0', 'ty1', 'lineH'):
            if isinstance(block.get(key), (int, float)):
                block[key] /= sy
        if block.get('polygon'):
            block['polygon'] = [[x / sx, y / sy] for x, y in block['polygon']]
        for child in block.get('sourceLines') or []:
            restore(child)
    for block in result:
        restore(block)
    return result


def run_document_ocr(image: Image.Image, settings: EnhancementSettings | None, page_mode: str,
                     enhanced: Callable[[Image.Image], list[dict]], legacy: Callable[[], list[dict]],
                     warn: Callable[[str], Any]) -> list[dict]:
    # Zero image allocation/import of OpenCV in the disabled/non-document path.
    if settings is None or not settings.active(page_mode):
        return legacy()
    try:
        prepared = prepare_document(image, settings)
        try:
            blocks = enhanced(prepared)
            return restore_coordinates(blocks, prepared.width / image.width, prepared.height / image.height)
        finally:
            prepared.close()
    except Exception as exc:
        # Do not retry user cancellation or a failing fallback recursively.
        from .activity import JobCancelledError
        if isinstance(exc, JobCancelledError):
            raise
        warn(f'پیش‌پردازش کتاب اجرا نشد ({type(exc).__name__})؛ OCR با روش قبلی ادامه می‌یابد.')
    return legacy()
