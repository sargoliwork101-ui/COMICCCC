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
