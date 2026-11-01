import os
import sys
from pathlib import Path

# The app owns its dependencies in python_app/.venv. If a system Python launches
# this file, hand off to that local interpreter rather than using global packages.
_APP_DIR = Path(__file__).resolve().parent
_LOCAL_PYTHON = _APP_DIR / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
_IN_APP_VENV = Path(sys.prefix).resolve() == (_APP_DIR / ".venv").resolve()

if __name__ == "__main__" and not _IN_APP_VENV and _LOCAL_PYTHON.is_file():
    os.execv(str(_LOCAL_PYTHON), [str(_LOCAL_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]])

# Keep dependency failures actionable when run.py is launched before the local venv exists.
_REQUIRED_IMPORTS = {
    "fastapi", "uvicorn", "multipart", "PIL", "fitz", "numpy", "cv2", "httpx",
    "pydantic", "pydantic_core", "starlette", "rapidocr", "onnxruntime",
}

if __name__ == "__main__":
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
