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
    hezar_dir = models_root / "hezar"
    for directory in (hf_dir, paddlex_dir, torch_dir, surya_dir, mineru_dir, hezar_dir):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(hf_dir))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_dir / "hub"))
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(paddlex_dir))
    os.environ.setdefault("TORCH_HOME", str(torch_dir))
    os.environ.setdefault("MODEL_CACHE_DIR", str(surya_dir))
    os.environ.setdefault("MINERU_HOME", str(mineru_dir))
    os.environ.setdefault("HEZAR_CACHE_DIR", str(hezar_dir))
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


def _is_hf_network_or_hub_error(exc: BaseException) -> bool:
    err_low = f"{type(exc).__name__}: {exc}".lower()
    if any(fatal in err_low for fatal in ("401 client error", "404 client error", "repository not found", "gatedrepoerror", "entry not found")):
        return False
    return any(
        marker in err_low
        for marker in (
            "timed out",
            "timeout",
            "connection",
            "connecterror",
            "readerror",
            "ssl",
            "chunked",
            "reset",
            "eof",
            "getaddrinfo",
            "name or service not known",
            "nameresolutionerror",
            "temporary failure",
            "unreachable",
            "remoteprotocolerror",
            "localentrynotfounderror",
            "max retries",
            "maxretryerror",
            "403",
            "429",
            "500",
            "502",
            "503",
            "504",
            "bad gateway",
            "service unavailable",
            "forbidden",
        )
    )


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
        import shutil
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
            if not _is_hf_network_or_hub_error(first_exc) or os.environ.get("HF_ENDPOINT"):
                raise
            used_endpoint = "https://hf-mirror.com"
            print(f"Retrying {repo_id} via hf-mirror.com (30%)...", file=sys.stderr, flush=True)
            snapshot_download(max_workers=2, endpoint=used_endpoint, **dl_kwargs)
        # Remove huggingface_hub's local_dir `.cache/` metadata tree so libraries like `hezar`
        # that walk `local_dir` recursively for `*.yaml` never trip on `.cache/huggingface/download/...`
        dl_cache = local_dir / ".cache"
        if dl_cache.is_dir():
            with contextlib.suppress(OSError):
                shutil.rmtree(dl_cache, ignore_errors=True)
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


def _configure_paddle_cpu_safe_env() -> None:
    """Disable PaddlePaddle 3.3.x PIR -> oneDNN path before PaddleX/PaddleOCR reads flags.

    In PaddlePaddle 3.3.0/3.3.1, oneDNN's PIR attribute converter lacks support for
    ``pir::ArrayAttribute<pir::DoubleAttribute>`` (``onednn_instruction.cc:118``), which
    crashes ``PaddleOCRVL``'s CPU ``'cv'`` layout/preprocess worker when MKLDNN is active.
    """
    os.environ["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] = "False"
    os.environ["FLAGS_use_mkldnn"] = "0"
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    pdx_flags = sys.modules.get("paddlex.utils.flags")
    if pdx_flags is not None:
        with contextlib.suppress(Exception):
            pdx_flags.ENABLE_MKLDNN_BYDEFAULT = False  # type: ignore[attr-defined]
    pocr_consts = sys.modules.get("paddleocr._constants")
    if pocr_consts is not None:
        with contextlib.suppress(Exception):
            pocr_consts.DEFAULT_ENABLE_MKLDNN = False  # type: ignore[attr-defined]
    paddle_mod = sys.modules.get("paddle")
    if paddle_mod is not None and hasattr(paddle_mod, "set_flags"):
        with contextlib.suppress(Exception):
            paddle_mod.set_flags({"FLAGS_use_mkldnn": False})


def _is_paddle_onednn_pir_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        marker in msg
        for marker in (
            "convertpirattribute2runtimeattribute",
            "onednn_instruction",
            "onednn",
            "mkldnn",
            "pir::arrayattribute<pir::doubleattribute>",
        )
    )


def _select_paddleocr_vl_version(pvl_module: Any, models_root: Path | None = None) -> str | None:
    supported = getattr(pvl_module, "_AVAILABLE_PIPELINE_VERSIONS", None)
    if isinstance(supported, (list, tuple, set)) and supported:
        # If the user already downloaded v1.5 weights locally (and v1.6 is not cached),
        # prefer the already-cached pipeline version to avoid an unexpected multi-GB re-download.
        if models_root is not None and "v1.5" in supported:
            official_dir = models_root / "paddlex" / "official_models"
            try:
                has_v15 = any(official_dir.glob("*PaddleOCR-VL-1.5*")) if official_dir.is_dir() else False
                has_v16 = any(official_dir.glob("*PaddleOCR-VL-1.6*")) if official_dir.is_dir() else False
                if has_v15 and not has_v16:
                    return "v1.5"
            except OSError:
                pass
        for preferred in ("v1.6", "v1.5", "v1"):
            if preferred in supported:
                return preferred
        return str(list(supported)[-1])
    default_ver = getattr(pvl_module, "_DEFAULT_PIPELINE_VERSION", None)
    return str(default_ver) if default_ver else None


