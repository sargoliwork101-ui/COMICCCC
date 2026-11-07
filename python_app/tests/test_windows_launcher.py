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


def test_existing_venv_and_bootstrap_enforce_matching_python_311_to_313_bounds():
    venv_check = NORMAL.split('if not exist "%VENV_PYTHON%" goto prepare_python\n', 1)[1].split('\nif errorlevel 1 goto unsupported_venv', 1)[0]
    assert "(3,11) <= sys.version_info[:2] < (3,14)" in venv_check
    assert "struct.calcsize('P') == 8" in venv_check
    assert NORMAL.count("(3,11) <= sys.version_info[:2] < (3,14)") >= 2


def test_windows_launcher_clears_pip_timeout_before_starting_server():
    run_app_section = NORMAL.split(":run_app\n", 1)[1].split("\n:find_python", 1)[0]
    assert 'set "PIP_RETRIES="' in run_app_section
    assert 'set "PIP_TIMEOUT="' in run_app_section
    assert run_app_section.index('set "PIP_TIMEOUT="') < run_app_section.index('"%VENV_PYTHON%" "%APP_DIR%\\run.py"')


def test_windows_launcher_repairs_relocated_app_folder_offline_without_deleting_venv(tmp_path, monkeypatch):
    import os
    import site

    assert "call :repair_relocated_venv" in NORMAL
    repair_section = NORMAL.split("\n:repair_relocated_venv\n", 1)[1].split("\nexit /b 0", 1)[0]
    assert "comic_ocr_studio_local.pth" in repair_section
    assert '"%VENV_PYTHON%" -m pip install -e "%APP_DIR%" --no-deps --no-build-isolation --no-index' in repair_section
    assert not re.search(r'(?im)^\s*(?:rmdir|rd)\s', NORMAL)

    # Execute the stdlib relocation snippet against a simulated site-packages with stale Drive-C editable hooks
    fake_sp = tmp_path / "site-packages"
    fake_sp.mkdir()
    stale_pth = fake_sp / "__editable__.comic_ocr_studio-3.0.99.pth"
    stale_finder = fake_sp / "__editable___comic_ocr_studio_3_0_99_finder.py"
    stale_pth.write_text("import __editable___comic_ocr_studio_3_0_99_finder", encoding="utf-8")
    stale_finder.write_text("MAPPING = {'comic_studio': 'C:/OldPath/python_app/comic_studio'}", encoding="utf-8")
    moved_app = str(tmp_path / "DriveD" / "python_app")

    monkeypatch.setattr(site, "getsitepackages", lambda: [str(fake_sp)])
    monkeypatch.setenv("APP_DIR", moved_app)
    snippet = repair_section.split('"%VENV_PYTHON%" -c "', 1)[1].split('" >nul', 1)[0]
    exec(snippet, {})

    assert not stale_pth.exists()
    assert not stale_finder.exists()
    assert (fake_sp / "comic_ocr_studio_local.pth").read_text(encoding="utf-8").strip() == moved_app


