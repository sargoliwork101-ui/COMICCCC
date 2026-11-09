@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>nul
title Build Offline EXE ^& Setup - Comic OCR Studio 4.31

cd /d "%~dp0"
set "APP_DIR=%CD%"
set "VENV_PY=%APP_DIR%\.venv\Scripts\python.exe"
set "WHEELHOUSE_DIR=%APP_DIR%\wheelhouse"
set "DEFAULT_OUT_DIR=%APP_DIR%\dist"

echo ====================================================================
echo   Comic OCR Studio 4.31 - Offline Windows EXE ^& Setup Builder
echo ====================================================================
echo.

set "BUILD_MODE="
if /I "%~1"=="--base" set "BUILD_MODE=1"
if /I "%~1"=="--with-nmt" set "BUILD_MODE=2"
if /I "%~1"=="--full" set "BUILD_MODE=3"
set "OUT_DIR=%~2"

if defined BUILD_MODE goto mode_selected

echo Select offline package variant to build:
echo   [1] Standard Offline Setup ^(App + Base RapidOCR models - compact ^& fast^)
echo   [2] Full Offline Setup     ^(App + Base RapidOCR + 600M Offline NLLB Translator^)
echo   [3] Full Offline Setup + Download wheelhouse\ for portable .bat installs
echo.
set /p "BUILD_MODE=Enter choice [1/2/3] (default 1): "
if not defined BUILD_MODE set "BUILD_MODE=1"

:mode_selected
if defined OUT_DIR goto output_selected
echo.
echo Folder that receives the built EXE files:
echo   Standalone app : ^<output folder^>\ComicOCRStudio\ComicOCRStudio.exe
echo   Offline Setup  : ^<output folder^>\ComicOCRStudio-Offline-Setup-4.31.exe
echo.
set /p "OUT_DIR=Output folder (press Enter for %DEFAULT_OUT_DIR%): "
if not defined OUT_DIR set "OUT_DIR=%DEFAULT_OUT_DIR%"

:output_selected
if not exist "%VENV_PY%" (
  echo [1/3] Preparing Python virtual environment first...
  call "%APP_DIR%\start_windows.bat" --setup-only
)

if not exist "%VENV_PY%" (
  echo [ERROR] Virtual environment was not found at "%VENV_PY%".
  echo Please run start_windows.bat once on a machine with Python or internet first.
  pause
  exit /b 1
)

echo [2/3] Ensuring PyInstaller is installed in .venv...
"%VENV_PY%" -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  echo       PyInstaller is missing - installing it now (local wheelhouse, then pypi.org, then public mirrors)...
  "%VENV_PY%" -m offline_packaging.build_offline_package --ensure-pyinstaller
  if errorlevel 1 (
    echo       Retrying with a direct pip install and mirror failover...
    call :install_pyi
    if errorlevel 1 goto pyi_failed
  )
)
"%VENV_PY%" -c "import PyInstaller" >nul 2>nul
if errorlevel 1 goto pyi_failed

set "EXTRA_FLAGS="
if "%BUILD_MODE%"=="2" set "EXTRA_FLAGS=--with-nmt"
if "%BUILD_MODE%"=="3" set "EXTRA_FLAGS=--with-nmt --download-wheelhouse"

echo [3/3] Building ComicOCRStudio.exe and 1-click Offline Windows Setup...
echo       Output folder: "%OUT_DIR%"
"%VENV_PY%" -m offline_packaging.build_offline_package %EXTRA_FLAGS% --output-dir "%OUT_DIR%"
if errorlevel 1 (
  echo.
  echo [ERROR] Offline build failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo ====================================================================
echo   BUILD COMPLETE!
echo   1-Click Standalone EXE : "%OUT_DIR%\ComicOCRStudio\ComicOCRStudio.exe"
echo   Offline Setup Installer: "%OUT_DIR%\ComicOCRStudio-Offline-Setup-4.31*.exe"
echo ====================================================================
pause
exit /b 0

:pyi_failed
echo.
echo [ERROR] Could not install PyInstaller.
echo Please check your internet connection, or copy the PyInstaller .whl file into
echo "%WHEELHOUSE_DIR%" and run this builder again.
pause
exit /b 1

:install_pyi
if exist "%WHEELHOUSE_DIR%\*.whl" (
  "%VENV_PY%" -m pip install --disable-pip-version-check --timeout 120 --retries 10 --prefer-binary --find-links="%WHEELHOUSE_DIR%" "pyinstaller>=6.10,<7"
  if not errorlevel 1 exit /b 0
)
"%VENV_PY%" -m pip install --disable-pip-version-check --timeout 120 --retries 10 --prefer-binary "pyinstaller>=6.10,<7"
if not errorlevel 1 exit /b 0
"%VENV_PY%" -m pip install --disable-pip-version-check --timeout 120 --retries 10 --prefer-binary --index-url https://mirrors.aliyun.com/pypi/simple/ "pyinstaller>=6.10,<7"
if not errorlevel 1 exit /b 0
"%VENV_PY%" -m pip install --disable-pip-version-check --timeout 120 --retries 10 --prefer-binary --index-url https://pypi.tuna.tsinghua.edu.cn/simple "pyinstaller>=6.10,<7"
exit /b %errorlevel%
