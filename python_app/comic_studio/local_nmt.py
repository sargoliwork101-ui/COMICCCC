"""Built-in 100% offline Neural Machine Translation (Meta NLLB-200 via CTranslate2 + SentencePiece).

All model weights and runtime packages live inside the active storage directory
(`models_dir() / "local-nmt"` and `custom_site_packages_dir()` when custom storage
is active), ensuring zero Drive-C leaks, full custom-path migration compatibility,
real byte-weighted download progress, and clean RAM release on Windows and Linux.
"""
from __future__ import annotations

import contextlib
import gc
import importlib
import importlib.util
import os
from pathlib import Path
import re
import shutil
import threading
from typing import Any, Callable

import httpx

from .ocr import OcrError, emit, ensure_custom_site_packages_on_path, install_packages, trim_process_memory
from .paths import bundled_models_dir, models_dir

DEFAULT_LOCAL_NMT_MODEL = "nllb-600m"
DEFAULT_LOCAL_BEAM_SIZE = 2
DEFAULT_LOCAL_SOURCE_LIMIT = 4000

HF_PRIMARY_ENDPOINT = "https://huggingface.co"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"

LOCAL_NMT_RUNTIME_PACKAGES = [
    "ctranslate2>=4.0.0",
    "sentencepiece>=0.2.0",
]

LOCAL_NMT_MODELS: dict[str, dict[str, Any]] = {
    "nllb-600m": {
        "id": "nllb-600m",
        "label": "NLLB-200 سبک و سریع (600M · ~630 MB)",
        "short_label": "NLLB-200 (600M)",
        "description": (
            "پیشنهادی برای همهٔ لپ‌تاپ‌ها و سیستم‌های معمولی روی پردازنده (CPU) بدون نیاز به کارت گرافیک؛ "
            "سریع، کم‌حجم و مناسب ترجمهٔ تک‌جمله و صفحه‌های کامل."
        ),
        "approx_size": "~630 MB",
        "approx_bytes": 655_000_000,
        "min_free_bytes": 950_000_000,
        "ram_hint": "~750 MB",
        "primary_repo": "entai2965/nllb-200-distilled-600M-ctranslate2",
        "fallback_repos": (
            "JustFrederik/nllb-200-distilled-600M-ct2-int8",
        ),
        "tokenizer_repo": "facebook/nllb-200-distilled-600M",
    },
    "nllb-1.3b": {
        "id": "nllb-1.3b",
        "label": "NLLB-200 دقیق‌تر (1.3B · ~1.35 GB)",
        "short_label": "NLLB-200 (1.3B)",
        "description": (
            "جمله‌بندی دقیق‌تر برای جملات طولانی‌تر؛ قابل اجرا روی پردازنده (CPU) "
            "با حدود ۱.۶ گیگابایت رم آزاد در زمان ترجمه."
        ),
        "approx_size": "~1.35 GB",
        "approx_bytes": 1_420_000_000,
        "min_free_bytes": 1_900_000_000,
        "ram_hint": "~1.6 GB",
        "primary_repo": "entai2965/nllb-200-distilled-1.3B-ctranslate2",
        "fallback_repos": (
            "JustFrederik/nllb-200-distilled-1.3B-ct2-int8",
            "OpenNMT/nllb-200-distilled-1.3B-ct2-int8",
        ),
        "tokenizer_repo": "facebook/nllb-200-distilled-600M",
    },
}

# Studio OCR source codes + ISO/BCP-47 codes -> FLORES-200 NLLB language tokens.
NLLB_LANGUAGE_MAP: dict[str, str] = {
    # Studio OCR codes
    "eng": "eng_Latn",
    "fas": "pes_Arab",
    "jpn": "jpn_Jpan",
    "kor": "kor_Hang",
    "chi_sim": "zho_Hans",
    "chi_tra": "zho_Hant",
    # Studio target codes & common aliases
    "fa": "pes_Arab",
    "per": "pes_Arab",
    "en": "eng_Latn",
    "ar": "arb_Arab",
    "ara": "arb_Arab",
    "tr": "tur_Latn",
    "tur": "tur_Latn",
    "de": "deu_Latn",
    "deu": "deu_Latn",
    "fr": "fra_Latn",
    "fra": "fra_Latn",
    "ru": "rus_Cyrl",
    "rus": "rus_Cyrl",
    "es": "spa_Latn",
    "spa": "spa_Latn",
    "ja": "jpn_Jpan",
    "ko": "kor_Hang",
    "zh": "zho_Hans",
    "zh-cn": "zho_Hans",
    "zh_cn": "zho_Hans",
    "zh-hans": "zho_Hans",
    "zh-tw": "zho_Hant",
    "zh-hant": "zho_Hant",
    "it": "ita_Latn",
    "pt": "por_Latn",
    "nl": "nld_Latn",
    "pl": "pol_Latn",
    "hi": "hin_Deva",
    "ur": "urd_Arab",
    "uk": "ukr_Cyrl",
}

_VALID_FLORES_RE = re.compile(r"^[a-z]{3}_[A-Z][a-z]{3}$")

