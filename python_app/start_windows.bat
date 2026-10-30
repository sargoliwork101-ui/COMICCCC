@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

rem Comic OCR Studio 3.27 - one-click Windows setup and launcher.
rem The first run installs the packages below into an isolated .venv.
rem To force a reinstall, delete .venv\.comic-ocr-studio-3.27.ready and run again.

set "APP_DIR=%CD%"
set "VENV_DIR=%APP_DIR%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "READY=%VENV_DIR%\.comic-ocr-studio-3.27.ready"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"

if exist "%VENV_PYTHON%" goto have_venv

set "BOOTSTRAP="
where py >nul 2>&1
if not errorlevel 1 set "BOOTSTRAP=py"
if not defined BOOTSTRAP (
    where python >nul 2>&1
    if not errorlevel 1 set "BOOTSTRAP=python"
)
rem Also cover the standard python.org installation path when PATH is not set.
if not defined BOOTSTRAP if exist "%LocalAppData%\Programs\Python\Python313\python.exe" set "BOOTSTRAP=local313"
if not defined BOOTSTRAP goto no_python

echo [Comic OCR Studio] Creating the isolated Python environment...
if "%BOOTSTRAP%"=="py" (
    py -3 -m venv "%VENV_DIR%"
) else if "%BOOTSTRAP%"=="python" (
    python -m venv "%VENV_DIR%"
) else (
    "%LocalAppData%\Programs\Python\Python313\python.exe" -m venv "%VENV_DIR%"
)
if errorlevel 1 goto failed

:have_venv
"%VENV_PYTHON%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if errorlevel 1 goto old_python

if exist "%READY%" goto run_app
echo [Comic OCR Studio] Installing requirements. This may take a few minutes...
"%VENV_PYTHON%" -m pip install --upgrade pip
if errorlevel 1 goto failed

rem Runtime requirements are intentionally listed here so this file is self-contained.
"%VENV_PYTHON%" -m pip install ^
    "fastapi>=0.115,<1" ^
    "uvicorn>=0.30,<1" ^
    "python-multipart>=0.0.9,<1" ^
    "Pillow>=11,<13" ^
    "PyMuPDF>=1.24,<2" ^
    "numpy>=2,<3" ^
    "httpx>=0.27,<1" ^
    "rapidocr>=3.10,<3.11" ^
    "onnxruntime>=1.20,<2"
if errorlevel 1 goto failed

rem Install the local application without asking pip to resolve the list twice.
"%VENV_PYTHON%" -m pip install -e "%APP_DIR%" --no-deps
if errorlevel 1 goto failed
type nul > "%READY%"
if errorlevel 1 goto failed

:run_app
echo [Comic OCR Studio] Starting. Answer the browser and window questions below...
"%VENV_PYTHON%" "%APP_DIR%\run.py"
if errorlevel 1 goto failed
goto finished

:no_python
echo.
echo Python 3.11 or newer was not found.
echo Install Python from https://www.python.org/downloads/ and enable "Add Python to PATH".
pause
exit /b 1

:old_python
echo.
echo The Python inside .venv is older than 3.11.
echo Delete the .venv folder and run this file again with Python 3.11 or newer.
pause
exit /b 1

:failed
echo.
echo Setup or application failed. Read the error above, then try again.
pause
exit /b 1

:finished
endlocal
