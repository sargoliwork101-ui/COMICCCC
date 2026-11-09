from pathlib import Path
import re
import tomllib
from types import SimpleNamespace

import pytest


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


def test_v405_launcher_fast_path_wheelhouse_and_offline_packaging(tmp_path):
    import sys
    import zipfile
    from PIL import Image
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from offline_packaging.build_offline_package import (
        SFX_MAGIC,
        append_sfx_zip_payload,
        generate_windows_ico,
        pyinstaller_command,
        read_sfx_trailer,
        zip_directory,
    )

    assert 'ComicOCRStudio.exe' in NORMAL
    assert ':fast_spec_check' in NORMAL
    assert 'wheelhouse' in NORMAL.lower()
    assert 'ctranslate2' in NORMAL and 'sentencepiece' in NORMAL

    offline_bat = (ROOT / "build_windows_offline.bat").read_text(encoding="utf-8")
    assert "offline_packaging.build_offline_package" in offline_bat
    assert "--with-nmt" in offline_bat
    assert "ComicOCRStudio-Offline-Setup-%APP_VERSION%" in offline_bat
    assert 'set "APP_VERSION=4.34"' in offline_bat
    assert "DisableDelayedExpansion" in offline_bat
    assert '--find-links="%WHEELHOUSE_DIR%"' in offline_bat
    assert 'start_windows.bat" --setup-only' in offline_bat
    assert '"%~1"=="--setup-only"' in NORMAL
    assert 'if defined SETUP_ONLY' in NORMAL

    seller_bat = (ROOT / "start_license_manager.bat").read_text(encoding="utf-8")
    assert '"%PYTHON_EXE%" %PYTHON_ARG% "%CD%\\license_manager.py" %*' in seller_bat
    assert "\\WindowsApps\\" in seller_bat

    iss_text = (ROOT / "offline_packaging" / "ComicOCRStudio.iss").read_text(encoding="utf-8")
    assert "PrivilegesRequired=lowest" in iss_text
    assert "ComicOCRStudio.exe" in iss_text

    # Verify multi-resolution .ico generation from static/assets/icon128.png
    ico_out = generate_windows_ico(
        ROOT / "comic_studio" / "static" / "assets" / "icon128.png",
        tmp_path / "ComicOCRStudio.ico",
    )
    assert ico_out.is_file() and ico_out.stat().st_size > 1000
    with Image.open(ico_out) as ico_img:
        assert ico_img.format == "ICO"

    # Verify PyInstaller command includes bundled_models when staged models exist
    staged = tmp_path / "bundled_models"
    (staged / "rapidocr").mkdir(parents=True)
    (staged / "rapidocr" / "dummy.onnx").write_bytes(b"onnx")
    cmd = pyinstaller_command(
        entry_script=ROOT / "run.py",
        dist_dir=tmp_path / "dist",
        work_dir=tmp_path / "work",
        spec_dir=tmp_path,
        icon_path=ico_out,
        static_dir=ROOT / "comic_studio" / "static",
        staged_models_dir=staged,
    )
    joined = " ".join(cmd)
    assert "--onedir" in cmd and "--windowed" in cmd
    assert "--optimize" in cmd and "license_manager" in cmd
    assert "bundled_models" in joined
    assert "ctranslate2" in joined and "sentencepiece" in joined
    assert "cv2" in cmd

    # Verify SFX self-extracting installer binary layout & trailer validation
    sample_app = tmp_path / "app_dir"
    sample_app.mkdir()
    (sample_app / "ComicOCRStudio.exe").write_bytes(b"MZ-MOCK-EXE")
    (sample_app / "README-OFFLINE-FA.txt").write_text("سلام", encoding="utf-8")
    payload_zip = zip_directory(sample_app, tmp_path / "payload.zip")
    stub_exe = tmp_path / "stub.exe"
    stub_exe.write_bytes(b"MZ-STUB-INSTALLER-HEADER" * 8)
    setup_exe = append_sfx_zip_payload(stub_exe, payload_zip, tmp_path / "Setup.exe")
    offset, length = read_sfx_trailer(setup_exe)
    assert offset == stub_exe.stat().st_size
    assert length == payload_zip.stat().st_size
    raw = setup_exe.read_bytes()
    assert raw[-8:] == SFX_MAGIC
    import io
    with zipfile.ZipFile(io.BytesIO(raw[offset : offset + length])) as zf:
        assert "ComicOCRStudio.exe" in zf.namelist()
        assert "README-OFFLINE-FA.txt" in zf.namelist()





