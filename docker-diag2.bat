@echo off
cd /d "%~dp0"
set OUT=docker-diag2.txt

echo ===== FULL LOGIN FLOW TEST ===== > %OUT% 2>&1

echo. >> %OUT%
echo --- Step 1: Login and capture Set-Cookie header --- >> %OUT%
curl -v -s -c "%TEMP%\ionsync-cookies.txt" -H "X-Dashboard-Password: mptmP2l" http://localhost:3000/api/login >> %OUT% 2>&1

echo. >> %OUT%
echo --- Step 2: /api/peers WITH cookie --- >> %OUT%
curl -v -s -b "%TEMP%\ionsync-cookies.txt" http://localhost:3000/api/peers >> %OUT% 2>&1

echo. >> %OUT%
echo --- Step 3: /api/devices WITH cookie --- >> %OUT%
curl -v -s -b "%TEMP%\ionsync-cookies.txt" http://localhost:3000/api/devices >> %OUT% 2>&1

echo. >> %OUT%
echo --- Step 4: /api/logs WITH cookie --- >> %OUT%
curl -v -s -b "%TEMP%\ionsync-cookies.txt" http://localhost:3000/api/logs >> %OUT% 2>&1

echo. >> %OUT%
echo --- Stored cookies --- >> %OUT%
type "%TEMP%\ionsync-cookies.txt" >> %OUT% 2>&1

echo Done. See docker-diag2.txt
pause
