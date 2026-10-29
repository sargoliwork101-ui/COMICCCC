from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
STATIC_DIR = PACKAGE_DIR / "static"
ASSETS_DIR = PACKAGE_DIR / "assets"


def data_dir() -> Path:
    """Return the per-user writable directory; never write into the extension."""
    root = Path(os.environ.get("COMIC_STUDIO_DATA", Path.home() / ".comic-ocr-studio"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_root(project_id: str) -> Path:
    return data_dir() / "projects" / project_id


def models_dir() -> Path:
    path = data_dir() / "models"
    path.mkdir(parents=True, exist_ok=True)
    return path
