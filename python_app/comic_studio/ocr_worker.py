from __future__ import annotations

import argparse
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
    for directory in (hf_dir, paddlex_dir, torch_dir):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(hf_dir))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_dir / "hub"))
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(paddlex_dir))
    os.environ.setdefault("TORCH_HOME", str(torch_dir))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _strip_markup(raw: str) -> str:
    text = str(raw or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(?:p|div|li|tr|h[1-6])>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"^\s*#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    lines = [" ".join(part.split()) for part in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


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

    def __init__(self, models_root: Path) -> None:
        self.models_root = models_root

    def prepare(self, language: str) -> str:
        if self.hf_repo:
            from huggingface_hub import snapshot_download
            local_dir = self.models_root / "hf-repos" / self.hf_repo.replace("/", "__")
            local_dir.mkdir(parents=True, exist_ok=True)
            path = snapshot_download(repo_id=self.hf_repo, local_dir=str(local_dir))
            return str(Path(path).name)
        return "ready"

    def local_repo_or_id(self) -> str:
        assert self.hf_repo
        local_dir = self.models_root / "hf-repos" / self.hf_repo.replace("/", "__")
        if local_dir.is_dir() and any(local_dir.iterdir()):
            return str(local_dir)
        return self.hf_repo

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        raise NotImplementedError


class _PaddleOcrVlAdapter(_BaseAdapter):
    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self._pipeline: Any = None

    def _get_pipeline(self) -> Any:
        if self._pipeline is None:
            from paddleocr import PaddleOCRVL
            self._pipeline = PaddleOCRVL(pipeline_version="v1.6")
        return self._pipeline

    def prepare(self, language: str) -> str:
        self._get_pipeline()
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
                    content = _strip_markup(block.get("block_content") or block.get("content") or block.get("text") or "")
                    bbox = block.get("block_bbox") or block.get("bbox") or block.get("coordinate")
                    score = float(block.get("score", 0.9) or 0.9)
                else:
                    label = str(getattr(block, "label", "text")).lower()
                    content = _strip_markup(getattr(block, "content", ""))
                    bbox = getattr(block, "bbox", None)
                    score = float(getattr(block, "score", 0.9) or 0.9)
                if label in {"image", "figure", "header_image", "footer_image"} or not content or not bbox or len(bbox) < 4:
                    continue
                poly = _clamp_polygon(_rect_polygon(bbox[0], bbox[1], bbox[2], bbox[3]), width, height)
                lines.append({"text": content, "confidence": max(0.0, min(1.0, score)), "polygon": poly})
        return lines


class _SuryaAdapter(_BaseAdapter):
    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root)
        self._predictor: Any = None
        self._legacy: tuple[Any, Any] | None = None

    def _ensure_loaded(self) -> None:
        if self._predictor is not None or self._legacy is not None:
            return
        try:
            from surya.inference import SuryaInferenceManager
            from surya.recognition import RecognitionPredictor
            manager = SuryaInferenceManager()
            self._predictor = RecognitionPredictor(manager)
        except ImportError:
            from surya.detection import DetectionPredictor
            from surya.recognition import RecognitionPredictor
            self._legacy = (RecognitionPredictor(), DetectionPredictor())

    def prepare(self, language: str) -> str:
        from PIL import Image
        self._ensure_loaded()
        sample = Image.new("RGB", (160, 64), "white")
        if self._predictor is not None:
            self._predictor([sample])
        elif self._legacy is not None:
            rec, det = self._legacy
            rec([sample], det_predictor=det)
        import importlib.metadata
        return importlib.metadata.version("surya-ocr")

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        self._ensure_loaded()
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        lines: list[dict[str, Any]] = []
        if self._predictor is not None:
            preds = self._predictor([rgb])
            page = preds[0] if preds else None
            for block in getattr(page, "blocks", []) or []:
                if getattr(block, "skipped", False) or getattr(block, "error", False):
                    continue
                text = _strip_markup(getattr(block, "html", "") or getattr(block, "text", ""))
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
                lines.append({"text": text, "confidence": max(0.0, min(1.0, conf)), "polygon": _clamp_polygon(poly, width, height)})
        elif self._legacy is not None:
            rec, det = self._legacy
            preds = rec([rgb], det_predictor=det)
            page = preds[0] if preds else None
            for line in getattr(page, "text_lines", []) or []:
                text = _strip_markup(getattr(line, "text", ""))
                if not text:
                    continue
                raw_poly = getattr(line, "polygon", None)
                bbox = getattr(line, "bbox", None)
                poly = [[float(pt[0]), float(pt[1])] for pt in raw_poly[:4]] if raw_poly and len(raw_poly) >= 4 else _rect_polygon(*bbox[:4])
                conf = float(getattr(line, "confidence", 0.9) or 0.9)
                lines.append({"text": text, "confidence": max(0.0, min(1.0, conf)), "polygon": _clamp_polygon(poly, width, height)})
        return lines