def test_v427_offline_builder_survives_slow_pypi_and_can_write_the_exe_to_another_folder(tmp_path):
    """v4.29: the EXE builder must not die on a slow pypi.org and must honour a custom output folder."""
    import sys
    from pathlib import Path
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from offline_packaging import build_offline_package as pkg

    # 1. The PyInstaller bootstrap uses a long timeout + the public PyPI mirrors.
    source = (ROOT / "offline_packaging" / "build_offline_package.py").read_text(encoding="utf-8")
    assert "PIP_TIMEOUT_SECONDS = 120" in source
    assert "PIP_RETRIES = 10" in source
    assert "mirrors.aliyun.com/pypi/simple/" in source
    assert "pypi.tuna.tsinghua.edu.cn/simple" in source
    assert "def ensure_pyinstaller(" in source
    assert callable(pkg.ensure_pyinstaller)

    # 2. An already installed PyInstaller short-circuits the whole network dance.
    calls: list[list[str]] = []

    def fake_run(cmd, *args, **kwargs):
        calls.append(list(cmd))
        return SimpleNamespace(returncode=0)

    original_run = pkg.subprocess.run
    pkg.subprocess.run = fake_run
    try:
        assert pkg.ensure_pyinstaller(sys.executable) is True
    finally:
        pkg.subprocess.run = original_run
    assert calls == [] or all("pip" not in " ".join(call) for call in calls)
    assert not any("install" in " ".join(call) for call in calls)

    # 3. The builder accepts a custom output folder and a custom build folder.
    parser_flags = source.split("parser.add_argument(", 1)
    assert any("--output-dir" in chunk for chunk in parser_flags)
    assert any("--build-dir" in chunk for chunk in parser_flags)
    assert "--ensure-pyinstaller" in source
    assert 'dist_root = Path(args.output_dir).expanduser().resolve() if args.output_dir else REPO_PY_ROOT / "dist"' in source

    # 4. The .bat asks for the output folder and keeps the mirror failover.
    offline_bat = (ROOT / "build_windows_offline.bat").read_text(encoding="utf-8")
    assert "--output-dir" in offline_bat
    assert "--ensure-pyinstaller" in offline_bat
    assert "mirrors.aliyun.com/pypi/simple/" in offline_bat
    assert "pypi.tuna.tsinghua.edu.cn/simple" in offline_bat
    assert "--timeout 120 --retries 10" in offline_bat
    assert "OUT_DIR" in offline_bat


# ---------------------------------------------------------------------------
# v4.33 - the offline builder must never show a raw Python traceback
# ---------------------------------------------------------------------------


def _builder_module():
    import sys
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    import offline_packaging.build_offline_package as builder

    return builder


def test_v433_the_offline_builder_never_shows_a_python_traceback(tmp_path, monkeypatch, capsys):
    """v4.33: a failing build must print a clear message, not a Python stack trace."""
    builder = _builder_module()

    monkeypatch.setattr(builder, "ensure_pyinstaller", lambda *a, **k: False)
    code = builder.main(["--output-dir", str(tmp_path / "dist"), "--build-dir", str(tmp_path / "build")])
    out = capsys.readouterr().out
    assert code == 1
    assert "Traceback" not in out
    assert "[ERROR]" in out
    assert "PyInstaller" in out


def test_v433_the_offline_builder_checks_the_ocr_models_before_shipping(tmp_path):
    """v4.33: a bundle without the OCR models must stop the build (it would not read text)."""
    builder = _builder_module()

    staging = tmp_path / "bundled_models"
    (staging / "rapidocr").mkdir(parents=True)
    with pytest.raises(builder.BuildError) as excinfo:
        builder.verify_bundled_ocr_models(staging)
    assert "OCR models" in str(excinfo.value)

    for name in (
        "ch_PP-OCRv5_det_mobile.onnx",
        "latin_PP-OCRv5_rec_mobile.onnx",
        "arabic_PP-OCRv5_rec_mobile.onnx",
    ):
        (staging / "rapidocr" / name).write_bytes(b"onnx")
    builder.verify_bundled_ocr_models(staging)


