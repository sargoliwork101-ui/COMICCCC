@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

rem HaSaYa Studio 4.57 - optional administrator launcher.
rem Use this when Windows denies permission during OCR package installation.
rem Optional OCR models are still downloaded only after an explicit click in the app.

fltmc >nul 2>&1
if not errorlevel 1 goto elevated
if /i "%~1"=="__ELEVATED__" goto elevation_failed

set "COMIC_ADMIN_LAUNCHER=%~f0"
echo [HaSaYa Studio] Windows will now ask for administrator permission.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { $child = Start-Process -FilePath $env:COMIC_ADMIN_LAUNCHER -ArgumentList '__ELEVATED__' -Verb RunAs -Wait -PassThru -ErrorAction Stop; if ($child.ExitCode -ne 0) { exit 2 }; exit 0 } catch { Write-Error $_; exit 1 }"
if errorlevel 2 exit /b 1
if errorlevel 1 goto elevation_failed
exit /b 0

:elevated
echo [HaSaYa Studio] Running with administrator privileges.
echo [HaSaYa Studio] Optional model downloads still require your explicit approval.
call "%~dp0start_windows.bat"
exit /b %errorlevel%

:elevation_failed
echo.
echo Administrator setup was not started. If you cancelled the Windows prompt, no elevated setup was run.
echo You can retry with start_windows_admin.bat or use start_windows.bat without elevation.
pause
exit /b 1
