@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem Comic OCR Studio 4.20 - Windows setup and launcher.
rem Dependencies are installed in .venv during setup; later launches reuse that local environment.
rem Existing supported system Python installations are never modified or removed.

set "APP_DIR=%CD%"
set "VENV_DIR=%APP_DIR%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "READY=%VENV_DIR%\.comic-ocr-studio-4.20.ready"
set "OFFLINE_WHEELS=%APP_DIR%\wheelhouse"
set "OFFLINE_PYTHON_EXE=%APP_DIR%\offline_python\python-3.13.17-amd64.exe"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "PYTHONNOUSERSITE=1"
rem Detection must not cause the new Python Install Manager to auto-install runtimes.
set "PYTHON_MANAGER_AUTOMATIC_INSTALL=0"
set "PIP_RETRIES=1"
set "PIP_TIMEOUT=15"
set "COMIC_MANAGED_PYTHON=%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe"
set "SETUP_ONLY="
if /i "%~1"=="--setup-only" set "SETUP_ONLY=1"
if /i "%~1"=="--help" set "SETUP_ONLY=1"

rem Fast path: if a standalone packaged ComicOCRStudio.exe sits next to this launcher, run it directly.
if not defined SETUP_ONLY if exist "%APP_DIR%\ComicOCRStudio.exe" (
    start "" "%APP_DIR%\ComicOCRStudio.exe"
    exit /b 0
)

rem A broken or unsupported existing environment is preserved before rebuilding.
if not exist "%VENV_PYTHON%" goto prepare_python
"%VENV_PYTHON%" -c "import sys,struct; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) and struct.calcsize('P') == 8 else 1)" >nul 2>&1
if errorlevel 1 goto unsupported_venv
if not exist "%READY%" goto have_venv
"%VENV_PYTHON%" -c "import os,sys,importlib.util as u; s=u.find_spec('comic_studio'); sys.exit(1 if not s or not s.origin else (0 if os.path.normcase(os.path.realpath(sys.argv[1]))==os.path.normcase(os.path.realpath(os.path.dirname(os.path.dirname(s.origin)))) else 1))" "%APP_DIR%" >nul 2>&1
if errorlevel 1 call :repair_relocated_venv
echo [Comic OCR Studio] Using the installed packages in this folder's .venv.
goto run_app

:unsupported_venv
echo [Comic OCR Studio] The existing environment is broken or uses an unsupported Python.
echo [Comic OCR Studio] It will be kept as a .venv.previous-* folder, not deleted.

:prepare_python
call :find_python
if defined BOOTSTRAP_EXE goto create_venv
call :install_python
if errorlevel 1 goto no_python
call :find_python
if not defined BOOTSTRAP_EXE goto no_python

:create_venv
if not exist "%VENV_DIR%" goto make_venv
set "OLD_VENV=%APP_DIR%\.venv.previous-%RANDOM%-%RANDOM%"
if exist "%OLD_VENV%" goto failed_preserve
move "%VENV_DIR%" "%OLD_VENV%" >nul
if errorlevel 1 goto failed_preserve
echo [Comic OCR Studio] Previous environment saved at "%OLD_VENV%".

:make_venv
echo [Comic OCR Studio] Creating the isolated Python environment...
"%BOOTSTRAP_EXE%" %BOOTSTRAP_ARG% -m venv "%VENV_DIR%"
if errorlevel 1 goto failed

:have_venv
set "HAD_READY="
if exist "%VENV_DIR%\.comic-ocr-studio-*.ready" set "HAD_READY=1"
if defined HAD_READY (
    rem Fast version-bump check: if all required packages are already present, avoid slow network pip upgrades.
    call :fast_spec_check
    if not errorlevel 1 (
        call :repair_relocated_venv
        type nul > "%READY%"
        goto run_app
    )
)
rem Reaching here means either first-time setup or a new required package is missing: allow generous download timeouts.
set "PIP_RETRIES=5"
set "PIP_TIMEOUT=90"
"%VENV_PYTHON%" -m pip --version >nul 2>&1
if not errorlevel 1 goto update_tools
echo [Comic OCR Studio] Restoring pip using Python ensurepip...
"%VENV_PYTHON%" -m ensurepip --upgrade
if errorlevel 1 goto failed

:update_tools
set "PIP_FIND_LINKS="
if exist "%OFFLINE_WHEELS%\*.whl" set "PIP_FIND_LINKS=--find-links=%OFFLINE_WHEELS%"
if exist "%OFFLINE_WHEELS%\*.whl" (
    echo [Comic OCR Studio] Installing packages from local offline wheelhouse...
    "%VENV_PYTHON%" -m pip install --no-index --find-links="%OFFLINE_WHEELS%" ^
        "fastapi>=0.115,<1" "uvicorn>=0.30,<1" "python-multipart>=0.0.9,<1" "Pillow>=11,<13" ^
        "PyMuPDF>=1.24,<2" "numpy>=2,<3" "opencv-python-headless>=4.10,<5" "httpx>=0.27,<1" ^
        "ctranslate2>=4.0,<5" "sentencepiece>=0.2,<1" "rapidocr>=3.10,<3.11" "onnxruntime>=1.20,<2" "python-bidi>=0.4.2,<1" >nul 2>&1
    if not errorlevel 1 (
        call :repair_relocated_venv
        call :check_imports
        if not errorlevel 1 (
            type nul > "%READY%"
            goto run_app
        )
    )
)
echo [Comic OCR Studio] Checking pip and Python installation tools...
"%VENV_PYTHON%" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 echo [Comic OCR Studio] Could not update installation tools; continuing with the installed tools.

