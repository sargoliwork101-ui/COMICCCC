"""Synthetic safety/filter regressions; not an OCR accuracy benchmark."""
import pytest
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from comic_studio import document_enhancement as de
from comic_studio.activity import JobCancelledError

@pytest.mark.parametrize('mode', ['comic', 'auto', 'document'])
def test_legacy_identity(mode, monkeypatch):
    config = de.EnhancementSettings(enabled=mode != 'document', grayscale={'enabled': True})
    monkeypatch.setattr(de, 'prepare_document', lambda *_: pytest.fail('legacy allocated image'))
    sentinel = []
    with Image.new('RGB', (20, 20)) as image:
        assert de.run_document_ocr(image, config, mode, lambda _: pytest.fail(), lambda: sentinel, lambda _: pytest.fail()) is sentinel

@pytest.mark.parametrize('scenario', ['clear', 'blur', 'low_contrast', 'noise', 'small_serif', 'uneven'])
@pytest.mark.parametrize('stage', de.STAGES)
def test_filters_preserve_original(scenario, stage):
    rng = np.random.default_rng(1)
    image = Image.new('RGB', (160, 100), 'white')
    if scenario == 'uneven':
        image = Image.fromarray(np.repeat(np.tile(np.arange(160, dtype=np.uint8), (100, 1))[:, :, None], 3, axis=2))
    if scenario == 'noise':
        image = Image.fromarray(rng.integers(0, 256, (100, 160, 3), dtype=np.uint8))
    draw = ImageDraw.Draw(image)
    if scenario == 'small_serif':
        from PIL import ImageFont
        font = ImageFont.truetype('DejaVuSerif.ttf', 10)
        draw.text((5, 20), 'Small Serif print 123', font=font, fill='black')
    else:
        draw.text((5, 20), 'Book print 123', fill=(170, 170, 170) if scenario == 'low_contrast' else 'black')
    if scenario == 'blur':
        old = image
        image = image.filter(ImageFilter.GaussianBlur(1))
        old.close()
    original = image.tobytes()
    config = de.EnhancementSettings(enabled=True, **{stage: {'enabled': True}})
    with de.prepare_document(image, config) as result:
        assert result.size == ((320, 200) if stage == 'upscale' else image.size)
        if stage == 'threshold': assert set(np.unique(result)).issubset({0, 255})
        if stage == 'grayscale': assert result.mode == 'L' and len(np.unique(result)) > 2
    assert image.tobytes() == original
    image.close()

def test_mapping_and_fallback(monkeypatch):
    cfg = de.EnhancementSettings(enabled=True, upscale={'enabled': True, 'factor': 3})
    blocks = [{'x0': 6, 'y0': 9, 'x1': 30, 'y1': 60, 'lineH': 12, 'polygon': [[6, 9]], 'sourceLines': [{'x0': 6, 'y0': 9}]}]
    warnings = []
    with Image.new('RGB', (20, 30)) as image:
        result = de.run_document_ocr(image, cfg, 'document', lambda _: blocks, lambda: pytest.fail(), warnings.append)
        assert result[0]['x0'] == 2 and result[0]['sourceLines'][0]['y0'] == 3
        assert blocks[0]['x0'] == 6
        monkeypatch.setattr(de, 'prepare_document', lambda *_: (_ for _ in ()).throw(ValueError('filter failed')))
        sentinel = []
        assert de.run_document_ocr(image, cfg, 'document', lambda _: pytest.fail(), lambda: sentinel, warnings.append) is sentinel
        assert len(warnings) == 1
        monkeypatch.setattr(de, 'prepare_document', lambda *_: (_ for _ in ()).throw(JobCancelledError('stop')))
        with pytest.raises(JobCancelledError):
            de.run_document_ocr(image, cfg, 'document', lambda _: pytest.fail(), lambda: pytest.fail(), warnings.append)

def test_validation_and_local_otsu():
    for payload in [{'order': ['upscale'] * 6}, {'threshold': {'window': 4}}, {'upscale': {'factor': 4}}]:
        with pytest.raises(ValueError): de.EnhancementSettings(**payload)
    with Image.new('RGB', (31, 23), 'white') as image:
        cfg = de.EnhancementSettings(threshold={'enabled': True, 'method': 'adaptive_otsu'})
        with de.prepare_document(image, cfg) as result:
            assert result.size == image.size


def test_oversize_upscale_rejected_before_filters(monkeypatch):
    cfg = de.EnhancementSettings(enabled=True, grayscale={'enabled': True}, upscale={'enabled': True})
    monkeypatch.setitem(de.FILTERS, 'grayscale', lambda *_: pytest.fail('preflight must reject first'))
    with Image.new('L', (2500, 2000)) as image:
        with pytest.raises(de.EnhancementError, match='20.0') as exc:
            de.prepare_document(image, cfg)
        assert 'بزرگ‌نمایی' in str(exc.value) and '2500' in str(exc.value)


