# IonSync — Recovery Runbook (2026-08 mass-delete incident)

## What happened

The SQLite DB got corrupted and was rebuilt with `_dbrebuild.cjs`. That script copies the
`files` table **verbatim** — including every `action='deleted'` **tombstone** — and drops the
corrupt `file_versions`. Seqs and `sync_seq` are preserved.

The damage came from the cursor-sync feed. When a healthy client bootstraps **from seq 0**
(which happens after a redeploy/endpoint change, a cursor reset, or a `since > current`
rollback), the server replayed **every tombstone as a live delete**. That is why the web copy
fell from ~20k to ~11k, and why this PC saw an endless `file_push → sync_done → sync_cursor`
storm — it was next in line for the same replay.

This PC's vault is the source of truth (correct ~20k). Recovery flows **outward from this PC**.

## Second symptom — the all-night livelock

The rebuild lost the tail of the seq range, so a healthy client's saved cursor (`4072715`) ended
up **higher** than the server's counter (`4072698`). The server's old `since > current` guard
forced a from-0 bootstrap and streamed the first 250 files with low seqs — but a client cursor
only moves **forward**, so it refused to checkpoint them and re-requested `since=4072715` on every
cycle. Infinite loop, no progress, all night. It wasn't wiping the vault (stuck on the same 250
oldest files), but it never converges.

## Code fix (committed, NOT deployed)

Branch `fix/bootstrap-no-tombstones` (commits `8f3cec7`, `13f5a01`):

- `getChangesSince(..., includeDeletes)` — a genuine from-0 bootstrap streams **active files
  only**; real deletes still flow via live events and `since>0` deltas. (Blocks the mass-delete.)
- Cursor handler now **adopts the client's watermark** when `since > current` (bumps `sync_seq` to
  `since` and serves a normal, empty delta) instead of forcing an un-checkpointable from-0 replay.
  (Blocks the livelock AND fixes the original under-fetch.)
- `SyncDB.bumpSeqTo()` / `repairSeqCounter()` on startup — never let the counter sit below
  `MAX(seq)` (defense-in-depth, audit §3.5).
- Tests: `npm test` = 69 pass, `npm run typecheck` = clean.

Review before production: `git diff main...fix/bootstrap-no-tombstones`.

## Stop the loop right now (before any deploy)

Either is safe and non-destructive:

- **Quit the looping Obsidian instance** (device `6dbd2ecf…`, your most-synced copy). Simplest.
- **Or bump the server counter** above the client cursor so the server stops forcing bootstraps —
  e.g. set `sync_seq` to `4072720`+ in `settings`. This is exactly what the code fix automates.

---

## Recovery steps — do them in this order

### 0. Freeze (done)
Obsidian on this PC closed / sync off. Web already down. Nothing is touching the server.
Confirm this PC still shows ~20k files before continuing.

### 1. Deploy the fix
Merge `fix/bootstrap-no-tombstones` → `main` so Dockhand redeploys with the fix. Do this first so
no future restore can mass-delete again. (A clean reseed in step 2–3 wouldn't have tombstones
anyway, but deploy-first is the safe bias.)

### 2. Wipe the server to an empty DB
Stop the container and clear its data volume so it starts empty (`sync_seq=0`, no tombstones):

```bash
docker compose down
docker volume rm ionsync_data      # destroys /data/db and /data/files
docker compose up -d               # recreates an empty volume
```

Adapt to your Dockhand setup if the volume name differs (`docker volume ls`). We wipe `files/`
too — the good PC re-uploads all content fresh in step 3.

### 3. Re-seed from this PC (the correct 20k)
The plugin only uploads paths whose content differs from its **local metadata**. To make it
re-upload everything, clear that metadata so every file looks new:

1. Keep Obsidian closed.
2. In the vault, go to `.obsidian/plugins/<ionsync-folder>/` (the folder with IonSync's
   `main.js` / `manifest.json`).
3. Delete `data/metadata.json` and `data/delete-queue.json`.
4. Edit `data.json` in that folder and set:
   `"lastSyncedSeq": 0, "bootstrapComplete": false, "bootstrapInProgress": false, "lastSyncedEndpoint": ""`
5. Reopen Obsidian.

The plugin now bootstraps against the empty server (receives nothing — **no deletes**), then its
reconcile scan uploads all ~20k files, rebuilding the server with fresh seqs and correct content.
Watch the dev console: you'll see `Sending` uploads, then it settles. Verify the dashboard file
count reaches ~20k.

### 4. Reconnect the web copy
Once the server shows ~20k, do the same metadata reset on the web device (or just wipe its vault
and let it bootstrap). With the fix deployed and the server clean, it bootstraps down all ~20k
active files with no deletions. Confirm it lands at ~20k, not 11k.

### 5. Clean up
Remove the scratch scripts from the repo root when done: `_dbrebuild.cjs`, and any `_db*.cjs`.

---

## Guardrails for next time
- Never point a live server at a rebuilt DB that still contains old tombstones unless the fix is
  deployed.
- After any DB restore, sanity-check on the server:
  `SELECT COUNT(*) FROM files WHERE action='deleted';` and
  `SELECT value FROM settings WHERE key='sync_seq';` vs `SELECT MAX(seq) FROM files;`.
- A from-0 bootstrap should now only ever *add* files to a client, never remove them.