_ABBREV_PLACEHOLDER = "\ufff0"
_ABBREV_RE = re.compile(
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Fig|Figs|Eq|Eqs|Ref|Refs|No|Nos|Vol|Ch|Sec|vs|etc|al|cf|p|pp)\."
    r"|\b(?:e\.g|i\.e)\."
    r"|(?<=\b[A-Z])\.(?=\s+[A-Z])",
)
_SENTENCE_END_MATCH_RE = re.compile(
    r"[.!?…。！？؟][\"'”’»）)\]]*\s+"
    r"|[。！？][\"'”’»）)\]]*(?=[^\s\"'”’»）)\]!?。！？])"
)
_BULLET_OR_HEADING_RE = re.compile(
    r"^\s*(?:[-•*▪◦]|\d+[.)]|[A-Za-z\u0600-\u06FF][.)])\s+|:\s*$"
)
_LATIN_LETTER_RE = re.compile(r"[A-Za-z]")
_ARABIC_SCRIPT_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]")
_CJK_HIRAGANA_KATAKANA_RE = re.compile(r"[\u3040-\u30FF]")
_HANGUL_RE = re.compile(r"[\uAC00-\uD7AF]")
_HAN_RE = re.compile(r"[\u4E00-\u9FFF]")
_CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")


class LocalNmtError(RuntimeError):
    """User-facing error raised by the built-in offline NMT engine."""


