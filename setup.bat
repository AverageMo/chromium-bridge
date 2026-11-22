@echo off
rem Double-click to run the guided setup. Extra arguments pass through, e.g. setup.bat -SkipAutostart
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
