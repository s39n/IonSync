# Extracts a single file from the backup zip and restores it to the vault.
$backupZip  = "C:\Users\Sean\Documents\SecondBrain.zip"
$vaultPath  = "C:\Users\Sean\Documents\SecondBrain"
$sevenZip   = "C:\Program Files\7-Zip\7z.exe"
$tempDir    = "$env:TEMP\SecondBrain_single_restore"

# The relative path of the file to restore (as it appears inside the zip's SecondBrain\ folder)
$relPath = "Efforts\Active Projects\Career\Projects\Medicare Bad Debt\SRG Medicare Bad Debt\SRG Medicare BD-Accounts.md"

if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

Write-Host "Extracting file from zip..."

# 7-Zip path inside the zip: "SecondBrain\<relPath>"
$zipInternalPath = "SecondBrain\$relPath"

& $sevenZip e $backupZip "-o$tempDir" $zipInternalPath -y

# The extracted file lands flat in tempDir (7z 'e' strips folder structure)
$fileName    = Split-Path $relPath -Leaf
$extracted   = Join-Path $tempDir $fileName
$destination = Join-Path $vaultPath $relPath

if (Test-Path $extracted) {
    $size = (Get-Item $extracted).Length
    Write-Host "Extracted: $fileName ($size bytes)"
    if ($size -gt 0) {
        # Ensure destination folder exists
        $destDir = Split-Path $destination -Parent
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item $extracted $destination -Force
        Write-Host "Restored to: $destination"
    } else {
        Write-Host "WARNING: File is also 0 bytes in the backup. Cannot restore."
    }
} else {
    Write-Host "ERROR: File not found in zip at path: $zipInternalPath"
    Write-Host "Listing zip contents matching 'BD-Accounts'..."
    & $sevenZip l $backupZip "*BD-Accounts*"
}

Remove-Item $tempDir -Recurse -Force
Write-Host "Done."
