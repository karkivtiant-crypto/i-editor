@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0start.js"
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
