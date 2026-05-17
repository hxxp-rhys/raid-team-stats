@echo off
title Raid Team Stats - Upload Now
echo Uploading your latest WoW data...
echo.
"%~dp0rts-companion.exe"
echo.
echo ---------------------------------------------------------------
echo Done. If "run at startup" was enabled during install, the
echo uploader also syncs automatically in the background after every
echo /reload or logout - you do not need to run this each time.
echo.
pause
