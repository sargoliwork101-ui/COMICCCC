@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem Comic OCR Studio 3.43 - Windows setup and launcher.
rem Required packages and pip are checked/updated in the isolated .venv on each run.
rem Existing supported system Python installations are never modified or removed.

set "APP_DIR=%CD%"
set "VENV_DIR=%APP_DIR%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "READY=%VENV_DIR%\.comic-ocr-studio-3.43.ready"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"
set "PYTHONNOUSERSITE=1"
rem Detection must not cause the new Python Install Manager to auto-install runtimes.
set "PYTHON_MANAGER_AUTOMATIC_INSTALL=0"
set "PIP_RETRIES=1"
set "PIP_TIMEOUT=15"
set "COMIC_MANAGED_PYTHON=%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe"

rem A broken or unsupported existing environment is preserved before rebuilding.
if not exist "%VENV_PYTHON%" goto prepare_python
"%VENV_PYTHON%" -c "import sys,struct; sys.exit(0 if sys.version_info >= (3,11) and struct.calcsize('P') == 8 else 1)" >nul 2>&1
if not errorlevel 1 goto have_venv
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
"%VENV_PYTHON%" -m pip --version >nul 2>&1
if not errorlevel 1 goto update_tools
echo [Comic OCR Studio] Restoring pip using Python ensurepip...
"%VENV_PYTHON%" -m ensurepip --upgrade
if errorlevel 1 goto failed

:update_tools
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
    "rapidocr>=3.10,<3.11" ^
    "onnxruntime>=1.20,<2"
if errorlevel 1 goto update_failed

rem Install the local application without resolving the dependency list twice.
"%VENV_PYTHON%" -m pip install -e "%APP_DIR%" --no-deps --no-build-isolation
if errorlevel 1 goto update_failed
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
echo [Comic OCR Studio] Downloading the official Python 3.13.17 installer from python.org.
echo [Comic OCR Studio] It will be installed for this user without changing PATH.
set "COMIC_PY_INSTALLER=%TEMP%\ComicOCR-Python313-%RANDOM%-%RANDOM%.exe"
set "COMIC_PY_TARGET=%LocalAppData%\Programs\ComicOCRStudio\Python313"
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.13.17/python-3.13.17-amd64.exe' -OutFile $env:COMIC_PY_INSTALLER; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $env:COMIC_PY_INSTALLER).Hash -ne '5DA012101BA2E17113A9A1CD901E9CE1441086F2B7ECB5DE06EC94163899A190') { throw 'Python installer checksum mismatch.' }; exit 0 } catch { Write-Error $_; exit 1 }"
if errorlevel 1 goto installer_failed
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

:check_imports
"%VENV_PYTHON%" -c "import fastapi,uvicorn,multipart,PIL,fitz,numpy,cv2,httpx,rapidocr,onnxruntime"
exit /b %ERRORLEVEL%

:failed_preserve
echo.
echo Could not preserve the old .venv. Close programs using it and retry. Nothing was deleted.
pause
exit /b 1

:no_python
echo.
echo Python setup could not be completed. Check the internet connection and Windows permissions.
echo You can install 64-bit Python 3.11, 3.12 or 3.13 from https://www.python.org/downloads/ and retry.
echo The automatic installer requires PowerShell and a 64-bit supported Windows system.
pause
exit /b 1

:failed
echo.
echo Setup or application failed. Read the error above, then try again.
echo Initial setup requires internet access. No project files were removed.
pause
exit /b 1