echo [Comic OCR Studio] Checking and updating required packages. This can take a few minutes...
rem Keep this list in sync with pyproject.toml and the [ocr] extra.
"%VENV_PYTHON%" -m pip install --upgrade ^
    "fastapi>=0.115,<1" ^
    "uvicorn>=0.30,<1" ^
    "python-multipart>=0.0.9,<1" ^
    "Pillow>=11,<13" ^
    "PyMuPDF>=1.24,<2" ^
    "numpy>=2,<3" ^
    "opencv-python-headless>=4.10,<5" ^
    "httpx>=0.27,<1" ^
    "ctranslate2>=4.0,<5" ^
    "sentencepiece>=0.2,<1" ^
    "rapidocr>=3.10,<3.11" ^
    "onnxruntime>=1.20,<2" ^
    "python-bidi>=0.4.2,<1"
if errorlevel 1 goto update_failed

rem Install the local application without resolving the dependency list twice.
"%VENV_PYTHON%" -m pip install -e "%APP_DIR%" --no-deps --no-build-isolation
if errorlevel 1 goto update_failed
rem Enable DirectX 12 GPU acceleration (DirectML) for ONNX Runtime when a hardware GPU is available.
"%VENV_PYTHON%" -c "import sys, onnxruntime as ort; from comic_studio.ocr_managed import inspect_hardware; hw = inspect_hardware(); sys.exit(0 if hw.get('hasGpu') and 'DmlExecutionProvider' not in ort.get_available_providers() and 'CUDAExecutionProvider' not in ort.get_available_providers() else 1)" >nul 2>&1
if not errorlevel 1 (
    echo [Comic OCR Studio] Hardware GPU detected; enabling DirectML GPU acceleration...
    "%VENV_PYTHON%" -m pip uninstall -y onnxruntime >nul 2>&1
    "%VENV_PYTHON%" -m pip install --upgrade "onnxruntime-directml>=1.20,<2" || "%VENV_PYTHON%" -m pip install --upgrade "onnxruntime>=1.20,<2"
)
"%VENV_PYTHON%" -m pip check
if errorlevel 1 goto failed
call :check_imports
if errorlevel 1 goto failed
type nul > "%READY%"
if errorlevel 1 goto failed
goto run_app

:update_failed
if not defined HAD_READY goto failed
echo.
echo [Comic OCR Studio] Update failed. Checking the previously installed environment...
"%VENV_PYTHON%" -m pip check
if errorlevel 1 goto failed
call :check_imports
if errorlevel 1 goto failed
echo [Comic OCR Studio] Existing packages are usable; starting without the update.
goto run_app

:run_app
set "PIP_RETRIES="
set "PIP_TIMEOUT="
if defined SETUP_ONLY (
    echo [Comic OCR Studio] Environment setup complete.
    exit /b 0
)
echo [Comic OCR Studio] Starting. Answer the browser and window questions below...
"%VENV_PYTHON%" "%APP_DIR%\run.py"
if errorlevel 1 goto failed
exit /b 0

:find_python
set "BOOTSTRAP_EXE="
set "BOOTSTRAP_ARG="
if exist "%COMIC_MANAGED_PYTHON%" call :try_python "%COMIC_MANAGED_PYTHON%"
if defined BOOTSTRAP_EXE exit /b 0
where py.exe >nul 2>&1
if errorlevel 1 goto find_path_python
for %%V in (3.13 3.12 3.11) do call :try_py_launcher %%V
if defined BOOTSTRAP_EXE exit /b 0
:find_path_python
for %%V in (313 312 311) do if exist "%LocalAppData%\Programs\Python\Python%%V\python.exe" call :try_python "%LocalAppData%\Programs\Python\Python%%V\python.exe"
if defined BOOTSTRAP_EXE exit /b 0
for /f "delims=" %%P in ('where python.exe 2^>nul') do call :try_python "%%P"
exit /b 0

:try_py_launcher
if defined BOOTSTRAP_EXE exit /b 0
py -%~1 -c "import sys,struct; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) and struct.calcsize('P') == 8 else 1)" >nul 2>&1
if errorlevel 1 exit /b 0
set "BOOTSTRAP_EXE=py"
set "BOOTSTRAP_ARG=-%~1"
exit /b 0

:try_python
if defined BOOTSTRAP_EXE exit /b 0
rem Do not invoke the Windows Store app-execution alias when Python is absent.
if /i "%~dp1"=="%LocalAppData%\Microsoft\WindowsApps\" exit /b 0
"%~1" -c "import sys,struct; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) and struct.calcsize('P') == 8 else 1)" >nul 2>&1
if errorlevel 1 exit /b 0
set "BOOTSTRAP_EXE=%~1"
set "BOOTSTRAP_ARG="
exit /b 0