def normalize_local_nmt_model(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in LOCAL_NMT_MODELS else DEFAULT_LOCAL_NMT_MODEL


def normalize_local_nmt_settings(raw: Any) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    model = normalize_local_nmt_model(data.get("model"))
    try:
        beam_size = int(data.get("beam_size", DEFAULT_LOCAL_BEAM_SIZE))
    except (TypeError, ValueError):
        beam_size = DEFAULT_LOCAL_BEAM_SIZE
    beam_size = max(1, min(4, beam_size))
    try:
        source_limit = int(data.get("source_limit", DEFAULT_LOCAL_SOURCE_LIMIT))
    except (TypeError, ValueError):
        source_limit = DEFAULT_LOCAL_SOURCE_LIMIT
    source_limit = max(200, min(20_000, source_limit))
    keep_loaded = bool(data.get("keep_loaded", False))
    return {
        "model": model,
        "beam_size": beam_size,
        "source_limit": source_limit,
        "keep_loaded": keep_loaded,
    }


def detect_script_nllb_language(text: str) -> str | None:
    sample = str(text or "")
    if not sample.strip():
        return None
    hangul = len(_HANGUL_RE.findall(sample))
    kana = len(_CJK_HIRAGANA_KATAKANA_RE.findall(sample))
    han = len(_HAN_RE.findall(sample))
    arabic = len(_ARABIC_SCRIPT_RE.findall(sample))
    cyrillic = len(_CYRILLIC_RE.findall(sample))
    latin = len(_LATIN_LETTER_RE.findall(sample))
    best = max(
        (hangul, "kor_Hang"),
        (kana, "jpn_Jpan"),
        (han, "zho_Hans"),
        (arabic, "pes_Arab"),
        (cyrillic, "rus_Cyrl"),
        (latin, "eng_Latn"),
        key=lambda item: item[0],
    )
    return best[1] if best[0] > 0 else None


def resolve_nllb_language(code: str | None, *, default: str = "eng_Latn") -> str:
    clean = str(code or "").strip()
    if not clean:
        return default
    if _VALID_FLORES_RE.match(clean):
        return clean
    lowered = clean.lower().split("+")[0].strip()
    if lowered in NLLB_LANGUAGE_MAP:
        return NLLB_LANGUAGE_MAP[lowered]
    base = lowered.split("-")[0].split("_")[0]
    if base in NLLB_LANGUAGE_MAP:
        return NLLB_LANGUAGE_MAP[base]
    return default


def resolve_nllb_pair(source_language: str | None, target_language: str | None, sample_text: str = "") -> tuple[str, str]:
    src = resolve_nllb_language(source_language, default="eng_Latn")
    tgt = resolve_nllb_language(target_language, default="pes_Arab")
    if str(source_language or "").strip().lower() == "auto":
        detected = detect_script_nllb_language(sample_text)
        if detected:
            src = detected
    elif src == tgt and sample_text.strip():
        # Guard against a common UI mismatch where OCR language was left on the
        # target language while translating foreign-script text (e.g. English -> Persian).
        detected = detect_script_nllb_language(sample_text)
        if detected and detected != tgt:
            src = detected
    return src, tgt


def split_nllb_sentences(text: str, *, max_chunk_chars: int = 360) -> list[str]:
    """Split text into NLLB-safe single sentences without breaking abbreviations.

    NLLB-200 was trained on single sentences and can drop trailing sentences if
    a multi-sentence paragraph is fed as a single sequence.
    """
    compact = " ".join(str(text or "").split()).strip()
    if not compact:
        return []
    protected = _ABBREV_RE.sub(lambda m: m.group(0)[:-1] + _ABBREV_PLACEHOLDER, compact)
    raw_parts: list[str] = []
    start = 0
    for match in _SENTENCE_END_MATCH_RE.finditer(protected):
        end_pos = match.end()
        segment = protected[start:end_pos].replace(_ABBREV_PLACEHOLDER, ".").strip()
        if segment:
            raw_parts.append(segment)
        start = end_pos
    tail = protected[start:].replace(_ABBREV_PLACEHOLDER, ".").strip()
    if tail:
        raw_parts.append(tail)
    if not raw_parts:
        raw_parts = [compact]

    bounded: list[str] = []
    for sentence in raw_parts:
        if len(sentence) <= max_chunk_chars:
            bounded.append(sentence)
            continue
        remaining = sentence
        while len(remaining) > max_chunk_chars:
            cut = -1
            for sep in ("؛ ", "; ", "، ", ", ", " - ", " — ", " "):
                pos = remaining.rfind(sep, 0, max_chunk_chars)
                if pos >= int(max_chunk_chars * 0.45):
                    cut = pos + len(sep.rstrip())
                    break
            if cut <= 0:
                cut = max_chunk_chars
            head = remaining[:cut].strip()
            if head:
                bounded.append(head)
            remaining = remaining[cut:].strip()
        if remaining:
            bounded.append(remaining)
    return bounded or [compact]


def _merge_soft_wrapped_paragraph(paragraph: str) -> list[str]:
    """Group soft-wrapped OCR lines inside a single block while keeping bullets/headings distinct."""
    raw_lines = [line.strip() for line in paragraph.split("\n") if line.strip()]
    if len(raw_lines) <= 1:
        return raw_lines
    logical_lines: list[str] = []
    current = ""
    for line in raw_lines:
        if _BULLET_OR_HEADING_RE.search(line):
            if current:
                logical_lines.append(current)
                current = ""
            logical_lines.append(line)
            continue
        if not current:
            current = line
        elif re.search(r"[.!?…。！？؟:؛]\s*$", current):
            logical_lines.append(current)
            current = line
        else:
            current = f"{current} {line}"
    if current:
        logical_lines.append(current)
    return logical_lines


def _find_sentencepiece_model(model_dir: Path) -> Path | None:
    for pattern in ("sentencepiece.bpe.model", "*.bpe.model", "sentencepiece*.model", "spm*.model", "*.model", "*.spm"):
        for hit in sorted(model_dir.glob(pattern)):
            if hit.is_file() and hit.stat().st_size > 64:
                return hit
    return None


def _dir_size_bytes(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    total = 0
    for root, _dirs, files in os.walk(directory):
        for fname in files:
            if fname.endswith(".part"):
                continue
            with contextlib.suppress(OSError):
                total += (Path(root) / fname).stat().st_size
    return total


def _is_wanted_repo_file(filename: str) -> bool:
    norm = filename.replace("\\", "/").strip("/")
    if not norm or "/" in norm or norm.startswith("."):
        return False
    lower = norm.lower()
    if lower in {
        "model.bin",
        "config.json",
        "shared_vocabulary.json",
        "shared_vocabulary.txt",
        "vocabulary.json",
        "vocabulary.txt",
        "sentencepiece.bpe.model",
        "sentencepiece.model",
        "source.spm",
        "target.spm",
        "tokenizer_config.json",
        "special_tokens_map.json",
    }:
        return True
    return lower.endswith((".bpe.model", ".spm"))


def _format_mb(num_bytes: int | float) -> str:
    mb = max(0.0, float(num_bytes)) / (1024 * 1024)
    if mb >= 1024:
        return f"{mb / 1024:.2f} GB"
    return f"{mb:.0f} MB" if mb >= 10 else f"{mb:.1f} MB"


class LocalNmtManager:
    """Thread-safe lifecycle, download, and CPU/GPU CTranslate2 execution manager for NLLB-200."""

    def __init__(self, *, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport
        self._lock = threading.RLock()
        self._download_lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._busy_model: str | None = None
        self._busy_stage: str = ""
        self._busy_progress: float = 0.0
        self._loaded_model_id: str | None = None
        self._loaded_model_dir: str | None = None
        self._translator: Any = None
        self._sp: Any = None

    @property
    def root_dir(self) -> Path:
        return models_dir() / "local-nmt"

    def model_dir(self, model_id: str) -> Path:
        return self.root_dir / normalize_local_nmt_model(model_id)

    @staticmethod
    def _dir_has_valid_nmt_files(mdir: Path) -> bool:
        if not mdir.is_dir():
            return False
        model_bin = mdir / "model.bin"
        config_json = mdir / "config.json"
        has_vocab = any(
            (mdir / vname).is_file()
            for vname in ("shared_vocabulary.json", "shared_vocabulary.txt", "vocabulary.json", "vocabulary.txt")
        )
        sp_file = _find_sentencepiece_model(mdir)
        try:
            return (
                model_bin.is_file()
                and model_bin.stat().st_size > 0
                and config_json.is_file()
                and has_vocab
                and sp_file is not None
            )
        except OSError:
            return False

    def resolved_model_dir(self, model_id: str) -> Path:
        norm_id = normalize_local_nmt_model(model_id)
        primary = self.root_dir / norm_id
        if self._dir_has_valid_nmt_files(primary):
            return primary
        bundled = bundled_models_dir()
        if bundled is not None:
            b_cand = bundled / "local-nmt" / norm_id
            if self._dir_has_valid_nmt_files(b_cand):
                return b_cand
        return primary

    def runtime_installed(self) -> bool:
        ensure_custom_site_packages_on_path()
        return (
            importlib.util.find_spec("ctranslate2") is not None
            and importlib.util.find_spec("sentencepiece") is not None
        )

    def is_model_files_present(self, model_id: str) -> bool:
        return self._dir_has_valid_nmt_files(self.resolved_model_dir(model_id))

    def is_ready(self, model_id: str) -> bool:
        return self.runtime_installed() and self.is_model_files_present(model_id)

    def status(self, active_model: str = DEFAULT_LOCAL_NMT_MODEL) -> dict[str, Any]:
        selected = normalize_local_nmt_model(active_model)
        rt_ok = self.runtime_installed()
        with self._lock:
            loaded_id = self._loaded_model_id if self._translator is not None else None
            busy_model = self._busy_model
            busy_stage = self._busy_stage
            busy_progress = round(self._busy_progress, 4)
        cards: list[dict[str, Any]] = []
        for mid, meta in LOCAL_NMT_MODELS.items():
            mdir = self.resolved_model_dir(mid)
            files_ok = self._dir_has_valid_nmt_files(mdir)
            disk_bytes = _dir_size_bytes(mdir) if mdir.is_dir() else 0
            cards.append({
                "id": mid,
                "label": meta["label"],
                "shortLabel": meta["short_label"],
                "description": meta["description"],
                "approxSize": meta["approx_size"],
                "approxBytes": meta["approx_bytes"],
                "ramHint": meta["ram_hint"],
                "diskBytes": disk_bytes,
                "diskSizeLabel": _format_mb(disk_bytes) if disk_bytes > 0 else "",
                "filesPresent": files_ok,
                "ready": bool(rt_ok and files_ok),
                "selected": mid == selected,
                "loaded": mid == loaded_id,
                "downloading": mid == busy_model,
            })
        return {
            "runtimeInstalled": rt_ok,
            "activeModel": selected,
            "loadedModel": loaded_id,
            "busyModel": busy_model,
            "busyStage": busy_stage,
            "busyProgress": busy_progress,
            "storagePath": str(self.root_dir),
            "models": cards,
        }

    def cancel_prepare(self) -> dict[str, Any]:
        self._cancel_event.set()
        return {"ok": True, "cancelled": True}

    def unload(self) -> dict[str, Any]:
        with self._lock:
            was_loaded = self._loaded_model_id
            translator = self._translator
            self._translator = None
            self._sp = None
            self._loaded_model_id = None
            self._loaded_model_dir = None
        if translator is not None:
            with contextlib.suppress(Exception):
                if hasattr(translator, "unload_model"):
                    translator.unload_model(to_cpu=False)
            del translator
        gc.collect()
        trim_process_memory()
        return {"ok": True, "unloadedModel": was_loaded}

    def delete_model(self, model_id: str) -> dict[str, Any]:
        target_id = normalize_local_nmt_model(model_id)
        if self._busy_model == target_id and self._download_lock.locked():
            raise LocalNmtError("این مدل هم‌اکنون در حال دانلود است؛ ابتدا دانلود را لغو کنید.")
        with self._lock:
            if self._loaded_model_id == target_id:
                self.unload()
        mdir = self.model_dir(target_id)
        freed = _dir_size_bytes(mdir)
        if mdir.exists():
            try:
                shutil.rmtree(mdir)
            except OSError as exc:
                raise LocalNmtError(f"حذف فایل‌های مدل از دیسک ممکن نبود: {exc}") from exc
        emit(f"مدل مترجم آفلاین «{LOCAL_NMT_MODELS[target_id]['short_label']}» از دیسک حذف شد.", "success")
        return {
            "ok": True,
            "deletedModel": target_id,
            "freedBytes": freed,
            "status": self.status(target_id),
        }

    def _set_busy(self, model_id: str | None, stage: str = "", progress: float = 0.0) -> None:
        with self._lock:
            self._busy_model = model_id
            self._busy_stage = stage
            self._busy_progress = max(0.0, min(1.0, float(progress)))

    def _check_cancelled(self) -> None:
        if self._cancel_event.is_set():
            raise LocalNmtError("دانلود و آماده‌سازی مترجم آفلاین به درخواست شما لغو شد.")

    def _fetch_repo_manifest(
        self,
        client: httpx.Client,
        endpoint: str,
        repo_id: str,
    ) -> list[tuple[str, int]]:
        resp = client.get(f"{endpoint}/api/models/{repo_id}", timeout=25.0)
        resp.raise_for_status()
        payload = resp.json()
        siblings = payload.get("siblings") if isinstance(payload, dict) else None
        if not isinstance(siblings, list):
            raise LocalNmtError("فهرست فایل‌های مخزن مدل معتبر نیست.")
        files: list[tuple[str, int]] = []
        for entry in siblings:
            if not isinstance(entry, dict):
                continue
            rfilename = str(entry.get("rfilename") or "").strip()
            if not _is_wanted_repo_file(rfilename):
                continue
            size = 0
            lfs = entry.get("lfs")
            if isinstance(lfs, dict) and isinstance(lfs.get("size"), int):
                size = lfs["size"]
            elif isinstance(entry.get("size"), int):
                size = entry["size"]
            files.append((rfilename, max(0, size)))
        if not any(name == "model.bin" for name, _ in files):
            raise LocalNmtError(f"فایل model.bin در مخزن {repo_id} یافت نشد.")
        # Download small metadata/tokenizer files first so fast failures happen immediately.
        files.sort(key=lambda item: (item[0] == "model.bin", item[1], item[0]))
        return files

    def _stream_file(
        self,
        client: httpx.Client,
        url: str,
        dest: Path,
        *,
        on_chunk_bytes: Callable[[int], None],
    ) -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        part_path = dest.with_name(dest.name + ".part")
        written = 0
        try:
            with client.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0)) as resp:
                resp.raise_for_status()
                with open(part_path, "wb") as handle:
                    for chunk in resp.iter_bytes(chunk_size=262_144):
                        self._check_cancelled()
                        if not chunk:
                            continue
                        handle.write(chunk)
                        written += len(chunk)
                        on_chunk_bytes(len(chunk))
            os.replace(part_path, dest)
            return written
        except BaseException:
            with contextlib.suppress(OSError):
                if part_path.exists():
                    part_path.unlink()
            raise

    def _download_repo_into(
        self,
        model_id: str,
        dest_dir: Path,
        meta: dict[str, Any],
        *,
        progress_cb: Callable[[str, float], None] | None = None,
    ) -> None:
        repos = [meta["primary_repo"], *meta.get("fallback_repos", ())]
        endpoints = [os.environ.get("HF_ENDPOINT", "").strip() or HF_PRIMARY_ENDPOINT]
        if endpoints[0] == HF_PRIMARY_ENDPOINT:
            endpoints.append(HF_MIRROR_ENDPOINT)

        last_exc: Exception | None = None
        dest_dir.mkdir(parents=True, exist_ok=True)

        headers = {"User-Agent": "ComicOCRStudio/4.10"}
        with httpx.Client(headers=headers, follow_redirects=True, transport=self._transport) as client:
            selected_manifest: list[tuple[str, int]] | None = None
            selected_endpoint = endpoints[0]
            selected_repo = repos[0]

            for repo_id in repos:
                for endpoint in endpoints:
                    self._check_cancelled()
                    try:
                        selected_manifest = self._fetch_repo_manifest(client, endpoint, repo_id)
                        selected_endpoint = endpoint
                        selected_repo = repo_id
                        break
                    except LocalNmtError as exc:
                        if self._cancel_event.is_set():
                            raise
                        last_exc = exc
                    except Exception as exc:
                        last_exc = exc
                if selected_manifest is not None:
                    break

            if selected_manifest is None:
                raise LocalNmtError(
                    f"دریافت مشخصات مدل آفلاین ممکن نشد؛ اتصال اینترنت را بررسی کنید. ({last_exc})"
                )

            need_external_sp = not any(
                name.endswith((".model", ".spm")) for name, _ in selected_manifest
            )
            approx_total = sum(sz for _, sz in selected_manifest) or int(meta["approx_bytes"])
            if need_external_sp:
                approx_total += 4_850_000

            completed_bytes = 0
            last_emitted_pct = -1

            def report_progress(label_prefix: str) -> None:
                nonlocal last_emitted_pct
                ratio = min(1.0, completed_bytes / max(1, approx_total))
                overall = 0.18 + 0.78 * ratio
                pct = int(ratio * 100)
                self._set_busy(model_id, label_prefix, overall)
                if progress_cb is not None:
                    progress_cb(label_prefix, round(overall, 4))
                if pct != last_emitted_pct and (pct % 2 == 0 or pct >= 99):
                    last_emitted_pct = pct
                    emit(
                        f"{label_prefix}: {_format_mb(completed_bytes)} از {_format_mb(approx_total)} ({pct}٪)",
                        progress=round(overall, 4),
                    )

            for rfilename, expected_size in selected_manifest:
                self._check_cancelled()
                target_file = dest_dir / rfilename
                if target_file.is_file() and target_file.stat().st_size > 0:
                    if expected_size <= 0 or target_file.stat().st_size == expected_size:
                        completed_bytes += target_file.stat().st_size
                        report_progress(f"تأیید فایل موجود ({rfilename})")
                        continue

                file_downloaded = False
                for endpoint in ([selected_endpoint] + [ep for ep in endpoints if ep != selected_endpoint]):
                    self._check_cancelled()
                    url = f"{endpoint}/{selected_repo}/resolve/main/{rfilename}"
                    before_file = completed_bytes
                    try:
                        def _on_chunk(n: int) -> None:
                            nonlocal completed_bytes
                            completed_bytes += n
                            report_progress(f"در حال دانلود {meta['short_label']}")

                        self._stream_file(client, url, target_file, on_chunk_bytes=_on_chunk)
                        file_downloaded = True
                        break
                    except LocalNmtError:
                        if self._cancel_event.is_set():
                            raise
                        completed_bytes = before_file
                    except Exception as exc:
                        completed_bytes = before_file
                        last_exc = exc
                if not file_downloaded:
                    raise LocalNmtError(
                        f"دانلود فایل «{rfilename}» ناموفق بود؛ لطفاً دوباره تلاش کنید (فایل‌های دانلودشده حفظ شده‌اند). جزئیات: {last_exc}"
                    )

            if _find_sentencepiece_model(dest_dir) is None:
                tok_repo = meta["tokenizer_repo"]
                sp_dest = dest_dir / "sentencepiece.bpe.model"
                sp_ok = False
                for endpoint in endpoints:
                    self._check_cancelled()
                    sp_url = f"{endpoint}/{tok_repo}/resolve/main/sentencepiece.bpe.model"
                    before_sp = completed_bytes
                    try:
                        def _on_sp_chunk(n: int) -> None:
                            nonlocal completed_bytes
                            completed_bytes += n
                            report_progress("در حال دانلود توکنایزر چندزبانه")

                        self._stream_file(client, sp_url, sp_dest, on_chunk_bytes=_on_sp_chunk)
                        sp_ok = True
                        break
                    except LocalNmtError:
                        if self._cancel_event.is_set():
                            raise
                        completed_bytes = before_sp
                    except Exception as exc:
                        completed_bytes = before_sp
                        last_exc = exc
                if not sp_ok:
                    raise LocalNmtError(f"دانلود فایل توکنایزر SentencePiece ناموفق بود: {last_exc}")

    def prepare(
        self,
        model_id: str = DEFAULT_LOCAL_NMT_MODEL,
        *,
        progress_cb: Callable[[str, float], None] | None = None,
    ) -> dict[str, Any]:
        target_id = normalize_local_nmt_model(model_id)
        meta = LOCAL_NMT_MODELS[target_id]
        if not self._download_lock.acquire(blocking=False):
            raise LocalNmtError("هم‌اکنون یک دانلود مدل مترجم آفلاین در حال انجام است.")
        self._cancel_event.clear()
        self._set_busy(target_id, "در حال بررسی پیش‌نیازها…", 0.02)
        if progress_cb is not None:
            progress_cb("در حال بررسی پیش‌نیازها…", 0.02)
        try:
            dest_dir = self.model_dir(target_id)
            dest_dir.parent.mkdir(parents=True, exist_ok=True)
            if not self.is_model_files_present(target_id):
                try:
                    free_bytes = shutil.disk_usage(dest_dir.parent).free
                except OSError:
                    free_bytes = meta["min_free_bytes"]
                existing_bytes = _dir_size_bytes(dest_dir)
                needed_bytes = max(120_000_000, int(meta["min_free_bytes"]) - existing_bytes)
                if free_bytes < needed_bytes:
                    raise LocalNmtError(
                        f"فضای خالی درایو کافی نیست؛ حداقل {_format_mb(needed_bytes)} فضای خالی لازم است "
                        f"(فضای موجود: {_format_mb(free_bytes)}). می‌توانید از «مسیر ذخیره‌سازی و دانلودها» درایو دیگری انتخاب کنید."
                    )

            self._check_cancelled()
            if not self.runtime_installed():
                self._set_busy(target_id, "نصب موتور اجرایی CTranslate2 و SentencePiece…", 0.06)
                if progress_cb is not None:
                    progress_cb("نصب موتور اجرایی CTranslate2 و SentencePiece…", 0.06)
                emit("نصب موتور سبک ترجمهٔ آفلاین (CTranslate2 + SentencePiece)…", progress=0.06)

                def _on_runtime_progress(msg: str, prog: float) -> None:
                    self._set_busy(target_id, msg, prog)
                    if progress_cb is not None:
                        progress_cb(msg, prog)

                try:
                    try:
                        install_packages(
                            LOCAL_NMT_RUNTIME_PACKAGES,
                            cancel_event=self._cancel_event,
                            progress_cb=_on_runtime_progress,
                            start_p=0.06,
                            end_p=0.16,
                            label="مترجم آفلاین",
                        )
                    except TypeError:
                        # Support 1-argument monkeypatched stubs in unit tests.
                        install_packages(LOCAL_NMT_RUNTIME_PACKAGES)
                except OcrError as exc:
                    if self._cancel_event.is_set() or "لغو" in str(exc):
                        raise LocalNmtError("دانلود مدل مترجم آفلاین به درخواست کاربر لغو شد.") from exc
                    raise LocalNmtError(
                        f"نصب موتور اجرایی مترجم آفلاین (CTranslate2 / SentencePiece) ناموفق بود؛ اتصال اینترنت را بررسی کنید و دوباره تلاش کنید. جزئیات: {exc}"
                    ) from exc
                ensure_custom_site_packages_on_path()
                importlib.invalidate_caches()
                if not self.runtime_installed():
                    raise LocalNmtError("پس از نصب، بسته‌های ctranslate2 یا sentencepiece یافت نشدند.")

            self._check_cancelled()
            if not self.is_model_files_present(target_id):
                self._set_busy(target_id, f"اتصال برای دریافت {meta['short_label']}…", 0.16)
                if progress_cb is not None:
                    progress_cb(f"اتصال برای دریافت {meta['short_label']}…", 0.16)
                emit(f"دریافت مدل مترجم آفلاین «{meta['label']}» آغاز شد…", progress=0.16)
                self._download_repo_into(target_id, dest_dir, meta, progress_cb=progress_cb)

            self._check_cancelled()
            self._set_busy(target_id, "در حال بررسی سلامت فایل‌های مدل…", 0.97)
            if progress_cb is not None:
                progress_cb("در حال بررسی سلامت فایل‌های مدل…", 0.97)
            emit("در حال بررسی سلامت مدل مترجم آفلاین روی سیستم…", progress=0.97)
            self._ensure_loaded(target_id)
            # Release immediately after verification so preparation leaves idle RAM clean.
            self.unload()
            if progress_cb is not None:
                progress_cb("آماده شد", 1.0)
            emit(
                f"مدل مترجم آفلاین «{meta['short_label']}» آمادهٔ استفاده است و از این پس بدون اینترنت کار می‌کند.",
                "success",
                1.0,
            )
            return self.status(target_id)
        finally:
            self._set_busy(None, "", 0.0)
            self._download_lock.release()

    def _ensure_loaded(self, model_id: str) -> tuple[Any, Any]:
        target_id = normalize_local_nmt_model(model_id)
        mdir = self.resolved_model_dir(target_id)
        with self._lock:
            if (
                self._translator is not None
                and self._sp is not None
                and self._loaded_model_id == target_id
                and self._loaded_model_dir == str(mdir)
            ):
                return self._translator, self._sp

            if not self.runtime_installed():
                raise LocalNmtError(
                    "موتور مترجم آفلاین هنوز نصب نشده است. در پنجرهٔ «مدیریت ترجمه‌ها» روی «دانلود و نصب خودکار» کلیک کنید."
                )
            if not self.is_model_files_present(target_id):
                label = LOCAL_NMT_MODELS[target_id]["short_label"]
                raise LocalNmtError(
                    f"مدل آفلاین «{label}» هنوز دانلود نشده است. در پنجرهٔ «مدیریت ترجمه‌ها» یک‌بار روی «دانلود و نصب خودکار» کلیک کنید تا پس از آن همیشه بدون اینترنت کار کند."
                )

            self.unload()
            ensure_custom_site_packages_on_path()
            import ctranslate2
            import sentencepiece as spm

            sp_path = _find_sentencepiece_model(mdir)
            if sp_path is None:
                raise LocalNmtError("فایل توکنایزر SentencePiece در پوشهٔ مدل یافت نشد.")

            sp = spm.SentencePieceProcessor()
            if not sp.Load(str(sp_path)):
                raise LocalNmtError("بارگذاری فایل توکنایزر SentencePiece ناموفق بود.")

            cpu_threads = max(1, min(4, (os.cpu_count() or 2)))
            translator = None
            # Prefer CUDA automatically only when available and healthy; fall back cleanly to CPU int8/default.
            try_configs: list[tuple[str, str]] = []
            with contextlib.suppress(Exception):
                if getattr(ctranslate2, "get_cuda_device_count", lambda: 0)() > 0:
                    try_configs.append(("cuda", "int8_float16"))
                    try_configs.append(("cuda", "default"))
            try_configs.extend([("cpu", "int8"), ("cpu", "default")])

            load_err: Exception | None = None
            for device, compute_type in try_configs:
                try:
                    kwargs: dict[str, Any] = {
                        "device": device,
                        "compute_type": compute_type,
                        "inter_threads": 1,
                    }
                    if device == "cpu":
                        kwargs["intra_threads"] = cpu_threads
                    translator = ctranslate2.Translator(str(mdir), **kwargs)
                    break
                except Exception as exc:
                    load_err = exc
                    translator = None
            if translator is None:
                raise LocalNmtError(f"بارگذاری مدل مترجم آفلاین ناموفق بود: {load_err}")

            self._translator = translator
            self._sp = sp
            self._loaded_model_id = target_id
            self._loaded_model_dir = str(mdir)
            return translator, sp

    def _translate_sentences_raw(
        self,
        sentences: list[str],
        src_flores: str,
        tgt_flores: str,
        *,
        model_id: str,
        beam_size: int = DEFAULT_LOCAL_BEAM_SIZE,
    ) -> list[str]:
        if not sentences:
            return []
        if src_flores == tgt_flores:
            return list(sentences)

        active_indices: list[int] = []
        active_sentences: list[str] = []
        outputs: list[str] = list(sentences)
        for idx, sent in enumerate(sentences):
            if re.search(r"[^\W\d_]", sent, re.UNICODE):
                active_indices.append(idx)
                active_sentences.append(sent)
        if not active_sentences:
            return outputs

        with self._lock:
            translator, sp = self._ensure_loaded(model_id)
            tokenized_batch: list[list[str]] = []
            for s in active_sentences:
                pieces = list(sp.encode(s, out_type=str))
                tokenized_batch.append([src_flores, *pieces, "</s>"])
            target_prefixes = [[tgt_flores]] * len(tokenized_batch)
            results = translator.translate_batch(
                tokenized_batch,
                target_prefix=target_prefixes,
                beam_size=max(1, min(4, int(beam_size))),
                max_batch_size=32,
                max_input_length=512,
                max_decoding_length=384,
                repetition_penalty=1.08,
                no_repeat_ngram_size=4,
                replace_unknowns=True,
            )
            strip_tokens = {"</s>", "<s>", "<unk>", tgt_flores, src_flores}
            for out_pos, src_sent, res in zip(active_indices, active_sentences, results):
                hyp = list(res.hypotheses[0]) if getattr(res, "hypotheses", None) else []
                cleaned = [tok for tok in hyp if tok not in strip_tokens]
                text_out = str(sp.decode(cleaned) or "").strip()
                outputs[out_pos] = text_out or src_sent
            return outputs

    def translate_blocks(
        self,
        source_texts: list[str],
        source_language: str,
        target_language: str,
        *,
        model_id: str = DEFAULT_LOCAL_NMT_MODEL,
        beam_size: int = DEFAULT_LOCAL_BEAM_SIZE,
        keep_loaded: bool = True,
    ) -> list[str]:
        """Translate one or many blocks offline, guaranteeing 1-to-1 line parity for multi-block batches."""
        if not source_texts:
            return []
        combined_sample = "\n".join(str(t or "") for t in source_texts)
        src_flores, tgt_flores = resolve_nllb_pair(source_language, target_language, combined_sample)

        try:
            # Single-block / single-sentence path: merge soft-wrapped OCR lines inside paragraphs
            # so SOV languages like Persian receive complete grammatical sentences.
            if len(source_texts) == 1:
                raw_single = str(source_texts[0] or "").replace("\r\n", "\n").replace("\r", "\n").strip()
                if not raw_single:
                    return [""]
                paragraphs = re.split(r"\n\s*\n", raw_single)
                para_line_sentences: list[list[list[int]]] = []
                flat_sentences: list[str] = []
                for para in paragraphs:
                    logical_lines = _merge_soft_wrapped_paragraph(para)
                    line_slots: list[list[int]] = []
                    for line in logical_lines:
                        sents = split_nllb_sentences(line)
                        idxs: list[int] = []
                        for s in sents:
                            idxs.append(len(flat_sentences))
                            flat_sentences.append(s)
                        line_slots.append(idxs)
                    para_line_sentences.append(line_slots)
                translated_flat = self._translate_sentences_raw(
                    flat_sentences,
                    src_flores,
                    tgt_flores,
                    model_id=model_id,
                    beam_size=beam_size,
                )
                rebuilt_paragraphs: list[str] = []
                for line_slots in para_line_sentences:
                    rebuilt_lines = [
                        " ".join(translated_flat[i] for i in idxs if translated_flat[i]).strip()
                        for idxs in line_slots
                    ]
                    rebuilt_paragraphs.append("\n".join(line for line in rebuilt_lines if line))
                return ["\n\n".join(p for p in rebuilt_paragraphs if p).strip()]

            # Multi-block path: preserve exact line count & empty-line positions per block
            # so `distribute_translation(source_texts, "\n".join(out))` never shifts blocks.
            block_plans: list[list[list[int]]] = []
            flat_sentences = []
            for raw_block in source_texts:
                norm_lines = str(raw_block or "").replace("\r\n", "\n").replace("\r", "\n").strip().split("\n")
                line_plan: list[list[int]] = []
                for line in norm_lines:
                    clean_line = line.strip()
                    if not clean_line:
                        line_plan.append([])
                        continue
                    sents = split_nllb_sentences(clean_line)
                    idxs = []
                    for s in sents:
                        idxs.append(len(flat_sentences))
                        flat_sentences.append(s)
                    line_plan.append(idxs)
                block_plans.append(line_plan)

            translated_flat = self._translate_sentences_raw(
                flat_sentences,
                src_flores,
                tgt_flores,
                model_id=model_id,
                beam_size=beam_size,
            )
            out_blocks: list[str] = []
            for line_plan in block_plans:
                out_lines: list[str] = []
                for idxs in line_plan:
                    if not idxs:
                        out_lines.append("")
                    else:
                        joined = " ".join(translated_flat[i] for i in idxs if translated_flat[i]).strip()
                        out_lines.append(joined or "-")
                out_blocks.append("\n".join(out_lines))
            return out_blocks
        finally:
            if not keep_loaded:
                self.unload()

    def test_translation(
        self,
        *,
        model_id: str = DEFAULT_LOCAL_NMT_MODEL,
        source_language: str = "eng",
        target_language: str = "fa",
        sample_text: str = "",
        beam_size: int = DEFAULT_LOCAL_BEAM_SIZE,
        keep_loaded: bool = False,
    ) -> dict[str, Any]:
        text = str(sample_text or "").strip() or "Hello! Wait a second, where are we going today?"
        result = self.translate_blocks(
            [text],
            source_language,
            target_language,
            model_id=model_id,
            beam_size=beam_size,
            keep_loaded=keep_loaded,
        )[0]
        label = LOCAL_NMT_MODELS[normalize_local_nmt_model(model_id)]["short_label"]
        return {
            "ok": True,
            "model": normalize_local_nmt_model(model_id),
            "sourceText": text,
            "translatedText": result,
            "message": f"مترجم آفلاین «{label}» آماده است ✓ — نمونهٔ ترجمه: «{result}»",
        }


local_nmt_manager = LocalNmtManager()
