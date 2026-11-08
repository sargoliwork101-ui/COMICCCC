@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title Comic OCR Studio - Seller License Generator

rem Seller-only launcher (never shipped inside customer dist\ComicOCRStudio builds).
set "PYTHON_EXE="
if exist "%CD%\.venv\Scripts\python.exe" set "PYTHON_EXE=%CD%\.venv\Scripts\python.exe"
if not defined PYTHON_EXE if exist "%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe" set "PYTHON_EXE=%LocalAppData%\Programs\ComicOCRStudio\Python313\python.exe"
if not defined PYTHON_EXE (
    where py >nul 2>&1 && set "PYTHON_EXE=py -3"
)
if not defined PYTHON_EXE (
    where python >nul 2>&1 && set "PYTHON_EXE=python"
)

if not defined PYTHON_EXE (
    echo [Error] Python 3.11+ was not found. Run start_windows.bat --setup-only first or install Python.
    pause
    exit /b 1
)

%PYTHON_EXE% "%CD%\license_manager.py" %*
if errorlevel 1 pause