:install_python
where powershell.exe >nul 2>&1
if errorlevel 1 exit /b 1
if not defined LocalAppData exit /b 1
if not defined TEMP exit /b 1
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 exit /b 1
echo [Comic OCR Studio] No compatible 64-bit Python was found.
set "COMIC_PY_INSTALLER=%TEMP%\ComicOCR-Python313-%RANDOM%-%RANDOM%.exe"
set "COMIC_PY_TARGET=%LocalAppData%\Programs\ComicOCRStudio\Python313"
if exist "%OFFLINE_PYTHON_EXE%" (
    echo [Comic OCR Studio] Found bundled offline Python 3.13.17 installer; verifying SHA-256...
    copy /y "%OFFLINE_PYTHON_EXE%" "%COMIC_PY_INSTALLER%" >nul
    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if ((Get-FileHash -Algorithm SHA256 -LiteralPath $env:COMIC_PY_INSTALLER).Hash -ne '5DA012101BA2E17113A9A1CD901E9CE1441086F2B7ECB5DE06EC94163899A190') { exit 1 }; exit 0"
    if not errorlevel 1 goto run_py_installer
    del /q "%COMIC_PY_INSTALLER%" >nul 2>&1
)
echo [Comic OCR Studio] Downloading the official Python 3.13.17 installer from python.org.
echo [Comic OCR Studio] It will be installed for this user without changing PATH.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.13.17/python-3.13.17-amd64.exe' -OutFile $env:COMIC_PY_INSTALLER; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $env:COMIC_PY_INSTALLER).Hash -ne '5DA012101BA2E17113A9A1CD901E9CE1441086F2B7ECB5DE06EC94163899A190') { throw 'Python installer checksum mismatch.' }; exit 0 } catch { Write-Error $_; exit 1 }"
if errorlevel 1 goto installer_failed
:run_py_installer
echo [Comic OCR Studio] Installing Python for this user...
start "" /wait "%COMIC_PY_INSTALLER%" /quiet InstallAllUsers=0 "TargetDir=%COMIC_PY_TARGET%" Include_launcher=0 Include_pip=1 Include_test=0 PrependPath=0 AppendPath=0 Shortcuts=0
set "INSTALL_RESULT=%ERRORLEVEL%"
del /q "%COMIC_PY_INSTALLER%" >nul 2>&1
if not "%INSTALL_RESULT%"=="0" (
    echo Python installer returned exit code %INSTALL_RESULT%.
    exit /b 1
)
exit /b 0

:installer_failed
if defined COMIC_PY_INSTALLER del /q "%COMIC_PY_INSTALLER%" >nul 2>&1
echo [Comic OCR Studio] Python download or checksum verification failed.
exit /b 1

:fast_spec_check
"%VENV_PYTHON%" -c "import sys,importlib.util as u; pkgs=('fastapi','uvicorn','multipart','PIL','fitz','numpy','cv2','httpx','ctranslate2','sentencepiece','rapidocr','onnxruntime','bidi'); sys.exit(0 if all(u.find_spec(m) is not None for m in pkgs) else 1)" >nul 2>&1
exit /b %ERRORLEVEL%

:check_imports
"%VENV_PYTHON%" -c "import fastapi,uvicorn,multipart,PIL,fitz,numpy,cv2,httpx,ctranslate2,sentencepiece,rapidocr,onnxruntime,bidi"
exit /b %ERRORLEVEL%

:repair_relocated_venv
echo [Comic OCR Studio] App folder location changed; updating local environment paths...
"%VENV_PYTHON%" -c "import os,site; sp=[p for p in site.getsitepackages() if os.path.isdir(p)][0]; app=os.environ['APP_DIR']; [os.remove(os.path.join(sp,f)) for f in os.listdir(sp) if f.startswith('__editable__') and 'comic_ocr_studio' in f and os.path.isfile(os.path.join(sp,f))]; open(os.path.join(sp,'comic_ocr_studio_local.pth'),'w',encoding='utf-8').write(app+'\n')" >nul 2>&1
"%VENV_PYTHON%" -m pip install -e "%APP_DIR%" --no-deps --no-build-isolation --no-index >nul 2>&1
exit /b 0

:failed_preserve
echo.
echo Could not preserve the old .venv. Close programs using it and retry. Nothing was deleted.
if not defined SETUP_ONLY pause
exit /b 1

:no_python
echo.
echo Python setup could not be completed. Check the internet connection and Windows permissions.
echo You can install 64-bit Python 3.11, 3.12 or 3.13 from https://www.python.org/downloads/ and retry.
echo The automatic installer requires PowerShell and a 64-bit supported Windows system.
if not defined SETUP_ONLY pause
exit /b 1

:failed
echo.
echo Setup or application failed. Read the error above, then try again.
echo Initial setup requires internet access. No project files were removed.
if not defined SETUP_ONLY pause
exit /b 1
