@echo off
cd /d "%~dp0"
set OUT=docker-diag3.txt

echo ===== CHECK: dashboard.html in container ===== > %OUT% 2>&1
docker compose exec ionsync ls -la /app/client/ >> %OUT% 2>&1
echo. >> %OUT%

echo ===== CHECK: Full dashboard response (first 5 lines) ===== >> %OUT% 2>&1
curl -s http://localhost:3000/dashboard | findstr /n "" | findstr "^[1-5]:" >> %OUT% 2>&1
echo. >> %OUT%

echo ===== CHECK: which image is running ===== >> %OUT% 2>&1
docker compose images >> %OUT% 2>&1
echo. >> %OUT%

echo ===== CHECK: container image creation date ===== >> %OUT% 2>&1
docker inspect ionsync:latest --format "{{.Created}}" >> %OUT% 2>&1

echo Done. See docker-diag3.txt
pause