def test_v433_the_offline_builder_checks_the_built_app_before_packaging(tmp_path):
    """v4.33: the built app folder must contain the exe, the program files and the models."""
    builder = _builder_module()

    app_dir = tmp_path / "ComicOCRStudio"
    with pytest.raises(builder.BuildError) as excinfo:
        builder.verify_built_app(app_dir)
    assert "not usable" in str(excinfo.value)

    (app_dir / "_internal" / "comic_studio" / "static").mkdir(parents=True)
    (app_dir / "_internal" / "comic_studio" / "static" / "index.html").write_text("<html></html>", encoding="utf-8")
    (app_dir / "ComicOCRStudio.exe").write_bytes(b"MZ")
    (app_dir / "_internal" / "bundled_models" / "rapidocr").mkdir(parents=True)
    (app_dir / "_internal" / "bundled_models" / "rapidocr" / "det.onnx").write_bytes(b"onnx")
    builder.verify_built_app(app_dir)


def test_v433_the_offline_builder_self_test_runs_without_breaking(tmp_path, monkeypatch, capsys):
    """v4.33: the new --preflight self-test answers every question before the long build."""
    builder = _builder_module()

    monkeypatch.setattr(builder, "_pyinstaller_installed", lambda *a, **k: True)
    code = builder.run_preflight()
    out = capsys.readouterr().out
    assert code in (0, 1)
    assert "Traceback" not in out
    assert "بررسی آمادگی ساخت بستهٔ آفلاین" in out
    assert "PyInstaller" in out


def test_v433_the_offline_builder_only_collects_installed_packages(tmp_path):
    """v4.33: `--collect-all <missing package>` used to abort the whole PyInstaller build."""
    builder = _builder_module()

    staged = tmp_path / "bundled_models"
    staged.mkdir(parents=True)
    cmd = builder.pyinstaller_command(
        entry_script=ROOT / "run.py",
        dist_dir=tmp_path / "dist",
        work_dir=tmp_path / "work",
        spec_dir=tmp_path,
        icon_path=tmp_path / "icon.ico",
        static_dir=ROOT / "comic_studio" / "static",
        staged_models_dir=staged,
    )
    import importlib.util

    for pkg in ("rapidocr", "onnxruntime", "ctranslate2", "sentencepiece", "pymupdf", "bidi"):
        if importlib.util.find_spec(pkg) is None:
            assert pkg not in cmd, f"{pkg} is not installed and must not be collected"


def test_v434_the_readiness_checklist_never_contradicts_its_own_marks(tmp_path, monkeypatch, capsys):
    """v4.34: a ready machine must not be reported as 'not ready' (the wording was inverted)."""
    builder = _builder_module()

    monkeypatch.setattr(builder, "_pyinstaller_installed", lambda *a, **k: True)
    monkeypatch.setattr(builder, "find_iscc", lambda: Path("C:/Program Files (x86)/Inno Setup 6/ISCC.exe"))
    monkeypatch.setattr(builder, "find_dotnet_csc", lambda: None)

    # A seller machine where everything is in place.
    models = tmp_path / "models"
    (models / "rapidocr").mkdir(parents=True)
    (models / "rapidocr" / "ch_PP-OCRv5_det_mobile.onnx").write_bytes(b"onnx")
    (models / "tesseract").mkdir(parents=True)
    for lang in ("eng", "fas"):
        (models / "tesseract" / f"{lang}.traineddata").write_bytes(b"x" * 3_400_000)
    monkeypatch.setattr(builder, "models_dir", lambda: models)

    import license_manager

    class _ReadyVault:
        def key_status(self):
            return {
                "vaultPublicKey": "a" * 64,
                "embeddedPublicKey": "a" * 64,
                "backupExists": True,
                "masterKeyPath": str(tmp_path / "seller_master_key.json"),
                "backupPath": str(tmp_path / "backup" / "seller_master_key.json"),
            }

    monkeypatch.setattr(license_manager, "SellerVault", _ReadyVault)

    code = builder.run_preflight()
    out = capsys.readouterr().out
    assert code == 0, out
    assert "Traceback" not in out
    assert "مورد آماده نیست" not in out
    assert "همه‌چیز آماده است" in out
    # Every checklist line states the real state, never a sentence that contradicts its mark.
    assert "PyInstaller (the packer that makes the .exe) - installed" in out
    assert "[warn]" not in out
    assert "OCR models (RapidOCR) - found in" in out
    assert "Backup copy of the seller master key - found in" in out
