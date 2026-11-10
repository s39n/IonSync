# Staging stack

A second IonSync server on the same Docker host, running a **copy** of the
production data on different ports. Server changes soak here before they reach
the real vault. Production is not involved: it keeps deploying from `main`.

| | Production | Staging |
|---|---|---|
| Dockhand stack | `ionsync` | `ionsync-staging` |
| Compose file | `docker-compose.yml` | `docker-compose.staging.yml` (includes the normal file, adds a fixed network subnet) |
| Branch | `main` (auto, daily) | whichever branch is under test (manual deploy) |
| Image (`IONSYNC_IMAGE`) | `ionsync:latest` | `ionsync-staging:latest` |
| Sync port (`IONSYNC_PORT`) | 3778 | 3878 |
| Dashboard (`IONSYNC_DASH`) | 3779 | 3879 |
| LLM API (`IONSYNC_API_PORT`) | 3780 | 3880 (idle: no token set) |
| Data (`IONSYNC_DATA`) | `/volume1/Docker/IonSync` | `/volume1/Docker/IonSync-staging` |

## Rules that keep production safe

- **`IONSYNC_IMAGE` must differ.** Both stacks build on the same Docker host; with
  the same image name a staging build would replace the tag production runs from.
- **Separate data directory.** Staging never mounts the production directory.
- **No auto-update, no webhook** on the staging stack. It changes only when
  deployed by hand.
- **No signing key.** Staging builds are unsigned, so a device connected to
  staging refuses its plugin bundle instead of installing test code.
- **Never point a real vault at staging.** It has the same password and a copy of
  the same notes; a real device that syncs with it and then with production would
  carry staging's state back. Use a throwaway test vault.

## Why staging has its own compose file

The NAS already uses all 31 of Docker's default network address pools, so a new
compose project cannot get a network ("all predefined address pools have been
fully subnetted"). `docker-compose.staging.yml` includes the normal compose file
and pins the staging network to `10.202.0.0/24` (override with
`IONSYNC_STAGING_SUBNET`), which is outside those pools. A branch under test
must contain this file, i.e. be based on a `main` that has it.

## Testing a change

1. Push the branch to GitHub.
2. In Dockhand, set the `IonSync-staging` repository's branch to that branch and
   deploy the `ionsync-staging` stack.
3. Open `http://<nas>:3879/dashboard`, check the logs, connect a test vault to
   port 3878.
4. Merge to `main` when satisfied; production picks it up on its normal schedule.

## Refreshing the copy

Stop the staging stack, replace `db/`, `files/` and `conflicts/` in the staging
data directory with a fresh copy from production (copy `db/sync.db` together
with `db/sync.db-wal`), then start it again. Production keeps running during the
copy; verify the copied database with `PRAGMA integrity_check`.
