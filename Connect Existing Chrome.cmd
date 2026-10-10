@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\connect-existing-chrome.ps1"
if errorlevel 1 echo Setup did not finish. See the message above.
pause
