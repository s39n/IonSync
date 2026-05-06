@echo off
cd /d "%~dp0"
echo Stopping container...
docker compose down
echo.
echo Rebuilding image (ionsync:latest)...
docker compose build
echo.
echo Starting container...
docker compose up -d
echo.
echo Done. Dashboard: http://localhost:3000/dashboard
echo Password is in your .env file (IONSYNC_PASSWORD)
pause