class _MinerUAdapter(_BaseAdapter):
    def prepare(self, language: str) -> str:
        import importlib.metadata
        return importlib.metadata.version("mineru")

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        import subprocess
        import tempfile
        from PIL import Image

        with Image.open(image_path) as im:
            width, height = im.size
        with tempfile.TemporaryDirectory(prefix="comic-mineru-") as tmp:
            out_dir = Path(tmp) / "out"
            out_dir.mkdir(parents=True, exist_ok=True)
            lang_map = {"eng": "en", "kor": "korean", "jpn": "japan", "chi_sim": "ch"}
            cmd = [sys.executable, "-m", "mineru.cli.client", "-p", image_path, "-o", str(out_dir), "-l", lang_map.get(language, "en")]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
            if proc.returncode != 0:
                alt = shutil_which_in_venv("mineru")
                if alt:
                    proc = subprocess.run([alt, "-p", image_path, "-o", str(out_dir)], capture_output=True, text=True, timeout=600, check=False)
                if proc.returncode != 0:
                    raise RuntimeError((proc.stderr or proc.stdout or "MinerU execution failed")[-1200:])
            lines: list[dict[str, Any]] = []
            for json_file in out_dir.rglob("*content_list*.json"):
                payload = json.loads(json_file.read_text(encoding="utf-8"))
                items = payload if isinstance(payload, list) else payload.get("pdf_info", [])
                for entry in items:
                    if not isinstance(entry, dict):
                        continue
                    text = _strip_markup(entry.get("text") or entry.get("content") or "")
                    bbox = entry.get("bbox")
                    if not text or not bbox or len(bbox) < 4:
                        continue
                    bx0, by0, bx1, by1 = [float(v) for v in bbox[:4]]
                    if max(bx1, by1) <= 1000.0 and (width > 1000 or height > 1000):
                        bx0, bx1 = bx0 * width / 1000.0, bx1 * width / 1000.0
                        by0, by1 = by0 * height / 1000.0, by1 * height / 1000.0
                    poly = _clamp_polygon(_rect_polygon(bx0, by0, bx1, by1), width, height)
                    lines.append({"text": text, "confidence": 0.9, "polygon": poly})
                if lines:
                    break
            return lines


def shutil_which_in_venv(binary_name: str) -> str | None:
    import shutil
    scripts_dir = Path(sys.executable).parent
    for suffix in ("", ".exe", ".cmd"):
        candidate = scripts_dir / f"{binary_name}{suffix}"
        if candidate.is_file():
            return str(candidate)
    return shutil.which(binary_name)


class _TransformersRegionAdapter(_BaseAdapter):
    def __init__(self, models_root: Path, hf_repo: str, prompt: str) -> None:
        super().__init__(models_root)
        self.hf_repo = hf_repo
        self.prompt = prompt
        self._model: Any = None
        self._processor: Any = None
        self._device: str = "cpu"

    def _load(self) -> tuple[Any, Any, str]:
        if self._model is not None and self._processor is not None:
            return self._model, self._processor, self._device
        import torch
        from transformers import AutoModel, AutoModelForCausalLM, AutoModelForImageTextToText, AutoProcessor

        model_id = self.local_repo_or_id()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if device == "cuda" else torch.float32
        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        model = None
        last_err: Exception | None = None
        for loader in (AutoModelForImageTextToText, AutoModelForCausalLM, AutoModel):
            try:
                model = loader.from_pretrained(model_id, torch_dtype=dtype, trust_remote_code=True)
                break
            except Exception as exc:
                last_err = exc
        if model is None:
            raise RuntimeError(f"Could not load model {self.hf_repo}: {last_err}")
        model = model.to(device).eval()
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
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": crop_img},
                    {"type": "text", "text": self.prompt},
                ],
            }
        ]
        if hasattr(processor, "apply_chat_template"):
            text_input = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = processor(text=[text_input], images=[crop_img], return_tensors="pt")
        else:
            inputs = processor(images=crop_img, return_tensors="pt")
        inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}
        with torch.no_grad():
            generated = model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
        prompt_len = inputs["input_ids"].shape[-1] if "input_ids" in inputs else 0
        new_tokens = generated[:, prompt_len:] if prompt_len and generated.shape[-1] > prompt_len else generated
        decoded = processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
        return _strip_markup(decoded)

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        boxes = _default_regions(width, height, regions)
        lines: list[dict[str, Any]] = []
        for x0, y0, x1, y1 in boxes:
            crop = rgb.crop((int(x0), int(y0), int(x1), int(y1)))
            text = self._infer_crop(crop)
            if text:
                poly = _clamp_polygon(_rect_polygon(x0, y0, x1, y1), width, height)
                lines.append({"text": text, "confidence": 0.88, "polygon": poly})
        return lines


