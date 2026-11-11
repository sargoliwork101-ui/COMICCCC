@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Comic OCR Studio 4.46 - Seller License Generator (转发)

rem The seller tool now lives in a dedicated folder: python_app\license_tool\
rem This launcher only forwards to it so old shortcuts/setup docs keep working.
call "%~dp0license_tool\start_license_manager.bat" %*
