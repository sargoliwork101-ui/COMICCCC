import importlib
import os
import subprocess
import sys
from pathlib import Path

# The app owns its dependencies in python_app/.venv. If a system Python launches
# this file, hand off to that local interpreter rather than using global packages.
_APP_DIR = Path(__file__).resolve().parent
_IS_FROZEN = bool(getattr(sys, "frozen", False))
_LOCAL_PYTHON = _APP_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
_IN_APP_VENV = Path(sys.prefix).resolve() == (_APP_DIR / ".venv").resolve()


def _ensure_frozen_stdio() -> None:
    """Ensure PyInstaller `--windowed` builds never crash when uvicorn/logging inspects stdio."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115


def _local_venv_python_usable(py_path: Path) -> bool:
    if not py_path.is_file():
        return False
    try:
        probe = subprocess.run(
            [str(py_path), "-c", "import sys; sys.exit(0)"],
            capture_output=True,
            timeout=15,
            check=False,
        )
        return probe.returncode == 0
    except OSError:
        return False


def _ensure_local_package_resolution() -> None:
    """Ensure moving `python_app` to another folder or drive always imports `comic_studio`
    from this folder rather than a stale editable `.pth` / `_EditableFinder` pointing to the old path."""
    app_str = str(_APP_DIR)
    if not sys.path or Path(sys.path[0]).resolve() != _APP_DIR:
        sys.path[:] = [app_str, *[p for p in sys.path if p != app_str]]

    expected_pkg = (_APP_DIR / "comic_studio").resolve()
    cleaned_meta = []
    removed_stale = False
    for finder in sys.meta_path:
        mapping = getattr(finder, "MAPPING", None)
        if isinstance(mapping, dict) and "comic_studio" in mapping:
            try:
                mapped = Path(str(mapping["comic_studio"])).resolve()
            except OSError:
                mapped = None
            if mapped != expected_pkg:
                removed_stale = True
                continue
        cleaned_meta.append(finder)
    if removed_stale:
        sys.meta_path[:] = cleaned_meta
        sys.modules.pop("comic_studio", None)
        importlib.invalidate_caches()


if __name__ == "__main__" and not _IS_FROZEN and not _IN_APP_VENV and _LOCAL_PYTHON.exists():
    if _local_venv_python_usable(_LOCAL_PYTHON):
        _HANDOFF_ARGV = [str(_LOCAL_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]]
        if os.name == "nt":
            raise SystemExit(subprocess.call(_HANDOFF_ARGV))
        os.execv(str(_LOCAL_PYTHON), _HANDOFF_ARGV)
    else:
        for marker in (_APP_DIR / ".venv").glob(".comic-ocr-studio-*.ready"):
            try:
                marker.unlink()
            except OSError:
                pass

# Keep dependency failures actionable when run.py is launched before the local venv exists.
_REQUIRED_IMPORTS = {
    "comic_studio", "fastapi", "uvicorn", "multipart", "PIL", "fitz", "numpy", "cv2", "httpx",
    "pydantic", "pydantic_core", "starlette", "rapidocr", "onnxruntime",
}

if __name__ == "__main__":
    _ensure_frozen_stdio()
    if not _IS_FROZEN:
        _ensure_local_package_resolution()
    try:
        from comic_studio.__main__ import main
        main()
    except ModuleNotFoundError as error:
        missing = (error.name or "").split(".", 1)[0]
        if missing not in _REQUIRED_IMPORTS:
            raise
        if _IN_APP_VENV:
            for marker in (_APP_DIR / ".venv").glob(".comic-ocr-studio-*.ready"):
                try:
                    marker.unlink()
                except OSError:
                    pass
        print(
            f"Comic OCR Studio dependency is missing: {error.name}.\n\n"
            "Recommended on Windows: run start_windows.bat from the python_app folder.\n"
            "It installs dependencies into the app's local .venv; normal later launches reuse it.\n\n"
            "Manual setup from python_app (PowerShell):\n"
            "  py -3.12 -m venv .venv\n"
            "  .\\.venv\\Scripts\\python.exe -m pip install -e '.[ocr]'\n"
            "  .\\.venv\\Scripts\\python.exe run.py",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
