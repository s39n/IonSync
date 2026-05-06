@echo off
cd /d "%~dp0"
echo ===== CONTAINER STATUS ===== > docker-diag.txt 2>&1
docker compose ps >> docker-diag.txt 2>&1
echo. >> docker-diag.txt

echo ===== CONTAINER LOGS (last 50 lines) ===== >> docker-diag.txt 2>&1
docker compose logs --tail=50 >> docker-diag.txt 2>&1
echo. >> docker-diag.txt

echo ===== TEST: GET /dashboard (should 200) ===== >> docker-diag.txt 2>&1
curl -s -o nul -w "HTTP %%{http_code}" http://localhost:3000/dashboard >> docker-diag.txt 2>&1
echo. >> docker-diag.txt

echo ===== TEST: Login with correct password ===== >> docker-diag.txt 2>&1
for /f "tokens=2 delims==" %%a in ('findstr /i "IONSYNC_PASSWORD" .env') do set PW=%%a
curl -s -w "\nHTTP %%{http_code}" -H "X-Dashboard-Password: %PW%" http://localhost:3000/api/login >> docker-diag.txt 2>&1
echo. >> docker-diag.txt

echo ===== INSPECT: env vars in container ===== >> docker-diag.txt 2>&1
docker compose exec ionsync env | findstr IONSYNC >> docker-diag.txt 2>&1
echo. >> docker-diag.txt

echo ===== INSPECT: config.js in container ===== >> docker-diag.txt 2>&1
docker compose exec ionsync cat /app/config.js >> docker-diag.txt 2>&1

echo Done. See docker-diag.txt
pause
