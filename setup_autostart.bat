@echo off
:: GSHC Registry Forms — Auto-Start Setup
:: Run this file ONCE to make the server start silently at Windows login.
:: No confirmation dialogs will appear after this is set up.
:: To remove auto-start, run: schtasks /delete /tn "GSHC Registry Forms" /f

setlocal
set "VBS=%~dp0start.vbs"

echo.
echo  GSHC Registry Forms — Auto-Start Setup
echo  =======================================
echo  Registering silent startup task for this Windows account...
echo.

schtasks /create /tn "GSHC Registry Forms" ^
  /tr "wscript.exe //nologo \"%VBS%\"" ^
  /sc ONLOGON /rl NORMAL /f >nul 2>&1

if %errorlevel%==0 (
    echo  SUCCESS.
    echo  The GSHC Registry server will now start silently every time
    echo  you log into Windows. No confirmation dialog will appear.
    echo.
    echo  To remove auto-start later, run:
    echo    schtasks /delete /tn "GSHC Registry Forms" /f
) else (
    echo  Could not register the task automatically.
    echo  Try right-clicking this file and choosing "Run as Administrator".
)

echo.
pause
