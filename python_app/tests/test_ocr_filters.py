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


def test_removed_paper_filter_cannot_be_enabled_by_legacy_payload():
    import inspect
    assert 'document_binarize' not in inspect.signature(prepare_ocr_photo).parameters
    request = OcrRequest(document_binarize=True)
    assert 'document_binarize' not in request.model_dump()
    with photo() as image:
        assert prepare_ocr_photo(image, contrast=False) is image
