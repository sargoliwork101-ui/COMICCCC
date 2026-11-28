"""Opt-in Books & Articles preprocessing; no model-based image synthesis."""
from __future__ import annotations

import copy
from typing import Literal, Callable, Any

from PIL import Image, ImageEnhance, ImageFilter
from pydantic import BaseModel, ConfigDict, Field, model_validator

Stage = Literal['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'threshold', 'contrast']
STAGES = ['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'threshold', 'contrast']
MAX_PIXELS = 16_000_000

# The order the classic filter chain is listed in: cheapest and most broadly
# useful first, heavier/edge-specialised stages later. Used when a caller only
# wants "a sensible order" and for sorting the analyser's proposals.
DEFAULT_ORDER = ['grayscale', 'denoise', 'clahe', 'contrast', 'upscale', 'unsharp', 'threshold']

# Two stages contradict each other: `threshold` outputs a 1-bit image, so a
# following `contrast`/`clahe`/`grayscale` cannot change a single pixel, and an
# `unsharp` after it only re-blurs the hard edges OCR wants. Measured on real
# output: threshold-then-contrast changed 0 of 1,080,000 pixels.
AFTER_THRESHOLD_POINTLESS = frozenset({'contrast', 'clahe', 'grayscale'})
# `threshold` itself must stay last when enabled: anything after it is either a
# no-op or destructive.
THRESHOLD_TERMINAL = frozenset({'threshold'})


class OrderIssue(BaseModel):
    """A stage in the current chain whose work is thrown away by a later one."""
    model_config = ConfigDict(extra='forbid')
    stage: Stage
    reason: Literal['after_threshold', 'threshold_not_last']
    message: str



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


class Contrast(FilterSettings):
    strength: float = Field(default=1, ge=0.5, le=3)


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
    despeckle_area: int = Field(default=0, ge=0, le=8)

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
    contrast: Contrast = Field(default_factory=Contrast)

    @model_validator(mode='before')
    @classmethod
    def migrate_order(cls, values):
        if isinstance(values, dict) and isinstance(values.get('order'), list):
            old = values['order']
            if len(old) == 6 and all(isinstance(name, str) for name in old) and set(old) == set(STAGES) - {'contrast'}:
                return {**values, 'order': [*old, 'contrast']}
        return values

    @model_validator(mode='after')
    def valid_order(self):
        if len(self.order) != len(STAGES) or set(self.order) != set(STAGES):
            raise ValueError('Each filter must occur exactly once in the order')
        return self

    def active(self, page_mode: str) -> bool:
        return page_mode == 'document' and self.enabled and any(getattr(self, name).enabled for name in self.order)

    def order_issues(self) -> list[OrderIssue]:
        """Stages whose output a later stage throws away.

        Reported, never silently "fixed": the user may have a reason, and the
        analyser offers a corrected order they can accept explicitly.
        """
        issues: list[OrderIssue] = []
        enabled = [name for name in self.order if getattr(self, name).enabled]
        if 'threshold' not in enabled:
            return issues
        after = [name for name in enabled if enabled.index(name) > enabled.index('threshold')]
        for name in after:
            if name in AFTER_THRESHOLD_POINTLESS:
                issues.append(OrderIssue(
                    stage=name, reason='after_threshold',
                    message=f'«{FILTER_LABELS[name]}» بعد از «سیاه‌وسفید تطبیقی» اجرا می‌شود، ولی خروجی آن مرحله فقط سیاه و سفید است؛ '
                            f'پس این مرحله هیچ پیکسلی را عوض نمی‌کند.',
                ))
            elif name == 'unsharp':
                issues.append(OrderIssue(
                    stage=name, reason='after_threshold',
                    message='«وضوح لبه» بعد از «سیاه‌وسفید تطبیقی» فقط لبه‌های سخت را نرم می‌کند و کار مفیدی انجام نمی‌دهد.',
                ))
        return issues


FILTER_LABELS = {
    'upscale': 'بزرگ‌نمایی', 'grayscale': 'خاکستری', 'clahe': 'کنتراست موضعی',
    'denoise': 'کاهش نویز', 'unsharp': 'وضوح لبه',
    'threshold': 'سیاه‌وسفید تطبیقی', 'contrast': 'کنتراست معمولی',
}


def normalize_order(order: list[str], enabled: dict[str, bool] | None = None) -> list[str]:
    """Return a dependency-safe order, keeping the user's relative choices.

    Only ordering that provably matters is changed: `threshold` moves to the
    end, because every other stage after it is a measured no-op or a blur.
    Everything else keeps its existing relative position, so a deliberate
    `denoise`-before-`upscale` preference survives.
    """
    current = [name for name in order if name in STAGES]
    for name in STAGES:
        if name not in current:
            current.append(name)
    if 'threshold' not in current:
        return current
    rest = [name for name in current if name != 'threshold']
    return [*rest, 'threshold']


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
    binary = np.where(gray > threshold, 255, 0).astype(np.uint8)
    if settings.despeckle_area:
        binary = _remove_speckles(binary, settings.despeckle_area)
    return Image.fromarray(binary)


def _remove_speckles(binary, max_area):
    """Opt-in tiny isolated black components only, never erode letter strokes.

    Punctuation/small diacritics can also be tiny, so this is disabled by default.
    The area is measured at the current pipeline resolution (after upscaling).
    """
    import cv2
    import numpy as np
    count, labels, stats, _ = cv2.connectedComponentsWithStats(
        (binary == 0).astype(np.uint8), connectivity=8,
    )
    remove = np.zeros(count, dtype=bool)
    remove[1:] = ((stats[1:, cv2.CC_STAT_AREA] <= max_area)
                  & (stats[1:, cv2.CC_STAT_WIDTH] <= 3)
                  & (stats[1:, cv2.CC_STAT_HEIGHT] <= 3))
    result = binary.copy()
    result[remove[labels]] = 255
    return result


def _contrast(image, settings):
    return ImageEnhance.Contrast(image).enhance(settings.strength)


FILTERS = dict(zip(STAGES, [_upscale, _grayscale, _clahe, _denoise, _unsharp, _threshold, _contrast]))


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


# --------------------------------------------------------------------------
# Page analysis: propose a starting configuration for this page.
# --------------------------------------------------------------------------
# These are image statistics, not a measurement of OCR accuracy. Every proposal
# is explicitly a starting point the user confirms in the OCR dialog; nothing
# here is allowed to claim or imply a guaranteed accuracy gain.

def _profile(image: Image.Image) -> dict[str, float]:
    import cv2
    import numpy as np

    with image.convert('L') as gray_image:
        gray = np.asarray(gray_image, dtype=np.float32)
    if gray.size == 0:
        raise EnhancementError('این صفحه تصویری برای تحلیل ندارد.')
    # Downscale huge scans: statistics are scale-invariant and this keeps the
    # analysis cheap enough to run while the user is looking at the dialog.
    h, w = gray.shape
    if max(h, w) > 1400:
        scale = 1400 / max(h, w)
        gray = cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)

    # Percentiles rather than min/max so a single speck of dust cannot define
    # "paper white" or "ink black". The paper reference is the brightest mode;
    # the ink reference must come from the darkest tail of the *content*, not
    # from a fixed percentile, otherwise a washed-out scan reports that it has
    # no contrast at all (its darkest 5% is still paper).
    paper = float(np.percentile(gray, 90))
    ink = float(gray.min())
    # Use the 2nd percentile of the whole page but only trust it when it is
    # clearly below the paper; fall back to the true minimum for faded ink.
    dark_tail = float(np.percentile(gray, 2))
    if dark_tail > paper - 8:
        dark_tail = ink
    contrast = max(paper - dark_tail, 1.0)

    # Text pixels as a fraction of the page. Very low means the page is mostly
    # blank or a drawing; very high means a dark scan or a photo.
    ink_ratio = float((gray < paper - contrast * 0.35).mean())

    # Noise: median absolute deviation of the second difference. Extremely
    # cheap and insensitive to text (which is a small fraction of pixels).
    residual = np.abs(gray[1:-1, 1:-1] * 4 - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:])
    noise = float(np.median(residual)) if residual.size else 0.0

    # Blur: a sharp edge jumps from paper to ink in a pixel or two, so its
    # gradient reaches several times the page contrast. Blur spreads that jump
    # over many pixels and the peak gradient collapses. Measuring the peak
    # against page contrast (not against the mean, which also falls) keeps this
    # independent of how dark or faded the scan is: a low-contrast page that is
    # still sharp scores the same as a crisp black one.
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gx, gy)
    edge_peak_ratio = float(np.percentile(magnitude, 99.9)) / contrast
    # Calibrated on measured output: ~4.2 crisp, ~2.7 at 1px blur, ~1.9 at 1.6px.
    blur = float(np.clip((3.6 - edge_peak_ratio) / 1.8, 0.0, 1.0))

    # Illumination unevenness: brightness of the paper across a coarse grid.
    tile_h = max(1, h // 6)
    tile_w = max(1, w // 6)
    tiles = []
    for ty in range(0, h - tile_h + 1, tile_h):
        for tx in range(0, w - tile_w + 1, tile_w):
            block = gray[ty:ty + tile_h, tx:tx + tile_w]
            tiles.append(float(np.percentile(block, 90)))
    tile_spread = float(np.percentile(tiles, 95) - np.percentile(tiles, 5)) if tiles else 0.0

    return {
        'paper': round(paper, 1),
        'ink': round(ink, 1),
        'contrast': round(contrast, 1),
        'ink_ratio': round(ink_ratio, 4),
        'noise': round(noise, 2),
        'blur': round(blur, 3),
        'edge_peak_ratio': round(edge_peak_ratio, 1),
        'tile_spread': round(tile_spread, 1),
        'width': int(image.width),
        'height': int(image.height),
    }


def analyze_page(image: Image.Image) -> dict[str, Any]:
    """Propose an enabled set, parameters and order for one page.

    Returns plain data so the UI can show it before anything is applied. The
    proposal never claims improved accuracy; the caller must present it as a
    starting point for the user to accept, edit or reject.
    """
    stats = _profile(image)
    reasons: list[dict[str, str]] = []
    proposed = EnhancementSettings(enabled=True, order=list(DEFAULT_ORDER))
    notes: list[str] = []

    low_contrast = stats['contrast'] < 150
    heavy_noise = stats['noise'] > 6.0
    looks_blurred = stats['blur'] > 0.45
    uneven = stats['tile_spread'] > 45
    faint = stats['ink_ratio'] < 0.012
    small_text = stats['width'] < 1100

    if low_contrast or uneven:
        proposed.clahe.enabled = True
        if uneven:
            proposed.clahe.clip_limit = 2.5
            proposed.clahe.tile_grid = 12
        reasons.append({'stage': 'clahe', 'why': 'کنتراست صفحه کم است' if low_contrast else 'روشنایی صفحه یکدست نیست'})
    if heavy_noise:
        proposed.denoise.enabled = True
        proposed.denoise.diameter = 7
        proposed.denoise.sigma_color = 40
        reasons.append({'stage': 'denoise', 'why': 'نویز نقطهای صفحه زیاد است'})
    if looks_blurred:
        proposed.unsharp.enabled = True
        proposed.unsharp.amount = 1.4
        proposed.unsharp.radius = 1.4
        reasons.append({'stage': 'unsharp', 'why': 'لبه‌های حروف نرم و تار هستند'})
    if small_text:
        proposed.upscale.enabled = True
        proposed.upscale.factor = 2
        reasons.append({'stage': 'upscale', 'why': 'عرض صفحه کم است و حروف ریز'})
    if low_contrast and not uneven and not heavy_noise:
        proposed.contrast.enabled = True
        proposed.contrast.strength = 1.25
        reasons.append({'stage': 'contrast', 'why': 'متن خاکستری است، نه سیاه'})
    if faint and (low_contrast or uneven):
        # Binarising a faint page usually destroys thin strokes, so it stays off
        # here and the note explains how to turn it on deliberately.
        if not looks_blurred:
            notes.append('اگر با این تنظیمات هنوز متن روشن ناخوانا بود، «سیاه‌وسفید تطبیقی» را دستی روشن کنید؛ به‌صورت خودکار روشن نمی‌شود چون خط‌های نازک را ممکن است حذف کند.')

    if not reasons:
        reasons.append({'stage': 'grayscale', 'why': 'صفحه تمیز است؛ فقط پیش‌نیاز ساده لازم است'})
        proposed.grayscale.enabled = True

    # Put the enabled stages in dependency order but keep the user's list intact.
    proposed.order = normalize_order(list(DEFAULT_ORDER))
    enabled_stages = [name for name in proposed.order if getattr(proposed, name).enabled]
    for name in AFTER_THRESHOLD_POINTLESS:
        if name in enabled_stages and 'threshold' in enabled_stages:
            issues = proposed.order_issues()
            notes.extend(issue.message for issue in issues)

    return {
        'stats': stats,
        'proposed': proposed.model_dump(),
        'enabled': enabled_stages,
        'reasons': reasons,
        'notes': notes,
        'is_empty_page': stats['ink_ratio'] < 0.0008,
    }
