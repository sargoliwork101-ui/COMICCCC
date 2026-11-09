from __future__ import annotations

from collections.abc import Callable
import contextlib
import importlib
import json
import os
from pathlib import Path
import shutil
import site
import subprocess
import sys
import tempfile
import threading
import uuid
from typing import Any


def _resolve_runtime_dirs() -> tuple[Path, Path, Path]:
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        meipass = Path(getattr(sys, "_MEIPASS", exe_dir)).resolve()
        pkg_candidate = meipass / "comic_studio"
        pkg_dir = pkg_candidate if (pkg_candidate / "static").is_dir() else Path(__file__).resolve().parent
        static_dir = pkg_dir / "static" if (pkg_dir / "static").is_dir() else (meipass / "static")
        return pkg_dir, exe_dir, static_dir
    pkg_dir = Path(__file__).resolve().parent
    return pkg_dir, pkg_dir.parent, pkg_dir / "static"


PACKAGE_DIR, APP_DIR, STATIC_DIR = _resolve_runtime_dirs()
STORAGE_CONFIG_FILENAME = "storage-config.json"
_HostPath = type(PACKAGE_DIR)

_CONFIG_LOCK = threading.RLock()
_CONFIG_CACHE: tuple[str, int, int, dict[str, Any]] | None = None
_FALLBACK_WARNING: str = ""
_ACTIVE_CUSTOM_SITE: str | None = None

_TRANSIENT_ROOT_NAMES = frozenset({
    STORAGE_CONFIG_FILENAME,
    "backup-temp",
    "restore-staging",
})
_TRANSIENT_MODEL_NAMES = frozenset({
    "tmp",
})


def default_data_dir() -> Path:
    """Default local data directory when no optional custom path is configured."""
    raw = os.environ.get("COMIC_STUDIO_DATA")
    if raw and raw.strip():
        return _HostPath(raw.strip())
    return _HostPath(os.path.expanduser("~")) / ".comic-ocr-studio"


def storage_config_path() -> Path:
    """Bootstrap JSON pointer storing the user's optional custom data directory."""
    raw = os.environ.get("COMIC_STUDIO_CONFIG")
    if raw and raw.strip():
        return _HostPath(raw.strip())
    return default_data_dir() / STORAGE_CONFIG_FILENAME


def _read_storage_config() -> dict[str, Any]:
    global _CONFIG_CACHE
    cfg_path = storage_config_path()
    key = str(cfg_path)
    with _CONFIG_LOCK:
        try:
            st = cfg_path.stat()
        except OSError:
            _CONFIG_CACHE = (key, -1, -1, {})
            return {}
        if (
            _CONFIG_CACHE is not None
            and _CONFIG_CACHE[0] == key
            and _CONFIG_CACHE[1] == st.st_mtime_ns
            and _CONFIG_CACHE[2] == st.st_size
        ):
            return dict(_CONFIG_CACHE[3])
        try:
            payload = json.loads(cfg_path.read_text(encoding="utf-8"))
            data = payload if isinstance(payload, dict) else {}
        except Exception:
            data = {}
        _CONFIG_CACHE = (key, st.st_mtime_ns, st.st_size, data)
        return dict(data)


def _write_storage_config(custom_data_dir: str) -> None:
    global _CONFIG_CACHE
    cfg_path = storage_config_path()
    clean = str(custom_data_dir or "").strip()
    with _CONFIG_LOCK:
        if not clean and not cfg_path.exists():
            _CONFIG_CACHE = (str(cfg_path), -1, -1, {})
            return
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"custom_data_dir": clean}
        fd, raw_tmp = tempfile.mkstemp(
            prefix=".storage-config-",
            suffix=".tmp",
            dir=cfg_path.parent,
        )
        tmp_path = Path(raw_tmp)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                with contextlib.suppress(OSError):
                    os.fsync(handle.fileno())
            os.replace(tmp_path, cfg_path)
        finally:
            if tmp_path.exists():
                with contextlib.suppress(OSError):
                    tmp_path.unlink()
        try:
            st = cfg_path.stat()
            _CONFIG_CACHE = (str(cfg_path), st.st_mtime_ns, st.st_size, payload)
        except OSError:
            _CONFIG_CACHE = None