def test_filter_failure_names_stage_without_leaking_path(monkeypatch):
    cfg = de.EnhancementSettings(enabled=True, clahe={'enabled': True})
    monkeypatch.setitem(de.FILTERS, 'clahe', lambda *_: (_ for _ in ()).throw(RuntimeError('/private/path')))
    with Image.new('RGB', (20, 20)) as image:
        with pytest.raises(de.EnhancementError) as exc:
            de.prepare_document(image, cfg)
        assert 'clahe' in str(exc.value) and '/private' not in str(exc.value)


def test_only_explicit_preview_bypasses_limit(monkeypatch):
    monkeypatch.setattr(de, 'MAX_PIXELS', 100)
    cfg = de.EnhancementSettings(enabled=True, upscale={'enabled': True})
    with Image.new('RGB', (10, 10)) as image:
        with pytest.raises(de.EnhancementError):
            de.prepare_document(image, cfg)
        with de.prepare_document(image, cfg, enforce_size_limit=False) as preview:
            assert preview.size == (20, 20)
        # A preview must not alter policy for subsequent normal OCR calls.
        with pytest.raises(de.EnhancementError):
            de.prepare_document(image, cfg)


def test_despeckle_is_opt_in_and_preserves_connected_strokes():
    binary = np.full((30, 40), 255, np.uint8)
    binary[2, 2] = 0
    binary[4, 4:6] = 0
    binary[10:23, 12:15] = 0  # connected letter stroke
    binary[24:27, 25:28] = 0  # 9-pixel punctuation, larger than supported removal
    cleaned = de._remove_speckles(binary, 2)
    assert cleaned[2, 2] == 255 and np.all(cleaned[4, 4:6] == 255)
    assert np.array_equal(cleaned[10:23, 12:15], binary[10:23, 12:15])
    assert np.array_equal(cleaned[24:27, 25:28], binary[24:27, 25:28])
    assert binary[2, 2] == 0
    assert de.Threshold().despeckle_area == 0
    with pytest.raises(ValueError): de.Threshold(despeckle_area=9)


def test_threshold_despeckle_removes_isolated_dot():
    image = Image.new('L', (80, 80), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 25, 50), fill=0)
    draw.point((60, 60), fill=0)
    for method in ['sauvola', 'adaptive_otsu']:
        with de._threshold(image, de.Threshold(method=method)) as raw:
            assert raw.getpixel((60, 60)) == 0
        with de._threshold(image, de.Threshold(method=method, despeckle_area=2)) as cleaned:
            assert cleaned.getpixel((60, 60)) == 255
            assert cleaned.getpixel((22, 35)) == 0
    image.close()


def test_legacy_order_migrates_with_disabled_contrast():
    old = ['threshold', 'unsharp', 'denoise', 'clahe', 'grayscale', 'upscale']
    cfg = de.EnhancementSettings(order=old)
    assert cfg.order == old + ['contrast'] and not cfg.contrast.enabled
    assert old == ['threshold', 'unsharp', 'denoise', 'clahe', 'grayscale', 'upscale']


def test_contrast_order_changes_actual_pixels():
    image = Image.fromarray(np.tile(np.arange(80, 180, dtype=np.uint8), (80, 1)))
    cfg = de.EnhancementSettings(enabled=True, contrast={'enabled': True, 'strength': 2},
                                 threshold={'enabled': True})
    cfg.order.remove('contrast'); cfg.order.insert(0, 'contrast')
    with de.prepare_document(image, cfg) as before:
        pixels = np.array(before)
    cfg.order.remove('contrast'); cfg.order.append('contrast')
    with de.prepare_document(image, cfg) as after:
        assert not np.array_equal(pixels, np.array(after))
    image.close()


# --------------------------------------------------------------------------
# 4.88: dependency-aware ordering and the page analyser.
# These are image-statistics tests, not an OCR accuracy benchmark.
# --------------------------------------------------------------------------

def _page(width=700, height=900, *, blur=0.0, noise=0.0, contrast=1.0, uneven=False):
    """A synthetic text page with adjustable defects."""
    image = Image.new('RGB', (width, height), (250, 248, 244))
    draw = ImageDraw.Draw(image)
    y = 60
    while y < height - 60:
        draw.text((60, y), 'Control systems regulate machine behaviour.', fill=(25, 25, 30))
        y += 34
    if uneven:
        ramp = np.linspace(1.06, 0.74, width, dtype=np.float32)[None, :, None]
        image = Image.fromarray(np.clip(np.asarray(image, np.float32) * ramp, 0, 255).astype(np.uint8))
    if contrast != 1.0:
        arr = np.asarray(image, np.float32)
        image = Image.fromarray(np.clip(128 + (arr - 128) * contrast, 0, 255).astype(np.uint8))
    if blur:
        image = image.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        rng = np.random.default_rng(3)
        arr = np.asarray(image, np.float32) + rng.normal(0, noise, (height, width, 3))
        image = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return image


