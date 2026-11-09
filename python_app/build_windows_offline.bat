@echo off
rem Comic OCR Studio 4.37 - Windows offline EXE / Setup builder launcher.
rem The questions (which package, which output folder) are asked by the builder itself
rem (Python), not by this file: the old `set /p` menu died silently on the seller's
rem machine right after the output-folder question.
rem Every run is recorded in python_app\build_offline.log
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>nul
title Build Offline EXE ^& Setup - Comic OCR Studio 4.37

cd /d "%~dp0"
set "APP_DIR=%CD%"
set "VENV_PY=%APP_DIR%\.venv\Scripts\python.exe"
set "WHEELHOUSE_DIR=%APP_DIR%\wheelhouse"
set "DEFAULT_OUT_DIR=%APP_DIR%\dist"
set "APP_VERSION=4.37"

echo ====================================================================
echo   Comic OCR Studio 4.37 - Offline Windows EXE ^& Setup Builder
echo ====================================================================
echo.

set "MODE=%~1"
set "OUT_DIR=%~2"
set "EXTRA_FLAGS="
if /I "%MODE%"=="--base" set "MODE=1"
if /I "%MODE%"=="--with-nmt" set "MODE=2"
if /I "%MODE%"=="--full" set "MODE=3"
if /I "%MODE%"=="--check" set "MODE=4"
if not defined MODE set "MODE=menu"
if "%MODE%"=="2" set "EXTRA_FLAGS=--with-nmt"
if "%MODE%"=="3" set "EXTRA_FLAGS=--with-nmt --download-wheelhouse"

call :ensure_venv
if errorlevel 1 goto no_venv

if "%MODE%"=="4" goto self_test
if "%MODE%"=="menu" goto interactive
if not defined OUT_DIR set "OUT_DIR=%DEFAULT_OUT_DIR%"

echo [1/4] Output folder: "%OUT_DIR%"
echo [2/4] Ensuring PyInstaller is installed in .venv...
"%VENV_PY%" -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  echo       PyInstaller is missing - installing it now ^(local wheelhouse, then pypi.org, then public mirrors^)...
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
"%VENV_PY%" -m offline_packaging.build_offline_package %EXTRA_FLAGS% --output-dir "%OUT_DIR%"
if errorlevel 1 goto build_failed

echo [4/4] Checking the produced files...
if not exist "%OUT_DIR%\ComicOCRStudio" (
  echo.
  echo [ERROR] The standalone app folder was not created: "%OUT_DIR%\ComicOCRStudio"
  goto build_failed
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
echo   Full log       : "%APP_DIR%\build_offline.log"
echo ====================================================================
pause
exit /b 0

:interactive
rem The builder asks the questions and prints the progress; nothing is asked here.
"%VENV_PY%" -m offline_packaging.build_offline_package --interactive
if errorlevel 1 goto build_failed
echo.
echo   Full log       : "%APP_DIR%\build_offline.log"
echo ====================================================================
pause
exit /b 0

:self_test
"%VENV_PY%" -m offline_packaging.build_offline_package --preflight
echo.
echo (Self-test finished. Nothing was built and nothing was changed.)
echo   Full log       : "%APP_DIR%\build_offline.log"
pause
exit /b 0

:build_failed
echo.
echo [ERROR] The offline build did not finish. Read the last message above - it says exactly what to fix.
echo         The full log is here: "%APP_DIR%\build_offline.log"
pause
exit /b 1

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
echo [0/4] Preparing the Python environment of the program first...
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

:done
echo.
echo (The builder stopped.)
pause
exit /b 0