def configured_custom_data_dir() -> str:
    return str(_read_storage_config().get("custom_data_dir") or "").strip()


def data_dir() -> Path:
    """Active user data root (honoring optional custom directory when configured and reachable)."""
    global _FALLBACK_WARNING
    custom_raw = configured_custom_data_dir()
    if custom_raw:
        try:
            custom_root = _HostPath(custom_raw)
            custom_root.mkdir(parents=True, exist_ok=True)
            _FALLBACK_WARNING = ""
            return custom_root
        except OSError as exc:
            _FALLBACK_WARNING = (
                f"مسیر سفارشی انتخاب‌شده («{custom_raw}») در حال حاضر در دسترس نیست ({exc})؛ "
                "برنامه موقتاً از مسیر پیش‌فرض استفاده می‌کند تا به اطلاعات شما آسیبی نرسد."
            )
    else:
        _FALLBACK_WARNING = ""
    root = default_data_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def is_custom_data_dir_active() -> bool:
    custom_raw = configured_custom_data_dir()
    if not custom_raw:
        return False
    try:
        active = data_dir().resolve()
        default = default_data_dir().resolve()
        return active != default and active == _HostPath(custom_raw).resolve()
    except OSError:
        return False


def project_root(project_id: str) -> Path:
    return data_dir() / "projects" / project_id


def models_dir() -> Path:
    path = data_dir() / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path


def bundled_models_dir() -> Path | None:
    """Optional read-only offline model bundle shipped next to ComicOCRStudio.exe or python_app."""
    raw_env = os.environ.get("COMIC_STUDIO_BUNDLED_MODELS")
    candidates: list[Path] = []
    if raw_env and raw_env.strip():
        candidates.append(_HostPath(raw_env.strip()))
    search_roots: list[Path] = [APP_DIR]
    if getattr(sys, "frozen", False):
        with contextlib.suppress(OSError):
            exe_dir = _HostPath(str(sys.executable)).resolve().parent
            if exe_dir not in search_roots:
                search_roots.append(exe_dir)
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            meipass_dir = _HostPath(str(meipass))
            if meipass_dir not in search_roots:
                search_roots.append(meipass_dir)
    for root in search_roots:
        candidates.append(root / "bundled_models")
        candidates.append(root / "bundled-models")
    for cand in candidates:
        with contextlib.suppress(OSError):
            if cand.is_dir():
                return cand
    return None


def custom_site_packages_dir() -> Path:
    return models_dir() / "site-packages"


def ensure_custom_site_packages_on_path() -> Path | None:
    """Append `<models_dir>/site-packages` to `sys.path` when present so optional runtime
    packages (like EasyOCR/PyTorch) installed into a custom drive are importable in-process
    without writing gigabytes onto Drive C."""
    global _ACTIVE_CUSTOM_SITE
    with _CONFIG_LOCK:
        try:
            candidate = data_dir() / "models" / "site-packages"
            has_dir = candidate.is_dir()
            cand_str = str(candidate.resolve()) if has_dir else None
        except OSError:
            has_dir = False
            cand_str = None

        if _ACTIVE_CUSTOM_SITE and _ACTIVE_CUSTOM_SITE != cand_str:
            sys.path[:] = [p for p in sys.path if p != _ACTIVE_CUSTOM_SITE]
            _ACTIVE_CUSTOM_SITE = None
            importlib.invalidate_caches()

        if has_dir and cand_str:
            if cand_str not in sys.path:
                site.addsitedir(cand_str)
                # Keep custom site at the end of sys.path so already-loaded core C extensions
                # (numpy, Pillow, cv2, onnxruntime) always resolve from the app's primary .venv.
                if cand_str in sys.path:
                    sys.path[:] = [p for p in sys.path if p != cand_str] + [cand_str]
                importlib.invalidate_caches()
            _ACTIVE_CUSTOM_SITE = cand_str
            return Path(cand_str)
        return None


