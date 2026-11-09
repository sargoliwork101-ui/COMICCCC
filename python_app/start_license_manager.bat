@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

title Comic OCR Studio 4.29 - Seller License Generator

rem Seller-only launcher (never shipped inside customer dist\ComicOCRStudio builds).
set "PYTHON_MANAGER_AUTOMATIC_INSTALL=0"
set "PYTHON_EXE="
set "PYTHON_ARG="

if exist "%CD%\.venv\Scripts\python.exe" (
    "%CD%\.venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
    if not errorlevel 1 set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"
)
if not defined PYTHON_EXE if exist "%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe" (
    "%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
    if not errorlevel 1 set "PYTHON_EXE=%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe"
)
if not defined PYTHON_EXE (
    for %%V in (3.13 3.12 3.11) do (
        if not defined PYTHON_EXE (
            py -%%V -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
            if not errorlevel 1 (
                set "PYTHON_EXE=py"
                set "PYTHON_ARG=-%%V"
            )
        )
    )
)
if not defined PYTHON_EXE (
    for /f "delims=" %%P in ('where python 2^>nul') do (
        if not defined PYTHON_EXE (
            echo %%P | findstr /i /c:"\WindowsApps\" >nul
            if errorlevel 1 (
                "%%~P" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
                if not errorlevel 1 set "PYTHON_EXE=%%~P"
            )
        )
    )
)

if not defined PYTHON_EXE (
    echo [Error] Python 3.11+ was not found. Run start_windows.bat --setup-only first or install Python.
    pause
    exit /b 1
)

"%PYTHON_EXE%" %PYTHON_ARG% "%CD%\license_manager.py" %*
if errorlevel 1 pause
