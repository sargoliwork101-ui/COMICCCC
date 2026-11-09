@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>nul
title Build Offline EXE ^& Setup - Comic OCR Studio 4.33

cd /d "%~dp0"
set "APP_DIR=%CD%"
set "VENV_PY=%APP_DIR%\.venv\Scripts\python.exe"
set "WHEELHOUSE_DIR=%APP_DIR%\wheelhouse"
set "DEFAULT_OUT_DIR=%APP_DIR%\dist"
set "APP_VERSION=4.33"

echo ====================================================================
echo   Comic OCR Studio 4.33 - Offline Windows EXE ^& Setup Builder
echo ====================================================================
echo.

set "BUILD_MODE="
if /I "%~1"=="--base" set "BUILD_MODE=1"
if /I "%~1"=="--with-nmt" set "BUILD_MODE=2"
if /I "%~1"=="--full" set "BUILD_MODE=3"
if /I "%~1"=="--check" set "BUILD_MODE=4"
set "OUT_DIR=%~2"

if defined BUILD_MODE goto mode_selected

echo Select offline package variant to build:
echo   [1] Standard Offline Setup ^(App + Base RapidOCR models - compact ^& fast^)
echo   [2] Full Offline Setup     ^(App + Base RapidOCR + 600M Offline NLLB Translator^)
echo   [3] Full Offline Setup + Download wheelhouse\ for portable .bat installs
echo   [4] Self-test only         ^(check this computer, build nothing^)
echo.
set /p "BUILD_MODE=Enter choice [1/2/3/4] (default 1): "
if not defined BUILD_MODE set "BUILD_MODE=1"

:mode_selected
if "%BUILD_MODE%"=="4" goto self_test
if defined OUT_DIR goto output_selected
echo.
echo Folder that receives the built EXE files:
echo   Standalone app : ^<output folder^>\ComicOCRStudio\ComicOCRStudio.exe
echo   Offline Setup  : ^<output folder^>\ComicOCRStudio-Offline-Setup-%APP_VERSION%.exe
echo.
set /p "OUT_DIR=Output folder (press Enter for %DEFAULT_OUT_DIR%): "
if not defined OUT_DIR set "OUT_DIR=%DEFAULT_OUT_DIR%"

:output_selected
call :ensure_venv
if errorlevel 1 goto no_venv

if "%BUILD_MODE%"=="2" set "EXTRA_FLAGS=--with-nmt"
if "%BUILD_MODE%"=="3" set "EXTRA_FLAGS=--with-nmt --download-wheelhouse"

echo [2/4] Ensuring PyInstaller is installed in .venv...
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

echo [3/4] Building ComicOCRStudio.exe and 1-click Offline Windows Setup...
echo       Output folder: "%OUT_DIR%"
"%VENV_PY%" -m offline_packaging.build_offline_package %EXTRA_FLAGS% --output-dir "%OUT_DIR%"
if errorlevel 1 (
  echo.
  echo [ERROR] The offline build did not finish. Read the last message above - it says exactly what to fix.
  pause
  exit /b 1
)

echo [4/4] Checking the produced files...
if not exist "%OUT_DIR%\ComicOCRStudio" (
  echo.
  echo [ERROR] The standalone app folder was not created: "%OUT_DIR%\ComicOCRStudio"
  pause
  exit /b 1
)
set "SETUP_EXE="
if exist "%OUT_DIR%\ComicOCRStudio-Offline-Setup-%APP_VERSION%.exe" set "SETUP_EXE=%OUT_DIR%\ComicOCRStudio-Offline-Setup-%APP_VERSION%.exe"
if exist "%OUT_DIR%\ComicOCRStudio-Offline-Setup-%APP_VERSION%-Full-NMT.exe" set "SETUP_EXE=%OUT_DIR%\ComicOCRStudio-Offline-Setup-%APP_VERSION%-Full-NMT.exe"

echo.
echo ====================================================================
echo   BUILD COMPLETE!
echo   Standalone app : "%OUT_DIR%\ComicOCRStudio\ComicOCRStudio.exe"
if defined SETUP_EXE (
  echo   Offline Setup : "%SETUP_EXE%"
) else (
  if exist "%OUT_DIR%\ComicOCRStudio-Offline-Setup-%APP_VERSION%.zip" (
    echo   Offline Setup : "%OUT_DIR%\ComicOCRStudio-Offline-Setup-%APP_VERSION%.zip"
    echo   [note] Inno Setup is not installed on this computer, so only the .zip archive could be built.
    echo          Install "Inno Setup 6" and run this builder again to get a real .exe installer.
  ) else (
    echo   [warn] No installer file was found in "%OUT_DIR%" - check the messages above.
  )
)
echo ====================================================================
pause
exit /b 0

:self_test
call :ensure_venv
if errorlevel 1 goto no_venv
echo.
"%VENV_PY%" -m offline_packaging.build_offline_package --preflight
echo.
echo (Self-test finished. Nothing was built and nothing was changed.)
pause
exit /b 0

:no_venv
echo.
echo [ERROR] The Python environment of the program is not ready yet.
echo Please run start_windows.bat once on a machine with Python or internet, then run this builder again.
pause
exit /b 1

:pyi_failed
echo.
echo [ERROR] Could not install PyInstaller.
echo Please check your internet connection, or copy the PyInstaller .whl file into
echo "%WHEELHOUSE_DIR%" and run this builder again.
pause
exit /b 1

:ensure_venv
if exist "%VENV_PY%" (
  "%VENV_PY%" -c "import sys,struct; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) and struct.calcsize('P') == 8 else 1)" >nul 2>&1
  if not errorlevel 1 exit /b 0
)
echo [1/4] Preparing the Python environment of the program first...
call "%APP_DIR%\start_windows.bat" --setup-only
if not exist "%VENV_PY%" exit /b 1
"%VENV_PY%" -c "import sys,struct; sys.exit(0 if (3,11) <= sys.version_info[:2] < (3,14) and struct.calcsize('P') == 8 else 1)" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

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
