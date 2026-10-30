@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

rem Comic OCR Studio 3.13 - optional administrator launcher.
rem Use this when Windows denies permission during OCR package installation.
rem Optional OCR models are still downloaded only after an explicit click in the app.

fltmc >nul 2>&1
if not errorlevel 1 goto elevated
if /i "%~1"=="__ELEVATED__" goto elevation_failed

set "COMIC_ADMIN_LAUNCHER=%~f0"
echo [Comic OCR Studio] Windows will now ask for administrator permission.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:COMIC_ADMIN_LAUNCHER -ArgumentList '__ELEVATED__' -Verb RunAs -Wait -ErrorAction Stop; exit 0 } catch { Write-Error $_; exit 1 }"
if errorlevel 1 goto elevation_failed
exit /b 0

:elevated
echo [Comic OCR Studio] Running with administrator privileges.
echo [Comic OCR Studio] Optional model downloads still require your explicit approval.
call "%~dp0start_windows.bat"
exit /b %errorlevel%

:elevation_failed
echo.
echo Administrator setup was not started. If you cancelled the Windows prompt, no elevated setup was run.
echo You can retry with start_windows_admin.bat or use start_windows.bat without elevation.
pause
exit /b 1
