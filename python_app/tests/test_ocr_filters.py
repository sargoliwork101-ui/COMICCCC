from PIL import Image, ImageDraw, ImageFilter
import pytest
from pydantic import ValidationError
from comic_studio.ocr_filters import prepare_ocr_photo
from comic_studio.schemas import OcrRequest


def photo():
    im = Image.new('RGB', (120, 80), (195, 195, 195))
    ImageDraw.Draw(im).rectangle((20, 15, 80, 60), fill=(100, 100, 100))
    blurred = im.filter(ImageFilter.GaussianBlur(1.5))
    im.close()
    return blurred


def test_defaults_and_disabled_contrast_preserve_legacy_input():
    with photo() as im:
        assert prepare_ocr_photo(im) is im
        assert prepare_ocr_photo(im, contrast=False, contrast_strength=3) is im


@pytest.mark.parametrize('strength', [0.5, 1, 1.5, 3])
@pytest.mark.parametrize('sharpen', [False, True])
def test_filters_preserve_source_and_coordinates(strength, sharpen):
    with photo() as im:
        original = im.tobytes()
        result = prepare_ocr_photo(im, sharpen=sharpen, contrast_strength=strength)
        try:
            assert result.size == im.size
            assert result.mode == 'RGB'
            assert im.tobytes() == original
            if sharpen or strength != 1:
                assert result is not im
                assert result.tobytes() != original
        finally:
            if result is not im:
                result.close()


def test_strength_changes_pixels_and_sharpen_works_without_contrast():
    with photo() as im:
        with prepare_ocr_photo(im, contrast_strength=0.5) as low:
            with prepare_ocr_photo(im, contrast_strength=2) as high:
                assert low.tobytes() != high.tobytes()
        with prepare_ocr_photo(im, contrast=False, sharpen=True) as sharp:
            assert sharp.tobytes() != im.tobytes()


def test_transparency_is_white_backed():
    with Image.new('RGBA', (20, 10), (0, 0, 0, 0)) as im:
        with prepare_ocr_photo(im, sharpen=True) as result:
            assert result.getpixel((0, 0)) == (255, 255, 255)


@pytest.mark.parametrize('value', [0, 0.49, 3.1, float('inf'), float('nan')])
def test_api_rejects_invalid_strength(value):
    with pytest.raises(ValidationError):
        OcrRequest(contrast_strength=value)


def test_document_binarization_cleans_uneven_paper_without_losing_strokes_and_dots():
    import numpy as np
    # Faint print on a gradual paper shadow, including tiny Persian-like dots.
    gray = np.tile(np.linspace(150, 240, 240, dtype=np.uint8), (120, 1)).copy()
    ink = np.zeros(gray.shape, dtype=bool)
    for x in range(20, 220, 25):
        ink[40:60, x:x + 3] = True
        ink[70:72, x:x + 2] = True
    gray[ink] -= 35
    with Image.fromarray(gray).convert('RGB') as image:
        original = image.tobytes()
        with prepare_ocr_photo(image, document_binarize=True, page_mode='document') as result:
            binary = np.asarray(result)[:, :, 0]
            assert set(np.unique(binary)) == {0, 255}
            assert (binary[ink] == 0).mean() > 0.98
            assert (binary[~ink] == 255).mean() > 0.98
            assert result.size == image.size
            assert result.mode == 'RGB'
        assert image.tobytes() == original


@pytest.mark.parametrize('size', [(1, 1), (1, 20), (2, 2), (3, 3), (10, 8), (120, 80)])
def test_document_binarization_small_and_transparent_inputs(size):
    with Image.new('RGBA', size, (0, 0, 0, 0)) as image:
        with prepare_ocr_photo(image, document_binarize=True, sharpen=True) as result:
            assert result.size == size
            assert result.getpixel((0, 0)) == (255, 255, 255)


def test_document_binarization_is_independent_of_contrast_switch():
    import numpy as np
    with photo() as image:
        with prepare_ocr_photo(image, contrast=False, contrast_strength=3, document_binarize=True) as result:
            assert set(np.unique(np.asarray(result))) <= {0, 255}
            assert result is not image
        assert prepare_ocr_photo(image, contrast=False, document_binarize=False) is image
