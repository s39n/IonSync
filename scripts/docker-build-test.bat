@echo off
cd /d "%~dp0.."
echo Running docker build (no-cache)...
docker build --no-cache -t ionsync-test . > docker-build-output.txt 2>&1
echo Exit code: %ERRORLEVEL% >> docker-build-output.txt
echo Done. Check docker-build-output.txt for results.
pause
