from __future__ import annotations

import argparse
import contextlib
import ctypes
import gc
import html
import json
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any


def _configure_cache_dirs(models_root: Path) -> None:
    hf_dir = models_root / "hf"
    paddlex_dir = models_root / "paddlex"
    torch_dir = models_root / "torch"
    surya_dir = models_root / "surya"
    mineru_dir = models_root / "mineru"
    for directory in (hf_dir, paddlex_dir, torch_dir, surya_dir, mineru_dir):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(hf_dir))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_dir / "hub"))
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(paddlex_dir))
    os.environ.setdefault("TORCH_HOME", str(torch_dir))
    os.environ.setdefault("MODEL_CACHE_DIR", str(surya_dir))
    os.environ.setdefault("MINERU_HOME", str(mineru_dir))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")
    os.environ.setdefault("SURYA_INFERENCE_BACKEND", "llamacpp")
    os.environ.setdefault("SURYA_INFERENCE_PARALLEL", "1")
    os.environ.setdefault("SURYA_INFERENCE_CTX_SIZE", "16384")
    os.environ.setdefault("SURYA_INFERENCE_KEEP_ALIVE", "false")
    cores = str(max(1, int(os.cpu_count() or 1)))
    for thread_key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(thread_key, cores)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "true")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    os.environ.setdefault("FLAGS_use_mkldnn", "1")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "60")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")


def _widen_requests_default_timeout(min_timeout: float = 120.0) -> None:
    """Prevent hardcoded short HTTP timeouts (such as PaddleX's 15s `requests.get(..., timeout=15)`)
    from aborting multi-hundred-MB weight downloads on slow connections."""
    try:
        import requests
    except Exception:
        return
    orig_req = getattr(requests.Session, "request", None)
    if orig_req is None or getattr(orig_req, "_comic_studio_widened", False):
        return

    def _wrapped_request(self: Any, method: str, url: str, **kwargs: Any) -> Any:
        raw_t = kwargs.get("timeout")
        if raw_t is None:
            kwargs["timeout"] = min_timeout
        elif isinstance(raw_t, (int, float)) and raw_t < min_timeout:
            kwargs["timeout"] = min_timeout
        elif isinstance(raw_t, tuple) and len(raw_t) == 2:
            c_t, r_t = raw_t
            kwargs["timeout"] = (
                max(float(c_t), 30.0) if isinstance(c_t, (int, float)) else c_t,
                max(float(r_t), min_timeout) if isinstance(r_t, (int, float)) else r_t,
            )
        return orig_req(self, method, url, **kwargs)

    _wrapped_request._comic_studio_widened = True  # type: ignore[attr-defined]
    requests.Session.request = _wrapped_request  # type: ignore[method-assign]


