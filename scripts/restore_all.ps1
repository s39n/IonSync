# restore_all.ps1
# Walks every file in the backup zip and copies it to the vault
# if the vault file is missing OR is 0 bytes.
# Files that already have content in the vault are NOT overwritten.

$backupZip   = "C:\Users\Sean\Documents\SecondBrain.zip"
$vaultPath   = "C:\Users\Sean\Documents\SecondBrain"
$sevenZip    = "C:\Program Files\7-Zip\7z.exe"
$tempDir     = "$env:TEMP\SecondBrain_restore_all"
$resultsFile = "C:\Users\Sean\Projects\IonSync\restore_all_results.txt"

$results = [System.Collections.Generic.List[string]]::new()
$results.Add("=== Restore-All from Backup ===")
$results.Add("Vault:   $vaultPath")
$results.Add("Backup:  $backupZip")
$results.Add("Time:    $(Get-Date)")
$results.Add("")

# -- Step 1: Extract full backup with 7-Zip ----------------------------------
Write-Host "Extracting backup zip with 7-Zip (this may take a minute)..."
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

$proc = Start-Process -FilePath $sevenZip `
    -ArgumentList "x", "`"$backupZip`"", "-o`"$tempDir`"", "-y" `
    -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -notin @(0, 1)) {
    Write-Host "ERROR: 7-Zip exited with code $($proc.ExitCode)"
    exit 1
}
Write-Host "Extraction done."

# -- Step 2: Find backup root ------------------------------------------------
$zipContents = Get-ChildItem $tempDir
$zipRoot = $tempDir
if ($zipContents.Count -eq 1 -and $zipContents[0].PSIsContainer) {
    $zipRoot = $zipContents[0].FullName
    $results.Add("Zip root: $($zipContents[0].Name)")
} else {
    $results.Add("Zip root: (extraction root)")
}
$results.Add("")

# -- Step 3: Walk every file in the backup -----------------------------------
Write-Host "Scanning backup files and restoring where vault is empty..."
$restored  = 0
$skipped   = 0
$backupEmpty = 0
$errors    = 0

$allBackupFiles = Get-ChildItem -Path $zipRoot -Recurse -File

foreach ($backupFile in $allBackupFiles) {
    # Compute vault-relative path
    $rel         = $backupFile.FullName.Substring($zipRoot.Length).TrimStart('\','/')
    $vaultFile   = Join-Path $vaultPath $rel

    $backupSize = $backupFile.Length
    if ($backupSize -eq 0) {
        $backupEmpty++
        continue   # nothing to restore from an empty backup file
    }

    # Check vault file
    if (Test-Path $vaultFile) {
        $vaultSize = (Get-Item $vaultFile).Length
        if ($vaultSize -gt 0) {
            $skipped++
            continue   # vault already has content, leave it alone
        }
    }

    # Vault file is missing or empty - restore from backup
    try {
        $destDir = Split-Path $vaultFile -Parent
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        Copy-Item $backupFile.FullName $vaultFile -Force
        $results.Add("[RESTORED] ($backupSize bytes)  $rel")
        $restored++
    } catch {
        $results.Add("[ERROR]    $rel  -- $($_.Exception.Message)")
        $errors++
    }
}

$results.Add("")
$results.Add("=== Summary ===")
$results.Add("Backup files scanned:        $($allBackupFiles.Count)")
$results.Add("Restored (vault was empty):  $restored")
$results.Add("Skipped (vault has content): $skipped")
$results.Add("Backup files also empty:     $backupEmpty")
$results.Add("Errors:                      $errors")

# -- Step 4: Cleanup ---------------------------------------------------------
Remove-Item $tempDir -Recurse -Force
$results.Add("")
$results.Add("Temp folder cleaned up.")

$results | Out-File -FilePath $resultsFile -Encoding UTF8
Write-Host "DONE. Results written to restore_all_results.txt"