def _is_forbidden_system_or_app_dir(resolved: Path) -> str | None:
    # 1. Never allow bare filesystem / drive root (e.g. `C:\`, `D:\`, `/`)
    if resolved.parent == resolved:
        return "ریشهٔ مستقیم درایو (مثل D:\\) قابل انتخاب نیست؛ لطفاً یک پوشهٔ مشخص مثل D:\\ComicOCRStudio انتخاب کنید."

    norm = os.path.normcase(str(resolved))
    if os.name == "nt":
        win_dir = os.path.normcase(os.environ.get("SystemRoot") or r"C:\Windows")
        prog_dirs = [
            os.path.normcase(p)
            for p in (
                os.environ.get("ProgramFiles"),
                os.environ.get("ProgramFiles(x86)"),
                os.environ.get("ProgramW6432"),
            )
            if p
        ]
        if norm == win_dir or norm.startswith(win_dir + os.sep):
            return "پوشهٔ سیستمی ویندوز مجاز نیست؛ لطفاً یک پوشهٔ معمولی در درایو دلخواه انتخاب کنید."
        for pdir in prog_dirs:
            if norm == pdir:
                return "پوشهٔ اصلی Program Files را مستقیماً انتخاب نکنید؛ یک پوشهٔ جداگانه انتخاب کنید."
    else:
        for sys_prefix in ("/bin", "/sbin", "/usr", "/etc", "/proc", "/sys", "/dev", "/boot", "/lib", "/lib64"):
            if norm == sys_prefix or norm.startswith(sys_prefix + "/"):
                return "پوشه‌های سیستمی سیستم‌عامل مجاز نیستند؛ لطفاً یک پوشهٔ کاربری یا درایو جداگانه انتخاب کنید."

    # 2. Never allow the source package itself or `.venv` as data_dir
    app_resolved = APP_DIR.resolve()
    pkg_resolved = PACKAGE_DIR.resolve()
    venv_resolved = (APP_DIR / ".venv").resolve()
    if resolved == app_resolved:
        return "پوشهٔ اصلی کدهای اجرایی (python_app) را مستقیماً انتخاب نکنید؛ یک پوشهٔ جداگانه (مثلاً پوشهٔ کنار آن در همان درایو) انتخاب کنید."
    if resolved == pkg_resolved or pkg_resolved in resolved.parents:
        return "پوشهٔ داخلی کدهای برنامه (comic_studio) قابل انتخاب به‌عنوان پوشهٔ داده نیست."
    if resolved == venv_resolved or venv_resolved in resolved.parents:
        return "پوشهٔ محیط پایتون (.venv) قابل انتخاب به‌عنوان پوشهٔ داده نیست."
    return None


def validate_custom_data_dir(raw_path: str) -> Path:
    """Validate and write-probe a user-supplied custom storage directory before activating it."""
    expanded = os.path.expandvars(os.path.expanduser(str(raw_path or "").strip()))
    # Strip accidental surrounding quotes pasted from Windows Explorer ("Copy as path")
    if len(expanded) >= 2 and expanded[0] == expanded[-1] and expanded[0] in {'"', "'"}:
        expanded = expanded[1:-1].strip()
    if not expanded:
        raise ValueError("مسیر پوشه خالی است.")
    if any(ch in expanded for ch in ("\x00", "\r", "\n")):
        raise ValueError("مسیر واردشده کاراکتر غیرمجاز دارد.")
    candidate = Path(expanded)
    if not candidate.is_absolute():
        raise ValueError("لطفاً مسیر کامل پوشه را وارد کنید (مثلاً D:\\ComicOCRStudio).")
    try:
        resolved = candidate.resolve(strict=False)
    except OSError as exc:
        raise ValueError(f"مسیر واردشده معتبر نیست: {exc}") from exc

    if resolved.exists() and not resolved.is_dir():
        raise ValueError("مسیر انتخاب‌شده یک فایل است، نه یک پوشه.")

    reason = _is_forbidden_system_or_app_dir(resolved)
    if reason:
        raise ValueError(reason)

    try:
        resolved.mkdir(parents=True, exist_ok=True)
        probe = resolved / f".comic-studio-probe-{uuid.uuid4().hex[:10]}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as exc:
        raise ValueError(
            f"امکان ساخت پوشه یا نوشتن فایل در «{resolved}» وجود ندارد "
            f"(از وصل‌بودن درایو و دسترسی نوشتن مطمئن شوید): {exc}"
        ) from exc
    return resolved