def _configure_torch_runtime(torch_mod: Any) -> str:
    """Configure PyTorch multi-core CPU threads and return best available accelerator ('cuda', 'mps', or 'cpu')."""
    cores = max(1, int(os.cpu_count() or 1))
    try:
        torch_mod.set_num_threads(cores)
    except Exception:
        pass
    try:
        torch_mod.set_num_interop_threads(min(4, max(1, cores // 2)))
    except Exception:
        pass
    try:
        if hasattr(torch_mod, "cuda") and torch_mod.cuda.is_available():
            try:
                torch_mod.backends.cuda.matmul.allow_tf32 = True
                torch_mod.backends.cudnn.allow_tf32 = True
                torch_mod.backends.cudnn.benchmark = True
            except Exception:
                pass
            return "cuda"
    except Exception:
        pass
    try:
        if hasattr(torch_mod, "backends") and hasattr(torch_mod.backends, "mps") and torch_mod.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _release_worker_caches() -> None:
    """Release transient CPU/GPU activation buffers after each recognized page."""
    gc.collect()
    torch_mod = sys.modules.get("torch")
    if torch_mod is not None:
        try:
            if hasattr(torch_mod, "cuda") and torch_mod.cuda.is_available():
                torch_mod.cuda.empty_cache()
        except Exception:
            pass
        try:
            if hasattr(torch_mod, "mps") and hasattr(torch_mod.mps, "empty_cache"):
                if hasattr(torch_mod, "backends") and hasattr(torch_mod.backends, "mps") and torch_mod.backends.mps.is_available():
                    torch_mod.mps.empty_cache()
        except Exception:
            pass
    paddle_mod = sys.modules.get("paddle")
    if paddle_mod is not None:
        try:
            if hasattr(paddle_mod, "device") and hasattr(paddle_mod.device, "cuda"):
                if paddle_mod.device.is_compiled_with_cuda() and paddle_mod.device.cuda.device_count() > 0:
                    paddle_mod.device.cuda.empty_cache()
        except Exception:
            pass
    if sys.platform.startswith("linux"):
        try:
            libc = ctypes.CDLL("libc.so.6")
            if hasattr(libc, "malloc_trim"):
                libc.malloc_trim(0)
        except Exception:
            pass


_HEADING_LABELS = {
    "title", "doc_title", "paragraph_title", "section_header", "section-header",
    "header", "heading", "sub_title", "subtitle", "caption", "figure_title", "table_title",
}
_LIST_LABELS = {"list", "list_item", "list-item"}


def _extract_markup_hints(raw: str, label: str = "") -> dict[str, Any]:
    text = str(raw or "").strip()
    norm_label = str(label or "").strip().lower()
    hints: dict[str, Any] = {}
    if norm_label in _HEADING_LABELS or re.search(r"<h[1-6]\b", text, re.IGNORECASE) or re.match(r"^\s*#{1,6}\s+\S", text):
        hints["role"] = "heading"
        hints["bold"] = True
    elif norm_label in _LIST_LABELS or re.search(r"<li\b", text, re.IGNORECASE):
        hints["role"] = "list"
    stripped_tags = re.sub(r"<[^>]+>", "", text).strip()
    if stripped_tags:
        lines = [ln.strip() for ln in stripped_tags.splitlines() if ln.strip()]
        bold_lines = sum(
            1 for ln in lines
            if ln.startswith("**") and ln.endswith("**") and len(ln) > 4 and "**" not in ln[2:-2]
        )
        italic_lines = sum(
            1 for ln in lines
            if (
                (ln.startswith("*") and not ln.startswith("**") and ln.endswith("*") and not ln.endswith("**") and len(ln) > 2)
                or (ln.startswith("_") and not ln.startswith("__") and ln.endswith("_") and not ln.endswith("__") and len(ln) > 2)
            )
        )
        if (
            re.match(r"^\s*<(?:b|strong)\b[^>]*>[\s\S]*</(?:b|strong)>\s*$", text, re.IGNORECASE)
            or (lines and bold_lines * 2 >= len(lines))
        ):
            hints["bold"] = True
        if (
            re.match(r"^\s*<(?:i|em)\b[^>]*>[\s\S]*</(?:i|em)>\s*$", text, re.IGNORECASE)
            or (lines and italic_lines * 2 >= len(lines))
        ):
            hints["italic"] = True
    return hints


def _strip_markup(raw: str) -> str:
    text = str(raw or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(?:p|div|li|tr|h[1-6])>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"^(\s*)#{1,6}\s+", r"\1", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
    cleaned_lines: list[str] = []
    for raw_line in text.splitlines():
        expanded = raw_line.expandtabs(4)
        lead_len = min(16, len(expanded) - len(expanded.lstrip(" ")))
        body = " ".join(expanded.split())
        if body:
            cleaned_lines.append((" " * lead_len) + body)
    return "\n".join(cleaned_lines).strip("\n")


def _rect_polygon(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    left, right = sorted((float(x0), float(x1)))
    top, bottom = sorted((float(y0), float(y1)))
    if right - left < 2.0:
        right = left + 2.0
    if bottom - top < 2.0:
        bottom = top + 2.0
    return [[left, top], [right, top], [right, bottom], [left, bottom]]


def _clamp_polygon(poly: list[list[float]], width: int, height: int) -> list[list[float]]:
    return [
        [max(0.0, min(float(width), float(pt[0]))), max(0.0, min(float(height), float(pt[1])))]
        for pt in poly
    ]


def _default_regions(width: int, height: int, regions: list[list[float]] | None) -> list[list[float]]:
    valid: list[list[float]] = []
    for item in regions or []:
        if isinstance(item, (list, tuple)) and len(item) == 4:
            x0, y0, x1, y1 = [float(v) for v in item]
            x0 = max(0.0, min(float(width - 1), x0))
            y0 = max(0.0, min(float(height - 1), y0))
            x1 = max(x0 + 2.0, min(float(width), x1))
            y1 = max(y0 + 2.0, min(float(height), y1))
            if (x1 - x0) >= 6 and (y1 - y0) >= 6:
                valid.append([x0, y0, x1, y1])
    if valid:
        return valid
    return [[0.0, 0.0, float(width), float(height)]]


class _BaseAdapter:
    hf_repo: str | None = None
    hf_ignore_patterns: tuple[str, ...] | None = None

    def __init__(self, models_root: Path) -> None:
        self.models_root = models_root

    def _safe_repo_folder_name(self, repo_override: str | None = None) -> str:
        target = repo_override or self.hf_repo
        assert target
        # Replace dots and special chars so transformers `trust_remote_code=True` dynamic module
        # imports never fail on dotted folder names like `rednote-hilab__dots.mocr`.
        raw = target.replace("/", "__")
        return re.sub(r"[^A-Za-z0-9_-]+", "_", raw)

    def _resolve_hf_repo_revision(self, repo_id: str, endpoint: str | None = None) -> str | None:
        ref_file = self.models_root / "hf" / "hub" / f"models--{repo_id.replace('/', '--')}" / "refs" / "main"
        if ref_file.is_file():
            sha = ref_file.read_text(encoding="utf-8", errors="ignore").strip()
            if len(sha) >= 12:
                return f"hf:{sha[:12]}"
        try:
            from huggingface_hub import HfApi
            api = HfApi(endpoint=endpoint) if endpoint else HfApi()
            info = api.model_info(repo_id, timeout=8.0)
            sha = str(getattr(info, "sha", "") or "").strip()
            if len(sha) >= 12:
                return f"hf:{sha[:12]}"
        except Exception:
            pass
        return None

    def _download_hf_repo_resilient(
        self,
        repo_id: str,
        *,
        ignore_patterns: tuple[str, ...] | list[str] | None = None,
    ) -> tuple[str, str]:
        from huggingface_hub import snapshot_download

        local_dir = self.models_root / "hf-repos" / self._safe_repo_folder_name(repo_id)
        local_dir.mkdir(parents=True, exist_ok=True)
        dl_kwargs: dict[str, Any] = {"repo_id": repo_id, "local_dir": str(local_dir)}
        if ignore_patterns:
            dl_kwargs["ignore_patterns"] = list(ignore_patterns)
        used_endpoint: str | None = os.environ.get("HF_ENDPOINT") or None
        print(f"Downloading {repo_id} (15%)...", file=sys.stderr, flush=True)
        try:
            snapshot_download(max_workers=3, **dl_kwargs)
        except Exception as first_exc:
            err_low = str(first_exc).lower()
            is_net = any(k in err_low for k in ("timed out", "timeout", "connection", "ssl", "chunked", "reset", "eof"))
            if not is_net or os.environ.get("HF_ENDPOINT"):
                raise
            used_endpoint = "https://hf-mirror.com"
            print(f"Retrying {repo_id} via hf-mirror.com (30%)...", file=sys.stderr, flush=True)
            snapshot_download(max_workers=2, endpoint=used_endpoint, **dl_kwargs)
        print(f"Model {repo_id} weights ready (100%).", file=sys.stderr, flush=True)
        rev = self._resolve_hf_repo_revision(repo_id, endpoint=used_endpoint) or "ready"
        return str(local_dir), rev

    def prepare(self, language: str) -> str:
        _widen_requests_default_timeout(120.0)
        if self.hf_repo:
            _, rev = self._download_hf_repo_resilient(self.hf_repo, ignore_patterns=self.hf_ignore_patterns)
            return rev
        return "ready"

    def local_repo_or_id(self) -> str:
        assert self.hf_repo
        safe_dir = self.models_root / "hf-repos" / self._safe_repo_folder_name()
        if safe_dir.is_dir() and any(safe_dir.iterdir()):
            return str(safe_dir)
        legacy_dir = self.models_root / "hf-repos" / self.hf_repo.replace("/", "__")
        if "." not in legacy_dir.name and legacy_dir.is_dir() and any(legacy_dir.iterdir()):
            return str(legacy_dir)
        return self.hf_repo

    def close(self) -> None:
        return None

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        raise NotImplementedError


def _select_paddleocr_vl_version(pvl_module: Any) -> str | None:
    supported = getattr(pvl_module, "_AVAILABLE_PIPELINE_VERSIONS", None)
    if isinstance(supported, (list, tuple, set)) and supported:
        for preferred in ("v1.6", "v1.5", "v1"):
            if preferred in supported:
                return preferred
        return str(list(supported)[-1])
    default_ver = getattr(pvl_module, "_DEFAULT_PIPELINE_VERSION", None)
    return str(default_ver) if default_ver else None


class _PaddleOcrVlAdapter(_BaseAdapter):
    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self._pipeline: Any = None

    def _get_pipeline(self) -> Any:
        if self._pipeline is None:
            from paddleocr import PaddleOCRVL
            try:
                from paddleocr._pipelines import paddleocr_vl as _pvl_mod
            except Exception:
                _pvl_mod = None

            chosen_ver = _select_paddleocr_vl_version(_pvl_mod) if _pvl_mod is not None else None
            candidates: list[str | None] = []
            if chosen_ver:
                candidates.append(chosen_ver)
            for fallback_ver in ("v1.6", "v1.5", "v1", None):
                if fallback_ver not in candidates:
                    candidates.append(fallback_ver)

            paddle_device: str | None = None
            try:
                import paddle
                if hasattr(paddle, "device") and paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
                    paddle_device = "gpu:0"
                else:
                    paddle_device = "cpu"
            except Exception:
                paddle_device = None

            last_err: Exception | None = None
            for candidate in candidates:
                kwargs: dict[str, Any] = {}
                if candidate is not None:
                    kwargs["pipeline_version"] = candidate
                device_kwargs = {"device": paddle_device} if paddle_device else {}
                try:
                    self._pipeline = PaddleOCRVL(
                        use_chart_recognition=False,
                        use_seal_recognition=False,
                        **device_kwargs,
                        **kwargs,
                    )
                    break
                except TypeError:
                    try:
                        self._pipeline = PaddleOCRVL(
                            use_chart_recognition=False,
                            use_seal_recognition=False,
                            **kwargs,
                        )
                        break
                    except TypeError:
                        try:
                            self._pipeline = PaddleOCRVL(**kwargs)
                            break
                        except ValueError as exc:
                            last_err = exc
                            if "Invalid pipeline version" in str(exc):
                                continue
                            raise
                except ValueError as exc:
                    last_err = exc
                    if "Invalid pipeline version" in str(exc):
                        continue
                    raise
            if self._pipeline is None:
                raise RuntimeError(f"Could not initialize PaddleOCRVL pipeline: {last_err}")
        return self._pipeline

    def prepare(self, language: str) -> str:
        _widen_requests_default_timeout(120.0)
        print("Preparing PaddleOCR-VL sub-models (20%)...", file=sys.stderr, flush=True)
        try:
            self._get_pipeline()
        except Exception as first_exc:
            err_low = str(first_exc).lower()
            is_net = any(k in err_low for k in ("timed out", "timeout", "connection", "ssl", "chunked", "reset", "eof"))
            if not is_net or os.environ.get("PADDLE_PDX_HUGGING_FACE_ENDPOINT"):
                raise
            print("Retrying PaddleOCR-VL download via hf-mirror.com (40%)...", file=sys.stderr, flush=True)
            os.environ["PADDLE_PDX_HUGGING_FACE_ENDPOINT"] = "https://hf-mirror.com"
            os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            try:
                from paddlex.utils import flags as _pdx_flags
                _pdx_flags.HUGGING_FACE_ENDPOINT = "https://hf-mirror.com"
            except Exception:
                pass
            self._pipeline = None
            self._get_pipeline()
        self._pipeline = None
        _release_worker_caches()
        print("PaddleOCR-VL weights ready (100%).", file=sys.stderr, flush=True)
        import importlib.metadata
        try:
            return importlib.metadata.version("paddleocr")
        except Exception:
            import paddleocr
            return getattr(paddleocr, "__version__", "ready")

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        with Image.open(image_path) as im:
            width, height = im.size
        pipeline = self._get_pipeline()
        output = pipeline.predict(image_path)
        lines: list[dict[str, Any]] = []
        for page in output:
            data = page.json if hasattr(page, "json") else (page if isinstance(page, dict) else {})
            res = data.get("res", data) if isinstance(data, dict) else {}
            blocks = res.get("parsing_res_list") or getattr(page, "parsing_res_list", None) or []
            for block in blocks:
                if isinstance(block, dict):
                    label = str(block.get("block_label") or block.get("label") or "text").lower()
                    raw_content = block.get("block_content") or block.get("content") or block.get("text") or ""
                    content = _strip_markup(raw_content)
                    hints = _extract_markup_hints(raw_content, label)
                    bbox = block.get("block_bbox") or block.get("bbox") or block.get("coordinate")
                    score = float(block.get("score", 0.9) or 0.9)
                else:
                    label = str(getattr(block, "label", "text")).lower()
                    raw_content = getattr(block, "content", "")
                    content = _strip_markup(raw_content)
                    hints = _extract_markup_hints(raw_content, label)
                    bbox = getattr(block, "bbox", None)
                    score = float(getattr(block, "score", 0.9) or 0.9)
                if label in {"image", "figure", "header_image", "footer_image"} or not content or not bbox or len(bbox) < 4:
                    continue
                poly = _clamp_polygon(_rect_polygon(bbox[0], bbox[1], bbox[2], bbox[3]), width, height)
                lines.append({"text": content, "confidence": max(0.0, min(1.0, score)), "polygon": poly, **hints})
        return lines


class _SuryaAdapter(_BaseAdapter):
    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self._manager: Any = None
        self._predictor: Any = None
        self._legacy: tuple[Any, Any] | None = None

    def _ensure_loaded(self) -> None:
        if self._predictor is not None or self._legacy is not None:
            return
        try:
            import torch
            dev = _configure_torch_runtime(torch)
            os.environ.setdefault("TORCH_DEVICE", dev)
        except Exception:
            pass
        try:
            from surya.inference import SuryaInferenceManager
            from surya.recognition import RecognitionPredictor
            manager = SuryaInferenceManager(method="llamacpp")
            self._manager = manager
            self._predictor = RecognitionPredictor(manager)
        except TypeError:
            from surya.inference import SuryaInferenceManager
            from surya.recognition import RecognitionPredictor
            manager = SuryaInferenceManager()
            self._manager = manager
            self._predictor = RecognitionPredictor(manager)
        except ImportError:
            from surya.detection import DetectionPredictor
            from surya.recognition import RecognitionPredictor
            self._legacy = (RecognitionPredictor(), DetectionPredictor())

    def close(self) -> None:
        mgr = self._manager
        self._manager = None
        self._predictor = None
        if mgr is not None and hasattr(mgr, "stop"):
            try:
                mgr.stop()
            except Exception:
                pass

    def prepare(self, language: str) -> str:
        _widen_requests_default_timeout(120.0)
        import importlib.metadata

        # Surya 2.x (0.20+): pre-download GGUF VLM + layout checkpoints directly via huggingface_hub
        # without spawning llama-server or running slow full-page CPU inference on a dummy image.
        surya_settings = None
        try:
            from surya.settings import settings as _ss
            surya_settings = _ss
        except Exception:
            surya_settings = None

        gguf_repo = getattr(surya_settings, "SURYA_GGUF_REPO", None) if surya_settings is not None else None
        if gguf_repo:
            from huggingface_hub import hf_hub_download, snapshot_download

            model_file = str(getattr(surya_settings, "SURYA_GGUF_MODEL_FILE", "surya-2.5.gguf"))
            mmproj_file = str(getattr(surya_settings, "SURYA_GGUF_MMPROJ_FILE", "surya-2.5-mmproj.gguf"))
            ckpt_repo = str(getattr(surya_settings, "SURYA_MODEL_CHECKPOINT", "datalab-to/surya-ocr-2.5"))
            fast_layout = str(getattr(surya_settings, "FAST_LAYOUT_MODEL_CHECKPOINT", "") or "")

            def _hf_file_resilient(repo_id: str, filename: str) -> str:
                try:
                    return hf_hub_download(repo_id=repo_id, filename=filename)
                except Exception as first_exc:
                    err_low = str(first_exc).lower()
                    is_net = any(k in err_low for k in ("timed out", "timeout", "connection", "ssl", "chunked", "reset", "eof"))
                    if not is_net or os.environ.get("HF_ENDPOINT"):
                        raise
                    return hf_hub_download(repo_id=repo_id, filename=filename, endpoint="https://hf-mirror.com")

            print("Downloading Surya config metadata (10%)...", file=sys.stderr, flush=True)
            with contextlib.suppress(Exception):
                _hf_file_resilient(ckpt_repo, "config.json")
            print(f"Downloading {mmproj_file} from {gguf_repo} (25%)...", file=sys.stderr, flush=True)
            _hf_file_resilient(gguf_repo, mmproj_file)
            print(f"Downloading {model_file} from {gguf_repo} (60%)...", file=sys.stderr, flush=True)
            _hf_file_resilient(gguf_repo, model_file)
            if fast_layout.startswith("hf://"):
                layout_repo = fast_layout[5:].split("/")[0] + "/" + fast_layout[5:].split("/")[1]
                print(f"Downloading layout model {layout_repo} (88%)...", file=sys.stderr, flush=True)
                with contextlib.suppress(Exception):
                    try:
                        snapshot_download(repo_id=layout_repo, max_workers=3)
                    except Exception:
                        if not os.environ.get("HF_ENDPOINT"):
                            snapshot_download(repo_id=layout_repo, max_workers=2, endpoint="https://hf-mirror.com")
            print("Surya weights verified (100%).", file=sys.stderr, flush=True)
            return importlib.metadata.version("surya-ocr")

        # Legacy Surya v1 (< 0.20) fallback
        self._ensure_loaded()
        return importlib.metadata.version("surya-ocr")

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        self._ensure_loaded()
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        lines: list[dict[str, Any]] = []
        try:
            if self._predictor is not None:
                try:
                    preds = self._predictor([rgb])
                except Exception:
                    # Fallback to pure CPU layers if GPU Vulkan offload failed on older drivers
                    if os.environ.get("LLAMA_CPP_NGL", "0") != "0":
                        self.close()
                        os.environ["LLAMA_CPP_NGL"] = "0"
                        try:
                            from surya.settings import settings as _ss
                            _ss.LLAMA_CPP_NGL = 0
                        except Exception:
                            pass
                        self._ensure_loaded()
                        preds = self._predictor([rgb])
                    else:
                        raise
                page = preds[0] if preds else None
                for block in getattr(page, "blocks", []) or []:
                    if getattr(block, "skipped", False) or getattr(block, "error", False):
                        continue
                    raw_content = getattr(block, "html", "") or getattr(block, "text", "")
                    label = str(getattr(block, "label", "") or getattr(block, "block_type", "") or "")
                    text = _strip_markup(raw_content)
                    hints = _extract_markup_hints(raw_content, label)
                    if not text:
                        continue
                    raw_poly = getattr(block, "polygon", None)
                    bbox = getattr(block, "bbox", None)
                    if raw_poly and len(raw_poly) >= 4:
                        poly = [[float(pt[0]), float(pt[1])] for pt in raw_poly[:4]]
                    elif bbox and len(bbox) >= 4:
                        poly = _rect_polygon(bbox[0], bbox[1], bbox[2], bbox[3])
                    else:
                        continue
                    conf = float(getattr(block, "confidence", 0.9) or 0.9)
                    lines.append({"text": text, "confidence": max(0.0, min(1.0, conf)), "polygon": _clamp_polygon(poly, width, height), **hints})
            elif self._legacy is not None:
                rec, det = self._legacy
                preds = rec([rgb], det_predictor=det)
                page = preds[0] if preds else None
                for line in getattr(page, "text_lines", []) or []:
                    raw_content = getattr(line, "text", "")
                    text = _strip_markup(raw_content)
                    hints = _extract_markup_hints(raw_content)
                    if not text:
                        continue
                    raw_poly = getattr(line, "polygon", None)
                    bbox = getattr(line, "bbox", None)
                    if raw_poly and len(raw_poly) >= 4:
                        poly = [[float(pt[0]), float(pt[1])] for pt in raw_poly[:4]]
                    elif bbox and len(bbox) >= 4:
                        poly = _rect_polygon(bbox[0], bbox[1], bbox[2], bbox[3])
                    else:
                        continue
                    conf = float(getattr(line, "confidence", 0.9) or 0.9)
                    lines.append({"text": text, "confidence": max(0.0, min(1.0, conf)), "polygon": _clamp_polygon(poly, width, height), **hints})
        finally:
            rgb.close()
        return lines


class _MinerUAdapter(_BaseAdapter):
    def prepare(self, language: str) -> str:
        _widen_requests_default_timeout(120.0)
        import importlib.metadata
        import subprocess

        # 1. MinerU 4.x official Python model downloader with verification & multi-source fallback
        try:
            from mineru.model.download import download_model_repo, verify_model_repo
            from mineru.model.registry import model_repos_for_tier

            repos = list(model_repos_for_tier("basic"))
            total = max(1, len(repos))
            for idx, repo_key in enumerate(repos):
                pct = int(15 + (idx / total) * 75)
                if verify_model_repo(repo_key):
                    print(f"MinerU {repo_key} already verified ({pct}%).", file=sys.stderr, flush=True)
                    continue
                print(f"Downloading MinerU {repo_key} ({pct}%)...", file=sys.stderr, flush=True)
                last_exc: Exception | None = None
                attempts: list[tuple[str, str | None]] = [("huggingface", None)]
                if not os.environ.get("HF_ENDPOINT"):
                    attempts.append(("huggingface", "https://hf-mirror.com"))
                attempts.append(("modelscope", None))
                for src_name, mirror_ep in attempts:
                    prev_ep = os.environ.get("HF_ENDPOINT")
                    try:
                        if mirror_ep:
                            os.environ["HF_ENDPOINT"] = mirror_ep
                        download_model_repo(repo_key, source=src_name)
                        if verify_model_repo(repo_key):
                            last_exc = None
                            break
                        last_exc = RuntimeError(f"MinerU model '{repo_key}' incomplete after download from {src_name}")
                    except Exception as exc:
                        last_exc = exc
                    finally:
                        if mirror_ep:
                            if prev_ep is None:
                                os.environ.pop("HF_ENDPOINT", None)
                            else:
                                os.environ["HF_ENDPOINT"] = prev_ep
                if last_exc is not None:
                    raise RuntimeError(f"Failed to download MinerU sub-model '{repo_key}': {last_exc}") from last_exc
            print("MinerU weights verified (100%).", file=sys.stderr, flush=True)
            return importlib.metadata.version("mineru")
        except ImportError:
            pass

        # 2. Legacy / CLI fallback with strict exit-code verification
        dl_bin = shutil_which_in_venv("mineru-models-download")
        if dl_bin:
            cli_candidates = [
                [dl_bin, "--tier", "basic"],
                [dl_bin, "-s", "huggingface", "-m", "auto"],
                [dl_bin, "-s", "modelscope", "-m", "auto"],
            ]
            last_err = ""
            succeeded = False
            for cmd in cli_candidates:
                proc = subprocess.run(
                    cmd,
                    stdout=sys.stderr,
                    stderr=sys.stderr,
                    text=True,
                    timeout=1800,
                    check=False,
                )
                if proc.returncode == 0:
                    succeeded = True
                    break
                last_err = f"exit code {proc.returncode} for {' '.join(cmd)}"
            if not succeeded:
                raise RuntimeError(f"MinerU model download CLI failed ({last_err})")
        return importlib.metadata.version("mineru")

    @staticmethod
    def _extract_mineru_payload(
        payload: Any,
        width: int,
        height: int,
        *,
        coord_mode: str = "auto",
    ) -> list[dict[str, Any]]:
        lines: list[dict[str, Any]] = []

        def _visit(node: Any) -> None:
            if isinstance(node, list):
                for child in node:
                    _visit(child)
                return
            if not isinstance(node, dict):
                return
            raw_content = (
                node.get("text")
                or node.get("content")
                or node.get("markdown")
                or node.get("table_body")
                or ""
            )
            if not raw_content and isinstance(node.get("list_items"), list):
                raw_content = "\n".join(str(it) for it in node["list_items"] if str(it).strip())
            label = str(node.get("type") or node.get("category") or node.get("label") or "")
            if label.lower() in {"image", "figure", "discarded"}:
                return
            text = _strip_markup(raw_content)
            hints = _extract_markup_hints(raw_content, label)
            bbox = node.get("bbox")
            if text and isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
                bx0, by0, bx1, by1 = [float(v) for v in bbox[:4]]
                max_c = max(bx0, by0, bx1, by1)
                if coord_mode == "norm1000":
                    bx0, bx1 = bx0 * width / 1000.0, bx1 * width / 1000.0
                    by0, by1 = by0 * height / 1000.0, by1 * height / 1000.0
                elif coord_mode == "norm1":
                    bx0, bx1 = bx0 * width, bx1 * width
                    by0, by1 = by0 * height, by1 * height
                else:
                    has_frac = any(float(v) != int(float(v)) for v in bbox[:4])
                    if 0.0 < max_c <= 1.05 and (width > 2 or height > 2) and (has_frac or max_c <= 1.0):
                        bx0, bx1 = bx0 * width, bx1 * width
                        by0, by1 = by0 * height, by1 * height
                    elif max_c <= 1000.0 and (width > 1000 or height > 1000):
                        bx0, bx1 = bx0 * width / 1000.0, bx1 * width / 1000.0
                        by0, by1 = by0 * height / 1000.0, by1 * height / 1000.0
                poly = _clamp_polygon(_rect_polygon(bx0, by0, bx1, by1), width, height)
                lines.append({"text": text, "confidence": 0.9, "polygon": poly, **hints})
                return
            for key in ("pages", "pdf_info", "para_blocks", "blocks", "preproc_blocks", "lines", "spans"):
                if key in node:
                    _visit(node[key])

        _visit(payload)
        return lines

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        import subprocess
        import tempfile
        from PIL import Image

        try:
            import torch
            dev = _configure_torch_runtime(torch)
            os.environ.setdefault("MINERU_DEVICE_MODE", dev)
        except Exception:
            pass

        with Image.open(image_path) as im:
            width, height = im.size

        # 1. MinerU 4.x native Python parser API
        try:
            from mineru.parser import parse as mineru_parse
            parsed = mineru_parse(image_path, tier="basic", ocr_mode="ocr", image_analysis=False)
            try:
                from mineru.render import render_content_list
                rendered_list = render_content_list(parsed)
                cl_lines = self._extract_mineru_payload(rendered_list, width, height, coord_mode="norm1000")
                if cl_lines:
                    return cl_lines
            except Exception:
                pass
            raw_dict = parsed.to_dict() if hasattr(parsed, "to_dict") else parsed
            native_lines = self._extract_mineru_payload(raw_dict, width, height, coord_mode="norm1")
            if native_lines:
                return native_lines
        except ImportError:
            pass
        except Exception:
            pass

        # 2. MinerU 4.x `mineru-kit parse` or legacy 2.x/3.x `mineru` CLI
        with tempfile.TemporaryDirectory(prefix="comic-mineru-") as tmp:
            out_dir = Path(tmp) / "out"
            out_dir.mkdir(parents=True, exist_ok=True)
            kit_bin = shutil_which_in_venv("mineru-kit")
            if kit_bin:
                json_out = out_dir / "middle.json"
                proc = subprocess.run(
                    [kit_bin, "parse", image_path, "-o", str(json_out), "-f", "middle_json", "--ocr-mode", "ocr"],
                    capture_output=True,
                    text=True,
                    timeout=600,
                    check=False,
                )
            else:
                lang_map = {"eng": "en", "kor": "korean", "jpn": "japan", "chi_sim": "ch"}
                cmd = [sys.executable, "-m", "mineru.cli.client", "-p", image_path, "-o", str(out_dir), "-l", lang_map.get(language, "en")]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
                if proc.returncode != 0:
                    alt = shutil_which_in_venv("mineru")
                    if alt:
                        proc = subprocess.run([alt, "-p", image_path, "-o", str(out_dir)], capture_output=True, text=True, timeout=600, check=False)
            if proc.returncode != 0:
                raise RuntimeError((proc.stderr or proc.stdout or "MinerU execution failed")[-1200:])
            for json_file in out_dir.rglob("*.json"):
                try:
                    payload = json.loads(json_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                extracted = self._extract_mineru_payload(payload, width, height)
                if extracted:
                    return extracted
            return []


def shutil_which_in_venv(binary_name: str) -> str | None:
    import shutil
    scripts_dir = Path(sys.executable).parent
    for suffix in ("", ".exe", ".cmd"):
        candidate = scripts_dir / f"{binary_name}{suffix}"
        if candidate.is_file():
            return str(candidate)
    return shutil.which(binary_name)


def _has_flash_attn() -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec("flash_attn") is not None
    except Exception:
        return False


class _TransformersRegionAdapter(_BaseAdapter):
    preferred_attn: str | None = None
    system_prompt: str | None = None
    repetition_penalty: float | None = None

    def __init__(self, models_root: Path, hf_repo: str, prompt: str) -> None:
        super().__init__(models_root)
        self.hf_repo = hf_repo
        self.prompt = prompt
        self._model: Any = None
        self._processor: Any = None
        self._device: str = "cpu"

    def _candidate_loaders(self, transformers_mod: Any) -> list[Any]:
        loaders: list[Any] = []
        for attr in ("AutoModelForImageTextToText", "AutoModelForCausalLM", "AutoModel"):
            cls = getattr(transformers_mod, attr, None)
            if cls is not None:
                loaders.append(cls)
        return loaders

    def _load_processor(self, transformers_mod: Any, model_id: str) -> Any:
        auto_proc = getattr(transformers_mod, "AutoProcessor")
        auto_tok = getattr(transformers_mod, "AutoTokenizer")
        try:
            return auto_proc.from_pretrained(model_id, trust_remote_code=True)
        except Exception:
            return auto_tok.from_pretrained(model_id, trust_remote_code=True)

    def _load(self) -> tuple[Any, Any, str]:
        if self._model is not None and self._processor is not None:
            return self._model, self._processor, self._device
        import torch
        import transformers

        model_id = self.local_repo_or_id()
        device = _configure_torch_runtime(torch)
        if device == "cuda":
            bf16_ok = bool(hasattr(torch.cuda, "is_bf16_supported") and torch.cuda.is_bf16_supported())
            dtype = torch.bfloat16 if bf16_ok else torch.float16
        elif device == "mps":
            dtype = torch.float16
        else:
            dtype = torch.float32

        attn_candidates: list[str | None] = []
        if device == "cuda" and _has_flash_attn():
            attn_candidates.append("flash_attention_2")
        if self.preferred_attn and self.preferred_attn not in attn_candidates:
            attn_candidates.append(self.preferred_attn)
        for fallback_attn in ("sdpa", "eager", None):
            if fallback_attn not in attn_candidates:
                attn_candidates.append(fallback_attn)

        processor = self._load_processor(transformers, model_id)
        model = None
        last_err: Exception | None = None
        for loader in self._candidate_loaders(transformers):
            for attn_impl in attn_candidates:
                extra_kw: dict[str, Any] = {"trust_remote_code": True}
                if attn_impl is not None:
                    extra_kw["attn_implementation"] = attn_impl
                try:
                    try:
                        model = loader.from_pretrained(
                            model_id,
                            torch_dtype=dtype,
                            low_cpu_mem_usage=True,
                            **extra_kw,
                        )
                    except TypeError:
                        model = loader.from_pretrained(model_id, torch_dtype=dtype, **extra_kw)
                    break
                except Exception as exc:
                    last_err = exc
            if model is not None:
                break
        if model is None:
            raise RuntimeError(f"Could not load model {self.hf_repo}: {last_err}")
        try:
            model = model.to(device).eval()
        except Exception:
            if device != "cpu":
                device = "cpu"
                model = model.to(dtype=torch.float32, device="cpu").eval()
            else:
                raise
        self._model, self._processor, self._device = model, processor, device
        return model, processor, device

    def _infer_crop(self, crop_img: Any, *, max_tokens: int | None = None) -> str:
        import torch
        model, processor, device = self._load()
        cw, ch = getattr(crop_img, "size", (400, 200))
        if max_tokens is None:
            area = int(cw) * int(ch)
            if area >= 600_000:
                max_tokens = 2048
            elif area >= 180_000:
                max_tokens = 1024
            else:
                max_tokens = 512

        inputs = None
        has_chat_tmpl = bool(
            hasattr(processor, "apply_chat_template")
            and getattr(processor, "chat_template", None)
        )
        if has_chat_tmpl:
            messages: list[dict[str, Any]] = []
            if self.system_prompt is not None:
                messages.append({"role": "system", "content": self.system_prompt})
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": crop_img},
                        {"type": "text", "text": self.prompt},
                    ],
                }
            )
            try:
                text_input = processor.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
                inputs = processor(text=[text_input], images=[crop_img], return_tensors="pt")
            except (ValueError, TypeError, AttributeError):
                inputs = None

        if inputs is None:
            inputs = processor(images=crop_img, return_tensors="pt")

        if hasattr(inputs, "pop"):
            inputs.pop("token_type_ids", None)
        model_dtype = getattr(model, "dtype", None)
        prepared_inputs: dict[str, Any] = {}
        for k, v in inputs.items():
            if hasattr(v, "to"):
                if (
                    device != "cpu"
                    and model_dtype is not None
                    and hasattr(v, "is_floating_point")
                    and v.is_floating_point()
                ):
                    prepared_inputs[k] = v.to(device=device, dtype=model_dtype)
                else:
                    prepared_inputs[k] = v.to(device)
            else:
                prepared_inputs[k] = v

        gen_kwargs: dict[str, Any] = {"max_new_tokens": max_tokens, "do_sample": False}
        if self.repetition_penalty is not None:
            gen_kwargs["repetition_penalty"] = self.repetition_penalty

        grad_ctx = torch.inference_mode if hasattr(torch, "inference_mode") else torch.no_grad
        with grad_ctx():
            generated = model.generate(**prepared_inputs, **gen_kwargs)
        prompt_len = prepared_inputs["input_ids"].shape[-1] if "input_ids" in prepared_inputs else 0
        new_tokens = generated[:, prompt_len:] if prompt_len and generated.shape[-1] > prompt_len else generated
        decoded = processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
        del inputs, prepared_inputs, generated, new_tokens
        decoded = re.sub(r"<｜hy_[^｜]*｜>", "", decoded)
        return _strip_markup(decoded)

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        try:
            boxes = _default_regions(width, height, regions)
            lines: list[dict[str, Any]] = []
            for x0, y0, x1, y1 in boxes:
                crop = rgb.crop((int(x0), int(y0), int(x1), int(y1)))
                try:
                    text = self._infer_crop(crop)
                finally:
                    crop.close()
                if text:
                    poly = _clamp_polygon(_rect_polygon(x0, y0, x1, y1), width, height)
                    lines.append({"text": text, "confidence": 0.88, "polygon": poly})
            return lines
        finally:
            rgb.close()


class _DotsOcrAdapter(_TransformersRegionAdapter):
    LAYOUT_PROMPT = (
        "Please output the layout information from the image as a JSON list of objects with "
        "'bbox' ([x1, y1, x2, y2]) and 'text' fields. Output JSON only."
    )
    FALLBACK_HF_REPO = "rednote-hilab/dots.ocr"

    def __init__(self, models_root: Path) -> None:
        os.environ.setdefault("LOCAL_RANK", "0")
        super().__init__(models_root, "rednote-hilab/dots.mocr", self.LAYOUT_PROMPT)

    def prepare(self, language: str) -> str:
        os.environ.setdefault("LOCAL_RANK", "0")
        _widen_requests_default_timeout(120.0)
        assert self.hf_repo
        try:
            _, rev = self._download_hf_repo_resilient(self.hf_repo)
            return rev
        except Exception as exc:
            msg = str(exc).lower()
            if any(tok in msg for tok in ("404", "not found", "repositorynotfound", "gated")):
                _, rev = self._download_hf_repo_resilient(self.FALLBACK_HF_REPO)
                return rev
            raise

    def local_repo_or_id(self) -> str:
        os.environ.setdefault("LOCAL_RANK", "0")
        primary = super().local_repo_or_id()
        if primary != self.hf_repo:
            return primary
        alt_dir = self.models_root / "hf-repos" / self._safe_repo_folder_name(self.FALLBACK_HF_REPO)
        if alt_dir.is_dir() and any(alt_dir.iterdir()):
            return str(alt_dir)
        return primary

    @staticmethod
    def _extract_json_array(raw: str) -> list[Any] | None:
        decoder = json.JSONDecoder()
        empty_fallback: list[Any] | None = None
        cursor = 0
        while True:
            idx = raw.find("[", cursor)
            if idx < 0:
                return empty_fallback
            try:
                parsed, _ = decoder.raw_decode(raw, idx)
                if isinstance(parsed, list) and all(isinstance(el, dict) for el in parsed):
                    if parsed:
                        return parsed
                    empty_fallback = parsed
            except json.JSONDecodeError:
                pass
            cursor = idx + 1

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        os.environ.setdefault("LOCAL_RANK", "0")
        from PIL import Image
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        try:
            raw = self._infer_crop(rgb, max_tokens=2048)
        finally:
            rgb.close()
        items = self._extract_json_array(raw)
        if items is not None:
            try:
                lines: list[dict[str, Any]] = []
                for entry in items:
                    if not isinstance(entry, dict):
                        continue
                    bbox = entry.get("bbox")
                    raw_content = entry.get("text") or entry.get("content") or ""
                    label = str(entry.get("category") or entry.get("type") or entry.get("label") or "")
                    text = _strip_markup(raw_content)
                    hints = _extract_markup_hints(raw_content, label)
                    if not text or not bbox or len(bbox) < 4:
                        continue
                    poly = _clamp_polygon(_rect_polygon(bbox[0], bbox[1], bbox[2], bbox[3]), width, height)
                    lines.append({"text": text, "confidence": 0.9, "polygon": poly, **hints})
                if lines:
                    return lines
            except Exception:
                pass
        return super().recognize(image_path, language, regions)


class _DeepSeekOcr2Adapter(_TransformersRegionAdapter):
    preferred_attn = "eager"
    GROUNDING_RE = re.compile(
        r"<\|ref\|>(.*?)<\|/ref\|>\s*<\|det\|>\s*\[\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]\]\s*<\|/det\|>",
        re.DOTALL,
    )

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root, "deepseek-ai/DeepSeek-OCR-2", "Extract all text from this image.")

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        with Image.open(image_path) as im:
            width, height = im.size
        model, processor, _ = self._load()
        if hasattr(model, "infer"):
            import tempfile
            with tempfile.TemporaryDirectory(prefix="comic-dpsk-") as tmp:
                res = model.infer(
                    processor,
                    prompt="<image>\n<|grounding|>Convert the document to markdown. ",
                    image_file=image_path,
                    output_path=tmp,
                    base_size=1024,
                    image_size=768,
                    crop_mode=True,
                    save_results=False,
                )
                raw = str(res or "")
                grounded: list[dict[str, Any]] = []
                for match in self.GROUNDING_RE.finditer(raw):
                    text = _strip_markup(match.group(1))
                    if not text:
                        continue
                    nx0, ny0, nx1, ny1 = [float(match.group(i)) for i in range(2, 6)]
                    scale_x = width / 1000.0 if max(nx0, nx1) <= 1000.0 else 1.0
                    scale_y = height / 1000.0 if max(ny0, ny1) <= 1000.0 else 1.0
                    poly = _clamp_polygon(_rect_polygon(nx0 * scale_x, ny0 * scale_y, nx1 * scale_x, ny1 * scale_y), width, height)
                    grounded.append({"text": text, "confidence": 0.9, "polygon": poly})
                if grounded:
                    return grounded
        return super().recognize(image_path, language, regions)


class _HunyuanOcrAdapter(_TransformersRegionAdapter):
    hf_ignore_patterns = ("v1.0/*", "dflash/*")
    preferred_attn = "eager"
    system_prompt = ""
    repetition_penalty = 1.08

    def __init__(self, models_root: Path) -> None:
        super().__init__(
            models_root,
            "tencent/HunyuanOCR",
            "Extract all text from the image accurately, preserving line breaks.",
        )

    def _candidate_loaders(self, transformers_mod: Any) -> list[Any]:
        loaders: list[Any] = []
        hy_cls = getattr(transformers_mod, "HunYuanVLForConditionalGeneration", None)
        if hy_cls is not None:
            loaders.append(hy_cls)
        loaders.extend(super()._candidate_loaders(transformers_mod))
        return loaders

    def _load_processor(self, transformers_mod: Any, model_id: str) -> Any:
        auto_proc = getattr(transformers_mod, "AutoProcessor")
        try:
            proc = auto_proc.from_pretrained(model_id, trust_remote_code=True, use_fast=False)
        except Exception:
            proc = super()._load_processor(transformers_mod, model_id)
        if getattr(proc, "video_token", None) is None:
            with contextlib.suppress(Exception):
                proc.video_token = "<｜hy_video｜>"
        return proc


def _create_adapter(engine_id: str, models_root: Path) -> _BaseAdapter:
    if engine_id == "paddleocr-vl-1-6":
        return _PaddleOcrVlAdapter(models_root)
    if engine_id == "surya":
        return _SuryaAdapter(models_root)
    if engine_id == "mineru-2-5-pro":
        return _MinerUAdapter(models_root)
    if engine_id == "dots-ocr":
        return _DotsOcrAdapter(models_root)
    if engine_id == "deepseek-ocr-2":
        return _DeepSeekOcr2Adapter(models_root)
    if engine_id == "got-ocr-2":
        return _TransformersRegionAdapter(models_root, "stepfun-ai/GOT-OCR-2.0-hf", "OCR this text accurately.")
    if engine_id == "glm-ocr":
        return _TransformersRegionAdapter(models_root, "zai-org/GLM-OCR", "Recognize all text in this image region.")
    if engine_id == "olmocr":
        return _TransformersRegionAdapter(models_root, "allenai/olmOCR-2-7B-1025", "Read the exact text in this image.")
    if engine_id == "hunyuan-ocr":
        return _HunyuanOcrAdapter(models_root)
    raise ValueError(f"Unsupported isolated engine: {engine_id}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Comic OCR Studio isolated OCR worker")
    parser.add_argument("--engine", required=True)
    parser.add_argument("--models-root", required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--language", default="eng")
    args = parser.parse_args()

    protocol_out = sys.stdout
    models_root = Path(args.models_root).resolve()
    _configure_cache_dirs(models_root)
    with contextlib.redirect_stdout(sys.stderr):
        adapter = _create_adapter(args.engine, models_root)

    if args.prepare:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                revision = adapter.prepare(args.language)
            protocol_out.write(json.dumps({"ok": True, "modelRevision": revision}) + "\n")
            protocol_out.flush()
            return 0
        except Exception as exc:
            protocol_out.write(json.dumps({"ok": False, "error": f"{exc}\n{traceback.format_exc()[-1000:]}"}) + "\n")
            protocol_out.flush()
            return 1

    if args.serve:
        protocol_out.write(json.dumps({"ready": True, "engine": args.engine}) + "\n")
        protocol_out.flush()
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                if req.get("cmd") == "ping":
                    resp = {"ok": True, "pong": True}
                elif req.get("cmd") == "quit":
                    with contextlib.suppress(Exception):
                        adapter.close()
                    protocol_out.write(json.dumps({"ok": True, "bye": True}) + "\n")
                    protocol_out.flush()
                    return 0
                else:
                    try:
                        with contextlib.redirect_stdout(sys.stderr):
                            out_lines = adapter.recognize(
                                req["imagePath"],
                                req.get("language", "eng"),
                                req.get("regions"),
                            )
                        resp = {"ok": True, "lines": out_lines}
                    finally:
                        _release_worker_caches()
            except Exception as exc:
                resp = {"ok": False, "error": str(exc)}
            protocol_out.write(json.dumps(resp, ensure_ascii=False) + "\n")
            protocol_out.flush()
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
