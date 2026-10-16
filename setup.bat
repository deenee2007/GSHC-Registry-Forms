@echo off
title GSHC Registry Forms — Setup
echo ============================================================
echo  GSHC Registry Forms System — One-time Setup
echo ============================================================
echo.

REM ── 1. Remove the "downloaded from internet" security mark ──
echo Step 1: Removing download security restriction from project files...
PowerShell -Command "Get-ChildItem '%~dp0' -Recurse -ErrorAction SilentlyContinue | Unblock-File"
echo Done.
echo.

REM ── 2. Register silent startup task ──
echo Step 2: Registering silent startup task...
set "VBSPATH=%~dp0start.vbs"

REM Delete old task if it exists
schtasks /delete /tn "GSHC Registry Forms" /f >nul 2>&1

REM Create new task: runs at logon, hidden, no UAC prompt
schtasks /create /tn "GSHC Registry Forms" ^
  /tr "wscript.exe \"%VBSPATH%\"" ^
  /sc onlogon /rl LIMITED /f /it >nul 2>&1

if %errorlevel% equ 0 (
  echo Done. The app will now start silently in the background at every login.
) else (
  echo Could not register startup task. You can still launch manually with start.vbs.
)
echo.

REM ── 3. Confirm Node.js is available ──
echo Step 3: Checking Node.js...
node -v >nul 2>&1
if %errorlevel% equ 0 (
  for /f %%i in ('node -v') do echo Node.js found: %%i
) else (
  echo WARNING: Node.js not found on PATH.
  echo Please install Node.js from https://nodejs.org then run this setup again.
)
echo.

echo ============================================================
echo  Setup complete.
echo  - After your next login the app starts silently.
echo  - To launch now, double-click start.vbs
echo  - Open your browser to: http://localhost:3100
echo ============================================================
echo.
pause
