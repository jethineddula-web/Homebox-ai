@echo off
rem Starts Homebox from source (needs Node.js 22 or newer) and opens its window in your browser.
title Homebox
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Homebox needs Node.js. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
tasklist /fi "imagename eq Homebox.exe" | find /i "Homebox.exe" >nul && (
  echo The Homebox desktop app is already running. Use that window, or quit it first.
  pause
  exit /b 1
)
echo Homebox is running. Keep this window open while AI works. Close it to stop Homebox.
echo.
set HOMEBOX_OPEN=1
node src\core\server.js
pause