def _dir_size_bytes(root: Path, *, skip_root_names: frozenset[str] = frozenset()) -> int:
    if not root.is_dir():
        return 0
    total = 0
    stack: list[tuple[Path, bool]] = [(root, True)]
    while stack:
        current, is_top = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    if is_top and entry.name in skip_root_names:
                        continue
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if current.name == "models" and entry.name in _TRANSIENT_MODEL_NAMES:
                                continue
                            stack.append((Path(entry.path), False))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _disk_stats_gb(target: Path) -> tuple[float, float]:
    probe = target
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe if probe.exists() else Path.home())
        return round(usage.free / (1024 ** 3), 2), round(usage.total / (1024 ** 3), 2)
    except OSError:
        return 0.0, 0.0


def inspect_storage_status() -> dict[str, Any]:
    active = data_dir()
    default_root = default_data_dir()
    custom_cfg = configured_custom_data_dir()
    custom_active = is_custom_data_dir_active()
    models_bytes = _dir_size_bytes(active / "models")
    projects_bytes = _dir_size_bytes(active / "projects")
    used_bytes = _dir_size_bytes(active, skip_root_names=_TRANSIENT_ROOT_NAMES)
    free_gb, total_gb = _disk_stats_gb(active)
    def_free_gb, def_total_gb = _disk_stats_gb(default_root)
    return {
        "mode": "custom" if custom_active else "default",
        "activePath": str(active),
        "defaultPath": str(default_root),
        "customPath": custom_cfg,
        "customActive": custom_active,
        "fallbackWarning": _FALLBACK_WARNING,
        "appDir": str(APP_DIR),
        "envOverrideActive": bool((os.environ.get("COMIC_STUDIO_DATA") or "").strip()),
        "usedBytes": used_bytes,
        "usedGb": round(used_bytes / (1024 ** 3), 2),
        "modelsBytes": models_bytes,
        "modelsGb": round(models_bytes / (1024 ** 3), 2),
        "projectsBytes": projects_bytes,
        "projectsGb": round(projects_bytes / (1024 ** 3), 2),
        "freeDiskGb": free_gb,
        "totalDiskGb": total_gb,
        "defaultFreeDiskGb": def_free_gb,
        "defaultTotalDiskGb": def_total_gb,
    }


def _same_filesystem(path_a: Path, path_b: Path) -> bool:
    probe_a = path_a
    while not probe_a.exists() and probe_a.parent != probe_a:
        probe_a = probe_a.parent
    probe_b = path_b
    while not probe_b.exists() and probe_b.parent != probe_b:
        probe_b = probe_b.parent
    if os.name == "nt":
        drv_a = os.path.splitdrive(os.path.abspath(str(probe_a)))[0].lower()
        drv_b = os.path.splitdrive(os.path.abspath(str(probe_b)))[0].lower()
        if drv_a and drv_b:
            return drv_a == drv_b
    try:
        return os.stat(probe_a).st_dev == os.stat(probe_b).st_dev
    except OSError:
        return False


def _collect_migratable_entries(source_root: Path) -> tuple[list[tuple[Path, Path, str, int]], int]:
    """Return `(entries, total_bytes)` where each entry is `(src_path, rel_path, kind, size)`
    and `kind` is `'dir'`, `'symlink'`, or `'file'`."""
    entries: list[tuple[Path, Path, str, int]] = []
    total_bytes = 0
    if not source_root.is_dir():
        return entries, 0

    def _walk(cur: Path, is_top: bool) -> None:
        nonlocal total_bytes
        try:
            children = sorted(os.scandir(cur), key=lambda e: e.name)
        except OSError:
            return
        for entry in children:
            if is_top and entry.name in _TRANSIENT_ROOT_NAMES:
                continue
            src = Path(entry.path)
            rel = src.relative_to(source_root)
            if cur.name == "models" and entry.name in _TRANSIENT_MODEL_NAMES:
                continue
            try:
                if entry.is_symlink():
                    entries.append((src, rel, "symlink", 0))
                elif entry.is_dir(follow_symlinks=False):
                    entries.append((src, rel, "dir", 0))
                    _walk(src, False)
                elif entry.is_file(follow_symlinks=False):
                    sz = entry.stat(follow_symlinks=False).st_size
                    entries.append((src, rel, "file", sz))
                    total_bytes += sz
            except OSError:
                continue

    _walk(source_root, True)
    return entries, total_bytes


