@echo off
title Stat Smith - Upload Now
echo Uploading your latest WoW data...
echo.
rem The companion is a windowless (GUI-subsystem) app, so it writes no
rem console output; cmd still waits for this one-shot run to finish.
"%~dp0rts-companion.exe"
echo.
echo --- recent uploader log ---------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=Join-Path $env:LOCALAPPDATA 'RaidTeamStats\uploader.log'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f -Tail 15 } else { Write-Output 'No log yet. In WoW: enable the Stat Smith addon and log in - it writes its data file within ~60s.' }"
echo ---------------------------------------------------------------
echo Done. If "run at startup" was enabled, the uploader also syncs
echo automatically in the background every few minutes while you play -
echo you do not need to run this each time.
echo.
pause
