from pathlib import Path
import re
import tomllib


ROOT = Path(__file__).resolve().parents[1]
NORMAL = (ROOT / "start_windows.bat").read_text(encoding="utf-8")


def test_optional_admin_launcher_uses_uac_and_delegates_to_normal_setup():
    elevated = (ROOT / "start_windows_admin.bat").read_text(encoding="utf-8")
    assert "Start-Process" in elevated
    assert "-Verb RunAs" in elevated
    assert "-PassThru" in elevated
    assert "$child.ExitCode" in elevated
    assert "__ELEVATED__" in elevated
    assert "fltmc" in elevated
    assert 'call "%~dp0start_windows.bat"' in elevated
    assert "RunAs" not in NORMAL


def test_windows_requirements_match_runtime_and_default_ocr():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    dependencies = project["dependencies"] + project["optional-dependencies"]["ocr"]
    install = NORMAL.split('"%VENV_PYTHON%" -m pip install --upgrade ^', 1)[1].split('\nif errorlevel', 1)[0]
    requirements = re.findall(r'"([^"\n]+)"', install)
    assert sorted(requirements) == sorted(dependencies)
    assert any(item.lower().startswith("opencv-python-headless") for item in requirements)


def test_python_bootstrap_download_is_official_verified_and_isolated():
    assert "https://www.python.org/ftp/python/3.13.17/python-3.13.17-amd64.exe" in NORMAL
    # Hash published on the Python 3.13.17 release page for the x64 installer.
    assert "5DA012101BA2E17113A9A1CD901E9CE1441086F2B7ECB5DE06EC94163899A190" in NORMAL
    assert "Get-FileHash -Algorithm SHA256" in NORMAL
    assert NORMAL.index("Get-FileHash -Algorithm SHA256") < NORMAL.index('start "" /wait')
    assert "InstallAllUsers=0" in NORMAL
    assert "PrependPath=0" in NORMAL
    assert 'if not defined BOOTSTRAP_EXE goto no_python' in NORMAL
    assert "WindowsApps" in NORMAL  # Avoid triggering the Microsoft Store alias.
    assert "PYTHON_MANAGER_AUTOMATIC_INSTALL=0" in NORMAL


def test_launcher_recovers_pip_and_preserves_broken_environments():
    assert '"%VENV_PYTHON%" -m ensurepip --upgrade' in NORMAL
    assert '"%VENV_PYTHON%" -m pip install --upgrade pip setuptools wheel' in NORMAL
    assert 'move "%VENV_DIR%" "%OLD_VENV%"' in NORMAL
    assert '.venv.previous-' in NORMAL
    assert not re.search(r'(?im)^\s*(?:rmdir|rd)\s', NORMAL)
    assert NORMAL.index('call :find_python') < NORMAL.index('move "%VENV_DIR%"')
    assert 'if errorlevel 1 goto failed_preserve' in NORMAL


def test_offline_fallback_requires_prior_ready_and_healthy_packages():
    update_failed = NORMAL.split(':update_failed\n', 1)[1].split(':run_app\n', 1)[0]
    assert 'if not defined HAD_READY goto failed' in update_failed
    assert '"%VENV_PYTHON%" -m pip check' in update_failed
    assert 'call :check_imports' in update_failed
    assert update_failed.count('if errorlevel 1 goto failed') >= 2
    assert 'goto run_app' in update_failed
