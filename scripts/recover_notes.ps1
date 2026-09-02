# ============================================================
# IonSync Note Recovery Script (Network Share Version)
# Reads directly from D:\IonSync\files (NAS Docker share)
# Run this by right-clicking → "Run with PowerShell"
# ============================================================

$SOURCE_FILES = "D:\IonSync\files"
$RECOVERY_DIR = "C:\IonSync_Recovery_$(Get-Date -Format 'yyyyMMdd_HHmmss')"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  IonSync Note Recovery" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Source: $SOURCE_FILES"
Write-Host "Output: $RECOVERY_DIR"
Write-Host ""

# Verify source is accessible
if (-not (Test-Path $SOURCE_FILES)) {
    Write-Host "ERROR: Cannot access $SOURCE_FILES" -ForegroundColor Red
    Write-Host "Make sure the D: (Docker NAS) drive is connected." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Create recovery directory
New-Item -ItemType Directory -Force -Path $RECOVERY_DIR | Out-Null

Write-Host "Scanning vault files on NAS..." -ForegroundColor Yellow

$recovered = 0
$skipped = 0
$errors = 0

# Walk every directory in the files store
# Structure: $SOURCE_FILES\<vault\path\to\note.md>\v_<mtime>
# We need to find all directories that contain v_* files (these are the "notes")

Get-ChildItem -Path $SOURCE_FILES -Recurse -Directory | ForEach-Object {
    $dir = $_

    # Check if this directory contains version files (v_<mtime>)
    $versions = Get-ChildItem -Path $dir.FullName -File -Filter "v_*" -ErrorAction SilentlyContinue

    if ($versions -and $versions.Count -gt 0) {
        # This is a note directory. Pick the latest version (highest mtime number = newest)
        $latestVersion = $versions | Sort-Object Name -Descending | Select-Object -First 1

        # The vault path is the directory's path relative to $SOURCE_FILES
        $relativePath = $dir.FullName.Substring($SOURCE_FILES.Length).TrimStart('\', '/')

        # Destination in recovery folder
        $destFile = Join-Path $RECOVERY_DIR $relativePath
        $destDir = Split-Path $destFile -Parent

        try {
            New-Item -ItemType Directory -Force -Path $destDir -ErrorAction SilentlyContinue | Out-Null
            Copy-Item -Path $latestVersion.FullName -Destination $destFile -Force
            $recovered++

            if ($recovered % 500 -eq 0) {
                Write-Host "  Recovered $recovered files so far..." -ForegroundColor Gray
            }
        } catch {
            $errors++
            # Silently skip files with path issues
        }
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  RECOVERY COMPLETE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Files recovered: $recovered" -ForegroundColor Green
if ($errors -gt 0) {
    Write-Host "Errors (skipped): $errors" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Your notes are in:" -ForegroundColor White
Write-Host "  $RECOVERY_DIR" -ForegroundColor Green
Write-Host ""

# Open the recovery folder
Write-Host "Opening recovery folder..." -ForegroundColor Gray
Start-Process explorer.exe $RECOVERY_DIR

Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "  1. Check the recovery folder looks right" -ForegroundColor White
Write-Host "  2. Copy its contents into your Obsidian vault folder" -ForegroundColor White
Write-Host "  3. Restart Obsidian - it will re-index everything" -ForegroundColor White
Write-Host "  4. Do NOT re-enable IonSync on the new computer yet" -ForegroundColor Red
Write-Host ""
Read-Host "Press Enter to exit"
