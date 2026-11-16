from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from comic_studio import APP_NAME
from comic_studio.backup import FORMAT as PROJECT_FORMAT
from comic_studio.license_guard import _SIGNING_DOMAIN
from comic_studio.main import create_app
from support_client import scoped_client

ROOT = Path(__file__).resolve().parents[2]
PYTHON_APP = ROOT / "python_app"


@pytest.fixture
def brand_client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    with scoped_client(create_app()) as client:
        yield client


def test_runtime_and_browser_shell_use_hasaya_brand(brand_client):
    assert APP_NAME == "HaSaYa Studio"
    health = brand_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["name"] == "HaSaYa Studio"
    openapi = brand_client.get("/openapi.json")
    assert openapi.status_code == 200
    assert openapi.json()["info"]["title"] == "HaSaYa Studio"

    page = brand_client.get("/")
    assert page.status_code == 200
    assert "<title>HaSaYa Studio</title>" in page.text
    assert "<h1>HaSaYa Studio " in page.text
    assert "Comic OCR Studio" not in page.text


def test_http_auth_prompt_uses_the_new_application_name(tmp_path, monkeypatch):
    monkeypatch.setenv("COMIC_STUDIO_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("COMIC_STUDIO_ACCESS_PASSWORD", "test-password-that-is-long-enough")
    with scoped_client(create_app()) as client:
        response = client.get("/")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == 'Basic realm="HaSaYa Studio", charset="UTF-8"'


def test_launcher_and_installer_artifacts_use_hasaya_names():
    launcher = (PYTHON_APP / "start_windows.bat").read_text(encoding="utf-8")
    build_bat = (PYTHON_APP / "build_windows_offline.bat").read_text(encoding="utf-8")
    builder = (PYTHON_APP / "offline_packaging" / "build_offline_package.py").read_text(encoding="utf-8")
    installer = (PYTHON_APP / "offline_packaging" / "ComicOCRStudio.iss").read_text(encoding="utf-8")

    assert "HaSaYaStudio.exe" in launcher
    assert "HaSaYaStudio-Offline-Setup-%APP_VERSION%" in build_bat
    assert "HaSaYaStudio.exe" in builder
    assert "HaSaYaStudio-Offline-Setup-{APP_VERSION}" in builder
    import sys

    if str(PYTHON_APP) not in sys.path:
        sys.path.insert(0, str(PYTHON_APP))
    from offline_packaging.build_offline_package import pyinstaller_command

    command = pyinstaller_command(
        entry_script=PYTHON_APP / "run.py",
        dist_dir=PYTHON_APP / "dist",
        work_dir=PYTHON_APP / "build" / "branding-test",
        spec_dir=PYTHON_APP / "build" / "branding-test",
        icon_path=PYTHON_APP / "build" / "HaSaYaStudio.ico",
        static_dir=PYTHON_APP / "comic_studio" / "static",
        staged_models_dir=PYTHON_APP / "build" / "branding-test" / "models",
    )
    assert command[command.index("--name") + 1] == "HaSaYaStudio"
    assert "AppName=HaSaYa Studio" in installer
    assert "DefaultGroupName=HaSaYa Studio" in installer
    assert "Comic OCR Studio" not in launcher + build_bat + builder + installer

    seller_manager = (PYTHON_APP / "license_tool" / "manager.py").read_text(encoding="utf-8")
    seller_launcher = (PYTHON_APP / "license_tool" / "start_license_manager.bat").read_text(encoding="utf-8")
    assert "HaSaYa Studio" in seller_manager + seller_launcher
    assert "Comic OCR Studio" not in seller_manager + seller_launcher
    assert "HaSaYaStudio-Customers-" in seller_manager


def test_readme_and_in_app_guide_use_the_selected_brand():
    readme = (PYTHON_APP / "README.md").read_text(encoding="utf-8")
    root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    guide = (PYTHON_APP / "comic_studio" / "static" / "help-guide.js").read_text(encoding="utf-8")

    assert "HaSaYa Studio" in readme
    assert "HaSaYa Studio" in root_readme
    assert "HaSaYa Studio" in guide
    assert "Comic OCR Studio" not in readme
    assert "Comic OCR Studio" not in root_readme
    assert "Comic OCR Studio" not in guide


def test_python_application_sources_no_longer_show_the_old_brand():
    source_extensions = {".py", ".js", ".html", ".css"}
    source_files = [
        path
        for path in (PYTHON_APP / "comic_studio").rglob("*")
        if path.is_file() and path.suffix in source_extensions
    ]
    leftovers = [str(path.relative_to(ROOT)) for path in source_files if "Comic OCR Studio" in path.read_text(encoding="utf-8")]
    assert leftovers == []


def test_cli_gets_new_command_while_legacy_command_remains_available():
    import tomllib

    project = tomllib.loads((PYTHON_APP / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert project["scripts"]["hasaya-studio"] == "comic_studio.__main__:main"
    assert project["scripts"]["comic-ocr-studio"] == "comic_studio.__main__:main"


def test_rename_keeps_existing_project_and_license_signing_identifiers():
    # These values are formats/cryptographic domains, not user-facing branding.
    # Keeping them avoids breaking existing project archives and issued licenses.
    assert PROJECT_FORMAT == "comic-ocr-studio-project"
    assert _SIGNING_DOMAIN == b"ComicOCRStudio-License-v1:"
