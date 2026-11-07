@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>nul
title Build Offline EXE ^& Setup - Comic OCR Studio 4.06

cd /d "%~dp0"
set "APP_DIR=%CD%"
set "VENV_PY=%APP_DIR%\.venv\Scripts\python.exe"
set "WHEELHOUSE_DIR=%APP_DIR%\wheelhouse"

echo ====================================================================
echo   Comic OCR Studio 4.06 - Offline Windows EXE ^& Setup Builder
echo ====================================================================
echo.

set "BUILD_MODE="
if /I "%~1"=="--base" set "BUILD_MODE=1"
if /I "%~1"=="--with-nmt" set "BUILD_MODE=2"
if /I "%~1"=="--full" set "BUILD_MODE=3"

if defined BUILD_MODE goto mode_selected

echo Select offline package variant to build:
echo   [1] Standard Offline Setup ^(App + Base RapidOCR models - compact ^& fast^)
echo   [2] Full Offline Setup     ^(App + Base RapidOCR + 600M Offline NLLB Translator^)
echo   [3] Full Offline Setup + Download wheelhouse\ for portable .bat installs
echo.
set /p "BUILD_MODE=Enter choice [1/2/3] (default 1): "
if not defined BUILD_MODE set "BUILD_MODE=1"

:mode_selected
if not exist "%VENV_PY%" (
  echo [1/3] Preparing Python virtual environment first...
  call "%APP_DIR%\start_windows.bat" --help >nul 2>nul
)

if not exist "%VENV_PY%" (
  echo [ERROR] Virtual environment was not found at "%VENV_PY%".
  echo Please run start_windows.bat once on a machine with Python or internet first.
  pause
  exit /b 1
)

echo [2/3] Ensuring PyInstaller is installed in .venv...
set "PIP_FIND_LINKS="
if exist "%WHEELHOUSE_DIR%\*.whl" set "PIP_FIND_LINKS=--find-links=%WHEELHOUSE_DIR%"
"%VENV_PY%" -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  "%VENV_PY%" -m pip install --disable-pip-version-check %PIP_FIND_LINKS% "pyinstaller>=6.10,<7"
  if errorlevel 1 (
    echo [ERROR] Could not install PyInstaller.
    pause
    exit /b 1
  )
)

set "EXTRA_FLAGS="
if "%BUILD_MODE%"=="2" set "EXTRA_FLAGS=--with-nmt"
if "%BUILD_MODE%"=="3" set "EXTRA_FLAGS=--with-nmt --download-wheelhouse"

echo [3/3] Building ComicOCRStudio.exe and 1-click Offline Windows Setup...
"%VENV_PY%" -m offline_packaging.build_offline_package %EXTRA_FLAGS%
if errorlevel 1 (
  echo.
  echo [ERROR] Offline build failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo ====================================================================
echo   BUILD COMPLETE!
echo   1-Click Standalone EXE : "%APP_DIR%\dist\ComicOCRStudio\ComicOCRStudio.exe"
echo   Offline Setup Installer: "%APP_DIR%\dist\ComicOCRStudio-Offline-Setup-4.06*.exe"
echo ====================================================================
pause
exit /b 0
