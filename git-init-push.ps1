Set-Location "$PSScriptRoot"

git init
git remote add origin https://github.com/s39n/IonSync.git
git add .
git commit -m "Initial commit — IonSync v2"
git branch -M main
git push -u origin main

Remove-Item "$PSScriptRoot\git-init-push.ps1"
Write-Host "`nDone! Repo pushed to "https://github.com/s39n/IonSync.git" -ForegroundColor Green
