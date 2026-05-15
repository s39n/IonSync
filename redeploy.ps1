# Rebuild IonSync Docker image and redeploy to NAS
# Right-click → Run with PowerShell

$NAS = "10.0.0.202"
$USER = "Sean"
$IMAGE = "ionsync"

Set-Location $PSScriptRoot

Write-Host "=== IonSync Redeploy ===" -ForegroundColor Cyan

# 1. Build image locally
Write-Host "[1/3] Building Docker image..." -ForegroundColor Yellow
docker build -t $IMAGE .
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker build failed." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
Write-Host "  Build complete." -ForegroundColor Green

# 2. Push image to NAS via SSH pipe
Write-Host "[2/3] Transferring image to NAS (this may take a minute)..." -ForegroundColor Yellow
docker save $IMAGE | ssh "${USER}@${NAS}" "docker load"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Transfer failed." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
Write-Host "  Transfer complete." -ForegroundColor Green

# 3. Restart container on NAS with new image
Write-Host "[3/3] Restarting IonSync container on NAS..." -ForegroundColor Yellow
$container = (ssh "${USER}@${NAS}" "docker ps -a --filter name=ionsync --format '{{.Names}}' | head -1").Trim()
ssh "${USER}@${NAS}" "docker restart $container"
Write-Host "  Container restarted: $container" -ForegroundColor Green

Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Cyan
Write-Host "Open the dashboard and go to Danger Zone to use 'Restore Deleted Files'." -ForegroundColor White
Read-Host "Press Enter to exit"
