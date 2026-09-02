$vaultPath   = "C:\Users\Sean\Documents\SecondBrain"
$backupZip   = "C:\Users\Sean\Documents\SecondBrain.zip"
$tempDir     = "$env:TEMP\SecondBrain_restore_temp"
$resultsFile = "C:\Users\Sean\Projects\IonSync\fix_vault_results.txt"
$sevenZip    = "C:\Program Files\7-Zip\7z.exe"

$results = [System.Collections.Generic.List[string]]::new()
$results.Add("=== Vault Corrupt File Check ===")
$results.Add("Vault:   $vaultPath")
$results.Add("Backup:  $backupZip")
$results.Add("Time:    $(Get-Date)")
$results.Add("")

# -- Step 1: Find all 0-byte files in the vault ------------------------------
$corruptFiles = Get-ChildItem -Path $vaultPath -Recurse -File |
                Where-Object { $_.Length -eq 0 }

if ($corruptFiles.Count -eq 0) {
    $results.Add("No corrupt (0-byte) files found. Vault is clean!")
    $results | Out-File -FilePath $resultsFile -Encoding UTF8
    Write-Host "DONE - vault is clean. See fix_vault_results.txt"
    exit 0
}

$results.Add("Found $($corruptFiles.Count) corrupt (0-byte) file(s):")
foreach ($f in $corruptFiles) {
    $rel = $f.FullName.Substring($vaultPath.Length + 1)
    $results.Add("  - $rel")
}
$results.Add("")

# -- Step 2: Extract backup zip using 7-Zip ----------------------------------
$results.Add("Extracting backup zip with 7-Zip...")
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

if (-not (Test-Path $sevenZip)) {
    $results.Add("ERROR: 7-Zip not found at $sevenZip")
    $results | Out-File -FilePath $resultsFile -Encoding UTF8
    Write-Host "ERROR: 7-Zip not found. Please install 7-Zip and retry."
    exit 1
}

# -y = yes to all, x = extract with full paths, -o = output dir
$proc = Start-Process -FilePath $sevenZip `
    -ArgumentList "x", "`"$backupZip`"", "-o`"$tempDir`"", "-y" `
    -Wait -PassThru -NoNewWindow
if ($proc.ExitCode -notin @(0, 1)) {
    $results.Add("ERROR: 7-Zip exited with code $($proc.ExitCode)")
    $results | Out-File -FilePath $resultsFile -Encoding UTF8
    Write-Host "ERROR: 7-Zip extraction failed (exit code $($proc.ExitCode))."
    exit 1
}
$results.Add("Extraction complete (7-Zip exit code: $($proc.ExitCode)).")
$results.Add("")

# -- Step 3: Find the vault root inside the zip ------------------------------
$zipContents = Get-ChildItem $tempDir
$zipRoot = $tempDir
if ($zipContents.Count -eq 1 -and $zipContents[0].PSIsContainer) {
    $zipRoot = $zipContents[0].FullName
    $results.Add("Zip root folder detected: $($zipContents[0].Name)")
} else {
    $results.Add("No single root folder in zip - using extraction root directly.")
}
$results.Add("")

# -- Step 4: Restore each corrupt file ---------------------------------------
$restored    = 0
$alsoCorrupt = 0
$notFound    = 0

$results.Add("Restoration results:")
foreach ($f in $corruptFiles) {
    $rel        = $f.FullName.Substring($vaultPath.Length + 1)
    $backupFile = Join-Path $zipRoot $rel

    if (Test-Path $backupFile) {
        $backupSize = (Get-Item $backupFile).Length
        if ($backupSize -gt 0) {
            Copy-Item $backupFile $f.FullName -Force
            $results.Add("  [RESTORED]  ($backupSize bytes)  $rel")
            $restored++
        } else {
            $results.Add("  [SKIP]      (0 bytes in backup too) $rel")
            $alsoCorrupt++
        }
    } else {
        $results.Add("  [NOT FOUND] (missing from backup)  $rel")
        $notFound++
    }
}

$results.Add("")
$results.Add("=== Summary ===")
$results.Add("Total corrupt files:     $($corruptFiles.Count)")
$results.Add("Restored from backup:    $restored")
$results.Add("Also 0 bytes in backup:  $alsoCorrupt")
$results.Add("Not found in backup:     $notFound")

# -- Step 5: Cleanup temp ----------------------------------------------------
Remove-Item $tempDir -Recurse -Force
$results.Add("")
$results.Add("Temp extraction folder cleaned up.")

$results | Out-File -FilePath $resultsFile -Encoding UTF8
Write-Host "DONE. Results written to fix_vault_results.txt"
