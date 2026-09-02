@echo off
echo Running vault corruption check and restore...
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\Sean\Projects\IonSync\fix_vault.ps1"
echo.
echo Finished. Press any key to close.
pause > nul