def _repair_relocated_isolated_venvs(models_root: Path) -> None:
    """Ensure any migrated isolated venv under `<models_root>/envs/*` has healthy Python/launcher metadata."""
    envs_dir = models_root / "envs"
    if not envs_dir.is_dir():
        return
    base_py = getattr(sys, "_base_executable", None) or sys.executable
    if not base_py or not Path(base_py).is_file():
        base_py = sys.executable
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    for env_dir in envs_dir.iterdir():
        if not env_dir.is_dir():
            continue
        py = env_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not (env_dir / "pyvenv.cfg").is_file():
            continue
        probe_ok = False
        if py.exists():
            try:
                res = subprocess.run(
                    [str(py), "-c", "import sys; sys.exit(0)"],
                    capture_output=True,
                    timeout=15,
                    check=False,
                    creationflags=creationflags,
                )
                probe_ok = res.returncode == 0
            except Exception:
                probe_ok = False
        if not probe_ok:
            with contextlib.suppress(Exception):
                subprocess.run(
                    [str(base_py), "-m", "venv", "--upgrade", str(env_dir)],
                    capture_output=True,
                    timeout=120,
                    check=False,
                    creationflags=creationflags,
                )


def _remove_migrated_source_entries(source_root: Path) -> int:
    """Remove migrated subdirectories/files from `source_root` AFTER destination verification,
    preserving `storage-config.json`."""
    if not source_root.is_dir():
        return 0
    freed = 0
    for child in list(source_root.iterdir()):
        if child.name == STORAGE_CONFIG_FILENAME:
            continue
        freed += _dir_size_bytes(child) if child.is_dir() and not child.is_symlink() else (
            child.stat(follow_symlinks=False).st_size if child.exists() and not child.is_symlink() else 0
        )
        try:
            if child.is_symlink() or child.is_file():
                child.unlink(missing_ok=True)
            elif child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            pass
    return freed