class _PaddleOcrVlAdapter(_BaseAdapter):
    _CPU_MAX_SIDE = 2200

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self._pipeline: Any = None
        self._device: str = "cpu"

    def _get_pipeline(self, *, force_cpu: bool = False) -> Any:
        if self._pipeline is None:
            _configure_paddle_cpu_safe_env()
            from paddleocr import PaddleOCRVL
            try:
                from paddleocr._pipelines import paddleocr_vl as _pvl_mod
            except Exception:
                _pvl_mod = None

            chosen_ver = _select_paddleocr_vl_version(_pvl_mod, self.models_root) if _pvl_mod is not None else None
            candidates: list[str | None] = []
            if chosen_ver:
                candidates.append(chosen_ver)
            for fallback_ver in ("v1.6", "v1.5", "v1", None):
                if fallback_ver not in candidates:
                    candidates.append(fallback_ver)

            paddle_device: str | None = "cpu" if force_cpu else None
            if not force_cpu:
                try:
                    import paddle
                    if hasattr(paddle, "set_flags"):
                        with contextlib.suppress(Exception):
                            paddle.set_flags({"FLAGS_use_mkldnn": False})
                    if hasattr(paddle, "device") and paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
                        paddle_device = "gpu:0"
                    else:
                        paddle_device = "cpu"
                except Exception:
                    paddle_device = None
            self._device = "gpu" if (paddle_device or "").startswith("gpu") else "cpu"
            cpu_threads = max(1, min(12, os.cpu_count() or 4))

            last_err: Exception | None = None
            for candidate in candidates:
                ver_kwargs: dict[str, Any] = {}
                if candidate is not None:
                    ver_kwargs["pipeline_version"] = candidate
                device_kwargs = {"device": paddle_device} if paddle_device else {}
                attempt_kwargs_list: list[dict[str, Any]] = []
                if self._device == "cpu":
                    attempt_kwargs_list.append({
                        "use_chart_recognition": False,
                        "use_seal_recognition": False,
                        "enable_mkldnn": False,
                        "use_queues": False,
                        "cpu_threads": cpu_threads,
                        **device_kwargs,
                        **ver_kwargs,
                    })
                attempt_kwargs_list.extend([
                    {
                        "use_chart_recognition": False,
                        "use_seal_recognition": False,
                        "enable_mkldnn": False,
                        **device_kwargs,
                        **ver_kwargs,
                    },
                    {
                        "use_chart_recognition": False,
                        "use_seal_recognition": False,
                        **device_kwargs,
                        **ver_kwargs,
                    },
                    {
                        "use_chart_recognition": False,
                        "use_seal_recognition": False,
                        **ver_kwargs,
                    },
                    dict(ver_kwargs),
                ])

                invalid_ver = False
                for call_kwargs in attempt_kwargs_list:
                    try:
                        self._pipeline = PaddleOCRVL(**call_kwargs)
                        break
                    except (TypeError, ValueError) as exc:
                        err_text = str(exc)
                        if isinstance(exc, ValueError) and "Invalid pipeline version" in err_text:
                            last_err = exc
                            invalid_ver = True
                            break
                        if isinstance(exc, ValueError) and "Unknown argument:" not in err_text:
                            raise
                        last_err = exc
                        continue
                if self._pipeline is not None:
                    break
                if invalid_ver:
                    continue
            if self._pipeline is None:
                raise RuntimeError(f"Could not initialize PaddleOCRVL pipeline: {last_err}")
        return self._pipeline

    def prepare(self, language: str) -> str:
        _widen_requests_default_timeout(120.0)
        _configure_paddle_cpu_safe_env()
        print("Preparing PaddleOCR-VL sub-models (20%)...", file=sys.stderr, flush=True)
        try:
            self._get_pipeline()
        except Exception as first_exc:
            if not _is_hf_network_or_hub_error(first_exc) or os.environ.get("PADDLE_PDX_HUGGING_FACE_ENDPOINT"):
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
        import tempfile
        from PIL import Image

        with Image.open(image_path) as im:
            width, height = im.size

        pipeline = self._get_pipeline()
        target_path = image_path
        scale_x = 1.0
        scale_y = 1.0
        temp_scaled_path: str | None = None
        try:
            if self._device == "cpu" and max(width, height) > self._CPU_MAX_SIDE:
                ratio = float(self._CPU_MAX_SIDE) / float(max(width, height))
                scaled_w = max(32, int(round(width * ratio)))
                scaled_h = max(32, int(round(height * ratio)))
                scale_x = float(width) / float(scaled_w)
                scale_y = float(height) / float(scaled_h)
                fd, tmp_name = tempfile.mkstemp(prefix="pvl_cpu_", suffix=".png")
                os.close(fd)
                temp_scaled_path = tmp_name
                with Image.open(image_path) as raw_im:
                    rgb_im = raw_im.convert("RGB")
                    resized = rgb_im.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)
                    try:
                        resized.save(temp_scaled_path, format="PNG")
                    finally:
                        resized.close()
                        if rgb_im is not raw_im:
                            rgb_im.close()
                target_path = temp_scaled_path

            try:
                pages = list(pipeline.predict(target_path))
            except Exception as pred_exc:
                if not (_is_paddle_onednn_pir_error(pred_exc) or self._device == "gpu"):
                    raise
                print(
                    f"PaddleOCR-VL runtime fallback triggered ({pred_exc}); rebuilding CPU pipeline with MKLDNN disabled...",
                    file=sys.stderr,
                    flush=True,
                )
                _configure_paddle_cpu_safe_env()
                self._pipeline = None
                pipeline = self._get_pipeline(force_cpu=True)
                if max(width, height) > self._CPU_MAX_SIDE and temp_scaled_path is None:
                    ratio = float(self._CPU_MAX_SIDE) / float(max(width, height))
                    scaled_w = max(32, int(round(width * ratio)))
                    scaled_h = max(32, int(round(height * ratio)))
                    scale_x = float(width) / float(scaled_w)
                    scale_y = float(height) / float(scaled_h)
                    fd, tmp_name = tempfile.mkstemp(prefix="pvl_cpu_", suffix=".png")
                    os.close(fd)
                    temp_scaled_path = tmp_name
                    with Image.open(image_path) as raw_im:
                        rgb_im = raw_im.convert("RGB")
                        resized = rgb_im.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)
                        try:
                            resized.save(temp_scaled_path, format="PNG")
                        finally:
                            resized.close()
                            if rgb_im is not raw_im:
                                rgb_im.close()
                    target_path = temp_scaled_path
                pages = list(pipeline.predict(target_path))
        finally:
            if temp_scaled_path:
                with contextlib.suppress(OSError):
                    os.remove(temp_scaled_path)

        lines: list[dict[str, Any]] = []
        for page in pages:
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
                bx0 = float(bbox[0]) * scale_x
                by0 = float(bbox[1]) * scale_y
                bx1 = float(bbox[2]) * scale_x
                by1 = float(bbox[3]) * scale_y
                poly = _clamp_polygon(_rect_polygon(bx0, by0, bx1, by1), width, height)
                lines.append({"text": content, "confidence": max(0.0, min(1.0, score)), "polygon": poly, **hints})
        return lines


