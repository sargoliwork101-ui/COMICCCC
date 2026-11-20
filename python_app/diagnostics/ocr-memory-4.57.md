# OCR memory investigation — Studio 4.57

## Scope and limits

The reported symptom is a local server that exits after 25 completed pages with
PP-OCR, although the next page works on its own. The original document and a
Windows crash dump were not available. These measurements identify and fix two
reproducible sources of avoidable memory pressure. They **do not prove** that
either one is the sole cause of that particular Windows/DirectML process exit.

No native heap trimming, forced working-set eviction, periodic model reload,
recognition-quality reduction, or OCR result truncation was introduced.

## 1. Temporary buffers in bright-text fallback

Previously `_extra_preprocess_image` retained the input RGB array, the 3x RGB
array, the grayscale image, the threshold mask and the inverted mask until the
final RGB image had been allocated. This raised the peak during a single page,
even if no page-to-page Python object leak occurred.

The fix releases the two RGB arrays immediately after grayscale conversion and
uses the same grayscale buffer for thresholding and inversion. Temporary PIL
images are explicitly closed, including failures in ordinary preprocessing.
The interpolation, threshold, dimensions and output pixel values are unchanged.

Fresh-process measurements, using a deterministic 2400×1800 RGB image:

| Measurement (MiB) | Old reference implementation | Fixed implementation |
|---|---:|---:|
| Baseline process RSS | 76.30 | 76.17 |
| Sampled peak process RSS | 468.05 | 276.70 |
| Increase above baseline | 391.75 | 200.53 |

The incremental sampled peak fell by approximately **49%** in this experiment.
Both 7200×5400 outputs have the identical SHA-256:
`9ed74faec9294f6467ced8a721582395e3eef6086aa8888d542a52d3edbaff4b`.

The test runs each version in a fresh process and samples RSS every 5 ms, so
these are observed peaks, not exact allocation maxima. They are not promises
for every page size or platform. Very large pages still require substantial
memory for the final, unchanged-resolution image.

## 2. Full-resolution images retained by the grid

Native `loading="lazy"` defers initial image loading, but does not unload images
already visited. Each card kept its full-resolution `src` after scrolling away.
This retained pixel ownership in proportion to the number of pages visited.

The grid now observes visibility using `IntersectionObserver` with a 160 px
prefetch margin. Offscreen image elements detach their `src`, preserving their
URL/version metadata, dimensions/layout and click handlers. Returning to a card
reloads its full-resolution original. Old observer callbacks cannot mutate a
new grid, and observers are disconnected on redraw. Browsers without the API
retain the previous native-lazy-loading behavior.

Real Chromium, viewport 1280×800, after visiting 36 distinct 1600×2200 pages:

| Measurement | Before | After |
|---|---:|---:|
| Attached full-resolution image sources | 36 | 12 |
| Estimated attached decoded pixel bytes (MiB) | 483.40 | 161.13 |
| First offscreen page detached | No | Yes |

The byte figure is `sum(naturalWidth × naturalHeight × 4)` for attached images;
it is **not browser RSS**, a heap snapshot, or a guarantee that Chromium returns
cached memory to the OS immediately. Detaching makes the old image resources
eligible for eviction. The number retained varies with viewport size and card
layout, rather than growing with the total number visited.

The same test confirms that scrolling back restores the 1600×2200 original and
click-to-select continues to work. Saved images, OCR payloads and exports do not
use this visibility policy and are not downscaled.

## 3. Actual model, not just request mocks

RapidOCR 3.10.0 / ONNX Runtime 1.32.0 / PP-OCRv6 Small, CPUExecutionProvider,
Linux x86-64. The full `recognize_image` path processed 36 synthetic English
pages, alternating 1000×1400, 1400×1800 and 1800×2600. Contrast preprocessing was
enabled; precise upscaling was disabled. The model stayed loaded throughout.
Input PIL images and page results were disposed after each page.

- Pages 7–12 median post-page RSS: **477.85 MiB**.
- Pages 31–36 median post-page RSS: **479.90 MiB**.
- Sampled overall peak RSS: **993.7 MiB** (20 ms sampling).
- All 36 pages produced text; no model reload between pages and no process exit.

The sampled intra-page peak is much larger than the post-page median. Therefore
looking only at Task Manager *after* a page, or testing only a fake model, is
insufficient. This run did not reproduce unbounded model memory growth. It does
not validate PP-OCRv5, Persian, GPU providers, the user's document or Windows.

## 4. Concurrent edited-image response race

The broad browser suite also logged an h11 `Too much data for declared
Content-Length` error. Edited PNGs are replaced atomically, but `FileResponse`
can stat the old path and then open the newly replaced file. Its body and
Content-Length can therefore describe different generations. Edited-image
responses now open once, obtain the size with `fstat` on that descriptor, and
stream 64 KiB chunks from the same descriptor. Closure is shielded from disconnect
cancellation. Original immutable image responses are unchanged. Regression
tests cover replacement before opening and after opening. This response failure
is not proof of the reported whole-process exit.

## Reproduction

Install the test environment from `python_app`:

```sh
python -m pip install -e ".[dev,ocr]"
```

With PP-OCRv6 weights already present (these tests never download missing weights):

```sh
COMIC_STUDIO_REAL_OCR_MEMORY=1 \
COMIC_STUDIO_MEMORY_REPORT_DIR=../.cache/ocr-memory \
python -m pytest tests/test_real_ocr_memory.py -s
```

On PowerShell, set the environment variables first:

```powershell
$env:COMIC_STUDIO_REAL_OCR_MEMORY = "1"
$env:COMIC_STUDIO_MEMORY_REPORT_DIR = "..\.cache\ocr-memory"
python -m pytest tests/test_real_ocr_memory.py -s
```

From the repository root, after `npm ci`:

```sh
npm run test:studio-memory-browser
```

Set `COMIC_STUDIO_PYTHON` to the test Python executable if it is not the Linux
`python_app/.venv/bin/python` default. Small optional JSON measurements can be
written with `COMIC_STUDIO_MEMORY_REPORT`; profiling artifacts belong in the
ignored `.cache` directory, not source control.

The next platform-specific investigation, if the original crash persists, needs
process-exit/native-crash evidence on Windows and separate measurements of the
server, browser, and GPU/committed memory. It should not be replaced by another
arbitrary reload-every-N-pages workaround.
