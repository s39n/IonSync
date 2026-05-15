# Fix IonSync DB - restore all deleted files back to active
# Run: right-click → Run with PowerShell

$NAS = "10.0.0.202"
$USER = "Sean"

Write-Host "Finding IonSync container..." -ForegroundColor Yellow
$container = (ssh "${USER}@${NAS}" "docker ps --filter name=ionsync --format '{{.Names}}' | head -1").Trim()

if (-not $container) {
    Write-Host "ERROR: IonSync container not found or not running." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Container: $container" -ForegroundColor Green

# Show current counts
Write-Host ""
Write-Host "Current DB state:" -ForegroundColor Yellow
ssh "${USER}@${NAS}" "docker exec $container sqlite3 /data/db/sync.db `"SELECT action, COUNT(*) as count FROM files GROUP BY action;`""

# Fix it
Write-Host ""
Write-Host "Restoring deleted files to active..." -ForegroundColor Yellow
$result = ssh "${USER}@${NAS}" "docker exec $container sqlite3 /data/db/sync.db `"UPDATE files SET action='active' WHERE action='deleted'; SELECT changes() || ' files restored';`""
Write-Host $result -ForegroundColor Green

# Show new counts
Write-Host ""
Write-Host "Updated DB state:" -ForegroundColor Yellow
ssh "${USER}@${NAS}" "docker exec $container sqlite3 /data/db/sync.db `"SELECT action, COUNT(*) as count FROM files GROUP BY action;`""

Write-Host ""
Write-Host "Done! Now re-enable IonSync on your OLD computer only." -ForegroundColor Cyan
Write-Host "It will sync the restored files back to your vault." -ForegroundColor Cyan
Read-Host "Press Enter to exit"
