@echo off
setlocal

cd /d "%~dp0"

echo Starting Trinity Download Manager...
echo.

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

call npm run tauri dev

echo.
echo Trinity Download Manager closed.
pause
