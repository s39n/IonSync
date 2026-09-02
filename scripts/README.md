# scripts/

One-off operational and recovery scripts for IonSync. These are run manually
(not part of the build or CI). PowerShell/`.bat` scripts are Windows-oriented.

## Current

- **fix_db.ps1** — restore all `deleted` file records back to `active` in the
  server DB (recovery after a spurious mass-delete).
- **fix_vault.ps1** / **fix_vault.bat** — repair a local vault after a bad sync.
- **recover_notes.ps1** — pull note content back down from the server.
- **restore_all.ps1** / **restore_one.ps1** — bulk / single file restore from
  the server's version history.

## Legacy (pre-Dockhand)

Deployment now happens by pushing to `main` (Dockhand git-deploy). These predate
that and are kept only for reference / local Docker testing:

- **redeploy.ps1** — build the image locally and push it to the NAS over SSH.
- **rebuild.bat** — `docker compose down/build/up` locally.
- **docker-build-test.bat** — local `docker build --no-cache` smoke test.

All scripts resolve the repo root themselves, so they can be run from anywhere.