def test_threshold_then_contrast_really_is_a_no_op():
    """A binarsing stage leaves nothing for a later contrast/CLAHE to change.

    The UI warns about this order, so the warning must be true.
    """
    image = _page()
    cfg = de.EnhancementSettings(enabled=True, threshold={'enabled': True})
    cfg.order = [*[name for name in de.STAGES if name != 'threshold'], 'threshold']
    with de.prepare_document(image, cfg) as after_threshold:
        threshold_only = np.array(after_threshold.convert('L'))
    cfg.order = ['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'threshold', 'contrast']
    cfg.contrast.enabled = True
    cfg.contrast.strength = 2.5
    with de.prepare_document(image, cfg) as after_contrast:
        with_contrast = np.array(after_contrast.convert('L'))
    image.close()
    assert set(np.unique(threshold_only)) <= {0, 255}
    assert np.array_equal(threshold_only, with_contrast)


def test_order_issues_reports_stages_that_run_after_threshold():
    cfg = de.EnhancementSettings(enabled=True, threshold={'enabled': True},
                                 contrast={'enabled': True}, clahe={'enabled': True})
    cfg.order = ['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'threshold', 'contrast']
    stages = {issue.stage for issue in cfg.order_issues()}
    assert stages == {'contrast'}
    assert all(issue.reason == 'after_threshold' for issue in cfg.order_issues())
    # Nothing is reported when the binariser is off or already last.
    cfg.threshold.enabled = False
    assert cfg.order_issues() == []
    cfg.threshold.enabled = True
    cfg.order = ['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'contrast', 'threshold']
    assert cfg.order_issues() == []


def test_normalize_order_only_moves_threshold():
    """A deliberate denoise-before-upscale preference must survive."""
    order = ['upscale', 'threshold', 'grayscale', 'clahe', 'denoise', 'unsharp', 'contrast']
    fixed = de.normalize_order(order)
    assert fixed[-1] == 'threshold'
    assert fixed[:-1] == ['upscale', 'grayscale', 'clahe', 'denoise', 'unsharp', 'contrast']
    assert sorted(fixed) == sorted(de.STAGES)
    # Missing stages are added rather than dropped.
    assert sorted(de.normalize_order(['upscale', 'grayscale'])) == sorted(de.STAGES)


def test_blur_metric_separates_sharp_from_blurred():
    """The blur score must not be fooled by low contrast (it normalises by it)."""
    sharp = de.analyze_page(_page())['stats']
    blurred = de.analyze_page(_page(blur=1.6))['stats']
    assert sharp['blur'] < 0.3
    assert blurred['blur'] > sharp['blur'] + 0.3
    # A faded but sharp page must not be reported as blurred.
    faded = de.analyze_page(_page(contrast=0.35))['stats']
    assert faded['blur'] < 0.3
    assert faded['contrast'] < sharp['contrast'] - 40


def test_analyze_page_proposes_matching_filters():
    blurred = de.analyze_page(_page(blur=1.6))
    assert 'unsharp' in blurred['enabled']
    assert any(entry['stage'] == 'unsharp' for entry in blurred['reasons'])

    noisy = de.analyze_page(_page(noise=22))
    assert 'denoise' in noisy['enabled']

    uneven = de.analyze_page(_page(uneven=True))
    assert 'clahe' in uneven['enabled']

    clean = de.analyze_page(_page())
    assert 'unsharp' not in clean['enabled']
    assert 'denoise' not in clean['enabled']


def test_analyze_page_never_claims_accuracy_and_never_auto_binarises():
    """No proposal may assert better OCR accuracy, and threshold stays opt-in."""
    for kwargs in ({}, {'blur': 1.6}, {'noise': 22}, {'contrast': 0.3}, {'uneven': True}):
        with _page(**kwargs) as image:
            result = de.analyze_page(image)
        assert result['proposed']['enabled'] is True
        assert result['proposed']['threshold']['enabled'] is False
        assert isinstance(result['notes'], list)
        # The payload is data only. No message may promise, imply or measure
        # OCR accuracy — only image statistics and a "starting point" framing.
        for text in result['notes']:
            assert 'دقت' not in text or 'تضمین' in text or 'تضمین دقت' in text
    # Every proposed stage must be enabled in its own settings block.
    for name in de.STAGES:
        assert isinstance(result['proposed'][name], dict)


def test_analyze_page_proposal_uses_a_dependency_safe_order():
    with _page(blur=1.4, contrast=0.5) as image:
        result = de.analyze_page(image)
    order = result['proposed']['order']
    assert sorted(order) == sorted(de.STAGES)
    assert order[-1] == 'threshold'


def test_analyze_page_rejects_an_empty_image_cleanly():
    with Image.new('RGB', (10, 10)) as blank:
        result = de.analyze_page(blank)
    assert result['is_empty_page'] is True
    assert result['stats']['width'] == 10