class _SuryaAdapter(_BaseAdapter):
    _SKIP_LABELS = {"Figure", "Image", "Diagram", "Blank-Page"}

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self._manager: Any = None
        self._predictor: Any = None
        self._legacy: tuple[Any, Any] | None = None
        self._layout_detector: Any = None
        self._layout_detector_checked: bool = False

    @staticmethod
    def _sync_surya_runtime_settings() -> None:
        try:
            from surya.settings import settings as _ss
            ctx_val = int(os.environ.get("SURYA_INFERENCE_CTX_SIZE", "24576") or "24576")
            max_tok = int(os.environ.get("SURYA_MAX_TOKENS_FULL_PAGE", "4096") or "4096")
            ngl_val = int(os.environ.get("LLAMA_CPP_NGL", "0") or "0")
            logprobs_raw = str(os.environ.get("SURYA_INFERENCE_LOGPROBS", "false")).strip().lower()
            _ss.SURYA_INFERENCE_BACKEND = "llamacpp"
            _ss.SURYA_INFERENCE_PARALLEL = 1
            _ss.SURYA_INFERENCE_CTX_SIZE = ctx_val
            _ss.SURYA_MAX_TOKENS_FULL_PAGE = max_tok
            _ss.SURYA_INFERENCE_LOGPROBS = logprobs_raw in {"1", "true", "yes"}
            _ss.LLAMA_CPP_NGL = ngl_val
        except Exception:
            pass

    def _ensure_loaded(self) -> None:
        if self._predictor is not None or self._legacy is not None:
            return
        try:
            import torch
            dev = _configure_torch_runtime(torch)
            os.environ.setdefault("TORCH_DEVICE", dev)
        except Exception:
            pass
        self._sync_surya_runtime_settings()
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
        self._legacy = None
        self._layout_detector = None
        self._layout_detector_checked = False
        server_pid: int | None = None
        if mgr is not None:
            backend = getattr(mgr, "backend", None)
            handle = getattr(backend, "handle", None) if backend is not None else None
            proc = getattr(handle, "process", None) if handle is not None else None
            if proc is not None and hasattr(proc, "pid"):
                server_pid = int(proc.pid)
            elif handle is not None and hasattr(handle, "pid"):
                try:
                    server_pid = int(handle.pid)
                except Exception:
                    server_pid = None
            if hasattr(mgr, "stop"):
                with contextlib.suppress(Exception):
                    mgr.stop()
        if server_pid is None:
            state_json = Path(os.path.expanduser("~/.cache/datalab/surya/llamacpp_server.json"))
            if state_json.is_file():
                with contextlib.suppress(Exception):
                    meta = json.loads(state_json.read_text(encoding="utf-8"))
                    if isinstance(meta, dict) and meta.get("pid"):
                        server_pid = int(meta["pid"])
                with contextlib.suppress(OSError):
                    state_json.unlink()
        if server_pid and server_pid > 0 and server_pid != os.getpid():
            with contextlib.suppress(Exception):
                if os.name == "nt":
                    import subprocess as _sp
                    _sp.run(["taskkill", "/F", "/T", "/PID", str(server_pid)], capture_output=True, timeout=4, check=False)
                else:
                    import signal as _sig
                    os.kill(server_pid, _sig.SIGTERM)

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
                    if not _is_hf_network_or_hub_error(first_exc) or os.environ.get("HF_ENDPOINT"):
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

    def _detect_fast_layout_inprocess(self, rgb: Any) -> Any:
        """Run Surya's local rf-detr (`datalab-to/surya_layout2`) in-process (~0.3s on CPU)
        when already cached on disk so per-block recognition runs with ~10x fewer visual tokens
        and never depends on llama-server `--special` compact tokens."""
        try:
            from surya.common.rfdetr_torch import load_detector
            from surya.fast_layout import build_layout_result
            from surya.settings import settings as _ss
        except Exception:
            return None

        if not self._layout_detector_checked:
            self._layout_detector_checked = True
            ckpt = str(getattr(_ss, "FAST_LAYOUT_MODEL_CHECKPOINT", "") or "")
            local_dir: str | None = None
            if ckpt.startswith("hf://"):
                parts = ckpt[len("hf://"):].split("/")
                repo_id = "/".join(parts[:2])
                subfolder = "/".join(parts[2:])
                try:
                    from huggingface_hub import snapshot_download
                    snap = snapshot_download(
                        repo_id,
                        local_files_only=True,
                        allow_patterns=[f"{subfolder}/*"] if subfolder else None,
                    )
                    cand = os.path.join(snap, subfolder) if subfolder else snap
                    if os.path.isdir(cand):
                        local_dir = cand
                except Exception:
                    local_dir = None
            elif ckpt and os.path.isdir(ckpt):
                local_dir = ckpt
            if local_dir:
                with contextlib.suppress(Exception):
                    self._layout_detector = load_detector(
                        local_dir,
                        num_threads=getattr(_ss, "FAST_LAYOUT_NUM_THREADS", None),
                        device=getattr(_ss, "FAST_DETECTOR_DEVICE", None),
                    )

        if self._layout_detector is None:
            return None
        try:
            thresh = float(getattr(_ss, "FAST_LAYOUT_CONFIDENCE_THRESHOLD", 0.35) or 0.35)
            dets_list = self._layout_detector.detect([rgb], threshold=thresh)
            if not dets_list:
                return None
            layout_res = build_layout_result(rgb, dets_list[0], order=None)
            text_boxes = [
                b for b in (getattr(layout_res, "bboxes", None) or [])
                if str(getattr(b, "label", "")) not in self._SKIP_LABELS
            ]
            return layout_res if text_boxes else None
        except Exception:
            return None

    @staticmethod
    def _build_region_layout_fallback(rgb: Any, regions: list[list[float]] | None) -> Any:
        try:
            from surya.layout.schema import LayoutBox, LayoutResult
        except Exception:
            return None
        width, height = rgb.size
        candidate_boxes: list[tuple[float, float, float, float]] = []
        if regions:
            for item in regions:
                if isinstance(item, (list, tuple)) and len(item) == 4:
                    x0, y0, x1, y1 = [float(v) for v in item]
                    x0 = max(0.0, min(float(width - 1), x0))
                    y0 = max(0.0, min(float(height - 1), y0))
                    x1 = max(x0 + 6.0, min(float(width), x1))
                    y1 = max(y0 + 6.0, min(float(height), y1))
                    if (x1 - x0) >= 12 and (y1 - y0) >= 10:
                        candidate_boxes.append((x0, y0, x1, y1))
        if not candidate_boxes:
            try:
                import cv2
                import numpy as np
                gray = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2GRAY)
                _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
                if float(np.mean(bw > 0)) > 0.55:
                    bw = 255 - bw
                kw = max(15, width // 32)
                kh = max(5, height // 110)
                merged = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, kh)))
                contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                raw_rects: list[tuple[float, float, float, float]] = []
                for cnt in contours:
                    rx, ry, rw, rh = cv2.boundingRect(cnt)
                    if rw >= max(18, width // 50) and rh >= 10 and (rw * rh) <= (width * height * 0.92):
                        pad_x = max(4, int(rh * 0.18))
                        pad_y = max(3, int(rh * 0.22))
                        raw_rects.append((
                            float(max(0, rx - pad_x)),
                            float(max(0, ry - pad_y)),
                            float(min(width, rx + rw + pad_x)),
                            float(min(height, ry + rh + pad_y)),
                        ))
                raw_rects.sort(key=lambda r: (round(r[1] / 24.0), r[0]))
                candidate_boxes = raw_rects[:48]
            except Exception:
                candidate_boxes = []
        if not candidate_boxes:
            return None
        layout_boxes = []
        for idx, (x0, y0, x1, y1) in enumerate(candidate_boxes):
            poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
            try:
                lb = LayoutBox(polygon=poly, label="Text", raw_label="Text", position=idx, confidence=0.95, count=256)
            except TypeError:
                lb = LayoutBox(polygon=poly, label="Text", position=idx, confidence=0.95)
            layout_boxes.append(lb)
        return LayoutResult(bboxes=layout_boxes, image_bbox=[0.0, 0.0, float(width), float(height)])

    @staticmethod
    def _is_blank_image(rgb: Any) -> bool:
        try:
            from surya.common.blank import is_blank
            return bool(is_blank(rgb))
        except Exception:
            try:
                import numpy as np
                arr = np.asarray(rgb)
                return bool(arr.std() < 2.0)
            except Exception:
                return False

    @staticmethod
    def _extract_surya_lines(preds: Any, width: int, height: int) -> tuple[list[dict[str, Any]], bool]:
        lines: list[dict[str, Any]] = []
        page = preds[0] if preds else None
        if page is None:
            return lines, False
        blocks = list(getattr(page, "blocks", None) or [])
        had_error = bool(getattr(page, "error", False)) or any(bool(getattr(b, "error", False)) for b in blocks)
        for block in blocks:
            if getattr(block, "skipped", False):
                continue
            raw_content = getattr(block, "html", "") or getattr(block, "text", "")
            label = str(getattr(block, "label", "") or getattr(block, "block_type", "") or "")
            text = _strip_markup(raw_content)
            if not text:
                continue
            hints = _extract_markup_hints(raw_content, label)
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
        return lines, had_error

    @staticmethod
    def _read_llama_server_error_tail() -> str:
        log_path = Path(os.path.expanduser("~/.cache/datalab/surya/llamacpp_server.log"))
        if not log_path.is_file():
            return ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
            relevant = [ln.strip() for ln in tail if ln.strip()]
            return " | ".join(relevant[-4:])[-400:]
        except Exception:
            return ""

    def _invoke_surya_predictor(self, rgb: Any, layout_res: Any = None) -> Any:
        assert self._predictor is not None
        if layout_res is not None:
            try:
                return self._predictor([rgb], layout_results=[layout_res])
            except TypeError:
                return self._predictor([rgb])
        return self._predictor([rgb])

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        self._ensure_loaded()
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        lines: list[dict[str, Any]] = []
        try:
            if self._predictor is not None:
                page_blank = self._is_blank_image(rgb)
                fast_layout = None if page_blank else self._detect_fast_layout_inprocess(rgb)
                had_error = False

                def _run_pass() -> tuple[list[dict[str, Any]], bool]:
                    if fast_layout is not None:
                        p_fast = self._invoke_surya_predictor(rgb, fast_layout)
                        l_fast, err_fast = self._extract_surya_lines(p_fast, width, height)
                        if l_fast:
                            return l_fast, err_fast
                        if err_fast:
                            return [], True
                    p_full = self._invoke_surya_predictor(rgb, None)
                    return self._extract_surya_lines(p_full, width, height)

                try:
                    lines, had_error = _run_pass()
                except Exception:
                    if os.environ.get("LLAMA_CPP_NGL", "0") != "0":
                        self.close()
                        os.environ["LLAMA_CPP_NGL"] = "0"
                        self._ensure_loaded()
                        lines, had_error = _run_pass()
                    else:
                        raise

                # Surya's openai_client swallows llama-server HTTP errors into BlockOCRResult(error=True)
                # without raising an exception! Recover on CPU if GPU offload was active.
                if not lines and not page_blank and (had_error or os.environ.get("LLAMA_CPP_NGL", "0") != "0"):
                    if os.environ.get("LLAMA_CPP_NGL", "0") != "0":
                        self.close()
                        os.environ["LLAMA_CPP_NGL"] = "0"
                        self._ensure_loaded()
                        lines, had_error = _run_pass()

                # If full-page special-token parsing returned 0 blocks on a non-blank page without fast_layout,
                # run per-block BLOCK_PROMPT on OpenCV/provided text regions.
                if not lines and not page_blank and fast_layout is None:
                    region_layout = self._build_region_layout_fallback(rgb, regions)
                    if region_layout is not None:
                        try:
                            p_reg = self._predictor([rgb], layout_results=[region_layout])
                            reg_lines, reg_err = self._extract_surya_lines(p_reg, width, height)
                            if reg_lines:
                                lines = reg_lines
                                had_error = False
                            elif reg_err:
                                had_error = True
                        except TypeError:
                            pass

                if not lines and had_error:
                    log_hint = self._read_llama_server_error_tail()
                    detail = f" ({log_hint})" if log_hint else ""
                    raise RuntimeError(f"Surya llama-server inference returned an error{detail}")
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
    @staticmethod
    def _mineru_repo_is_ready(verify_result: Any) -> bool:
        if hasattr(verify_result, "ready"):
            return bool(verify_result.ready)
        if isinstance(verify_result, dict) and "ready" in verify_result:
            return bool(verify_result["ready"])
        return bool(verify_result)

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
                if self._mineru_repo_is_ready(verify_model_repo(repo_key)):
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
                        if self._mineru_repo_is_ready(verify_model_repo(repo_key)):
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
            middle_obj = getattr(parsed, "middle_json", parsed)
            try:
                from mineru.render import render_content_list
                rendered_list = render_content_list(middle_obj)
                cl_lines = self._extract_mineru_payload(rendered_list, width, height, coord_mode="norm1000")
                if cl_lines:
                    return cl_lines
            except Exception:
                pass
            raw_dict = (
                middle_obj.to_dict()
                if hasattr(middle_obj, "to_dict")
                else (parsed.to_dict() if hasattr(parsed, "to_dict") else parsed)
            )
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
                    [
                        kit_bin,
                        "parse",
                        image_path,
                        "-o",
                        str(json_out),
                        "-f",
                        "middle_json",
                        "--tier",
                        "basic",
                        "--disable-image-analysis",
                        "--ocr-mode",
                        "ocr",
                    ],
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


def _sanitize_config_attn(config: Any, attn_impl: str | None) -> Any:
    """Override hardcoded nested ``flash_attention_2`` in remote configs (e.g. dots.ocr, DeepSeek-OCR-2)
    when ``flash_attn`` is unavailable on Windows/CPU."""
    if config is None or attn_impl is None:
        return config
    seen: set[int] = set()

    def _patch(cfg_obj: Any) -> None:
        if cfg_obj is None or id(cfg_obj) in seen:
            return
        seen.add(id(cfg_obj))
        for attr_name in ("attn_implementation", "_attn_implementation", "_attn_implementation_internal"):
            if hasattr(cfg_obj, attr_name):
                with contextlib.suppress(Exception):
                    setattr(cfg_obj, attr_name, attn_impl)
        for sub_name in ("vision_config", "text_config", "language_config", "llm_config", "audio_config"):
            sub_cfg = getattr(cfg_obj, sub_name, None)
            if sub_cfg is not None and not isinstance(sub_cfg, dict):
                _patch(sub_cfg)
            elif isinstance(sub_cfg, dict) and "attn_implementation" in sub_cfg:
                sub_cfg["attn_implementation"] = attn_impl

    _patch(config)
    return config


def _install_transformers_v4_compat_shims(transformers_mod: Any) -> None:
    """Restore symbols removed in transformers 4.48–4.57 that remote-code OCR models
    (notably ``deepseek-ai/DeepSeek-OCR-2``) still import or call."""
    import importlib

    with contextlib.suppress(Exception):
        modeling_llama = sys.modules.get("transformers.models.llama.modeling_llama")
        if modeling_llama is None:
            modeling_llama = importlib.import_module("transformers.models.llama.modeling_llama")
        base_attn = getattr(modeling_llama, "LlamaAttention", None)
        if base_attn is not None:
            if not hasattr(modeling_llama, "LlamaFlashAttention2"):
                setattr(modeling_llama, "LlamaFlashAttention2", base_attn)
            if not hasattr(modeling_llama, "LlamaSdpaAttention"):
                setattr(modeling_llama, "LlamaSdpaAttention", base_attn)
    with contextlib.suppress(Exception):
        cache_utils = getattr(transformers_mod, "cache_utils", None)
        if cache_utils is None:
            import transformers.cache_utils as cache_utils  # type: ignore[no-redef]
        dyn_cache = getattr(cache_utils, "DynamicCache", None)
        if dyn_cache is not None:
            if not hasattr(dyn_cache, "seen_tokens"):
                setattr(
                    dyn_cache,
                    "seen_tokens",
                    property(lambda self: self.get_seq_length() if hasattr(self, "get_seq_length") else 0),
                )
            if not hasattr(dyn_cache, "get_max_length"):
                setattr(
                    dyn_cache,
                    "get_max_length",
                    lambda self: self.get_max_cache_shape() if hasattr(self, "get_max_cache_shape") else None,
                )
            if not hasattr(dyn_cache, "get_usable_length"):
                setattr(
                    dyn_cache,
                    "get_usable_length",
                    lambda self, new_seq_length, layer_idx=0: (
                        self.get_seq_length(layer_idx) if hasattr(self, "get_seq_length") else 0
                    ),
                )


def _normalize_crop_for_vlm(crop_img: Any, *, max_long_side: int | None = None) -> tuple[Any, bool]:
    """Ensure RGB mode, minimum 32x32 size (preventing ``factor:28`` ValueError in Qwen2.5-VL,
    GLM-OCR, dots.ocr, olmOCR, and HunyuanOCR), and bounded aspect ratio <= 160."""
    import math
    from PIL import Image

    owned = False
    img = crop_img
    if getattr(img, "mode", "RGB") != "RGB":
        img = img.convert("RGB")
        owned = True

    w, h = getattr(img, "size", (0, 0))
    if w <= 0 or h <= 0:
        return img, owned

    if max_long_side and max(w, h) > max_long_side:
        scale = float(max_long_side) / float(max(w, h))
        nw = max(32, int(round(w * scale)))
        nh = max(32, int(round(h * scale)))
        resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
        if owned:
            img.close()
        img = resized
        owned = True
        w, h = nw, nh

    target_w = max(32, w, int(math.ceil(h / 160.0)))
    target_h = max(32, h, int(math.ceil(w / 160.0)))
    if target_w != w or target_h != h:
        canvas = Image.new("RGB", (target_w, target_h), (255, 255, 255))
        ox = (target_w - w) // 2
        oy = (target_h - h) // 2
        canvas.paste(img, (ox, oy))
        if owned:
            img.close()
        img = canvas
        owned = True

    return img, owned


def _clean_repeated_substrings(text: str) -> str:
    """Trim runaway tail-repetition loops occasionally emitted by greedy VLM decoding."""
    n = len(text)
    if n < 600:
        return text
    for pat_len in range(2, min(160, n // 10) + 1):
        candidate = text[-pat_len:]
        if not candidate.strip():
            continue
        repeats = 0
        pos = n
        while pos >= pat_len and text[pos - pat_len:pos] == candidate:
            repeats += 1
            pos -= pat_len
        if repeats >= 10:
            return text[: pos + pat_len].rstrip()
    return text


class _TransformersRegionAdapter(_BaseAdapter):
    preferred_attn: str | None = None
    system_prompt: str | None = None
    repetition_penalty: float | None = 1.05
    max_crop_long_side: int | None = None

    def __init__(self, models_root: Path, hf_repo: str, prompt: str) -> None:
        super().__init__(models_root)
        self.hf_repo = hf_repo
        self.prompt = prompt
        self._model: Any = None
        self._processor: Any = None
        self._device: str = "cpu"
        self._last_grid_size: tuple[int, int] | None = None

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

    def _load_sanitized_config(self, transformers_mod: Any, model_id: str, attn_impl: str | None) -> Any:
        auto_cfg = getattr(transformers_mod, "AutoConfig", None)
        if auto_cfg is None:
            return None
        try:
            cfg = auto_cfg.from_pretrained(model_id, trust_remote_code=True)
            return _sanitize_config_attn(cfg, attn_impl)
        except Exception:
            return None

    @staticmethod
    def _instantiate_from_pretrained(loader: Any, model_id: str, dtype: Any, extra_kw: dict[str, Any]) -> Any:
        for dtype_key in ("dtype", "torch_dtype"):
            kw_low = {**extra_kw, dtype_key: dtype, "low_cpu_mem_usage": True}
            try:
                return loader.from_pretrained(model_id, **kw_low)
            except TypeError:
                kw_plain = {**extra_kw, dtype_key: dtype}
                try:
                    return loader.from_pretrained(model_id, **kw_plain)
                except TypeError:
                    continue
        return loader.from_pretrained(model_id, **extra_kw)

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
                cfg = self._load_sanitized_config(transformers, model_id, attn_impl)
                if cfg is not None:
                    extra_kw["config"] = cfg
                try:
                    model = self._instantiate_from_pretrained(loader, model_id, dtype, extra_kw)
                    break
                except Exception as exc:
                    last_err = exc
                    if "config" in extra_kw:
                        extra_no_cfg = {k: v for k, v in extra_kw.items() if k != "config"}
                        try:
                            model = self._instantiate_from_pretrained(loader, model_id, dtype, extra_no_cfg)
                            break
                        except Exception as exc2:
                            last_err = exc2
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

    def _prepare_model_inputs(self, inputs: Any, model: Any, device: str) -> dict[str, Any]:
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
        return prepared_inputs

    def _infer_raw(self, crop_img: Any, *, max_tokens: int | None = None, prompt_override: str | None = None) -> str:
        import torch

        model, processor, device = self._load()
        active_prompt = self.prompt if prompt_override is None else prompt_override
        norm_img, owned_norm = _normalize_crop_for_vlm(crop_img, max_long_side=self.max_crop_long_side)
        try:
            cw, ch = getattr(norm_img, "size", (400, 200))
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
                            {"type": "image", "image": norm_img},
                            {"type": "text", "text": active_prompt},
                        ],
                    }
                )
                try:
                    text_input = processor.apply_chat_template(
                        messages, tokenize=False, add_generation_prompt=True
                    )
                    inputs = processor(text=[text_input], images=[norm_img], return_tensors="pt")
                except (ValueError, TypeError, AttributeError):
                    inputs = None

            if inputs is None:
                try:
                    inputs = processor(images=norm_img, return_tensors="pt")
                except TypeError:
                    inputs = processor(text=[f"<image>\n{active_prompt}"], images=[norm_img], return_tensors="pt")

            self._last_grid_size = None
            grid_thw = inputs.get("image_grid_thw") if hasattr(inputs, "get") else None
            if grid_thw is not None:
                with contextlib.suppress(Exception):
                    first_grid = grid_thw[0]
                    gh = int(first_grid[1]) * 14
                    gw = int(first_grid[2]) * 14
                    if gw > 0 and gh > 0:
                        self._last_grid_size = (gw, gh)

            prepared_inputs = self._prepare_model_inputs(inputs, model, device)
            gen_kwargs: dict[str, Any] = {"max_new_tokens": max_tokens, "do_sample": False}
            if self.repetition_penalty is not None:
                gen_kwargs["repetition_penalty"] = self.repetition_penalty

            grad_ctx = torch.inference_mode if hasattr(torch, "inference_mode") else torch.no_grad
            try:
                with grad_ctx():
                    generated = model.generate(**prepared_inputs, **gen_kwargs)
            except Exception:
                if device != "cpu":
                    _release_worker_caches()
                    device = "cpu"
                    model = model.to(dtype=torch.float32, device="cpu").eval()
                    self._model = model
                    self._device = "cpu"
                    prepared_inputs = self._prepare_model_inputs(inputs, model, "cpu")
                    with grad_ctx():
                        generated = model.generate(**prepared_inputs, **gen_kwargs)
                else:
                    raise

            prompt_len = prepared_inputs["input_ids"].shape[-1] if "input_ids" in prepared_inputs else 0
            new_tokens = generated[:, prompt_len:] if prompt_len and generated.shape[-1] > prompt_len else generated
            decoded = processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
            del inputs, prepared_inputs, generated, new_tokens
            decoded = re.sub(r"<｜hy_[^｜]*｜>", "", decoded)
            return _clean_repeated_substrings(decoded)
        finally:
            if owned_norm:
                norm_img.close()

    def _infer_crop(self, crop_img: Any, *, max_tokens: int | None = None) -> str:
        return _strip_markup(self._infer_raw(crop_img, max_tokens=max_tokens))

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


