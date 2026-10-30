from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_optional_admin_launcher_uses_uac_and_delegates_to_normal_setup():
    elevated = (ROOT / "start_windows_admin.bat").read_text(encoding="utf-8")
    normal = (ROOT / "start_windows.bat").read_text(encoding="utf-8")
    assert "Start-Process" in elevated
    assert "-Verb RunAs" in elevated
    assert "__ELEVATED__" in elevated
    assert "fltmc" in elevated
    assert 'call "%~dp0start_windows.bat"' in elevated
    assert "RunAs" not in normal


def test_ocr_preprocessing_dependency_is_in_both_install_paths():
    import tomllib

    dependencies = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["dependencies"]
    normal = (ROOT / "start_windows.bat").read_text(encoding="utf-8")
    assert any(item.lower().startswith("opencv-python-headless") and "extra" not in item for item in dependencies)
    assert '"opencv-python-headless>=4.10,<5"' in normal
