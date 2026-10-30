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