class _GlmOcrAdapter(_TransformersRegionAdapter):
    repetition_penalty = 1.1

    def __init__(self, models_root: Path) -> None:
        # Official Zhipu GLM-OCR recognition prompt from zai-org/GLM-OCR config.yaml
        super().__init__(models_root, "zai-org/GLM-OCR", "Text Recognition:")

    def _candidate_loaders(self, transformers_mod: Any) -> list[Any]:
        loaders: list[Any] = []
        glm_cls = getattr(transformers_mod, "GlmOcrForConditionalGeneration", None)
        if glm_cls is not None:
            loaders.append(glm_cls)
        loaders.extend(super()._candidate_loaders(transformers_mod))
        return loaders


class _OlmOcrAdapter(_TransformersRegionAdapter):
    repetition_penalty = 1.08
    max_crop_long_side = 1288
    OLMOCR_PROMPT = (
        "Attached is one page or region of a document. "
        "Return the plain text representation of its readable text naturally, reading left to right and top to bottom. "
        "Do not hallucinate."
    )

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root, "allenai/olmOCR-2-7B-1025", self.OLMOCR_PROMPT)

    def _candidate_loaders(self, transformers_mod: Any) -> list[Any]:
        loaders: list[Any] = []
        qwen_cls = getattr(transformers_mod, "Qwen2_5_VLForConditionalGeneration", None)
        if qwen_cls is not None:
            loaders.append(qwen_cls)
        loaders.extend(super()._candidate_loaders(transformers_mod))
        return loaders

    @staticmethod
    def _clean_olmocr_output(raw: str) -> str:
        text = str(raw or "").strip()
        if not text:
            return ""
        # Strip optional ```markdown / ```json fences
        text = re.sub(r"^\s*```(?:yaml|json|markdown|md)?\s*\n?", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\n?\s*```\s*$", "", text)
        # Parse JSON {"natural_text": ...} format emitted by olmOCR v1/v2 variants
        if text.startswith("{") and "natural_text" in text:
            with contextlib.suppress(Exception):
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    nt = parsed.get("natural_text")
                    text = "" if nt is None else str(nt).strip()
        # Strip YAML front matter (--- primary_language: ... ---) emitted by olmOCR-2-7B-1025
        yaml_match = re.match(
            r"^\s*---\s*\n(?:[A-Za-z0-9_]+\s*:[^\n]*\n)+\s*---\s*\n?",
            text,
        )
        if yaml_match:
            text = text[yaml_match.end():].strip()
        # Remove olmOCR figure crop placeholders ![Alt](page_x_y_w_h.png)
        text = re.sub(r"!\[[^\]]*\]\([^\)]*\)", "", text)
        cleaned = _strip_markup(text)
        if cleaned.strip().lower() in {"null", "none"}:
            return ""
        return cleaned

    def _infer_crop(self, crop_img: Any, *, max_tokens: int | None = None) -> str:
        raw = self._infer_raw(crop_img, max_tokens=max_tokens)
        return self._clean_olmocr_output(raw)


class _DotsOcrAdapter(_TransformersRegionAdapter):
    LAYOUT_PROMPT = (
        "Please output the layout information from the PDF image, including each layout element's bbox, "
        "its category, and the corresponding text content within the bbox.\n"
        "1. Bbox format: [x1, y1, x2, y2]\n"
        "2. Layout Categories: ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', "
        "'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'].\n"
        "3. Do not omit or hallucinate text; output a valid JSON list of objects with 'bbox', 'category', and 'text'."
    )
    REGION_FALLBACK_PROMPT = "Extract all text from this image."
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
            raw = self._infer_raw(rgb, max_tokens=4096, prompt_override=self.LAYOUT_PROMPT)
            grid_size = self._last_grid_size
        finally:
            rgb.close()
        items = self._extract_json_array(raw)
        if items is not None:
            try:
                # dots.ocr predicts bboxes in the processor's resized (grid_w*14, grid_h*14) pixel space
                ref_w, ref_h = grid_size if (grid_size and grid_size[0] > 0 and grid_size[1] > 0) else (width, height)
                sx = float(width) / float(ref_w)
                sy = float(height) / float(ref_h)
                lines: list[dict[str, Any]] = []
                for entry in items:
                    if not isinstance(entry, dict):
                        continue
                    bbox = entry.get("bbox")
                    raw_content = entry.get("text") or entry.get("content") or ""
                    label = str(entry.get("category") or entry.get("type") or entry.get("label") or "")
                    if label.strip().lower() in {"picture", "image", "figure"}:
                        continue
                    text = _strip_markup(raw_content)
                    hints = _extract_markup_hints(raw_content, label)
                    if not text or not bbox or len(bbox) < 4:
                        continue
                    bx0, by0, bx1, by1 = [float(v) for v in bbox[:4]]
                    poly = _clamp_polygon(_rect_polygon(bx0 * sx, by0 * sy, bx1 * sx, by1 * sy), width, height)
                    lines.append({"text": text, "confidence": 0.9, "polygon": poly, **hints})
                if lines:
                    return lines
            except Exception:
                pass
        prev_prompt = self.prompt
        self.prompt = self.REGION_FALLBACK_PROMPT
        try:
            return super().recognize(image_path, language, regions)
        finally:
            self.prompt = prev_prompt


class _DeepSeekOcr2Adapter(_TransformersRegionAdapter):
    preferred_attn = "eager"
    GROUNDING_RE = re.compile(
        r"<\|ref\|>(.*?)<\|/ref\|>\s*<\|det\|>\s*\[\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]\]\s*<\|/det\|>",
        re.DOTALL,
    )

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root, "deepseek-ai/DeepSeek-OCR-2", "Free OCR.")

    def _load(self) -> tuple[Any, Any, str]:
        import transformers
        _install_transformers_v4_compat_shims(transformers)
        return super()._load()

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        import tempfile
        from PIL import Image

        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = im.size
        try:
            model, processor, device = self._load()
            # ``deepseek-ai/DeepSeek-OCR-2`` remote ``model.infer(...)`` hardcodes ``.cuda()`` internally;
            # run it on CUDA and fall back cleanly to region crops or processor path otherwise.
            if hasattr(model, "infer") and device == "cuda":
                try:
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
                            raw_ref = match.group(1)
                            if raw_ref.strip().lower() in {"image", "figure", "picture"}:
                                continue
                            text = _strip_markup(raw_ref)
                            if not text:
                                continue
                            nx0, ny0, nx1, ny1 = [float(match.group(i)) for i in range(2, 6)]
                            scale_x = width / 1000.0 if max(nx0, nx1) <= 1000.0 else 1.0
                            scale_y = height / 1000.0 if max(ny0, ny1) <= 1000.0 else 1.0
                            poly = _clamp_polygon(_rect_polygon(nx0 * scale_x, ny0 * scale_y, nx1 * scale_x, ny1 * scale_y), width, height)
                            grounded.append({"text": text, "confidence": 0.9, "polygon": poly})
                        if grounded:
                            return grounded

                        # Region-level fallback via ``model.infer(..., prompt="<image>\nFree OCR. ")``
                        # because ``deepseek-ai/DeepSeek-OCR-2`` ships an AutoTokenizer rather than an AutoProcessor.
                        boxes = _default_regions(width, height, regions)
                        region_lines: list[dict[str, Any]] = []
                        for idx, (x0, y0, x1, y1) in enumerate(boxes):
                            crop = rgb.crop((int(x0), int(y0), int(x1), int(y1)))
                            norm_crop, owned_norm = _normalize_crop_for_vlm(crop)
                            crop_file = Path(tmp) / f"crop_{idx}.png"
                            try:
                                norm_crop.save(crop_file, format="PNG")
                                crop_res = model.infer(
                                    processor,
                                    prompt="<image>\nFree OCR. ",
                                    image_file=str(crop_file),
                                    output_path=tmp,
                                    base_size=640,
                                    image_size=640,
                                    crop_mode=False,
                                    save_results=False,
                                )
                                txt = _strip_markup(str(crop_res or ""))
                                if txt:
                                    poly = _clamp_polygon(_rect_polygon(x0, y0, x1, y1), width, height)
                                    region_lines.append({"text": txt, "confidence": 0.89, "polygon": poly})
                            finally:
                                if owned_norm:
                                    norm_crop.close()
                                crop.close()
                                with contextlib.suppress(OSError):
                                    crop_file.unlink()
                        if region_lines:
                            return region_lines
                except Exception:
                    pass
        finally:
            rgb.close()
        return super().recognize(image_path, language, regions)


class _HunyuanOcrAdapter(_TransformersRegionAdapter):
    hf_ignore_patterns = ("v1.0/*", "dflash/*")
    preferred_attn = "eager"
    system_prompt = ""
    repetition_penalty = 1.08

    # Official fixed prompts from Tencent-Hunyuan/HunyuanOCR/inference/tasks.py
    SPOTTING_JSON_PROMPT = (
        "Detect and recognize the text in the image, and output the text coordinates in a formatted manner. "
        'Output format: [{"box": [xmin, ymin, xmax, ymax], "text": "..."}]. '
        "Coordinates are integers normalized to [0, 1000]."
    )
    REGION_OCR_PROMPT = "提取图中的文字。"
    SPOTTING_TAG_RE = re.compile(
        r"<ref>(.*?)</ref>\s*<box>\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*,\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)\s*</box>",
        re.DOTALL,
    )

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root, "tencent/HunyuanOCR", self.REGION_OCR_PROMPT)

    def _candidate_loaders(self, transformers_mod: Any) -> list[Any]:
        loaders: list[Any] = []
        hy_cls = getattr(transformers_mod, "HunYuanVLForConditionalGeneration", None)
        if hy_cls is not None:
            loaders.append(hy_cls)
        loaders.extend(super()._candidate_loaders(transformers_mod))
        return loaders

    @staticmethod
    def _patch_hunyuan_tokenizer(tokenizer: Any) -> None:
        token_map = {
            "image_token": "<｜hy_place▁holder▁no▁102｜>",
            "boi_token": "<｜hy_place▁holder▁no▁100｜>",
            "eoi_token": "<｜hy_place▁holder▁no▁101｜>",
            "video_token": "<｜hy_place▁holder▁no▁105｜>",
            "bov_token": "<｜hy_place▁holder▁no▁103｜>",
            "eov_token": "<｜hy_place▁holder▁no▁104｜>",
        }
        unk_id = getattr(tokenizer, "unk_token_id", None)
        for attr, tok in token_map.items():
            cur = getattr(tokenizer, attr, None)
            if cur is None:
                with contextlib.suppress(Exception):
                    setattr(tokenizer, attr, tok)
            id_attr = f"{attr}_id"
            cur_id = getattr(tokenizer, id_attr, None)
            if cur_id is None and hasattr(tokenizer, "convert_tokens_to_ids"):
                with contextlib.suppress(Exception):
                    tid = tokenizer.convert_tokens_to_ids(getattr(tokenizer, attr, tok))
                    if tid is not None and tid != unk_id:
                        setattr(tokenizer, id_attr, tid)

    def _load_processor(self, transformers_mod: Any, model_id: str) -> Any:
        auto_proc = getattr(transformers_mod, "AutoProcessor")
        try:
            proc = auto_proc.from_pretrained(model_id, trust_remote_code=True, use_fast=False)
        except Exception:
            try:
                auto_tok = getattr(transformers_mod, "AutoTokenizer")
                auto_img = getattr(transformers_mod, "AutoImageProcessor")
                tok = auto_tok.from_pretrained(model_id, trust_remote_code=True, use_fast=False)
                self._patch_hunyuan_tokenizer(tok)
                img_proc = auto_img.from_pretrained(model_id, trust_remote_code=True)
                hy_proc_cls = getattr(transformers_mod, "HunYuanVLProcessor", None)
                if hy_proc_cls is not None:
                    proc = hy_proc_cls(image_processor=img_proc, tokenizer=tok)
                else:
                    proc = super()._load_processor(transformers_mod, model_id)
            except Exception:
                proc = super()._load_processor(transformers_mod, model_id)
        if getattr(proc, "video_token", None) is None:
            with contextlib.suppress(Exception):
                proc.video_token = "<｜hy_place▁holder▁no▁105｜>"
        if hasattr(proc, "tokenizer"):
            self._patch_hunyuan_tokenizer(proc.tokenizer)
        return proc

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image

        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = im.size
        try:
            raw = self._infer_raw(rgb, max_tokens=4096, prompt_override=self.SPOTTING_JSON_PROMPT)
        except Exception:
            raw = ""
        finally:
            rgb.close()

        if raw:
            items = _DotsOcrAdapter._extract_json_array(raw)
            if items:
                spotted: list[dict[str, Any]] = []
                for entry in items:
                    if not isinstance(entry, dict):
                        continue
                    box = entry.get("box") or entry.get("bbox")
                    txt = _strip_markup(str(entry.get("text") or entry.get("content") or ""))
                    if not txt or not isinstance(box, (list, tuple)) or len(box) < 4:
                        continue
                    bx0, by0, bx1, by1 = [float(v) for v in box[:4]]
                    sx = width / 1000.0 if max(bx0, bx1) <= 1000.0 else 1.0
                    sy = height / 1000.0 if max(by0, by1) <= 1000.0 else 1.0
                    poly = _clamp_polygon(_rect_polygon(bx0 * sx, by0 * sy, bx1 * sx, by1 * sy), width, height)
                    spotted.append({"text": txt, "confidence": 0.9, "polygon": poly})
                if spotted:
                    return spotted

            tag_lines: list[dict[str, Any]] = []
            for m in self.SPOTTING_TAG_RE.finditer(raw):
                txt = _strip_markup(m.group(1))
                if not txt:
                    continue
                bx0, by0, bx1, by1 = [float(m.group(i)) for i in range(2, 6)]
                sx = width / 1000.0 if max(bx0, bx1) <= 1000.0 else 1.0
                sy = height / 1000.0 if max(by0, by1) <= 1000.0 else 1.0
                poly = _clamp_polygon(_rect_polygon(bx0 * sx, by0 * sy, bx1 * sx, by1 * sy), width, height)
                tag_lines.append({"text": txt, "confidence": 0.9, "polygon": poly})
            if tag_lines:
                return tag_lines

        return super().recognize(image_path, language, regions)


class _HezarOcrAdapter(_BaseAdapter):
    CRAFT_REPO = "hezarai/CRAFT"
    CRNN_REPO = "hezarai/crnn-base-fa-v2"

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self.hf_repo = self.CRNN_REPO
        self._detector: Any = None
        self._recognizer: Any = None
        self._device: str = "cpu"

    def _local_or_hub(self, repo_id: str) -> str:
        safe_dir = self.models_root / "hf-repos" / self._safe_repo_folder_name(repo_id)
        if safe_dir.is_dir() and (safe_dir / "model_config.yaml").is_file():
            return str(safe_dir)
        return repo_id

    def prepare(self, language: str) -> str:
        _widen_requests_default_timeout(120.0)
        print(f"Downloading Hezar CRAFT detector {self.CRAFT_REPO} (20%)...", file=sys.stderr, flush=True)
        craft_dir, _ = self._download_hf_repo_resilient(self.CRAFT_REPO)
        if not (Path(craft_dir) / "model_config.yaml").is_file():
            raise RuntimeError(f"Incomplete Hezar CRAFT download in {craft_dir}: model_config.yaml missing")
        print(f"Downloading Hezar Persian CRNN {self.CRNN_REPO} (60%)...", file=sys.stderr, flush=True)
        crnn_dir, rev = self._download_hf_repo_resilient(self.CRNN_REPO)
        if not (Path(crnn_dir) / "model_config.yaml").is_file():
            raise RuntimeError(f"Incomplete Hezar CRNN download in {crnn_dir}: model_config.yaml missing")
        print("Hezar Persian OCR models ready (100%).", file=sys.stderr, flush=True)
        return rev

    def _ensure_loaded(self, force_cpu: bool = False) -> tuple[Any, Any]:
        if force_cpu and self._device != "cpu":
            self._detector = None
            self._recognizer = None
        if self._detector is not None and self._recognizer is not None:
            return self._detector, self._recognizer
        import torch
        from hezar.models import Model

        dev = "cpu" if force_cpu else _configure_torch_runtime(torch)
        craft_src = self._local_or_hub(self.CRAFT_REPO)
        crnn_src = self._local_or_hub(self.CRNN_REPO)
        try:
            detector = Model.load(craft_src, device=dev)
            recognizer = Model.load(crnn_src, device=dev)
        except Exception:
            if dev != "cpu":
                dev = "cpu"
                detector = Model.load(craft_src, device="cpu")
                recognizer = Model.load(crnn_src, device="cpu")
            else:
                raise
        self._detector, self._recognizer, self._device = detector, recognizer, dev
        return detector, recognizer

    def close(self) -> None:
        self._detector = None
        self._recognizer = None

    @staticmethod
    def _extract_text(pred_item: Any) -> str:
        if isinstance(pred_item, dict):
            return str(pred_item.get("text") or "").strip()
        if hasattr(pred_item, "text"):
            return str(getattr(pred_item, "text") or "").strip()
        if isinstance(pred_item, (list, tuple)) and pred_item:
            first = pred_item[0]
            if isinstance(first, dict):
                return str(first.get("text") or "").strip()
            if hasattr(first, "text"):
                return str(getattr(first, "text") or "").strip()
        return ""

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image

        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        try:
            detector, recognizer = self._ensure_loaded()
            try:
                det_outputs = detector.predict(rgb)
            except Exception:
                if self._device != "cpu":
                    detector, recognizer = self._ensure_loaded(force_cpu=True)
                    det_outputs = detector.predict(rgb)
                else:
                    raise

            first_det = det_outputs[0] if isinstance(det_outputs, (list, tuple)) and det_outputs else det_outputs
            raw_boxes = (
                first_det.get("boxes", [])
                if isinstance(first_det, dict)
                else getattr(first_det, "boxes", [])
            ) or []

            crop_entries: list[tuple[Any, list[list[float]]]] = []
            for raw_box in raw_boxes:
                if not isinstance(raw_box, (list, tuple)) or len(raw_box) < 4:
                    continue
                # Hezar CRAFT boxes are (x1, y1, width, height); add generous vertical margin
                # so Persian upper/lower diacritical dots (پ چ ژ ی ت ث ب ن) are never clipped.
                bx, by, bw, bh = [float(v) for v in raw_box[:4]]
                if bw < 4.0 or bh < 4.0:
                    continue
                pad_x = max(3, int(round(bh * 0.10)))
                pad_y = max(4, int(round(bh * 0.18)))
                cx0 = max(0, int(round(bx - pad_x)))
                cy0 = max(0, int(round(by - pad_y)))
                cx1 = min(width, int(round(bx + bw + pad_x)))
                cy1 = min(height, int(round(by + bh + pad_y)))
                if cx1 - cx0 < 4 or cy1 - cy0 < 4:
                    continue
                poly = _clamp_polygon(_rect_polygon(bx, by, bx + bw, by + bh), width, height)
                crop_entries.append((rgb.crop((cx0, cy0, cx1, cy1)), poly))

            if not crop_entries and regions:
                for rx0, ry0, rx1, ry1 in _default_regions(width, height, regions):
                    if rx1 - rx0 >= 4 and ry1 - ry0 >= 4:
                        poly = _clamp_polygon(_rect_polygon(rx0, ry0, rx1, ry1), width, height)
                        crop_entries.append((rgb.crop((int(rx0), int(ry0), int(rx1), int(ry1))), poly))

            lines: list[dict[str, Any]] = []
            try:
                batch_size = 16
                for start in range(0, len(crop_entries), batch_size):
                    batch = crop_entries[start:start + batch_size]
                    batch_imgs = [item[0] for item in batch]
                    try:
                        preds = recognizer.predict(batch_imgs)
                    except Exception:
                        try:
                            preds = [recognizer.predict(img) for img in batch_imgs]
                        except Exception:
                            if self._device != "cpu":
                                _, recognizer = self._ensure_loaded(force_cpu=True)
                                preds = [recognizer.predict(img) for img in batch_imgs]
                            else:
                                raise
                    if not isinstance(preds, (list, tuple)):
                        preds = [preds]
                    for (_, poly), pred in zip(batch, preds):
                        txt = _strip_markup(self._extract_text(pred))
                        if txt:
                            lines.append({"text": txt, "confidence": 0.9, "polygon": poly})
            finally:
                for crop_img, _ in crop_entries:
                    crop_img.close()
            return lines
        finally:
            rgb.close()


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
        return _GlmOcrAdapter(models_root)
    if engine_id == "olmocr":
        return _OlmOcrAdapter(models_root)
    if engine_id == "hunyuan-ocr":
        return _HunyuanOcrAdapter(models_root)
    if engine_id == "hezar-ocr":
        return _HezarOcrAdapter(models_root)
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