def apply_storage_directory(
    custom_path: str,
    *,
    migrate_existing: bool = True,
    cleanup_source: bool = True,
    progress_cb: Callable[[str, float], None] | None = None,
) -> dict[str, Any]:
    """Validate, optionally migrate & verify all Studio data/models/venvs, and switch active `data_dir()`."""
    def _report(msg: str, prog: float) -> None:
        if progress_cb is not None:
            progress_cb(msg, prog)

    clean_input = str(custom_path or "").strip()
    old_dir = data_dir().resolve()
    default_resolved = default_data_dir().resolve()

    if clean_input:
        target_dir = validate_custom_data_dir(clean_input)
        save_custom_value = "" if target_dir == default_resolved else str(target_dir)
    else:
        default_resolved.mkdir(parents=True, exist_ok=True)
        target_dir = default_resolved
        save_custom_value = ""

    if old_dir == target_dir:
        _write_storage_config(save_custom_value)
        ensure_custom_site_packages_on_path()
        _report("مسیر ذخیره‌سازی بررسی و ثبت شد.", 1.0)
        return {
            **inspect_storage_status(),
            "migratedBytes": 0,
            "freedSourceBytes": 0,
            "changed": False,
        }

    # Block recursive parent/child nesting when migrating
    if old_dir in target_dir.parents or target_dir in old_dir.parents:
        raise ValueError(
            "مسیر جدید نباید زیرپوشه یا پوشهٔ والدِ مستقیم مسیر فعلی باشد؛ لطفاً یک پوشهٔ مجزا (مثلاً D:\\ComicOCRStudio) انتخاب کنید."
        )

    migrated_bytes = 0
    freed_bytes = 0

    if migrate_existing and old_dir.is_dir():
        _report("در حال بررسی فایل‌ها، پروژه‌ها و مدل‌های فعلی برای انتقال امن…", 0.06)
        entries, total_bytes = _collect_migratable_entries(old_dir)
        if entries:
            try:
                free_bytes = shutil.disk_usage(target_dir).free
            except OSError as exc:
                raise ValueError(f"خواندن فضای خالی مسیر مقصد ممکن نبود: {exc}") from exc
            safety_margin = 64 * 1024 * 1024  # 64 MB safety headroom
            if free_bytes < total_bytes + safety_margin:
                need_gb = round((total_bytes + safety_margin) / (1024 ** 3), 2)
                avail_gb = round(free_bytes / (1024 ** 3), 2)
                raise ValueError(
                    f"فضای خالی مسیر مقصد ({avail_gb} گیگابایت) برای انتقال امن فایل‌های فعلی ({need_gb} گیگابایت) کافی نیست."
                )

            copied_so_far = 0
            verified_targets: list[tuple[Path, int]] = []
            for idx, (src, rel, kind, sz) in enumerate(entries):
                dst = target_dir / rel
                if kind == "dir":
                    dst.mkdir(parents=True, exist_ok=True)
                elif kind == "symlink":
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    if not dst.exists() and not dst.is_symlink():
                        link_target = os.readlink(src)
                        os.symlink(link_target, dst)
                elif kind == "file":
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    # Skip re-copying identical already-present model weights of exact same size & mtime
                    if dst.is_file() and not dst.is_symlink():
                        try:
                            dst_st = dst.stat()
                            src_st = src.stat()
                            if dst_st.st_size == sz and abs(dst_st.st_mtime - src_st.st_mtime) < 2.0:
                                copied_so_far += sz
                                verified_targets.append((dst, sz))
                                continue
                        except OSError:
                            pass
                    part = dst.parent / f".{dst.name}.mig-{uuid.uuid4().hex[:8]}"
                    try:
                        shutil.copy2(src, part, follow_symlinks=False)
                        os.replace(part, dst)
                    finally:
                        if part.exists():
                            with contextlib.suppress(OSError):
                                part.unlink()
                    copied_so_far += sz
                    migrated_bytes += sz
                    verified_targets.append((dst, sz))

                if idx % 15 == 0 or copied_so_far == total_bytes:
                    ratio = (copied_so_far / total_bytes) if total_bytes > 0 else ((idx + 1) / len(entries))
                    _report(
                        f"در حال انتقال امن فایل‌ها به مسیر جدید ({copied_so_far / (1024 * 1024):.1f} از {total_bytes / (1024 * 1024):.1f} مگابایت)…",
                        round(0.10 + 0.72 * min(1.0, ratio), 3),
                    )

            _report("تأیید سلامت تمام فایل‌های منتقل‌شده در مسیر جدید…", 0.85)
            for dst_file, expected_size in verified_targets:
                if not dst_file.is_file() or dst_file.stat().st_size != expected_size:
                    raise OSError(f"تأیید سلامت فایل منتقل‌شده ناموفق بود: {dst_file}")

            _report("به‌روزرسانی محیط‌های اجرایی مدل‌های OCR در مسیر جدید…", 0.90)
            _repair_relocated_isolated_venvs(target_dir / "models")

    (target_dir / "projects").mkdir(parents=True, exist_ok=True)
    (target_dir / "models").mkdir(parents=True, exist_ok=True)

    # Commit the pointer atomically ONLY after 100% of files are verified on target_dir
    _write_storage_config(save_custom_value)
    ensure_custom_site_packages_on_path()

    if migrate_existing and cleanup_source and old_dir.is_dir() and old_dir != target_dir:
        _report("آزادسازی فضای مصرفی مسیر قبلی پس از تأیید کامل سلامت فایل‌ها…", 0.95)
        freed_bytes = _remove_migrated_source_entries(old_dir)

    _report("مسیر ذخیره‌سازی جدید با موفقیت فعال شد.", 1.0)
    return {
        **inspect_storage_status(),
        "migratedBytes": migrated_bytes,
        "freedSourceBytes": freed_bytes,
        "changed": True,
    }


