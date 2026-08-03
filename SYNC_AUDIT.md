# IonSync Multi-Device Sync — Correctness Audit

_Written after the 2026-07 data-loss incident. Focus: can you trust this to move
between many machines — some editing at the same time, some cold for months —
without losing or silently dropping notes?_

This audit reflects the code as of commit `059dd97` (bootstrap-completeness +
watchdog + cascade-cap fixes already applied).

---

## 1. How sync actually works (the model)

**Ordering.** The server keeps one monotonic counter, `sync_seq` (in the
`settings` table). Every time a file's row is written, it's stamped with the next
seq via `allocateSeq()`. `MAX(seq)` on `files` should always equal the counter.
_Verified healthy on your server: counter = MAX(seq) = 4,003,364, 0 rows above._

**Download (catch-up).** Each device persists `lastSyncedSeq`. On connect it sends
`sync_cursor { since }`; the server replays every change with `seq > since`
(`getChangesSince` = `WHERE seq > ? ORDER BY seq ASC LIMIT 250`), in batches
capped by 250 files **or** 8 MB, driven by `sync_done { more }`. Active files carry
content; deletions carry a tombstone (empty content).

**Upload.** A device's own edits flow up as live `file_data` messages while
connected, and via `_reconcileUploads` (a one-time disk scan) after each sync.

**Deletion.** Deletes propagate **only** through live vault events (the
`deleteQueue`) and the tombstone feed. Bulk `sync` **never** infers a delete from
"file missing on one side" — by explicit design (see `_reconcileUploads`:
_"Offline DELETES are intentionally not propagated here… Deletes flow through
vault events"_).

**Conflicts.** Direction is decided by mtime (`compareFiles`); a concurrent edit
is detected clock-independently by `baseSha1` (the sha the client last synced).
A losing edit is preserved as a `(Conflicted Copy …)` file, never discarded.
Hidden/config paths (`.obsidian/**`, and now the `OBSIDI~1` short-name twin) use
last-write-wins and never mint copies.

---

## 2. Scenario-by-scenario

### ✅ S1 — Two+ devices online, editing *different* files
Each edit uploads, the server stamps a seq and broadcasts to the other peers.
Clean. No issues.

### ✅ S2 — Two devices editing the *same* file at once
`baseSha1` catches it: the second uploader's base no longer matches the server
head → the server keeps its head, stores the other edit as a `(Conflicted Copy)`,
and pushes both to everyone. No edit is lost. This is sound. Residual risk: if
both devices have badly skewed clocks, `compareFiles` can pick a
counter-intuitive "winner" for the *head*, but the loser still survives as a
conflict copy, so it's a naming annoyance, not data loss.

### ✅ S3 — Cold device returns after weeks, others were active
It sends `sync_cursor { since: oldSeq }` and the server replays everything newer,
in order. The **multi-batch completeness** is now covered by a regression test
(600 files across ≥3 batches, ends exactly at the server cursor). If it stalls
mid-catch-up, the new **watchdog** resumes it from the last checkpoint; if its
metadata was wiped, the **bootstrap-in-progress guard** forces a clean full
bootstrap instead of falsely reporting "synced." These three were the direct
causes of your incident and are now fixed + tested.

### ⚠️ S4 — Cold device that *deleted* files while offline  → **files resurrect**
This is the biggest remaining correctness gap, and it's by design today. Deletes
only propagate through *live* vault events. If you delete notes on a device
that's offline (or the plugin is disabled), those deletions are **never sent**.
On reconnect the server still has the files active and pushes them **back** — the
deleted notes reappear. Not data *loss*, but a knowledge base that "un-deletes"
things is its own kind of untrustworthy.
- **Recommendation:** on reconnect, run a bounded tree-diff-delete reconciliation
  — files in local metadata but absent from disk *and* still active on the server
  — gated by the same cascade safety cap, and only after the download phase so a
  transiently-missing file (iCloud/remote-fs) isn't mistaken for a delete.

### ⚠️ S5 — Cold device returns after **months** → tombstone may be gone → **resurrect**
Deleted-file tombstones are purged by `SyncCleanup` after
`keepDeletedFilesSecs` (default **7 days**) — but only when
`oldestDeviceOnline > cutoff`, i.e. every *known* device has checked in since the
deletion. So a device that's simply been offline keeps tombstones alive and will
learn the delete when it returns. **However**, the guard is time/last-online
based, not cursor based:
- If a stale device's `devices` row was ever removed (e.g. dashboard "remove
  device"), the guard no longer waits for it → tombstones purge → when that
  device returns, its deleted paths look "new to the server" and get
  **re-uploaded (resurrected)** to everyone.
- **Recommendation:** make tombstone purge **cursor-based** — never purge a
  tombstone whose seq is still ahead of the *minimum* `lastSyncedSeq` across
  known devices. That ties retention to "has every device actually seen this
  change," which is the real invariant, instead of wall-clock time.

### ✅ S6 — Folder deletion across devices
Obsidian doesn't reliably fire per-child delete events, so a folder delete is
cascaded to its children (`collectFolderChildren`). This is now **capped**: a
single event that would delete >1000 files or >⅓ of the vault is refused and
surfaced as a warning, so one mis-click or short-name collision can't wipe the
KB (your incident cascaded ~14k). Trade-off: a *legitimate* huge folder delete
won't propagate automatically — do it in batches or via the dashboard's explicit
folder-delete. Safe-by-default, which is the right bias for a knowledge base.

### ✅ S7 — Fresh device, first ever sync
Bootstrap from seq 0 delivers the whole vault; delete-queue drain is deferred and
then wiped so first-connect platform noise can't propagate as deletes. Robust.

---

## 3. Fragilities worth hardening (beyond the fixes already shipped)

1. **Offline-delete propagation (S4)** — highest value. Today deletes silently
   vanish if made while disconnected. A capped reconnect reconciliation closes it.
2. **Cursor-based tombstone retention (S5)** — replace the time-based purge guard
   so a long-absent device can never resurrect old deletes.
3. **Metadata durability** — the incident began when `metadata.json` was orphaned
   as a conflicted-copy, leaving the store empty while the cursor stayed high. The
   `bootstrapInProgress` + empty-metadata guards now catch this, but the metadata
   should also be written atomically (temp + rename) and checksummed so a partial
   write can't silently truncate it.
4. **Config folder as normal content** — the `OBSIDI~1` twin proved that any path
   which dodges the `.obsidian` check syncs as content and can conflict/flap
   without bound. Consider validating/normalizing incoming paths server-side
   (reject Windows 8.3 short-name segments, reject a second config-dir alias).
5. **Seq counter integrity** — a DB restore that rolls `sync_seq` *backward* below
   `MAX(seq)` would corrupt delivery. The `since > current → bootstrap` guard
   covers clients, but the server should also **repair** the counter on startup:
   `sync_seq = MAX(MAX(seq), sync_seq)`.

---

## 4. Bottom line

The three failures you actually hit — silent incomplete bootstrap, stuck
"Syncing", and a folder delete fanning out into a mass wipe — are **fixed and
covered by tests**. The model is fundamentally sound for concurrent online
editing and for cold devices catching up.

The two things that would still surprise you are both about **deletions across
long gaps** (S4 and S5): a delete made while offline is lost, and a very stale
device can resurrect old deletes. Neither loses data, but both undermine trust in
the KB. I'd prioritize the capped reconnect-delete reconciliation and
cursor-based tombstone retention next.