class _DotsOcrAdapter(_TransformersRegionAdapter):
    LAYOUT_PROMPT = (
        "Please output the layout information from the image as a JSON list of objects with "
        "'bbox' ([x1, y1, x2, y2]) and 'text' fields. Output JSON only."
    )

    def __init__(self, models_root: Path) -> None:
        super().__init__(models_root, "rednote-hilab/dots.mocr", self.LAYOUT_PROMPT)

    def recognize(self, image_path: str, language: str, regions: list[list[float]] | None) -> list[dict[str, Any]]:
        from PIL import Image
        with Image.open(image_path) as im:
            rgb = im.convert("RGB")
            width, height = rgb.size
        raw = self._infer_crop(rgb, max_tokens=2048)
        match = re.search(r"\[.*\]", raw, flags=re.DOTALL)
        if match:
            try:
                items = json.loads(match.group(0))
                lines: list[dict[str, Any]] = []
                for entry in items:
                    if not isinstance(entry, dict):
                        continue
                    bbox = entry.get("bbox")
                    text = _strip_markup(entry.get("text") or entry.get("content") or "")
                    if not text or not bbox or len(bbox) < 4:
                        continue
                    poly = _clamp_polygon(_rect_polygon(bbox[0], bbox[1], bbox[2], bbox[3]), width, height)
                    lines.append({"text": text, "confidence": 0.9, "polygon": poly})
                if lines:
                    return lines
            except Exception:
                pass
        return super().recognize(image_path, language, regions)


class _DeepSeekOcr2Adapter(_TransformersRegionAdapter):
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
        return _TransformersRegionAdapter(models_root, "tencent/HunyuanOCR", "Extract the exact text in this image.")
    raise ValueError(f"Unsupported isolated engine: {engine_id}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Comic OCR Studio isolated OCR worker")
    parser.add_argument("--engine", required=True)
    parser.add_argument("--models-root", required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--language", default="eng")
    args = parser.parse_args()

    models_root = Path(args.models_root).resolve()
    _configure_cache_dirs(models_root)
    adapter = _create_adapter(args.engine, models_root)

    if args.prepare:
        try:
            revision = adapter.prepare(args.language)
            sys.stdout.write(json.dumps({"ok": True, "modelRevision": revision}) + "\n")
            sys.stdout.flush()
            return 0
        except Exception as exc:
            sys.stdout.write(json.dumps({"ok": False, "error": f"{exc}\n{traceback.format_exc()[-1000:]}"}) + "\n")
            sys.stdout.flush()
            return 1

    if args.serve:
        sys.stdout.write(json.dumps({"ready": True, "engine": args.engine}) + "\n")
        sys.stdout.flush()
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                if req.get("cmd") == "ping":
                    resp = {"ok": True, "pong": True}
                elif req.get("cmd") == "quit":
                    sys.stdout.write(json.dumps({"ok": True, "bye": True}) + "\n")
                    sys.stdout.flush()
                    return 0
                else:
                    out_lines = adapter.recognize(
                        req["imagePath"],
                        req.get("language", "eng"),
                        req.get("regions"),
                    )
                    resp = {"ok": True, "lines": out_lines}
            except Exception as exc:
                resp = {"ok": False, "error": str(exc)}
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