def pick_folder_dialog(initial_dir: str | None = None) -> str | None:
    """Open a native OS folder selection dialog on the local machine.
    Returns selected path string, `""` if user cancelled, or raises `RuntimeError` if headless."""
    start_dir = str(initial_dir or data_dir())
    if os.name == "nt":
        ps_exe = shutil.which("powershell.exe") or shutil.which("powershell")
        if ps_exe:
            ps_script = (
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$dlg.Description = 'پوشهٔ دلخواه برای ذخیرهٔ دانلودهای OCR و اطلاعات برنامه را انتخاب کنید'; "
                "$dlg.ShowNewFolderButton = $true; "
                "if ($env:COMIC_PICK_INIT -and (Test-Path -LiteralPath $env:COMIC_PICK_INIT)) { "
                "  $dlg.SelectedPath = $env:COMIC_PICK_INIT "
                "}; "
                "$owner = New-Object System.Windows.Forms.Form; "
                "$owner.TopMost = $true; "
                "$res = $dlg.ShowDialog($owner); "
                "if ($res -eq [System.Windows.Forms.DialogResult]::OK) { "
                "  [Console]::Out.Write($dlg.SelectedPath) "
                "}"
            )
            env = dict(os.environ)
            env["COMIC_PICK_INIT"] = start_dir
            res = subprocess.run(
                [ps_exe, "-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
                check=False,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if res.returncode == 0:
                return (res.stdout or "").strip()

    if sys.platform == "darwin" and shutil.which("osascript"):
        res = subprocess.run(
            [
                "osascript",
                "-e",
                'POSIX path of (choose folder with prompt "پوشهٔ ذخیره‌سازی Comic OCR Studio را انتخاب کنید:")',
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            check=False,
        )
        if res.returncode == 0:
            return (res.stdout or "").strip()
        return ""

    if sys.platform.startswith("linux") and (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        if shutil.which("zenity"):
            res = subprocess.run(
                ["zenity", "--file-selection", "--directory", "--title=انتخاب پوشهٔ ذخیره‌سازی", f"--filename={start_dir}/"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
                check=False,
            )
            return (res.stdout or "").strip() if res.returncode == 0 else ""
        if shutil.which("kdialog"):
            res = subprocess.run(
                ["kdialog", "--getexistingdirectory", start_dir],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
                check=False,
            )
            return (res.stdout or "").strip() if res.returncode == 0 else ""

    # Generic Tkinter fallback when display is available
    if os.name == "nt" or sys.platform == "darwin" or os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        try:
            if getattr(sys, "frozen", False):
                import tkinter as tk
                from tkinter import filedialog

                root = tk.Tk()
                try:
                    root.withdraw()
                    with contextlib.suppress(Exception):
                        root.attributes("-topmost", True)
                    picked = filedialog.askdirectory(initialdir=start_dir or "")
                    return str(picked or "").strip()
                finally:
                    with contextlib.suppress(Exception):
                        root.destroy()
            tk_code = (
                "import os, sys, tkinter as tk; from tkinter import filedialog; "
                "root = tk.Tk(); root.withdraw(); "
                "root.attributes('-topmost', True); "
                "p = filedialog.askdirectory(initialdir=os.environ.get('COMIC_PICK_INIT') or ''); "
                "sys.stdout.write(p or '')"
            )
            env = dict(os.environ)
            env["COMIC_PICK_INIT"] = start_dir
            res = subprocess.run(
                [sys.executable, "-c", tk_code],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
                check=False,
                env=env,
            )
            if res.returncode == 0:
                return (res.stdout or "").strip()
        except Exception:
            pass

    raise RuntimeError(
        "پنجرهٔ گرافیکی انتخاب پوشه در این محیط در دسترس نیست؛ لطفاً مسیر پوشه (مثلاً D:\\ComicOCRStudio) را مستقیماً در کادر بالا تایپ یا پیست کنید."
    )
